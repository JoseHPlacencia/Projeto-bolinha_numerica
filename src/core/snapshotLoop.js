const config = require("../config/gameConfig");
const {
    cloneClientSnapshotState,
    createClientSnapshotState,
    createSnapshot
} = require("./snapshotSerializer");
const { getHighResolutionTime, getServerTime } = require("../utils/time");

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
            sendVolatileSnapshotWhileReliablePending(socket, players, territories);
            continue;
        }

        const nextSnapshotState = cloneClientSnapshotState(socket.data.snapshotState);
        const snapshot = createTimedSnapshot(players, territories, socket.id, nextSnapshotState);

        if (shouldSendReliably(snapshot)) {
            queueReliableSnapshot(socket, snapshot, nextSnapshotState);
            continue;
        }

        socket.data.snapshotState = nextSnapshotState;
        prepareSnapshotTimingForEmit(snapshot, "volatile");
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

function sendVolatileSnapshotWhileReliablePending(socket, players, territories) {
    if (config.network.volatileSnapshotsWhileReliablePendingEnabled === false) {
        return;
    }

    const clientState = socket.data.snapshotState || createClientSnapshotState();
    const temporaryState = cloneClientSnapshotState(clientState);
    const snapshot = createTimedSnapshot(players, territories, socket.id, temporaryState);
    const volatileSnapshot = createVolatileSnapshotForPendingReliableState(snapshot, clientState);

    prepareSnapshotTimingForEmit(volatileSnapshot, "volatile-pending");
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
        timing: undefined,
        preserveTrails: true
    };
}

function filterKnownIds(ids, knownStates) {
    return (ids || []).filter(id => knownStates && knownStates.has(id));
}

function queueReliableSnapshot(socket, snapshot, nextSnapshotState) {
    const pending = {
        id: getNextReliableSnapshotId(socket),
        attempts: 0,
        queuedAt: getServerTime(),
        nextRetryAt: 0,
        snapshot,
        snapshotState: nextSnapshotState
    };

    socket.data.pendingReliableSnapshot = pending;
    sendReliableSnapshot(socket, pending);
}

function sendReliableSnapshot(socket, pending) {
    pending.attempts++;
    pending.nextRetryAt = Date.now() + getReliableSnapshotRetryMs();
    prepareSnapshotTimingForEmit(pending.snapshot, "reliable", pending);

    const emitter = typeof socket.timeout === "function"
        ? socket.timeout(getReliableSnapshotAckTimeoutMs())
        : socket;

    emitter.emit("gameState", pending.snapshot, (error, acknowledgement) => {
        if (error) {
            return;
        }

        acknowledgeReliableSnapshot(socket, pending.id, acknowledgement);
    });
}

function acknowledgeReliableSnapshot(socket, pendingId, acknowledgement = { applied: true }) {
    const pending = socket.data.pendingReliableSnapshot;

    if (!pending || pending.id !== pendingId) {
        return;
    }

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
    if (!snapshotState || !invalidations) {
        return;
    }

    invalidateMapEntries(snapshotState.playerInfo, invalidations.playerInfo);
    invalidateMapEntries(snapshotState.territories, invalidations.territories);
    invalidateMapEntries(snapshotState.trails, invalidations.trails);

    if (Array.isArray(invalidations.territories) && invalidations.territories.length > 0) {
        snapshotState.territoryPoints.clear();
        snapshotState.nextTerritoryPointId = 1;
    }
}

function invalidateMapEntries(map, ids) {
    if (!map || !Array.isArray(ids)) {
        return;
    }

    for (const id of ids) {
        if (typeof id === "string" && id.length > 0 && id.length <= 128) {
            map.delete(id);
        }
    }
}

function createTimedSnapshot(players, territories, viewerId, nextSnapshotState) {
    const startedAt = getHighResolutionTime();
    const serverSnapshotStartedAt = getServerTime();
    const snapshot = createSnapshot(players, territories, viewerId, nextSnapshotState);
    const serverSnapshotReadyAt = getServerTime();

    attachSnapshotTiming(snapshot, {
        serverSnapshotStartedAt,
        serverSnapshotReadyAt,
        serverSerializeMs: getHighResolutionTime() - startedAt
    });

    return snapshot;
}

function attachSnapshotTiming(snapshot, timing) {
    if (!shouldAttachSnapshotTiming(snapshot)) {
        return;
    }

    snapshot.timing = {
        serverSnapshotStartedAt: timing.serverSnapshotStartedAt,
        serverSnapshotReadyAt: timing.serverSnapshotReadyAt,
        serverSerializeMs: roundTimingMs(timing.serverSerializeMs)
    };
}

function prepareSnapshotTimingForEmit(snapshot, delivery, pending = null) {
    if (!snapshot || !snapshot.timing) {
        return;
    }

    const serverEmitAt = getServerTime();

    snapshot.timing.serverEmitAt = serverEmitAt;
    snapshot.timing.delivery = delivery;
    snapshot.timing.serverReadyToEmitMs = roundTimingMs(serverEmitAt - snapshot.timing.serverSnapshotReadyAt);
    snapshot.timing.serverSnapshotToEmitMs = roundTimingMs(serverEmitAt - snapshot.timing.serverSnapshotStartedAt);

    if (pending) {
        snapshot.timing.reliableId = pending.id;
        snapshot.timing.reliableAttempt = pending.attempts;
        snapshot.timing.reliableQueuedAt = pending.queuedAt;
        snapshot.timing.reliableQueueMs = roundTimingMs(serverEmitAt - pending.queuedAt);
    }

    snapshot.timing.payloadBytes = estimateSnapshotBytes(snapshot);
}

function shouldAttachSnapshotTiming(snapshot) {
    return config.network.captureTimingDiagnosticsEnabled !== false
        && snapshot
        && (
            hasEntries(snapshot.territoryOps)
            || hasEntries(snapshot.territories)
        );
}

function estimateSnapshotBytes(snapshot) {
    try {
        return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    } catch (_error) {
        return null;
    }
}

function roundTimingMs(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
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
module.exports.acknowledgeReliableSnapshot = acknowledgeReliableSnapshot;
module.exports.invalidateSnapshotCache = invalidateSnapshotCache;
module.exports.queueReliableSnapshot = queueReliableSnapshot;
module.exports.sendSnapshot = sendSnapshot;
module.exports.shouldSendReliably = shouldSendReliably;
