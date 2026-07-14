const geometryEpsilon = 1e-7;
const defaultAngleThresholdRadians = Math.PI / 180;
const defaultMaxArcSweepRadians = Math.PI * 0.75;
const defaultMaxArcRadialDrift = 2;
const defaultLineDeviationTolerance = 1.5;
const defaultPrimitiveBlockSize = 48;

function createPathPrimitivesFromPoints(points, options = {}) {
    const validPoints = getValidPoints(points);

    return createPathPrimitivesFromValidPoints(
        validPoints,
        normalizePrimitiveOptions(options, "path")
    );
}

function createPathPrimitivesFromValidPoints(validPoints, options) {
    if (validPoints.length < 2) {
        return [];
    }

    const primitives = [];
    let runStartIndex = 0;
    let runAngle = getSegmentAngle(validPoints[0], validPoints[1]);
    let index = 1;

    while (index < validPoints.length - 1) {
        const nextAngle = getSegmentAngle(validPoints[index], validPoints[index + 1]);
        const angleDelta = Math.abs(getAngleDelta(runAngle, nextAngle));

        if (!Number.isFinite(angleDelta) || angleDelta < options.angleThresholdRadians) {
            index++;
            continue;
        }

        const arc = createArcPrimitive(validPoints, runStartIndex, index, index + 1, {
            maxArcRadialDrift: options.maxArcRadialDrift,
            maxArcSweepRadians: options.maxArcSweepRadians
        });

        if (arc) {
            primitives.push(arc);
            runStartIndex = index + 1;
            runAngle = runStartIndex < validPoints.length - 1
                ? getSegmentAngle(validPoints[runStartIndex], validPoints[runStartIndex + 1])
                : null;
            index = Math.max(index + 2, runStartIndex + 1);
            continue;
        }

        pushLinePrimitive(primitives, validPoints, runStartIndex, index);
        runStartIndex = index;
        runAngle = nextAngle;
        index++;
    }

    pushLinePrimitive(primitives, validPoints, runStartIndex, validPoints.length - 1);

    return primitives;
}

function doesLineCrossPathPrimitive(startPoint, endPoint, primitive) {
    if (!isValidPoint(startPoint)
        || !isValidPoint(endPoint)
        || !primitive
        || !doBoundsOverlap(getLineBounds(startPoint, endPoint), primitive.bounds)) {
        return false;
    }

    if (primitive.type === "line") {
        return segmentsCross(startPoint, endPoint, primitive.from, primitive.to);
    }

    if (primitive.type === "arc") {
        return lineSegmentCrossesArc(startPoint, endPoint, primitive);
    }

    return false;
}

function createLinePrimitivesFromPoints(points, options = {}) {
    const validPoints = getValidPoints(points);

    return createLinePrimitivesFromValidPoints(
        validPoints,
        normalizePrimitiveOptions(options, "line")
    );
}

function createLinePrimitivesFromValidPoints(validPoints, options) {
    if (validPoints.length < 2) {
        return [];
    }

    const primitives = [];
    let runStartIndex = 0;
    let index = 2;

    while (index < validPoints.length) {
        if (canUseLinePrimitiveRun(validPoints, runStartIndex, index, {
            angleThresholdRadians: options.angleThresholdRadians,
            maxDeviation: options.maxDeviation
        })) {
            index++;
            continue;
        }

        pushLinePrimitive(primitives, validPoints, runStartIndex, index - 1);
        runStartIndex = index - 1;
        index = runStartIndex + 2;
    }

    pushLinePrimitive(primitives, validPoints, runStartIndex, validPoints.length - 1);

    return primitives;
}

function createPathPrimitiveIndex(primitives, options = {}) {
    const validPrimitives = [];

    for (const primitive of primitives || []) {
        if (primitive && isValidBounds(primitive.bounds)) {
            validPrimitives.push(primitive);
        }
    }

    if (validPrimitives.length <= 0) {
        return createEmptyPathPrimitiveIndex();
    }

    const blockSize = getPositiveIntegerOption(
        options.blockSize,
        defaultPrimitiveBlockSize
    );

    return createPathPrimitiveIndexFrom(validPrimitives, blockSize);
}

