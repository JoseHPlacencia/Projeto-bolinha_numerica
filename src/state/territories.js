const config = require("../config/gameConfig");
const {
    calculatePolygonArea,
    createCirclePolygon,
    doBoundsContainBounds,
    doBoundsOverlap,
    doPolygonsOverlap,
    getPolygonBounds,
    isPointInPolygon,
    isPolygonInsidePolygon,
    serializePolygon,
    subtractPolygon,
    unionPolygons
} = require("../utils/geometry");
const { getHighResolutionTime } = require("../utils/time");

const territoryChangeAreaEpsilon = 1;

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
        const subtract = measureCaptureApplyOperation(diagnostics, "captureApplySubtract", () => (
            subtractPolygon(otherTerritory.polygon, capturedPolygon)
        ));
        const resultPointCount = getPolygonPointCount(subtract.value);
        addCaptureApplyCount(captureApply, "subtractResultPointCount", resultPointCount);
        const changed = measureCaptureApplyPhase(diagnostics, "captureApplyUpdateTerritory", () => (
            updateTerritoryPolygon(otherTerritory, subtract.value)
        ));

        recordSlowestCaptureApplySubtract(captureApply, {
            changed,
            durationMs: subtract.durationMs,
            playerId,
            resultArea: getTerritoryArea(otherTerritory),
            resultPointCount,
            subjectArea: previousArea,
            subjectPointCount
        });

        if (changed) {
            addCaptureApplyCount(captureApply, "subtractChangedCount", 1);
            addCaptureApplyCount(captureApply, "changedTerritoryCount", 1);
            changedPlayerIds.add(playerId);
        }
    }

    return changedPlayerIds;
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
        ownerChangedCount: 0,
        slowestOverlap: null,
        slowestSubtract: null,
        subtractChangedCount: 0,
        subtractCount: 0,
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
        durationMs,
        playerId: detail.playerId,
        resultArea: roundToMilliseconds(detail.resultArea),
        resultPointCount: detail.resultPointCount,
        subjectArea: roundToMilliseconds(detail.subjectArea),
        subjectPointCount: detail.subjectPointCount
    };
}

function getPolygonPointCount(polygon) {
    return (polygon || []).reduce((sum, ring) => (
        sum + (Array.isArray(ring) ? ring.length : 0)
    ), 0);
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

function updateTerritoryPolygon(territory, nextPolygon, options = {}) {
    const previousArea = getTerritoryArea(territory);
    const nextArea = calculatePolygonArea(nextPolygon);

    if (Math.abs(previousArea - nextArea) <= territoryChangeAreaEpsilon) {
        return false;
    }

    delete territory.lastCaptureOperation;

    if (!options.preserveCaptureOperationLog) {
        territory.captureOperationLog = [];
    }

    territory.polygon = nextPolygon;
    territory.area = nextArea;
    territory.bounds = getPolygonBounds(nextPolygon);
    territory.version = (territory.version || 0) + 1;

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
