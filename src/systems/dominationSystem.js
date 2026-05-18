const config = require("../config/gameConfig");
const {
    applyCapturedPolygon,
    getPlayerTerritoryPolygon
} = require("../state/territories");
const {
    calculatePolygonArea,
    createPolygonFromPoints,
    findClosestPolygonBoundaryContact,
    unionPolygons
} = require("../utils/geometry");

const geometryEpsilon = 1e-7;

function captureClosedTrail(player, territories, players) {
    const capturedPolygon = createExternalTrailCapturePolygon(player, territories);

    if (!capturedPolygon) {
        return null;
    }

    applyCapturedPolygon(territories, player.id, capturedPolygon, players);

    return capturedPolygon;
}

function createExternalTrailCapturePolygon(player, territories) {
    if (!hasAnySideTrailSegment(player)) {
        return null;
    }

    const currentTerritory = getPlayerTerritoryPolygon(territories, player.id);
    const candidates = createTrailCaptureCandidates(player, currentTerritory);
    const bestCandidate = selectBestCaptureCandidate(
        currentTerritory,
        candidates,
        config.territory.minCaptureArea
    );

    if (!bestCandidate) {
        return null;
    }

    return bestCandidate.polygon;
}

function selectBestCaptureCandidate(currentTerritory, candidates, minAddedArea) {
    const currentArea = calculatePolygonArea(currentTerritory);
    let bestCandidate = null;

    for (const candidate of candidates) {
        const rankedCandidate = rankCaptureCandidate(currentTerritory, currentArea, candidate);

        if (rankedCandidate.addedArea < minAddedArea) {
            continue;
        }

        if (!bestCandidate || isBetterCaptureCandidate(rankedCandidate, bestCandidate)) {
            bestCandidate = rankedCandidate;
        }
    }

    return bestCandidate;
}

function rankCaptureCandidate(currentTerritory, currentArea, candidate) {
    const union = unionPolygons(currentTerritory, candidate.polygon);
    const candidateArea = calculatePolygonArea(candidate.polygon);
    const addedArea = calculatePolygonArea(union) - currentArea;
    const overlapArea = Math.max(0, candidateArea - addedArea);

    return {
        ...candidate,
        addedArea,
        overlapArea,
        hasLowOverlap: hasLowTerritoryOverlap(candidateArea, overlapArea)
    };
}

function hasLowTerritoryOverlap(candidateArea, overlapArea) {
    if (candidateArea <= Number.EPSILON) {
        return false;
    }

    return overlapArea <= Math.max(1, candidateArea * 0.02);
}

function isBetterCaptureCandidate(candidate, bestCandidate) {
    if (candidate.hasLowOverlap !== bestCandidate.hasLowOverlap) {
        return candidate.hasLowOverlap;
    }

    if (Math.abs(candidate.addedArea - bestCandidate.addedArea) > geometryEpsilon) {
        return candidate.addedArea > bestCandidate.addedArea;
    }

    return candidate.overlapArea < bestCandidate.overlapArea;
}

function createTrailCaptureCandidates(player, territoryPolygon) {
    const candidates = [];

    for (const segment of getTrailSegments(player)) {
        candidates.push(...createTrailCaptureCandidatesFromSegment(segment, territoryPolygon));
    }

    return candidates;
}

function createTrailCaptureCandidatesFromSegment(segment, territoryPolygon) {
    const candidates = [];
    const finiteSidePoints = getFinitePoints(segment);

    if (finiteSidePoints.length < 2) {
        return candidates;
    }

    const startContact = findClosestPolygonBoundaryContact(territoryPolygon, finiteSidePoints[0]);
    const endContact = findClosestPolygonBoundaryContact(territoryPolygon, finiteSidePoints[finiteSidePoints.length - 1]);

    if (!startContact || !endContact) {
        return candidates;
    }

    const clippedSidePoints = createBorderSnappedSidePoints(
        finiteSidePoints,
        startContact.point,
        endContact.point
    );
    const boundaryPaths = createBoundaryPaths(territoryPolygon[0], endContact, startContact);
    let bestCandidate = null;

    for (const boundaryPath of boundaryPaths) {
        const points = createTrailBoundaryCapturePoints(clippedSidePoints, boundaryPath);
        const candidate = createTrailCandidateFromPoints(points);

        if (candidate && isLargerAreaCandidate(candidate, bestCandidate)) {
            bestCandidate = candidate;
        }
    }

    if (bestCandidate) {
        candidates.push(bestCandidate);
    }

    return candidates;
}

function getTrailSegments(player) {
    return [
        ...getVisibleSegments(player.trailLeftSegments),
        ...getVisibleSegments(player.trailRightSegments)
    ];
}

function hasAnySideTrailSegment(player) {
    return getVisibleSegments(player.trailLeftSegments).length > 0
        || getVisibleSegments(player.trailRightSegments).length > 0;
}

function getVisibleSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments.filter(segment => Array.isArray(segment) && segment.length >= 2);
}

function createTrailBoundaryCapturePoints(sidePoints, boundaryPath) {
    const finiteSidePoints = getFinitePoints(sidePoints);

    if (finiteSidePoints.length < 2 || boundaryPath.length < 2) {
        return [];
    }

    const lastSidePoint = finiteSidePoints[finiteSidePoints.length - 1];
    const boundaryPoints = arePointsEqual(lastSidePoint, boundaryPath[0])
        ? boundaryPath.slice(1)
        : boundaryPath;
    const points = finiteSidePoints.concat(boundaryPoints);

    return removeConsecutiveDuplicatePoints(points);
}

function createTrailCandidateFromPoints(points) {
    if (points.length < config.territory.minCaptureTrailPoints) {
        return null;
    }

    const polygon = createPolygonFromPoints(points);

    const area = calculatePolygonArea(polygon);

    if (area <= 0) {
        return null;
    }

    return { polygon, area };
}

function createBoundaryPaths(ring, startContact, endContact) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 3) {
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
        path.push(coordinatesToPoint(openRing[vertexIndex]));

        if (vertexIndex === endContact.segmentIndex) {
            break;
        }

        vertexIndex = (vertexIndex + 1) % openRing.length;
        guard++;
    }

    path.push(endContact.point);

    return path;
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

function getFinitePoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(point => ({
            x: point.x,
            y: point.y
        }));
}

function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
}

function createBorderSnappedSidePoints(sidePoints, startPoint, endPoint) {
    return removeConsecutiveDuplicatePoints([
        startPoint,
        ...sidePoints.slice(1, -1),
        endPoint
    ]);
}

function isLargerAreaCandidate(candidate, bestCandidate) {
    return !bestCandidate || candidate.area > bestCandidate.area + geometryEpsilon;
}

function coordinatesToPoint(coordinates) {
    return {
        x: coordinates[0],
        y: coordinates[1]
    };
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

function areCoordinatesEqual(first, second) {
    return first[0] === second[0] && first[1] === second[1];
}

module.exports = {
    captureClosedTrail,
    createExternalTrailCapturePolygon
};
