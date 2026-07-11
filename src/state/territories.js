const config = require("../config/gameConfig");
const {
    calculatePolygonArea,
    createCirclePolygon,
    doBoundsContainBounds,
    doBoundsOverlap,
    doPolygonsOverlap,
    getPolygonBounds,
    getPolygonPointCount,
    isPointInPolygon,
    isPolygonInsidePolygon,
    serializePolygon
} = require("../utils/geometry");
const {
    addCaptureApplyCount,
    getCaptureApplyDiagnostics,
    getCaptureApplyMetrics,
    measureCaptureApplyOperation,
    measureCaptureApplyPhase,
    recordCaptureApplyMax,
    recordSlowestCaptureApplyOverlap,
    recordSlowestCaptureApplySubtract
} = require("./territoryDiagnostics");
const {
    clearTerritoryOperationPolygonCache,
    getCapturedOperationPolygon,
    getOwnerCapturedPolygon,
    getTerritoryOperationPolygon,
    subtractTerritoryPolygon
} = require("./territoryOperations");
const { createTerritoryOverlapRepair } = require("./territoryOverlapRepair");

const territoryChangeAreaEpsilon = 1;

const {
    auditChangedTerritoryOverlaps,
    getBoundsArea,
    processTerritoryOverlapRepairQueue,
    repairChangedTerritoryOverlaps,
    scheduleTerritoryOverlapRepairQueue
} = createTerritoryOverlapRepair({ updateTerritoryPolygon });

/**
 * Authoritative territory state.
 *
 * Polygon, version, area, bounds and derived operation caches form one unit.
 * External systems must use this module's update paths instead of mutating a
 * territory polygon directly. See .ai/docs/ARCHITECTURE.md for the invariants.
 */

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
    clearTerritoryOperationPolygonCache(territory);

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
