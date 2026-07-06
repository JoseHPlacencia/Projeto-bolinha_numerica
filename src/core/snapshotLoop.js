const { performance } = require("node:perf_hooks");
const config = require("../config/gameConfig");
const {
    cloneClientSnapshotState,
    createClientSnapshotState,
    createSnapshot
} = require("./snapshotSerializer");
const {
    getSocketSnapshotEpoch,
    resetSocketSnapshotState
} = require("./snapshotState");
const { resolveSpectatorFollowId } = require("../systems/spectatorSystem");

function startSnapshotLoop(io, players, territories, roomCode, numberSystem, runtimeConfig = null, roomDiagnostics = null) {
    const intervalMs = 1000 / config.loop.snapshotRate;
    const loopDiagnostics = {
        expectedIntervalMs: intervalMs,
        lastTickAt: null,
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

function sendSnapshot(io, players, territories, roomCode, numberSystem, runtimeConfig = null, loopDiagnostics = null, roomDiagnostics = null) {
    for (const socket of io.sockets.sockets.values()) {
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
            socket.data.snapshotState = createClientSnapshotState();
        }

        if (retryPendingReliableSnapshot(socket)) {
            sendVolatileSnapshotWhileReliablePending(socket, players, territories, numberSystem, viewerId, runtimeConfig, loopDiagnostics, roomDiagnostics);
            continue;
        }

        const nextSnapshotState = cloneClientSnapshotState(socket.data.snapshotState);
        const measuredSnapshot = createMeasuredSnapshot(
            players,
            territories,
            viewerId,
            nextSnapshotState,
            numberSystem,
            runtimeConfig,
            isNetworkDiagnosticsEnabled(socket)
        );
        const snapshot = measuredSnapshot.snapshot;
        assignSnapshotSequence(socket, snapshot);
        const sendDiagnostics = createSnapshotSendDiagnostics(measuredSnapshot, loopDiagnostics, roomDiagnostics);

        if (isSpectatorSocket) {
            snapshot.spectator = { followId: viewerId };
        }

        if (shouldSendReliably(snapshot)) {
            queueReliableSnapshot(socket, snapshot, nextSnapshotState, sendDiagnostics);
            continue;
        }

        socket.data.snapshotState = nextSnapshotState;
        emitVolatileSnapshot(socket, snapshot, "volatile", null, sendDiagnostics);
    }
}

function retryPendingReliableSnapshot(socket) {
    const pending = socket.data.pendingReliableSnapshot;
    if (!pending) return false;
    if (Date.now() >= pending.nextRetryAt) {
        sendReliableSnapshot(socket, pending);
    }
    return true;
}

function sendVolatileSnapshotWhileReliablePending(socket, players, territories, numberSystem, viewerId, runtimeConfig = null, loopDiagnostics = null, roomDiagnostics = null) {
    if (config.network.volatileSnapshotsWhileReliablePendingEnabled === false) return;
    const clientState = socket.data.snapshotState || createClientSnapshotState();
    const temporaryState = cloneClientSnapshotState(clientState);
    const measuredSnapshot = createMeasuredSnapshot(
        players,
        territories,
        viewerId,
        temporaryState,
        numberSystem,
        runtimeConfig,
        isNetworkDiagnosticsEnabled(socket)
    );
    const snapshot = measuredSnapshot.snapshot;
    assignSnapshotSequence(socket, snapshot);
    const sendDiagnostics = createSnapshotSendDiagnostics(measuredSnapshot, loopDiagnostics, roomDiagnostics);

    if (socket.data && socket.data.spectatorRoomCode) {
        snapshot.spectator = { followId: viewerId };
    }
    const volatileSnapshot = createVolatileSnapshotForPendingReliableState(snapshot, clientState);
    emitVolatileSnapshot(socket, volatileSnapshot, "volatile-pending", socket.data.pendingReliableSnapshot, sendDiagnostics);
}

function createVolatileSnapshotForPendingReliableState(snapshot, clientState) {
    return {
        ...snapshot,
        playerInfo: {},
        territoryIds: filterKnownIds(snapshot.territoryIds, clientState.territories),
        territoryVersions: {},
        territories: {},
        territoryOps: {},
        removedTerritoryIds: [],
        trailIds: filterKnownIds(snapshot.trailIds, clientState.trails),
        trails: {},
        removedTrailIds: [],
        trailRemovals: {},
        payloadBudget: null,
        preserveTrails: true
    };
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
}

function sendReliableSnapshot(socket, pending) {
    const sendType = pending.sentCount > 0 ? "reliable-retry" : "reliable";
    pending.sentCount++;
    pending.lastSentAt = Date.now();
    pending.nextRetryAt = pending.lastSentAt + getReliableSnapshotRetryMs();
    const emitter = typeof socket.timeout === "function"
        ? socket.timeout(getReliableSnapshotAckTimeoutMs())
        : socket;
    emitter.emit("gameState", createSnapshotForNetworkSend(socket, pending.snapshot, sendType, pending, pending.sendDiagnostics), (error, acknowledgement) => {
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
        socket.data.snapshotState = pending.snapshotState;
        socket.data.pendingReliableSnapshot = null;
        return;
    }
    if (!hasAnyInvalidation(acknowledgement.invalidations)) {
        resetSocketSnapshotState(socket);
        return;
    }
    socket.data.snapshotState = pending.snapshotState;
    invalidateSnapshotState(socket.data.snapshotState, acknowledgement.invalidations);
    socket.data.pendingReliableSnapshot = null;
}

function emitVolatileSnapshot(socket, snapshot, sendType, pending = null, sendDiagnostics = null) {
    socket.volatile.emit("gameState", createSnapshotForNetworkSend(socket, snapshot, sendType, pending, sendDiagnostics));
}

function createSnapshotForNetworkSend(socket, snapshot, sendType, pending = null, sendDiagnostics = null) {
    if (!isNetworkDiagnosticsEnabled(socket)) {
        return snapshot;
    }

    return {
        ...snapshot,
        networkDiagnostics: createNetworkDiagnosticsSnapshot(socket, snapshot, sendType, pending, sendDiagnostics)
    };
}

function createNetworkDiagnosticsSnapshot(socket, snapshot, sendType, pending = null, sendDiagnostics = null) {
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
        snapshotTime: snapshot.time,
        basePayloadBytes: payloadMeasurement.bytes,
        payloadMeasureMs: payloadMeasurement.measureMs,
        snapshotBreakdown,
        playerCount: countObjectKeys(snapshot.players),
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

function isPayloadOutlier(bytes) {
    return Number.isFinite(bytes) && bytes >= getPayloadOutlierThresholdBytes();
}

function getPayloadOutlierThresholdBytes() {
    return Number.isFinite(config.network.diagnosticsPayloadOutlierBytes)
        ? config.network.diagnosticsPayloadOutlierBytes
        : 50000;
}

function createMeasuredSnapshot(players, territories, viewerId, clientState, numberSystem, runtimeConfig, shouldMeasure = false) {
    const startedAt = shouldMeasure ? performance.now() : null;
    const snapshot = createSnapshot(players, territories, viewerId, clientState, numberSystem, runtimeConfig);

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
        snapshotBuildMs: measuredSnapshot.buildMs
    };
}

function cloneGameLoopDiagnostics(gameLoop) {
    if (!gameLoop || typeof gameLoop !== "object") {
        return null;
    }

    return {
        schema: gameLoop.schema,
        updatedAt: gameLoop.updatedAt,
        roomCode: gameLoop.roomCode,
        tick: gameLoop.tick,
        expectedIntervalMs: gameLoop.expectedIntervalMs,
        tickIntervalMs: gameLoop.tickIntervalMs,
        tickDriftMs: gameLoop.tickDriftMs,
        tickDurationMs: gameLoop.tickDurationMs,
        deltaTimeMs: gameLoop.deltaTimeMs,
        playerCount: gameLoop.playerCount,
        territoryCount: gameLoop.territoryCount,
        numberCount: gameLoop.numberCount,
        collisionCount: gameLoop.collisionCount,
        themeChanged: gameLoop.themeChanged,
        bot: cloneBotDiagnostics(gameLoop.bot),
        trails: cloneTrailDiagnostics(gameLoop.trails),
        phases: { ...(gameLoop.phases || {}) },
        slowestPhase: gameLoop.slowestPhase
            ? { ...gameLoop.slowestPhase }
            : null
    };
}

function normalizeGameLoopDiagnostics(gameLoop) {
    if (!gameLoop || typeof gameLoop !== "object") {
        return null;
    }

    return {
        schema: gameLoop.schema,
        updatedAt: finiteOrNull(gameLoop.updatedAt),
        roomCode: typeof gameLoop.roomCode === "string" ? gameLoop.roomCode : null,
        tick: finiteOrNull(gameLoop.tick),
        expectedIntervalMs: finiteOrNull(gameLoop.expectedIntervalMs),
        tickIntervalMs: finiteOrNull(gameLoop.tickIntervalMs),
        tickDriftMs: finiteOrNull(gameLoop.tickDriftMs),
        tickDurationMs: finiteOrNull(gameLoop.tickDurationMs),
        deltaTimeMs: finiteOrNull(gameLoop.deltaTimeMs),
        playerCount: finiteOrNull(gameLoop.playerCount),
        territoryCount: finiteOrNull(gameLoop.territoryCount),
        numberCount: finiteOrNull(gameLoop.numberCount),
        collisionCount: finiteOrNull(gameLoop.collisionCount),
        themeChanged: Boolean(gameLoop.themeChanged),
        bot: normalizeBotDiagnostics(gameLoop.bot),
        trails: normalizeTrailDiagnostics(gameLoop.trails),
        phases: normalizeGameLoopPhases(gameLoop.phases),
        slowestPhase: normalizeGameLoopSlowestPhase(gameLoop.slowestPhase)
    };
}

function cloneTrailDiagnostics(trailDiagnostics) {
    if (!trailDiagnostics || typeof trailDiagnostics !== "object") {
        return null;
    }

    return {
        activeTrailPlayers: trailDiagnostics.activeTrailPlayers,
        captureApply: cloneCaptureApplyDiagnostics(trailDiagnostics.captureApply),
        captureAttempts: trailDiagnostics.captureAttempts,
        captureChangedPlayerCount: trailDiagnostics.captureChangedPlayerCount,
        captureOperationReplayAccepted: trailDiagnostics.captureOperationReplayAccepted,
        captureOperationReplayAreaMismatch: trailDiagnostics.captureOperationReplayAreaMismatch,
        captureOperationReplayInvalid: trailDiagnostics.captureOperationReplayInvalid,
        captureOperationReplayRejected: trailDiagnostics.captureOperationReplayRejected,
        captures: trailDiagnostics.captures,
        clearTrailCount: trailDiagnostics.clearTrailCount,
        closedTrailReturns: trailDiagnostics.closedTrailReturns,
        fillPathCount: trailDiagnostics.fillPathCount,
        fillPolygonCount: trailDiagnostics.fillPolygonCount,
        ownerTrailSegmentChecks: trailDiagnostics.ownerTrailSegmentChecks,
        pathPrimitiveCacheHits: trailDiagnostics.pathPrimitiveCacheHits,
        pathPrimitiveCacheMisses: trailDiagnostics.pathPrimitiveCacheMisses,
        pathPrimitiveCount: trailDiagnostics.pathPrimitiveCount,
        pathPrimitiveInputPointCount: trailDiagnostics.pathPrimitiveInputPointCount,
        phases: { ...(trailDiagnostics.phases || {}) },
        playersProcessed: trailDiagnostics.playersProcessed,
        selfCollisionTests: trailDiagnostics.selfCollisionTests,
        selfCollisions: trailDiagnostics.selfCollisions,
        selfPathPrimitiveCacheHits: trailDiagnostics.selfPathPrimitiveCacheHits,
        selfPathPrimitiveCacheMisses: trailDiagnostics.selfPathPrimitiveCacheMisses,
        selfPathPrimitiveCount: trailDiagnostics.selfPathPrimitiveCount,
        selfPathPrimitiveInputPointCount: trailDiagnostics.selfPathPrimitiveInputPointCount,
        selfTrailSegmentChecks: trailDiagnostics.selfTrailSegmentChecks,
        slowestPhase: trailDiagnostics.slowestPhase
            ? { ...trailDiagnostics.slowestPhase }
            : null,
        trailOwnerChecks: trailDiagnostics.trailOwnerChecks,
        trailOwnerHits: trailDiagnostics.trailOwnerHits
    };
}

function normalizeTrailDiagnostics(trailDiagnostics) {
    if (!trailDiagnostics || typeof trailDiagnostics !== "object") {
        return null;
    }

    return {
        activeTrailPlayers: finiteOrNull(trailDiagnostics.activeTrailPlayers),
        captureApply: normalizeCaptureApplyDiagnostics(trailDiagnostics.captureApply),
        captureAttempts: finiteOrNull(trailDiagnostics.captureAttempts),
        captureChangedPlayerCount: finiteOrNull(trailDiagnostics.captureChangedPlayerCount),
        captureOperationReplayAccepted: finiteOrNull(trailDiagnostics.captureOperationReplayAccepted),
        captureOperationReplayAreaMismatch: finiteOrNull(trailDiagnostics.captureOperationReplayAreaMismatch),
        captureOperationReplayInvalid: finiteOrNull(trailDiagnostics.captureOperationReplayInvalid),
        captureOperationReplayRejected: finiteOrNull(trailDiagnostics.captureOperationReplayRejected),
        captures: finiteOrNull(trailDiagnostics.captures),
        clearTrailCount: finiteOrNull(trailDiagnostics.clearTrailCount),
        closedTrailReturns: finiteOrNull(trailDiagnostics.closedTrailReturns),
        fillPathCount: finiteOrNull(trailDiagnostics.fillPathCount),
        fillPolygonCount: finiteOrNull(trailDiagnostics.fillPolygonCount),
        ownerTrailSegmentChecks: finiteOrNull(trailDiagnostics.ownerTrailSegmentChecks),
        pathPrimitiveCacheHits: finiteOrNull(trailDiagnostics.pathPrimitiveCacheHits),
        pathPrimitiveCacheMisses: finiteOrNull(trailDiagnostics.pathPrimitiveCacheMisses),
        pathPrimitiveCount: finiteOrNull(trailDiagnostics.pathPrimitiveCount),
        pathPrimitiveInputPointCount: finiteOrNull(trailDiagnostics.pathPrimitiveInputPointCount),
        phases: normalizeGameLoopPhases(trailDiagnostics.phases),
        playersProcessed: finiteOrNull(trailDiagnostics.playersProcessed),
        selfCollisionTests: finiteOrNull(trailDiagnostics.selfCollisionTests),
        selfCollisions: finiteOrNull(trailDiagnostics.selfCollisions),
        selfPathPrimitiveCacheHits: finiteOrNull(trailDiagnostics.selfPathPrimitiveCacheHits),
        selfPathPrimitiveCacheMisses: finiteOrNull(trailDiagnostics.selfPathPrimitiveCacheMisses),
        selfPathPrimitiveCount: finiteOrNull(trailDiagnostics.selfPathPrimitiveCount),
        selfPathPrimitiveInputPointCount: finiteOrNull(trailDiagnostics.selfPathPrimitiveInputPointCount),
        selfTrailSegmentChecks: finiteOrNull(trailDiagnostics.selfTrailSegmentChecks),
        slowestPhase: normalizeGameLoopSlowestPhase(trailDiagnostics.slowestPhase),
        trailOwnerChecks: finiteOrNull(trailDiagnostics.trailOwnerChecks),
        trailOwnerHits: finiteOrNull(trailDiagnostics.trailOwnerHits)
    };
}

function cloneCaptureApplyDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    return {
        boundsOverlapCount: diagnostics.boundsOverlapCount,
        boundsRejectedCount: diagnostics.boundsRejectedCount,
        calls: diagnostics.calls,
        candidateCount: diagnostics.candidateCount,
        changedTerritoryCount: diagnostics.changedTerritoryCount,
        emptyCapturedBoundsCount: diagnostics.emptyCapturedBoundsCount,
        maxCapturedArea: diagnostics.maxCapturedArea,
        maxCapturedBoundsArea: diagnostics.maxCapturedBoundsArea,
        maxCapturedPointCount: diagnostics.maxCapturedPointCount,
        maxOwnerArea: diagnostics.maxOwnerArea,
        maxOwnerPointCount: diagnostics.maxOwnerPointCount,
        maxTerritoryCount: diagnostics.maxTerritoryCount,
        missingOwnerTerritoryCount: diagnostics.missingOwnerTerritoryCount,
        overlapCount: diagnostics.overlapCount,
        overlapRejectedCount: diagnostics.overlapRejectedCount,
        operationSimplifyAttemptCount: diagnostics.operationSimplifyAttemptCount,
        operationSimplifyCacheHitCount: diagnostics.operationSimplifyCacheHitCount,
        operationSimplifyCapturedCount: diagnostics.operationSimplifyCapturedCount,
        operationSimplifyHitCount: diagnostics.operationSimplifyHitCount,
        operationSimplifyInputPointCount: diagnostics.operationSimplifyInputPointCount,
        operationSimplifyMaxAreaDrift: diagnostics.operationSimplifyMaxAreaDrift,
        operationSimplifyMaxAreaDriftRatio: diagnostics.operationSimplifyMaxAreaDriftRatio,
        operationSimplifyOutputPointCount: diagnostics.operationSimplifyOutputPointCount,
        operationSimplifySubjectCount: diagnostics.operationSimplifySubjectCount,
        ownerChangedCount: diagnostics.ownerChangedCount,
        slowestOverlap: diagnostics.slowestOverlap
            ? { ...diagnostics.slowestOverlap }
            : null,
        slowestSubtract: diagnostics.slowestSubtract
            ? { ...diagnostics.slowestSubtract }
            : null,
        subtractChangedCount: diagnostics.subtractChangedCount,
        subtractCount: diagnostics.subtractCount,
        subtractOperationClippingPointCount: diagnostics.subtractOperationClippingPointCount,
        subtractOperationPointCount: diagnostics.subtractOperationPointCount,
        subtractPointCount: diagnostics.subtractPointCount,
        subtractResultPointCount: diagnostics.subtractResultPointCount
    };
}

function normalizeCaptureApplyDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    return {
        boundsOverlapCount: finiteOrNull(diagnostics.boundsOverlapCount),
        boundsRejectedCount: finiteOrNull(diagnostics.boundsRejectedCount),
        calls: finiteOrNull(diagnostics.calls),
        candidateCount: finiteOrNull(diagnostics.candidateCount),
        changedTerritoryCount: finiteOrNull(diagnostics.changedTerritoryCount),
        emptyCapturedBoundsCount: finiteOrNull(diagnostics.emptyCapturedBoundsCount),
        maxCapturedArea: finiteOrNull(diagnostics.maxCapturedArea),
        maxCapturedBoundsArea: finiteOrNull(diagnostics.maxCapturedBoundsArea),
        maxCapturedPointCount: finiteOrNull(diagnostics.maxCapturedPointCount),
        maxOwnerArea: finiteOrNull(diagnostics.maxOwnerArea),
        maxOwnerPointCount: finiteOrNull(diagnostics.maxOwnerPointCount),
        maxTerritoryCount: finiteOrNull(diagnostics.maxTerritoryCount),
        missingOwnerTerritoryCount: finiteOrNull(diagnostics.missingOwnerTerritoryCount),
        overlapCount: finiteOrNull(diagnostics.overlapCount),
        overlapRejectedCount: finiteOrNull(diagnostics.overlapRejectedCount),
        operationSimplifyAttemptCount: finiteOrNull(diagnostics.operationSimplifyAttemptCount),
        operationSimplifyCacheHitCount: finiteOrNull(diagnostics.operationSimplifyCacheHitCount),
        operationSimplifyCapturedCount: finiteOrNull(diagnostics.operationSimplifyCapturedCount),
        operationSimplifyHitCount: finiteOrNull(diagnostics.operationSimplifyHitCount),
        operationSimplifyInputPointCount: finiteOrNull(diagnostics.operationSimplifyInputPointCount),
        operationSimplifyMaxAreaDrift: finiteOrNull(diagnostics.operationSimplifyMaxAreaDrift),
        operationSimplifyMaxAreaDriftRatio: finiteOrNull(diagnostics.operationSimplifyMaxAreaDriftRatio),
        operationSimplifyOutputPointCount: finiteOrNull(diagnostics.operationSimplifyOutputPointCount),
        operationSimplifySubjectCount: finiteOrNull(diagnostics.operationSimplifySubjectCount),
        ownerChangedCount: finiteOrNull(diagnostics.ownerChangedCount),
        slowestOverlap: normalizeCaptureApplyOverlap(diagnostics.slowestOverlap),
        slowestSubtract: normalizeCaptureApplySubtract(diagnostics.slowestSubtract),
        subtractChangedCount: finiteOrNull(diagnostics.subtractChangedCount),
        subtractCount: finiteOrNull(diagnostics.subtractCount),
        subtractOperationClippingPointCount: finiteOrNull(diagnostics.subtractOperationClippingPointCount),
        subtractOperationPointCount: finiteOrNull(diagnostics.subtractOperationPointCount),
        subtractPointCount: finiteOrNull(diagnostics.subtractPointCount),
        subtractResultPointCount: finiteOrNull(diagnostics.subtractResultPointCount)
    };
}

