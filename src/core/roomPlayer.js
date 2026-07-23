const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { initializePlayerTerritory } = require("../state/territories");

function initializeRoomPlayer(room, playerId, alreadyJoined, playerOptions = {}, spawn = null) {
    if (!room || !playerId) {
        return null;
    }

    if (alreadyJoined) {
        return room.players.get(playerId) || null;
    }

    const runtimeConfig = room.runtimeConfig || config;
    const player = createPlayer(room.players, playerId, room.territories, {
        ...playerOptions,
        maxLives: runtimeConfig.gameMode && runtimeConfig.gameMode.catch
            ? runtimeConfig.gameMode.catch.roomLives
            : null,
        runtimeConfig,
        spawn
    });

    if (!player) {
        return null;
    }

    initializePlayerTerritory(room.territories, player, runtimeConfig);
    room.botManager?.ensureBots();
    return player;
}

module.exports = {
    initializeRoomPlayer
};
