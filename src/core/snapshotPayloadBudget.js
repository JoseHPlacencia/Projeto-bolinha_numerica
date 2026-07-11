const config = require("../config/gameConfig");

function createSnapshotPayloadBudget() {
    const budgetBytes = getSnapshotPayloadBudgetBytes();

    if (!Number.isFinite(budgetBytes)) {
        return {
            enabled: false
        };
    }

    return {
        enabled: true,
        budgetBytes,
        usedBytes: 0,
        deferredBytes: 0,
        sent: createSectionCounts(),
        deferred: createSectionCounts()
    };
}

function createSectionCounts() {
    return {
        territories: 0,
        territoryOps: 0,
        trails: 0
    };
}

function serializeSnapshotPayloadBudget(payloadBudget) {
    if (!payloadBudget || !payloadBudget.enabled) {
        return null;
    }

    return {
        budgetBytes: payloadBudget.budgetBytes,
        usedBytes: payloadBudget.usedBytes,
        remainingBytes: Math.max(0, payloadBudget.budgetBytes - payloadBudget.usedBytes),
        deferredBytes: payloadBudget.deferredBytes,
        sent: { ...payloadBudget.sent },
        deferred: { ...payloadBudget.deferred }
    };
}

function consumeSnapshotPayloadBudget(payloadBudget, section, estimatedBytes, options = {}) {
    if (!payloadBudget || !payloadBudget.enabled) {
        return true;
    }

    const bytes = Math.max(0, Math.ceil(Number(estimatedBytes) || 0));
    const force = options.force === true;
    const hasRoom = payloadBudget.usedBytes <= 0
        || payloadBudget.usedBytes + bytes <= payloadBudget.budgetBytes;

    if (!force && !hasRoom) {
        incrementSectionCount(payloadBudget.deferred, section);
        payloadBudget.deferredBytes += bytes;
        return false;
    }

    incrementSectionCount(payloadBudget.sent, section);
    payloadBudget.usedBytes += bytes;
    return true;
}

function incrementSectionCount(target, section) {
    if (target && Object.prototype.hasOwnProperty.call(target, section)) {
        target[section]++;
    }
}

function estimateTerritoryPayloadBytes(territory) {
    const pointCount = countPolygonPoints(territory && territory.polygon);
    const ringCount = Array.isArray(territory && territory.polygon)
        ? territory.polygon.length
        : 0;

    return 180 + pointCount * 32 + ringCount * 24;
}

function estimateTerritoryOperationPayloadBytes(operation) {
    const trailPointCount = getPackedPointCount(operation && operation.trailPoints)
        + getPackedPointCount(operation && operation.trailTailPoints);

    return 220 + trailPointCount * 22;
}

function estimateTrailPayloadBytes(update) {
    const pointCount = getTrailPayloadPointCount(update);
    const segmentCount = countArrayItems(update && update.leftSegments)
        + countArrayItems(update && update.rightSegments)
        + countArrayItems(update && update.leftPatches)
        + countArrayItems(update && update.rightPatches);

    return 220 + pointCount * 22 + segmentCount * 18;
}

function getTrailUpdatePointCount(update) {
    if (!update) {
        return 0;
    }

    return getPatchPointCount(update.leftPatches)
        + getPatchPointCount(update.rightPatches)
        + getPackedPointCount(update.leftFillPoints)
        + getPackedPointCount(update.rightFillPoints);
}

function getTrailPayloadPointCount(update) {
    if (!update) {
        return 0;
    }

    if (update.full) {
        return countPackedSegmentsPoints(update.leftSegments)
            + countPackedSegmentsPoints(update.rightSegments)
            + getPackedPointCount(update.leftFillPath)
            + getPackedPointCount(update.rightFillPath);
    }

    return getTrailUpdatePointCount(update);
}

function getPatchPointCount(patches) {
    return (patches || []).reduce(
        (sum, patch) => sum + getPackedPointCount(patch.points),
        0
    );
}

function getPackedPointCount(points) {
    return Array.isArray(points) ? points.length : 0;
}

function countPackedSegmentsPoints(segments) {
    return (segments || []).reduce(
        (sum, segment) => sum + getPackedPointCount(segment),
        0
    );
}

function countPolygonPoints(polygon) {
    return (polygon || []).reduce(
        (sum, ring) => sum + countArrayItems(ring),
        0
    );
}

function countArrayItems(value) {
    return Array.isArray(value) ? value.length : 0;
}

function getSnapshotPayloadBudgetBytes() {
    const value = config.network.snapshotPayloadBudgetBytes;

    return Number.isFinite(value) && value > 0 ? Math.floor(value) : Infinity;
}

module.exports = {
    consumeSnapshotPayloadBudget,
    createSnapshotPayloadBudget,
    estimateTerritoryOperationPayloadBytes,
    estimateTerritoryPayloadBytes,
    estimateTrailPayloadBytes,
    getTrailUpdatePointCount,
    serializeSnapshotPayloadBudget
};
