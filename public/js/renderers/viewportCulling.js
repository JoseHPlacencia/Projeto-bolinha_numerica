export function createViewportBounds(center, viewportWidth, viewportHeight, scale, margin = 0) {
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
    const halfWidth = viewportWidth / safeScale / 2 + safeMargin;
    const halfHeight = viewportHeight / safeScale / 2 + safeMargin;

    return {
        minX: center.x - halfWidth,
        minY: center.y - halfHeight,
        maxX: center.x + halfWidth,
        maxY: center.y + halfHeight
    };
}

export function boundsOverlap(first, second) {
    if (!first || !second) {
        return true;
    }

    return first.minX <= second.maxX
        && first.maxX >= second.minX
        && first.minY <= second.maxY
        && first.maxY >= second.minY;
}

export function getPointsBounds(points, margin = 0) {
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hasPoint = false;

    for (const point of points || []) {
        if (!isValidPoint(point)) {
            continue;
        }

        hasPoint = true;
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }

    if (!hasPoint) {
        return null;
    }

    return {
        minX: minX - safeMargin,
        minY: minY - safeMargin,
        maxX: maxX + safeMargin,
        maxY: maxY + safeMargin
    };
}

export function getRingsBounds(rings, margin = 0) {
    let bounds = null;

    for (const ring of rings || []) {
        bounds = mergeBounds(bounds, getPointsBounds(ring, margin));
    }

    return bounds;
}

export function clipRingsToBounds(rings, bounds) {
    if (!bounds) {
        return rings || [];
    }

    return (rings || [])
        .map(ring => clipRingToBounds(ring, bounds))
        .filter(ring => ring.length >= 3);
}

export function clipClosedRingStrokeToBounds(ring, bounds) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 2) {
        return [];
    }

    return clipPolylineToBounds(openRing.concat(openRing[0]), bounds);
}

export function clipPolylineToBounds(points, bounds) {
    if (!bounds) {
        return [points || []];
    }

    const clippedSegments = [];
    let currentSegment = [];

    for (let index = 0; index < (points || []).length - 1; index++) {
        const clipped = clipLineSegmentToBounds(points[index], points[index + 1], bounds);

        if (!clipped) {
            pushSegment(clippedSegments, currentSegment);
            currentSegment = [];
            continue;
        }

        if (currentSegment.length === 0) {
            currentSegment.push(clipped.start, clipped.end);
            continue;
        }

        const lastPoint = currentSegment[currentSegment.length - 1];

        if (!arePointsEqual(lastPoint, clipped.start)) {
            pushSegment(clippedSegments, currentSegment);
            currentSegment = [clipped.start, clipped.end];
            continue;
        }

        currentSegment.push(clipped.end);
    }

    pushSegment(clippedSegments, currentSegment);

    return clippedSegments;
}

export function isPointNearBounds(point, bounds, margin = 0) {
    if (!bounds || !isValidPoint(point)) {
        return true;
    }

    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;

    return point.x >= bounds.minX - safeMargin
        && point.x <= bounds.maxX + safeMargin
        && point.y >= bounds.minY - safeMargin
        && point.y <= bounds.maxY + safeMargin;
}

function clipRingToBounds(ring, bounds) {
    let points = getOpenRing(ring);

    points = clipPolygonEdge(points, point => point.x >= bounds.minX, (start, end) => ({
        x: bounds.minX,
        y: start.y + (end.y - start.y) * ((bounds.minX - start.x) / (end.x - start.x))
    }));
    points = clipPolygonEdge(points, point => point.x <= bounds.maxX, (start, end) => ({
        x: bounds.maxX,
        y: start.y + (end.y - start.y) * ((bounds.maxX - start.x) / (end.x - start.x))
    }));
    points = clipPolygonEdge(points, point => point.y >= bounds.minY, (start, end) => ({
        x: start.x + (end.x - start.x) * ((bounds.minY - start.y) / (end.y - start.y)),
        y: bounds.minY
    }));
    points = clipPolygonEdge(points, point => point.y <= bounds.maxY, (start, end) => ({
        x: start.x + (end.x - start.x) * ((bounds.maxY - start.y) / (end.y - start.y)),
        y: bounds.maxY
    }));

    return removeConsecutiveDuplicatePoints(points).filter(isValidPoint);
}

function clipPolygonEdge(points, isInside, getIntersection) {
    if (points.length === 0) {
        return [];
    }

    const output = [];
    let previous = points[points.length - 1];
    let previousInside = isInside(previous);

    for (const current of points) {
        const currentInside = isInside(current);

        if (currentInside) {
            if (!previousInside) {
                output.push(getIntersection(previous, current));
            }

            output.push(current);
        } else if (previousInside) {
            output.push(getIntersection(previous, current));
        }

        previous = current;
        previousInside = currentInside;
    }

    return removeConsecutiveDuplicatePoints(output).filter(isValidPoint);
}

function clipLineSegmentToBounds(start, end, bounds) {
    if (!isValidPoint(start) || !isValidPoint(end)) {
        return null;
    }

    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    let startAmount = 0;
    let endAmount = 1;

    const updates = [
        clipLineAmount(-deltaX, start.x - bounds.minX),
        clipLineAmount(deltaX, bounds.maxX - start.x),
        clipLineAmount(-deltaY, start.y - bounds.minY),
        clipLineAmount(deltaY, bounds.maxY - start.y)
    ];

    for (const update of updates) {
        if (!update.visible) {
            return null;
        }

        if (update.side === "start") {
            startAmount = Math.max(startAmount, update.amount);
        } else if (update.side === "end") {
            endAmount = Math.min(endAmount, update.amount);
        }

        if (startAmount > endAmount) {
            return null;
        }
    }

    return {
        start: {
            x: start.x + deltaX * startAmount,
            y: start.y + deltaY * startAmount
        },
        end: {
            x: start.x + deltaX * endAmount,
            y: start.y + deltaY * endAmount
        }
    };
}

function clipLineAmount(direction, distance) {
    if (Math.abs(direction) <= Number.EPSILON) {
        return {
            visible: distance >= 0,
            side: null,
            amount: 0
        };
    }

    const amount = distance / direction;

    if (direction < 0) {
        return {
            visible: amount <= 1,
            side: "start",
            amount
        };
    }

    return {
        visible: amount >= 0,
        side: "end",
        amount
    };
}

function getOpenRing(ring) {
    const points = (ring || []).filter(isValidPoint);

    if (points.length > 1 && arePointsEqual(points[0], points[points.length - 1])) {
        return points.slice(0, -1);
    }

    return points;
}

function pushSegment(segments, points) {
    const cleaned = removeConsecutiveDuplicatePoints(points);

    if (cleaned.length >= 2) {
        segments.push(cleaned);
    }
}

function removeConsecutiveDuplicatePoints(points) {
    return (points || []).filter((point, index) => (
        isValidPoint(point)
        && (index === 0 || !arePointsEqual(point, points[index - 1]))
    ));
}

function arePointsEqual(first, second) {
    return Boolean(first && second)
        && Math.abs(first.x - second.x) <= Number.EPSILON
        && Math.abs(first.y - second.y) <= Number.EPSILON;
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

function isValidPoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}
