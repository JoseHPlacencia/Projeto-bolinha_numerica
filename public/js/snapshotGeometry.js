import { clamp } from "./sharedMath.js";

const coordinatePrecision = 1000;
const geometryEpsilon = 1e-7;
const indexedBoundaryMaxDistanceSquared = 4;

export function unpackPolygon(polygon) {
    return {
        rings: (polygon || [])
            .map(unpackPoints)
            .filter(ring => ring.length >= 3)
    };
}

export function unpackSegments(segments) {
    return (segments || [])
        .map(unpackPoints)
        .filter(segment => segment.length >= 2);
}

export function unpackPoints(points) {
    return (points || [])
        .map(unpackPoint)
        .filter(Boolean);
}

export function unpackPoint(point) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        return null;
    }

    return {
        x: point[0],
        y: point[1]
    };
}

export function isValidPoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}

export function createTrailFillPolygon(leftPath, rightPath) {
    const ring = leftPath.concat([...rightPath].reverse());

    if (ring.length < 3) {
        return null;
    }

    const closedRing = closeRing(ring);

    return closedRing.length >= 4 ? {
        rings: [closedRing]
    } : null;
}

function closeRing(ring) {
    const points = ring.filter(isValidPoint);

    if (points.length === 0) {
        return [];
    }

    const first = points[0];
    const last = points[points.length - 1];

    if (Math.abs(first.x - last.x) <= Number.EPSILON
        && Math.abs(first.y - last.y) <= Number.EPSILON) {
        return points;
    }

    return points.concat({
        x: first.x,
        y: first.y
    });
}

export function createClippedTrailPoints(sidePoints, expectedLength, startPoint, endPoint) {
    const expectedPointCount = Number.isInteger(expectedLength) && expectedLength > 1
        ? expectedLength
        : sidePoints.length;
    const usablePoints = sidePoints.slice(0, expectedPointCount);
    const middlePoints = usablePoints.length >= expectedPointCount
        ? usablePoints.slice(1, -1)
        : usablePoints.slice(1);

    return removeConsecutiveDuplicatePoints([
        startPoint,
        ...middlePoints,
        endPoint
    ]);
}

export function createBoundaryPaths(ring, startContact, endContact) {
    const openRing = getOpenRing(ring);

    if (!startContact || !endContact || openRing.length < 3) {
        return [];
    }

    const forwardPath = createForwardBoundaryPath(openRing, startContact, endContact);
    const reversePath = createForwardBoundaryPath(openRing, endContact, startContact).reverse();

    return [
        removeConsecutiveDuplicatePoints(forwardPath),
        removeConsecutiveDuplicatePoints(reversePath)
    ].filter(path => path.length >= 2);
}

function createForwardBoundaryPath(openRing, startContact, endContact) {
    if (startContact.segmentIndex === endContact.segmentIndex
        && endContact.segmentT >= startContact.segmentT) {
        return [startContact.point, endContact.point];
    }

    const path = [startContact.point];
    let vertexIndex = (startContact.segmentIndex + 1) % openRing.length;
    let guard = 0;

    while (guard <= openRing.length) {
        path.push(openRing[vertexIndex]);

        if (vertexIndex === endContact.segmentIndex) {
            break;
        }

        vertexIndex = (vertexIndex + 1) % openRing.length;
        guard++;
    }

    path.push(endContact.point);

    return path;
}

export function selectBoundaryPathByAnchor(paths, anchor) {
    let selectedPath = null;
    let selectedDistance = Infinity;

    for (const path of paths || []) {
        const distance = getPointPathDistanceSquared(anchor, path);

        if (distance < selectedDistance) {
            selectedDistance = distance;
            selectedPath = path;
        }
    }

    return selectedPath && Number.isFinite(selectedDistance) ? selectedPath : null;
}

export function getPointPathDistanceSquared(point, path) {
    let distance = Infinity;

    for (let index = 0; index < path.length - 1; index++) {
        distance = Math.min(
            distance,
            getPointSegmentDistanceSquared(point, path[index], path[index + 1])
        );
    }

    return distance;
}

export function findClosestPolygonBoundaryContact(ring, point) {
    const openRing = getOpenRing(ring);
    let closestContact = null;

    for (let segmentIndex = 0; segmentIndex < openRing.length; segmentIndex++) {
        const projection = projectPointOnSegment(
            point,
            openRing[segmentIndex],
            openRing[(segmentIndex + 1) % openRing.length]
        );

        if (!closestContact || projection.distanceSquared < closestContact.distanceSquared) {
            closestContact = {
                point: projection.point,
                segmentIndex,
                segmentT: projection.segmentT,
                distanceSquared: projection.distanceSquared
            };
        }
    }

    return closestContact;
}

