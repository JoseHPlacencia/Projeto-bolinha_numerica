const { performance } = require("node:perf_hooks");

const config = require("../config/gameConfig");
const {
    expandCompactTrailUpdate
} = require("./snapshotTrailWireFormat");

function measureSnapshotPayload(snapshot) {
    const startedAt = performance.now();

    try {
        return {
            bytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
            measureMs: performance.now() - startedAt
        };
    } catch (_error) {
        return {
            bytes: null,
            measureMs: performance.now() - startedAt
        };
    }
}

function createSnapshotBreakdown(snapshot, options = {}) {
    const territories = snapshot && snapshot.territories || {};
    const territoryOps = snapshot && snapshot.territoryOps || {};
    const trails = snapshot && snapshot.trails || {};
    const territoryValues = Object.values(territories);
    const operationValues = Object.values(territoryOps);
    const trailValues = Object.values(trails);
    let territoryPointDefinitionCount = 0;
    let territoryRingReferenceCount = 0;
    let captureOperationCount = 0;
    let captureOperationTrailPointCount = 0;
    let fullTrailUpdateCount = 0;
    let fullTrailPointCount = 0;
    let partialTrailUpdateCount = 0;
    let partialTrailRemainingPointCount = 0;
    let trailPatchUpdateCount = 0;
    let trailPatchPointCount = 0;

    for (const territory of territoryValues) {
        const polygon = territory && territory.polygon;
        territoryPointDefinitionCount += countArrayItems(polygon && polygon.points);
        territoryRingReferenceCount += countRingReferences(polygon && polygon.rings);
    }

    for (const operation of operationValues) {
        if (!operation || operation.type !== "trailCapture") {
            continue;
        }

        captureOperationCount++;
        captureOperationTrailPointCount += countArrayItems(operation.trailPoints)
            + countArrayItems(operation.trailTailPoints);
    }

    for (const rawTrail of trailValues) {
        const trail = expandCompactTrailUpdate(rawTrail);

        if (!trail) {
            continue;
        }

        if (trail.partial) {
            partialTrailUpdateCount++;
            partialTrailRemainingPointCount += Number.isFinite(trail.remainingPointCount)
                ? trail.remainingPointCount
                : 0;
        }

        if (trail.full) {
            fullTrailUpdateCount++;
            fullTrailPointCount += countPackedSegmentsPoints(trail.leftSegments)
                + countPackedSegmentsPoints(trail.rightSegments)
                + countArrayItems(trail.leftFillPath)
                + countArrayItems(trail.rightFillPath);
            continue;
        }

        trailPatchUpdateCount++;
        trailPatchPointCount += countTrailPatchPoints(trail);
    }

    const breakdown = {
        playerPositionCount: countPlayerPositions(snapshot && snapshot.players),
        playerInfoCount: countObjectKeys(snapshot && snapshot.playerInfo),
        territoryVersionCount: countObjectKeys(snapshot && snapshot.territoryVersions),
        territoryPayloadCount: countObjectKeys(territories),
        territoryOperationCount: countObjectKeys(territoryOps),
        removedTerritoryCount: countArrayItems(snapshot && snapshot.removedTerritoryIds),
        captureOperationCount,
        captureOperationTrailPointCount,
        territoryPointDefinitionCount,
        territoryRingReferenceCount,
        trailUpdateCount: trailValues.length,
        removedTrailCount: countArrayItems(snapshot && snapshot.removedTrailIds),
        fullTrailUpdateCount,
        fullTrailPointCount,
        partialTrailUpdateCount,
        partialTrailRemainingPointCount,
        trailPatchUpdateCount,
        trailPatchPointCount,
        leaderboardCount: countArrayItems(snapshot && snapshot.leaderboard),
        numberCount: countArrayItems(snapshot && snapshot.numbers && snapshot.numbers.nums),
        payloadBudget: normalizePayloadBudget(snapshot && snapshot.payloadBudget)
    };

    if (options.includePayloadOutlier) {
        breakdown.payloadOutlier = createPayloadOutlierBreakdown(snapshot, options.payloadBytes);
    }

    return breakdown;
}

