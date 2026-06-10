const config = require("../config/gameConfig");
const {
    applyCapturedPolygon,
    getPlayerTerritoryPolygon
} = require("../state/territories");
const {
    calculatePolygonArea,
    createKnownSimplePolygonFromPoints,
    findClosestPolygonBoundaryContact,
    isPointInPolygon
} = require("../utils/geometry");
const {
    endPlayerGame,
    handlePlayerLifeLoss,
    handlePlayerVictory
} = require("./catchModeSystem");
const { relocatePlayersAfterTerritoryChange } = require("./territoryRespawnSystem");

const geometryEpsilon = 1e-7;

function captureClosedTrail(player, territories, players, context = {}) {
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
    damagePlayersInsideCapturedPolygon(players, territories, player, capture.polygon, context);

    const relocationPlayerIds = new Set(changedPlayerIds);
    relocationPlayerIds.delete(player.id);

    const noRespawnPlayerIds = relocatePlayersAfterTerritoryChange(players, territories, relocationPlayerIds);
    endPlayersWithoutRespawn(players, territories, noRespawnPlayerIds, player, context);
    maybeEndGameWithVictory(players, territories, player, context);

    return capture.polygon;
}

function damagePlayersInsideCapturedPolygon(players, territories, attacker, capturedPolygon, context) {
    for (const target of [...players.values()]) {
        if (!target || target.id === attacker.id) {
            continue;
        }

        if (!isPointInPolygon(capturedPolygon, target.x, target.y)
            && !doesTrailTouchCapturedPolygon(target, capturedPolygon)) {
            continue;
        }

        handlePlayerLifeLoss(players, territories, target, context, {
            attacker,
            reason: "captured"
        });
    }
}

function doesTrailTouchCapturedPolygon(player, capturedPolygon) {
    return doSegmentsTouchPolygon(player.trailLeftSegments, capturedPolygon)
        || doSegmentsTouchPolygon(player.trailRightSegments, capturedPolygon);
}

function doSegmentsTouchPolygon(segments, polygon) {
    if (!Array.isArray(segments) || !polygon || !polygon[0]) {
        return false;
    }

    for (const segment of segments) {
        if (!Array.isArray(segment) || segment.length === 0) {
            continue;
        }

        if (segment.some(point => isPointInPolygon(polygon, point.x, point.y))) {
            return true;
        }

        for (let index = 0; index < segment.length - 1; index++) {
            if (doesSegmentCrossPolygon(segment[index], segment[index + 1], polygon)) {
                return true;
            }
        }
    }

    return false;
}

function doesSegmentCrossPolygon(startPoint, endPoint, polygon) {
    const ring = polygon[0] || [];

    for (let index = 0; index < ring.length - 1; index++) {
        const boundaryStart = coordinatesToPoint(ring[index]);
        const boundaryEnd = coordinatesToPoint(ring[index + 1]);

        if (segmentsIntersect(startPoint, endPoint, boundaryStart, boundaryEnd)) {
            return true;
        }
    }

    return false;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
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

    return firstT >= -geometryEpsilon
        && firstT <= 1 + geometryEpsilon
        && secondT >= -geometryEpsilon
        && secondT <= 1 + geometryEpsilon;
}

function doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(Math.min(firstStart.x, firstEnd.x), Math.min(secondStart.x, secondEnd.x))
        <= Math.min(Math.max(firstStart.x, firstEnd.x), Math.max(secondStart.x, secondEnd.x)) + geometryEpsilon
        && Math.max(Math.min(firstStart.y, firstEnd.y), Math.min(secondStart.y, secondEnd.y))
        <= Math.min(Math.max(firstStart.y, firstEnd.y), Math.max(secondStart.y, secondEnd.y)) + geometryEpsilon;
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

function crossProduct(first, second) {
    return first.x * second.y - first.y * second.x;
}

function endPlayersWithoutRespawn(players, territories, playerIds, attacker, context) {
    for (const playerId of playerIds || []) {
        const target = players.get(playerId);

        if (!target || target.id === attacker.id) {
            continue;
        }

        endPlayerGame(players, territories, target, context, {
            attacker,
            reason: "noRespawnSpace"
        });
    }
}

function maybeEndGameWithVictory(players, territories, player, context) {
    if (!player || !players.has(player.id) || !hasPlayerDominatedMap(territories, player)) {
        return false;
    }

    return handlePlayerVictory(players, territories, player, context);
}

function hasPlayerDominatedMap(territories, player) {
    const territory = territories.get(player.id);
    const runtimeConfig = player.runtimeConfig;
    const worldConfig = runtimeConfig && runtimeConfig.world ? runtimeConfig.world : config.world;
    const totalMapArea = Math.PI * worldConfig.mapRadius * worldConfig.mapRadius;
    const victoryRatio = Number.isFinite(config.territory.victoryAreaRatio)
        ? config.territory.victoryAreaRatio
        : 1;

    return territory
        && totalMapArea > 0
        && calculatePolygonArea(territory.polygon) >= totalMapArea * victoryRatio;
}

function createExternalTrailCapturePolygon(player, territories) {
    const capture = createExternalTrailCapture(player, territories);

    return capture ? capture.polygon : null;
}

function createExternalTrailCapture(player, territories) {
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

    return bestCandidate;
}

function selectBestCaptureCandidate(currentTerritory, candidates, minAddedArea) {
    const currentArea = calculatePolygonArea(currentTerritory);
    let bestCandidate = null;

    for (const candidate of candidates) {
        const rankedCandidate = rankCaptureCandidate(currentArea, candidate);

        if (rankedCandidate.addedArea < minAddedArea) {
            continue;
        }

        if (!bestCandidate || isBetterCaptureCandidate(rankedCandidate, bestCandidate)) {
            bestCandidate = rankedCandidate;
        }
    }

    return bestCandidate;
}

function rankCaptureCandidate(currentArea, candidate) {
    const addedArea = candidate.area - currentArea;

    return {
        ...candidate,
        addedArea,
        overlapArea: currentArea
    };
}

function isBetterCaptureCandidate(candidate, bestCandidate) {
    if (Math.abs(candidate.addedArea - bestCandidate.addedArea) > geometryEpsilon) {
        return candidate.addedArea > bestCandidate.addedArea;
    }

    return candidate.overlapArea < bestCandidate.overlapArea;
}

function createTrailCaptureCandidates(player, territoryPolygon) {
    const candidates = [];

    for (const trail of getTrailSegments(player)) {
        candidates.push(...createTrailCaptureCandidatesFromSegment(trail, territoryPolygon));
    }

    return candidates;
}

function createTrailCaptureCandidatesFromSegment(trail, territoryPolygon) {
    const candidates = [];
    const finiteSidePoints = getFinitePoints(trail.points);

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

    for (let boundaryPathIndex = 0; boundaryPathIndex < boundaryPaths.length; boundaryPathIndex++) {
        const boundaryPath = boundaryPaths[boundaryPathIndex];
        const points = createTrailBoundaryCapturePoints(clippedSidePoints, boundaryPath);
        const candidate = createTrailCandidateFromPoints(points);

        if (candidate && isLargerAreaCandidate(candidate, bestCandidate)) {
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
        }
    }

    if (bestCandidate) {
        candidates.push(bestCandidate);
    }

    return candidates;
}

function getTrailSegments(player) {
    return [
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

    const polygon = createKnownSimplePolygonFromPoints(points);
    const area = calculatePolygonArea(polygon);

    if (area <= 0) {
        return null;
    }

    return { polygon, area };
}

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

function clonePoint(point) {
    return {
        x: point.x,
        y: point.y
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
