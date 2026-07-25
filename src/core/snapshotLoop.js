const { performance } = require("node:perf_hooks");
const config = require("../config/gameConfig");
const {
    createSnapshot,
    createSnapshotSharedFrame
} = require("./snapshotSerializer");
const {
    createClientSnapshotState,
    createClientSnapshotStateDraft,
    materializeClientSnapshotStateDraft
} = require("./snapshotClientState");
const {
    getSocketSnapshotEpoch,
    resetSocketSnapshotState
} = require("./snapshotState");
const {
    getSocketSnapshotSchema,
    supportsSeparatedReliableState
} = require("./snapshotProtocol");
const {
    RELIABLE_GAME_STATE_EVENT,
    createTransientStateSnapshot
} = require("./snapshotChannels");
const {
    countArrayItems,
    countInvalidations,
    countObjectKeys,
    countPlayerPositions,
    createSnapshotBreakdown,
    isPayloadOutlier,
    measureSnapshotPayload
} = require("./snapshotPayloadDiagnostics");
const {
    cloneGameLoopDiagnostics,
    normalizeGameLoopDiagnostics
} = require("./snapshotGameLoopDiagnostics");
const { resolveSpectatorFollowId } = require("../systems/spectatorSystem");
const {
    getTerritoryOverlapRepairQueueDiagnostics
} = require("../state/territories");

function startSnapshotLoop(
    io,
    players,
    territories,
    roomCode,
    numberSystem,
    runtimeConfig = null,
    roomDiagnostics = null,
    options = {}
) {
    const snapshotRate = resolveSnapshotRate(options.snapshotRate);
    const intervalMs = 1000 / snapshotRate;
    const loopDiagnostics = {
        expectedIntervalMs: intervalMs,
        lastTickAt: null,
        snapshotRate,
        tick: 0,
        tickIntervalMs: null,
        tickDriftMs: null
    };

    return setInterval(() => {
        const tickAt = performance.now();
        loopDiagnostics.tick += 1;
        loopDiagnostics.tickIntervalMs = Number.isFinite(loopDiagnostics.lastTickAt)
            ? tickAt - loopDiagnostics.lastTickAt
            : null;
        loopDiagnostics.tickDriftMs = Number.isFinite(loopDiagnostics.tickIntervalMs)
            ? loopDiagnostics.tickIntervalMs - intervalMs
            : null;
        loopDiagnostics.lastTickAt = tickAt;

        sendSnapshot(io, players, territories, roomCode, numberSystem, runtimeConfig, loopDiagnostics, roomDiagnostics);
    }, intervalMs);
}

function resolveSnapshotRate(rawSnapshotRate) {
    return Number.isInteger(rawSnapshotRate) && rawSnapshotRate > 0
        ? rawSnapshotRate
        : config.loop.snapshotRate;
}

