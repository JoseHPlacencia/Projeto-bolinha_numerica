const config = require("../config/gameConfig");
const {
    cloneClientSnapshotState,
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

        if (retryPendingReliableSnapshot(socket)) {
            continue;
        }

        const nextSnapshotState = cloneClientSnapshotState(socket.data.snapshotState);
        const snapshot = createSnapshot(players, territories, socket.id, nextSnapshotState);

        if (shouldSendReliably(snapshot)) {
            queueReliableSnapshot(socket, snapshot, nextSnapshotState);
            continue;
        }

        socket.data.snapshotState = nextSnapshotState;
        socket.volatile.emit("gameState", snapshot);
    }
}

function retryPendingReliableSnapshot(socket) {
    const pending = socket.data.pendingReliableSnapshot;

    if (!pending) {
        return false;
    }

    if (Date.now() >= pending.nextRetryAt) {
        sendReliableSnapshot(socket, pending);
    }

    return true;
}

function queueReliableSnapshot(socket, snapshot, nextSnapshotState) {
    const pending = {
        id: getNextReliableSnapshotId(socket),
        nextRetryAt: 0,
        snapshot,
        snapshotState: nextSnapshotState
    };

    socket.data.pendingReliableSnapshot = pending;
    sendReliableSnapshot(socket, pending);
}

function sendReliableSnapshot(socket, pending) {
    pending.nextRetryAt = Date.now() + getReliableSnapshotRetryMs();

    const emitter = typeof socket.timeout === "function"
        ? socket.timeout(getReliableSnapshotAckTimeoutMs())
        : socket;

    emitter.emit("gameState", pending.snapshot, error => {
        if (error) {
            return;
        }

        acknowledgeReliableSnapshot(socket, pending.id);
    });
}

function acknowledgeReliableSnapshot(socket, pendingId) {
    const pending = socket.data.pendingReliableSnapshot;

    if (!pending || pending.id !== pendingId) {
        return;
    }

    socket.data.snapshotState = pending.snapshotState;
    socket.data.pendingReliableSnapshot = null;
}

function getNextReliableSnapshotId(socket) {
    const nextId = (socket.data.nextReliableSnapshotId || 0) + 1;

    socket.data.nextReliableSnapshotId = nextId;

    return nextId;
}

function getReliableSnapshotAckTimeoutMs() {
    return Math.max(100, config.network.reliableSnapshotAckTimeoutMs || 1000);
}

function getReliableSnapshotRetryMs() {
    return Math.max(getReliableSnapshotAckTimeoutMs(), config.network.reliableSnapshotRetryMs || 1500);
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
module.exports.acknowledgeReliableSnapshot = acknowledgeReliableSnapshot;
module.exports.queueReliableSnapshot = queueReliableSnapshot;
module.exports.sendSnapshot = sendSnapshot;
module.exports.shouldSendReliably = shouldSendReliably;
