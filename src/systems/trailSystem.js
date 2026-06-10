const config = require("../config/gameConfig");
const { getPlayerTerritoryPolygon } = require("../state/territories");
const {
    calculatePolygonArea,
    createPolygonFromPoints,
    findClosestPolygonBoundaryContact,
    findSegmentPolygonBoundaryContact,
    isPointInPolygon
} = require("../utils/geometry");
const { distanceBetween } = require("../utils/math");
const { handlePlayerLifeLoss } = require("./catchModeSystem");
const { captureClosedTrail } = require("./dominationSystem");

const geometryEpsilon = 1e-7;

const trailSides = Object.freeze({
    left: Object.freeze({
        activeKey: "isLeftTrailActive",
        lastPointKey: "lastLeftTrailPoint",
        segmentsKey: "trailLeftSegments",
        fillPathKey: "trailLeftFillPath"
    }),
    right: Object.freeze({
        activeKey: "isRightTrailActive",
        lastPointKey: "lastRightTrailPoint",
        segmentsKey: "trailRightSegments",
        fillPathKey: "trailRightFillPath"
    })
});

function updateTrails(players, territories, context = {}) {
    for (const player of players.values()) {
        updatePlayerTrail(player, territories, players, context);
    }
}

function updatePlayerTrail(player, territories, players = new Map([[player.id, player]]), context = {}) {
    const territoryPolygon = getPlayerTerritoryPolygon(territories, player.id);
    const sample = createTrailSample(player);
    const previousSample = {
        leftPoint: player.lastLeftTrailPoint,
        rightPoint: player.lastRightTrailPoint
    };
    const leftUpdate = updateTrailSide(player, trailSides.left, sample.leftPoint, territoryPolygon);
    const rightUpdate = updateTrailSide(player, trailSides.right, sample.rightPoint, territoryPolygon);
    const leftInside = leftUpdate.inside;
    const rightInside = rightUpdate.inside;

    player.lastLeftTrailPoint = clonePoint(sample.leftPoint);
    player.lastRightTrailPoint = clonePoint(sample.rightPoint);

    if (!(leftInside && rightInside) && hasSelfTrailCollision(player, previousSample, sample)) {
        handlePlayerLifeLoss(players, territories, player, context, {
            reason: "selfTrail"
        });
        return;
    }

    markCrossedTrailOwners(player, players, previousSample, sample);

    if (leftInside && rightInside && hasAnyTrailSegment(player)) {
        if (canCaptureClosedTrail(player)) {
            const capturedPolygon = captureClosedTrail(player, territories, players, context);

            if (capturedPolygon) {
                player.consumeCatchBalance(1);
            }
        }
        clearTrail(player);
        return;
    }

    updateTrailFill(player, sample, previousSample, territoryPolygon, leftUpdate, rightUpdate);
}

function updateTrailSide(player, side, currentPoint, territoryPolygon) {
    const isInside = isPointInPolygon(territoryPolygon, currentPoint.x, currentPoint.y);

    if (isInside) {
        return {
            inside: true,
            path: closeActiveSideSegment(player, side, currentPoint, territoryPolygon)
        };
    }

    if (!player[side.activeKey]) {
        return {
            inside: false,
            path: startSideSegment(player, side, currentPoint, territoryPolygon)
        };
    } else {
        return {
            inside: false,
            path: appendPointToActiveSegment(player, side, currentPoint, false)
        };
    }
}

function startSideSegment(player, side, currentPoint, territoryPolygon) {
    const previousPoint = player[side.lastPointKey];
    const contact = previousPoint
        ? findSegmentPolygonBoundaryContact(territoryPolygon, previousPoint, currentPoint)
        : null;
    const boundaryPoint = contact
        ? contact.point
        : findClosestBoundaryPoint(territoryPolygon, currentPoint);
    const segment = [];

    appendPoint(segment, boundaryPoint, true);
    appendPoint(segment, currentPoint, true);
    player[side.segmentsKey].push(segment);
    player[side.activeKey] = true;

    return segment.slice();
}

function closeActiveSideSegment(player, side, currentPoint, territoryPolygon) {
    if (!player[side.activeKey]) {
        return [];
    }

    const segment = getActiveSegment(player, side);

    if (!segment) {
        player[side.activeKey] = false;
        return [];
    }

    const previousPoint = segment[segment.length - 1] || player[side.lastPointKey];
    const contact = previousPoint
        ? findSegmentPolygonBoundaryContact(territoryPolygon, previousPoint, currentPoint)
        : null;
    const boundaryPoint = contact
        ? contact.point
        : findClosestBoundaryPoint(territoryPolygon, previousPoint || currentPoint);

    appendPoint(segment, boundaryPoint, true);
    player[side.activeKey] = false;

    if (segment.length < 2) {
        player[side.segmentsKey].pop();
        return [];
    }

    return previousPoint ? [previousPoint, boundaryPoint] : segment.slice();
}

