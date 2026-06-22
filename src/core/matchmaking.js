const config = require("../config/gameConfig");
const { getHumanPlayerCount } = require("../systems/botSystem");

function getPublicMatchCandidates(rooms, rawDifficulty, options = {}) {
    const difficulty = normalizeDifficulty(rawDifficulty);
    const maxPlayers = normalizeMaxPlayers(options.maxPlayers);

    return Array.from(rooms && rooms.values ? rooms.values() : [])
        .map(room => ({
            humanPlayerCount: getRoomHumanPlayerCount(room),
            room
        }))
        .filter(candidate => isPublicMatchCandidate(
            candidate.room,
            candidate.humanPlayerCount,
            difficulty,
            maxPlayers
        ))
        .sort(compareCandidates)
        .map(candidate => candidate.room);
}

function isPublicMatchCandidate(room, humanPlayerCount, difficulty, maxPlayers) {
    const roomMaxPlayers = normalizeMaxPlayers(
        room && room.maxPlayers !== undefined
            ? room.maxPlayers
            : room && room.runtimeConfig && room.runtimeConfig.customOptions
                ? room.runtimeConfig.customOptions.maxPlayers
                : maxPlayers
    );

    return Boolean(room)
        && !room.hiddenFromList
        && !room.isPrivate
        && !room.isSystemRoom
        && normalizeDifficulty(room.difficulty) === difficulty
        && humanPlayerCount < roomMaxPlayers;
}

function compareCandidates(first, second) {
    if (second.humanPlayerCount !== first.humanPlayerCount) {
        return second.humanPlayerCount - first.humanPlayerCount;
    }

    return getCreatedAt(first.room) - getCreatedAt(second.room);
}

function getRoomHumanPlayerCount(room) {
    return room && room.players instanceof Map
        ? getHumanPlayerCount(room.players)
        : 0;
}

function getCreatedAt(room) {
    const createdAt = Number(room && room.createdAt);
    return Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER;
}

function normalizeDifficulty(rawDifficulty) {
    const difficulty = String(rawDifficulty || "").trim().toLowerCase();
    return difficulty === "easy" || difficulty === "hard" ? difficulty : "medium";
}

function normalizeMaxPlayers(rawMaxPlayers) {
    const configuredMaxPlayers = Number(config.rooms.maxPlayersPerRoom);
    const maxPlayers = Number(rawMaxPlayers);

    if (Number.isInteger(maxPlayers) && maxPlayers > 0) {
        return maxPlayers;
    }

    return Number.isInteger(configuredMaxPlayers) && configuredMaxPlayers > 0
        ? configuredMaxPlayers
        : 1;
}

module.exports = {
    getPublicMatchCandidates
};