function normalizeCaptureApplyOverlap(detail) {
    if (!detail || typeof detail !== "object") {
        return null;
    }

    return {
        durationMs: finiteOrNull(detail.durationMs),
        hit: Boolean(detail.hit),
        playerId: typeof detail.playerId === "string" ? detail.playerId : null,
        subjectPointCount: finiteOrNull(detail.subjectPointCount)
    };
}

function normalizeCaptureApplySubtract(detail) {
    if (!detail || typeof detail !== "object") {
        return null;
    }

    return {
        changed: Boolean(detail.changed),
        clippingPointCount: finiteOrNull(detail.clippingPointCount),
        durationMs: finiteOrNull(detail.durationMs),
        operationClippingPointCount: finiteOrNull(detail.operationClippingPointCount),
        operationResultArea: finiteOrNull(detail.operationResultArea),
        operationSubjectArea: finiteOrNull(detail.operationSubjectArea),
        operationSubjectPointCount: finiteOrNull(detail.operationSubjectPointCount),
        playerId: typeof detail.playerId === "string" ? detail.playerId : null,
        resultArea: finiteOrNull(detail.resultArea),
        resultPointCount: finiteOrNull(detail.resultPointCount),
        subjectArea: finiteOrNull(detail.subjectArea),
        subjectPointCount: finiteOrNull(detail.subjectPointCount),
        usedSimplified: Boolean(detail.usedSimplified)
    };
}

