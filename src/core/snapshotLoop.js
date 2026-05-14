const config = require("../config/gameConfig");
const { createSnapshot } = require("./snapshotSerializer");

function startSnapshotLoop(io, players) {
    const intervalMs = 1000 / config.loop.snapshotRate;

    return setInterval(() => {
        sendSnapshot(io, players);
    }, intervalMs);
}

function sendSnapshot(io, players) {
    io.volatile.emit("gameState", createSnapshot(players));
}

module.exports = startSnapshotLoop;
module.exports.sendSnapshot = sendSnapshot;
