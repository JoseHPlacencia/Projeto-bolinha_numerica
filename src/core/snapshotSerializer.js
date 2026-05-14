const { getServerTime } = require("../utils/time");

function createSnapshot(players) {
    return {
        time: getServerTime(),
        players: serializePlayers(players)
    };
}

function serializePlayers(players) {
    const serializedPlayers = {};

    for (const player of players.values()) {
        serializedPlayers[player.id] = player.serialize();
    }

    return serializedPlayers;
}

module.exports = {
    createSnapshot,
    serializePlayers
};
