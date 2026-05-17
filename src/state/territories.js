const config = require("../config/gameConfig");
const {
    createCirclePolygon,
    isPointInPolygon,
    serializePolygon,
    subtractPolygon,
    unionPolygons
} = require("../utils/geometry");

function createTerritories() {
    return new Map();
}

function initializePlayerTerritory(territories, player) {
    territories.set(player.id, {
        id: player.id,
        color: player.color,
        baseX: player.territoryX,
        baseY: player.territoryY,
        polygon: createCirclePolygon(
            player.territoryX,
            player.territoryY,
            config.world.initialTerritoryRadius,
            config.territory.circleSegments
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

function applyCapturedPolygon(territories, ownerId, capturedPolygon) {
    const territory = territories.get(ownerId);

    if (!territory) {
        return;
    }

    territory.polygon = unionPolygons(territory.polygon, capturedPolygon);

    for (const [playerId, otherTerritory] of territories.entries()) {
        if (playerId === ownerId) {
            continue;
        }

        otherTerritory.polygon = subtractPolygon(otherTerritory.polygon, capturedPolygon);
    }
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
