const config = require("../config/gameConfig");
const { getPointPolygonDistance } = require("../utils/geometry");
const { distanceBetween } = require("../utils/math");

function isSpawnPositionValid(players, x, y, territories = null, runtimeConfig = config) {
    const spawnConfig = getRuntimeConfig(runtimeConfig);
    const spawnPoint = { x, y };

    for (const player of players.values()) {
        const territory = territories && territories.get(player.id);
        const distance = territory && territory.polygon
            ? getPointPolygonDistance(territory.polygon, spawnPoint)
            : distanceBetween(x, y, player.territoryX, player.territoryY);

        if (distance < getMinTerritoryDistance(spawnConfig)) {
            return false;
        }
    }

    return true;
}

function getSpawnRadiusLimit(runtimeConfig = config) {
    const spawnConfig = getRuntimeConfig(runtimeConfig);

    return spawnConfig.world.mapRadius - spawnConfig.world.initialTerritoryRadius * 3 - spawnConfig.world.playerSize / 2;
}

function createRandomPointInsideCircle(radius) {
    const angle = Math.random() * Math.PI * 2;

    const distance = Math.sqrt(Math.random()) * radius;

    return {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance
    };
}

function createSpawn(players, territories = null, runtimeConfig = config) {
    const spawnConfig = getRuntimeConfig(runtimeConfig);
    const radiusLimit = getSpawnRadiusLimit(spawnConfig);

    for (let attempt = 0; attempt < spawnConfig.spawn.maxAttempts; attempt++) {
        const spawn = createRandomPointInsideCircle(radiusLimit);

        if (isSpawnPositionValid(players, spawn.x, spawn.y, territories, spawnConfig)) {
            return spawn;
        }
    }

    return findGridSpawn(players, territories, radiusLimit, spawnConfig);
}

function findGridSpawn(players, territories, radiusLimit, runtimeConfig = config) {
    const spawnConfig = getRuntimeConfig(runtimeConfig);
    const sideSamples = Math.ceil(Math.sqrt(spawnConfig.spawn.maxAttempts));

    for (let row = 0; row < sideSamples; row++) {
        const y = interpolateSpawnRange(-radiusLimit, radiusLimit, row, sideSamples);

        for (let column = 0; column < sideSamples; column++) {
            const x = interpolateSpawnRange(-radiusLimit, radiusLimit, column, sideSamples);

            if (Math.hypot(x, y) > radiusLimit) {
                continue;
            }

            if (isSpawnPositionValid(players, x, y, territories, spawnConfig)) {
                return { x, y };
            }
        }
    }

    return null;
}

function getRuntimeConfig(runtimeConfig) {
    return runtimeConfig && runtimeConfig.world && runtimeConfig.spawn
        ? runtimeConfig
        : {
            ...config,
            spawn: config.spawn,
            world: config.world
        };
}

function getMinTerritoryDistance(runtimeConfig) {
    return runtimeConfig.spawn && Number.isFinite(runtimeConfig.spawn.minTerritoryDistance)
        ? runtimeConfig.spawn.minTerritoryDistance
        : runtimeConfig.world.initialTerritoryRadius * 3;
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
