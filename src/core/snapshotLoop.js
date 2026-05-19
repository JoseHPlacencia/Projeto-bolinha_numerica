const config = require("../config/gameConfig");
const {
    createClientSnapshotState,
    createSnapshot
} = require("./snapshotSerializer");

function startSnapshotLoop(io, players, territories) {
    const intervalMs = 1000 / config.loop.snapshotRate;

    return setInterval(() => {
        sendSnapshot(io, players, territories);
    }, intervalMs);
}

function sendSnapshot(io, players, territories) {
    for (const socket of io.sockets.sockets.values()) {
        if (!players.has(socket.id)) {
            continue;
        }

        if (!socket.data.snapshotState) {
            socket.data.snapshotState = createClientSnapshotState();
        }

        const snapshot = createSnapshot(players, territories, socket.id, socket.data.snapshotState);
        const emitter = shouldSendReliably(snapshot) ? socket : socket.volatile;

        emitter.emit("gameState", snapshot);
    }
}

function shouldSendReliably(snapshot) {
    return hasEntries(snapshot.playerInfo)
        || hasEntries(snapshot.territories)
        || hasFullTrailUpdate(snapshot.trails);
}

function hasEntries(value) {
    return value && Object.keys(value).length > 0;
}

function hasFullTrailUpdate(trails) {
    return Object.values(trails || {}).some(trail => trail && trail.full);
}

module.exports = startSnapshotLoop;
module.exports.sendSnapshot = sendSnapshot;
module.exports.shouldSendReliably = shouldSendReliably;