/**
 * Extends a point-derived primitive index without rebuilding its immutable
 * prefix. The result is byte-for-byte equivalent to a full build as long as
 * the same point array only grew at the end. Any incompatible change falls
 * back to a complete rebuild.
 */
function updatePathPrimitiveIndexFromPoints(points, previousState = null, options = {}) {
    const sourcePoints = Array.isArray(points) ? points : [];
    const sourcePointCount = getSourcePointCount(sourcePoints, options.pointCount);
    const normalizedOptions = normalizePrimitiveOptions(options, options.mode);
    const signature = createPrimitiveOptionsSignature(normalizedOptions);
    const previousCanExtend = canExtendPrimitiveIndexState(
        sourcePoints,
        sourcePointCount,
        previousState,
        signature
    );

    if (!previousCanExtend) {
        return createFullPrimitiveIndexState(
            sourcePoints,
            sourcePointCount,
            normalizedOptions,
            signature
        );
    }

    return extendPrimitiveIndexState(
        sourcePoints,
        sourcePointCount,
        previousState,
        normalizedOptions,
        signature
    );
}

function createFullPrimitiveIndexState(points, sourcePointCount, options, signature) {
    const validPoints = getValidPoints(points, 0, sourcePointCount);
    const primitives = createPrimitivesFromValidPoints(validPoints, options);
    const index = createPathPrimitiveIndexFrom(primitives, options.blockSize);
    const lastPoint = sourcePointCount > 0 ? points[sourcePointCount - 1] : null;

    return {
        allPointsValid: validPoints.length === sourcePointCount,
        index,
        lastX: lastPoint && lastPoint.x,
        lastY: lastPoint && lastPoint.y,
        rebuiltPointCount: sourcePointCount,
        reusedBlockCount: 0,
        signature,
        sourcePointCount,
        updatedIncrementally: false
    };
}

function extendPrimitiveIndexState(points, sourcePointCount, previousState, options, signature) {
    const previousPrimitives = previousState.index.primitives;
    const lastPrimitive = previousPrimitives[previousPrimitives.length - 1];
    const stablePrimitiveCount = lastPrimitive && lastPrimitive.type === "line"
        ? previousPrimitives.length - 1
        : previousPrimitives.length;
    const rebuildStartIndex = lastPrimitive && lastPrimitive.type === "line"
        ? lastPrimitive.startIndex
        : previousState.sourcePointCount - 1;
    const tailPoints = getValidPoints(points, rebuildStartIndex, sourcePointCount);
    const tailPrimitives = createPrimitivesFromValidPoints(tailPoints, options);

    offsetPrimitiveIndexes(tailPrimitives, rebuildStartIndex);

    const primitives = previousPrimitives
        .slice(0, stablePrimitiveCount)
        .concat(tailPrimitives);
    const indexed = extendPathPrimitiveIndex(
        primitives,
        previousState.index,
        stablePrimitiveCount,
        options.blockSize
    );
    const lastPoint = points[sourcePointCount - 1];

    return {
        allPointsValid: true,
        index: indexed.index,
        lastX: lastPoint.x,
        lastY: lastPoint.y,
        rebuiltPointCount: tailPoints.length,
        reusedBlockCount: indexed.reusedBlockCount,
        signature,
        sourcePointCount,
        updatedIncrementally: true
    };
}

function createPrimitivesFromValidPoints(validPoints, options) {
    return options.mode === "line"
        ? createLinePrimitivesFromValidPoints(validPoints, options)
        : createPathPrimitivesFromValidPoints(validPoints, options);
}

function createPathPrimitiveIndexFrom(primitives, blockSize) {
    const blocks = [];
    let bounds = null;

    for (let startIndex = 0; startIndex < primitives.length; startIndex += blockSize) {
        const block = createPathPrimitiveBlock(primitives, startIndex, blockSize);

        if (!block) {
            continue;
        }

        blocks.push(block);
        bounds = mergeBounds(bounds, block.bounds);
    }

    return {
        blocks,
        bounds,
        primitives
    };
}

