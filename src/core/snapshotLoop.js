const config = require("../config/gameConfig");
const { createSnapshot } = require("./snapshotSerializer");

function startRoomSnapshotLoop(io, room) {
    const intervalMs = 1000 / config.loop.snapshotRate;

    return setInterval(() => {
        sendRoomSnapshot(io, room);
    }, intervalMs);
}

function sendRoomSnapshot(io, room) {
    io.to(room.code).volatile.emit("gameState", createSnapshot(room.players));
}

module.exports = {
    startRoomSnapshotLoop,
    sendRoomSnapshot
};
