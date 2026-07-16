"use strict";

const config = require("../config/gameConfig");
const {
    createNumberGenerator,
    getNumberProfile
} = require("../content/numberContent");

const NUMBER_CONFIG = config.numbers;
const COLOR_SEED_RANGE = 0x100000000;

function createNumberSystem(mapRadius, players, difficulty, numberOptions = {}) {
    const { key: profileKey, profile } = getNumberProfile(difficulty);
    const numberConfig = createNumberConfig(numberOptions);
    const generateNumber = createNumberGenerator(profile);
    const state = createNumberState();

    initializeNumbers(state, mapRadius, players, generateNumber, profile, numberConfig);

    return {
        difficulty: profileKey,
        getNumbersMap: () => state.numbers,
        getTheme: () => state.theme,
        serialize: () => serializeNumbers(state),
        update: nowMs => updateNumbers(state, players, mapRadius, nowMs, generateNumber, profile, numberConfig)
    };
}

function createNumberConfig(options = {}) {
    const source = options && typeof options === "object" ? options : {};

    return Object.freeze({
        radius: getPositiveNumber(source.radius, NUMBER_CONFIG.radius),
        minDistanceBetween: getPositiveNumber(source.minDistanceBetween, NUMBER_CONFIG.minDistanceBetween),
        minDistanceFromPlayer: getPositiveNumber(source.minDistanceFromPlayer, NUMBER_CONFIG.minDistanceFromPlayer),
        maxNumbers: Math.max(1, Math.round(getPositiveNumber(source.maxNumbers, NUMBER_CONFIG.maxNumbers))),
        respawnDelaySec: getPositiveNumber(source.respawnDelaySec, NUMBER_CONFIG.respawnDelaySec),
        maxSpawnAttempts: Math.max(1, Math.round(getPositiveNumber(source.maxSpawnAttempts, NUMBER_CONFIG.maxSpawnAttempts))),
        spawnRadiusRatio: clamp(getPositiveNumber(source.spawnRadiusRatio, NUMBER_CONFIG.spawnRadiusRatio), 0.1, 0.98),
        themeIntervalMultiplier: getPositiveNumber(source.themeIntervalMultiplier, 1)
    });
}

function createNumberState() {
    return {
        nextId: 1,
        numbers: new Map(),
        pending: [],
        pendingHead: 0,
        theme: null,
        themeIndex: 0,
        themeNextSwitch: 0
    };
}

function initializeNumbers(state, mapRadius, players, generateNumber, profile, numberConfig) {
    state.numbers.clear();
    state.pending.length = 0;
    state.pendingHead = 0;
    state.nextId = 1;

    for (let index = 0; index < numberConfig.maxNumbers; index++) {
        spawnOneNumber(state, mapRadius, players, generateNumber, numberConfig);
    }

    initializeTheme(state, profile, numberConfig);
}

function initializeTheme(state, profile, numberConfig) {
    state.themeIndex = Math.floor(Math.random() * profile.themes.length);
    state.theme = profile.themes[state.themeIndex];
    state.themeNextSwitch = Date.now() + getThemeIntervalMs(profile, numberConfig);
}

function spawnOneNumber(state, mapRadius, players, generateNumber, numberConfig) {
    const position = trySpawnPosition(state, mapRadius, players, numberConfig);

    if (!position) {
        return null;
    }

    const numberData = generateNumber();
    const id = state.nextId++;

    state.numbers.set(id, {
        id,
        x: position.x,
        y: position.y,
        display: numberData.display,
        value: numberData.value,
        sets: numberData.sets,
        colorSeed: Math.floor(Math.random() * COLOR_SEED_RANGE),
        version: 1
    });

    return id;
}

function trySpawnPosition(state, mapRadius, players, numberConfig) {
    const limit = mapRadius * numberConfig.spawnRadiusRatio;

    for (let attempt = 0; attempt < numberConfig.maxSpawnAttempts; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * limit;
        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance;

        if (!isPositionFarFromNumbers(state, x, y, numberConfig)) {
            continue;
        }

        if (!isPositionFarFromPlayers(x, y, players, numberConfig)) {
            continue;
        }

        return { x, y };
    }

    return null;
}

