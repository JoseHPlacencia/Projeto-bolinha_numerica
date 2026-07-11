const config = require("../config/gameConfig");

/**
 * Shared snapshot serialization primitives.
 *
 * Coordinate precision and territory point references must be identical across
 * player, territory and trail payloads. Version resend policy also belongs here
 * so every versioned section follows the same full-sync rule.
 */

function packReferencedPolygon(polygon, clientState) {
    ensureTerritoryPointCache(clientState);

    if (!Array.isArray(polygon)) {
        return {
            rings: [],
            points: []
        };
    }

    const pointDefinitions = [];
    const rings = polygon
        .map(ring => packPointReferenceRing(ring, clientState, pointDefinitions))
        .filter(ring => ring.length >= 3);

    return {
        rings,
        points: pointDefinitions
    };
}

function packPointReferenceRing(ring, clientState, pointDefinitions) {
    return (ring || [])
        .map(point => getTerritoryPointReference(point, clientState, pointDefinitions))
        .filter(Number.isInteger);
}

function getTerritoryPointReference(point, clientState, pointDefinitions) {
    const packedPoint = packCoordinatePair(point);

    if (!packedPoint) {
        return null;
    }

    const key = getTerritoryPointKey(packedPoint);
    let pointId = clientState.territoryPoints.get(key);

    if (!pointId) {
        pointId = clientState.nextTerritoryPointId++;
        clientState.territoryPoints.set(key, pointId);
        pointDefinitions.push([
            pointId,
            packedPoint[0],
            packedPoint[1]
        ]);
    }

    return pointId;
}

function getTerritoryPointKey(point) {
    return `${point[0]},${point[1]}`;
}

function ensureTerritoryPointCache(clientState) {
    if (!(clientState.territoryPoints instanceof Map)) {
        clientState.territoryPoints = new Map();
    }

    if (!Number.isInteger(clientState.nextTerritoryPointId) || clientState.nextTerritoryPointId < 1) {
        clientState.nextTerritoryPointId = 1;
    }

}

function packPoints(points) {
    return (points || [])
        .map(packPoint)
        .filter(Boolean);
}

function packPoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return null;
    }

    return [
        packCoordinate(point.x),
        packCoordinate(point.y)
    ];
}

function packCoordinatePair(point) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        return null;
    }

    return [
        packCoordinate(point[0]),
        packCoordinate(point[1])
    ];
}

function packCoordinate(value) {
    return roundToPrecision(value, config.network.coordinatePrecision);
}

function packAngle(value) {
    return roundToPrecision(value, config.network.anglePrecision);
}

function roundToPrecision(value, precision) {
    const safePrecision = Number.isFinite(precision) && precision > 0 ? precision : 1;

    return Math.round(value * safePrecision) / safePrecision;
}

function shouldSendVersionedState(knownState, version, now, fullSyncIntervalMs) {
    return !knownState
        || knownState.version !== version
        || (
            shouldSendForcedFullSync()
            && now - knownState.sentAt >= fullSyncIntervalMs
        );
}

function shouldSendForcedFullSync() {
    return config.network.forcedFullSyncsEnabled !== false;
}

module.exports = {
    packAngle,
    packCoordinate,
    packPoint,
    packPoints,
    packReferencedPolygon,
    roundToPrecision,
    shouldSendForcedFullSync,
    shouldSendVersionedState
};