function cloneBotDiagnostics(botDiagnostics) {
    if (!botDiagnostics || typeof botDiagnostics !== "object") {
        return null;
    }

    return {
        cycle: botDiagnostics.cycle,
        decisionsProcessed: botDiagnostics.decisionsProcessed,
        pendingAfter: botDiagnostics.pendingAfter,
        pendingBefore: botDiagnostics.pendingBefore,
        phases: { ...(botDiagnostics.phases || {}) },
        selfTrailSafety: botDiagnostics.selfTrailSafety
            ? { ...botDiagnostics.selfTrailSafety }
            : null,
        slowestPhase: botDiagnostics.slowestPhase
            ? { ...botDiagnostics.slowestPhase }
            : null
    };
}

function normalizeBotDiagnostics(botDiagnostics) {
    if (!botDiagnostics || typeof botDiagnostics !== "object") {
        return null;
    }

    return {
        cycle: finiteOrNull(botDiagnostics.cycle),
        decisionsProcessed: finiteOrNull(botDiagnostics.decisionsProcessed),
        pendingAfter: finiteOrNull(botDiagnostics.pendingAfter),
        pendingBefore: finiteOrNull(botDiagnostics.pendingBefore),
        phases: normalizeGameLoopPhases(botDiagnostics.phases),
        selfTrailSafety: normalizeSelfTrailSafetyDiagnostics(botDiagnostics.selfTrailSafety),
        slowestPhase: normalizeGameLoopSlowestPhase(botDiagnostics.slowestPhase)
    };
}

function normalizeSelfTrailSafetyDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    return {
        budgetHitCount: finiteOrNull(diagnostics.budgetHitCount),
        bypassCount: finiteOrNull(diagnostics.bypassCount),
        candidateCount: finiteOrNull(diagnostics.candidateCount),
        decisionCount: finiteOrNull(diagnostics.decisionCount),
        evaluatedCandidateCount: finiteOrNull(diagnostics.evaluatedCandidateCount),
        evaluatedLocalCandidateCount: finiteOrNull(diagnostics.evaluatedLocalCandidateCount),
        filteredTrailPointCount: finiteOrNull(diagnostics.filteredTrailPointCount),
        filteredTrailSegmentCount: finiteOrNull(diagnostics.filteredTrailSegmentCount),
        localCandidateCount: finiteOrNull(diagnostics.localCandidateCount),
        maxBudgetElapsedMs: finiteOrNull(diagnostics.maxBudgetElapsedMs),
        pathEvaluationCount: finiteOrNull(diagnostics.pathEvaluationCount),
        pointDistanceCheckCount: finiteOrNull(diagnostics.pointDistanceCheckCount),
        sampleCount: finiteOrNull(diagnostics.sampleCount),
        segmentCrossCheckCount: finiteOrNull(diagnostics.segmentCrossCheckCount),
        trailPointCount: finiteOrNull(diagnostics.trailPointCount),
        trailSegmentCount: finiteOrNull(diagnostics.trailSegmentCount),
        unsafeTargetCount: finiteOrNull(diagnostics.unsafeTargetCount)
    };
}