function extendPathPrimitiveIndex(primitives, previousIndex, stablePrimitiveCount, blockSize) {
    const reusableBlockCount = Math.min(
        Math.floor(stablePrimitiveCount / blockSize),
        previousIndex.blocks.length
    );
    const blocks = previousIndex.blocks.slice(0, reusableBlockCount);
    let bounds = null;

    for (const block of blocks) {
        bounds = mergeBounds(bounds, block.bounds);
    }

    for (
        let startIndex = reusableBlockCount * blockSize;
        startIndex < primitives.length;
        startIndex += blockSize
    ) {
        const block = createPathPrimitiveBlock(primitives, startIndex, blockSize);

        if (!block) {
            continue;
        }

        blocks.push(block);
        bounds = mergeBounds(bounds, block.bounds);
    }

    return {
        index: {
            blocks,
            bounds,
            primitives
        },
        reusedBlockCount: reusableBlockCount
    };
}

function createPathPrimitiveBlock(primitives, startIndex, blockSize) {
    const blockPrimitives = primitives.slice(startIndex, startIndex + blockSize);
    let bounds = null;

    for (const primitive of blockPrimitives) {
        bounds = mergeBounds(bounds, primitive.bounds);
    }

    return bounds
        ? {
            bounds,
            primitives: blockPrimitives
        }
        : null;
}

function createEmptyPathPrimitiveIndex() {
    return {
        blocks: [],
        bounds: null,
        primitives: []
    };
}

function canExtendPrimitiveIndexState(points, sourcePointCount, previousState, signature) {
    if (!previousState
        || previousState.signature !== signature
        || previousState.allPointsValid !== true
        || !previousState.index
        || !Array.isArray(previousState.index.primitives)
        || previousState.sourcePointCount < 2
        || previousState.sourcePointCount >= sourcePointCount) {
        return false;
    }

    const previousLastPoint = points[previousState.sourcePointCount - 1];

    return isValidPoint(previousLastPoint)
        && previousLastPoint.x === previousState.lastX
        && previousLastPoint.y === previousState.lastY
        && areValidPoints(points, previousState.sourcePointCount, sourcePointCount);
}

function areValidPoints(points, startIndex, endIndex) {
    for (let index = startIndex; index < endIndex; index++) {
        if (!isValidPoint(points[index])) {
            return false;
        }
    }

    return true;
}

function offsetPrimitiveIndexes(primitives, offset) {
    for (const primitive of primitives) {
        primitive.startIndex += offset;
        primitive.endIndex += offset;
    }
}

function getSourcePointCount(points, requestedPointCount) {
    return Number.isInteger(requestedPointCount)
        ? Math.min(points.length, Math.max(0, requestedPointCount))
        : points.length;
}

function normalizePrimitiveOptions(options = {}, requestedMode = "path") {
    return {
        angleThresholdRadians: getPositiveNumberOption(
            options.angleThresholdRadians,
            defaultAngleThresholdRadians
        ),
        blockSize: getPositiveIntegerOption(options.blockSize, defaultPrimitiveBlockSize),
        maxArcRadialDrift: getNonNegativeNumberOption(
            options.maxArcRadialDrift,
            defaultMaxArcRadialDrift
        ),
        maxArcSweepRadians: getPositiveNumberOption(
            options.maxArcSweepRadians,
            defaultMaxArcSweepRadians
        ),
        maxDeviation: getNonNegativeNumberOption(
            options.maxDeviation,
            defaultLineDeviationTolerance
        ),
        mode: requestedMode === "line" ? "line" : "path"
    };
}

function createPrimitiveOptionsSignature(options) {
    return [
        options.mode,
        options.angleThresholdRadians,
        options.maxArcSweepRadians,
        options.maxArcRadialDrift,
        options.maxDeviation,
        options.blockSize
    ].join(":");
}

function canUseLinePrimitiveRun(points, startIndex, endIndex, options) {
    const startPoint = points[startIndex];
    const endPoint = points[endIndex];

    if (!startPoint || !endPoint || endIndex <= startIndex + 1) {
        return true;
    }

    const chordAngle = getSegmentAngle(startPoint, endPoint);
    const maxDeviationSquared = options.maxDeviation * options.maxDeviation;

    for (let index = startIndex; index < endIndex; index++) {
        const segmentAngle = getSegmentAngle(points[index], points[index + 1]);

        if (Math.abs(getAngleDelta(chordAngle, segmentAngle)) > options.angleThresholdRadians) {
            return false;
        }
    }

    for (let index = startIndex + 1; index < endIndex; index++) {
        if (getPointLineSegmentDistanceSquared(points[index], startPoint, endPoint) > maxDeviationSquared) {
            return false;
        }
    }

    return true;
}

