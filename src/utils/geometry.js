const polygonClipping = require("polygon-clipping");
const {
    findClosestRingBoundaryContact,
    findSegmentRingBoundaryContact,
    isPointInPolygonRing
} = require("./polygonSpatialIndex");
const coordinatePrecision = 1000;
const geometryEpsilon = 1e-7;
const redundantPointDistanceTolerance = 0.05;
const redundantPointDistanceToleranceSquared = redundantPointDistanceTolerance * redundantPointDistanceTolerance;

function createCirclePolygon(x, y, radius, segments) {
    const ring = [];

    for (let index = 0; index < segments; index++) {
        const angle = (Math.PI * 2 * index) / segments;

        ring.push([
            x + Math.cos(angle) * radius,
            y + Math.sin(angle) * radius
        ]);
    }

    closeRing(ring);

    return [ring];
}

function createPolygonFromPoints(points) {
    const ring = points
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(point => [point.x, point.y]);

    if (ring.length < 3) {
        return [];
    }

    closeRing(ring);

    return normalizeSimplePolygon([ring]);
}

function createKnownSimplePolygonFromPoints(points) {
    const ring = points
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(point => [point.x, point.y]);

    if (ring.length < 3) {
        return [];
    }

    closeRing(ring);

    return normalizeKnownSimplePolygon([ring]);
}

function unionPolygons(...polygons) {
    const validMultiPolygons = polygons
        .map(polygonToMultiPolygon)
        .filter(hasPolygons);

    if (validMultiPolygons.length === 0) {
        return [];
    }

    try {
        return getLargestSimplePolygon(polygonClipping.union(...validMultiPolygons));
    } catch (_error) {
        return normalizeSimplePolygon(polygons[0]);
    }
}

function subtractPolygon(subject, clipping) {
    return getLargestSimplePolygon(subtractPolygonComponents(subject, clipping));
}

function repairPolygonTopology(polygon) {
    const normalizedPolygon = normalizeKnownSimplePolygon(polygon);

    if (!hasPolygon(normalizedPolygon)) {
        return [];
    }

    try {
        return getLargestSimplePolygon(polygonClipping.union([normalizedPolygon]));
    } catch (_error) {
        return [];
    }
}

function subtractPolygonComponents(subject, clipping) {
    if (!hasPolygon(subject)) {
        return [];
    }

    if (!hasPolygon(clipping)) {
        const normalizedSubject = normalizeSimplePolygon(subject);

        return hasPolygon(normalizedSubject) ? [normalizedSubject] : [];
    }

    try {
        return normalizeMultiPolygon(polygonClipping.difference(
            polygonToMultiPolygon(subject),
            polygonToMultiPolygon(clipping)
        ));
    } catch (_error) {
        const normalizedSubject = normalizeSimplePolygon(subject);

        return hasPolygon(normalizedSubject) ? [normalizedSubject] : [];
    }
}

/**
 * Exact subtraction for polygons whose rings are already known to be simple.
 *
 * Territory state and capture candidates satisfy this invariant before they
 * reach the boolean kernel. They still pass through coordinate rounding and
 * redundant-point removal, but skipping another self-intersection sweep avoids
 * rebuilding and sorting every boundary segment on each capture.
 */
function subtractKnownSimplePolygonComponents(subject, clipping) {
    if (!hasPolygon(subject)) {
        return [];
    }

    if (!hasPolygon(clipping)) {
        return subtractPolygonComponents(subject, clipping);
    }

    try {
        return normalizeKnownSimpleMultiPolygon(polygonClipping.difference(
            knownSimplePolygonToMultiPolygon(subject),
            knownSimplePolygonToMultiPolygon(clipping)
        ));
    } catch (_error) {
        return subtractPolygonComponents(subject, clipping);
    }
}

function calculatePolygonIntersectionArea(first, second) {
    if (!hasPolygon(first) || !hasPolygon(second)) {
        return 0;
    }

    try {
        return normalizeMultiPolygon(polygonClipping.intersection(
            polygonToMultiPolygon(first),
            polygonToMultiPolygon(second)
        )).reduce((sum, polygon) => sum + calculatePolygonArea(polygon), 0);
    } catch (_error) {
        return doPolygonsOverlap(first, second) ? geometryEpsilon : 0;
    }
}

