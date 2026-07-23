"use strict";

const RESERVED_HUMAN_SLOTS = 2;
const SMALL_ROOM_UNRESERVED_SLOTS = 2;
const MAP_PLAYER_CAPACITIES = Object.freeze([
    Object.freeze({ mapSize: 0.5, maxPlayers: 4 }),
    Object.freeze({ mapSize: 0.75, maxPlayers: 9 }),
    Object.freeze({ mapSize: 1, maxPlayers: 16 }),
    Object.freeze({ mapSize: 1.5, maxPlayers: 25 }),
    Object.freeze({ mapSize: 2, maxPlayers: 36 })
]);

function calculateMapScaledPlayerLimit(rawMapSize, rawRequestedMaxPlayers, rawGlobalMaxPlayers) {
    const globalMaxPlayers = normalizeGlobalMaxPlayers(rawGlobalMaxPlayers);
    const requestedMaxPlayers = Math.max(
        1,
        Math.min(globalMaxPlayers, normalizeCount(rawRequestedMaxPlayers) || globalMaxPlayers)
    );
    const mapCapacity = calculateMapPlayerCapacity(rawMapSize, globalMaxPlayers);

    return Math.min(requestedMaxPlayers, mapCapacity);
}

function calculateMapPlayerCapacity(rawMapSize, rawGlobalMaxPlayers) {
    const mapSize = Number(rawMapSize);
    const globalMaxPlayers = normalizeGlobalMaxPlayers(rawGlobalMaxPlayers);
    const normalizedMapSize = Number.isFinite(mapSize) && mapSize > 0 ? mapSize : 1;
    const closest = MAP_PLAYER_CAPACITIES.reduce((best, candidate) => (
        Math.abs(candidate.mapSize - normalizedMapSize) < Math.abs(best.mapSize - normalizedMapSize)
            ? candidate
            : best
    ), MAP_PLAYER_CAPACITIES[2]);

    return Math.min(globalMaxPlayers, closest.maxPlayers);
}

function normalizeGlobalMaxPlayers(value) {
    return normalizeCount(value)
        || MAP_PLAYER_CAPACITIES[MAP_PLAYER_CAPACITIES.length - 1].maxPlayers;
}

/**
 * Keeps the final one or two positions available for humans without making
 * one- and two-player rooms incapable of starting with bots.
 */
function getReservedHumanSlotCount(rawMaxPlayers) {
    const maxPlayers = normalizeCount(rawMaxPlayers);

    return Math.min(
        RESERVED_HUMAN_SLOTS,
        Math.max(0, maxPlayers - SMALL_ROOM_UNRESERVED_SLOTS)
    );
}

function calculateActiveBotTarget(rawMaxPlayers, rawHumanCount, rawRequestedBotCount) {
    const maxPlayers = normalizeCount(rawMaxPlayers);
    const humanCount = Math.min(maxPlayers, normalizeCount(rawHumanCount));
    const requestedBotCount = normalizeCount(rawRequestedBotCount);
    const availableBotSlots = Math.max(
        0,
        maxPlayers - humanCount - getReservedHumanSlotCount(maxPlayers)
    );

    return Math.min(requestedBotCount, availableBotSlots);
}

function normalizeCount(value) {
    const count = Number(value);

    return Number.isInteger(count) && count > 0 ? count : 0;
}

module.exports = {
    calculateActiveBotTarget,
    calculateMapPlayerCapacity,
    calculateMapScaledPlayerLimit,
    getReservedHumanSlotCount
};
