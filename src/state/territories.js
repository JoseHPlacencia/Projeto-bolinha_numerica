const config = require("../config/gameConfig");
const {
    calculatePolygonArea,
    createCirclePolygon,
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

    territories.set(player.id, {
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
    });
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

    for (const [playerId, otherTerritory] of territories.entries()) {
        if (playerId === ownerId) {
            continue;
        }

        const nextPolygon = subtractPolygon(otherTerritory.polygon, capturedPolygon);

        if (updateTerritoryPolygon(otherTerritory, nextPolygon)) {
            changedPlayerIds.add(playerId);
        }
    }

    return changedPlayerIds;
}

function getOwnerCapturedPolygon(currentPolygon, capturedPolygon, operationPolygon) {
    return calculatePolygonArea(operationPolygon) > 0
        ? operationPolygon
        : unionPolygons(currentPolygon, capturedPolygon);
}

function updateTerritoryPolygon(territory, nextPolygon, options = {}) {
    const previousArea = calculatePolygonArea(territory.polygon);
    const nextArea = calculatePolygonArea(nextPolygon);

    if (Math.abs(previousArea - nextArea) <= territoryChangeAreaEpsilon) {
        return false;
    }

    delete territory.lastCaptureOperation;

    if (!options.preserveCaptureOperationLog) {
        territory.captureOperationLog = [];
    }

    territory.polygon = nextPolygon;
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