function normalizeGameLoopPhases(phases) {
    const normalized = {};

    for (const [name, durationMs] of Object.entries(phases || {})) {
        normalized[name] = finiteOrNull(durationMs);
    }

    return normalized;
}

function normalizeGameLoopSlowestPhase(slowestPhase) {
    if (!slowestPhase || typeof slowestPhase !== "object") {
        return null;
    }

    return {
        name: typeof slowestPhase.name === "string" ? slowestPhase.name : null,
        durationMs: finiteOrNull(slowestPhase.durationMs)
    };
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
        || hasItems(snapshot.removedTerritoryIds)
        || hasItems(snapshot.removedTrailIds)
        || hasEntries(snapshot.trailRemovals)
        || hasReliableTrailUpdate(snapshot.trails);
}

function hasEntries(value) {
    return value && Object.keys(value).length > 0;
}

function hasItems(value) {
    return Array.isArray(value) && value.length > 0;
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

function isNetworkDiagnosticsEnabled(socket) {
    return Boolean(socket && socket.data && socket.data.networkDiagnosticsEnabled);
}

function measureSnapshotPayload(snapshot) {
    const startedAt = performance.now();

    try {
        return {
            bytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
            measureMs: performance.now() - startedAt
        };
    } catch (error) {
        return {
            bytes: null,
            measureMs: performance.now() - startedAt
        };
    }
}

function countObjectKeys(value) {
    return value && typeof value === "object" ? Object.keys(value).length : 0;
}

function countArrayItems(value) {
    return Array.isArray(value) ? value.length : 0;
}

function createSnapshotBreakdown(snapshot, options = {}) {
    const territories = snapshot && snapshot.territories || {};
    const territoryOps = snapshot && snapshot.territoryOps || {};
    const trails = snapshot && snapshot.trails || {};
    const territoryValues = Object.values(territories);
    const operationValues = Object.values(territoryOps);
    const trailValues = Object.values(trails);
    let territoryPointDefinitionCount = 0;
    let territoryRingReferenceCount = 0;
    let captureOperationCount = 0;
    let captureOperationTrailPointCount = 0;
    let fullTrailUpdateCount = 0;
    let fullTrailPointCount = 0;
    let partialTrailUpdateCount = 0;
    let partialTrailRemainingPointCount = 0;
    let trailPatchUpdateCount = 0;
    let trailPatchPointCount = 0;

    for (const territory of territoryValues) {
        const polygon = territory && territory.polygon;
        territoryPointDefinitionCount += countArrayItems(polygon && polygon.points);
        territoryRingReferenceCount += countRingReferences(polygon && polygon.rings);
    }

    for (const operation of operationValues) {
        if (!operation || operation.type !== "trailCapture") {
            continue;
        }

        captureOperationCount++;
        captureOperationTrailPointCount += countArrayItems(operation.trailPoints)
            + countArrayItems(operation.trailTailPoints);
    }

    for (const trail of trailValues) {
        if (!trail) {
            continue;
        }

        if (trail.partial) {
            partialTrailUpdateCount++;
            partialTrailRemainingPointCount += Number.isFinite(trail.remainingPointCount)
                ? trail.remainingPointCount
                : 0;
        }

        if (trail.full) {
            fullTrailUpdateCount++;
            fullTrailPointCount += countPackedSegmentsPoints(trail.leftSegments)
                + countPackedSegmentsPoints(trail.rightSegments)
                + countArrayItems(trail.leftFillPath)
                + countArrayItems(trail.rightFillPath);
            continue;
        }

        trailPatchUpdateCount++;
        trailPatchPointCount += countTrailPatchPoints(trail);
    }

    const breakdown = {
        playerPositionCount: countObjectKeys(snapshot && snapshot.players),
        playerInfoCount: countObjectKeys(snapshot && snapshot.playerInfo),
        territoryVersionCount: countObjectKeys(snapshot && snapshot.territoryVersions),
        territoryPayloadCount: countObjectKeys(territories),
        territoryOperationCount: countObjectKeys(territoryOps),
        removedTerritoryCount: countArrayItems(snapshot && snapshot.removedTerritoryIds),
        captureOperationCount,
        captureOperationTrailPointCount,
        territoryPointDefinitionCount,
        territoryRingReferenceCount,
        trailUpdateCount: trailValues.length,
        removedTrailCount: countArrayItems(snapshot && snapshot.removedTrailIds),
        fullTrailUpdateCount,
        fullTrailPointCount,
        partialTrailUpdateCount,
        partialTrailRemainingPointCount,
        trailPatchUpdateCount,
        trailPatchPointCount,
        leaderboardCount: countArrayItems(snapshot && snapshot.leaderboard),
        numberCount: countArrayItems(snapshot && snapshot.numbers && snapshot.numbers.nums),
        payloadBudget: normalizePayloadBudget(snapshot && snapshot.payloadBudget)
    };

    if (options.includePayloadOutlier) {
        breakdown.payloadOutlier = createPayloadOutlierBreakdown(snapshot, options.payloadBytes);
    }

    return breakdown;
}

function createPayloadOutlierBreakdown(snapshot, payloadBytes) {
    const limit = getPayloadOutlierTopLimit();
    const sectionBytes = createSectionByteBreakdown(snapshot);
    const trailDetails = createTrailPayloadDetails(snapshot && snapshot.trails, limit);
    const territoryDetails = createTerritoryPayloadDetails(snapshot && snapshot.territories, limit);
    const territoryOperationDetails = createTerritoryOperationPayloadDetails(snapshot && snapshot.territoryOps, limit);

    return {
        payloadBytes: finiteOrNull(payloadBytes),
        thresholdBytes: getPayloadOutlierThresholdBytes(),
        sectionBytes,
        topSections: sectionBytes.slice(0, limit),
        topTrails: trailDetails,
        topTerritories: territoryDetails,
        topTerritoryOps: territoryOperationDetails
    };
}

function normalizePayloadBudget(value) {
    if (!value || typeof value !== "object") {
        return null;
    }

    return {
        budgetBytes: finiteOrNull(value.budgetBytes),
        usedBytes: finiteOrNull(value.usedBytes),
        remainingBytes: finiteOrNull(value.remainingBytes),
        deferredBytes: finiteOrNull(value.deferredBytes),
        sent: normalizePayloadBudgetCounts(value.sent),
        deferred: normalizePayloadBudgetCounts(value.deferred)
    };
}

function normalizePayloadBudgetCounts(value) {
    return {
        territories: finiteOrNull(value && value.territories),
        territoryOps: finiteOrNull(value && value.territoryOps),
        trails: finiteOrNull(value && value.trails)
    };
}

function getPayloadOutlierTopLimit() {
    return Number.isInteger(config.network.diagnosticsPayloadOutlierTopLimit)
        ? Math.max(1, config.network.diagnosticsPayloadOutlierTopLimit)
        : 5;
}

function createSectionByteBreakdown(snapshot) {
    return Object.keys(snapshot || {})
        .map(section => ({
            section,
            bytes: measureJsonBytes(snapshot[section])
        }))
        .filter(item => Number.isFinite(item.bytes))
        .sort((first, second) => second.bytes - first.bytes);
}

function createTrailPayloadDetails(trails, limit) {
    return Object.entries(trails || {})
        .map(([playerId, trail]) => createTrailPayloadDetail(playerId, trail))
        .filter(Boolean)
        .sort(comparePayloadDetails)
        .slice(0, limit);
}

function createTrailPayloadDetail(playerId, trail) {
    if (!trail || typeof trail !== "object") {
        return null;
    }

    const leftPatchPointCount = countPatchPoints(trail.leftPatches);
    const rightPatchPointCount = countPatchPoints(trail.rightPatches);
    const leftFillPointCount = countArrayItems(trail.leftFillPoints);
    const rightFillPointCount = countArrayItems(trail.rightFillPoints);
    const leftSegmentPointCount = countPackedSegmentsPoints(trail.leftSegments);
    const rightSegmentPointCount = countPackedSegmentsPoints(trail.rightSegments);
    const leftFillPathPointCount = countArrayItems(trail.leftFillPath);
    const rightFillPathPointCount = countArrayItems(trail.rightFillPath);
    const patchPointCount = leftPatchPointCount + rightPatchPointCount + leftFillPointCount + rightFillPointCount;
    const fullPointCount = leftSegmentPointCount + rightSegmentPointCount + leftFillPathPointCount + rightFillPathPointCount;

    return {
        playerId,
        bytes: measureJsonBytes(trail),
        full: Boolean(trail.full),
        partial: Boolean(trail.partial),
        pointBudget: finiteOrNull(trail.pointBudget),
        pointCount: trail.full ? fullPointCount : patchPointCount,
        patchPointCount,
        remainingPointCount: finiteOrNull(trail.remainingPointCount),
        fullPointCount,
        leftPatchCount: countArrayItems(trail.leftPatches),
        rightPatchCount: countArrayItems(trail.rightPatches),
        leftPatchPointCount,
        rightPatchPointCount,
        leftFillPointCount,
        rightFillPointCount,
        leftSegmentPointCount,
        rightSegmentPointCount,
        leftFillPathPointCount,
        rightFillPathPointCount
    };
}

function createTerritoryPayloadDetails(territories, limit) {
    return Object.entries(territories || {})
        .map(([playerId, territory]) => createTerritoryPayloadDetail(playerId, territory))
        .filter(Boolean)
        .sort(comparePayloadDetails)
        .slice(0, limit);
}

function createTerritoryPayloadDetail(playerId, territory) {
    if (!territory || typeof territory !== "object") {
        return null;
    }

    const polygon = territory.polygon || {};

    return {
        playerId,
        bytes: measureJsonBytes(territory),
        pointDefinitionCount: countArrayItems(polygon.points),
        ringReferenceCount: countRingReferences(polygon.rings),
        version: finiteOrNull(territory.version)
    };
}

function createTerritoryOperationPayloadDetails(operations, limit) {
    return Object.entries(operations || {})
        .map(([playerId, operation]) => createTerritoryOperationPayloadDetail(playerId, operation))
        .filter(Boolean)
        .sort(comparePayloadDetails)
        .slice(0, limit);
}

function createTerritoryOperationPayloadDetail(playerId, operation) {
    if (!operation || typeof operation !== "object") {
        return null;
    }

    return {
        playerId,
        bytes: measureJsonBytes(operation),
        type: typeof operation.type === "string" ? operation.type : null,
        trailPointCount: countArrayItems(operation.trailPoints),
        trailTailPointCount: countArrayItems(operation.trailTailPoints),
        version: finiteOrNull(operation.version)
    };
}

function comparePayloadDetails(first, second) {
    const byteDifference = (second.bytes || 0) - (first.bytes || 0);

    if (byteDifference !== 0) {
        return byteDifference;
    }

    return (second.pointCount || 0) - (first.pointCount || 0);
}

function measureJsonBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch (_error) {
        return null;
    }
}

