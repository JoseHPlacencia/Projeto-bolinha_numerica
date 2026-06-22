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
            speed: roundPositive(config.movement.speed * customOptions.playerSpeed),
            rotationStrength: scaleRotationStrength(
                config.movement.rotationStrength,
                customOptions.playerSpeed
            )
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
    normalized.maxPlayers = normalizeMaxPlayers(source.maxPlayers);
    normalized.allowBots = typeof source.allowBots === "boolean"
        ? source.allowBots
        : config.roomCustomOptions.allowBotsDefault !== false;
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

function normalizeMaxPlayers(value) {
    const numericValue = Number(value);
    const playerOptions = config.roomCustomOptions.players;

    if (!Number.isInteger(numericValue)) {
        return playerOptions.default;
    }

    return clamp(numericValue, playerOptions.min, playerOptions.max);
}

function validateRoomCustomOptions(rawOptions = {}) {
    if (!rawOptions || typeof rawOptions !== "object") {
        return null;
    }

    if (rawOptions.maxPlayers !== undefined) {
        const maxPlayers = rawOptions.maxPlayers;
        const playerOptions = config.roomCustomOptions.players;

        if (!Number.isInteger(maxPlayers)
            || maxPlayers < playerOptions.min
            || maxPlayers > playerOptions.max) {
            return `A quantidade de jogadores deve ser um número inteiro de ${playerOptions.min} a ${playerOptions.max}.`;
        }
    }

    if (rawOptions.allowBots !== undefined && typeof rawOptions.allowBots !== "boolean") {
        return "A opção de permitir bots deve ser verdadeira ou falsa.";
    }

    return null;
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
            rotationStrength: roomConfig.movement.rotationStrength,
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

function scaleRotationStrength(baseStrength, speedMultiplier) {
    const numericStrength = Number(baseStrength);
    const numericMultiplier = Number(speedMultiplier);
    const strength = Number.isFinite(numericStrength)
        ? clamp(numericStrength, 0, 1)
        : 0;
    const multiplier = Number.isFinite(numericMultiplier)
        ? Math.max(0, numericMultiplier)
        : 1;

    if (strength === 0 || strength === 1 || multiplier === 1) {
        return strength;
    }

    return 1 - Math.pow(1 - strength, multiplier);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

module.exports = {
    createRoomRuntimeConfig,
    normalizeRoomCustomOptions,
    scaleRotationStrength,
    serializeRoomSettings,
    validateRoomCustomOptions
};