function isPayloadOutlier(bytes) {
    return Number.isFinite(bytes) && bytes >= getPayloadOutlierThresholdBytes();
}

function countObjectKeys(value) {
    return value && typeof value === "object" ? Object.keys(value).length : 0;
}

function countPlayerPositions(value) {
    return Array.isArray(value)
        ? Math.floor(value.length / 4)
        : countObjectKeys(value);
}

function countArrayItems(value) {
    return Array.isArray(value) ? value.length : 0;
}

function countInvalidations(invalidations) {
    return {
        playerInfo: countInvalidationItems(invalidations && invalidations.playerInfo),
        territories: countInvalidationItems(invalidations && invalidations.territories),
        trails: countInvalidationItems(invalidations && invalidations.trails)
    };
}

function createPayloadOutlierBreakdown(snapshot, payloadBytes) {
    const limit = getPayloadOutlierTopLimit();
    const sectionBytes = createSectionByteBreakdown(snapshot);

    return {
        payloadBytes: finiteOrNull(payloadBytes),
        thresholdBytes: getPayloadOutlierThresholdBytes(),
        sectionBytes,
        topSections: sectionBytes.slice(0, limit),
        topTrails: createTrailPayloadDetails(snapshot && snapshot.trails, limit),
        topTerritories: createTerritoryPayloadDetails(snapshot && snapshot.territories, limit),
        topTerritoryOps: createTerritoryOperationPayloadDetails(snapshot && snapshot.territoryOps, limit)
    };
}

function normalizePayloadBudget(value) {
    if (!value || typeof value !== "object") {
        return null;
    }

    return {
        budgetBytes: finiteOrNull(value.budgetBytes),
        usedBytes: finiteOrNull(value.usedBytes),
        remainingBytes: finiteOrNull(value.remainingBytes),
        deferredBytes: finiteOrNull(value.deferredBytes),
        sent: normalizePayloadBudgetCounts(value.sent),
        deferred: normalizePayloadBudgetCounts(value.deferred)
    };
}

function normalizePayloadBudgetCounts(value) {
    return {
        territories: finiteOrNull(value && value.territories),
        territoryOps: finiteOrNull(value && value.territoryOps),
        trails: finiteOrNull(value && value.trails)
    };
}

function getPayloadOutlierThresholdBytes() {
    return Number.isFinite(config.network.diagnosticsPayloadOutlierBytes)
        ? config.network.diagnosticsPayloadOutlierBytes
        : 50000;
}

function getPayloadOutlierTopLimit() {
    return Number.isInteger(config.network.diagnosticsPayloadOutlierTopLimit)
        ? Math.max(1, config.network.diagnosticsPayloadOutlierTopLimit)
        : 5;
}

function createSectionByteBreakdown(snapshot) {
    return Object.keys(snapshot || {})
        .map(section => ({
            section,
            bytes: measureJsonBytes(snapshot[section])
        }))
        .filter(item => Number.isFinite(item.bytes))
        .sort((first, second) => second.bytes - first.bytes);
}

function createTrailPayloadDetails(trails, limit) {
    return Object.entries(trails || {})
        .map(([playerId, trail]) => createTrailPayloadDetail(playerId, trail))
        .filter(Boolean)
        .sort(comparePayloadDetails)
        .slice(0, limit);
}