function isPointInPolygon(polygon, x, y) {
    const outerRing = polygon[0];

    return Boolean(outerRing) && isPointInPolygonRing(outerRing, x, y);
}

function isCircleInsidePolygon(polygon, x, y, radius) {
    if (!isPointInPolygon(polygon, x, y)) {
        return false;
    }

    const contact = findClosestPolygonBoundaryContact(polygon, { x, y });

    if (!contact) {
        return false;
    }

    const safeRadius = Math.max(0, radius - geometryEpsilon);

    return contact.distanceSquared >= safeRadius * safeRadius;
}

function getPointPolygonDistance(polygon, point) {
    if (isPointInPolygon(polygon, point.x, point.y)) {
        return 0;
    }

    const contact = findClosestPolygonBoundaryContact(polygon, point);

    return contact ? Math.sqrt(contact.distanceSquared) : Infinity;
}

function calculatePolygonArea(polygon) {
    if (!polygon || !polygon[0]) {
        return 0;
    }

    return Math.abs(calculateRingArea(polygon[0]));
}

function createPolygonMetrics(polygon) {
    const rings = Array.isArray(polygon) ? polygon : [];
    const ring = Array.isArray(rings[0]) ? rings[0] : [];
    const pointCount = rings.reduce((sum, candidateRing) => (
        sum + (Array.isArray(candidateRing) ? candidateRing.length : 0)
    ), 0);
    const isClosed = ring.length > 1 && areCoordinatesEqual(ring[0], ring[ring.length - 1]);
    const boundsPointCount = isClosed ? ring.length - 1 : ring.length;
    let doubleArea = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let index = 0; index < ring.length; index++) {
        const point = ring[index];

        if (index < ring.length - 1) {
            const next = ring[index + 1];

            doubleArea += point[0] * next[1] - next[0] * point[1];
        }

        if (index < boundsPointCount) {
            minX = Math.min(minX, point[0]);
            minY = Math.min(minY, point[1]);
            maxX = Math.max(maxX, point[0]);
            maxY = Math.max(maxY, point[1]);
        }
    }

    return {
        area: Math.abs(doubleArea / 2),
        bounds: Number.isFinite(minX)
            ? { minX, minY, maxX, maxY }
            : null,
        pointCount,
        polygon
    };
}

function calculatePolygonCentroid(polygon) {
    const ring = getOpenRing(polygon[0]);

    if (ring.length === 0) {
        return null;
    }

    let doubleArea = 0;
    let centroidX = 0;
    let centroidY = 0;

    for (let index = 0; index < ring.length; index++) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];
        const cross = current[0] * next[1] - next[0] * current[1];

        doubleArea += cross;
        centroidX += (current[0] + next[0]) * cross;
        centroidY += (current[1] + next[1]) * cross;
    }

    if (Math.abs(doubleArea) <= geometryEpsilon) {
        return calculateAveragePoint(ring);
    }

    return {
        x: centroidX / (3 * doubleArea),
        y: centroidY / (3 * doubleArea)
    };
}

function serializePolygon(polygon) {
    return {
        rings: normalizeSimplePolygon(polygon).map(ring => ring.map(([x, y]) => ({ x, y })))
    };
}

function getPolygonBounds(polygon) {
    const ring = getOpenRing(polygon && polygon[0]);

    if (ring.length === 0) {
        return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const point of ring) {
        minX = Math.min(minX, point[0]);
        minY = Math.min(minY, point[1]);
        maxX = Math.max(maxX, point[0]);
        maxY = Math.max(maxY, point[1]);
    }

    return {
        minX,
        minY,
        maxX,
        maxY
    };
}

function getPolygonPointCount(polygon) {
    return (polygon || []).reduce((sum, ring) => (
        sum + (Array.isArray(ring) ? ring.length : 0)
    ), 0);
}

function doBoundsOverlap(first, second, padding = 0) {
    return first
        && second
        && first.minX <= second.maxX + padding
        && first.maxX >= second.minX - padding
        && first.minY <= second.maxY + padding
        && first.maxY >= second.minY - padding;
}

