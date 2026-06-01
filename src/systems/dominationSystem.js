const config = require("../config/gameConfig");
const {
    applyCapturedPolygon,
    getPlayerTerritoryPolygon
} = require("../state/territories");
const {
    calculatePolygonArea,
<<<<<<< HEAD
    createPolygonFromPoints,
    findClosestPolygonBoundaryContact,
    unionPolygons,
    isPointInPolygon
} = require("../utils/geometry");
const { relocatePlayersAfterTerritoryChange } = require("./territoryRespawnSystem");
const numberSystem = require("./numberSystem");
=======
    createKnownSimplePolygonFromPoints,
    findClosestPolygonBoundaryContact
} = require("../utils/geometry");
const { relocatePlayersAfterTerritoryChange } = require("./territoryRespawnSystem");
>>>>>>> 70aca42 (teste)

const geometryEpsilon = 1e-7;

function captureClosedTrail(player, territories, players) {
<<<<<<< HEAD
    const capturedPolygon = createExternalTrailCapturePolygon(player, territories);

    if (!capturedPolygon) {
        return null;
    }

    const changedPlayerIds = applyCapturedPolygon(territories, player.id, capturedPolygon);

    relocatePlayersAfterTerritoryChange(players, territories, changedPlayerIds);

    // ── Captura de números dentro do polígono fechado ──
    const idsCapturados = [];
    for (const num of numberSystem.getNumeros().values()) {
        if (isPointInPolygon(capturedPolygon, num.x, num.y)) {
            idsCapturados.push(num.id);
        }
    }
    if (idsCapturados.length > 0) {
        const resultados = numberSystem.processarCaptura(idsCapturados);
        if (!player.capturas) player.capturas = [];
        for (const r of resultados) {
            player.capturas.push(r);
        }
    }

    return capturedPolygon;
}

function createExternalTrailCapturePolygon(player, territories) {
=======
    const capture = createExternalTrailCapture(player, territories);

    if (!capture) {
        return null;
    }

    const territory = territories.get(player.id);
    const baseVersion = territory ? territory.version || 0 : 0;
    const changedPlayerIds = applyCapturedPolygon(territories, player.id, capture.polygon, {
        ownerPolygon: capture.operation && capture.operation.previewPolygon
    });

    storeCaptureOperation(territories, player.id, capture, baseVersion, changedPlayerIds);

    const relocationPlayerIds = new Set(changedPlayerIds);
    relocationPlayerIds.delete(player.id);

    relocatePlayersAfterTerritoryChange(players, territories, relocationPlayerIds);

    return capture.polygon;
}

function createExternalTrailCapturePolygon(player, territories) {
    const capture = createExternalTrailCapture(player, territories);

    return capture ? capture.polygon : null;
}

function createExternalTrailCapture(player, territories) {
>>>>>>> 70aca42 (teste)
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

<<<<<<< HEAD
    return bestCandidate.polygon;
=======
    return bestCandidate;
>>>>>>> 70aca42 (teste)
}

function selectBestCaptureCandidate(currentTerritory, candidates, minAddedArea) {
    const currentArea = calculatePolygonArea(currentTerritory);
    let bestCandidate = null;

    for (const candidate of candidates) {
<<<<<<< HEAD
        const rankedCandidate = rankCaptureCandidate(currentTerritory, currentArea, candidate);
=======
        const rankedCandidate = rankCaptureCandidate(currentArea, candidate);
>>>>>>> 70aca42 (teste)

        if (rankedCandidate.addedArea < minAddedArea) {
            continue;
        }

        if (!bestCandidate || isBetterCaptureCandidate(rankedCandidate, bestCandidate)) {
            bestCandidate = rankedCandidate;
        }
    }

    return bestCandidate;
}