export function projectPointOnSegment(point, segmentStart, segmentEnd) {
    const direction = subtractPoints(segmentEnd, segmentStart);
    const lengthSquared = direction.x * direction.x + direction.y * direction.y;
    const segmentT = lengthSquared <= geometryEpsilon
        ? 0
        : clamp(dotProduct(subtractPoints(point, segmentStart), direction) / lengthSquared, 0, 1);
    const projectedPoint = {
        x: segmentStart.x + direction.x * segmentT,
        y: segmentStart.y + direction.y * segmentT
    };

    return {
        point: projectedPoint,
        segmentT,
        distanceSquared: getDistanceSquared(point, projectedPoint)
    };
}

function getPointSegmentDistanceSquared(point, segmentStart, segmentEnd) {
    return projectPointOnSegment(point, segmentStart, segmentEnd).distanceSquared;
}

export function normalizePolygonRing(points) {
    const ring = points
        .filter(isValidPoint)
        .map(point => ({
            x: roundCoordinate(point.x),
            y: roundCoordinate(point.y)
        }));

    removeClosingDuplicatePoint(ring);
    const dedupedRing = removeConsecutiveDuplicatePoints(ring);

    removeCollinearPoints(dedupedRing);

    return closeRing(dedupedRing);
}

function getOpenRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
        return ring.slice(0, -1);
    }

    return ring.slice();
}

export function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
}

function removeClosingDuplicatePoint(ring) {
    if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
        ring.pop();
    }
}

function removeCollinearPoints(ring) {
    removeCircularRedundantPoints(ring, (previous, current, next) => (
        Math.abs(crossCoordinates(previous, current, next)) <= geometryEpsilon
    ));
}

function removeCircularRedundantPoints(points, isRedundant) {
    const pointCount = points.length;

    if (pointCount < 3) {
        return;
    }

    const previousIndexes = new Int32Array(pointCount);
    const nextIndexes = new Int32Array(pointCount);
    const removed = new Uint8Array(pointCount);
    const pendingIndexes = Array.from({ length: pointCount }, (_value, index) => index);
    let pendingHead = 0;
    let remainingPointCount = pointCount;

    for (let index = 0; index < pointCount; index++) {
        previousIndexes[index] = (index - 1 + pointCount) % pointCount;
        nextIndexes[index] = (index + 1) % pointCount;
    }

    while (pendingHead < pendingIndexes.length && remainingPointCount >= 3) {
        const index = pendingIndexes[pendingHead++];

        if (removed[index]) {
            continue;
        }

        const previousIndex = previousIndexes[index];
        const nextIndex = nextIndexes[index];

        if (!isRedundant(points[previousIndex], points[index], points[nextIndex])) {
            continue;
        }

        removed[index] = 1;
        nextIndexes[previousIndex] = nextIndex;
        previousIndexes[nextIndex] = previousIndex;
        remainingPointCount--;
        pendingIndexes.push(previousIndex, nextIndex);
    }

    if (remainingPointCount === pointCount) {
        return;
    }

    const compacted = [];
    let startIndex = 0;

    while (startIndex < pointCount && removed[startIndex]) {
        startIndex++;
    }

    if (startIndex < pointCount) {
        let index = startIndex;

        do {
            compacted.push(points[index]);
            index = nextIndexes[index];
        } while (index !== startIndex && compacted.length < remainingPointCount);
    }

    points.length = 0;
    points.push(...compacted);
}

function crossCoordinates(first, second, third) {
    return (second.x - first.x) * (third.y - first.y)
        - (second.y - first.y) * (third.x - first.x);
}

export function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

function subtractPoints(first, second) {
    return {
        x: first.x - second.x,
        y: first.y - second.y
    };
}

function dotProduct(first, second) {
    return first.x * second.x + first.y * second.y;
}

export function getDistanceSquared(first, second) {
    const x = first.x - second.x;
    const y = first.y - second.y;

    return x * x + y * y;
}

export function calculateRingArea(ring) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 3) {
        return 0;
    }

    let area = 0;

    for (let index = 0; index < openRing.length; index++) {
        const current = openRing[index];
        const next = openRing[(index + 1) % openRing.length];

        area += current.x * next.y - next.x * current.y;
    }

    return area / 2;
}