function doBoundsContainPoint(bounds, x, y, padding = 0) {
    return Boolean(
        bounds
        && Number.isFinite(x)
        && Number.isFinite(y)
        && x >= bounds.minX - padding
        && x <= bounds.maxX + padding
        && y >= bounds.minY - padding
        && y <= bounds.maxY + padding
    );
}

function doBoundsContainBounds(outer, inner, padding = 0) {
    return Boolean(
        outer
        && inner
        && inner.minX >= outer.minX - padding
        && inner.maxX <= outer.maxX + padding
        && inner.minY >= outer.minY - padding
        && inner.maxY <= outer.maxY + padding
    );
}

function doPolygonsOverlap(first, second, firstBounds = null, secondBounds = null) {
    if (!hasPolygon(first) || !hasPolygon(second)) {
        return false;
    }

    const resolvedFirstBounds = firstBounds || getPolygonBounds(first);
    const resolvedSecondBounds = secondBounds || getPolygonBounds(second);

    if (!doBoundsOverlap(resolvedFirstBounds, resolvedSecondBounds)) {
        return false;
    }

    const firstRing = getOpenRing(first[0]);
    const secondRing = getOpenRing(second[0]);

    if (firstRing.some(([x, y]) => (
        doBoundsContainPoint(resolvedSecondBounds, x, y)
        && isPointInPolygon(second, x, y)
    ))) {
        return true;
    }

    if (secondRing.some(([x, y]) => (
        doBoundsContainPoint(resolvedFirstBounds, x, y)
        && isPointInPolygon(first, x, y)
    ))) {
        return true;
    }

    return doPolygonBoundariesIntersect(firstRing, secondRing);
}

function doPolygonsHavePositiveAreaOverlap(first, second, firstBounds = null, secondBounds = null) {
    if (!hasPolygon(first) || !hasPolygon(second)) {
        return false;
    }

    const resolvedFirstBounds = firstBounds || getPolygonBounds(first);
    const resolvedSecondBounds = secondBounds || getPolygonBounds(second);

    if (!doBoundsHavePositiveAreaOverlap(resolvedFirstBounds, resolvedSecondBounds)) {
        return false;
    }

    const firstRing = getOpenRing(first[0]);
    const secondRing = getOpenRing(second[0]);

    if (firstRing.length < 3 || secondRing.length < 3) {
        return false;
    }

    if (doPolygonBoundariesCreateAreaOverlap(firstRing, secondRing)) {
        return true;
    }

    return doesRingHaveStrictInteriorPoint(firstRing, second, resolvedSecondBounds, secondRing)
        || doesRingHaveStrictInteriorPoint(secondRing, first, resolvedFirstBounds, firstRing);
}

function doBoundsHavePositiveAreaOverlap(first, second) {
    return Boolean(
        first
        && second
        && Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX) > geometryEpsilon
        && Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY) > geometryEpsilon
    );
}

