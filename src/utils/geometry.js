const polygonClipping = require("polygon-clipping");
const coordinatePrecision = 1000;
const geometryEpsilon = 1e-7;

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
    if (!hasPolygon(subject)) {
        return [];
    }

    if (!hasPolygon(clipping)) {
        return normalizeSimplePolygon(subject);
    }

    try {
        return getLargestSimplePolygon(polygonClipping.difference(
            polygonToMultiPolygon(subject),
            polygonToMultiPolygon(clipping)
        ));
    } catch (_error) {
        return normalizeSimplePolygon(subject);
    }
}

function isPointInPolygon(polygon, x, y) {
    const outerRing = polygon[0];

    return Boolean(outerRing) && isPointInRing(outerRing, x, y);
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
    if (!polygon[0]) {
        return 0;
    }

    return Math.abs(calculateRingArea(polygon[0]));
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
    const ring = getOpenRing(polygon[0]);

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

function findSegmentPolygonBoundaryContact(polygon, startPoint, endPoint) {
    const ring = getOpenRing(polygon[0]);
    let closestContact = null;

    for (let segmentIndex = 0; segmentIndex < ring.length; segmentIndex++) {
        const boundaryStart = coordinatesToPoint(ring[segmentIndex]);
        const boundaryEnd = coordinatesToPoint(ring[(segmentIndex + 1) % ring.length]);
        const intersection = getSegmentIntersection(startPoint, endPoint, boundaryStart, boundaryEnd);

        if (!intersection) {
            continue;
        }

        if (!closestContact || intersection.pathT < closestContact.pathT) {
            closestContact = {
                point: intersection.point,
                pathT: intersection.pathT,
                segmentIndex,
                segmentT: intersection.segmentT
            };
        }
    }

    return closestContact;
}

function findClosestPolygonBoundaryContact(polygon, point) {
    const ring = getOpenRing(polygon[0]);
    let closestContact = null;

    for (let segmentIndex = 0; segmentIndex < ring.length; segmentIndex++) {
        const segmentStart = coordinatesToPoint(ring[segmentIndex]);
        const segmentEnd = coordinatesToPoint(ring[(segmentIndex + 1) % ring.length]);
        const projection = projectPointOnSegment(point, segmentStart, segmentEnd);

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
    let index = 0;

    while (ring.length >= 3 && index < ring.length) {
        const previous = ring[(index - 1 + ring.length) % ring.length];
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];

        if (isCollinear(previous, current, next)) {
            ring.splice(index, 1);
            index = Math.max(0, index - 1);
            continue;
        }

        index++;
    }
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
    if (ring.length < 4) {
        return false;
    }

    const openRing = ring.slice(0, -1);

    for (let firstIndex = 0; firstIndex < openRing.length; firstIndex++) {
        const firstStart = openRing[firstIndex];
        const firstEnd = openRing[(firstIndex + 1) % openRing.length];

        for (let secondIndex = firstIndex + 1; secondIndex < openRing.length; secondIndex++) {
            if (areAdjacentSegments(firstIndex, secondIndex, openRing.length)) {
                continue;
            }

            const secondStart = openRing[secondIndex];
            const secondEnd = openRing[(secondIndex + 1) % openRing.length];

            if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
                return true;
            }
        }
    }

    return false;
}

function isPointInRing(ring, x, y) {
    let isInside = false;

    for (let currentIndex = 0, previousIndex = ring.length - 1; currentIndex < ring.length; previousIndex = currentIndex++) {
        const current = ring[currentIndex];
        const previous = ring[previousIndex];
        const crossesHorizontalRay = (current[1] > y) !== (previous[1] > y);

        if (!crossesHorizontalRay) {
            continue;
        }

        const intersectionX = ((previous[0] - current[0]) * (y - current[1])) / (previous[1] - current[1]) + current[0];

        if (x < intersectionX) {
            isInside = !isInside;
        }
    }

    return isInside;
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

function getSegmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
    const firstDirection = subtractPoints(firstEnd, firstStart);
    const secondDirection = subtractPoints(secondEnd, secondStart);
    const denominator = crossProduct(firstDirection, secondDirection);

    if (Math.abs(denominator) <= geometryEpsilon) {
        return null;
    }

    const startDelta = subtractPoints(secondStart, firstStart);
    const pathT = crossProduct(startDelta, secondDirection) / denominator;
    const segmentT = crossProduct(startDelta, firstDirection) / denominator;

    if (!isUnitRange(pathT) || !isUnitRange(segmentT)) {
        return null;
    }

    return {
        point: {
            x: firstStart.x + firstDirection.x * pathT,
            y: firstStart.y + firstDirection.y * pathT
        },
        pathT,
        segmentT
    };
}

function projectPointOnSegment(point, segmentStart, segmentEnd) {
    const direction = subtractPoints(segmentEnd, segmentStart);
    const lengthSquared = direction.x * direction.x + direction.y * direction.y;
    const segmentT = lengthSquared <= geometryEpsilon
        ? 0
        : clampUnitRange(dotProduct(subtractPoints(point, segmentStart), direction) / lengthSquared);
    const projectedPoint = {
        x: segmentStart.x + direction.x * segmentT,
        y: segmentStart.y + direction.y * segmentT
    };
    const distanceX = point.x - projectedPoint.x;
    const distanceY = point.y - projectedPoint.y;

    return {
        point: projectedPoint,
        segmentT,
        distanceSquared: distanceX * distanceX + distanceY * distanceY
    };
}

function areCoordinatesEqual(first, second) {
    return first[0] === second[0] && first[1] === second[1];
}

function roundCoordinate(value) {
    return Math.round(value * coordinatePrecision) / coordinatePrecision;
}

function isCollinear(first, second, third) {
    return Math.abs(crossCoordinates(first, second, third)) <= geometryEpsilon;
}

function crossCoordinates(first, second, third) {
    return (second[0] - first[0]) * (third[1] - first[1])
        - (second[1] - first[1]) * (third[0] - first[0]);
}

function coordinatesToPoint(coordinates) {
    return {
        x: coordinates[0],
        y: coordinates[1]
    };
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

function isUnitRange(value) {
    return value >= -geometryEpsilon && value <= 1 + geometryEpsilon;
}

function clampUnitRange(value) {
    return Math.max(0, Math.min(1, value));
}

function areAdjacentSegments(firstIndex, secondIndex, segmentCount) {
    return Math.abs(firstIndex - secondIndex) <= 1
        || (firstIndex === 0 && secondIndex === segmentCount - 1);
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
    calculatePolygonArea,
    calculatePolygonCentroid,
    createCirclePolygon,
    createKnownSimplePolygonFromPoints,
    createPolygonFromPoints,
    findClosestPolygonBoundaryContact,
    findSegmentPolygonBoundaryContact,
    getPolygonBounds,
    getPointPolygonDistance,
    isCircleInsidePolygon,
    isPointInPolygon,
    serializePolygon,
    subtractPolygon,
    unionPolygons
};
