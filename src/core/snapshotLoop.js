const config = require("../config/gameConfig");
const { createSnapshot } = require("./snapshotSerializer");

function startSnapshotLoop(io, players, territories) {
    const intervalMs = 1000 / config.loop.snapshotRate;

    return setInterval(() => {
        sendSnapshot(io, players, territories);
    }, intervalMs);
}

function sendSnapshot(io, players, territories) {
    io.volatile.emit("gameState", createSnapshot(players, territories));
}

module.exports = startSnapshotLoop;
module.exports.sendSnapshot = sendSnapshot;
