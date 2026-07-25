const config = require("../config/gameConfig");
const {
    consumeSnapshotPayloadBudget,
    estimateTrailPayloadBytes,
    getTrailUpdatePointCount
} = require("./snapshotPayloadBudget");
const {
    packPoints,
    shouldSendForcedFullSync
} = require("./snapshotSerializationPrimitives");
const {
    supportsCompactTrailUpdates
} = require("./snapshotProtocol");
const {
    compactTrailUpdate
} = require("./snapshotTrailWireFormat");

/**
 * Incremental trail full-sync, patch, partial update and tombstone state.
 *
 * This module advances only the trail-related portion of clientState and
 * consumes the caller-owned snapshot payload budget.
 */

function serializeTrailUpdates(players, trailIds, viewerId, clientState, now, payloadBudget = null) {
    const serializedTrails = {};
    const includedTrailIds = [];

    for (const playerId of trailIds) {
        const player = players.get(playerId);

        if (!player || !hasAnyTrail(player)) {
            clientState.trails.delete(playerId);
            continue;
        }

        const stats = getTrailStats(player);
        const knownTrail = clientState.trails.get(playerId);
        const includeKnownTrail = Boolean(knownTrail);
        const shouldSendFull = shouldSendFullTrail(player, stats, knownTrail, now);
        const serialized = shouldSendFull
            ? serializeFullTrail(player)
            : serializeTrailPatch(player, knownTrail);
        const update = serialized.update;

        if (!shouldSendFull && getTrailUpdatePointCount(update) === 0) {
            clientState.trails.set(playerId, {
                ...serialized.state,
                lastFullSentAt: knownTrail.lastFullSentAt
            });
            includedTrailIds.push(playerId);
            continue;
        }

        if (!consumeSnapshotPayloadBudget(payloadBudget, "trails", estimateTrailPayloadBytes(update), {
            force: playerId === viewerId
        })) {
            if (includeKnownTrail) {
                includedTrailIds.push(playerId);
            }
            continue;
        }

        serializedTrails[playerId] = supportsCompactTrailUpdates(clientState.snapshotSchema)
            ? compactTrailUpdate(update)
            : update;
        clientState.trails.set(playerId, {
            ...serialized.state,
            lastFullSentAt: shouldSendFull ? now : knownTrail.lastFullSentAt
        });
        includedTrailIds.push(playerId);
    }

    return {
        trailIds: includedTrailIds,
        trails: serializedTrails
    };
}

function shouldSendFullTrail(player, stats, knownTrail, now) {
    if (!knownTrail || !canPatchTrail(stats, knownTrail)) {
        return true;
    }

    if (stats.pointCount > getTrailUpdateMaxPoints()) {
        return false;
    }

    if (
        shouldSendForcedFullSync()
        && now - knownTrail.lastFullSentAt >= config.network.trailFullSyncIntervalMs
    ) {
        return true;
    }

    const patchPointCount = getTrailPatchPointCount(player, knownTrail);

    return shouldSendForcedFullSync()
        && stats.pointCount > 0
        && patchPointCount / stats.pointCount >= config.network.trailPatchFullRatio;
}

function serializeFullTrail(player) {
    const maxPoints = getTrailUpdateMaxPoints();
    const componentBudgets = allocateTrailComponentBudgets([
        countSegmentPoints(player.trailLeftSegments),
        countSegmentPoints(player.trailRightSegments),
        getPointArrayLength(player.trailLeftFillPath),
        getPointArrayLength(player.trailRightFillPath)
    ], maxPoints);
    const leftSegments = packLimitedSegments(player.trailLeftSegments, componentBudgets[0]);
    const rightSegments = packLimitedSegments(player.trailRightSegments, componentBudgets[1]);
    const leftFillPath = packLimitedPoints(player.trailLeftFillPath, 0, componentBudgets[2]);
    const rightFillPath = packLimitedPoints(player.trailRightFillPath, 0, componentBudgets[3]);
    const sentStats = {
        leftSegmentLengths: getPackedSegmentLengths(leftSegments),
        rightSegmentLengths: getPackedSegmentLengths(rightSegments),
        leftFillLength: leftFillPath.length,
        rightFillLength: rightFillPath.length
    };
    const sentPointCount = getTrailStatsPointCount(sentStats);
    const totalPointCount = getTrailStats(player).pointCount;
    const update = {
        full: true,
        generation: getTrailGeneration(player),
        color: player.color,
        leftSegments,
        rightSegments,
        leftFillPath,
        rightFillPath
    };

    markPartialTrailUpdate(update, sentPointCount, totalPointCount, maxPoints);

    return {
        state: {
            ...sentStats,
            generation: getTrailGeneration(player),
            pointCount: sentPointCount
        },
        update
    };
}

