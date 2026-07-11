const config = require("../config/gameConfig");
const {
    addBotTargetingDiagnosticValue,
    addSelfTrailSafetyDiagnosticValue
} = require("./botDiagnostics");

const geometryEpsilon = 1e-7;

/**
 * Shared trail geometry and per-tick caches for bot targeting and route safety.
 *
 * Cache ownership remains in the decision context supplied by botSystem. This
 * module only creates or queries derived point/segment indexes.
 */

function getBotTrailTargetBlockSize() {
    const value = Number(config.bots.trailTargetBlockSize);

    return Number.isInteger(value) && value > 0 ? value : 32;
}

function getNearestDistanceSquared(origin, pointIndexOrPoints, diagnostics = null) {
    const pointIndex = getPointIndex(pointIndexOrPoints);
    const sourcePoints = pointIndex
        ? pointIndex.points
        : pointIndexOrPoints || [];
    let nearestDistanceSquared = Infinity;

    if (pointIndex && pointIndex.blocks.length > 0) {
        const orderedBlocks = pointIndex.blocks.map(block => ({
            block,
            distanceSquared: getPointBoundsDistanceSquared(origin, block.bounds)
        })).sort((first, second) => first.distanceSquared - second.distanceSquared);
        let blockBoundsRejected = 0;
        let checkedPointCount = 0;

        addSelfTrailSafetyDiagnosticValue(diagnostics, "pointBlockChecks", orderedBlocks.length);

        for (const item of orderedBlocks) {
            if (item.distanceSquared > nearestDistanceSquared + geometryEpsilon) {
                blockBoundsRejected++;
                continue;
            }

            for (const point of item.block.points) {
                checkedPointCount++;
                const deltaX = origin.x - point.x;
                const deltaY = origin.y - point.y;
                const distanceSquared = deltaX * deltaX + deltaY * deltaY;

                if (distanceSquared < nearestDistanceSquared) {
                    nearestDistanceSquared = distanceSquared;
                }
            }
        }

        addSelfTrailSafetyDiagnosticValue(diagnostics, "pointBlockBoundsRejected", blockBoundsRejected);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "pointDistanceCheckCount", checkedPointCount);

        return nearestDistanceSquared;
    }

    addSelfTrailSafetyDiagnosticValue(diagnostics, "pointDistanceCheckCount", sourcePoints.length);

    for (const point of sourcePoints) {
        const deltaX = origin.x - point.x;
        const deltaY = origin.y - point.y;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY;

        if (distanceSquared < nearestDistanceSquared) {
            nearestDistanceSquared = distanceSquared;
        }
    }

    return nearestDistanceSquared;
}

function getPointIndex(value) {
    return value
        && Array.isArray(value.points)
        && Array.isArray(value.blocks)
        ? value
        : null;
}



function createBoundsAroundPoint(point, radius) {
    const safeRadius = Number.isFinite(radius) && radius > 0
        ? radius
        : config.world.playerSize;

    return {
        maxX: point.x + safeRadius,
        maxY: point.y + safeRadius,
        minX: point.x - safeRadius,
        minY: point.y - safeRadius
    };
}

function filterPointsByBounds(points, bounds) {
    if (!Array.isArray(points) || points.length === 0) {
        return [];
    }

    return points.filter(point => isPointInBounds(point, bounds));
}

function filterSegmentsByBounds(segments, bounds) {
    if (!Array.isArray(segments) || segments.length === 0) {
        return [];
    }

    const filtered = [];

    for (const segment of segments) {
        if (!segment || !isFinitePoint(segment.start) || !isFinitePoint(segment.end)) {
            continue;
        }

        const segmentBounds = getSegmentBounds(segment.start, segment.end);

        if (doBoundsOverlap(segmentBounds, bounds)) {
            filtered.push({
                ...segment,
                bounds: segmentBounds
            });
        }
    }

    return filtered;
}

function createPointBlockIndex(points, blockSize) {
    const validPoints = (points || []).filter(isFinitePoint);
    const blocks = [];
    let bounds = null;

    for (let index = 0; index < validPoints.length; index += blockSize) {
        const blockPoints = validPoints.slice(index, index + blockSize);
        const blockBounds = getPointsBounds(blockPoints);

        if (!blockBounds) {
            continue;
        }

        blocks.push({
            bounds: blockBounds,
            points: blockPoints
        });
        bounds = mergeBounds(bounds, blockBounds);
    }

    return {
        blocks,
        bounds,
        points: validPoints
    };
}