function countRingReferences(rings) {
    return (rings || []).reduce((sum, ring) => sum + countArrayItems(ring), 0);
}

function countPackedSegmentsPoints(segments) {
    return (segments || []).reduce((sum, segment) => sum + countArrayItems(segment), 0);
}

function countTrailPatchPoints(trail) {
    return countPatchPoints(trail.leftPatches)
        + countPatchPoints(trail.rightPatches)
        + countArrayItems(trail.leftFillPoints)
        + countArrayItems(trail.rightFillPoints);
}

function countPatchPoints(patches) {
    return (patches || []).reduce((sum, patch) => sum + countArrayItems(patch && patch.points), 0);
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function countInvalidations(invalidations) {
    return {
        playerInfo: countInvalidationItems(invalidations && invalidations.playerInfo),
        territories: countInvalidationItems(invalidations && invalidations.territories),
        trails: countInvalidationItems(invalidations && invalidations.trails)
    };
}

function countInvalidationItems(value) {
    if (Array.isArray(value)) {
        return value.length;
    }

    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

module.exports = startSnapshotLoop;
module.exports.startSnapshotLoop = startSnapshotLoop;
module.exports.acknowledgeReliableSnapshot = acknowledgeReliableSnapshot;
module.exports.assignSnapshotSequence = assignSnapshotSequence;
module.exports.invalidateSnapshotCache = invalidateSnapshotCache;
module.exports.queueReliableSnapshot = queueReliableSnapshot;
module.exports.sendSnapshot = sendSnapshot;
module.exports.shouldSendReliably = shouldSendReliably;