function pushLinePrimitive(primitives, points, startIndex, endIndex) {
    if (!Number.isInteger(startIndex)
        || !Number.isInteger(endIndex)
        || endIndex <= startIndex
        || !points[startIndex]
        || !points[endIndex]) {
        return;
    }

    primitives.push(createLinePrimitive(points[startIndex], points[endIndex], startIndex, endIndex));
}

function createLinePrimitive(from, to, startIndex, endIndex) {
    return {
        bounds: getLineBounds(from, to),
        endIndex,
        from: clonePoint(from),
        startIndex,
        to: clonePoint(to),
        type: "line"
    };
}

function createArcPrimitive(points, startIndex, middleIndex, endIndex, options) {
    const start = points[startIndex];
    const middle = points[middleIndex];
    const end = points[endIndex];
    const circle = getCircleFromThreePoints(start, middle, end);

    if (!circle) {
        return null;
    }

    const startAngle = Math.atan2(start.y - circle.center.y, start.x - circle.center.x);
    const middleAngle = Math.atan2(middle.y - circle.center.y, middle.x - circle.center.x);
    const endAngle = Math.atan2(end.y - circle.center.y, end.x - circle.center.x);
    const middleOnCounterClockwiseArc = isAngleBetweenCounterClockwise(startAngle, middleAngle, endAngle);
    const clockwise = !middleOnCounterClockwiseArc;
    const sweepRadians = clockwise
        ? getCounterClockwiseAngleDelta(endAngle, startAngle)
        : getCounterClockwiseAngleDelta(startAngle, endAngle);

    if (!Number.isFinite(sweepRadians)
        || sweepRadians <= geometryEpsilon
        || sweepRadians > options.maxArcSweepRadians
        || !isArcRunStable(points, startIndex, endIndex, circle, options.maxArcRadialDrift)) {
        return null;
    }

    return {
        bounds: getArcBounds(circle.center, circle.radius, startAngle, endAngle, clockwise),
        center: clonePoint(circle.center),
        clockwise,
        endAngle,
        endIndex,
        radius: circle.radius,
        startAngle,
        startIndex,
        sweepRadians,
        type: "arc"
    };
}

function getCircleFromThreePoints(first, second, third) {
    if (!isValidPoint(first) || !isValidPoint(second) || !isValidPoint(third)) {
        return null;
    }

    const denominator = 2 * (
        first.x * (second.y - third.y)
        + second.x * (third.y - first.y)
        + third.x * (first.y - second.y)
    );

    if (Math.abs(denominator) <= geometryEpsilon) {
        return null;
    }

    const firstLengthSquared = first.x * first.x + first.y * first.y;
    const secondLengthSquared = second.x * second.x + second.y * second.y;
    const thirdLengthSquared = third.x * third.x + third.y * third.y;
    const center = {
        x: (
            firstLengthSquared * (second.y - third.y)
            + secondLengthSquared * (third.y - first.y)
            + thirdLengthSquared * (first.y - second.y)
        ) / denominator,
        y: (
            firstLengthSquared * (third.x - second.x)
            + secondLengthSquared * (first.x - third.x)
            + thirdLengthSquared * (second.x - first.x)
        ) / denominator
    };
    const radius = distanceBetweenPoints(center, first);

    if (!Number.isFinite(radius) || radius <= geometryEpsilon) {
        return null;
    }

    return {
        center,
        radius
    };
}

function isArcRunStable(points, startIndex, endIndex, circle, maxRadialDrift) {
    for (let index = startIndex + 1; index < endIndex; index++) {
        const point = points[index];
        const radialDrift = Math.abs(distanceBetweenPoints(circle.center, point) - circle.radius);

        if (radialDrift > maxRadialDrift) {
            return false;
        }
    }

    return true;
}