function isPositionFarFromNumbers(state, x, y, numberConfig) {
    const minimumDistanceSquared = numberConfig.minDistanceBetween ** 2;

    for (const number of state.numbers.values()) {
        const deltaX = number.x - x;
        const deltaY = number.y - y;

        if (deltaX * deltaX + deltaY * deltaY < minimumDistanceSquared) {
            return false;
        }
    }

    return true;
}

function isPositionFarFromPlayers(x, y, players, numberConfig) {
    const minimumDistanceSquared = numberConfig.minDistanceFromPlayer ** 2;

    for (const player of players.values()) {
        const deltaX = player.x - x;
        const deltaY = player.y - y;

        if (deltaX * deltaX + deltaY * deltaY < minimumDistanceSquared) {
            return false;
        }
    }

    return true;
}

function updateNumbers(state, players, mapRadius, nowMs, generateNumber, profile, numberConfig) {
    let themeChanged = false;

    if (nowMs >= state.themeNextSwitch) {
        state.themeIndex = (state.themeIndex + 1) % profile.themes.length;
        state.theme = profile.themes[state.themeIndex];
        state.themeNextSwitch = nowMs + getThemeIntervalMs(profile, numberConfig);
        themeChanged = true;
    }

    while (hasPendingRespawns(state) && state.pending[state.pendingHead].spawnAt <= nowMs) {
        state.pendingHead++;

        if (state.numbers.size < numberConfig.maxNumbers) {
            spawnOneNumber(state, mapRadius, players, generateNumber, numberConfig);
        }
    }

    compactPendingRespawns(state);

    if (state.numbers.size < numberConfig.maxNumbers && !hasPendingRespawns(state)) {
        spawnOneNumber(state, mapRadius, players, generateNumber, numberConfig);
    }

    const collisions = [];
    const playerRadius = config.world.playerSize / 2;
    const combinedRadiusSquared = (numberConfig.radius + playerRadius) ** 2;

    for (const [numberId, number] of state.numbers) {
        for (const player of players.values()) {
            const deltaX = player.x - number.x;
            const deltaY = player.y - number.y;

            if (deltaX * deltaX + deltaY * deltaY < combinedRadiusSquared) {
                collisions.push({
                    numberId,
                    playerId: player.id,
                    display: number.display,
                    value: number.value,
                    sets: [...number.sets],
                    belongsToTheme: state.theme ? state.theme.check(number) : false
                });
                state.numbers.delete(numberId);
                state.pending.push({ spawnAt: nowMs + numberConfig.respawnDelaySec * 1000 });
                break;
            }
        }
    }

    return { collisions, themeChanged };
}

function hasPendingRespawns(state) {
    return state.pendingHead < state.pending.length;
}

function compactPendingRespawns(state) {
    if (state.pendingHead === 0) {
        return;
    }

    if (state.pendingHead >= state.pending.length) {
        state.pending.length = 0;
        state.pendingHead = 0;
        return;
    }

    if (state.pendingHead >= 64 && state.pendingHead * 2 >= state.pending.length) {
        state.pending = state.pending.slice(state.pendingHead);
        state.pendingHead = 0;
    }
}

function serializeNumbers(state) {
    const numbers = [];

    for (const number of state.numbers.values()) {
        numbers.push([
            number.id,
            Math.round(number.x),
            Math.round(number.y),
            number.display,
            Number(number.value.toFixed(4)),
            number.colorSeed
        ]);
    }

    return {
        nums: numbers,
        theme: state.theme ? {
            id: state.theme.id,
            label: state.theme.label,
            emoji: state.theme.emoji,
            description: state.theme.description,
            operator: state.theme.operator || null,
            operands: state.theme.operands || null
        } : null,
        themeEndsIn: Math.max(0, Math.round((state.themeNextSwitch - Date.now()) / 1000))
    };
}

function getThemeIntervalMs(profile, numberConfig) {
    return profile.themeIntervalSec * numberConfig.themeIntervalMultiplier * 1000;
}

function getPositiveNumber(value, fallback) {
    const numericValue = Number(value);

    return Number.isFinite(numericValue) && numericValue > 0
        ? numericValue
        : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

module.exports = {
    createNumberSystem
};