function sendSnapshot(io, players, territories, roomCode, numberSystem, runtimeConfig = null, loopDiagnostics = null, roomDiagnostics = null) {
    const deferTerritoryGeometry = shouldDeferTerritoryGeometry(territories);
    let sharedFrame = null;
    const getSharedFrame = () => {
        if (!sharedFrame) {
            sharedFrame = createSnapshotSharedFrame(
                players,
                territories,
                numberSystem,
                runtimeConfig
            );
        }
        return sharedFrame;
    };

    for (const socket of getRoomSockets(io, roomCode)) {
        const isPlayerSocket = roomCode && socket.data.roomCode === roomCode && players.has(socket.id);
        const isSpectatorSocket = roomCode && socket.data.spectatorRoomCode === roomCode;

        if (!isPlayerSocket && !isSpectatorSocket) {
            continue;
        }

        const viewerId = isSpectatorSocket
            ? resolveSpectatorFollowId(socket, players, territories, runtimeConfig)
            : socket.id;

        if (!viewerId) {
            continue;
        }

        if (!socket.data.snapshotState) {
            socket.data.snapshotState = createSocketSnapshotState(socket);
        }

        if (retryPendingReliableSnapshot(socket)) {
            sendVolatileSnapshotWhileReliablePending(
                socket,
                players,
                territories,
                numberSystem,
                viewerId,
                runtimeConfig,
                loopDiagnostics,
                roomDiagnostics,
                getSharedFrame()
            );
            continue;
        }

        if (deferTerritoryGeometry) {
            sendVolatileSnapshotWithoutReliableGeometry(
                socket,
                players,
                territories,
                numberSystem,
                viewerId,
                runtimeConfig,
                loopDiagnostics,
                roomDiagnostics,
                "volatile-territory-repair",
                null,
                getSharedFrame()
            );
            continue;
        }

        const stateDraftStartedAt = isNetworkDiagnosticsEnabled(socket)
            ? performance.now()
            : null;
        const nextSnapshotState = createClientSnapshotStateDraft(socket.data.snapshotState);
        const stateDraftMs = stateDraftStartedAt === null
            ? null
            : performance.now() - stateDraftStartedAt;
        const measuredSnapshot = createMeasuredSnapshot(
            players,
            territories,
            viewerId,
            nextSnapshotState,
            numberSystem,
            runtimeConfig,
            isNetworkDiagnosticsEnabled(socket),
            getSharedFrame()
        );
        measuredSnapshot.stateDraftMs = stateDraftMs;
        const snapshot = measuredSnapshot.snapshot;
        assignSnapshotSequence(socket, snapshot);
        const sendDiagnostics = createSnapshotSendDiagnostics(measuredSnapshot, loopDiagnostics, roomDiagnostics);

        if (isSpectatorSocket) {
            snapshot.spectator = { followId: viewerId };
        }

        if (shouldSendReliably(snapshot)) {
            queueReliableSnapshot(
                socket,
                snapshot,
                nextSnapshotState,
                sendDiagnostics
            );
            continue;
        }

        socket.data.snapshotState = materializeSnapshotState(
            socket,
            nextSnapshotState,
            sendDiagnostics
        );
        emitVolatileSnapshot(socket, snapshot, "volatile", null, sendDiagnostics);
    }
}

function getRoomSockets(io, roomCode) {
    if (io && typeof io.getRoomSockets === "function") {
        return io.getRoomSockets(roomCode);
    }

    const sockets = io && io.sockets && io.sockets.sockets;
    return sockets && typeof sockets.values === "function" ? sockets.values() : [];
}

function retryPendingReliableSnapshot(socket) {
    const pending = socket.data.pendingReliableSnapshot;
    if (!pending) return false;
    if (Date.now() >= pending.nextRetryAt) {
        sendReliableSnapshot(socket, pending);
    }
    return true;
}

function sendVolatileSnapshotWhileReliablePending(
    socket,
    players,
    territories,
    numberSystem,
    viewerId,
    runtimeConfig = null,
    loopDiagnostics = null,
    roomDiagnostics = null,
    sharedFrame = null
) {
    if (config.network.volatileSnapshotsWhileReliablePendingEnabled === false) return;
    sendVolatileSnapshotWithoutReliableGeometry(
        socket,
        players,
        territories,
        numberSystem,
        viewerId,
        runtimeConfig,
        loopDiagnostics,
        roomDiagnostics,
        "volatile-pending",
        socket.data.pendingReliableSnapshot,
        sharedFrame
    );
}

function sendVolatileSnapshotWithoutReliableGeometry(
    socket,
    players,
    territories,
    numberSystem,
    viewerId,
    runtimeConfig,
    loopDiagnostics,
    roomDiagnostics,
    sendType,
    pending = null,
    sharedFrame = null
) {
    const clientState = socket.data.snapshotState || createSocketSnapshotState(socket);
    const stateDraftStartedAt = isNetworkDiagnosticsEnabled(socket)
        ? performance.now()
        : null;
    const temporaryState = createClientSnapshotStateDraft(clientState);
    const stateDraftMs = stateDraftStartedAt === null
        ? null
        : performance.now() - stateDraftStartedAt;
    const measuredSnapshot = createMeasuredSnapshot(
        players,
        territories,
        viewerId,
        temporaryState,
        numberSystem,
        runtimeConfig,
        isNetworkDiagnosticsEnabled(socket),
        sharedFrame
    );
    measuredSnapshot.stateDraftMs = stateDraftMs;
    const snapshot = measuredSnapshot.snapshot;
    assignSnapshotSequence(socket, snapshot);
    const sendDiagnostics = createSnapshotSendDiagnostics(measuredSnapshot, loopDiagnostics, roomDiagnostics);

    if (socket.data && socket.data.spectatorRoomCode) {
        snapshot.spectator = { followId: viewerId };
    }
    const volatileSnapshot = createVolatileSnapshotForPendingReliableState(snapshot, clientState);
    emitVolatileSnapshot(socket, volatileSnapshot, sendType, pending, sendDiagnostics);
}

