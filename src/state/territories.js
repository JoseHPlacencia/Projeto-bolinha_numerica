const config = require("../config/gameConfig");
const {
    calculatePolygonIntersectionArea,
    calculatePolygonArea,
    createCirclePolygon,
    createOperationalPolygon,
    doBoundsContainBounds,
    doBoundsOverlap,
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
const { getHighResolutionTime } = require("../utils/time");

const territoryChangeAreaEpsilon = 1;
const operationSimplifyMaxAreaDrift = config.world.playerSize * config.world.playerSize;

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
        const subjectOperation = getTerritoryOperationPolygon(otherTerritory, captureApply, diagnostics);
        capturedOperation = capturedOperation || getCapturedOperationPolygon(capturedPolygon, captureApply, diagnostics);
        const operationSubjectArea = calculatePolygonArea(subjectOperation.polygon);
        const subtract = measureCaptureApplyOperation(diagnostics, "captureApplySubtract", () => (
            subtractPolygonComponents(subjectOperation.polygon, capturedOperation.polygon)
        ));
        const retainedPolygon = selectRetainedTerritoryPolygon(
            subtract.value,
            options.players && options.players.get(playerId)
        );
        const resultPointCount = getPolygonPointCount(retainedPolygon);
        const operationResultArea = calculatePolygonArea(retainedPolygon);
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
            usedSimplified: subjectOperation.simplified || capturedOperation.simplified
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
        checkedPairs: new Set()
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
    const changedTerritory = territories.get(changedPlayerId);
    const changedBounds = getTerritoryBounds(changedTerritory);

    if (!changedTerritory || !changedBounds) {
        return false;
    }

    for (const otherPlayerId of getOverlapRepairCandidateIds(territories, changedPlayerId, ownerId, repairContext)) {
        const otherTerritory = territories.get(otherPlayerId);

        if (!otherTerritory) {
            continue;
        }

        const pairKey = createTerritoryPairKey(changedPlayerId, otherPlayerId);

        if (repairContext.checkedPairs.has(pairKey)) {
            continue;
        }

        repairContext.checkedPairs.add(pairKey);
        addCaptureApplyCount(metrics, "postCaptureOverlapCheckCount", 1);
        const otherBounds = getTerritoryBounds(otherTerritory);

        if (!doBoundsOverlap(changedBounds, otherBounds)) {
            addCaptureApplyCount(metrics, "postCaptureOverlapBoundsRejectedCount", 1);
            continue;
        }

        if (!doPolygonsOverlap(changedTerritory.polygon, otherTerritory.polygon, changedBounds, otherBounds)) {
            continue;
        }

        const overlapArea = calculatePolygonIntersectionArea(changedTerritory.polygon, otherTerritory.polygon);

        if (overlapArea <= territoryChangeAreaEpsilon) {
            continue;
        }

        addCaptureApplyCount(metrics, "postCaptureOverlapCount", 1);
        addCaptureApplyCount(metrics, "postCaptureOverlapRepairCount", 1);
        recordFirstPostCaptureOverlap(
            metrics,
            changedPlayerId,
            otherPlayerId,
            changedTerritory,
            otherTerritory,
            overlapArea
        );

        const winnerId = selectOverlapWinnerId(
            changedPlayerId,
            changedTerritory,
            otherPlayerId,
            otherTerritory,
            ownerId,
            changedPlayerIds
        );
        const loserId = winnerId === changedPlayerId ? otherPlayerId : changedPlayerId;
        const winnerTerritory = territories.get(winnerId);
        const loserTerritory = territories.get(loserId);
        const changed = trimTerritoryOverlap(loserTerritory, winnerTerritory, options.players && options.players.get(loserId));

        if (!changed) {
            continue;
        }

        addCaptureApplyCount(metrics, "postCaptureOverlapRepairChangedCount", 1);

        if (!changedPlayerIds.has(loserId)) {
            addCaptureApplyCount(metrics, "changedTerritoryCount", 1);
            changedPlayerIds.add(loserId);
            pendingIds.push(loserId);
        }

        return true;
    }

    return false;
}

function getOverlapRepairCandidateIds(territories, changedPlayerId, ownerId, repairContext) {
    if (changedPlayerId !== ownerId) {
        return [...territories.keys()].filter(playerId => playerId !== changedPlayerId);
    }

    const candidateIds = new Set();

    for (const candidateId of repairContext.candidateIds || []) {
        if (candidateId !== changedPlayerId && territories.has(candidateId)) {
            candidateIds.add(candidateId);
        }
    }

    appendIncrementalOverlapRepairCandidateIds(territories, ownerId, candidateIds);

    return [...candidateIds];
}

