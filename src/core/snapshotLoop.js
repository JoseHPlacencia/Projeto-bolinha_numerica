const { performance } = require("node:perf_hooks");
const config = require("../config/gameConfig");
const {
    cloneClientSnapshotState,
    createClientSnapshotState,
    createSnapshot
} = require("./snapshotSerializer");

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
        trailIds: filterKnownIds(snapshot.trailIds, clientState.trails),
        trails: {},
        preserveTrails: true
    };
}

function filterKnownIds(ids, knownStates) {
    return (ids || []).filter(id => knownStates && knownStates.has(id));
}

function queueReliableSnapshot(socket, snapshot, nextSnapshotState, sendDiagnostics = null) {
    const pending = {
        createdAt: Date.now(),
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
        acknowledgeReliableSnapshot(socket, pending.id, acknowledgement);
    });
}

function acknowledgeReliableSnapshot(socket, pendingId, acknowledgement = { applied: true }) {
    const pending = socket.data.pendingReliableSnapshot;
    if (!pending || pending.id !== pendingId) return;
    recordReliableSnapshotAcknowledgement(socket, pending, acknowledgement);
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
        snapshotBreakdown: createSnapshotBreakdown(snapshot),
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
        lastReliableAck: socket.data.networkDiagnosticsLastReliableAck || null
    };
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
        phases: normalizeGameLoopPhases(gameLoop.phases),
        slowestPhase: normalizeGameLoopSlowestPhase(gameLoop.slowestPhase)
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

function createSnapshotBreakdown(snapshot) {
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

    return {
        playerPositionCount: countObjectKeys(snapshot && snapshot.players),
        playerInfoCount: countObjectKeys(snapshot && snapshot.playerInfo),
        territoryVersionCount: countObjectKeys(snapshot && snapshot.territoryVersions),
        territoryPayloadCount: countObjectKeys(territories),
        territoryOperationCount: countObjectKeys(territoryOps),
        captureOperationCount,
        captureOperationTrailPointCount,
        territoryPointDefinitionCount,
        territoryRingReferenceCount,
        trailUpdateCount: trailValues.length,
        fullTrailUpdateCount,
        fullTrailPointCount,
        trailPatchUpdateCount,
        trailPatchPointCount,
        leaderboardCount: countArrayItems(snapshot && snapshot.leaderboard),
        numberCount: countArrayItems(snapshot && snapshot.numbers && snapshot.numbers.nums)
    };
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
        playerInfo: countArrayItems(invalidations && invalidations.playerInfo),
        territories: countArrayItems(invalidations && invalidations.territories),
        trails: countArrayItems(invalidations && invalidations.trails)
    };
}

module.exports = startSnapshotLoop;
module.exports.startSnapshotLoop = startSnapshotLoop;
module.exports.acknowledgeReliableSnapshot = acknowledgeReliableSnapshot;
module.exports.invalidateSnapshotCache = invalidateSnapshotCache;
module.exports.queueReliableSnapshot = queueReliableSnapshot;
module.exports.sendSnapshot = sendSnapshot;
module.exports.shouldSendReliably = shouldSendReliably;