function appendPointToActiveSegment(player, side, point, force) {
    const segment = getActiveSegment(player, side);

    if (!segment) {
        return [];
    }

    const previousPoint = segment[segment.length - 1];

    if (!appendPoint(segment, point, force)) {
        return [];
    }

    return previousPoint ? [previousPoint, point] : [point];
}

function updateTrailFill(player, sample, previousSample, territoryPolygon, leftUpdate, rightUpdate) {
    if (!hasAnyTrailSegment(player)) {
        clearTrailFill(player);
        return;
    }

    if (!previousSample.leftPoint || !previousSample.rightPoint) {
        return;
    }

    const leftInside = leftUpdate.inside;
    const rightInside = rightUpdate.inside;
    const leftPath = createFillSideStepPath(
        territoryPolygon,
        previousSample.leftPoint,
        sample.leftPoint,
        leftInside,
        leftUpdate.path
    );
    const rightPath = createFillSideStepPath(
        territoryPolygon,
        previousSample.rightPoint,
        sample.rightPoint,
        rightInside,
        rightUpdate.path
    );

    if (leftPath.length < 2 || rightPath.length < 2) {
        return;
    }

    const stepPolygon = createTrailFillPolygon(leftPath, rightPath);

    if (calculatePolygonArea(stepPolygon) > geometryEpsilon) {
        appendFillPath(player, trailSides.left, leftPath);
        appendFillPath(player, trailSides.right, rightPath);
    }
}

function appendPoint(points, point, force) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return false;
    }

    const lastPoint = points[points.length - 1];

    if (lastPoint) {
        const distance = distanceBetween(point.x, point.y, lastPoint.x, lastPoint.y);

        if (distance <= Number.EPSILON || (!force && distance < getTrailPointSpacing())) {
            return false;
        }
    }

    points.push({
        x: point.x,
        y: point.y
    });

    return true;
}

function getActiveSegment(player, side) {
    const segments = player[side.segmentsKey];

    return segments[segments.length - 1];
}

function findClosestBoundaryPoint(territoryPolygon, point) {
    const contact = findClosestPolygonBoundaryContact(territoryPolygon, point);

    return contact ? contact.point : point;
}

function hasAnyTrailSegment(player) {
    return hasVisibleSegment(player.trailLeftSegments)
        || hasVisibleSegment(player.trailRightSegments);
}

function hasVisibleSegment(segments) {
    return segments.some(segment => segment.length >= 2);
}

function hasSelfTrailCollision(player, previousSample, sample) {
    if (!previousSample.leftPoint || !previousSample.rightPoint) {
        return false;
    }

    return doesMovementLineCrossTrail(
        player,
        trailSides.left,
        previousSample.leftPoint,
        sample.leftPoint
    ) || doesMovementLineCrossTrail(
        player,
        trailSides.right,
        previousSample.rightPoint,
        sample.rightPoint
    );
}

function markCrossedTrailOwners(player, players, previousSample, sample) {
    if (!previousSample.leftPoint || !previousSample.rightPoint) {
        return;
    }

    for (const trailOwner of players.values()) {
        if (trailOwner.id === player.id || !hasAnyTrailSegment(trailOwner)) {
            continue;
        }

        if (doesPlayerMovementCrossTrailOwner(previousSample, sample, trailOwner)) {
            player.queueCatchEliminationTarget(trailOwner.id);
        }
    }
}

function canCaptureClosedTrail(player) {
    return config.gameMode.mode !== "catch" || player.catchBalance > 0;
}

function doesPlayerMovementCrossTrailOwner(previousSample, sample, trailOwner) {
    return doesMovementLineCrossStoredSegments(
        previousSample.leftPoint,
        sample.leftPoint,
        trailOwner.trailLeftSegments
    ) || doesMovementLineCrossStoredSegments(
        previousSample.leftPoint,
        sample.leftPoint,
        trailOwner.trailRightSegments
    ) || doesMovementLineCrossStoredSegments(
        previousSample.rightPoint,
        sample.rightPoint,
        trailOwner.trailLeftSegments
    ) || doesMovementLineCrossStoredSegments(
        previousSample.rightPoint,
        sample.rightPoint,
        trailOwner.trailRightSegments
    );
}

