const {
    calculatePolygonArea,
    getPointPolygonDistance,
    isPointInPolygon
} = require("../utils/geometry");

const boundaryDistanceEpsilon = 1e-7;

function selectRetainedTerritoryPolygon(components, player) {
    const validComponents = (components || []).filter(component => (
        calculatePolygonArea(component) > 0
    ));

    if (validComponents.length <= 1) {
        return validComponents[0] || [];
    }

    const playerPosition = getFinitePlayerPosition(player);
    const positionComponent = playerPosition
        ? validComponents.find(component => isPointInsideOrTouchingPolygon(component, playerPosition))
        : null;

    if (positionComponent) {
        return positionComponent;
    }

    const trailConnectionPoint = getPlayerTrailConnectionPoint(player, playerPosition);

    if (trailConnectionPoint) {
        return getClosestPolygonToPoint(validComponents, trailConnectionPoint);
    }

    return getLargestPolygon(validComponents);
}

function getFinitePlayerPosition(player) {
    return player && Number.isFinite(player.x) && Number.isFinite(player.y)
        ? { x: player.x, y: player.y }
        : null;
}

function isPointInsideOrTouchingPolygon(polygon, point) {
    return isPointInPolygon(polygon, point.x, point.y)
        || getPointPolygonDistance(polygon, point) <= boundaryDistanceEpsilon;
}

function getPlayerTrailConnectionPoint(player, playerPosition) {
    if (!player) {
        return null;
    }

    const connectionPoints = [
        getTrailSideConnectionPoint(player.trailLeftSegments, player.isLeftTrailActive),
        getTrailSideConnectionPoint(player.trailRightSegments, player.isRightTrailActive)
    ].filter(Boolean);

    if (connectionPoints.length <= 1 || !playerPosition) {
        return connectionPoints[0] || null;
    }

    return connectionPoints.reduce((closestPoint, point) => (
        getDistanceSquared(point, playerPosition) < getDistanceSquared(closestPoint, playerPosition)
            ? point
            : closestPoint
    ));
}

function getTrailSideConnectionPoint(segments, isActive) {
    const segment = getLatestVisibleTrailSegment(segments);

    if (!segment) {
        return null;
    }

    const point = isActive ? segment[0] : segment[segment.length - 1];

    return point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: point.x, y: point.y }
        : null;
}

function getLatestVisibleTrailSegment(segments) {
    if (!Array.isArray(segments)) {
        return null;
    }

    for (let index = segments.length - 1; index >= 0; index--) {
        if (Array.isArray(segments[index]) && segments[index].length >= 2) {
            return segments[index];
        }
    }

    return null;
}

function getClosestPolygonToPoint(polygons, point) {
    let closestPolygon = polygons[0];
    let closestDistance = getPointPolygonDistance(closestPolygon, point);

    for (let index = 1; index < polygons.length; index++) {
        const polygon = polygons[index];
        const distance = getPointPolygonDistance(polygon, point);

        if (distance < closestDistance
            || (distance === closestDistance
                && calculatePolygonArea(polygon) > calculatePolygonArea(closestPolygon))) {
            closestPolygon = polygon;
            closestDistance = distance;
        }
    }

    return closestPolygon;
}

function getLargestPolygon(polygons) {
    return polygons.reduce((largestPolygon, polygon) => (
        !largestPolygon || calculatePolygonArea(polygon) > calculatePolygonArea(largestPolygon)
            ? polygon
            : largestPolygon
    ), null) || [];
}

function getDistanceSquared(first, second) {
    const deltaX = first.x - second.x;
    const deltaY = first.y - second.y;

    return deltaX * deltaX + deltaY * deltaY;
}

module.exports = {
    selectRetainedTerritoryPolygon
};
