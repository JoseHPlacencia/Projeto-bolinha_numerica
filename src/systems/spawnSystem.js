const config = require("../config/gameConfig");
const { distanceBetween } = require("../utils/math");

function isSpawnPositionValid(players, x, y) {
    for (const player of players.values()) {
        const distance = distanceBetween(x, y, player.territoryX, player.territoryY);

        if (distance < config.spawn.minTerritoryDistance) {
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