function doesMovementLineCrossStoredSegments(startPoint, endPoint, segments) {
    if (arePointsEqual(startPoint, endPoint) || !Array.isArray(segments)) {
        return false;
    }

    for (const segment of segments) {
        for (let index = 0; index < segment.length - 1; index++) {
            if (segmentsCross(startPoint, endPoint, segment[index], segment[index + 1])) {
                return true;
            }
        }
    }

    return false;
}

function doesMovementLineCrossTrail(player, movingSide, startPoint, endPoint) {
    if (arePointsEqual(startPoint, endPoint)) {
        return false;
    }

    return doesLineCrossSideTrails(player, movingSide, trailSides.left, startPoint, endPoint)
        || doesLineCrossSideTrails(player, movingSide, trailSides.right, startPoint, endPoint);
}

function doesLineCrossSideTrails(player, movingSide, storedSide, startPoint, endPoint) {
    const segments = player[storedSide.segmentsKey];

    if (!Array.isArray(segments)) {
        return false;
    }

    for (const segment of segments) {
        for (let index = 0; index < segment.length - 1; index++) {
            if (shouldSkipSelfTrailSegment(player, movingSide, storedSide, segment, index)) {
                continue;
            }

            if (segmentsCross(startPoint, endPoint, segment[index], segment[index + 1])) {
                return true;
            }
        }
    }

    return false;
}

function shouldSkipSelfTrailSegment(player, movingSide, storedSide, segment, pointIndex) {
    const activeSegment = getActiveSegment(player, storedSide);

    if (segment !== activeSegment) {
        return false;
    }

    const recentPointSkip = getRecentSelfTrailCollisionPointSkip(player, movingSide, storedSide);

    return pointIndex >= Math.max(0, segment.length - recentPointSkip);
}

function getRecentSelfTrailCollisionPointSkip(player, movingSide, storedSide) {
    const baseSkip = movingSide === storedSide ? 3 : 2;

    if (!isPlayerSlidingOnMapBoundary(player)) {
        return baseSkip;
    }

    const boundaryTurnSkip = Math.ceil(
        (getRuntimeConfig(player).world.playerSize * 4) / getTrailPointSpacing(player)
    );

    return Math.max(baseSkip, boundaryTurnSkip);
}

function isPlayerSlidingOnMapBoundary(player) {
    return isBoundarySlideDirection(player.boundarySlideDirection)
        && Math.hypot(player.x, player.y) >= getMapMovementLimit(player) - Number.EPSILON;
}

function isBoundarySlideDirection(value) {
    return value === -1 || value === 1;
}

function getMapMovementLimit(player = null) {
    const runtimeConfig = getRuntimeConfig(player);

    return runtimeConfig.world.mapRadius - runtimeConfig.world.playerSize / 2;
}

function segmentsCross(firstStart, firstEnd, secondStart, secondEnd) {
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

    return firstT > geometryEpsilon
        && firstT <= 1 + geometryEpsilon
        && secondT > geometryEpsilon
        && secondT < 1 - geometryEpsilon;
}

function doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(Math.min(firstStart.x, firstEnd.x), Math.min(secondStart.x, secondEnd.x))
        <= Math.min(Math.max(firstStart.x, firstEnd.x), Math.max(secondStart.x, secondEnd.x)) + geometryEpsilon
        && Math.max(Math.min(firstStart.y, firstEnd.y), Math.min(secondStart.y, secondEnd.y))
        <= Math.min(Math.max(firstStart.y, firstEnd.y), Math.max(secondStart.y, secondEnd.y)) + geometryEpsilon;
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

function clearTrail(player) {
    player.trailLeftSegments = [];
    player.trailRightSegments = [];
    player.isLeftTrailActive = false;
    player.isRightTrailActive = false;
    clearTrailFill(player);
}

function clearTrailFill(player) {
    player.trailLeftFillPath = [];
    player.trailRightFillPath = [];
}

function createTrailSample(player) {
    const halfWidth = getRuntimeConfig(player).world.playerSize / 2;
    const normal = getPlayerNormal(player.angle);

    return {
        leftPoint: {
            x: player.x + normal.x * halfWidth,
            y: player.y + normal.y * halfWidth
        },
        rightPoint: {
            x: player.x - normal.x * halfWidth,
            y: player.y - normal.y * halfWidth
        }
    };
}

function getTrailPointSpacing(player = null) {
    return getRuntimeConfig(player).territory.trailPointSpacing;
}

function getRuntimeConfig(player = null) {
    return player && player.runtimeConfig && player.runtimeConfig.world
        ? player.runtimeConfig
        : config;
}