function createSegmentBlockIndex(segments, blockSize) {
    const validSegments = (segments || []).filter(segment => (
        segment
        && isFinitePoint(segment.start)
        && isFinitePoint(segment.end)
    )).map(segment => ({
        ...segment,
        bounds: isValidBounds(segment.bounds)
            ? segment.bounds
            : getSegmentBounds(segment.start, segment.end)
    }));
    const blocks = [];
    let bounds = null;

    for (let index = 0; index < validSegments.length; index += blockSize) {
        const blockSegments = validSegments.slice(index, index + blockSize);

        const blockBounds = getBoundsUnion(blockSegments.map(segment => segment.bounds));

        if (!blockBounds) {
            continue;
        }

        blocks.push({
            bounds: blockBounds,
            segments: blockSegments
        });
        bounds = mergeBounds(bounds, blockBounds);
    }

    return {
        blocks,
        bounds,
        segments: validSegments
    };
}

function getPointsBounds(points) {
    let bounds = null;

    for (const point of points || []) {
        if (!isFinitePoint(point)) {
            continue;
        }

        bounds = mergeBounds(bounds, {
            maxX: point.x,
            maxY: point.y,
            minX: point.x,
            minY: point.y
        });
    }

    return bounds;
}

function getBoundsUnion(boundsList) {
    let bounds = null;

    for (const item of boundsList || []) {
        bounds = mergeBounds(bounds, item);
    }

    return bounds;
}

function mergeBounds(first, second) {
    if (!isValidBounds(second)) {
        return first;
    }

    if (!isValidBounds(first)) {
        return {
            maxX: second.maxX,
            maxY: second.maxY,
            minX: second.minX,
            minY: second.minY
        };
    }

    return {
        maxX: Math.max(first.maxX, second.maxX),
        maxY: Math.max(first.maxY, second.maxY),
        minX: Math.min(first.minX, second.minX),
        minY: Math.min(first.minY, second.minY)
    };
}

function isPointInBounds(point, bounds) {
    return isFinitePoint(point)
        && point.x >= bounds.minX
        && point.x <= bounds.maxX
        && point.y >= bounds.minY
        && point.y <= bounds.maxY;
}

function getSegmentBounds(start, end) {
    return {
        maxX: Math.max(start.x, end.x),
        maxY: Math.max(start.y, end.y),
        minX: Math.min(start.x, end.x),
        minY: Math.min(start.y, end.y)
    };
}

function doBoundsOverlap(firstBounds, secondBounds) {
    if (!isValidBounds(firstBounds) || !isValidBounds(secondBounds)) {
        return false;
    }

    return firstBounds.minX <= secondBounds.maxX + geometryEpsilon
        && firstBounds.maxX + geometryEpsilon >= secondBounds.minX
        && firstBounds.minY <= secondBounds.maxY + geometryEpsilon
        && firstBounds.maxY + geometryEpsilon >= secondBounds.minY;
}

function isValidBounds(bounds) {
    return bounds
        && Number.isFinite(bounds.minX)
        && Number.isFinite(bounds.minY)
        && Number.isFinite(bounds.maxX)
        && Number.isFinite(bounds.maxY);
}

function getPointBoundsDistanceSquared(point, bounds) {
    if (!isFinitePoint(point) || !isValidBounds(bounds)) {
        return Infinity;
    }

    const deltaX = point.x < bounds.minX
        ? bounds.minX - point.x
        : point.x > bounds.maxX
            ? point.x - bounds.maxX
            : 0;
    const deltaY = point.y < bounds.minY
        ? bounds.minY - point.y
        : point.y > bounds.maxY
            ? point.y - bounds.maxY
            : 0;

    return deltaX * deltaX + deltaY * deltaY;
}



function getTrailPointsCached(context, player, options = {}) {
    if (!context || !context.trailPointCache || !player) {
        return getTrailPoints(player, options);
    }

    const skipRecent = Number.isFinite(options.skipRecent) ? options.skipRecent : 0;
    const cacheKey = `${player.id}:${skipRecent}`;

    if (!context.trailPointCache.has(cacheKey)) {
        context.trailPointCache.set(cacheKey, getTrailPoints(player, options));
    }

    return context.trailPointCache.get(cacheKey);
}

function getTrailTargetIndexCached(context, player) {
    if (!context || !context.trailTargetIndexCache || !player) {
        return createPointBlockIndex(getTrailPoints(player), getBotTrailTargetBlockSize());
    }

    const cacheKey = player.id;

    if (context.trailTargetIndexCache.has(cacheKey)) {
        addBotTargetingDiagnosticValue(context, "trailIndexCacheHitCount", 1);
        return context.trailTargetIndexCache.get(cacheKey);
    }

    addBotTargetingDiagnosticValue(context, "trailIndexCacheMissCount", 1);
    const pointIndex = createPointBlockIndex(
        getTrailPointsCached(context, player),
        getBotTrailTargetBlockSize()
    );

    context.trailTargetIndexCache.set(cacheKey, pointIndex);
    return pointIndex;
}

