const config = require("../config/gameConfig");
const {
    calculatePolygonIntersectionArea,
    calculatePolygonArea,
    createCirclePolygon,
    createOperationalPolygon,
    doBoundsContainBounds,
    doBoundsOverlap,
    doPolygonsHavePositiveAreaOverlap,
    doPolygonsOverlap,
    getPolygonBounds,
    getPolygonPointCount,
    isPointInPolygon,
    isPolygonInsidePolygon,
    serializePolygon,
    subtractPolygonComponents,
    unionPolygons
} = require("../utils/geometry");
const { selectRetainedTerritoryPolygon } = require("./territoryRetention");
const {
    getTerritoryRepairWorkerPendingCount,
    submitTerritoryRepairJob
} = require("./territoryRepairWorkerPool");
const { getHighResolutionTime } = require("../utils/time");

const territoryChangeAreaEpsilon = 1;
const operationSimplifyMaxAreaDrift = config.world.playerSize * config.world.playerSize;
const overlapRepairQueueStates = new WeakMap();
const territoryOperationPolygonCaches = new WeakMap();

function createTerritories() {
    return new Map();
}

function initializePlayerTerritory(territories, player, runtimeConfig = config) {
    const territoryConfig = runtimeConfig && runtimeConfig.territory ? runtimeConfig.territory : config.territory;
    const worldConfig = runtimeConfig && runtimeConfig.world ? runtimeConfig.world : config.world;
    const previousTerritory = territories.get(player.id);

    territories.set(player.id, createTerritoryState({
        id: player.id,
        color: player.color,
        version: previousTerritory ? (previousTerritory.version || 0) + 1 : 1,
        baseX: player.territoryX,
        baseY: player.territoryY,
        captureOperationLog: [],
        polygon: createCirclePolygon(
            player.territoryX,
            player.territoryY,
            worldConfig.initialTerritoryRadius,
            territoryConfig.circleSegments
        )
    }));
}

function deletePlayerTerritory(territories, playerId) {
    territories.delete(playerId);
}

function isPointOwnedByPlayer(territories, playerId, x, y) {
    const territory = territories.get(playerId);

    if (!territory) {
        return false;
    }

    return isPointInPolygon(territory.polygon, x, y);
}

function getPlayerTerritoryPolygon(territories, playerId) {
    const territory = territories.get(playerId);

    if (!territory) {
        return [];
    }

    return territory.polygon;
}