function serializeTrailPatch(player, knownTrail) {
    const maxPoints = getTrailUpdateMaxPoints();
    const componentBudgets = allocateTrailComponentBudgets([
        getSegmentPatchPointCount(player.trailLeftSegments, knownTrail.leftSegmentLengths),
        getSegmentPatchPointCount(player.trailRightSegments, knownTrail.rightSegmentLengths),
        Math.max(0, player.trailLeftFillPath.length - knownTrail.leftFillLength),
        Math.max(0, player.trailRightFillPath.length - knownTrail.rightFillLength)
    ], maxPoints);
    const update = {
        generation: getTrailGeneration(player),
        color: player.color
    };
    const leftPatchResult = getLimitedSegmentPatches(player.trailLeftSegments, knownTrail.leftSegmentLengths, componentBudgets[0]);
    const rightPatchResult = getLimitedSegmentPatches(player.trailRightSegments, knownTrail.rightSegmentLengths, componentBudgets[1]);
    const leftFillPoints = packLimitedPoints(player.trailLeftFillPath, knownTrail.leftFillLength, componentBudgets[2]);
    const rightFillPoints = packLimitedPoints(player.trailRightFillPath, knownTrail.rightFillLength, componentBudgets[3]);
    const sentStats = {
        leftSegmentLengths: leftPatchResult.lengths,
        rightSegmentLengths: rightPatchResult.lengths,
        leftFillLength: knownTrail.leftFillLength + leftFillPoints.length,
        rightFillLength: knownTrail.rightFillLength + rightFillPoints.length
    };
    const sentPointCount = getTrailStatsPointCount(sentStats);
    const totalPointCount = getTrailStats(player).pointCount;

    if (leftPatchResult.patches.length > 0) {
        update.leftPatches = leftPatchResult.patches;
    }

    if (rightPatchResult.patches.length > 0) {
        update.rightPatches = rightPatchResult.patches;
    }

    if (leftFillPoints.length > 0) {
        update.leftFillPoints = leftFillPoints;
        update.leftFillStart = knownTrail.leftFillLength;
    }

    if (rightFillPoints.length > 0) {
        update.rightFillPoints = rightFillPoints;
        update.rightFillStart = knownTrail.rightFillLength;
    }

    markPartialTrailUpdate(update, getTrailUpdatePointCount(update), totalPointCount - getTrailStatsPointCount(knownTrail), maxPoints);

    return {
        state: {
            ...sentStats,
            generation: getTrailGeneration(player),
            pointCount: sentPointCount
        },
        update
    };
}

function getLimitedSegmentPatches(segments, knownLengths, maxPoints) {
    const patches = [];
    const nextLengths = knownLengths.slice();
    let remainingPoints = maxPoints;

    for (let index = 0; index < segments.length; index++) {
        const knownLength = knownLengths[index] || 0;
        const availablePointCount = Math.max(0, segments[index].length - knownLength);
        const takePointCount = Math.min(availablePointCount, remainingPoints);

        if (takePointCount <= 0) {
            if (index < knownLengths.length) {
                nextLengths[index] = knownLength;
            }
            continue;
        }

        const points = packPoints(segments[index].slice(knownLength, knownLength + takePointCount));

        patches.push({
            index,
            start: knownLength,
            points
        });
        nextLengths[index] = knownLength + takePointCount;
        remainingPoints -= takePointCount;

        if (remainingPoints <= 0) {
            break;
        }
    }

    return {
        lengths: trimTrailingZeroLengths(nextLengths),
        patches
    };
}

