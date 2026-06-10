const config = require("../config/gameConfig");

const MULTIPLIER_OPTION_IDS = Object.freeze([
    "mapSize",
    "playerSpeed",
    "numberRespawn",
    "numberDensity",
    "numberSpread",
    "themeDuration"
]);

function createRoomRuntimeConfig(rawOptions = {}, difficulty = config.gameMode.catch.defaultDifficulty) {
    const customOptions = normalizeRoomCustomOptions(rawOptions, difficulty);
    const numberDensity = customOptions.numberDensity;

    return {
        customOptions,
        world: Object.freeze({
            ...config.world,
            mapRadius: roundPositive(config.world.mapRadius * customOptions.mapSize)
        }),
        movement: Object.freeze({
            ...config.movement,
            speed: roundPositive(config.movement.speed * customOptions.playerSpeed)
        }),
        territory: Object.freeze({
            ...config.territory
        }),
        spawn: Object.freeze({
            ...config.spawn,
            minTerritoryDistance: config.world.initialTerritoryRadius * 3
        }),
        numbers: Object.freeze({
            ...config.numbers,
            maxNumbers: Math.max(5, Math.round(config.numbers.maxNumbers * numberDensity)),
            minDistanceBetween: Math.max(40, Math.round(config.numbers.minDistanceBetween / Math.sqrt(numberDensity))),
            respawnDelaySec: roundPositive(config.numbers.respawnDelaySec * customOptions.numberRespawn, 2),
            spawnRadiusRatio: clamp(config.numbers.spawnRadiusRatio * customOptions.numberSpread, 0.35, 0.98),
            themeIntervalMultiplier: customOptions.themeDuration
        }),
        gameMode: Object.freeze({
            ...config.gameMode,
            catch: Object.freeze({
                ...config.gameMode.catch,
                roomLives: customOptions.lives
            })
        })
    };
}

function normalizeRoomCustomOptions(rawOptions = {}, difficulty = config.gameMode.catch.defaultDifficulty) {
    const source = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
    const normalized = {};

    for (const optionId of MULTIPLIER_OPTION_IDS) {
        normalized[optionId] = normalizeMultiplier(source[optionId]);
    }

    normalized.lives = normalizeLives(source.lives, difficulty);
    return Object.freeze(normalized);
}

function normalizeMultiplier(value) {
    const numericValue = Number(value);
    const multipliers = config.roomCustomOptions.multipliers;

    if (!Number.isFinite(numericValue)) {
        return 1;
    }

    return multipliers.reduce((closest, candidate) => (
        Math.abs(candidate - numericValue) < Math.abs(closest - numericValue)
            ? candidate
            : closest
    ), 1);
}

function normalizeLives(value, difficulty) {
    const numericValue = Math.round(Number(value));

    if (Number.isInteger(numericValue)) {
        return clamp(numericValue, config.roomCustomOptions.lives.min, config.roomCustomOptions.lives.max);
    }

    const normalizedDifficulty = difficulty === "easy" || difficulty === "hard" ? difficulty : "medium";
    const difficultyLives = config.gameMode.catch.livesByDifficulty[normalizedDifficulty];

    return Number.isInteger(difficultyLives)
        ? clamp(difficultyLives, config.roomCustomOptions.lives.min, config.roomCustomOptions.lives.max)
        : 2;
}

function serializeRoomSettings(runtimeConfig) {
    const roomConfig = runtimeConfig || createRoomRuntimeConfig();

    return {
        customOptions: roomConfig.customOptions,
        world: {
            mapRadius: roomConfig.world.mapRadius,
            initialTerritoryRadius: roomConfig.world.initialTerritoryRadius,
            playerSize: roomConfig.world.playerSize
        },
        movement: {
            speed: roomConfig.movement.speed
        },
        numbers: {
            maxNumbers: roomConfig.numbers.maxNumbers,
            respawnDelaySec: roomConfig.numbers.respawnDelaySec,
            spawnRadiusRatio: roomConfig.numbers.spawnRadiusRatio,
            themeIntervalMultiplier: roomConfig.numbers.themeIntervalMultiplier
        },
        gameMode: {
            catch: {
                roomLives: roomConfig.gameMode.catch.roomLives
            }
        }
    };
}

function roundPositive(value, precision = 0) {
    const factor = 10 ** precision;
    const rounded = Math.round(Number(value) * factor) / factor;

    return Number.isFinite(rounded) && rounded > 0 ? rounded : 1;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

module.exports = {
    createRoomRuntimeConfig,
    normalizeRoomCustomOptions,
    serializeRoomSettings
};