function lineSegmentCrossesArc(startPoint, endPoint, arc) {
    const direction = {
        x: endPoint.x - startPoint.x,
        y: endPoint.y - startPoint.y
    };
    const fromCenter = {
        x: startPoint.x - arc.center.x,
        y: startPoint.y - arc.center.y
    };
    const a = dotProduct(direction, direction);

    if (a <= geometryEpsilon) {
        return false;
    }

    const b = 2 * dotProduct(fromCenter, direction);
    const c = dotProduct(fromCenter, fromCenter) - arc.radius * arc.radius;
    const discriminant = b * b - 4 * a * c;

    if (discriminant < -geometryEpsilon) {
        return false;
    }

    const roots = Math.abs(discriminant) <= geometryEpsilon
        ? [-b / (2 * a)]
        : [
            (-b - Math.sqrt(discriminant)) / (2 * a),
            (-b + Math.sqrt(discriminant)) / (2 * a)
        ];

    return roots.some(t => {
        if (t <= geometryEpsilon || t > 1 + geometryEpsilon) {
            return false;
        }

        const point = {
            x: startPoint.x + direction.x * t,
            y: startPoint.y + direction.y * t
        };

        return isPointOnArcInterior(point, arc);
    });
}

function isPointOnArcInterior(point, arc) {
    const angle = Math.atan2(point.y - arc.center.y, point.x - arc.center.x);
    const traveled = arc.clockwise
        ? getCounterClockwiseAngleDelta(angle, arc.startAngle)
        : getCounterClockwiseAngleDelta(arc.startAngle, angle);
    const endpointEpsilon = Math.max(geometryEpsilon, 1 / Math.max(arc.radius, 1));

    return traveled > endpointEpsilon
        && traveled < arc.sweepRadians - endpointEpsilon;
}

function getArcBounds(center, radius, startAngle, endAngle, clockwise) {
    const points = [
        pointOnCircle(center, radius, startAngle),
        pointOnCircle(center, radius, endAngle)
    ];

    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        if (isAngleOnArc(startAngle, angle, endAngle, clockwise)) {
            points.push(pointOnCircle(center, radius, angle));
        }
    }

    return getPointsBounds(points);
}

function isAngleOnArc(startAngle, angle, endAngle, clockwise) {
    const sweepRadians = clockwise
        ? getCounterClockwiseAngleDelta(endAngle, startAngle)
        : getCounterClockwiseAngleDelta(startAngle, endAngle);
    const traveled = clockwise
        ? getCounterClockwiseAngleDelta(angle, startAngle)
        : getCounterClockwiseAngleDelta(startAngle, angle);

    return traveled >= -geometryEpsilon && traveled <= sweepRadians + geometryEpsilon;
}

function isAngleBetweenCounterClockwise(startAngle, angle, endAngle) {
    return getCounterClockwiseAngleDelta(startAngle, angle)
        <= getCounterClockwiseAngleDelta(startAngle, endAngle) + geometryEpsilon;
}

function getCounterClockwiseAngleDelta(startAngle, endAngle) {
    let delta = normalizeAngle(endAngle) - normalizeAngle(startAngle);

    if (delta < 0) {
        delta += Math.PI * 2;
    }

    return delta;
}

function getAngleDelta(firstAngle, secondAngle) {
    if (!Number.isFinite(firstAngle) || !Number.isFinite(secondAngle)) {
        return 0;
    }

    let delta = secondAngle - firstAngle;

    while (delta < -Math.PI) {
        delta += Math.PI * 2;
    }

    while (delta > Math.PI) {
        delta -= Math.PI * 2;
    }

    return delta;
}

function normalizeAngle(angle) {
    let normalized = angle % (Math.PI * 2);

    if (normalized < 0) {
        normalized += Math.PI * 2;
    }

    return normalized;
}