<<<<<<< HEAD
function rankCaptureCandidate(currentTerritory, currentArea, candidate) {
    const union = unionPolygons(currentTerritory, candidate.polygon);
    const candidateArea = calculatePolygonArea(candidate.polygon);
    const addedArea = calculatePolygonArea(union) - currentArea;
    const overlapArea = Math.max(0, candidateArea - addedArea);
=======
function rankCaptureCandidate(currentArea, candidate) {
    const addedArea = candidate.area - currentArea;
>>>>>>> 70aca42 (teste)

    return {
        ...candidate,
        addedArea,
<<<<<<< HEAD
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

=======
        overlapArea: currentArea
    };
}

function isBetterCaptureCandidate(candidate, bestCandidate) {
>>>>>>> 70aca42 (teste)
    if (Math.abs(candidate.addedArea - bestCandidate.addedArea) > geometryEpsilon) {
        return candidate.addedArea > bestCandidate.addedArea;
    }

    return candidate.overlapArea < bestCandidate.overlapArea;
}

function createTrailCaptureCandidates(player, territoryPolygon) {
    const candidates = [];

<<<<<<< HEAD
    for (const segment of getTrailSegments(player)) {
        candidates.push(...createTrailCaptureCandidatesFromSegment(segment, territoryPolygon));
=======
    for (const trail of getTrailSegments(player)) {
        candidates.push(...createTrailCaptureCandidatesFromSegment(trail, territoryPolygon));
>>>>>>> 70aca42 (teste)
    }

    return candidates;
}

<<<<<<< HEAD
function createTrailCaptureCandidatesFromSegment(segment, territoryPolygon) {
    const candidates = [];
    const finiteSidePoints = getFinitePoints(segment);
=======
function createTrailCaptureCandidatesFromSegment(trail, territoryPolygon) {
    const candidates = [];
    const finiteSidePoints = getFinitePoints(trail.points);
>>>>>>> 70aca42 (teste)

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

<<<<<<< HEAD
    for (const boundaryPath of boundaryPaths) {
=======
    for (let boundaryPathIndex = 0; boundaryPathIndex < boundaryPaths.length; boundaryPathIndex++) {
        const boundaryPath = boundaryPaths[boundaryPathIndex];
>>>>>>> 70aca42 (teste)
        const points = createTrailBoundaryCapturePoints(clippedSidePoints, boundaryPath);
        const candidate = createTrailCandidateFromPoints(points);

        if (candidate && isLargerAreaCandidate(candidate, bestCandidate)) {
<<<<<<< HEAD
            bestCandidate = candidate;
=======
            bestCandidate = {
                ...candidate,
                operation: createCaptureOperation(
                    trail,
                    clippedSidePoints,
                    startContact,
                    endContact,
                    boundaryPaths,
                    boundaryPathIndex,
                    candidate.polygon
                )
            };
>>>>>>> 70aca42 (teste)
        }
    }

    if (bestCandidate) {
        candidates.push(bestCandidate);
    }

    return candidates;
}

function getTrailSegments(player) {
    return [
<<<<<<< HEAD
        ...getVisibleSegments(player.trailLeftSegments),
        ...getVisibleSegments(player.trailRightSegments)
=======
        ...getVisibleSegments(player.trailLeftSegments).map((points, index) => ({
            side: "left",
            index,
            points
        })),
        ...getVisibleSegments(player.trailRightSegments).map((points, index) => ({
            side: "right",
            index,
            points
        }))
>>>>>>> 70aca42 (teste)
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

<<<<<<< HEAD
    const polygon = createPolygonFromPoints(points);

=======
    const polygon = createKnownSimplePolygonFromPoints(points);
>>>>>>> 70aca42 (teste)
    const area = calculatePolygonArea(polygon);

    if (area <= 0) {
        return null;
    }

    return { polygon, area };
}

<<<<<<< HEAD
=======
function createCaptureOperation(
    trail,
    clippedSidePoints,
    startContact,
    endContact,
    boundaryPaths,
    capturedBoundaryPathIndex,
    previewPolygon
) {
    const keepBoundaryPath = boundaryPaths[capturedBoundaryPathIndex];

    if (!keepBoundaryPath || keepBoundaryPath.length < 2 || getPolygonPointCount(previewPolygon) < 4) {
        return null;
    }

    return {
        type: "trailCapture",
        trailSide: trail.side,
        trailSegmentIndex: trail.index,
        trailSegmentLength: trail.points.length,
        trailPoints: clippedSidePoints.map(clonePoint),
        boundaryPathIndex: capturedBoundaryPathIndex,
        startContact: cloneContact(startContact),
        endContact: cloneContact(endContact),
        keepAnchor: createBoundaryPathAnchor(keepBoundaryPath),
        boundaryPathPointCount: keepBoundaryPath.length,
        previewPolygon
    };
}

function storeCaptureOperation(territories, playerId, capture, baseVersion, changedPlayerIds) {
    if (!changedPlayerIds.has(playerId) || !capture.operation) {
        return;
    }

    const territory = territories.get(playerId);

    if (!territory) {
        return;
    }

    const nextVersion = territory.version || 0;

    if (capture.operation.previewPolygon.length === 0) {
        return;
    }

    if (!arePolygonAreasClose(capture.operation.previewPolygon, territory.polygon)) {
        return;
    }

    territory.lastCaptureOperation = {
        type: "trailCapture",
        baseVersion,
        version: nextVersion,
        trailSide: capture.operation.trailSide,
        trailSegmentIndex: capture.operation.trailSegmentIndex,
        trailSegmentLength: capture.operation.trailSegmentLength,
        trailPoints: capture.operation.trailPoints,
        boundaryPathIndex: capture.operation.boundaryPathIndex,
        startContact: capture.operation.startContact,
        endContact: capture.operation.endContact,
        keepAnchor: capture.operation.keepAnchor
    };
}

function getPolygonPointCount(polygon) {
    return (polygon || []).reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0);
}

function createBoundaryPathAnchor(path) {
    if (path.length > 2) {
        return clonePoint(path[1]);
    }

    return {
        x: (path[0].x + path[path.length - 1].x) / 2,
        y: (path[0].y + path[path.length - 1].y) / 2
    };
}

function cloneContact(contact) {
    return {
        point: clonePoint(contact.point),
        segmentIndex: contact.segmentIndex,
        segmentT: contact.segmentT
    };
}

function arePolygonAreasClose(first, second) {
    const firstArea = calculatePolygonArea(first);
    const secondArea = calculatePolygonArea(second);

    return Math.abs(firstArea - secondArea) <= Math.max(1, secondArea * 0.001);
}

>>>>>>> 70aca42 (teste)
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

<<<<<<< HEAD
=======
function clonePoint(point) {
    return {
        x: point.x,
        y: point.y
    };
}

>>>>>>> 70aca42 (teste)
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