function shouldDeferTerritoryGeometry(territories) {
    const diagnostics = getTerritoryOverlapRepairQueueDiagnostics(territories);

    return diagnostics.pendingItems > 0
        || diagnostics.inFlightPairs > 0
        || diagnostics.completedJobs > 0
        || diagnostics.refreshRequests > 0;
}

function createVolatileSnapshotForPendingReliableState(snapshot, clientState) {
    const separatedReliableState = supportsSeparatedReliableState(snapshot.schema);
    const volatileSnapshot = {
        ...snapshot,
        playerInfo: {},
        territoryIds: separatedReliableState
            ? snapshot.territoryIds
            : filterKnownIds(snapshot.territoryIds, clientState.territories),
        territoryVersions: {},
        territories: {},
        territoryOps: {},
        removedTerritoryIds: [],
        trailIds: separatedReliableState
            ? snapshot.trailIds
            : filterKnownIds(snapshot.trailIds, clientState.trails),
        trails: {},
        removedTrailIds: [],
        trailRemovals: {},
        payloadBudget: null,
        preserveTrails: true
    };

    if (volatileSnapshot.schema >= 3) {
        delete volatileSnapshot.leaderboard;
        delete volatileSnapshot.mode;
        delete volatileSnapshot.roomConfig;
    }

    return volatileSnapshot;
}

function filterKnownIds(ids, knownStates) {
    return (ids || []).filter(id => knownStates && knownStates.has(id));
}

function assignSnapshotSequence(socket, snapshot) {
    if (!socket || !socket.data || !snapshot) {
        return null;
    }

    const previousSequence = Number.isSafeInteger(socket.data.snapshotSequence)
        ? socket.data.snapshotSequence
        : 0;
    const sequence = previousSequence + 1;

    socket.data.snapshotSequence = sequence;
    snapshot.sequence = sequence;
    snapshot.snapshotEpoch = getSocketSnapshotEpoch(socket);
    return sequence;
}

function queueReliableSnapshot(socket, snapshot, nextSnapshotState, sendDiagnostics = null) {
    const pending = {
        createdAt: Date.now(),
        epoch: snapshot.snapshotEpoch,
        id: getNextReliableSnapshotId(socket),
        lastSentAt: null,
        nextRetryAt: 0,
        sentCount: 0,
        sendDiagnostics,
        snapshot,
        snapshotState: nextSnapshotState
    };
    socket.data.pendingReliableSnapshot = pending;
    sendReliableSnapshot(socket, pending);
    return pending;
}

function sendReliableSnapshot(socket, pending) {
    const sendType = pending.sentCount > 0 ? "reliable-retry" : "reliable";
    pending.sentCount++;
    pending.lastSentAt = Date.now();
    pending.nextRetryAt = pending.lastSentAt + getReliableSnapshotRetryMs();
    const emitter = typeof socket.timeout === "function"
        ? socket.timeout(getReliableSnapshotAckTimeoutMs())
        : socket;
    const separatedReliableState = supportsSeparatedReliableState(
        pending.snapshot && pending.snapshot.schema
    );
    const eventName = separatedReliableState
        ? RELIABLE_GAME_STATE_EVENT
        : "gameState";
    const payload = pending.snapshot;

    emitter.emit(eventName, createSnapshotForNetworkSend(
        socket,
        payload,
        sendType,
        pending,
        pending.sendDiagnostics,
        separatedReliableState ? "reliable-state" : "game-state"
    ), (error, acknowledgement) => {
        if (error) {
            pending.ackTimeouts = (pending.ackTimeouts || 0) + 1;
            pending.lastAckErrorAt = Date.now();
            return;
        }
        acknowledgeReliableSnapshot(socket, pending.id, acknowledgement, pending.epoch);
    });
}