function allocateTrailComponentBudgets(componentPointCounts, maxPoints) {
    const counts = componentPointCounts.map(count => Math.max(0, count || 0));
    const totalPointCount = sumValues(counts);

    if (!Number.isFinite(maxPoints) || totalPointCount <= maxPoints) {
        return counts;
    }

    const budget = Math.max(1, Math.floor(maxPoints));
    const budgets = counts.map(() => 0);
    const activeIndexes = counts
        .map((count, index) => ({ count, index }))
        .filter(item => item.count > 0);

    if (activeIndexes.length === 0) {
        return budgets;
    }

    let remainingBudget = budget;

    for (const item of activeIndexes) {
        budgets[item.index] = 1;
        remainingBudget--;

        if (remainingBudget <= 0) {
            return budgets;
        }
    }

    const remainingCounts = counts.map((count, index) => Math.max(0, count - budgets[index]));
    const remainingTotal = sumValues(remainingCounts);
    const shares = remainingCounts.map((count, index) => {
        const exact = remainingTotal > 0 ? count / remainingTotal * remainingBudget : 0;
        const whole = Math.floor(exact);

        budgets[index] += whole;

        return {
            fraction: exact - whole,
            index
        };
    });

    remainingBudget = budget - sumValues(budgets);
    shares.sort((first, second) => second.fraction - first.fraction);

    for (const share of shares) {
        if (remainingBudget <= 0) {
            break;
        }

        if (counts[share.index] <= budgets[share.index]) {
            continue;
        }

        budgets[share.index]++;
        remainingBudget--;
    }

    return budgets.map((value, index) => Math.min(value, counts[index]));
}

function packLimitedSegments(segments, maxPoints) {
    const packedSegments = [];
    let remainingPoints = maxPoints;

    for (const segment of segments || []) {
        if (remainingPoints <= 0) {
            break;
        }

        const packedSegment = packLimitedPoints(segment, 0, remainingPoints);

        if (packedSegment.length === 0) {
            continue;
        }

        packedSegments.push(packedSegment);
        remainingPoints -= packedSegment.length;
    }

    return packedSegments;
}

function packLimitedPoints(points, startIndex, maxPoints) {
    if (!Array.isArray(points) || maxPoints <= 0) {
        return [];
    }

    const endIndex = Math.min(points.length, startIndex + maxPoints);

    return packPoints(points.slice(startIndex, endIndex));
}

function getPackedSegmentLengths(segments) {
    return Array.isArray(segments) ? segments.map(segment => segment.length) : [];
}

function countSegmentPoints(segments) {
    return sumValues(getSegmentLengths(segments));
}

function getTrailStatsPointCount(stats) {
    return sumValues(stats.leftSegmentLengths || [])
        + sumValues(stats.rightSegmentLengths || [])
        + Math.max(0, stats.leftFillLength || 0)
        + Math.max(0, stats.rightFillLength || 0);
}

function markPartialTrailUpdate(update, sentPointCount, totalPointCount, pointBudget) {
    if (!Number.isFinite(totalPointCount) || sentPointCount >= totalPointCount) {
        return;
    }

    update.partial = true;
    update.remainingPointCount = totalPointCount - sentPointCount;
    update.pointBudget = Number.isFinite(pointBudget) ? pointBudget : null;
}

function getTrailUpdateMaxPoints() {
    const value = config.network.trailUpdateMaxPoints;

    return Number.isFinite(value) && value > 0 ? Math.floor(value) : Infinity;
}

function trimTrailingZeroLengths(lengths) {
    const nextLengths = lengths.slice();

    while (nextLengths.length > 0 && nextLengths[nextLengths.length - 1] <= 0) {
        nextLengths.pop();
    }

    return nextLengths;
}



function getTrailStats(player) {
    const leftSegmentLengths = getSegmentLengths(player.trailLeftSegments);
    const rightSegmentLengths = getSegmentLengths(player.trailRightSegments);
    const leftFillLength = getPointArrayLength(player.trailLeftFillPath);
    const rightFillLength = getPointArrayLength(player.trailRightFillPath);
    const pointCount = sumValues(leftSegmentLengths)
        + sumValues(rightSegmentLengths)
        + leftFillLength
        + rightFillLength;

    return {
        generation: getTrailGeneration(player),
        leftSegmentLengths,
        rightSegmentLengths,
        leftFillLength,
        rightFillLength,
        pointCount
    };
}

function canPatchTrail(stats, knownTrail) {
    return stats.generation === knownTrail.generation
        && canPatchLengths(stats.leftSegmentLengths, knownTrail.leftSegmentLengths)
        && canPatchLengths(stats.rightSegmentLengths, knownTrail.rightSegmentLengths)
        && stats.leftFillLength >= knownTrail.leftFillLength
        && stats.rightFillLength >= knownTrail.rightFillLength;
}

