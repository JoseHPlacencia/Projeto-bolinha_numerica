const config = require("../config/gameConfig");
const {
    calculatePolygonArea,
    calculatePolygonIntersectionArea,
    doBoundsOverlap,
    doPolygonsHavePositiveAreaOverlap,
    getPolygonBounds,
    getPolygonPointCount
} = require("../utils/geometry");
const { getHighResolutionTime } = require("../utils/time");
const {
    addCaptureApplyCount,
    getCaptureApplyDiagnostics,
    getCaptureApplyMetrics,
    measureCaptureApplyPhase,
    recordCaptureApplyMax,
    roundToMilliseconds
} = require("./territoryDiagnostics");
const {
    createIdentityOperationPolygon,
    subtractTerritoryPolygon
} = require("./territoryOperations");
const {
    getTerritoryRepairWorkerPendingCount,
    submitTerritoryRepairJob
} = require("./territoryRepairWorkerPool");

const territoryChangeAreaEpsilon = 1;
const overlapRepairQueueStates = new WeakMap();

/**
 * Synchronous and queued repair of positive-area territory overlaps.
 *
 * Queue and worker state live here, while authoritative polygon mutation is
 * delegated to territories.js through updateTerritoryPolygon.
 */
function createTerritoryOverlapRepair({ updateTerritoryPolygon }) {
    if (typeof updateTerritoryPolygon !== "function") {
        throw new TypeError("territory overlap repair requires a polygon updater");
    }

    function repairChangedTerritoryOverlaps(territories, ownerId, changedPlayerIds, options, metrics) {
        if (!changedPlayerIds || changedPlayerIds.size <= 0) {
            return;
        }

        const pendingIds = [...changedPlayerIds];
        const repairContext = {
            candidateIds: options.captureRepairCandidateIds instanceof Set
                ? options.captureRepairCandidateIds
                : new Set(),
            checkedPairs: new Set(),
            ownerId
        };
        const maxRepairPasses = Math.max(1, territories.size * territories.size);
        let pendingIndex = 0;
        let repairPasses = 0;

        while (pendingIndex < pendingIds.length && repairPasses < maxRepairPasses) {
            const changedPlayerId = pendingIds[pendingIndex++];

            if (!changedPlayerIds.has(changedPlayerId)) {
                continue;
            }

            repairPasses++;

            if (repairTerritoryOverlaps(
                territories,
                changedPlayerId,
                ownerId,
                changedPlayerIds,
                pendingIds,
                options,
                repairContext,
                metrics
            )) {
                pendingIds.push(changedPlayerId);
            }
        }
    }

    function repairTerritoryOverlaps(
        territories,
        changedPlayerId,
        ownerId,
        changedPlayerIds,
        pendingIds,
        options,
        repairContext,
        metrics
    ) {
        if (!territories.has(changedPlayerId)) {
            return false;
        }

        for (const otherPlayerId of getOverlapRepairCandidateIds(territories, changedPlayerId, ownerId, repairContext)) {
            const pairKey = createTerritoryPairKey(changedPlayerId, otherPlayerId);

            if (repairContext.checkedPairs.has(pairKey)) {
                continue;
            }

            repairContext.checkedPairs.add(pairKey);
            const repair = measureCaptureApplyPhase(options.diagnostics, "captureApplyRepairPair", () => (
                repairTerritoryOverlapPair(
                    territories,
                    changedPlayerId,
                    otherPlayerId,
                    ownerId,
                    changedPlayerIds,
                    options.players,
                    metrics,
                    {
                        diagnostics: options.diagnostics,
                        phasePrefix: "captureApplyRepairPair"
                    }
                )
            ));

            if (!repair.changed) {
                continue;
            }

            if (!changedPlayerIds.has(repair.changedPlayerId)) {
                addCaptureApplyCount(metrics, "changedTerritoryCount", 1);
                changedPlayerIds.add(repair.changedPlayerId);
                pendingIds.push(repair.changedPlayerId);
            }

            return true;
        }

        return false;
    }

    function getOverlapRepairCandidateIds(territories, changedPlayerId, ownerId, repairContext) {
        const candidateIds = new Set();

        for (const candidateId of repairContext.candidateIds || []) {
            if (candidateId !== changedPlayerId
                && territories.has(candidateId)
                && canUseImmediateOverlapRepairPair(territories, changedPlayerId, candidateId)) {
                candidateIds.add(candidateId);
            }
        }

        if (ownerId !== changedPlayerId
            && territories.has(ownerId)
            && canUseImmediateOverlapRepairPair(territories, changedPlayerId, ownerId)) {
            candidateIds.add(ownerId);
        }

        appendBoundOverlappingOverlapRepairCandidateIds(territories, changedPlayerId, candidateIds);

        return [...candidateIds];
    }

    function appendBoundOverlappingOverlapRepairCandidateIds(territories, changedPlayerId, candidateIds) {
        const changedTerritory = territories.get(changedPlayerId);
        const changedBounds = getTerritoryBounds(changedTerritory);

        if (!changedBounds || !canUseImmediateBoundOverlapRepair(changedTerritory)) {
            return;
        }

        for (const [candidateId, candidateTerritory] of territories.entries()) {
            if (candidateId === changedPlayerId || candidateIds.has(candidateId)) {
                continue;
            }

            const candidateBounds = getTerritoryBounds(candidateTerritory);

            if (canUseImmediateOverlapRepairPair(territories, changedPlayerId, candidateId)
                && doBoundsOverlap(changedBounds, candidateBounds)) {
                candidateIds.add(candidateId);
            }
        }
    }

    function canUseImmediateOverlapRepairPair(territories, firstPlayerId, secondPlayerId) {
        return canUseImmediateBoundOverlapRepair(territories.get(firstPlayerId))
            && canUseImmediateBoundOverlapRepair(territories.get(secondPlayerId));
    }

    function canUseImmediateBoundOverlapRepair(territory) {
        return getPolygonPointCount(territory && territory.polygon) <= getImmediateOverlapRepairMaxPointCount();
    }

    function getImmediateOverlapRepairMaxPointCount() {
        const value = Number(config.territory.overlapRepairImmediateMaxPointCount);

        return Number.isInteger(value) && value > 0 ? value : 128;
    }

    function repairTerritoryOverlapPair(
        territories,
        firstPlayerId,
        secondPlayerId,
        ownerId,
        changedPlayerIds,
        players,
        metrics,
        options = {}
    ) {
        const phasePrefix = options.phasePrefix || "overlapRepairPair";
        const firstTerritory = territories.get(firstPlayerId);
        const secondTerritory = territories.get(secondPlayerId);
        const firstBounds = getTerritoryBounds(firstTerritory);
        const secondBounds = getTerritoryBounds(secondTerritory);

        if (!firstTerritory || !secondTerritory || !firstBounds || !secondBounds) {
            return createOverlapRepairResult(false);
        }

        addCaptureApplyCount(metrics, "postCaptureOverlapCheckCount", 1);

        if (!measureCaptureApplyPhase(options.diagnostics, `${phasePrefix}Bounds`, () => (
            doBoundsOverlap(firstBounds, secondBounds)
        ))) {
            addCaptureApplyCount(metrics, "postCaptureOverlapBoundsRejectedCount", 1);
            return createOverlapRepairResult(false);
        }

        if (!measureCaptureApplyPhase(options.diagnostics, `${phasePrefix}Overlap`, () => (
            doPolygonsHavePositiveAreaOverlap(
                firstTerritory.polygon,
                secondTerritory.polygon,
                firstBounds,
                secondBounds
            )
        ))) {
            return createOverlapRepairResult(false);
        }

        const confirmedOverlapArea = measureCaptureApplyPhase(
            options.diagnostics,
            `${phasePrefix}AreaConfirmation`,
            () => calculatePolygonIntersectionArea(firstTerritory.polygon, secondTerritory.polygon)
        );

        if (confirmedOverlapArea <= territoryChangeAreaEpsilon) {
            return createOverlapRepairResult(false);
        }

        const overlapDetail = createPostCaptureOverlapDetail(
            firstPlayerId,
            secondPlayerId,
            firstTerritory,
            secondTerritory
        );
        const winnerId = selectOverlapWinnerId(
            firstPlayerId,
            firstTerritory,
            secondPlayerId,
            secondTerritory,
            ownerId,
            changedPlayerIds
        );
        const loserId = winnerId === firstPlayerId ? secondPlayerId : firstPlayerId;
        const winnerTerritory = territories.get(winnerId);
        const loserTerritory = territories.get(loserId);
        const trim = measureCaptureApplyPhase(options.diagnostics, `${phasePrefix}Trim`, () => (
            trimTerritoryOverlap(
                loserTerritory,
                winnerTerritory,
                players && players.get(loserId),
                {
                    diagnostics: options.diagnostics,
                    metrics,
                    phasePrefix
                }
            )
        ));

        if (!trim.changed) {
            return createOverlapRepairResult(false);
        }

        addCaptureApplyCount(metrics, "postCaptureOverlapCount", 1);
        addCaptureApplyCount(metrics, "postCaptureOverlapRepairCount", 1);
        addCaptureApplyCount(metrics, "postCaptureOverlapRepairChangedCount", 1);
        recordFirstPostCaptureOverlap(metrics, overlapDetail, confirmedOverlapArea);

        return createOverlapRepairResult(true, loserId);
    }

    function createOverlapRepairResult(changed, changedPlayerId = null) {
        return {
            changed,
            changedPlayerId
        };
    }

    function scheduleTerritoryOverlapRepairQueue(territories, changedPlayerIds, options = {}) {
        if (!territories || !changedPlayerIds || changedPlayerIds.size <= 0) {
            return;
        }

        for (const changedPlayerId of changedPlayerIds) {
            enqueueTerritoryOverlapRepair(territories, changedPlayerId, options);
        }
    }

    function processTerritoryOverlapRepairQueue(territories, players = new Map(), options = {}) {
        const state = getTerritoryOverlapRepairQueueState(territories, false);
        const changedPlayerIds = new Set();

        if (!state) {
            return changedPlayerIds;
        }

        const diagnostics = getCaptureApplyDiagnostics(options);
        const metrics = getCaptureApplyMetrics(diagnostics);
        measureCaptureApplyPhase(diagnostics, "overlapRepairWorkerApply", () => {
            applyCompletedTerritoryRepairJobs(
                territories,
                state,
                metrics,
                changedPlayerIds
            );
        });
        recordCaptureApplyMax(
            metrics,
            "overlapRepairWorkerInFlightCount",
            state.inFlightPairKeys.size
        );

        if (!hasPendingOverlapRepairItems(state)) {
            compactOverlapRepairQueue(state);
            return changedPlayerIds;
        }

        const startedAt = getHighResolutionTime();
        const maxPairs = getOverlapRepairQueueMaxPairsPerTick();
        const budgetMs = getOverlapRepairQueueBudgetMs();
        let processedPairs = 0;
        let budgetHit = false;
        let workerBackpressure = false;

        while (hasPendingOverlapRepairItems(state) && processedPairs < maxPairs) {
            if (!hasOverlapRepairQueueBudget(startedAt, budgetMs)) {
                budgetHit = true;
                break;
            }

            const item = dequeueOverlapRepairItem(state);

            if (!item || !territories.has(item.changedPlayerId)) {
                if (item) {
                    state.pendingIds.delete(item.changedPlayerId);
                    state.refreshRequests.delete(item.changedPlayerId);
                }
                continue;
            }

            let itemCompleted = true;

            while (item.cursor < item.candidateIds.length && processedPairs < maxPairs) {
                if (!hasOverlapRepairQueueBudget(startedAt, budgetMs)) {
                    budgetHit = true;
                    itemCompleted = false;
                    break;
                }

                const otherPlayerId = item.candidateIds[item.cursor];

                if (otherPlayerId === item.changedPlayerId || !territories.has(otherPlayerId)) {
                    item.cursor++;
                    continue;
                }

                const pairVersionKey = createTerritoryPairVersionKey(territories, item.changedPlayerId, otherPlayerId);

                if (!pairVersionKey || state.checkedPairs.has(pairVersionKey)) {
                    item.cursor++;
                    continue;
                }

                const candidate = measureCaptureApplyPhase(diagnostics, "overlapRepairQueuePair", () => (
                    createTerritoryRepairWorkerCandidate(
                        territories,
                        item.changedPlayerId,
                        otherPlayerId,
                        item.ownerId,
                        metrics,
                        {
                            diagnostics,
                            phasePrefix: "overlapRepairQueuePair"
                        }
                    )
                ));

                if (!candidate) {
                    rememberCheckedOverlapRepairPair(state, pairVersionKey);
                    item.cursor++;
                    processedPairs++;
                    addCaptureApplyCount(metrics, "overlapRepairQueueProcessedCount", 1);
                    continue;
                }

                if (isTerritoryRepairWorkerEnabled()) {
                    const dispatched = measureCaptureApplyPhase(
                        diagnostics,
                        "overlapRepairWorkerDispatch",
                        () => dispatchTerritoryRepairWorkerCandidate(
                            state,
                            candidate,
                            players,
                            pairVersionKey
                        )
                    );

                    if (!dispatched) {
                        addCaptureApplyCount(metrics, "overlapRepairWorkerBackpressureCount", 1);
                        itemCompleted = false;
                        workerBackpressure = true;
                        break;
                    }

                    rememberCheckedOverlapRepairPair(state, pairVersionKey);
                    item.cursor++;
                    processedPairs++;
                    addCaptureApplyCount(metrics, "overlapRepairQueueProcessedCount", 1);
                    addCaptureApplyCount(metrics, "overlapRepairWorkerDispatchedCount", 1);
                    recordCaptureApplyMax(
                        metrics,
                        "overlapRepairWorkerInFlightCount",
                        state.inFlightPairKeys.size
                    );
                    continue;
                }

                const repair = repairTerritoryOverlapPair(
                    territories,
                    item.changedPlayerId,
                    otherPlayerId,
                    item.ownerId,
                    new Set([item.changedPlayerId]),
                    players,
                    metrics,
                    {
                        diagnostics,
                        phasePrefix: "overlapRepairQueuePair"
                    }
                );

                rememberCheckedOverlapRepairPair(state, pairVersionKey);
                item.cursor++;
                processedPairs++;
                addCaptureApplyCount(metrics, "overlapRepairQueueProcessedCount", 1);

                if (repair.changed) {
                    registerChangedTerritoryRepair(
                        territories,
                        metrics,
                        changedPlayerIds,
                        repair.changedPlayerId,
                        item.ownerId,
                        item.changedPlayerId,
                        otherPlayerId
                    );
                }
            }

            const refreshRequest = state.refreshRequests.get(item.changedPlayerId);

            if (refreshRequest) {
                state.refreshRequests.delete(item.changedPlayerId);
                refreshOverlapRepairItem(
                    item,
                    territories,
                    item.changedPlayerId,
                    refreshRequest
                );
                state.pending.push(item);
            } else if (itemCompleted && item.cursor >= item.candidateIds.length) {
                state.pendingIds.delete(item.changedPlayerId);
            } else {
                state.pending.push(item);
            }

            if (workerBackpressure) {
                break;
            }
        }

        compactOverlapRepairQueue(state);
        const pendingCount = getPendingOverlapRepairCount(state);

        if (budgetHit || pendingCount > 0) {
            addCaptureApplyCount(metrics, "overlapRepairQueueBudgetHitCount", budgetHit ? 1 : 0);
        }

        recordCaptureApplyMax(metrics, "overlapRepairQueuePendingCount", pendingCount);
        recordCaptureApplyMax(
            metrics,
            "overlapRepairWorkerInFlightCount",
            state.inFlightPairKeys.size
        );

        return changedPlayerIds;
    }

    function createTerritoryRepairWorkerCandidate(
        territories,
        firstPlayerId,
        secondPlayerId,
        ownerId,
        metrics,
        options = {}
    ) {
        const phasePrefix = options.phasePrefix || "overlapRepairQueuePair";
        const firstTerritory = territories.get(firstPlayerId);
        const secondTerritory = territories.get(secondPlayerId);
        const firstBounds = getTerritoryBounds(firstTerritory);
        const secondBounds = getTerritoryBounds(secondTerritory);

        if (!firstTerritory || !secondTerritory || !firstBounds || !secondBounds) {
            return null;
        }

        addCaptureApplyCount(metrics, "postCaptureOverlapCheckCount", 1);

        if (!measureCaptureApplyPhase(options.diagnostics, `${phasePrefix}Bounds`, () => (
            doBoundsOverlap(firstBounds, secondBounds)
        ))) {
            addCaptureApplyCount(metrics, "postCaptureOverlapBoundsRejectedCount", 1);
            return null;
        }

        if (!measureCaptureApplyPhase(options.diagnostics, `${phasePrefix}Overlap`, () => (
            doPolygonsHavePositiveAreaOverlap(
                firstTerritory.polygon,
                secondTerritory.polygon,
                firstBounds,
                secondBounds
            )
        ))) {
            return null;
        }

        const changedPlayerIds = new Set([firstPlayerId]);
        const winnerId = selectOverlapWinnerId(
            firstPlayerId,
            firstTerritory,
            secondPlayerId,
            secondTerritory,
            ownerId,
            changedPlayerIds
        );
        const loserId = winnerId === firstPlayerId ? secondPlayerId : firstPlayerId;

        return {
            changedPlayerId: firstPlayerId,
            first: createTerritoryWorkerSnapshot(firstPlayerId, firstTerritory),
            loserId,
            otherPlayerId: secondPlayerId,
            overlapDetail: createPostCaptureOverlapDetail(
                firstPlayerId,
                secondPlayerId,
                firstTerritory,
                secondTerritory
            ),
            ownerId,
            second: createTerritoryWorkerSnapshot(secondPlayerId, secondTerritory),
            winnerId
        };
    }

    function createTerritoryWorkerSnapshot(id, territory) {
        return {
            id,
            polygon: territory.polygon,
            version: territory.version || 0
        };
    }

    function dispatchTerritoryRepairWorkerCandidate(
        state,
        candidate,
        players,
        pairVersionKey
    ) {
        const maxInFlight = getOverlapRepairWorkerMaxInFlight();

        if (getTerritoryRepairWorkerPendingCount() >= maxInFlight
            || state.inFlightPairKeys.has(pairVersionKey)) {
            return false;
        }

        const dispatchedAt = getHighResolutionTime();
        const jobId = submitTerritoryRepairJob(
            {
                areaEpsilon: territoryChangeAreaEpsilon,
                first: candidate.first,
                loserId: candidate.loserId,
                loserPlayer: createTerritoryRetentionPlayerSnapshot(players.get(candidate.loserId)),
                second: candidate.second,
                winnerId: candidate.winnerId
            },
            response => {
                state.completedJobs.push({
                    candidate,
                    completedAt: getHighResolutionTime(),
                    dispatchedAt,
                    pairVersionKey,
                    response
                });
            },
            maxInFlight
        );

        if (!jobId) {
            return false;
        }

        state.inFlightPairKeys.add(pairVersionKey);
        return true;
    }

    function createTerritoryRetentionPlayerSnapshot(player) {
        if (!player) {
            return null;
        }

        return {
            isLeftTrailActive: Boolean(player.isLeftTrailActive),
            isRightTrailActive: Boolean(player.isRightTrailActive),
            trailLeftSegments: createCompactTrailSegments(player.trailLeftSegments),
            trailRightSegments: createCompactTrailSegments(player.trailRightSegments),
            x: Number.isFinite(player.x) ? player.x : null,
            y: Number.isFinite(player.y) ? player.y : null
        };
    }

    function createCompactTrailSegments(segments) {
        if (!Array.isArray(segments)) {
            return [];
        }

        for (let index = segments.length - 1; index >= 0; index--) {
            const segment = segments[index];

            if (!Array.isArray(segment) || segment.length < 2) {
                continue;
            }

            const first = segment[0];
            const last = segment[segment.length - 1];

            if (!isFiniteTrailPoint(first) || !isFiniteTrailPoint(last)) {
                return [];
            }

            return [[
                { x: first.x, y: first.y },
                { x: last.x, y: last.y }
            ]];
        }

        return [];
    }

    function isFiniteTrailPoint(point) {
        return point && Number.isFinite(point.x) && Number.isFinite(point.y);
    }

    function applyCompletedTerritoryRepairJobs(
        territories,
        state,
        metrics,
        changedPlayerIds
    ) {
        const completedJobs = state.completedJobs;
        state.completedJobs = [];

        for (const completed of completedJobs) {
            const { candidate, pairVersionKey, response } = completed;

            state.inFlightPairKeys.delete(pairVersionKey);
            addCaptureApplyCount(metrics, "overlapRepairWorkerCompletedCount", 1);
            recordCaptureApplyMax(
                metrics,
                "overlapRepairWorkerLatencyMs",
                completed.completedAt - completed.dispatchedAt
            );

            if (!response || response.error) {
                addCaptureApplyCount(metrics, "overlapRepairWorkerFailedCount", 1);
                forgetCheckedOverlapRepairPair(state, pairVersionKey);
                requeueTerritoryRepairWorkerCandidate(territories, state, candidate, metrics);
                continue;
            }

            const result = response.result;

            recordCaptureApplyMax(metrics, "overlapRepairWorkerComputeMs", result && result.totalMs);
            recordCaptureApplyMax(metrics, "overlapRepairWorkerIntersectionMs", result && result.intersectionMs);
            recordCaptureApplyMax(metrics, "overlapRepairWorkerSubtractMs", result && result.subtractMs);

            if (!isTerritoryRepairWorkerCandidateCurrent(territories, candidate)) {
                addCaptureApplyCount(metrics, "overlapRepairWorkerStaleCount", 1);
                requeueTerritoryRepairWorkerCandidate(territories, state, candidate, metrics);
                continue;
            }

            if (!result || !result.changed) {
                addCaptureApplyCount(metrics, "overlapRepairWorkerNoChangeCount", 1);
                continue;
            }

            const loserTerritory = territories.get(candidate.loserId);

            if (!updateTerritoryPolygon(loserTerritory, result.retainedPolygon)) {
                addCaptureApplyCount(metrics, "overlapRepairWorkerNoChangeCount", 1);
                continue;
            }

            addCaptureApplyCount(metrics, "postCaptureOverlapCount", 1);
            addCaptureApplyCount(metrics, "postCaptureOverlapRepairCount", 1);
            addCaptureApplyCount(metrics, "postCaptureOverlapRepairChangedCount", 1);
            addCaptureApplyCount(metrics, "overlapRepairWorkerChangedCount", 1);
            recordFirstPostCaptureOverlap(metrics, candidate.overlapDetail, result.overlapArea);
            registerChangedTerritoryRepair(
                territories,
                metrics,
                changedPlayerIds,
                candidate.loserId,
                candidate.ownerId,
                candidate.changedPlayerId,
                candidate.otherPlayerId
            );
        }
    }

    function isTerritoryRepairWorkerCandidateCurrent(territories, candidate) {
        const firstTerritory = territories.get(candidate.first.id);
        const secondTerritory = territories.get(candidate.second.id);

        return Boolean(
            firstTerritory
            && secondTerritory
            && (firstTerritory.version || 0) === candidate.first.version
            && (secondTerritory.version || 0) === candidate.second.version
        );
    }

    function requeueTerritoryRepairWorkerCandidate(territories, state, candidate, metrics) {
        const pendingItem = findPendingOverlapRepairItem(state, item => (
            item && item.changedPlayerId === candidate.changedPlayerId
        ));

        if (pendingItem) {
            const remainingCandidateIds = pendingItem.candidateIds.slice(pendingItem.cursor);

            if (!remainingCandidateIds.includes(candidate.otherPlayerId)) {
                pendingItem.candidateIds.splice(
                    pendingItem.cursor,
                    0,
                    candidate.otherPlayerId
                );
            }
            return;
        }

        enqueueTerritoryOverlapRepair(territories, candidate.changedPlayerId, {
            metrics,
            ownerId: candidate.ownerId,
            priorityCandidateIds: [candidate.changedPlayerId, candidate.otherPlayerId]
        });
    }

    function registerChangedTerritoryRepair(
        territories,
        metrics,
        changedPlayerIds,
        changedPlayerId,
        ownerId,
        firstPlayerId,
        secondPlayerId
    ) {
        addCaptureApplyCount(metrics, "overlapRepairQueueChangedCount", 1);
        addCaptureApplyCount(metrics, "changedTerritoryCount", 1);
        changedPlayerIds.add(changedPlayerId);
        enqueueTerritoryOverlapRepair(territories, changedPlayerId, {
            metrics,
            ownerId,
            priorityCandidateIds: [firstPlayerId, secondPlayerId]
        });
    }

    function enqueueTerritoryOverlapRepair(territories, changedPlayerId, options = {}) {
        if (!territories || !territories.has(changedPlayerId)) {
            return false;
        }

        const state = getTerritoryOverlapRepairQueueState(territories, true);

        if (state.pendingIds.has(changedPlayerId)) {
            const pendingItem = findPendingOverlapRepairItem(state, item => (
                item && item.changedPlayerId === changedPlayerId
            ));

            if (pendingItem) {
                refreshOverlapRepairItem(
                    pendingItem,
                    territories,
                    changedPlayerId,
                    options
                );
            } else {
                mergeOverlapRepairRefreshRequest(state, changedPlayerId, options);
            }

            addCaptureApplyCount(options.metrics, "overlapRepairQueueRefreshCount", 1);
            return true;
        }

        const candidateIds = createOverlapRepairQueueCandidateIds(
            territories,
            changedPlayerId,
            options.priorityCandidateIds
        );

        if (candidateIds.length <= 0) {
            return false;
        }

        state.pending.push({
            candidateIds,
            changedPlayerId,
            cursor: 0,
            ownerId: options.ownerId || changedPlayerId
        });
        state.pendingIds.add(changedPlayerId);
        trimOverlapRepairQueue(state);
        addCaptureApplyCount(options.metrics, "overlapRepairQueueQueuedCount", 1);
        recordCaptureApplyMax(
            options.metrics,
            "overlapRepairQueuePendingCount",
            getPendingOverlapRepairCount(state)
        );

        return true;
    }

    function getTerritoryOverlapRepairQueueState(territories, create) {
        if (!territories) {
            return null;
        }

        let state = overlapRepairQueueStates.get(territories);

        if (!state && create) {
            state = {
                checkedPairs: new Set(),
                completedJobs: [],
                inFlightPairKeys: new Set(),
                pending: [],
                pendingHead: 0,
                pendingIds: new Set(),
                refreshRequests: new Map()
            };
            overlapRepairQueueStates.set(territories, state);
        }

        return state;
    }

    function getTerritoryOverlapRepairQueueDiagnostics(territories) {
        const state = getTerritoryOverlapRepairQueueState(territories, false);

        if (!state) {
            return {
                completedJobs: 0,
                inFlightPairs: 0,
                pendingItems: 0,
                refreshRequests: 0
            };
        }

        return {
            completedJobs: state.completedJobs.length,
            inFlightPairs: state.inFlightPairKeys.size,
            pendingItems: getPendingOverlapRepairCount(state),
            refreshRequests: state.refreshRequests.size
        };
    }

    function createOverlapRepairQueueCandidateIds(territories, changedPlayerId, priorityCandidateIds) {
        const candidateIds = [];
        const seenIds = new Set([changedPlayerId]);

        appendOverlapRepairQueueCandidateIds(candidateIds, seenIds, territories, priorityCandidateIds);
        appendOverlapRepairQueueCandidateIds(candidateIds, seenIds, territories, territories.keys());

        return candidateIds;
    }

    function appendOverlapRepairQueueCandidateIds(target, seenIds, territories, sourceIds) {
        for (const candidateId of sourceIds || []) {
            if (seenIds.has(candidateId) || !territories.has(candidateId)) {
                continue;
            }

            seenIds.add(candidateId);
            target.push(candidateId);
        }
    }

    function refreshOverlapRepairItem(item, territories, changedPlayerId, options = {}) {
        item.candidateIds = createOverlapRepairQueueCandidateIds(
            territories,
            changedPlayerId,
            options.priorityCandidateIds
        );
        item.cursor = 0;
        item.ownerId = options.ownerId || item.ownerId || changedPlayerId;
    }

    function mergeOverlapRepairRefreshRequest(state, changedPlayerId, options = {}) {
        const previous = state.refreshRequests.get(changedPlayerId);
        const priorityCandidateIds = new Set(previous && previous.priorityCandidateIds || []);

        for (const candidateId of options.priorityCandidateIds || []) {
            priorityCandidateIds.add(candidateId);
        }

        state.refreshRequests.set(changedPlayerId, {
            ownerId: options.ownerId || previous && previous.ownerId || changedPlayerId,
            priorityCandidateIds: [...priorityCandidateIds]
        });
    }

    function trimOverlapRepairQueue(state) {
        const maxItems = getOverlapRepairQueueMaxItems();

        while (getPendingOverlapRepairCount(state) > maxItems) {
            const removed = dequeueOverlapRepairItem(state);

            if (removed) {
                state.pendingIds.delete(removed.changedPlayerId);
                state.refreshRequests.delete(removed.changedPlayerId);
            }
        }

        compactOverlapRepairQueue(state);
    }

    function hasPendingOverlapRepairItems(state) {
        return getPendingOverlapRepairCount(state) > 0;
    }

    function getPendingOverlapRepairCount(state) {
        return Math.max(0, state.pending.length - state.pendingHead);
    }

    function dequeueOverlapRepairItem(state) {
        if (!hasPendingOverlapRepairItems(state)) {
            return null;
        }

        const item = state.pending[state.pendingHead];

        state.pending[state.pendingHead] = null;
        state.pendingHead++;
        return item;
    }

    function findPendingOverlapRepairItem(state, predicate) {
        for (let index = state.pendingHead; index < state.pending.length; index++) {
            const item = state.pending[index];

            if (predicate(item)) {
                return item;
            }
        }

        return null;
    }

    function compactOverlapRepairQueue(state) {
        if (state.pendingHead === 0) {
            return;
        }

        if (state.pendingHead >= state.pending.length) {
            state.pending.length = 0;
            state.pendingHead = 0;
            return;
        }

        if (state.pendingHead >= 64 || state.pendingHead * 2 >= state.pending.length) {
            state.pending = state.pending.slice(state.pendingHead);
            state.pendingHead = 0;
        }
    }

    function rememberCheckedOverlapRepairPair(state, pairVersionKey) {
        if (!pairVersionKey) {
            return false;
        }

        if (state.checkedPairs.has(pairVersionKey)) {
            return true;
        }

        state.checkedPairs.add(pairVersionKey);

        const maxSize = getOverlapRepairQueueCheckedPairCacheSize();

        while (state.checkedPairs.size > maxSize) {
            const oldestPairVersionKey = state.checkedPairs.values().next().value;
            state.checkedPairs.delete(oldestPairVersionKey);
        }

        return false;
    }

    function forgetCheckedOverlapRepairPair(state, pairVersionKey) {
        if (state && pairVersionKey) {
            state.checkedPairs.delete(pairVersionKey);
        }
    }

    function createTerritoryPairVersionKey(territories, firstPlayerId, secondPlayerId) {
        const firstTerritory = territories.get(firstPlayerId);
        const secondTerritory = territories.get(secondPlayerId);

        if (!firstTerritory || !secondTerritory) {
            return null;
        }

        return [
            createTerritoryPairKey(firstPlayerId, secondPlayerId),
            firstTerritory.version || 0,
            secondTerritory.version || 0
        ].join(":");
    }

    function hasOverlapRepairQueueBudget(startedAt, budgetMs) {
        return !Number.isFinite(budgetMs)
            || budgetMs <= 0
            || getHighResolutionTime() - startedAt < budgetMs;
    }

    function getOverlapRepairQueueBudgetMs() {
        const value = Number(config.territory.overlapRepairQueueBudgetMs);

        return Number.isFinite(value) && value > 0 ? value : 4;
    }

    function getOverlapRepairQueueMaxPairsPerTick() {
        const value = Number(config.territory.overlapRepairQueueMaxPairsPerTick);

        return Number.isInteger(value) && value > 0 ? value : 10;
    }

    function getOverlapRepairQueueMaxItems() {
        const value = Number(config.territory.overlapRepairQueueMaxItems);

        return Number.isInteger(value) && value > 0 ? value : 128;
    }

    function getOverlapRepairQueueCheckedPairCacheSize() {
        const value = Number(config.territory.overlapRepairQueueCheckedPairCacheSize);

        return Number.isInteger(value) && value > 0 ? value : 512;
    }

    function isTerritoryRepairWorkerEnabled() {
        return config.territory.overlapRepairWorkerEnabled !== false;
    }

    function getOverlapRepairWorkerMaxInFlight() {
        const value = Number(config.territory.overlapRepairWorkerMaxInFlight);

        return Number.isInteger(value) && value > 0 ? value : 2;
    }

    function trimTerritoryOverlap(loserTerritory, winnerTerritory, loserPlayer, options = {}) {
        if (!loserTerritory || !winnerTerritory) {
            return createTerritoryTrimResult(false);
        }

        const loserPolygon = loserTerritory.polygon;
        const winnerPolygon = winnerTerritory.polygon;
        const subtract = subtractTerritoryPolygon(
            loserTerritory,
            winnerPolygon,
            createIdentityOperationPolygon(
                winnerPolygon,
                getPolygonPointCount(winnerPolygon)
            ),
            loserPlayer,
            {
                ...options,
                subjectOperation: createIdentityOperationPolygon(
                    loserPolygon,
                    getPolygonPointCount(loserPolygon)
                )
            }
        );

        return createTerritoryTrimResult(
            updateTerritoryPolygon(loserTerritory, subtract.retainedPolygon),
            subtract.removedArea
        );
    }

    function createTerritoryTrimResult(changed, removedArea = 0) {
        return {
            changed,
            removedArea: Number.isFinite(removedArea) ? Math.max(0, removedArea) : 0
        };
    }

    function selectOverlapWinnerId(firstId, firstTerritory, secondId, secondTerritory, ownerId, changedPlayerIds) {
        if (firstId === ownerId || secondId === ownerId) {
            return firstId === ownerId ? firstId : secondId;
        }

        const firstVersion = firstTerritory && firstTerritory.version || 0;
        const secondVersion = secondTerritory && secondTerritory.version || 0;

        if (firstVersion !== secondVersion) {
            return firstVersion > secondVersion ? firstId : secondId;
        }

        const firstChanged = changedPlayerIds.has(firstId);
        const secondChanged = changedPlayerIds.has(secondId);

        if (firstChanged !== secondChanged) {
            return firstChanged ? firstId : secondId;
        }

        const firstArea = getTerritoryArea(firstTerritory);
        const secondArea = getTerritoryArea(secondTerritory);

        if (Math.abs(firstArea - secondArea) > territoryChangeAreaEpsilon) {
            return firstArea > secondArea ? firstId : secondId;
        }

        return firstId < secondId ? firstId : secondId;
    }

    function auditChangedTerritoryOverlaps(territories, changedPlayerIds, metrics) {
        if (!metrics || !changedPlayerIds || changedPlayerIds.size <= 0) {
            return;
        }

        const checkedPairs = new Set();

        for (const changedPlayerId of changedPlayerIds) {
            const changedTerritory = territories.get(changedPlayerId);

            if (!changedTerritory) {
                continue;
            }

            const changedBounds = getTerritoryBounds(changedTerritory);

            if (!changedBounds) {
                continue;
            }

            for (const [otherPlayerId, otherTerritory] of territories.entries()) {
                if (otherPlayerId === changedPlayerId || !otherTerritory) {
                    continue;
                }

                const pairKey = createTerritoryPairKey(changedPlayerId, otherPlayerId);

                if (checkedPairs.has(pairKey)) {
                    continue;
                }

                checkedPairs.add(pairKey);
                addCaptureApplyCount(metrics, "postCaptureOverlapCheckCount", 1);

                const otherBounds = getTerritoryBounds(otherTerritory);

                if (!doBoundsOverlap(changedBounds, otherBounds)) {
                    addCaptureApplyCount(metrics, "postCaptureOverlapBoundsRejectedCount", 1);
                    continue;
                }

                const overlapArea = calculatePolygonIntersectionArea(changedTerritory.polygon, otherTerritory.polygon);

                if (overlapArea <= territoryChangeAreaEpsilon) {
                    continue;
                }

                addCaptureApplyCount(metrics, "postCaptureOverlapCount", 1);
                recordFirstPostCaptureOverlap(metrics, changedPlayerId, otherPlayerId, changedTerritory, otherTerritory, overlapArea);
            }
        }
    }

    function createTerritoryPairKey(firstId, secondId) {
        return firstId < secondId
            ? `${firstId}\0${secondId}`
            : `${secondId}\0${firstId}`;
    }

    function createPostCaptureOverlapDetail(firstId, secondId, firstTerritory, secondTerritory) {
        return {
            firstId,
            firstPointCount: getPolygonPointCount(firstTerritory && firstTerritory.polygon),
            firstVersion: firstTerritory && firstTerritory.version || 0,
            secondId,
            secondPointCount: getPolygonPointCount(secondTerritory && secondTerritory.polygon),
            secondVersion: secondTerritory && secondTerritory.version || 0
        };
    }

    function recordFirstPostCaptureOverlap(metrics, detail, overlapArea) {
        if (!metrics || metrics.postCaptureOverlapFirst) {
            return;
        }

        metrics.postCaptureOverlapFirst = {
            ...detail,
            overlapArea: roundToMilliseconds(overlapArea),
        };
    }

    function getBoundsArea(bounds) {
        if (!bounds) {
            return 0;
        }

        return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
    }



    function getTerritoryArea(territory) {
        return Number.isFinite(territory && territory.area)
            ? territory.area
            : calculatePolygonArea(territory && territory.polygon);
    }

    function getTerritoryBounds(territory) {
        return territory && territory.bounds
            ? territory.bounds
            : getPolygonBounds(territory && territory.polygon);
    }

    return {
        auditChangedTerritoryOverlaps,
        getBoundsArea,
        getTerritoryOverlapRepairQueueDiagnostics,
        processTerritoryOverlapRepairQueue,
        repairChangedTerritoryOverlaps,
        scheduleTerritoryOverlapRepairQueue
    };
}

module.exports = {
    createTerritoryOverlapRepair
};