function applyCapturedPolygon(territories, ownerId, capturedPolygon, options = {}) {
    const changedPlayerIds = new Set();
    const diagnostics = getCaptureApplyDiagnostics(options);
    const captureApply = getCaptureApplyMetrics(diagnostics);
    const territory = territories.get(ownerId);
    const captureRepairCandidateIds = new Set();

    addCaptureApplyCount(captureApply, "calls", 1);
    recordCaptureApplyMax(captureApply, "maxTerritoryCount", territories.size);
    recordCaptureApplyMax(captureApply, "maxCapturedPointCount", getPolygonPointCount(capturedPolygon));
    recordCaptureApplyMax(captureApply, "maxCapturedArea", measureCaptureApplyPhase(diagnostics, "captureApplyCapturedArea", () => (
        calculatePolygonArea(capturedPolygon)
    )));

    if (!territory) {
        addCaptureApplyCount(captureApply, "missingOwnerTerritoryCount", 1);
        return changedPlayerIds;
    }

    const ownerPolygon = measureCaptureApplyPhase(diagnostics, "captureApplyOwnerPolygon", () => (
        getOwnerCapturedPolygon(territory.polygon, capturedPolygon, options.ownerPolygon)
    ));

    recordCaptureApplyMax(captureApply, "maxOwnerPointCount", getPolygonPointCount(ownerPolygon));
    recordCaptureApplyMax(captureApply, "maxOwnerArea", calculatePolygonArea(ownerPolygon));

    if (measureCaptureApplyPhase(diagnostics, "captureApplyUpdateTerritory", () => (
        updateTerritoryPolygon(territory, ownerPolygon, { preserveCaptureOperationLog: true })
    ))) {
        addCaptureApplyCount(captureApply, "ownerChangedCount", 1);
        addCaptureApplyCount(captureApply, "changedTerritoryCount", 1);
        changedPlayerIds.add(ownerId);
    }

    const capturedBounds = measureCaptureApplyPhase(diagnostics, "captureApplyBounds", () => (
        getPolygonBounds(capturedPolygon)
    ));
    recordCaptureApplyMax(captureApply, "maxCapturedBoundsArea", getBoundsArea(capturedBounds));

    if (!capturedBounds) {
        addCaptureApplyCount(captureApply, "emptyCapturedBoundsCount", 1);
    }

    let capturedOperation = null;

    for (const [playerId, otherTerritory] of territories.entries()) {
        if (playerId === ownerId) {
            continue;
        }

        addCaptureApplyCount(captureApply, "candidateCount", 1);

        const otherBounds = getTerritoryBounds(otherTerritory);

        const overlapsBounds = Boolean(capturedBounds) && measureCaptureApplyPhase(diagnostics, "captureApplyBoundsFilter", () => (
            doBoundsOverlap(otherBounds, capturedBounds)
        ));

        if (!overlapsBounds) {
            addCaptureApplyCount(captureApply, "boundsRejectedCount", 1);
            continue;
        }

        captureRepairCandidateIds.add(playerId);
        addCaptureApplyCount(captureApply, "boundsOverlapCount", 1);

        const overlap = measureCaptureApplyOperation(diagnostics, "captureApplyOverlapFilter", () => (
            doPolygonsOverlap(otherTerritory.polygon, capturedPolygon, otherBounds, capturedBounds)
        ));

        recordSlowestCaptureApplyOverlap(captureApply, {
            durationMs: overlap.durationMs,
            hit: overlap.value,
            playerId,
            subjectPointCount: getPolygonPointCount(otherTerritory.polygon)
        });

        if (!overlap.value) {
            addCaptureApplyCount(captureApply, "overlapRejectedCount", 1);
            continue;
        }

        addCaptureApplyCount(captureApply, "overlapCount", 1);
        const subjectPointCount = getPolygonPointCount(otherTerritory.polygon);

        if (doBoundsContainBounds(capturedBounds, otherBounds)) {
            const containsTerritory = measureCaptureApplyPhase(diagnostics, "captureApplyContainmentFilter", () => (
                isPolygonInsidePolygon(otherTerritory.polygon, capturedPolygon, otherBounds, capturedBounds)
            ));

            if (containsTerritory) {
                const changed = measureCaptureApplyPhase(diagnostics, "captureApplyUpdateTerritory", () => (
                    updateTerritoryPolygon(otherTerritory, [])
                ));

                if (changed) {
                    addCaptureApplyCount(captureApply, "changedTerritoryCount", 1);
                    changedPlayerIds.add(playerId);
                }

                continue;
            }
        }

        addCaptureApplyCount(captureApply, "subtractCount", 1);
        addCaptureApplyCount(captureApply, "subtractPointCount", subjectPointCount);
        const previousArea = getTerritoryArea(otherTerritory);
        const subjectOperation = getTerritoryOperationPolygon(
            otherTerritory,
            captureApply,
            diagnostics,
            "subject",
            "captureApplySimplifySubject"
        );
        capturedOperation = capturedOperation || getCapturedOperationPolygon(capturedPolygon, captureApply, diagnostics);
        const subtract = measureCaptureApplyOperation(diagnostics, "captureApplySubtractTotal", () => (
            subtractTerritoryPolygon(
                otherTerritory,
                capturedPolygon,
                capturedOperation,
                options.players && options.players.get(playerId),
                {
                    diagnostics,
                    metrics: captureApply,
                    phasePrefix: "captureApply",
                    subjectOperation
                }
            )
        ));
        const retainedPolygon = subtract.value.retainedPolygon;
        const resultPointCount = getPolygonPointCount(retainedPolygon);
        const operationSubjectArea = subtract.value.operationSubjectArea;
        const operationResultArea = subtract.value.operationResultArea;
        const operationAreaDelta = Math.abs(operationSubjectArea - operationResultArea);
        addCaptureApplyCount(captureApply, "subtractOperationPointCount", subjectOperation.outputPointCount);
        addCaptureApplyCount(captureApply, "subtractOperationClippingPointCount", capturedOperation.outputPointCount);
        addCaptureApplyCount(captureApply, "subtractResultPointCount", resultPointCount);
        const changed = operationAreaDelta > territoryChangeAreaEpsilon
            && measureCaptureApplyPhase(diagnostics, "captureApplyUpdateTerritory", () => (
                updateTerritoryPolygon(otherTerritory, retainedPolygon)
            ));

        recordSlowestCaptureApplySubtract(captureApply, {
            changed,
            clippingPointCount: getPolygonPointCount(capturedPolygon),
            durationMs: subtract.durationMs,
            operationClippingPointCount: capturedOperation.outputPointCount,
            operationResultArea,
            operationSubjectArea,
            operationSubjectPointCount: subjectOperation.outputPointCount,
            playerId,
            resultArea: getTerritoryArea(otherTerritory),
            resultPointCount,
            subjectArea: previousArea,
            subjectPointCount,
            usedFallback: subtract.value.usedFallback,
            usedSimplified: subtract.value.usedSimplified
        });

        if (changed) {
            addCaptureApplyCount(captureApply, "subtractChangedCount", 1);
            addCaptureApplyCount(captureApply, "changedTerritoryCount", 1);
            changedPlayerIds.add(playerId);
        }
    }

    measureCaptureApplyPhase(diagnostics, "captureApplyRepairChangedOverlaps", () => {
        repairChangedTerritoryOverlaps(
            territories,
            ownerId,
            changedPlayerIds,
            {
                ...options,
                captureRepairCandidateIds
            },
            captureApply
        );
    });
    scheduleTerritoryOverlapRepairQueue(territories, changedPlayerIds, {
        metrics: captureApply,
        ownerId,
        priorityCandidateIds: captureRepairCandidateIds
    });

    if (options.captureOverlapAudit === true) {
        measureCaptureApplyPhase(diagnostics, "captureApplyPostOverlapAudit", () => {
            auditChangedTerritoryOverlaps(territories, changedPlayerIds, captureApply);
        });
    }

    return changedPlayerIds;
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
    let repairPasses = 0;

    while (pendingIds.length > 0 && repairPasses < maxRepairPasses) {
        const changedPlayerId = pendingIds.shift();

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

    if (state.pending.length <= 0) {
        return changedPlayerIds;
    }

    const startedAt = getHighResolutionTime();
    const maxPairs = getOverlapRepairQueueMaxPairsPerTick();
    const budgetMs = getOverlapRepairQueueBudgetMs();
    let processedPairs = 0;
    let budgetHit = false;
    let workerBackpressure = false;

    while (state.pending.length > 0 && processedPairs < maxPairs) {
        if (!hasOverlapRepairQueueBudget(startedAt, budgetMs)) {
            budgetHit = true;
            break;
        }

        const item = state.pending.shift();

        if (!item || !territories.has(item.changedPlayerId)) {
            if (item) {
                state.pendingIds.delete(item.changedPlayerId);
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

        if (itemCompleted && item.cursor >= item.candidateIds.length) {
            state.pendingIds.delete(item.changedPlayerId);
        } else {
            state.pending.push(item);
        }

        if (workerBackpressure) {
            break;
        }
    }

    if (budgetHit || state.pending.length > 0) {
        addCaptureApplyCount(metrics, "overlapRepairQueueBudgetHitCount", budgetHit ? 1 : 0);
    }

    recordCaptureApplyMax(metrics, "overlapRepairQueuePendingCount", state.pending.length);
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
    const completedJobs = state.completedJobs.splice(0);

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
    const pendingItem = state.pending.find(item => (
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
        return false;
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
    recordCaptureApplyMax(options.metrics, "overlapRepairQueuePendingCount", state.pending.length);

    return true;
}

function getTerritoryOverlapRepairQueueState(territories, create) {
    if (!territories) {
        return null;
    }

    let state = overlapRepairQueueStates.get(territories);

    if (!state && create) {
        state = {
            checkedPairOrder: [],
            checkedPairs: new Set(),
            completedJobs: [],
            inFlightPairKeys: new Set(),
            pending: [],
            pendingIds: new Set()
        };
        overlapRepairQueueStates.set(territories, state);
    }

    return state;
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

function trimOverlapRepairQueue(state) {
    const maxItems = getOverlapRepairQueueMaxItems();

    while (state.pending.length > maxItems) {
        const removed = state.pending.shift();

        if (removed) {
            state.pendingIds.delete(removed.changedPlayerId);
        }
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
    state.checkedPairOrder.push(pairVersionKey);

    const maxSize = getOverlapRepairQueueCheckedPairCacheSize();

    while (state.checkedPairOrder.length > maxSize) {
        const removed = state.checkedPairOrder.shift();
        state.checkedPairs.delete(removed);
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

function getCaptureApplyDiagnostics(options) {
    return options && options.diagnostics || null;
}

function getCaptureApplyMetrics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    if (!diagnostics.captureApply || typeof diagnostics.captureApply !== "object") {
        diagnostics.captureApply = createCaptureApplyMetrics();
    }

    return ensureCaptureApplyMetrics(diagnostics.captureApply);
}

function createCaptureApplyMetrics() {
    return {
        boundsOverlapCount: 0,
        boundsRejectedCount: 0,
        calls: 0,
        candidateCount: 0,
        changedTerritoryCount: 0,
        emptyCapturedBoundsCount: 0,
        maxCapturedArea: 0,
        maxCapturedBoundsArea: 0,
        maxCapturedPointCount: 0,
        maxOwnerArea: 0,
        maxOwnerPointCount: 0,
        maxTerritoryCount: 0,
        missingOwnerTerritoryCount: 0,
        overlapCount: 0,
        overlapRejectedCount: 0,
        operationSimplifyAttemptCount: 0,
        operationSimplifyCacheHitCount: 0,
        operationSimplifyCapturedCount: 0,
        operationSimplifyHitCount: 0,
        operationSimplifyInputPointCount: 0,
        operationSimplifyMaxAreaDrift: 0,
        operationSimplifyMaxAreaDriftRatio: 0,
        operationSimplifyOutputPointCount: 0,
        operationSimplifySubjectCount: 0,
        operationSubtractFallbackCount: 0,
        operationSubtractMaxResidualOverlapArea: 0,
        operationSubtractValidationCount: 0,
        operationSubtractValidationRejectedCount: 0,
        overlapRepairQueueBudgetHitCount: 0,
        overlapRepairQueueChangedCount: 0,
        overlapRepairQueuePendingCount: 0,
        overlapRepairQueueProcessedCount: 0,
        overlapRepairQueueQueuedCount: 0,
        overlapRepairWorkerBackpressureCount: 0,
        overlapRepairWorkerChangedCount: 0,
        overlapRepairWorkerCompletedCount: 0,
        overlapRepairWorkerComputeMs: 0,
        overlapRepairWorkerDispatchedCount: 0,
        overlapRepairWorkerFailedCount: 0,
        overlapRepairWorkerInFlightCount: 0,
        overlapRepairWorkerIntersectionMs: 0,
        overlapRepairWorkerLatencyMs: 0,
        overlapRepairWorkerNoChangeCount: 0,
        overlapRepairWorkerStaleCount: 0,
        overlapRepairWorkerSubtractMs: 0,
        ownerChangedCount: 0,
        postCaptureOverlapBoundsRejectedCount: 0,
        postCaptureOverlapCheckCount: 0,
        postCaptureOverlapCount: 0,
        postCaptureOverlapFirst: null,
        postCaptureOverlapRepairChangedCount: 0,
        postCaptureOverlapRepairCount: 0,
        slowestOverlap: null,
        slowestSubtract: null,
        subtractChangedCount: 0,
        subtractCount: 0,
        subtractOperationClippingPointCount: 0,
        subtractOperationPointCount: 0,
        subtractPointCount: 0,
        subtractResultPointCount: 0
    };
}

function ensureCaptureApplyMetrics(metrics) {
    const defaults = createCaptureApplyMetrics();

    for (const [name, value] of Object.entries(defaults)) {
        if (!(name in metrics)) {
            metrics[name] = value;
        }
    }

    return metrics;
}

function measureCaptureApplyPhase(diagnostics, name, callback) {
    if (!diagnostics || !diagnostics.phases) {
        return callback();
    }

    const startedAt = getHighResolutionTime();

    try {
        return callback();
    } finally {
        const durationMs = getHighResolutionTime() - startedAt;
        diagnostics.phases[name] = (diagnostics.phases[name] || 0) + durationMs;
    }
}

function measureCaptureApplyOperation(diagnostics, name, callback) {
    if (!diagnostics || !diagnostics.phases) {
        return {
            durationMs: null,
            value: callback()
        };
    }

    const startedAt = getHighResolutionTime();

    try {
        const value = callback();
        const durationMs = getHighResolutionTime() - startedAt;
        diagnostics.phases[name] = (diagnostics.phases[name] || 0) + durationMs;
        return { durationMs, value };
    } catch (error) {
        const durationMs = getHighResolutionTime() - startedAt;
        diagnostics.phases[name] = (diagnostics.phases[name] || 0) + durationMs;
        throw error;
    }
}

function addCaptureApplyCount(metrics, name, value) {
    if (!metrics || !Number.isFinite(value) || value <= 0) {
        return;
    }

    metrics[name] = (metrics[name] || 0) + value;
}

function recordCaptureApplyMax(metrics, name, value) {
    if (!metrics || !Number.isFinite(value)) {
        return;
    }

    metrics[name] = Math.max(metrics[name] || 0, value);
}

function recordSlowestCaptureApplyOverlap(metrics, detail) {
    if (!metrics || !Number.isFinite(detail.durationMs)) {
        return;
    }

    const durationMs = roundToMilliseconds(detail.durationMs);

    if (metrics.slowestOverlap && metrics.slowestOverlap.durationMs >= durationMs) {
        return;
    }

    metrics.slowestOverlap = {
        durationMs,
        hit: Boolean(detail.hit),
        playerId: detail.playerId,
        subjectPointCount: detail.subjectPointCount
    };
}

function recordSlowestCaptureApplySubtract(metrics, detail) {
    if (!metrics || !Number.isFinite(detail.durationMs)) {
        return;
    }

    const durationMs = roundToMilliseconds(detail.durationMs);

    if (metrics.slowestSubtract && metrics.slowestSubtract.durationMs >= durationMs) {
        return;
    }

    metrics.slowestSubtract = {
        changed: Boolean(detail.changed),
        clippingPointCount: detail.clippingPointCount,
        durationMs,
        operationClippingPointCount: detail.operationClippingPointCount,
        operationResultArea: roundToMilliseconds(detail.operationResultArea),
        operationSubjectArea: roundToMilliseconds(detail.operationSubjectArea),
        operationSubjectPointCount: detail.operationSubjectPointCount,
        playerId: detail.playerId,
        resultArea: roundToMilliseconds(detail.resultArea),
        resultPointCount: detail.resultPointCount,
        subjectArea: roundToMilliseconds(detail.subjectArea),
        subjectPointCount: detail.subjectPointCount,
        usedFallback: Boolean(detail.usedFallback),
        usedSimplified: Boolean(detail.usedSimplified)
    };
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

function roundToMilliseconds(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function createTerritoryState(territory) {
    return updateTerritoryMetrics({
        ...territory
    });
}

function updateTerritoryMetrics(territory) {
    territory.area = calculatePolygonArea(territory.polygon);
    territory.bounds = getPolygonBounds(territory.polygon);
    return territory;
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

function getOwnerCapturedPolygon(currentPolygon, capturedPolygon, operationPolygon) {
    return calculatePolygonArea(operationPolygon) > 0
        ? operationPolygon
        : unionPolygons(currentPolygon, capturedPolygon);
}

function subtractTerritoryPolygon(
    subjectTerritory,
    clippingPolygon,
    clippingOperation,
    subjectPlayer,
    options = {}
) {
    const diagnostics = options.diagnostics;
    const metrics = options.metrics;
    const phasePrefix = options.phasePrefix || "territoryOperation";
    const subjectPolygon = subjectTerritory && subjectTerritory.polygon || [];
    const subjectArea = getTerritoryArea(subjectTerritory);
    const subjectOperation = options.subjectOperation || getTerritoryOperationPolygon(
        subjectTerritory,
        metrics,
        diagnostics,
        options.subjectKind || "subject",
        `${phasePrefix}SimplifySubject`
    );
    const safeClippingOperation = clippingOperation || createIdentityOperationPolygon(
        clippingPolygon,
        getPolygonPointCount(clippingPolygon)
    );
    const operationSubjectArea = calculatePolygonArea(subjectOperation.polygon);
    const operationSubtract = measureCaptureApplyOperation(
        diagnostics,
        `${phasePrefix}Subtract`,
        () => subtractPolygonComponents(subjectOperation.polygon, safeClippingOperation.polygon)
    );
    let retainedPolygon = selectRetainedTerritoryPolygon(operationSubtract.value, subjectPlayer);
    let operationResultArea = calculatePolygonArea(retainedPolygon);
    const attemptedSimplified = subjectOperation.simplified || safeClippingOperation.simplified;
    const simplifyAreaDrift = getOperationSubtractAreaDrift(
        subjectOperation,
        safeClippingOperation
    );
    let usedFallback = false;
    let noOverlap = false;

    if (attemptedSimplified) {
        addCaptureApplyCount(metrics, "operationSubtractValidationCount", 1);
        const validation = measureCaptureApplyPhase(
            diagnostics,
            `${phasePrefix}SubtractValidation`,
            () => validateOperationalSubtract(
                subjectPolygon,
                clippingPolygon,
                retainedPolygon,
                {
                    diagnostics,
                    phasePrefix,
                    simplifyAreaDrift,
                    subjectArea
                }
            )
        );

        recordCaptureApplyMax(
            metrics,
            "operationSubtractMaxResidualOverlapArea",
            validation.residualOverlapArea
        );

        if (validation.noOverlap) {
            retainedPolygon = subjectPolygon;
            operationResultArea = subjectArea;
            noOverlap = true;
        } else if (!validation.valid) {
            addCaptureApplyCount(metrics, "operationSubtractValidationRejectedCount", 1);
            addCaptureApplyCount(metrics, "operationSubtractFallbackCount", 1);
            usedFallback = true;
            retainedPolygon = measureCaptureApplyPhase(
                diagnostics,
                `${phasePrefix}SubtractFallback`,
                () => selectRetainedTerritoryPolygon(
                    subtractPolygonComponents(subjectPolygon, clippingPolygon),
                    subjectPlayer
                )
            );
            operationResultArea = calculatePolygonArea(retainedPolygon);
        }
    }

    return {
        noOverlap,
        operationResultArea,
        operationSubjectArea: usedFallback || noOverlap
            ? subjectArea
            : operationSubjectArea,
        removedArea: Math.max(0, subjectArea - operationResultArea),
        retainedPolygon,
        usedFallback,
        usedSimplified: attemptedSimplified && !usedFallback && !noOverlap
    };
}

function validateOperationalSubtract(
    subjectPolygon,
    clippingPolygon,
    retainedPolygon,
    options = {}
) {
    const subjectArea = Number.isFinite(options.subjectArea)
        ? options.subjectArea
        : calculatePolygonArea(subjectPolygon);
    const retainedArea = calculatePolygonArea(retainedPolygon);
    const removedArea = Math.max(0, subjectArea - retainedArea);

    if (retainedArea > subjectArea + territoryChangeAreaEpsilon) {
        return {
            noOverlap: false,
            residualOverlapArea: 0,
            valid: false
        };
    }

    if (retainedArea <= territoryChangeAreaEpsilon) {
        const exactOverlapArea = measureCaptureApplyPhase(
            options.diagnostics,
            `${options.phasePrefix}SubtractAmbiguousIntersection`,
            () => calculatePolygonIntersectionArea(subjectPolygon, clippingPolygon)
        );

        return {
            noOverlap: exactOverlapArea <= territoryChangeAreaEpsilon,
            residualOverlapArea: 0,
            valid: subjectArea - exactOverlapArea <= territoryChangeAreaEpsilon
        };
    }

    const residualOverlapArea = measureCaptureApplyPhase(
        options.diagnostics,
        `${options.phasePrefix}SubtractResidualIntersection`,
        () => calculatePolygonIntersectionArea(retainedPolygon, clippingPolygon)
    );

    if (residualOverlapArea > territoryChangeAreaEpsilon) {
        return {
            noOverlap: false,
            residualOverlapArea,
            valid: false
        };
    }

    const ambiguousAreaThreshold = Math.max(
        territoryChangeAreaEpsilon,
        Number(options.simplifyAreaDrift) || 0
    );

    if (removedArea <= ambiguousAreaThreshold) {
        const exactOverlapArea = measureCaptureApplyPhase(
            options.diagnostics,
            `${options.phasePrefix}SubtractAmbiguousIntersection`,
            () => calculatePolygonIntersectionArea(subjectPolygon, clippingPolygon)
        );

        if (exactOverlapArea <= territoryChangeAreaEpsilon) {
            return {
                noOverlap: true,
                residualOverlapArea,
                valid: true
            };
        }
    }

    return {
        noOverlap: false,
        residualOverlapArea,
        valid: true
    };
}

function getOperationSubtractAreaDrift(subjectOperation, clippingOperation) {
    return [subjectOperation, clippingOperation].reduce((sum, operation) => (
        sum + (Number.isFinite(operation && operation.areaDrift)
            ? Math.max(0, operation.areaDrift)
            : 0)
    ), 0);
}

function getTerritoryOperationPolygon(
    territory,
    metrics,
    diagnostics,
    kind = "subject",
    phaseName = "captureApplySimplifySubject"
) {
    const polygon = territory && territory.polygon || [];
    const pointCount = getPolygonPointCount(polygon);
    const options = createOperationSimplifyOptions(kind);

    if (pointCount < options.minInputPointCount) {
        return createIdentityOperationPolygon(polygon, pointCount);
    }

    const settingsKey = createOperationSimplifyKey(options);
    const cache = getTerritoryOperationPolygonCache(territory);
    const cachedOperation = cache && cache.entries.get(settingsKey);

    if (cachedOperation) {
        const cached = {
            ...cachedOperation.stats,
            cacheHit: true,
            polygon: cachedOperation.polygon
        };

        recordOperationSimplifyUse(metrics, kind, cached);
        return cached;
    }

    const operation = measureCaptureApplyPhase(diagnostics, phaseName, () => (
        createOperationalPolygon(polygon, options)
    ));
    const result = {
        ...operation,
        attempted: true,
        cacheHit: false
    };

    if (cache) {
        cache.entries.set(settingsKey, {
            polygon: result.polygon,
            stats: createOperationPolygonStats(result)
        });
    }
    recordOperationSimplifyUse(metrics, kind, result);

    return result;
}

function getCapturedOperationPolygon(capturedPolygon, metrics, diagnostics) {
    const pointCount = getPolygonPointCount(capturedPolygon);
    const options = createOperationSimplifyOptions("clipping");

    if (pointCount < options.minInputPointCount) {
        return createIdentityOperationPolygon(capturedPolygon, pointCount);
    }

    const operation = measureCaptureApplyPhase(diagnostics, "captureApplySimplifyCaptured", () => (
        createOperationalPolygon(capturedPolygon, options)
    ));
    const result = {
        ...operation,
        attempted: true,
        cacheHit: false
    };

    recordOperationSimplifyUse(metrics, "clipping", result);

    return result;
}

function getTerritoryOperationPolygonCache(territory) {
    if (!territory || typeof territory !== "object") {
        return null;
    }

    const version = territory.version || 0;
    let cache = territoryOperationPolygonCaches.get(territory);

    if (!cache || cache.version !== version) {
        cache = {
            entries: new Map(),
            version
        };
        territoryOperationPolygonCaches.set(territory, cache);
    }

    return cache;
}

function createOperationSimplifyOptions(kind) {
    const territoryConfig = config.territory;
    const isClipping = kind === "clipping";

    return {
        maxAreaDrift: operationSimplifyMaxAreaDrift,
        maxAreaDriftRatio: territoryConfig.operationSimplifyMaxAreaDriftRatio,
        minInputPointCount: isClipping
            ? territoryConfig.operationSimplifyClippingMinPoints
            : territoryConfig.operationSimplifySubjectMinPoints,
        minPointCount: territoryConfig.operationSimplifyMinPoints,
        minTolerance: territoryConfig.operationSimplifyMinTolerance,
        targetPointCount: isClipping
            ? territoryConfig.operationSimplifyClippingTargetPoints
            : territoryConfig.operationSimplifySubjectTargetPoints,
        tolerance: territoryConfig.operationSimplifyTolerance
    };
}

function createOperationSimplifyKey(options) {
    return [
        options.maxAreaDrift,
        options.maxAreaDriftRatio,
        options.minInputPointCount,
        options.minPointCount,
        options.minTolerance,
        options.targetPointCount,
        options.tolerance
    ].join(":");
}

function createIdentityOperationPolygon(polygon, pointCount) {
    return {
        areaDrift: 0,
        areaDriftRatio: 0,
        attempted: false,
        cacheHit: false,
        inputPointCount: pointCount,
        outputPointCount: pointCount,
        polygon,
        simplified: false,
        tolerance: 0
    };
}

function createOperationPolygonStats(operation) {
    return {
        areaDrift: operation.areaDrift,
        areaDriftRatio: operation.areaDriftRatio,
        attempted: true,
        inputPointCount: operation.inputPointCount,
        outputPointCount: operation.outputPointCount,
        simplified: operation.simplified,
        tolerance: operation.tolerance
    };
}

function recordOperationSimplifyUse(metrics, kind, operation) {
    if (!metrics || !operation || !operation.attempted) {
        return;
    }

    addCaptureApplyCount(metrics, "operationSimplifyAttemptCount", 1);

    if (operation.cacheHit) {
        addCaptureApplyCount(metrics, "operationSimplifyCacheHitCount", 1);
    }

    if (!operation.simplified) {
        return;
    }

    addCaptureApplyCount(metrics, "operationSimplifyHitCount", 1);
    addCaptureApplyCount(metrics, "operationSimplifyInputPointCount", operation.inputPointCount);
    addCaptureApplyCount(metrics, "operationSimplifyOutputPointCount", operation.outputPointCount);
    recordCaptureApplyMax(metrics, "operationSimplifyMaxAreaDrift", operation.areaDrift);
    recordCaptureApplyMax(metrics, "operationSimplifyMaxAreaDriftRatio", operation.areaDriftRatio);

    if (kind === "clipping") {
        addCaptureApplyCount(metrics, "operationSimplifyCapturedCount", 1);
    } else {
        addCaptureApplyCount(metrics, "operationSimplifySubjectCount", 1);
    }
}

function updateTerritoryPolygon(territory, nextPolygon, options = {}) {
    const previousArea = getTerritoryArea(territory);
    const nextArea = calculatePolygonArea(nextPolygon);

    if (Math.abs(previousArea - nextArea) <= territoryChangeAreaEpsilon) {
        return false;
    }

    delete territory.lastCaptureOperation;
    delete territory.captureAffectedTerritoryIds;

    if (!options.preserveCaptureOperationLog) {
        territory.captureOperationLog = [];
    }

    territory.polygon = nextPolygon;
    territory.area = nextArea;
    territory.bounds = getPolygonBounds(nextPolygon);
    territory.version = (territory.version || 0) + 1;
    delete territory.operationPolygon;
    delete territory.operationPolygonSettingsKey;
    delete territory.operationPolygonStats;
    delete territory.operationPolygonVersion;
    territoryOperationPolygonCaches.delete(territory);

    return true;
}

function serializeTerritories(territories, players = new Map()) {
    const serializedTerritories = {};

    for (const [playerId, territory] of territories.entries()) {
        const player = players.get(playerId);

        serializedTerritories[playerId] = {
            id: playerId,
            color: player ? player.color : territory.color,
            baseX: territory.baseX,
            baseY: territory.baseY,
            polygon: serializePolygon(territory.polygon)
        };
    }

    return serializedTerritories;
}

module.exports = {
    applyCapturedPolygon,
    createTerritories,
    deletePlayerTerritory,
    getPlayerTerritoryPolygon,
    initializePlayerTerritory,
    isPointOwnedByPlayer,
    processTerritoryOverlapRepairQueue,
    serializeTerritories
};