function getTrailGeneration(player) {
    return Number.isSafeInteger(player && player.trailGeneration)
        ? player.trailGeneration
        : 0;
}

function canPatchLengths(currentLengths, knownLengths) {
    if (currentLengths.length < knownLengths.length) {
        return false;
    }

    for (let index = 0; index < knownLengths.length; index++) {
        if (currentLengths[index] < knownLengths[index]) {
            return false;
        }
    }

    return true;
}

function getTrailPatchPointCount(player, knownTrail) {
    return getSegmentPatchPointCount(player.trailLeftSegments, knownTrail.leftSegmentLengths)
        + getSegmentPatchPointCount(player.trailRightSegments, knownTrail.rightSegmentLengths)
        + Math.max(0, player.trailLeftFillPath.length - knownTrail.leftFillLength)
        + Math.max(0, player.trailRightFillPath.length - knownTrail.rightFillLength);
}

function getSegmentPatchPointCount(segments, knownLengths) {
    let pointCount = 0;

    for (let index = 0; index < segments.length; index++) {
        pointCount += Math.max(0, segments[index].length - (knownLengths[index] || 0));
    }

    return pointCount;
}

function getSegmentLengths(segments) {
    return Array.isArray(segments) ? segments.map(getPointArrayLength) : [];
}

function getPointArrayLength(points) {
    return Array.isArray(points) ? points.length : 0;
}

function sumValues(values) {
    return values.reduce((sum, value) => sum + value, 0);
}

function hasAnyTrail(player) {
    return hasVisibleSegment(player.trailLeftSegments)
        || hasVisibleSegment(player.trailRightSegments);
}

function hasVisibleSegment(segments) {
    return Array.isArray(segments) && segments.some(segment => segment.length >= 2);
}

function getTrailBounds(player) {
    let bounds = null;

    bounds = mergeBounds(bounds, getSegmentsBounds(player.trailLeftSegments));
    bounds = mergeBounds(bounds, getSegmentsBounds(player.trailRightSegments));
    bounds = mergeBounds(bounds, getPointsBounds(player.trailLeftFillPath));
    bounds = mergeBounds(bounds, getPointsBounds(player.trailRightFillPath));

    return expandBounds(bounds, config.territory.baseBorderWidth);
}

function getSegmentsBounds(segments) {
    let bounds = null;

    for (const segment of segments || []) {
        bounds = mergeBounds(bounds, getPointsBounds(segment));
    }

    return bounds;
}

function getPointsBounds(points) {
    let bounds = null;

    for (const point of points || []) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            continue;
        }

        const pointBounds = {
            minX: point.x,
            minY: point.y,
            maxX: point.x,
            maxY: point.y
        };

        bounds = mergeBounds(bounds, pointBounds);
    }

    return bounds;
}



function removeUnselectedTrailStates(players, clientState, selectedIds) {
    const removals = {};

    for (const [id, knownTrail] of clientState.trails.entries()) {
        if (selectedIds.has(id)) {
            continue;
        }

        const player = players.get(id);
        const currentGeneration = player
            ? getTrailGeneration(player)
            : Number.isSafeInteger(knownTrail && knownTrail.generation)
                ? knownTrail.generation + 1
                : 0;

        removals[id] = currentGeneration;
        clientState.trails.delete(id);
        clientState.trailVisibility.delete(id);
    }

    return removals;
}



function expandBounds(bounds, margin) {
    if (!bounds) {
        return null;
    }

    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;

    return {
        minX: bounds.minX - safeMargin,
        minY: bounds.minY - safeMargin,
        maxX: bounds.maxX + safeMargin,
        maxY: bounds.maxY + safeMargin
    };
}

function mergeBounds(first, second) {
    if (!first) {
        return second;
    }

    if (!second) {
        return first;
    }

    return {
        minX: Math.min(first.minX, second.minX),
        minY: Math.min(first.minY, second.minY),
        maxX: Math.max(first.maxX, second.maxX),
        maxY: Math.max(first.maxY, second.maxY)
    };
}


module.exports = {
    getTrailBounds,
    hasAnyTrail,
    removeUnselectedTrailStates,
    serializeTrailUpdates
};