function appendIncrementalOverlapRepairCandidateIds(territories, ownerId, candidateIds) {
    const territory = territories.get(ownerId);

    if (!territory) {
        return;
    }

    const ids = [...territories.keys()].filter(playerId => playerId !== ownerId);

    if (ids.length === 0) {
        territory.overlapRepairCursor = 0;
        return;
    }

    const maxCandidates = getIncrementalOverlapRepairCandidateCount();
    let cursor = Number.isInteger(territory.overlapRepairCursor)
        ? territory.overlapRepairCursor
        : 0;

    for (let scanned = 0; scanned < ids.length && candidateIds.size < maxCandidates; scanned++) {
        const candidateId = ids[cursor % ids.length];

        candidateIds.add(candidateId);
        cursor++;
    }

    territory.overlapRepairCursor = cursor % ids.length;
}

function getIncrementalOverlapRepairCandidateCount() {
    const value = config.territory.incrementalOverlapRepairCandidates;

    return Number.isInteger(value) && value > 0 ? value : 2;
}

function trimTerritoryOverlap(loserTerritory, winnerTerritory, loserPlayer) {
    if (!loserTerritory || !winnerTerritory) {
        return false;
    }

    const retainedPolygon = selectRetainedTerritoryPolygon(
        subtractPolygonComponents(loserTerritory.polygon, winnerTerritory.polygon),
        loserPlayer
    );

    return updateTerritoryPolygon(loserTerritory, retainedPolygon);
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

function recordFirstPostCaptureOverlap(metrics, firstId, secondId, firstTerritory, secondTerritory, overlapArea) {
    if (!metrics || metrics.postCaptureOverlapFirst) {
        return;
    }

    metrics.postCaptureOverlapFirst = {
        firstId,
        firstPointCount: getPolygonPointCount(firstTerritory.polygon),
        firstVersion: firstTerritory.version || 0,
        overlapArea: roundToMilliseconds(overlapArea),
        secondId,
        secondPointCount: getPolygonPointCount(secondTerritory.polygon),
        secondVersion: secondTerritory.version || 0
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

function getTerritoryOperationPolygon(territory, metrics, diagnostics) {
    const polygon = territory && territory.polygon || [];
    const pointCount = getPolygonPointCount(polygon);
    const options = createOperationSimplifyOptions("subject");

    if (pointCount < options.minInputPointCount) {
        return createIdentityOperationPolygon(polygon, pointCount);
    }

    const settingsKey = createOperationSimplifyKey(options);

    if (territory.operationPolygon
        && territory.operationPolygonVersion === territory.version
        && territory.operationPolygonSettingsKey === settingsKey) {
        const cached = {
            ...territory.operationPolygonStats,
            cacheHit: true,
            polygon: territory.operationPolygon
        };

        recordOperationSimplifyUse(metrics, "subject", cached);
        return cached;
    }

    const operation = measureCaptureApplyPhase(diagnostics, "captureApplySimplifySubject", () => (
        createOperationalPolygon(polygon, options)
    ));
    const result = {
        ...operation,
        attempted: true,
        cacheHit: false
    };

    territory.operationPolygon = result.polygon;
    territory.operationPolygonVersion = territory.version;
    territory.operationPolygonSettingsKey = settingsKey;
    territory.operationPolygonStats = createOperationPolygonStats(result);
    recordOperationSimplifyUse(metrics, "subject", result);

    return result;
}

function getCapturedOperationPolygon(capturedPolygon, metrics, diagnostics) {
    const pointCount = getPolygonPointCount(capturedPolygon);
    const options = createOperationSimplifyOptions("captured");

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

    recordOperationSimplifyUse(metrics, "captured", result);

    return result;
}

function createOperationSimplifyOptions(kind) {
    const territoryConfig = config.territory;

    return {
        maxAreaDrift: operationSimplifyMaxAreaDrift,
        maxAreaDriftRatio: territoryConfig.operationSimplifyMaxAreaDriftRatio,
        minInputPointCount: kind === "captured"
            ? territoryConfig.operationSimplifyClippingMinPoints
            : territoryConfig.operationSimplifySubjectMinPoints,
        minPointCount: territoryConfig.operationSimplifyMinPoints,
        minTolerance: territoryConfig.operationSimplifyMinTolerance,
        targetPointCount: kind === "captured"
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

    if (kind === "captured") {
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
    serializeTerritories
};