function acknowledgeReliableSnapshot(socket, pendingId, acknowledgement = { applied: true }, pendingEpoch = null) {
    const pending = socket.data.pendingReliableSnapshot;
    const currentEpoch = getSocketSnapshotEpoch(socket);

    if (
        !pending
        || pending.id !== pendingId
        || (pendingEpoch !== null && pending.epoch !== pendingEpoch)
        || (pending.epoch !== null && pending.epoch !== currentEpoch)
    ) {
        return;
    }

    recordReliableSnapshotAcknowledgement(socket, pending, acknowledgement);
    if (!acknowledgement || acknowledgement.applied !== false) {
        socket.data.snapshotState = materializeSnapshotState(
            socket,
            pending.snapshotState,
            null,
            pending.id
        );
        socket.data.pendingReliableSnapshot = null;
        return;
    }
    if (!hasAnyInvalidation(acknowledgement.invalidations)) {
        resetSocketSnapshotState(socket);
        return;
    }
    socket.data.snapshotState = materializeSnapshotState(
        socket,
        pending.snapshotState,
        null,
        pending.id
    );
    invalidateSnapshotState(socket.data.snapshotState, acknowledgement.invalidations);
    socket.data.pendingReliableSnapshot = null;
}

function emitVolatileSnapshot(socket, snapshot, sendType, pending = null, sendDiagnostics = null) {
    const transientSnapshot = createTransientStateSnapshot(snapshot);
    const payload = createSnapshotForNetworkSend(
        socket,
        transientSnapshot,
        sendType,
        pending,
        sendDiagnostics
    );
    socket.volatile.emit("gameState", payload);
}

function createSnapshotForNetworkSend(
    socket,
    snapshot,
    sendType,
    pending = null,
    sendDiagnostics = null,
    diagnosticChannel = "game-state"
) {
    if (!isNetworkDiagnosticsEnabled(socket)) {
        return snapshot;
    }

    return {
        ...snapshot,
        networkDiagnostics: createNetworkDiagnosticsSnapshot(
            socket,
            snapshot,
            sendType,
            pending,
            sendDiagnostics,
            diagnosticChannel
        )
    };
}

function createNetworkDiagnosticsSnapshot(
    socket,
    snapshot,
    sendType,
    pending = null,
    sendDiagnostics = null,
    diagnosticChannel = "game-state"
) {
    const payloadMeasurement = measureSnapshotPayload(snapshot);
    const snapshotBreakdown = createSnapshotBreakdown(snapshot, {
        includePayloadOutlier: isPayloadOutlier(payloadMeasurement.bytes),
        payloadBytes: payloadMeasurement.bytes
    });
    const now = Date.now();
    const previousSentAt = Number.isFinite(socket.data.networkDiagnosticsLastSentAt)
        ? socket.data.networkDiagnosticsLastSentAt
        : null;
    const sequence = (socket.data.networkDiagnosticsSequence || 0) + 1;

    socket.data.networkDiagnosticsSequence = sequence;
    socket.data.networkDiagnosticsLastSentAt = now;

    return {
        schema: 2,
        channel: diagnosticChannel,
        sequence,
        sendType,
        serverSentAt: now,
        serverSendIntervalMs: previousSentAt === null ? null : now - previousSentAt,
        loopTick: finiteOrNull(sendDiagnostics && sendDiagnostics.loopTick),
        loopExpectedIntervalMs: finiteOrNull(sendDiagnostics && sendDiagnostics.loopExpectedIntervalMs),
        loopIntervalMs: finiteOrNull(sendDiagnostics && sendDiagnostics.loopIntervalMs),
        loopDriftMs: finiteOrNull(sendDiagnostics && sendDiagnostics.loopDriftMs),
        gameLoop: normalizeGameLoopDiagnostics(sendDiagnostics && sendDiagnostics.gameLoop),
        snapshotBuildMs: finiteOrNull(sendDiagnostics && sendDiagnostics.snapshotBuildMs),
        snapshotStateDraftMs: finiteOrNull(sendDiagnostics && sendDiagnostics.snapshotStateDraftMs),
        snapshotStateCommitMs: finiteOrNull(sendDiagnostics && sendDiagnostics.snapshotStateCommitMs),
        snapshotStateTerritoryPointCount: countMapItems(
            socket.data.snapshotState && socket.data.snapshotState.territoryPoints
        ),
        lastSnapshotStateCommit: normalizeSnapshotStateCommitDiagnostic(
            socket.data.networkDiagnosticsLastSnapshotStateCommit,
            now
        ),
        snapshotTime: snapshot.time,
        basePayloadBytes: payloadMeasurement.bytes,
        payloadMeasureMs: payloadMeasurement.measureMs,
        snapshotBreakdown,
        playerCount: countPlayerPositions(snapshot.players),
        territoryCount: countArrayItems(snapshot.territoryIds),
        trailCount: countArrayItems(snapshot.trailIds),
        preserveTrails: Boolean(snapshot.preserveTrails),
        reliableInFlight: Boolean(pending && (sendType === "reliable" || sendType === "reliable-retry")),
        reliableBacklog: Boolean(pending && sendType === "volatile-pending"),
        reliablePending: Boolean(pending),
        reliableId: pending ? pending.id : null,
        reliableRetryCount: pending ? Math.max(0, (pending.sentCount || 1) - 1) : 0,
        reliableAgeMs: pending && Number.isFinite(pending.createdAt) ? now - pending.createdAt : null,
        reliableAckTimeouts: pending ? pending.ackTimeouts || 0 : 0,
        lastReliableAck: socket.data.networkDiagnosticsLastReliableAck || null,
        snapshotResyncRequestCount: socket.data.networkDiagnosticsSnapshotResyncCount || 0,
        lastSnapshotResync: normalizeSnapshotResyncDiagnostic(socket.data.networkDiagnosticsLastSnapshotResync, now),
        snapshotCacheInvalidationCount: socket.data.networkDiagnosticsSnapshotCacheInvalidationCount || 0,
        lastSnapshotCacheInvalidation: normalizeSnapshotCacheInvalidationDiagnostic(
            socket.data.networkDiagnosticsLastSnapshotCacheInvalidation,
            now
        )
    };
}

