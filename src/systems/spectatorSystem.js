const config = require("../config/gameConfig");
const { resetSocketSnapshotState } = require("../core/snapshotState");
const { calculatePolygonArea } = require("../utils/geometry");

function activateSpectator(
    socket,
    roomCode,
    players,
    territories,
    preferredFollowId = null,
    runtimeConfig = null
) {
    if (!socket || !roomCode) {
        return null;
    }

    socket.data.spectatorRoomCode = roomCode;
    socket.data.spectatorFollowId = resolveFollowId(
        players,
        territories,
        preferredFollowId,
        runtimeConfig
    );
    resetSocketSnapshotState(socket);

    return socket.data.spectatorFollowId;
}

function redirectSpectatorsAfterPlayerExit(
    io,
    roomCode,
    players,
    territories,
    exitedPlayerId,
    eliminatorId = null,
    runtimeConfig = null
) {
    if (!io || !roomCode || !exitedPlayerId) {
        return;
    }

    for (const socket of io.sockets.sockets.values()) {
        if (
            !socket.data
            || socket.data.spectatorRoomCode !== roomCode
            || socket.data.spectatorFollowId !== exitedPlayerId
        ) {
            continue;
        }

        socket.data.spectatorFollowId = resolveFollowId(
            players,
            territories,
            eliminatorId,
            runtimeConfig
        );
        resetSocketSnapshotState(socket);
    }
}

function resolveSpectatorFollowId(socket, players, territories, runtimeConfig = null) {
    const currentFollowId = socket && socket.data
        ? socket.data.spectatorFollowId
        : null;
    const followId = resolveFollowId(
        players,
        territories,
        currentFollowId,
        runtimeConfig
    );

    if (socket && socket.data && followId !== currentFollowId) {
        socket.data.spectatorFollowId = followId;
        resetSocketSnapshotState(socket);
    }

    return followId;
}

function resolveFollowId(
    players,
    territories,
    preferredFollowId = null,
    runtimeConfig = null
) {
    if (preferredFollowId && players.has(preferredFollowId)) {
        return preferredFollowId;
    }

    return pickHighestRankedPlayerId(players, territories, runtimeConfig);
}

function pickHighestRankedPlayerId(players, territories, runtimeConfig = null) {
    const worldConfig = runtimeConfig && runtimeConfig.world
        ? runtimeConfig.world
        : config.world;
    const totalArea = Math.PI * worldConfig.mapRadius * worldConfig.mapRadius;
    let highestRankedPlayer = null;
    let highestAreaPercent = Number.NEGATIVE_INFINITY;
    let highestEliminations = Number.NEGATIVE_INFINITY;

    for (const player of players.values()) {
        const territory = territories.get(player.id);
        const area = territory
            ? Math.max(0, calculatePolygonArea(territory.polygon))
            : 0;
        const areaPercent = totalArea > 0 ? area / totalArea * 100 : 0;
        const eliminations = Number(player.eliminations) || 0;

        if (
            areaPercent - highestAreaPercent > 0.001
            || (
                Math.abs(areaPercent - highestAreaPercent) <= 0.001
                && eliminations > highestEliminations
            )
        ) {
            highestRankedPlayer = player;
            highestAreaPercent = areaPercent;
            highestEliminations = eliminations;
        }
    }

    return highestRankedPlayer ? highestRankedPlayer.id : null;
}

module.exports = {
    activateSpectator,
    pickHighestRankedPlayerId,
    redirectSpectatorsAfterPlayerExit,
    resolveSpectatorFollowId
};
