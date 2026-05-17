const { getServerTime } = require("../utils/time");
const { serializeTerritories } = require("../state/territories");
const { serializeTrails } = require("../systems/trailSystem");

function createSnapshot(players, territories) {
    return {
        time: getServerTime(),
        players: serializePlayers(players),
        territories: serializeTerritories(territories, players),
        trails: serializeTrails(players)
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
