const config = require("../config/gameConfig");
const { getPointPolygonDistance } = require("../utils/geometry");
const { distanceBetween } = require("../utils/math");

function isSpawnPositionValid(players, x, y, territories = null) {
    const spawnPoint = { x, y };

    for (const player of players.values()) {
        const territory = territories && territories.get(player.id);
        const distance = territory && territory.polygon
            ? getPointPolygonDistance(territory.polygon, spawnPoint)
            : distanceBetween(x, y, player.territoryX, player.territoryY);

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

function createSpawn(players, territories = null) {
    const radiusLimit = getSpawnRadiusLimit();

    for (let attempt = 0; attempt < config.spawn.maxAttempts; attempt++) {
        const spawn = createRandomPointInsideCircle(radiusLimit);

        if (isSpawnPositionValid(players, spawn.x, spawn.y, territories)) {
            return spawn;
        }
    }

    return findGridSpawn(players, territories, radiusLimit) || { x: 0, y: 0 };
}

function findGridSpawn(players, territories, radiusLimit) {
    const sideSamples = Math.ceil(Math.sqrt(config.spawn.maxAttempts));

    for (let row = 0; row < sideSamples; row++) {
        const y = interpolateSpawnRange(-radiusLimit, radiusLimit, row, sideSamples);

        for (let column = 0; column < sideSamples; column++) {
            const x = interpolateSpawnRange(-radiusLimit, radiusLimit, column, sideSamples);

            if (Math.hypot(x, y) > radiusLimit) {
                continue;
            }

            if (isSpawnPositionValid(players, x, y, territories)) {
                return { x, y };
            }
        }
    }

    return null;
}

function interpolateSpawnRange(min, max, index, count) {
    if (count <= 1) {
        return (min + max) / 2;
    }

    return min + (max - min) * (index / (count - 1));
}

module.exports = {
    createSpawn,
    isSpawnPositionValid
};
