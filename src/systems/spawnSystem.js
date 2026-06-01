const config = require("../config/gameConfig");
const { distanceSqBetween } = require("../utils/math");

// PERFORMANCE: Usa distanceSqBetween para evitar Math.sqrt() em cada comparação.
// Com N jogadores, são N sqrt() eliminados por tentativa de spawn.
// Compara distância² com limiar² (minDistSq) — matematicamente equivalente.
const _MIN_DIST_SQ = config.spawn.minTerritoryDistance * config.spawn.minTerritoryDistance;

function isSpawnPositionValid(players, x, y) {
    for (const player of players.values()) {
        if (distanceSqBetween(x, y, player.territoryX, player.territoryY) < _MIN_DIST_SQ) {
            return false;
        }
    }

    return true;
}

function getSpawnRadiusLimit() {
    return config.world.mapRadius - config.world.initialTerritoryRadius * 3 - config.world.playerSize / 2;
}

function createRandomPointInsideCircle(radius) {
    const angle = Math.random() * Math.PI * 2;

    // sqrt keeps points evenly distributed over the circle area.
    const distance = Math.sqrt(Math.random()) * radius;

    return {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance
    };
}

function createSpawn(players) {
    const radiusLimit = getSpawnRadiusLimit();

    for (let attempt = 0; attempt < config.spawn.maxAttempts; attempt++) {
        const spawn = createRandomPointInsideCircle(radiusLimit);

        if (isSpawnPositionValid(players, spawn.x, spawn.y)) {
            return spawn;
        }
    }

    return { x: 0, y: 0 };
}

module.exports = {
    createSpawn,
    isSpawnPositionValid
};
