const config = require("../config/gameConfig");
const {
    calculatePolygonArea,
    createCirclePolygon,
    doBoundsOverlap,
    doPolygonsOverlap,
    getPolygonBounds,
    isPointInPolygon,
    serializePolygon,
    subtractPolygon,
    unionPolygons
} = require("../utils/geometry");

const territoryChangeAreaEpsilon = 1;

function createTerritories() {
    return new Map();
}

function initializePlayerTerritory(territories, player, runtimeConfig = config) {
    const territoryConfig = runtimeConfig && runtimeConfig.territory ? runtimeConfig.territory : config.territory;
    const worldConfig = runtimeConfig && runtimeConfig.world ? runtimeConfig.world : config.world;
    const previousTerritory = territories.get(player.id);

    territories.set(player.id, createTerritoryState({
        id: player.id,
        color: player.color,
        version: previousTerritory ? (previousTerritory.version || 0) + 1 : 1,
        baseX: player.territoryX,
        baseY: player.territoryY,
        captureOperationLog: [],
        polygon: createCirclePolygon(
            player.territoryX,
            player.territoryY,
            worldConfig.initialTerritoryRadius,
            territoryConfig.circleSegments
        )
    }));
}

function deletePlayerTerritory(territories, playerId) {
    territories.delete(playerId);
}

function isPointOwnedByPlayer(territories, playerId, x, y) {
    const territory = territories.get(playerId);

    if (!territory) {
        return false;
    }

    return isPointInPolygon(territory.polygon, x, y);
}

function getPlayerTerritoryPolygon(territories, playerId) {
    const territory = territories.get(playerId);

    if (!territory) {
        return [];
    }

    return territory.polygon;
}

function applyCapturedPolygon(territories, ownerId, capturedPolygon, options = {}) {
    const changedPlayerIds = new Set();
    const territory = territories.get(ownerId);

    if (!territory) {
        return changedPlayerIds;
    }

    const ownerPolygon = getOwnerCapturedPolygon(territory.polygon, capturedPolygon, options.ownerPolygon);

    if (updateTerritoryPolygon(territory, ownerPolygon, { preserveCaptureOperationLog: true })) {
        changedPlayerIds.add(ownerId);
    }

    const capturedBounds = getPolygonBounds(capturedPolygon);

    for (const [playerId, otherTerritory] of territories.entries()) {
        if (playerId === ownerId) {
            continue;
        }

        const otherBounds = getTerritoryBounds(otherTerritory);

        if (!capturedBounds || !doBoundsOverlap(otherBounds, capturedBounds)) {
            continue;
        }

        if (!doPolygonsOverlap(otherTerritory.polygon, capturedPolygon, otherBounds, capturedBounds)) {
            continue;
        }

        const nextPolygon = subtractPolygon(otherTerritory.polygon, capturedPolygon);

        if (updateTerritoryPolygon(otherTerritory, nextPolygon)) {
            changedPlayerIds.add(playerId);
        }
    }

    return changedPlayerIds;
}

function createTerritoryState(territory) {
    return updateTerritoryMetrics({
        ...territory
    });
}

function updateTerritoryMetrics(territory) {
    territory.area = calculatePolygonArea(territory.polygon);
    territory.bounds = getPolygonBounds(territory.polygon);
    return territory;
}

function getTerritoryArea(territory) {
    return Number.isFinite(territory && territory.area)
        ? territory.area
        : calculatePolygonArea(territory && territory.polygon);
}

function getTerritoryBounds(territory) {
    return territory && territory.bounds
        ? territory.bounds
        : getPolygonBounds(territory && territory.polygon);
}

function getOwnerCapturedPolygon(currentPolygon, capturedPolygon, operationPolygon) {
    return calculatePolygonArea(operationPolygon) > 0
        ? operationPolygon
        : unionPolygons(currentPolygon, capturedPolygon);
}

function updateTerritoryPolygon(territory, nextPolygon, options = {}) {
    const previousArea = getTerritoryArea(territory);
    const nextArea = calculatePolygonArea(nextPolygon);

    if (Math.abs(previousArea - nextArea) <= territoryChangeAreaEpsilon) {
        return false;
    }

    delete territory.lastCaptureOperation;

    if (!options.preserveCaptureOperationLog) {
        territory.captureOperationLog = [];
    }

    territory.polygon = nextPolygon;
    territory.area = nextArea;
    territory.bounds = getPolygonBounds(nextPolygon);
    territory.version = (territory.version || 0) + 1;

    return true;
}

function serializeTerritories(territories, players = new Map()) {
    const serializedTerritories = {};

    for (const [playerId, territory] of territories.entries()) {
        const player = players.get(playerId);

        serializedTerritories[playerId] = {
            id: playerId,
            color: player ? player.color : territory.color,
            baseX: territory.baseX,
            baseY: territory.baseY,
            polygon: serializePolygon(territory.polygon)
        };
    }

    return serializedTerritories;
}

module.exports = {
    applyCapturedPolygon,
    createTerritories,
    deletePlayerTerritory,
    getPlayerTerritoryPolygon,
    initializePlayerTerritory,
    isPointOwnedByPlayer,
    serializeTerritories
};
