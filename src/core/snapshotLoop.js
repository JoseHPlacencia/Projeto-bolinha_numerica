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

        socket.volatile.emit(
            "gameState",
            createSnapshot(players, territories, socket.id, socket.data.snapshotState)
        );
    }
}

module.exports = startSnapshotLoop;
module.exports.sendSnapshot = sendSnapshot;