function normalizeSnapshotResyncDiagnostic(value, now) {
    if (!value || typeof value !== "object") {
        return null;
    }

    return {
        at: finiteOrNull(value.at),
        ageMs: Number.isFinite(value.at) ? Math.max(0, now - value.at) : null,
        count: finiteOrNull(value.count)
    };
}

function normalizeSnapshotCacheInvalidationDiagnostic(value, now) {
    if (!value || typeof value !== "object") {
        return null;
    }

    return {
        at: finiteOrNull(value.at),
        ageMs: Number.isFinite(value.at) ? Math.max(0, now - value.at) : null,
        count: finiteOrNull(value.count),
        fullCacheReset: Boolean(value.fullCacheReset),
        invalidations: countInvalidations(value.invalidations)
    };
}

function normalizeSnapshotStateCommitDiagnostic(value, now) {
    if (!value || typeof value !== "object") {
        return null;
    }

    return {
        at: finiteOrNull(value.at),
        ageMs: Number.isFinite(value.at) ? Math.max(0, now - value.at) : null,
        durationMs: finiteOrNull(value.durationMs),
        reliableId: finiteOrNull(value.reliableId)
    };
}

function createMeasuredSnapshot(
    players,
    territories,
    viewerId,
    clientState,
    numberSystem,
    runtimeConfig,
    shouldMeasure = false,
    sharedFrame = null
) {
    const startedAt = shouldMeasure ? performance.now() : null;
    const snapshot = createSnapshot(
        players,
        territories,
        viewerId,
        clientState,
        numberSystem,
        runtimeConfig,
        sharedFrame
    );

    return {
        snapshot,
        buildMs: shouldMeasure ? performance.now() - startedAt : null
    };
}

function createSnapshotSendDiagnostics(measuredSnapshot, loopDiagnostics, roomDiagnostics) {
    if (!measuredSnapshot || !Number.isFinite(measuredSnapshot.buildMs)) {
        return null;
    }

    return {
        loopTick: loopDiagnostics && Number.isFinite(loopDiagnostics.tick) ? loopDiagnostics.tick : null,
        loopExpectedIntervalMs: loopDiagnostics && Number.isFinite(loopDiagnostics.expectedIntervalMs)
            ? loopDiagnostics.expectedIntervalMs
            : null,
        loopIntervalMs: loopDiagnostics && Number.isFinite(loopDiagnostics.tickIntervalMs)
            ? loopDiagnostics.tickIntervalMs
            : null,
        loopDriftMs: loopDiagnostics && Number.isFinite(loopDiagnostics.tickDriftMs)
            ? loopDiagnostics.tickDriftMs
            : null,
        gameLoop: cloneGameLoopDiagnostics(roomDiagnostics && roomDiagnostics.gameLoop),
        snapshotBuildMs: measuredSnapshot.buildMs,
        snapshotStateDraftMs: measuredSnapshot.stateDraftMs,
        snapshotStateCommitMs: null
    };
}

