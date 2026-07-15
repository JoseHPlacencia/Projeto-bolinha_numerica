const {
    calculatePolygonArea,
    createPolygonFromPoints,
    repairPolygonTopology
} = require("../utils/geometry");

const geometryEpsilon = 1e-7;

/**
 * Removes local out-and-back branches whose enclosed area is negligible.
 *
 * Boolean operations can leave a path that travels far from the boundary and
 * returns almost over the same line. It is still one connected component, so
 * component-area filters cannot discard it. Limiting the inspected point span
 * keeps this pass linear for a fixed configuration and avoids treating a thin
 * corridor connected to a meaningful region as a spike.
 */
function removeDegenerateTerritorySpikes(polygon, options = {}) {
    if (!Array.isArray(polygon) || polygon.length !== 1 || !Array.isArray(polygon[0])) {
        return polygon;
    }

    const maxArea = getPositiveOption(options.maxArea, 4);
    const maxEffectiveWidth = getPositiveOption(options.maxEffectiveWidth, 1.25);
    const maxMouthWidth = getPositiveOption(options.maxMouthWidth, 15);
    const minDepth = getPositiveOption(options.minDepth, 4);
    const maxPointSpan = Math.max(2, Math.floor(getPositiveOption(options.maxPointSpan, 8)));
    const originalRing = getOpenFiniteRing(polygon[0]);

    if (originalRing.length < 4) {
        return polygon;
    }

    let currentPolygon = polygon;
    let ring = originalRing;
    let changed = false;

    while (ring.length >= 4) {
        const spikes = findDegenerateSpikes(ring, {
            maxArea,
            maxEffectiveWidth,
            maxMouthWidth,
            maxPointSpan,
            minDepth
        });
        let cleanedStep = null;

        for (const spike of spikes) {
            cleanedStep = createCleanedSpikeStep(
                currentPolygon,
                ring,
                spike,
                spike.maximumRemovableArea
            );

            if (cleanedStep) {
                break;
            }
        }

        if (!cleanedStep) {
            break;
        }

        currentPolygon = cleanedStep;
        ring = getOpenFiniteRing(cleanedStep[0]);
        changed = true;
    }

    return changed ? currentPolygon : polygon;
}

function createCleanedSpikeStep(currentPolygon, ring, spike, maximumRemovableArea) {
    const removalSets = [
        spike.interiorIndexes,
        [...spike.interiorIndexes, spike.startIndex],
        [...spike.interiorIndexes, spike.endIndex]
    ];
    const currentArea = calculatePolygonArea(currentPolygon);
    let best = null;

    for (const indexes of removalSets) {
        const removedIndexes = new Set(indexes);
        const nextRing = ring.filter((_point, index) => !removedIndexes.has(index));

        if (nextRing.length < 3 || nextRing.length === ring.length) {
            continue;
        }

        const points = nextRing.map(point => ({
            x: point[0],
            y: point[1]
        }));
        let candidate = createPolygonFromPoints(points);

        if (candidate.length === 0) {
            candidate = repairPolygonTopology([nextRing]);
        }

        if (candidate.length === 0) {
            continue;
        }

        const areaDelta = Math.abs(currentArea - calculatePolygonArea(candidate));

        if (areaDelta > maximumRemovableArea + geometryEpsilon) {
            continue;
        }

        if (!best || areaDelta < best.areaDelta) {
            best = { areaDelta, candidate };
        }
    }

    return best && best.candidate;
}

function findDegenerateSpikes(ring, options) {
    const pointCount = ring.length;
    const maximumSpan = Math.min(options.maxPointSpan, Math.floor(pointCount / 2));
    const maximumMouthDistanceSquared = options.maxMouthWidth * options.maxMouthWidth;
    const candidates = [];

    for (let startIndex = 0; startIndex < pointCount; startIndex++) {
        for (let span = 2; span <= maximumSpan; span++) {
            const endIndex = (startIndex + span) % pointCount;
            const start = ring[startIndex];
            const end = ring[endIndex];

            if (getDistanceSquared(start, end) > maximumMouthDistanceSquared) {
                continue;
            }

            const pointIndexes = createCircularIndexRange(startIndex, span, pointCount);
            const branchPoints = pointIndexes.map(index => ring[index]);
            const depth = getMaximumDistanceFromMouth(branchPoints);

            if (depth < options.minDepth) {
                continue;
            }

            const area = calculateClosedPathArea(branchPoints);
            const maximumRemovableArea = Math.max(
                options.maxArea,
                depth * options.maxEffectiveWidth / 2
            );

            if (area > maximumRemovableArea + geometryEpsilon) {
                continue;
            }

            candidates.push({
                area,
                depth,
                endIndex,
                interiorIndexes: pointIndexes.slice(1, -1),
                maximumRemovableArea,
                startIndex
            });
        }
    }

    return candidates.sort((first, second) => (
        second.depth - first.depth || first.area - second.area
    ));
}

function createCircularIndexRange(startIndex, span, pointCount) {
    return Array.from({ length: span + 1 }, (_value, offset) => (
        (startIndex + offset) % pointCount
    ));
}

function calculateClosedPathArea(points) {
    let doubleArea = 0;

    for (let index = 0; index < points.length; index++) {
        const next = points[(index + 1) % points.length];

        doubleArea += points[index][0] * next[1] - next[0] * points[index][1];
    }

    return Math.abs(doubleArea / 2);
}

function getMaximumDistanceFromMouth(points) {
    const start = points[0];
    const end = points[points.length - 1];
    const mouthLengthSquared = getDistanceSquared(start, end);
    let maximumDistanceSquared = 0;

    for (const point of points) {
        maximumDistanceSquared = Math.max(
            maximumDistanceSquared,
            getPointSegmentDistanceSquared(point, start, end, mouthLengthSquared)
        );
    }

    return Math.sqrt(maximumDistanceSquared);
}

function getPointSegmentDistanceSquared(point, start, end, segmentLengthSquared) {
    if (segmentLengthSquared <= geometryEpsilon) {
        return getDistanceSquared(point, start);
    }

    const projection = Math.max(0, Math.min(1, (
        (point[0] - start[0]) * (end[0] - start[0])
        + (point[1] - start[1]) * (end[1] - start[1])
    ) / segmentLengthSquared));
    const projectedPoint = [
        start[0] + (end[0] - start[0]) * projection,
        start[1] + (end[1] - start[1]) * projection
    ];

    return getDistanceSquared(point, projectedPoint);
}

function getOpenFiniteRing(ring) {
    const points = ring
        .filter(point => (
            Array.isArray(point)
            && Number.isFinite(point[0])
            && Number.isFinite(point[1])
        ))
        .map(point => [point[0], point[1]]);
    const lastIndex = points.length - 1;

    if (lastIndex > 0 && arePointsEqual(points[0], points[lastIndex])) {
        points.pop();
    }

    return points;
}

function getDistanceSquared(first, second) {
    const deltaX = first[0] - second[0];
    const deltaY = first[1] - second[1];

    return deltaX * deltaX + deltaY * deltaY;
}

function arePointsEqual(first, second) {
    return first[0] === second[0] && first[1] === second[1];
}

function getPositiveOption(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

module.exports = {
    removeDegenerateTerritorySpikes
};