function createTrailPayloadDetail(playerId, trail) {
    if (!trail || typeof trail !== "object") {
        return null;
    }

    const rawTrail = trail;
    const expandedTrail = expandCompactTrailUpdate(rawTrail);

    if (!expandedTrail) {
        return null;
    }

    const leftPatchPointCount = countPatchPoints(expandedTrail.leftPatches);
    const rightPatchPointCount = countPatchPoints(expandedTrail.rightPatches);
    const leftFillPointCount = countArrayItems(expandedTrail.leftFillPoints);
    const rightFillPointCount = countArrayItems(expandedTrail.rightFillPoints);
    const leftSegmentPointCount = countPackedSegmentsPoints(expandedTrail.leftSegments);
    const rightSegmentPointCount = countPackedSegmentsPoints(expandedTrail.rightSegments);
    const leftFillPathPointCount = countArrayItems(expandedTrail.leftFillPath);
    const rightFillPathPointCount = countArrayItems(expandedTrail.rightFillPath);
    const patchPointCount = leftPatchPointCount + rightPatchPointCount + leftFillPointCount + rightFillPointCount;
    const fullPointCount = leftSegmentPointCount + rightSegmentPointCount + leftFillPathPointCount + rightFillPathPointCount;

    return {
        playerId,
        bytes: measureJsonBytes(rawTrail),
        full: Boolean(expandedTrail.full),
        partial: Boolean(expandedTrail.partial),
        pointBudget: finiteOrNull(expandedTrail.pointBudget),
        pointCount: expandedTrail.full ? fullPointCount : patchPointCount,
        patchPointCount,
        remainingPointCount: finiteOrNull(expandedTrail.remainingPointCount),
        fullPointCount,
        leftPatchCount: countArrayItems(expandedTrail.leftPatches),
        rightPatchCount: countArrayItems(expandedTrail.rightPatches),
        leftPatchPointCount,
        rightPatchPointCount,
        leftFillPointCount,
        rightFillPointCount,
        leftSegmentPointCount,
        rightSegmentPointCount,
        leftFillPathPointCount,
        rightFillPathPointCount
    };
}

function createTerritoryPayloadDetails(territories, limit) {
    return Object.entries(territories || {})
        .map(([playerId, territory]) => createTerritoryPayloadDetail(playerId, territory))
        .filter(Boolean)
        .sort(comparePayloadDetails)
        .slice(0, limit);
}

function createTerritoryPayloadDetail(playerId, territory) {
    if (!territory || typeof territory !== "object") {
        return null;
    }

    const polygon = territory.polygon || {};

    return {
        playerId,
        bytes: measureJsonBytes(territory),
        pointDefinitionCount: countArrayItems(polygon.points),
        ringReferenceCount: countRingReferences(polygon.rings),
        version: finiteOrNull(territory.version)
    };
}

function createTerritoryOperationPayloadDetails(operations, limit) {
    return Object.entries(operations || {})
        .map(([playerId, operation]) => createTerritoryOperationPayloadDetail(playerId, operation))
        .filter(Boolean)
        .sort(comparePayloadDetails)
        .slice(0, limit);
}

function createTerritoryOperationPayloadDetail(playerId, operation) {
    if (!operation || typeof operation !== "object") {
        return null;
    }

    return {
        playerId,
        bytes: measureJsonBytes(operation),
        type: typeof operation.type === "string" ? operation.type : null,
        trailPointCount: countArrayItems(operation.trailPoints),
        trailTailPointCount: countArrayItems(operation.trailTailPoints),
        version: finiteOrNull(operation.version)
    };
}

function comparePayloadDetails(first, second) {
    const byteDifference = (second.bytes || 0) - (first.bytes || 0);

    if (byteDifference !== 0) {
        return byteDifference;
    }

    return (second.pointCount || 0) - (first.pointCount || 0);
}

function measureJsonBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch (_error) {
        return null;
    }
}

function countRingReferences(rings) {
    return (rings || []).reduce((sum, ring) => sum + countArrayItems(ring), 0);
}

function countPackedSegmentsPoints(segments) {
    return (segments || []).reduce((sum, segment) => sum + countArrayItems(segment), 0);
}

function countTrailPatchPoints(trail) {
    return countPatchPoints(trail.leftPatches)
        + countPatchPoints(trail.rightPatches)
        + countArrayItems(trail.leftFillPoints)
        + countArrayItems(trail.rightFillPoints);
}

function countPatchPoints(patches) {
    return (patches || []).reduce((sum, patch) => sum + countArrayItems(patch && patch.points), 0);
}

function countInvalidationItems(value) {
    if (Array.isArray(value)) {
        return value.length;
    }

    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

module.exports = {
    countArrayItems,
    countInvalidations,
    countObjectKeys,
    countPlayerPositions,
    createSnapshotBreakdown,
    isPayloadOutlier,
    measureSnapshotPayload
};