function serializeTrails(players, territories) {
    const serializedTrails = {};

    for (const player of players.values()) {
        const leftSegments = serializeSegments(player.trailLeftSegments);
        const rightSegments = serializeSegments(player.trailRightSegments);

        if (leftSegments.length === 0 && rightSegments.length === 0) {
            continue;
        }

        serializedTrails[player.id] = {
            id: player.id,
            color: player.color,
            leftSegments,
            rightSegments,
            fillPolygon: serializeTrailFillPolygon(player)
        };
    }

    return serializedTrails;
}

function serializeSegments(segments) {
    return segments
        .map(segment => segment.map(clonePoint))
        .filter(segment => segment.length >= 2);
}

function serializeTrailFillPolygon(player) {
    const fillPolygon = createRawTrailFillPolygon(player.trailLeftFillPath, player.trailRightFillPath);

    return calculatePolygonArea(fillPolygon) > geometryEpsilon ? serializeRawPolygon(fillPolygon) : null;
}

function clonePoint(point) {
    return {
        x: point.x,
        y: point.y
    };
}

function getPlayerNormal(angle) {
    return {
        x: -Math.sin(angle),
        y: Math.cos(angle)
    };
}

function appendFillPath(player, side, path) {
    if (!Array.isArray(player[side.fillPathKey])) {
        player[side.fillPathKey] = [];
    }

    const fillPath = player[side.fillPathKey];

    for (const point of path) {
        appendPoint(fillPath, point, true);
    }
}

function createTrailFillPolygon(leftPath, rightPath) {
    const polygon = createPolygonFromPoints(removeConsecutiveDuplicatePoints(
        leftPath.concat([...rightPath].reverse())
    ));

    return calculatePolygonArea(polygon) > geometryEpsilon ? polygon : [];
}

function createRawTrailFillPolygon(leftPath, rightPath) {
    if (!Array.isArray(leftPath) || !Array.isArray(rightPath)) {
        return [];
    }

    const points = removeConsecutiveDuplicatePoints(leftPath.concat([...rightPath].reverse()));

    if (points.length < 3) {
        return [];
    }

    const ring = points.map(point => [point.x, point.y]);

    if (!areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        ring.push([ring[0][0], ring[0][1]]);
    }

    return [ring];
}

function serializeRawPolygon(polygon) {
    return {
        rings: polygon.map(ring => ring.map(([x, y]) => ({ x, y })))
    };
}

function createFillSideStepPath(territoryPolygon, previousPoint, currentPoint, currentInside, visiblePath = []) {
    if (Array.isArray(visiblePath) && visiblePath.length >= 2) {
        return visiblePath;
    }

    const previousInside = isPointInPolygon(territoryPolygon, previousPoint.x, previousPoint.y);

    if (previousInside && currentInside) {
        return createBoundaryPathBetweenPoints(territoryPolygon, previousPoint, currentPoint);
    }

    if (previousInside && !currentInside) {
        const contact = findSegmentPolygonBoundaryContact(territoryPolygon, previousPoint, currentPoint)
            || findClosestPolygonBoundaryContact(territoryPolygon, currentPoint);

        return contact ? [contact.point, currentPoint] : [];
    }

    if (!previousInside && currentInside) {
        const contact = findSegmentPolygonBoundaryContact(territoryPolygon, previousPoint, currentPoint)
            || findClosestPolygonBoundaryContact(territoryPolygon, previousPoint);

        return contact ? [previousPoint, contact.point] : [];
    }

    return [previousPoint, currentPoint];
}

function createBoundaryPathBetweenPoints(territoryPolygon, previousPoint, currentPoint) {
    const startContact = findClosestPolygonBoundaryContact(territoryPolygon, previousPoint);
    const endContact = findClosestPolygonBoundaryContact(territoryPolygon, currentPoint);

    return createShortestBoundaryPath(territoryPolygon[0], startContact, endContact);
}

function createShortestBoundaryPath(ring, startContact, endContact) {
    const boundaryPaths = createBoundaryPaths(ring, startContact, endContact);

    return boundaryPaths.sort((first, second) => calculatePathLength(first) - calculatePathLength(second))[0] || [];
}

function createBoundaryPaths(ring, startContact, endContact) {
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

function calculatePathLength(points) {
    let length = 0;

    for (let index = 1; index < points.length; index++) {
        length += distanceBetween(points[index - 1].x, points[index - 1].y, points[index].x, points[index].y);
    }

    return length;
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

function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
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
    clearTrail,
    createTrailSample,
    serializeTrails,
    updatePlayerTrail,
    updateTrails
};
