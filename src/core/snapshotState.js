function getSocketSnapshotEpoch(socket) {
    if (!socket || !socket.data) {
        return "socket:1";
    }

    if (
        !Number.isSafeInteger(socket.data.snapshotEpochGeneration)
        || socket.data.snapshotEpochGeneration < 1
    ) {
        socket.data.snapshotEpochGeneration = 1;
    }

    if (typeof socket.data.snapshotEpoch !== "string" || !socket.data.snapshotEpoch) {
        socket.data.snapshotEpoch = createSnapshotEpochToken(
            socket,
            socket.data.snapshotEpochGeneration
        );
    }

    return socket.data.snapshotEpoch;
}

function resetSocketSnapshotState(socket) {
    if (!socket || !socket.data) {
        return null;
    }

    const currentGeneration = Number.isSafeInteger(socket.data.snapshotEpochGeneration)
        ? socket.data.snapshotEpochGeneration
        : 0;

    socket.data.snapshotEpochGeneration = currentGeneration + 1;
    socket.data.snapshotEpoch = createSnapshotEpochToken(
        socket,
        socket.data.snapshotEpochGeneration
    );
    socket.data.snapshotState = null;
    socket.data.pendingReliableSnapshot = null;
    return socket.data.snapshotEpoch;
}

function createSnapshotEpochToken(socket, generation) {
    const socketId = typeof socket.id === "string" && socket.id
        ? socket.id
        : "socket";

    return `${socketId}:${generation}`;
}

module.exports = {
    getSocketSnapshotEpoch,
    resetSocketSnapshotState
};
