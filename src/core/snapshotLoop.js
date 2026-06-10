const config = require("../config/gameConfig");
const {
    cloneClientSnapshotState,
    createClientSnapshotState,
    createSnapshot
} = require("./snapshotSerializer");

function startSnapshotLoop(io, players, territories, roomCode, numberSystem, runtimeConfig = null) {
    const intervalMs = 1000 / config.loop.snapshotRate;

    return setInterval(() => {
        sendSnapshot(io, players, territories, roomCode, numberSystem, runtimeConfig);
    }, intervalMs);
}

function sendSnapshot(io, players, territories, roomCode, numberSystem, runtimeConfig = null) {
    for (const socket of io.sockets.sockets.values()) {
        const isPlayerSocket = roomCode && socket.data.roomCode === roomCode && players.has(socket.id);
        const isSpectatorSocket = roomCode && socket.data.spectatorRoomCode === roomCode;

        if (!isPlayerSocket && !isSpectatorSocket) {
            continue;
        }

        if (!socket.data.snapshotState) {
            socket.data.snapshotState = createClientSnapshotState();
        }

        const viewerId = isSpectatorSocket
            ? pickSpectatorFollowId(socket, players)
            : socket.id;

        if (!viewerId) {
            continue;
        }

        if (retryPendingReliableSnapshot(socket)) {
            sendVolatileSnapshotWhileReliablePending(socket, players, territories, numberSystem, viewerId, runtimeConfig);
            continue;
        }

        const nextSnapshotState = cloneClientSnapshotState(socket.data.snapshotState);
        const snapshot = createSnapshot(players, territories, viewerId, nextSnapshotState, numberSystem, runtimeConfig);

        if (isSpectatorSocket) {
            snapshot.spectator = { followId: viewerId };
        }

        if (shouldSendReliably(snapshot)) {
            queueReliableSnapshot(socket, snapshot, nextSnapshotState);
            continue;
        }

        socket.data.snapshotState = nextSnapshotState;
        socket.volatile.emit("gameState", snapshot);
    }
}

function pickSpectatorFollowId(socket, players) {
    const currentFollowId = socket.data && socket.data.spectatorFollowId;

    if (currentFollowId && players.has(currentFollowId)) {
        return currentFollowId;
    }

    for (const player of players.values()) {
        if (player && player.isBot) {
            socket.data.spectatorFollowId = player.id;
            return player.id;
        }
    }

    return null;
}

function retryPendingReliableSnapshot(socket) {
    const pending = socket.data.pendingReliableSnapshot;
    if (!pending) return false;
    if (Date.now() >= pending.nextRetryAt) {
        sendReliableSnapshot(socket, pending);
    }
    return true;
}

function sendVolatileSnapshotWhileReliablePending(socket, players, territories, numberSystem, viewerId, runtimeConfig = null) {
    if (config.network.volatileSnapshotsWhileReliablePendingEnabled === false) return;
    const clientState = socket.data.snapshotState || createClientSnapshotState();
    const temporaryState = cloneClientSnapshotState(clientState);
    const snapshot = createSnapshot(players, territories, viewerId, temporaryState, numberSystem, runtimeConfig);
    if (socket.data && socket.data.spectatorRoomCode) {
        snapshot.spectator = { followId: viewerId };
    }
    const volatileSnapshot = createVolatileSnapshotForPendingReliableState(snapshot, clientState);
    socket.volatile.emit("gameState", volatileSnapshot);
}

function createVolatileSnapshotForPendingReliableState(snapshot, clientState) {
    return {
        ...snapshot,
        playerInfo: {},
        territoryIds: filterKnownIds(snapshot.territoryIds, clientState.territories),
        territoryVersions: {},
        territories: {},
        territoryOps: {},
        trailIds: filterKnownIds(snapshot.trailIds, clientState.trails),
        trails: {},
        preserveTrails: true
    };
}

function filterKnownIds(ids, knownStates) {
    return (ids || []).filter(id => knownStates && knownStates.has(id));
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
    emitter.emit("gameState", pending.snapshot, (error, acknowledgement) => {
        if (error) return;
        acknowledgeReliableSnapshot(socket, pending.id, acknowledgement);
    });
}

function acknowledgeReliableSnapshot(socket, pendingId, acknowledgement = { applied: true }) {
    const pending = socket.data.pendingReliableSnapshot;
    if (!pending || pending.id !== pendingId) return;
    if (!acknowledgement || acknowledgement.applied !== false) {
        socket.data.snapshotState = pending.snapshotState;
        socket.data.pendingReliableSnapshot = null;
        return;
    }
    if (!hasAnyInvalidation(acknowledgement.invalidations)) {
        socket.data.snapshotState = null;
        socket.data.pendingReliableSnapshot = null;
        return;
    }
    socket.data.snapshotState = pending.snapshotState;
    invalidateSnapshotState(socket.data.snapshotState, acknowledgement.invalidations);
    socket.data.pendingReliableSnapshot = null;
}

function invalidateSnapshotCache(socket, invalidations) {
    if (!hasAnyInvalidation(invalidations)) {
        socket.data.snapshotState = null;
        if (socket.data.pendingReliableSnapshot) {
            socket.data.pendingReliableSnapshot = null;
        }
        return;
    }
    if (!socket.data.snapshotState) {
        socket.data.snapshotState = createClientSnapshotState();
    }
    invalidateSnapshotState(socket.data.snapshotState, invalidations);
    if (socket.data.pendingReliableSnapshot) {
        socket.data.pendingReliableSnapshot = null;
    }
}

function hasAnyInvalidation(invalidations) {
    return Boolean(invalidations)
        && (
            hasInvalidationIds(invalidations.playerInfo)
            || hasInvalidationIds(invalidations.territories)
            || hasInvalidationIds(invalidations.trails)
        );
}

function hasInvalidationIds(ids) {
    return Array.isArray(ids) && ids.length > 0;
}

function invalidateSnapshotState(snapshotState, invalidations) {
    if (!snapshotState || !invalidations) return;
    invalidateMapEntries(snapshotState.playerInfo, invalidations.playerInfo);
    invalidateMapEntries(snapshotState.territories, invalidations.territories);
    invalidateMapEntries(snapshotState.trails, invalidations.trails);
    if (Array.isArray(invalidations.territories) && invalidations.territories.length > 0) {
        snapshotState.territoryPoints.clear();
        snapshotState.nextTerritoryPointId = 1;
    }
}

function invalidateMapEntries(map, ids) {
    if (!map || !Array.isArray(ids)) return;
    for (const id of ids) {
        if (typeof id === "string" && id.length > 0 && id.length <= 128) {
            map.delete(id);
        }
    }
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
        || hasEntries(snapshot.territoryOps)
        || hasReliableTrailUpdate(snapshot.trails);
}

function hasEntries(value) {
    return value && Object.keys(value).length > 0;
}

function hasFullTrailUpdate(trails) {
    return Object.values(trails || {}).some(trail => trail && trail.full);
}

function hasReliableTrailUpdate(trails) {
    if (config.network.reliableTrailUpdatesEnabled !== false) {
        return hasEntries(trails);
    }
    return hasFullTrailUpdate(trails);
}

module.exports = startSnapshotLoop;
module.exports.startSnapshotLoop = startSnapshotLoop;
module.exports.acknowledgeReliableSnapshot = acknowledgeReliableSnapshot;
module.exports.invalidateSnapshotCache = invalidateSnapshotCache;
module.exports.queueReliableSnapshot = queueReliableSnapshot;
module.exports.sendSnapshot = sendSnapshot;
module.exports.shouldSendReliably = shouldSendReliably;
