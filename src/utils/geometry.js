const polygonClipping = require("polygon-clipping");

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

function unionPolygons(...polygons) {
    const validMultiPolygons = polygons
        .map(polygonToMultiPolygon)
        .filter(hasPolygons);

    if (validMultiPolygons.length === 0) {
        return [];
    }

    return getLargestSimplePolygon(polygonClipping.union(...validMultiPolygons));
}

function subtractPolygon(subject, clipping) {
    if (!hasPolygon(subject)) {
        return [];
    }

    if (!hasPolygon(clipping)) {
        return normalizeSimplePolygon(subject);
    }

    return getLargestSimplePolygon(polygonClipping.difference(
        polygonToMultiPolygon(subject),
        polygonToMultiPolygon(clipping)
    ));
}

function isPointInPolygon(polygon, x, y) {
    const outerRing = polygon[0];

    return Boolean(outerRing) && isPointInRing(outerRing, x, y);
}

function calculatePolygonArea(polygon) {
    if (!polygon[0]) {
        return 0;
    }

    return Math.abs(calculateRingArea(polygon[0]));
}

function serializePolygon(polygon) {
    return {
        rings: normalizeSimplePolygon(polygon).map(ring => ring.map(([x, y]) => ({ x, y })))
    };
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

function normalizeRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    const normalizedRing = ring
        .filter(point => (
            Array.isArray(point)
            && Number.isFinite(point[0])
            && Number.isFinite(point[1])
        ))
        .map(point => [point[0], point[1]]);

    removeConsecutiveDuplicatePoints(normalizedRing);

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

function closeRing(ring) {
    if (ring.length === 0 || areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        return;
    }

    ring.push([ring[0][0], ring[0][1]]);
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

function areCoordinatesEqual(first, second) {
    return first[0] === second[0] && first[1] === second[1];
}

function hasPolygon(polygon) {
    return Array.isArray(polygon) && polygon.length > 0;
}

function hasPolygons(multiPolygon) {
    return Array.isArray(multiPolygon) && multiPolygon.length > 0;
}

module.exports = {
    calculatePolygonArea,
    createCirclePolygon,
    createPolygonFromPoints,
    isPointInPolygon,
    serializePolygon,
    subtractPolygon,
    unionPolygons
};