function segmentsCross(firstStart, firstEnd, secondStart, secondEnd) {
    if (!doBoundsOverlap(getLineBounds(firstStart, firstEnd), getLineBounds(secondStart, secondEnd))) {
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

function doBoundsOverlap(first, second) {
    if (!first || !second) {
        return true;
    }

    return first.minX <= second.maxX + geometryEpsilon
        && first.maxX + geometryEpsilon >= second.minX
        && first.minY <= second.maxY + geometryEpsilon
        && first.maxY + geometryEpsilon >= second.minY;
}

function getLineBounds(startPoint, endPoint) {
    return {
        minX: Math.min(startPoint.x, endPoint.x),
        minY: Math.min(startPoint.y, endPoint.y),
        maxX: Math.max(startPoint.x, endPoint.x),
        maxY: Math.max(startPoint.y, endPoint.y)
    };
}

function getPointsBounds(points) {
    let bounds = null;

    for (const point of points || []) {
        if (!isValidPoint(point)) {
            continue;
        }

        const pointBounds = {
            minX: point.x,
            minY: point.y,
            maxX: point.x,
            maxY: point.y
        };

        bounds = bounds
            ? {
                minX: Math.min(bounds.minX, pointBounds.minX),
                minY: Math.min(bounds.minY, pointBounds.minY),
                maxX: Math.max(bounds.maxX, pointBounds.maxX),
                maxY: Math.max(bounds.maxY, pointBounds.maxY)
            }
            : pointBounds;
    }

    return bounds;
}

function getBoundsUnion(boundsList) {
    let union = null;

    for (const bounds of boundsList || []) {
        union = mergeBounds(union, bounds);
    }

    return union;
}

function mergeBounds(first, second) {
    if (!isValidBounds(second)) {
        return first;
    }

    if (!first) {
        return {
            minX: second.minX,
            minY: second.minY,
            maxX: second.maxX,
            maxY: second.maxY
        };
    }

    return {
        minX: Math.min(first.minX, second.minX),
        minY: Math.min(first.minY, second.minY),
        maxX: Math.max(first.maxX, second.maxX),
        maxY: Math.max(first.maxY, second.maxY)
    };
}

function isValidBounds(bounds) {
    return bounds
        && Number.isFinite(bounds.minX)
        && Number.isFinite(bounds.minY)
        && Number.isFinite(bounds.maxX)
        && Number.isFinite(bounds.maxY);
}

function pointOnCircle(center, radius, angle) {
    return {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius
    };
}

function getPointLineSegmentDistanceSquared(point, segmentStart, segmentEnd) {
    const direction = subtractPoints(segmentEnd, segmentStart);
    const lengthSquared = dotProduct(direction, direction);

    if (lengthSquared <= geometryEpsilon) {
        return getDistanceSquared(point, segmentStart);
    }

    const t = clamp(dotProduct(subtractPoints(point, segmentStart), direction) / lengthSquared, 0, 1);
    const projection = {
        x: segmentStart.x + direction.x * t,
        y: segmentStart.y + direction.y * t
    };

    return getDistanceSquared(point, projection);
}

function getSegmentAngle(startPoint, endPoint) {
    return Math.atan2(endPoint.y - startPoint.y, endPoint.x - startPoint.x);
}

function getValidPoints(points, startIndex = 0, endIndex = null) {
    const source = Array.isArray(points) ? points : [];
    const limit = Number.isInteger(endIndex)
        ? Math.min(source.length, Math.max(startIndex, endIndex))
        : source.length;
    const validPoints = [];

    for (let index = Math.max(0, startIndex); index < limit; index++) {
        if (isValidPoint(source[index])) {
            validPoints.push(source[index]);
        }
    }

    return validPoints;
}

function isValidPoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}

function clonePoint(point) {
    return {
        x: point.x,
        y: point.y
    };
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

function dotProduct(first, second) {
    return first.x * second.x + first.y * second.y;
}

function distanceBetweenPoints(first, second) {
    return Math.hypot(first.x - second.x, first.y - second.y);
}

function getDistanceSquared(first, second) {
    const deltaX = first.x - second.x;
    const deltaY = first.y - second.y;

    return deltaX * deltaX + deltaY * deltaY;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getPositiveNumberOption(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getNonNegativeNumberOption(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getPositiveIntegerOption(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
    createLinePrimitivesFromPoints,
    createPathPrimitiveIndex,
    createPathPrimitivesFromPoints,
    doesLineCrossPathPrimitive,
    updatePathPrimitiveIndexFromPoints
};
