"use strict";

const config = require("../../src/config/gameConfig");
const { calculateMapPlayerCapacity } = require("../../src/core/roomCapacity");

const DEFAULT_RAMP = Object.freeze([36, 72, 144]);

function createConnectionLoadPlan(options = {}) {
    const mapSize = finitePositive(options.mapSize, 2);
    const maximumArenaCapacity = calculateMapPlayerCapacity(
        mapSize,
        config.rooms.maxPlayersPerRoom
    );
    const arenaCapacity = integerInRange(
        options.arenaCapacity,
        maximumArenaCapacity,
        1,
        config.rooms.maxPlayersPerRoom,
        "arenaCapacity"
    );
    const maxRooms = integerInRange(
        options.maxRooms,
        config.rooms.maxRooms,
        1,
        config.rooms.maxRooms,
        "maxRooms"
    );

    if (arenaCapacity > maximumArenaCapacity) {
        throw new RangeError(
            `arenaCapacity ${arenaCapacity} exceeds the ${maximumArenaCapacity}-player limit `
            + `for a ${mapSize}x map.`
        );
    }

    const ramp = normalizeRamp(options.ramp, arenaCapacity * maxRooms);
    const stages = ramp.map((targetPlayers, index) => ({
        index: index + 1,
        rooms: createRoomAllocations(targetPlayers, arenaCapacity),
        targetPlayers
    }));

    return {
        arenaCapacity,
        mapSize,
        maxRooms,
        maximumArenaCapacity,
        maximumPlayers: arenaCapacity * maxRooms,
        stages
    };
}

function createRoomAllocations(totalPlayers, arenaCapacity) {
    const total = integerInRange(
        totalPlayers,
        undefined,
        1,
        Number.MAX_SAFE_INTEGER,
        "totalPlayers"
    );
    const capacity = integerInRange(
        arenaCapacity,
        undefined,
        1,
        Number.MAX_SAFE_INTEGER,
        "arenaCapacity"
    );
    const roomCount = Math.ceil(total / capacity);

    return Array.from({ length: roomCount }, (_unused, index) => ({
        index: index + 1,
        targetPlayers: Math.min(capacity, total - index * capacity)
    }));
}

function normalizeRamp(rawRamp, maximumPlayers) {
    const source = rawRamp === undefined ? DEFAULT_RAMP : rawRamp;
    const values = typeof source === "string"
        ? source.split(",").map(value => Number(value.trim()))
        : Array.isArray(source) ? source.map(Number) : [];

    if (values.length === 0) {
        throw new TypeError("ramp must contain at least one player target.");
    }

    let previous = 0;
    return values.map(value => {
        if (!Number.isInteger(value) || value < 1 || value > maximumPlayers) {
            throw new RangeError(
                `Every ramp target must be an integer from 1 to ${maximumPlayers}.`
            );
        }
        if (value <= previous) {
            throw new RangeError("Ramp targets must be strictly increasing.");
        }
        previous = value;
        return value;
    });
}

function integerInRange(value, fallback, minimum, maximum, name) {
    const candidate = value === undefined ? fallback : Number(value);

    if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
        throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return candidate;
}

function finitePositive(value, fallback) {
    const candidate = value === undefined ? fallback : Number(value);

    if (!Number.isFinite(candidate) || candidate <= 0) {
        throw new RangeError("mapSize must be a positive number.");
    }
    return candidate;
}

module.exports = {
    DEFAULT_RAMP,
    createConnectionLoadPlan,
    createRoomAllocations,
    normalizeRamp
};