export function hasSelfIntersections(ring) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 4) {
        return false;
    }

    const segments = createSortedRingSegments(openRing);

    for (let firstOrderIndex = 0; firstOrderIndex < segments.length; firstOrderIndex++) {
        const first = segments[firstOrderIndex];

        for (let secondOrderIndex = firstOrderIndex + 1; secondOrderIndex < segments.length; secondOrderIndex++) {
            const second = segments[secondOrderIndex];

            if (second.bounds.minX > first.bounds.maxX + geometryEpsilon) {
                break;
            }

            if (areAdjacentSegments(first.index, second.index, openRing.length)
                || !doBoundsOverlap(first.bounds, second.bounds)) {
                continue;
            }

            if (segmentsIntersect(first.start, first.end, second.start, second.end)) {
                return true;
            }
        }
    }

    return false;
}

function createSortedRingSegments(openRing) {
    return openRing
        .map((start, index) => {
            const end = openRing[(index + 1) % openRing.length];

            return {
                bounds: createSegmentBounds(start, end),
                end,
                index,
                start
            };
        })
        .sort((first, second) => first.bounds.minX - second.bounds.minX);
}

function createSegmentBounds(start, end) {
    return {
        minX: Math.min(start.x, end.x),
        minY: Math.min(start.y, end.y),
        maxX: Math.max(start.x, end.x),
        maxY: Math.max(start.y, end.y)
    };
}

function doBoundsOverlap(first, second) {
    return first.minX <= second.maxX + geometryEpsilon
        && first.maxX + geometryEpsilon >= second.minX
        && first.minY <= second.maxY + geometryEpsilon
        && first.maxY + geometryEpsilon >= second.minY;
}

function areAdjacentSegments(firstIndex, secondIndex, segmentCount) {
    const indexDistance = Math.abs(firstIndex - secondIndex);

    return indexDistance <= 1 || indexDistance === segmentCount - 1;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
    const firstToSecondStart = crossCoordinates(firstStart, firstEnd, secondStart);
    const firstToSecondEnd = crossCoordinates(firstStart, firstEnd, secondEnd);
    const secondToFirstStart = crossCoordinates(secondStart, secondEnd, firstStart);
    const secondToFirstEnd = crossCoordinates(secondStart, secondEnd, firstEnd);

    if (Math.abs(firstToSecondStart) <= geometryEpsilon
        && isPointOnSegment(secondStart, firstStart, firstEnd)) {
        return true;
    }
    if (Math.abs(firstToSecondEnd) <= geometryEpsilon
        && isPointOnSegment(secondEnd, firstStart, firstEnd)) {
        return true;
    }
    if (Math.abs(secondToFirstStart) <= geometryEpsilon
        && isPointOnSegment(firstStart, secondStart, secondEnd)) {
        return true;
    }
    if (Math.abs(secondToFirstEnd) <= geometryEpsilon
        && isPointOnSegment(firstEnd, secondStart, secondEnd)) {
        return true;
    }

    return (firstToSecondStart > 0) !== (firstToSecondEnd > 0)
        && (secondToFirstStart > 0) !== (secondToFirstEnd > 0);
}

function isPointOnSegment(point, segmentStart, segmentEnd) {
    return point.x >= Math.min(segmentStart.x, segmentEnd.x) - geometryEpsilon
        && point.x <= Math.max(segmentStart.x, segmentEnd.x) + geometryEpsilon
        && point.y >= Math.min(segmentStart.y, segmentEnd.y) - geometryEpsilon
        && point.y <= Math.max(segmentStart.y, segmentEnd.y) + geometryEpsilon;
}

export function isPointInsideOrOnRing(point, ring) {
    if (!isValidPoint(point)) {
        return false;
    }

    const openRing = getOpenRing(ring);

    if (openRing.length < 3) {
        return false;
    }

    for (let index = 0; index < openRing.length; index++) {
        if (getPointSegmentDistanceSquared(
            point,
            openRing[index],
            openRing[(index + 1) % openRing.length]
        ) <= indexedBoundaryMaxDistanceSquared) {
            return true;
        }
    }

    let inside = false;

    for (let index = 0, previousIndex = openRing.length - 1;
        index < openRing.length;
        previousIndex = index++) {
        const current = openRing[index];
        const previous = openRing[previousIndex];
        const crossesY = (current.y > point.y) !== (previous.y > point.y);

        if (!crossesY) {
            continue;
        }

        const intersectionX = (previous.x - current.x) * (point.y - current.y)
            / (previous.y - current.y)
            + current.x;

        if (point.x < intersectionX) {
            inside = !inside;
        }
    }

    return inside;
}

function roundCoordinate(value) {
    return Math.round(value * coordinatePrecision) / coordinatePrecision;
}