function getSelfTrailSegmentsCached(context, player, options = {}) {
    if (!context || !context.selfTrailSegmentCache || !player) {
        return getSelfTrailSegments(player, options);
    }

    const skipRecent = Number.isFinite(options.skipRecent) ? options.skipRecent : 0;
    const cacheKey = `${player.id}:${skipRecent}`;

    if (!context.selfTrailSegmentCache.has(cacheKey)) {
        context.selfTrailSegmentCache.set(cacheKey, getSelfTrailSegments(player, options));
    }

    return context.selfTrailSegmentCache.get(cacheKey);
}

function getTrailPoints(player, options = {}) {
    const points = [];
    const skipRecent = Number.isFinite(options.skipRecent)
        ? Math.max(0, Math.floor(options.skipRecent))
        : 0;

    appendTrailPoints(points, player.trailLeftSegments, skipRecent);
    appendTrailPoints(points, player.trailRightSegments, skipRecent);

    return points;
}

function getSelfTrailSegments(player, options = {}) {
    const segments = [];

    appendSelfTrailSegments(segments, player.trailLeftSegments, options.skipRecent);
    appendSelfTrailSegments(segments, player.trailRightSegments, options.skipRecent);

    return segments;
}

function appendTrailPoints(target, segments, skipRecent = 0) {
    if (!Array.isArray(segments)) {
        return;
    }

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];

        if (!Array.isArray(segment)) {
            continue;
        }

        const isLastSegment = segmentIndex === segments.length - 1;
        const usablePointCount = isLastSegment
            ? Math.max(0, segment.length - skipRecent)
            : segment.length;

        for (let pointIndex = 0; pointIndex < usablePointCount; pointIndex++) {
            const point = segment[pointIndex];

            if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
                target.push(point);
            }
        }
    }
}

function appendSelfTrailSegments(target, segments, skipRecent = 0) {
    if (!Array.isArray(segments)) {
        return;
    }

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];

        if (!Array.isArray(segment) || segment.length < 2) {
            continue;
        }

        const isLastSegment = segmentIndex === segments.length - 1;
        const usablePointCount = isLastSegment
            ? Math.max(0, segment.length - skipRecent)
            : segment.length;

        for (let pointIndex = 0; pointIndex < usablePointCount - 1; pointIndex++) {
            const start = segment[pointIndex];
            const end = segment[pointIndex + 1];

            if (isFinitePoint(start) && isFinitePoint(end)) {
                target.push({ start, end });
            }
        }
    }
}

function isFinitePoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}

function hasAnyTrail(player) {
    return getTrailPoints(player).length >= 2;
}

function hasAnyTrailCached(context, player) {
    return getTrailPointsCached(context, player).length >= 2;
}

function segmentsCross(firstStart, firstEnd, secondStart, secondEnd) {
    if (!doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd)) {
        return false;
    }

    const firstDirection = subtractPoints(firstEnd, firstStart);
    const secondDirection = subtractPoints(secondEnd, secondStart);
    const denominator = crossProduct(firstDirection, secondDirection);

    if (Math.abs(denominator) <= geometryEpsilon) {
        return false;
    }

    const startDelta = subtractPoints(secondStart, firstStart);
    const firstT = crossProduct(startDelta, secondDirection) / denominator;
    const secondT = crossProduct(startDelta, firstDirection) / denominator;

    return firstT > geometryEpsilon
        && firstT <= 1 + geometryEpsilon
        && secondT > geometryEpsilon
        && secondT < 1 - geometryEpsilon;
}

function doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(Math.min(firstStart.x, firstEnd.x), Math.min(secondStart.x, secondEnd.x))
        <= Math.min(Math.max(firstStart.x, firstEnd.x), Math.max(secondStart.x, secondEnd.x)) + geometryEpsilon
        && Math.max(Math.min(firstStart.y, firstEnd.y), Math.min(secondStart.y, secondEnd.y))
        <= Math.min(Math.max(firstStart.y, firstEnd.y), Math.max(secondStart.y, secondEnd.y)) + geometryEpsilon;
}

function subtractPoints(first, second) {
    return {
        x: first.x - second.x,
        y: first.y - second.y
    };
}

function crossProduct(first, second) {
    return first.x * second.y - first.y * second.x;
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

module.exports = {
    arePointsEqual,
    createBoundsAroundPoint,
    createPointBlockIndex,
    createSegmentBlockIndex,
    doBoundsOverlap,
    filterPointsByBounds,
    filterSegmentsByBounds,
    getNearestDistanceSquared,
    getPointBoundsDistanceSquared,
    getPointIndex,
    getSegmentBounds,
    getSelfTrailSegmentsCached,
    getTrailPointsCached,
    getTrailTargetIndexCached,
    hasAnyTrail,
    hasAnyTrailCached,
    isFinitePoint,
    isValidBounds,
    segmentsCross
};