function doPolygonBoundariesCreateAreaOverlap(firstRing, secondRing) {
    const firstBlocks = createBoundarySegmentBlocks(firstRing);
    const secondBlocks = createBoundarySegmentBlocks(secondRing);
    const firstOrientation = Math.sign(calculateOpenRingArea(firstRing)) || 1;
    const secondOrientation = Math.sign(calculateOpenRingArea(secondRing)) || 1;

    for (const firstBlock of firstBlocks) {
        for (const secondBlock of secondBlocks) {
            if (!doCoordinateBoundsOverlap(firstBlock.bounds, secondBlock.bounds)) {
                continue;
            }

            for (const firstSegment of firstBlock.segments) {
                for (const secondSegment of secondBlock.segments) {
                    if (!doCoordinateBoundsOverlap(firstSegment.bounds, secondSegment.bounds)) {
                        continue;
                    }

                    if (segmentsProperlyIntersect(
                        firstSegment.start,
                        firstSegment.end,
                        secondSegment.start,
                        secondSegment.end
                    ) || doCollinearSegmentsShareInteriorSide(
                        firstSegment.start,
                        firstSegment.end,
                        firstOrientation,
                        secondSegment.start,
                        secondSegment.end,
                        secondOrientation
                    )) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}

function calculateOpenRingArea(ring) {
    let area = 0;

    for (let index = 0; index < ring.length; index++) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];

        area += current[0] * next[1] - next[0] * current[1];
    }

    return area / 2;
}

function segmentsProperlyIntersect(firstStart, firstEnd, secondStart, secondEnd) {
    const firstToSecondStart = crossCoordinates(firstStart, firstEnd, secondStart);
    const firstToSecondEnd = crossCoordinates(firstStart, firstEnd, secondEnd);
    const secondToFirstStart = crossCoordinates(secondStart, secondEnd, firstStart);
    const secondToFirstEnd = crossCoordinates(secondStart, secondEnd, firstEnd);

    return haveOppositeNonZeroSigns(firstToSecondStart, firstToSecondEnd)
        && haveOppositeNonZeroSigns(secondToFirstStart, secondToFirstEnd);
}

function haveOppositeNonZeroSigns(first, second) {
    return (first > geometryEpsilon && second < -geometryEpsilon)
        || (first < -geometryEpsilon && second > geometryEpsilon);
}

function doCollinearSegmentsShareInteriorSide(
    firstStart,
    firstEnd,
    firstOrientation,
    secondStart,
    secondEnd,
    secondOrientation
) {
    if (!areSegmentsCollinear(firstStart, firstEnd, secondStart, secondEnd)
        || getCollinearSegmentOverlapLength(firstStart, firstEnd, secondStart, secondEnd) <= geometryEpsilon) {
        return false;
    }

    const firstDirectionX = firstEnd[0] - firstStart[0];
    const firstDirectionY = firstEnd[1] - firstStart[1];
    const secondDirectionX = secondEnd[0] - secondStart[0];
    const secondDirectionY = secondEnd[1] - secondStart[1];
    const interiorNormalDot = firstOrientation * secondOrientation * (
        firstDirectionX * secondDirectionX + firstDirectionY * secondDirectionY
    );

    return interiorNormalDot > geometryEpsilon;
}

function areSegmentsCollinear(firstStart, firstEnd, secondStart, secondEnd) {
    return isZero(crossCoordinates(firstStart, firstEnd, secondStart))
        && isZero(crossCoordinates(firstStart, firstEnd, secondEnd));
}

function getCollinearSegmentOverlapLength(firstStart, firstEnd, secondStart, secondEnd) {
    const useXAxis = Math.abs(firstEnd[0] - firstStart[0]) >= Math.abs(firstEnd[1] - firstStart[1]);
    const axis = useXAxis ? 0 : 1;
    const overlapStart = Math.max(
        Math.min(firstStart[axis], firstEnd[axis]),
        Math.min(secondStart[axis], secondEnd[axis])
    );
    const overlapEnd = Math.min(
        Math.max(firstStart[axis], firstEnd[axis]),
        Math.max(secondStart[axis], secondEnd[axis])
    );

    return Math.max(0, overlapEnd - overlapStart);
}

function doesRingHaveStrictInteriorPoint(sourceRing, targetPolygon, targetBounds, targetRing) {
    for (const point of sourceRing) {
        if (doBoundsContainPoint(targetBounds, point[0], point[1])
            && isPointInPolygon(targetPolygon, point[0], point[1])
            && !isCoordinateOnRingBoundary(point, targetRing)) {
            return true;
        }
    }

    return false;
}

function isCoordinateOnRingBoundary(point, ring) {
    for (let index = 0; index < ring.length; index++) {
        const start = ring[index];
        const end = ring[(index + 1) % ring.length];

        if (Math.abs(crossCoordinates(start, end, point)) <= geometryEpsilon
            && isPointOnSegment(point, start, end)) {
            return true;
        }
    }

    return false;
}

function isPolygonInsidePolygon(inner, outer, innerBounds = null, outerBounds = null) {
    if (!hasPolygon(inner) || !hasPolygon(outer)) {
        return false;
    }

    const resolvedInnerBounds = innerBounds || getPolygonBounds(inner);
    const resolvedOuterBounds = outerBounds || getPolygonBounds(outer);

    if (!doBoundsContainBounds(resolvedOuterBounds, resolvedInnerBounds)) {
        return false;
    }

    const innerRing = getOpenRing(inner[0]);
    const outerRing = getOpenRing(outer[0]);

    if (innerRing.length < 3 || outerRing.length < 3) {
        return false;
    }

    if (!innerRing.every(([x, y]) => isPointInPolygon(outer, x, y))) {
        return false;
    }

    return !doPolygonBoundariesIntersect(innerRing, outerRing);
}

function doPolygonBoundariesIntersect(firstRing, secondRing) {
    if (firstRing.length < 3 || secondRing.length < 3) {
        return false;
    }

    const firstBlocks = createBoundarySegmentBlocks(firstRing);
    const secondBlocks = createBoundarySegmentBlocks(secondRing);

    for (const firstBlock of firstBlocks) {
        for (const secondBlock of secondBlocks) {
            if (!doCoordinateBoundsOverlap(firstBlock.bounds, secondBlock.bounds)) {
                continue;
            }

            for (const firstSegment of firstBlock.segments) {
                for (const secondSegment of secondBlock.segments) {
                    if (!doCoordinateBoundsOverlap(firstSegment.bounds, secondSegment.bounds)) {
                        continue;
                    }

                    if (segmentsIntersect(firstSegment.start, firstSegment.end, secondSegment.start, secondSegment.end)) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}

function createBoundarySegmentBlocks(ring) {
    const blockSize = getBoundarySegmentBlockSize(ring.length);
    const blocks = [];
    let currentSegments = [];
    let currentBounds = null;

    for (let index = 0; index < ring.length; index++) {
        const start = ring[index];
        const end = ring[(index + 1) % ring.length];
        const segment = {
            bounds: getCoordinateSegmentBounds(start, end),
            end,
            start
        };

        currentSegments.push(segment);
        currentBounds = mergeCoordinateBounds(currentBounds, segment.bounds);

        if (currentSegments.length >= blockSize) {
            blocks.push({
                bounds: currentBounds,
                segments: currentSegments
            });
            currentSegments = [];
            currentBounds = null;
        }
    }

    if (currentSegments.length > 0) {
        blocks.push({
            bounds: currentBounds,
            segments: currentSegments
        });
    }

    return blocks;
}

function getBoundarySegmentBlockSize(segmentCount) {
    return segmentCount >= 512 ? 32 : 24;
}

function getCoordinateSegmentBounds(first, second) {
    return {
        minX: Math.min(first[0], second[0]),
        minY: Math.min(first[1], second[1]),
        maxX: Math.max(first[0], second[0]),
        maxY: Math.max(first[1], second[1])
    };
}

function mergeCoordinateBounds(first, second) {
    if (!first) {
        return second;
    }

    return {
        minX: Math.min(first.minX, second.minX),
        minY: Math.min(first.minY, second.minY),
        maxX: Math.max(first.maxX, second.maxX),
        maxY: Math.max(first.maxY, second.maxY)
    };
}

function doCoordinateBoundsOverlap(first, second) {
    return first
        && second
        && first.minX <= second.maxX + geometryEpsilon
        && first.maxX >= second.minX - geometryEpsilon
        && first.minY <= second.maxY + geometryEpsilon
        && first.maxY >= second.minY - geometryEpsilon;
}

function findSegmentPolygonBoundaryContact(polygon, startPoint, endPoint) {
    return findSegmentRingBoundaryContact(polygon && polygon[0], startPoint, endPoint);
}

function findClosestPolygonBoundaryContact(polygon, point) {
    return findClosestRingBoundaryContact(polygon && polygon[0], point);
}

function polygonToMultiPolygon(polygon) {
    const normalizedPolygon = normalizeSimplePolygon(polygon);

    return normalizedPolygon.length > 0 ? [normalizedPolygon] : [];
}

function getLargestSimplePolygon(multiPolygon) {
    let largestPolygon = [];
    let largestArea = 0;

    for (const polygon of normalizeMultiPolygon(multiPolygon)) {
        const simplePolygon = normalizeSimplePolygon(polygon);
        const area = calculatePolygonArea(simplePolygon);

        if (area > largestArea) {
            largestArea = area;
            largestPolygon = simplePolygon;
        }
    }

    return largestPolygon;
}

function normalizeMultiPolygon(multiPolygon) {
    if (!Array.isArray(multiPolygon)) {
        return [];
    }

    return multiPolygon
        .map(normalizeSimplePolygon)
        .filter(hasPolygon);
}

function normalizeKnownSimpleMultiPolygon(multiPolygon) {
    if (!Array.isArray(multiPolygon)) {
        return [];
    }

    return multiPolygon
        .map(normalizeKnownSimplePolygon)
        .filter(hasPolygon);
}

function knownSimplePolygonToMultiPolygon(polygon) {
    const normalizedPolygon = normalizeKnownSimplePolygon(polygon);

    return normalizedPolygon.length > 0 ? [normalizedPolygon] : [];
}

function normalizeSimplePolygon(polygon) {
    if (!Array.isArray(polygon)) {
        return [];
    }

    const ring = normalizeRing(polygon[0]);

    if (ring.length < 4) {
        return [];
    }

    return [ring];
}

function normalizeKnownSimplePolygon(polygon) {
    if (!Array.isArray(polygon)) {
        return [];
    }

    const ring = normalizeKnownSimpleRing(polygon[0]);

    if (ring.length < 4) {
        return [];
    }

    return [ring];
}

function normalizeRing(ring) {
    const normalizedRing = normalizeKnownSimpleRing(ring);

    return hasSelfIntersections(normalizedRing) ? [] : normalizedRing;
}

function normalizeKnownSimpleRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    const normalizedRing = ring
        .filter(point => (
            Array.isArray(point)
            && Number.isFinite(point[0])
            && Number.isFinite(point[1])
        ))
        .map(point => [
            roundCoordinate(point[0]),
            roundCoordinate(point[1])
        ]);

    removeConsecutiveDuplicatePoints(normalizedRing);
    removeClosingDuplicatePoint(normalizedRing);
    removeCollinearPoints(normalizedRing);

    if (normalizedRing.length >= 3) {
        closeRing(normalizedRing);
    }

    return normalizedRing;
}

function removeConsecutiveDuplicatePoints(ring) {
    for (let index = ring.length - 1; index > 0; index--) {
        if (areCoordinatesEqual(ring[index], ring[index - 1])) {
            ring.splice(index, 1);
        }
    }
}

function removeClosingDuplicatePoint(ring) {
    if (ring.length > 1 && areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        ring.pop();
    }
}

function removeCollinearPoints(ring) {
    removeCircularRedundantPoints(ring, isCollinear);
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

function closeRing(ring) {
    if (ring.length === 0 || areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        return;
    }

    ring.push([ring[0][0], ring[0][1]]);
}

function getOpenRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    if (ring.length > 1 && areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        return ring.slice(0, -1);
    }

    return ring.slice();
}

function hasSelfIntersections(ring) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 4) {
        return false;
    }

    const segments = createSortedCoordinateRingSegments(openRing);

    for (let firstOrderIndex = 0; firstOrderIndex < segments.length; firstOrderIndex++) {
        const first = segments[firstOrderIndex];

        for (let secondOrderIndex = firstOrderIndex + 1; secondOrderIndex < segments.length; secondOrderIndex++) {
            const second = segments[secondOrderIndex];

            if (second.bounds.minX > first.bounds.maxX + geometryEpsilon) {
                break;
            }

            if (areAdjacentSegments(first.index, second.index, openRing.length)
                || !doCoordinateBoundsOverlap(first.bounds, second.bounds)) {
                continue;
            }

            if (segmentsIntersect(first.start, first.end, second.start, second.end)) {
                return true;
            }
        }
    }

    return false;
}

function createSortedCoordinateRingSegments(openRing) {
    return openRing
        .map((start, index) => {
            const end = openRing[(index + 1) % openRing.length];

            return {
                bounds: getCoordinateSegmentBounds(start, end),
                end,
                index,
                start
            };
        })
        .sort((first, second) => first.bounds.minX - second.bounds.minX);
}

function calculateRingArea(ring) {
    let area = 0;

    for (let index = 0; index < ring.length - 1; index++) {
        const current = ring[index];
        const next = ring[index + 1];

        area += current[0] * next[1] - next[0] * current[1];
    }

    return area / 2;
}

function calculateAveragePoint(ring) {
    const total = ring.reduce((sum, point) => ({
        x: sum.x + point[0],
        y: sum.y + point[1]
    }), { x: 0, y: 0 });

    return {
        x: total.x / ring.length,
        y: total.y / ring.length
    };
}

function areCoordinatesEqual(first, second) {
    return first[0] === second[0] && first[1] === second[1];
}

function roundCoordinate(value) {
    return Math.round(value * coordinatePrecision) / coordinatePrecision;
}

function isCollinear(first, second, third) {
    if (!isCoordinateBetween(first, second, third)) {
        return false;
    }

    const segmentLengthSquared = getCoordinateDistanceSquared(first, third);

    if (segmentLengthSquared <= geometryEpsilon) {
        return getCoordinateDistanceSquared(first, second) <= redundantPointDistanceToleranceSquared;
    }

    const cross = crossCoordinates(first, second, third);
    const distanceSquared = (cross * cross) / segmentLengthSquared;

    return distanceSquared <= redundantPointDistanceToleranceSquared;
}

function crossCoordinates(first, second, third) {
    return (second[0] - first[0]) * (third[1] - first[1])
        - (second[1] - first[1]) * (third[0] - first[0]);
}

function isCoordinateBetween(first, second, third) {
    return (second[0] - first[0]) * (second[0] - third[0])
        + (second[1] - first[1]) * (second[1] - third[1]) <= geometryEpsilon;
}

function getCoordinateDistanceSquared(first, second) {
    const x = first[0] - second[0];
    const y = first[1] - second[1];

    return x * x + y * y;
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

function crossProduct(first, second) {
    return first.x * second.y - first.y * second.x;
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

    if (isZero(firstToSecondStart) && isPointOnSegment(secondStart, firstStart, firstEnd)) {
        return true;
    }

    if (isZero(firstToSecondEnd) && isPointOnSegment(secondEnd, firstStart, firstEnd)) {
        return true;
    }

    if (isZero(secondToFirstStart) && isPointOnSegment(firstStart, secondStart, secondEnd)) {
        return true;
    }

    if (isZero(secondToFirstEnd) && isPointOnSegment(firstEnd, secondStart, secondEnd)) {
        return true;
    }

    return (firstToSecondStart > 0) !== (firstToSecondEnd > 0)
        && (secondToFirstStart > 0) !== (secondToFirstEnd > 0);
}

function isPointOnSegment(point, segmentStart, segmentEnd) {
    return point[0] >= Math.min(segmentStart[0], segmentEnd[0]) - geometryEpsilon
        && point[0] <= Math.max(segmentStart[0], segmentEnd[0]) + geometryEpsilon
        && point[1] >= Math.min(segmentStart[1], segmentEnd[1]) - geometryEpsilon
        && point[1] <= Math.max(segmentStart[1], segmentEnd[1]) + geometryEpsilon;
}

function isZero(value) {
    return Math.abs(value) <= geometryEpsilon;
}

function hasPolygon(polygon) {
    return Array.isArray(polygon) && polygon.length > 0;
}

function hasPolygons(multiPolygon) {
    return Array.isArray(multiPolygon) && multiPolygon.length > 0;
}

module.exports = {
    calculatePolygonIntersectionArea,
    calculatePolygonArea,
    calculatePolygonCentroid,
    createCirclePolygon,
    createKnownSimplePolygonFromPoints,
    createPolygonMetrics,
    createPolygonFromPoints,
    doBoundsContainBounds,
    doBoundsContainPoint,
    doBoundsOverlap,
    doPolygonsHavePositiveAreaOverlap,
    doPolygonsOverlap,
    findClosestPolygonBoundaryContact,
    findSegmentPolygonBoundaryContact,
    getPolygonBounds,
    getPolygonPointCount,
    getPointPolygonDistance,
    isCircleInsidePolygon,
    isPointInPolygon,
    isPolygonInsidePolygon,
    repairPolygonTopology,
    serializePolygon,
    subtractKnownSimplePolygonComponents,
    subtractPolygon,
    subtractPolygonComponents,
    unionPolygons
};