function materializeSnapshotState(socket, snapshotState, sendDiagnostics = null, reliableId = null) {
    const shouldMeasure = isNetworkDiagnosticsEnabled(socket);
    const startedAt = shouldMeasure ? performance.now() : null;
    const materializedState = materializeClientSnapshotStateDraft(snapshotState);

    if (!shouldMeasure) {
        return materializedState;
    }

    const durationMs = performance.now() - startedAt;
    if (sendDiagnostics) {
        sendDiagnostics.snapshotStateCommitMs = durationMs;
    }
    socket.data.networkDiagnosticsLastSnapshotStateCommit = {
        at: Date.now(),
        durationMs,
        reliableId
    };
    return materializedState;
}

function recordReliableSnapshotAcknowledgement(socket, pending, acknowledgement) {
    const acknowledgedAt = Date.now();

    socket.data.networkDiagnosticsLastReliableAck = {
        reliableId: pending.id,
        acknowledgedAt,
        ackLatencyMs: Number.isFinite(pending.lastSentAt)
            ? acknowledgedAt - pending.lastSentAt
            : null,
        applied: !acknowledgement || acknowledgement.applied !== false,
        invalidations: countInvalidations(acknowledgement && acknowledgement.invalidations)
    };
}

function invalidateSnapshotCache(socket, invalidations) {
    if (!hasAnyInvalidation(invalidations)) {
        resetSocketSnapshotState(socket);
        return;
    }
    if (!socket.data.snapshotState) {
        socket.data.snapshotState = createSocketSnapshotState(socket);
    }
    invalidateSnapshotState(socket.data.snapshotState, invalidations);
    if (socket.data.pendingReliableSnapshot) {
        socket.data.pendingReliableSnapshot = null;
    }
}

function createSocketSnapshotState(socket) {
    return createClientSnapshotState({
        snapshotSchema: getSocketSnapshotSchema(socket)
    });
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
    return hasChangedCachedGlobals(snapshot)
        || hasEntries(snapshot.playerInfo)
        || hasEntries(snapshot.territories)
        || hasEntries(snapshot.territoryOps)
        || hasItems(snapshot.removedTerritoryIds)
        || hasItems(snapshot.removedTrailIds)
        || hasEntries(snapshot.trailRemovals)
        || hasReliableTrailUpdate(snapshot.trails);
}

function hasChangedCachedGlobals(snapshot) {
    return Boolean(
        snapshot
        && snapshot.schema >= 3
        && (
            hasOwn(snapshot, "leaderboard")
            || hasOwn(snapshot, "mode")
            || hasOwn(snapshot, "roomConfig")
        )
    );
}

function hasOwn(value, key) {
    return Boolean(value)
        && Object.prototype.hasOwnProperty.call(value, key);
}

function hasEntries(value) {
    return value && Object.keys(value).length > 0;
}

function hasItems(value) {
    return Array.isArray(value) && value.length > 0;
}

function hasFullTrailUpdate(trails) {
    return Object.values(trails || {}).some(trail => (
        Array.isArray(trail)
            ? trail[0] === 1
            : Boolean(trail && trail.full)
    ));
}

function hasReliableTrailUpdate(trails) {
    if (config.network.reliableTrailUpdatesEnabled !== false) {
        return hasEntries(trails);
    }
    return hasFullTrailUpdate(trails);
}

function isNetworkDiagnosticsEnabled(socket) {
    return Boolean(socket && socket.data && socket.data.networkDiagnosticsEnabled);
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function countMapItems(value) {
    return value && Number.isInteger(value.size) ? value.size : 0;
}

module.exports = startSnapshotLoop;
module.exports.startSnapshotLoop = startSnapshotLoop;
module.exports.resolveSnapshotRate = resolveSnapshotRate;
module.exports.acknowledgeReliableSnapshot = acknowledgeReliableSnapshot;
module.exports.assignSnapshotSequence = assignSnapshotSequence;
module.exports.invalidateSnapshotCache = invalidateSnapshotCache;
module.exports.queueReliableSnapshot = queueReliableSnapshot;
module.exports.sendSnapshot = sendSnapshot;
module.exports.shouldDeferTerritoryGeometry = shouldDeferTerritoryGeometry;
module.exports.shouldSendReliably = shouldSendReliably;
