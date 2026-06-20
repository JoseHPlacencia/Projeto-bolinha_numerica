import { clamp, lerp, lerpAngle } from "./sharedMath.js";

const coordinatePrecision = 1000;
const geometryEpsilon = 1e-7;
const indexedBoundaryMaxDistanceSquared = 4;
const captureAreaRegressionTolerance = 1;
const captureAreaRegressionRatioTolerance = 0.001;

export function createSnapshotInterpolator(networkConfig, options = {}) {
    const snapshots = [];
    const entityCache = {
        playerInfo: {},
        territories: {},
        territoryPoints: {},
        trails: {},
        trailAssemblies: {}
    };
    const networkState = {
        bufferMs: networkConfig.initialBufferMs,
        serverOffset: 0,
        lastSnapshotReceivedAt: null,
        deltas: [],
        lastSnapshotDeltaMs: 0,
        averageSnapshotDeltaMs: 0,
        jitterMs: 0
    };
    const debugState = {
        visiblePlayers: 0,
        visibleTerritories: 0,
        visibleTrails: 0
    };
    const networkDiagnosticsState = {
        events: [],
        lastServer: null,
        lastSnapshot: null,
        lastResync: null,
        lastResyncSuppressed: null
    };
    const pendingTerritoryOperations = new Map();
    const suppressedCaptureOperationResyncIds = new Set();
    const failedTerritoryOperationKeys = new Map();
    let hasServerClockSync = false;
    let lastResyncRequestedAt = Number.NEGATIVE_INFINITY;

    return {
        getDebugState,
        getNetworkDiagnostics,
        getRenderState,
        processSnapshot,
        reset
    };

    function reset() {
        snapshots.length = 0;
        entityCache.playerInfo = {};
        entityCache.territories = {};
        entityCache.territoryPoints = {};
        entityCache.trails = {};
        entityCache.trailAssemblies = {};
        networkState.bufferMs = networkConfig.initialBufferMs;
        networkState.serverOffset = 0;
        networkState.lastSnapshotReceivedAt = null;
        networkState.deltas = [];
        networkState.lastSnapshotDeltaMs = 0;
        networkState.averageSnapshotDeltaMs = 0;
        networkState.jitterMs = 0;
        debugState.visiblePlayers = 0;
        debugState.visibleTerritories = 0;
        debugState.visibleTrails = 0;
        networkDiagnosticsState.events.length = 0;
        networkDiagnosticsState.lastServer = null;
        networkDiagnosticsState.lastSnapshot = null;
        networkDiagnosticsState.lastResync = null;
        networkDiagnosticsState.lastResyncSuppressed = null;
        pendingTerritoryOperations.clear();
        suppressedCaptureOperationResyncIds.clear();
        failedTerritoryOperationKeys.clear();
        hasServerClockSync = false;
        lastResyncRequestedAt = Number.NEGATIVE_INFINITY;
    }

    function processSnapshot(rawSnapshot) {
        const now = performance.now();
        const applyResult = createApplyResult();
        const snapshot = expandSnapshot(rawSnapshot, applyResult);
        const shouldSave = applyResult.applied && isSnapshotNewerThanRenderBuffer(snapshot);

        if (shouldSave) {
            updateAdaptiveBuffer(now);
            syncServerClock(snapshot.time);
            saveSnapshot(snapshot);
        }
        recordSnapshotNetworkDiagnostics(rawSnapshot, snapshot, applyResult, now);

        return applyResult;
    }

    function getRenderState() {
        if (snapshots.length === 0) {
            return null;
        }

        if (snapshots.length === 1) {
            return createRenderState(snapshots[0], snapshots[0].players);
        }

        const serverNow = Date.now() - networkState.serverOffset;
        const renderTime = serverNow - networkState.bufferMs;
        const { previous, next } = findSnapshotPair(renderTime);
        const interval = next.time - previous.time || 1;
        const amount = clamp((renderTime - previous.time) / interval, 0, 1);
        const players = interpolatePlayers(previous, next, amount);

        return createInterpolatedRenderState(
            previous,
            next,
            players,
            amount
        );
    }

    function getDebugState() {
        return {
            bufferMs: networkState.bufferMs,
            serverOffsetMs: networkState.serverOffset,
            snapshotInterArrivalMs: networkState.lastSnapshotDeltaMs,
            averageSnapshotDeltaMs: networkState.averageSnapshotDeltaMs,
            jitterMs: networkState.jitterMs,
            snapshotCount: snapshots.length,
            visiblePlayers: debugState.visiblePlayers,
            visibleTerritories: debugState.visibleTerritories,
            visibleTrails: debugState.visibleTrails
        };
    }

    function getNetworkDiagnostics() {
        return {
            current: {
                ...getDebugState(),
                lastServer: networkDiagnosticsState.lastServer,
                lastSnapshot: networkDiagnosticsState.lastSnapshot,
                lastResync: networkDiagnosticsState.lastResync,
                lastResyncSuppressed: networkDiagnosticsState.lastResyncSuppressed
            },
            events: networkDiagnosticsState.events.slice(),
            summary: createNetworkDiagnosticsSummary()
        };
    }

    function recordSnapshotNetworkDiagnostics(rawSnapshot, snapshot, applyResult, receivedAt) {
        const serverDiagnostics = normalizeServerNetworkDiagnostics(rawSnapshot && rawSnapshot.networkDiagnostics);
        const invalidations = countInvalidations(applyResult && applyResult.invalidations);
        const event = {
            type: "snapshot",
            at: Date.now(),
            perfAt: receivedAt,
            bufferMs: networkState.bufferMs,
            snapshotInterArrivalMs: networkState.lastSnapshotDeltaMs,
            averageSnapshotDeltaMs: networkState.averageSnapshotDeltaMs,
            jitterMs: networkState.jitterMs,
            serverOffsetMs: networkState.serverOffset,
            snapshotCount: snapshots.length,
            visiblePlayers: debugState.visiblePlayers,
            visibleTerritories: debugState.visibleTerritories,
            visibleTrails: debugState.visibleTrails,
            preserveTrails: Boolean(snapshot && snapshot.preserveTrails),
            applied: !applyResult || applyResult.applied !== false,
            invalidations,
            server: serverDiagnostics
        };

        if (serverDiagnostics && Number.isFinite(serverDiagnostics.serverSentAt)) {
            event.estimatedTransitMs = event.at - (serverDiagnostics.serverSentAt + networkState.serverOffset);
        }

        networkDiagnosticsState.lastServer = serverDiagnostics;
        networkDiagnosticsState.lastSnapshot = event;
        pushNetworkDiagnosticsEvent(event);
    }

    function recordNetworkDiagnosticsEvent(event) {
        const entry = {
            at: Date.now(),
            perfAt: performance.now(),
            ...event
        };

        pushNetworkDiagnosticsEvent(entry);

        if (entry.type === "resyncRequested") {
            networkDiagnosticsState.lastResync = entry;
        } else if (entry.type === "resyncSuppressed") {
            networkDiagnosticsState.lastResyncSuppressed = entry;
        }
    }

    function pushNetworkDiagnosticsEvent(event) {
        const limit = getNetworkDiagnosticsHistoryLimit();

        networkDiagnosticsState.events.push(event);

        while (networkDiagnosticsState.events.length > limit) {
            networkDiagnosticsState.events.shift();
        }
    }

    function createNetworkDiagnosticsSummary() {
        const events = networkDiagnosticsState.events;
        const snapshotEvents = networkDiagnosticsState.events
            .filter(event => event.type === "snapshot");
        const resyncSummary = createResyncDiagnosticsSummary(events, snapshotEvents);

        if (snapshotEvents.length === 0) {
            return {
                samples: 0,
                resync: resyncSummary,
                resyncEvents: resyncSummary.requested,
                resyncSuppressedEvents: resyncSummary.suppressed
            };
        }

        return {
            samples: snapshotEvents.length,
            averageBufferMs: averageFiniteValues(snapshotEvents.map(event => event.bufferMs)),
            maxBufferMs: maxFiniteValue(snapshotEvents.map(event => event.bufferMs)),
            averageInterArrivalMs: averageFiniteValues(snapshotEvents.map(event => event.snapshotInterArrivalMs)),
            maxInterArrivalMs: maxFiniteValue(snapshotEvents.map(event => event.snapshotInterArrivalMs)),
            averageJitterMs: averageFiniteValues(snapshotEvents.map(event => event.jitterMs)),
            maxJitterMs: maxFiniteValue(snapshotEvents.map(event => event.jitterMs)),
            averagePayloadBytes: averageFiniteValues(snapshotEvents.map(event => event.server && event.server.basePayloadBytes)),
            maxPayloadBytes: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.basePayloadBytes)),
            averageLoopDriftMs: averageFiniteValues(snapshotEvents.map(event => event.server && event.server.loopDriftMs)),
            maxLoopDriftMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.loopDriftMs)),
            averageSnapshotBuildMs: averageFiniteValues(snapshotEvents.map(event => event.server && event.server.snapshotBuildMs)),
            maxSnapshotBuildMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.snapshotBuildMs)),
            averagePayloadMeasureMs: averageFiniteValues(snapshotEvents.map(event => event.server && event.server.payloadMeasureMs)),
            maxPayloadMeasureMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.payloadMeasureMs)),
            averageGameLoopDurationMs: averageFiniteValues(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.tickDurationMs)),
            maxGameLoopDurationMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.tickDurationMs)),
            averageGameLoopDriftMs: averageFiniteValues(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.tickDriftMs)),
            maxGameLoopDriftMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.tickDriftMs)),
            maxGameLoopTrailsMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.phases && event.server.gameLoop.phases.trails)),
            maxTrailSideUpdateMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.sideUpdate)),
            maxTrailSelfCollisionMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.selfCollision)),
            maxTrailOwnerCrossingMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.ownerCrossing)),
            maxTrailFillMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.fill)),
            maxTrailCaptureMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.capture)),
            maxTrailCaptureCreateMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.captureCreate)),
            maxTrailCaptureApplyTerritoryMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.captureApplyTerritory)),
            maxCaptureApplyCalls: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).calls)),
            maxCaptureApplyCandidates: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).candidateCount)),
            maxCaptureApplyBoundsRejected: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).boundsRejectedCount)),
            maxCaptureApplyBoundsOverlaps: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).boundsOverlapCount)),
            maxCaptureApplyOverlaps: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).overlapCount)),
            maxCaptureApplyOverlapRejected: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).overlapRejectedCount)),
            maxCaptureApplySubtractions: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).subtractCount)),
            maxCaptureApplySimplifyAttempts: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).operationSimplifyAttemptCount)),
            maxCaptureApplySimplifyHits: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).operationSimplifyHitCount)),
            maxCaptureApplySimplifyInputPoints: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).operationSimplifyInputPointCount)),
            maxCaptureApplySimplifyOutputPoints: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).operationSimplifyOutputPointCount)),
            maxCaptureApplyChangedTerritories: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).changedTerritoryCount)),
            maxCaptureApplyCapturedPoints: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).maxCapturedPointCount)),
            maxCaptureApplySubtractPoints: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).subtractPointCount)),
            maxCaptureApplyOperationSubtractPoints: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).subtractOperationPointCount)),
            maxCaptureApplySlowestOverlapMs: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).slowestOverlap && getEventCaptureApply(event).slowestOverlap.durationMs)),
            maxCaptureApplySlowestSubtractMs: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).slowestSubtract && getEventCaptureApply(event).slowestSubtract.durationMs)),
            maxTrailCaptureDamagePlayersMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.captureDamagePlayers)),
            maxTrailCaptureRelocatePlayersMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.captureRelocatePlayers)),
            maxTrailOwnerSegmentChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailSegmentChecks)),
            maxTrailSelfSegmentChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSegmentChecks)),
            maxTrailCaptures: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.captures)),
            maxGameLoopBotsMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.phases && event.server.gameLoop.phases.bots)),
            maxBotDecisionMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.phases && event.server.gameLoop.bot.phases.decisions)),
            maxBotSelfTrailSafetyMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.phases && event.server.gameLoop.bot.phases.selfTrailSafety)),
            maxBotSelfTrailBudgetHits: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.budgetHitCount)),
            maxBotSelfTrailBudgetElapsedMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.maxBudgetElapsedMs)),
            maxBotSelfTrailCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.candidateCount)),
            maxBotSelfTrailEvaluatedCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.evaluatedCandidateCount)),
            maxBotSelfTrailFilteredPoints: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.filteredTrailPointCount)),
            maxBotSelfTrailFilteredSegments: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.filteredTrailSegmentCount)),
            maxBotSelfTrailSamples: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.sampleCount)),
            maxBotTargetingMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.phases && event.server.gameLoop.bot.phases.targeting)),
            maxGameLoopNumberEventsMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.phases && event.server.gameLoop.phases.numberEvents)),
            maxTerritoryPayloadCount: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.territoryPayloadCount)),
            maxTerritoryOperationCount: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.territoryOperationCount)),
            maxTrailPatchPointCount: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.trailPatchPointCount)),
            maxPartialTrailUpdates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.partialTrailUpdateCount)),
            maxPartialTrailRemainingPoints: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.partialTrailRemainingPointCount)),
            payloadOutlierCount: snapshotEvents.filter(event => event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.payloadOutlier).length,
            maxPayloadOutlierBytes: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.payloadOutlier && event.server.snapshotBreakdown.payloadOutlier.payloadBytes)),
            reliableRetryEvents: snapshotEvents.filter(event => event.server && event.server.sendType === "reliable-retry").length,
            reliableBacklogEvents: snapshotEvents.filter(event => event.server && isReliableBacklog(event.server)).length,
            bufferSpikeEvents: snapshotEvents.filter(event => event.bufferMs >= getSlowBufferMs()).length,
            resync: resyncSummary,
            resyncEvents: resyncSummary.requested,
            resyncSuppressedEvents: resyncSummary.suppressed
        };
    }

    function createResyncDiagnosticsSummary(events, snapshotEvents) {
        const resyncEvents = events.filter(event => event.type === "resyncRequested");
        const suppressedEvents = events.filter(event => event.type === "resyncSuppressed");
        const invalidationEvents = snapshotEvents.filter(event => hasAnyInvalidationCounts(event.invalidations));
        const windowDurationMs = getDiagnosticsWindowDurationMs(events);
        const lastResync = resyncEvents[resyncEvents.length - 1] || null;
        const lastSuppressed = suppressedEvents[suppressedEvents.length - 1] || null;

        return {
            requested: resyncEvents.length,
            suppressed: suppressedEvents.length,
            snapshotInvalidationEvents: invalidationEvents.length,
            requestedPerMinute: calculateRatePerMinute(resyncEvents.length, windowDurationMs),
            suppressedPerMinute: calculateRatePerMinute(suppressedEvents.length, windowDurationMs),
            snapshotInvalidationsPerMinute: calculateRatePerMinute(invalidationEvents.length, windowDurationMs),
            invalidations: sumInvalidationCounts(snapshotEvents.map(event => event.invalidations)),
            reasons: countBy(resyncEvents.map(event => event.reason)),
            suppressedReasons: countBy(suppressedEvents.map(event => event.reason)),
            lastReason: lastResync && lastResync.reason || null,
            lastSuppressedReason: lastSuppressed && lastSuppressed.reason || null,
            lastAgeMs: lastResync && Number.isFinite(lastResync.perfAt)
                ? Math.max(0, performance.now() - lastResync.perfAt)
                : null,
            lastSuppressedAgeMs: lastSuppressed && Number.isFinite(lastSuppressed.perfAt)
                ? Math.max(0, performance.now() - lastSuppressed.perfAt)
                : null,
            lastInvalidations: lastResync && lastResync.invalidations || null,
            lastDetails: lastResync && lastResync.details || null
        };
    }

    function getEventCaptureApply(event) {
        return event
            && event.server
            && event.server.gameLoop
            && event.server.gameLoop.trails
            && event.server.gameLoop.trails.captureApply;
    }

    function isReliableBacklog(server) {
        return Boolean(server && (server.reliableBacklog || server.sendType === "volatile-pending"));
    }

    function normalizeServerNetworkDiagnostics(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            schema: value.schema,
            sequence: value.sequence,
            sendType: value.sendType,
            serverSentAt: finiteOrNull(value.serverSentAt),
            serverSendIntervalMs: finiteOrNull(value.serverSendIntervalMs),
            loopTick: finiteOrNull(value.loopTick),
            loopExpectedIntervalMs: finiteOrNull(value.loopExpectedIntervalMs),
            loopIntervalMs: finiteOrNull(value.loopIntervalMs),
            loopDriftMs: finiteOrNull(value.loopDriftMs),
            gameLoop: normalizeGameLoopDiagnostics(value.gameLoop),
            snapshotBuildMs: finiteOrNull(value.snapshotBuildMs),
            snapshotTime: finiteOrNull(value.snapshotTime),
            basePayloadBytes: finiteOrNull(value.basePayloadBytes),
            payloadMeasureMs: finiteOrNull(value.payloadMeasureMs),
            snapshotBreakdown: normalizeSnapshotBreakdown(value.snapshotBreakdown),
            playerCount: finiteOrNull(value.playerCount),
            territoryCount: finiteOrNull(value.territoryCount),
            trailCount: finiteOrNull(value.trailCount),
            preserveTrails: Boolean(value.preserveTrails),
            reliableInFlight: Boolean(value.reliableInFlight),
            reliableBacklog: Boolean(value.reliableBacklog),
            reliablePending: Boolean(value.reliablePending),
            reliableId: finiteOrNull(value.reliableId),
            reliableRetryCount: finiteOrNull(value.reliableRetryCount),
            reliableAgeMs: finiteOrNull(value.reliableAgeMs),
            reliableAckTimeouts: finiteOrNull(value.reliableAckTimeouts),
            lastReliableAck: normalizeReliableAck(value.lastReliableAck),
            snapshotResyncRequestCount: finiteOrNull(value.snapshotResyncRequestCount),
            lastSnapshotResync: normalizeSnapshotResyncDiagnostic(value.lastSnapshotResync),
            snapshotCacheInvalidationCount: finiteOrNull(value.snapshotCacheInvalidationCount),
            lastSnapshotCacheInvalidation: normalizeSnapshotCacheInvalidationDiagnostic(value.lastSnapshotCacheInvalidation)
        };
    }

    function normalizeGameLoopDiagnostics(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            schema: value.schema,
            updatedAt: finiteOrNull(value.updatedAt),
            roomCode: typeof value.roomCode === "string" ? value.roomCode : null,
            tick: finiteOrNull(value.tick),
            expectedIntervalMs: finiteOrNull(value.expectedIntervalMs),
            tickIntervalMs: finiteOrNull(value.tickIntervalMs),
            tickDriftMs: finiteOrNull(value.tickDriftMs),
            tickDurationMs: finiteOrNull(value.tickDurationMs),
            deltaTimeMs: finiteOrNull(value.deltaTimeMs),
            playerCount: finiteOrNull(value.playerCount),
            territoryCount: finiteOrNull(value.territoryCount),
            numberCount: finiteOrNull(value.numberCount),
            collisionCount: finiteOrNull(value.collisionCount),
            themeChanged: Boolean(value.themeChanged),
            bot: normalizeBotDiagnostics(value.bot),
            trails: normalizeTrailDiagnostics(value.trails),
            phases: normalizeGameLoopPhases(value.phases),
            slowestPhase: normalizeGameLoopSlowestPhase(value.slowestPhase)
        };
    }

    function normalizeTrailDiagnostics(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            activeTrailPlayers: finiteOrNull(value.activeTrailPlayers),
            captureApply: normalizeCaptureApplyDiagnostics(value.captureApply),
            captureAttempts: finiteOrNull(value.captureAttempts),
            captureChangedPlayerCount: finiteOrNull(value.captureChangedPlayerCount),
            captureOperationReplayAccepted: finiteOrNull(value.captureOperationReplayAccepted),
            captureOperationReplayAreaMismatch: finiteOrNull(value.captureOperationReplayAreaMismatch),
            captureOperationReplayInvalid: finiteOrNull(value.captureOperationReplayInvalid),
            captureOperationReplayRejected: finiteOrNull(value.captureOperationReplayRejected),
            captures: finiteOrNull(value.captures),
            clearTrailCount: finiteOrNull(value.clearTrailCount),
            closedTrailReturns: finiteOrNull(value.closedTrailReturns),
            fillPathCount: finiteOrNull(value.fillPathCount),
            fillPolygonCount: finiteOrNull(value.fillPolygonCount),
            ownerTrailSegmentChecks: finiteOrNull(value.ownerTrailSegmentChecks),
            phases: normalizeGameLoopPhases(value.phases),
            playersProcessed: finiteOrNull(value.playersProcessed),
            selfCollisionTests: finiteOrNull(value.selfCollisionTests),
            selfCollisions: finiteOrNull(value.selfCollisions),
            selfTrailSegmentChecks: finiteOrNull(value.selfTrailSegmentChecks),
            slowestPhase: normalizeGameLoopSlowestPhase(value.slowestPhase),
            trailOwnerChecks: finiteOrNull(value.trailOwnerChecks),
            trailOwnerHits: finiteOrNull(value.trailOwnerHits)
        };
    }

    function normalizeCaptureApplyDiagnostics(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            boundsOverlapCount: finiteOrNull(value.boundsOverlapCount),
            boundsRejectedCount: finiteOrNull(value.boundsRejectedCount),
            calls: finiteOrNull(value.calls),
            candidateCount: finiteOrNull(value.candidateCount),
            changedTerritoryCount: finiteOrNull(value.changedTerritoryCount),
            emptyCapturedBoundsCount: finiteOrNull(value.emptyCapturedBoundsCount),
            maxCapturedArea: finiteOrNull(value.maxCapturedArea),
            maxCapturedBoundsArea: finiteOrNull(value.maxCapturedBoundsArea),
            maxCapturedPointCount: finiteOrNull(value.maxCapturedPointCount),
            maxOwnerArea: finiteOrNull(value.maxOwnerArea),
            maxOwnerPointCount: finiteOrNull(value.maxOwnerPointCount),
            maxTerritoryCount: finiteOrNull(value.maxTerritoryCount),
            missingOwnerTerritoryCount: finiteOrNull(value.missingOwnerTerritoryCount),
            overlapCount: finiteOrNull(value.overlapCount),
            overlapRejectedCount: finiteOrNull(value.overlapRejectedCount),
            operationSimplifyAttemptCount: finiteOrNull(value.operationSimplifyAttemptCount),
            operationSimplifyCacheHitCount: finiteOrNull(value.operationSimplifyCacheHitCount),
            operationSimplifyCapturedCount: finiteOrNull(value.operationSimplifyCapturedCount),
            operationSimplifyHitCount: finiteOrNull(value.operationSimplifyHitCount),
            operationSimplifyInputPointCount: finiteOrNull(value.operationSimplifyInputPointCount),
            operationSimplifyMaxAreaDrift: finiteOrNull(value.operationSimplifyMaxAreaDrift),
            operationSimplifyMaxAreaDriftRatio: finiteOrNull(value.operationSimplifyMaxAreaDriftRatio),
            operationSimplifyOutputPointCount: finiteOrNull(value.operationSimplifyOutputPointCount),
            operationSimplifySubjectCount: finiteOrNull(value.operationSimplifySubjectCount),
            ownerChangedCount: finiteOrNull(value.ownerChangedCount),
            slowestOverlap: normalizeCaptureApplyOverlap(value.slowestOverlap),
            slowestSubtract: normalizeCaptureApplySubtract(value.slowestSubtract),
            subtractChangedCount: finiteOrNull(value.subtractChangedCount),
            subtractCount: finiteOrNull(value.subtractCount),
            subtractOperationClippingPointCount: finiteOrNull(value.subtractOperationClippingPointCount),
            subtractOperationPointCount: finiteOrNull(value.subtractOperationPointCount),
            subtractPointCount: finiteOrNull(value.subtractPointCount),
            subtractResultPointCount: finiteOrNull(value.subtractResultPointCount)
        };
    }

    function normalizeCaptureApplyOverlap(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            durationMs: finiteOrNull(value.durationMs),
            hit: Boolean(value.hit),
            playerId: typeof value.playerId === "string" ? value.playerId : null,
            subjectPointCount: finiteOrNull(value.subjectPointCount)
        };
    }

    function normalizeCaptureApplySubtract(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            changed: Boolean(value.changed),
            clippingPointCount: finiteOrNull(value.clippingPointCount),
            durationMs: finiteOrNull(value.durationMs),
            operationClippingPointCount: finiteOrNull(value.operationClippingPointCount),
            operationResultArea: finiteOrNull(value.operationResultArea),
            operationSubjectArea: finiteOrNull(value.operationSubjectArea),
            operationSubjectPointCount: finiteOrNull(value.operationSubjectPointCount),
            playerId: typeof value.playerId === "string" ? value.playerId : null,
            resultArea: finiteOrNull(value.resultArea),
            resultPointCount: finiteOrNull(value.resultPointCount),
            subjectArea: finiteOrNull(value.subjectArea),
            subjectPointCount: finiteOrNull(value.subjectPointCount),
            usedSimplified: Boolean(value.usedSimplified)
        };
    }

    function normalizeBotDiagnostics(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            cycle: finiteOrNull(value.cycle),
            decisionsProcessed: finiteOrNull(value.decisionsProcessed),
            pendingAfter: finiteOrNull(value.pendingAfter),
            pendingBefore: finiteOrNull(value.pendingBefore),
            phases: normalizeGameLoopPhases(value.phases),
            selfTrailSafety: normalizeSelfTrailSafetyDiagnostics(value.selfTrailSafety),
            slowestPhase: normalizeGameLoopSlowestPhase(value.slowestPhase)
        };
    }

    function normalizeSelfTrailSafetyDiagnostics(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            budgetHitCount: finiteOrNull(value.budgetHitCount),
            bypassCount: finiteOrNull(value.bypassCount),
            candidateCount: finiteOrNull(value.candidateCount),
            decisionCount: finiteOrNull(value.decisionCount),
            evaluatedCandidateCount: finiteOrNull(value.evaluatedCandidateCount),
            evaluatedLocalCandidateCount: finiteOrNull(value.evaluatedLocalCandidateCount),
            filteredTrailPointCount: finiteOrNull(value.filteredTrailPointCount),
            filteredTrailSegmentCount: finiteOrNull(value.filteredTrailSegmentCount),
            localCandidateCount: finiteOrNull(value.localCandidateCount),
            maxBudgetElapsedMs: finiteOrNull(value.maxBudgetElapsedMs),
            pathEvaluationCount: finiteOrNull(value.pathEvaluationCount),
            pointDistanceCheckCount: finiteOrNull(value.pointDistanceCheckCount),
            sampleCount: finiteOrNull(value.sampleCount),
            segmentCrossCheckCount: finiteOrNull(value.segmentCrossCheckCount),
            trailPointCount: finiteOrNull(value.trailPointCount),
            trailSegmentCount: finiteOrNull(value.trailSegmentCount),
            unsafeTargetCount: finiteOrNull(value.unsafeTargetCount)
        };
    }

    function normalizeGameLoopPhases(value) {
        const phases = {};

        for (const [name, durationMs] of Object.entries(value || {})) {
            phases[name] = finiteOrNull(durationMs);
        }

        return phases;
    }

    function normalizeGameLoopSlowestPhase(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            name: typeof value.name === "string" ? value.name : null,
            durationMs: finiteOrNull(value.durationMs)
        };
    }

    function normalizeSnapshotBreakdown(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            playerPositionCount: finiteOrNull(value.playerPositionCount),
            playerInfoCount: finiteOrNull(value.playerInfoCount),
            territoryVersionCount: finiteOrNull(value.territoryVersionCount),
            territoryPayloadCount: finiteOrNull(value.territoryPayloadCount),
            territoryOperationCount: finiteOrNull(value.territoryOperationCount),
            captureOperationCount: finiteOrNull(value.captureOperationCount),
            captureOperationTrailPointCount: finiteOrNull(value.captureOperationTrailPointCount),
            territoryPointDefinitionCount: finiteOrNull(value.territoryPointDefinitionCount),
            territoryRingReferenceCount: finiteOrNull(value.territoryRingReferenceCount),
            trailUpdateCount: finiteOrNull(value.trailUpdateCount),
            fullTrailUpdateCount: finiteOrNull(value.fullTrailUpdateCount),
            fullTrailPointCount: finiteOrNull(value.fullTrailPointCount),
            partialTrailUpdateCount: finiteOrNull(value.partialTrailUpdateCount),
            partialTrailRemainingPointCount: finiteOrNull(value.partialTrailRemainingPointCount),
            trailPatchUpdateCount: finiteOrNull(value.trailPatchUpdateCount),
            trailPatchPointCount: finiteOrNull(value.trailPatchPointCount),
            leaderboardCount: finiteOrNull(value.leaderboardCount),
            numberCount: finiteOrNull(value.numberCount),
            payloadBudget: normalizePayloadBudget(value.payloadBudget),
            payloadOutlier: normalizePayloadOutlier(value.payloadOutlier)
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

    function normalizePayloadOutlier(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            payloadBytes: finiteOrNull(value.payloadBytes),
            thresholdBytes: finiteOrNull(value.thresholdBytes),
            sectionBytes: normalizeNamedByteList(value.sectionBytes, "section"),
            topSections: normalizeNamedByteList(value.topSections, "section"),
            topTrails: normalizeTrailPayloadDetails(value.topTrails),
            topTerritories: normalizeTerritoryPayloadDetails(value.topTerritories),
            topTerritoryOps: normalizeTerritoryOperationPayloadDetails(value.topTerritoryOps)
        };
    }

    function normalizeNamedByteList(values, nameKey) {
        return (values || []).map(item => ({
            [nameKey]: item && typeof item[nameKey] === "string" ? item[nameKey] : null,
            bytes: finiteOrNull(item && item.bytes)
        }));
    }

    function normalizeTrailPayloadDetails(values) {
        return (values || []).map(item => ({
            playerId: item && typeof item.playerId === "string" ? item.playerId : null,
            bytes: finiteOrNull(item && item.bytes),
            full: Boolean(item && item.full),
            partial: Boolean(item && item.partial),
            pointBudget: finiteOrNull(item && item.pointBudget),
            pointCount: finiteOrNull(item && item.pointCount),
            patchPointCount: finiteOrNull(item && item.patchPointCount),
            remainingPointCount: finiteOrNull(item && item.remainingPointCount),
            fullPointCount: finiteOrNull(item && item.fullPointCount),
            leftPatchCount: finiteOrNull(item && item.leftPatchCount),
            rightPatchCount: finiteOrNull(item && item.rightPatchCount),
            leftPatchPointCount: finiteOrNull(item && item.leftPatchPointCount),
            rightPatchPointCount: finiteOrNull(item && item.rightPatchPointCount),
            leftFillPointCount: finiteOrNull(item && item.leftFillPointCount),
            rightFillPointCount: finiteOrNull(item && item.rightFillPointCount),
            leftSegmentPointCount: finiteOrNull(item && item.leftSegmentPointCount),
            rightSegmentPointCount: finiteOrNull(item && item.rightSegmentPointCount),
            leftFillPathPointCount: finiteOrNull(item && item.leftFillPathPointCount),
            rightFillPathPointCount: finiteOrNull(item && item.rightFillPathPointCount)
        }));
    }

    function normalizeTerritoryPayloadDetails(values) {
        return (values || []).map(item => ({
            playerId: item && typeof item.playerId === "string" ? item.playerId : null,
            bytes: finiteOrNull(item && item.bytes),
            pointDefinitionCount: finiteOrNull(item && item.pointDefinitionCount),
            ringReferenceCount: finiteOrNull(item && item.ringReferenceCount),
            version: finiteOrNull(item && item.version)
        }));
    }

    function normalizeTerritoryOperationPayloadDetails(values) {
        return (values || []).map(item => ({
            playerId: item && typeof item.playerId === "string" ? item.playerId : null,
            bytes: finiteOrNull(item && item.bytes),
            type: item && typeof item.type === "string" ? item.type : null,
            trailPointCount: finiteOrNull(item && item.trailPointCount),
            trailTailPointCount: finiteOrNull(item && item.trailTailPointCount),
            version: finiteOrNull(item && item.version)
        }));
    }

    function normalizeReliableAck(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            reliableId: finiteOrNull(value.reliableId),
            acknowledgedAt: finiteOrNull(value.acknowledgedAt),
            ackLatencyMs: finiteOrNull(value.ackLatencyMs),
            applied: Boolean(value.applied),
            invalidations: countInvalidations(value.invalidations)
        };
    }

    function normalizeSnapshotResyncDiagnostic(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            at: finiteOrNull(value.at),
            ageMs: finiteOrNull(value.ageMs),
            count: finiteOrNull(value.count)
        };
    }

    function normalizeSnapshotCacheInvalidationDiagnostic(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            at: finiteOrNull(value.at),
            ageMs: finiteOrNull(value.ageMs),
            count: finiteOrNull(value.count),
            fullCacheReset: Boolean(value.fullCacheReset),
            invalidations: countInvalidations(value.invalidations)
        };
    }

    function countInvalidations(invalidations) {
        return {
            playerInfo: getInvalidationCount(invalidations && invalidations.playerInfo),
            territories: getInvalidationCount(invalidations && invalidations.territories),
            trails: getInvalidationCount(invalidations && invalidations.trails)
        };
    }

    function countItems(value) {
        return Array.isArray(value) ? value.length : 0;
    }

    function hasAnyInvalidationCounts(invalidations) {
        const counts = normalizeInvalidationCounts(invalidations);

        return counts.playerInfo > 0 || counts.territories > 0 || counts.trails > 0;
    }

    function sumInvalidationCounts(invalidationsList) {
        return (invalidationsList || []).reduce((sum, invalidations) => {
            const counts = normalizeInvalidationCounts(invalidations);

            sum.playerInfo += counts.playerInfo;
            sum.territories += counts.territories;
            sum.trails += counts.trails;

            return sum;
        }, {
            playerInfo: 0,
            territories: 0,
            trails: 0
        });
    }

    function normalizeInvalidationCounts(invalidations) {
        return {
            playerInfo: getInvalidationCount(invalidations && invalidations.playerInfo),
            territories: getInvalidationCount(invalidations && invalidations.territories),
            trails: getInvalidationCount(invalidations && invalidations.trails)
        };
    }

    function getInvalidationCount(value) {
        if (Array.isArray(value)) {
            return value.length;
        }

        return Number.isFinite(value) ? Math.max(0, value) : 0;
    }

    function getDiagnosticsWindowDurationMs(events) {
        const timedEvents = (events || []).filter(event => Number.isFinite(event && event.perfAt));

        if (timedEvents.length < 2) {
            return null;
        }

        return Math.max(0, timedEvents[timedEvents.length - 1].perfAt - timedEvents[0].perfAt);
    }

    function calculateRatePerMinute(count, durationMs) {
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            return null;
        }

        return count / durationMs * 60000;
    }

    function countBy(values) {
        return (values || []).reduce((counts, value) => {
            const key = value === null || value === undefined || value === "" ? "(none)" : String(value);

            counts[key] = (counts[key] || 0) + 1;

            return counts;
        }, {});
    }

    function getNetworkDiagnosticsHistoryLimit() {
        const configuredLimit = Number(networkConfig.diagnosticsHistoryLimit);

        return Number.isInteger(configuredLimit) && configuredLimit > 0
            ? configuredLimit
            : 240;
    }

    function getSlowBufferMs() {
        return getFiniteConfigNumber(
            networkConfig.diagnosticsSlowBufferMs,
            getFiniteConfigNumber(networkConfig.minBufferMs, 100) + 50
        );
    }

    function averageFiniteValues(values) {
        const finiteValues = values.filter(Number.isFinite);

        if (finiteValues.length === 0) {
            return null;
        }

        return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
    }

    function maxFiniteValue(values) {
        const finiteValues = values.filter(Number.isFinite);

        return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
    }

    function finiteOrNull(value) {
        return Number.isFinite(value) ? value : null;
    }

    function createApplyResult() {
        return {
            applied: true,
            invalidations: {
                playerInfo: [],
                territories: [],
                trails: []
            }
        };
    }

    function markCacheInvalid(applyResult, type, id) {
        if (!applyResult || !applyResult.invalidations || !id) {
            return;
        }

        const ids = applyResult.invalidations[type];

        if (!ids || ids.includes(id)) {
            applyResult.applied = false;
            return;
        }

        ids.push(id);
        applyResult.applied = false;
    }

    function expandSnapshot(rawSnapshot, applyResult) {
        if (rawSnapshot && rawSnapshot.schema === 2) {
            return expandCompactSnapshot(rawSnapshot, applyResult);
        }

        return expandLegacySnapshot(rawSnapshot);
    }

    function expandCompactSnapshot(rawSnapshot, applyResult) {
        updatePlayerInfoCache(rawSnapshot.playerInfo, rawSnapshot.sequence);
        updateTerritoryCache(rawSnapshot.territories, applyResult, rawSnapshot.sequence);
        updateTrailCache(rawSnapshot.trails, applyResult, rawSnapshot.sequence);
        const activeTrailIds = new Set(rawSnapshot.trailIds || []);
        const failedTerritoryOperationIds = updateTerritoryOperations(rawSnapshot.territoryOps, activeTrailIds, applyResult);
        const ignoredTerritoryResyncIds = createIgnoredTerritoryResyncIds(failedTerritoryOperationIds);

        const players = expandPlayers(rawSnapshot.players, rawSnapshot.debug);
        const territories = selectCachedEntities(entityCache.territories, rawSnapshot.territoryIds);
        const trails = rawSnapshot.preserveTrails
            ? getPreviousSnapshotEntities("trails")
            : selectCachedEntities(entityCache.trails, rawSnapshot.trailIds);

        requestRecoveryForMissingCachedEntities(rawSnapshot.territoryIds, territories, "territories", applyResult, ignoredTerritoryResyncIds);
        requestRecoveryForStaleCachedVersions(rawSnapshot.territoryVersions, territories, applyResult, ignoredTerritoryResyncIds);

        if (!rawSnapshot.preserveTrails) {
            requestRecoveryForMissingCachedEntities(rawSnapshot.trailIds, trails, "trails", applyResult);
        }

        debugState.visiblePlayers = Object.keys(players).length;
        debugState.visibleTerritories = Object.keys(territories).length;
        debugState.visibleTrails = Object.keys(trails).length;

        return {
            sequence: rawSnapshot.sequence,
            time: rawSnapshot.time,
            players,
            territories,
            trails,
            trailIds: rawSnapshot.trailIds || Object.keys(trails),
            preserveTrails: Boolean(rawSnapshot.preserveTrails),
            leaderboard: rawSnapshot.leaderboard || [],
            mode: rawSnapshot.mode || null,
            numbers: rawSnapshot.numbers || null
        };
    }

    function expandLegacySnapshot(rawSnapshot) {
        const snapshot = rawSnapshot || {
            time: Date.now(),
            players: {},
            territories: {},
            trails: {}
        };

        debugState.visiblePlayers = Object.keys(snapshot.players || {}).length;
        debugState.visibleTerritories = Object.keys(snapshot.territories || {}).length;
        debugState.visibleTrails = Object.keys(snapshot.trails || {}).length;

        return {
            sequence: snapshot.sequence,
            time: snapshot.time,
            players: snapshot.players || {},
            territories: snapshot.territories || {},
            trails: snapshot.trails || {},
            trailIds: Object.keys(snapshot.trails || {}),
            preserveTrails: false,
            leaderboard: snapshot.leaderboard || [],
            mode: snapshot.mode || null,
            numbers: snapshot.numbers || null
        };
    }

    function updateAdaptiveBuffer(now) {
        if (!Number.isFinite(networkState.lastSnapshotReceivedAt)) {
            networkState.lastSnapshotReceivedAt = now;
            return;
        }

        const delta = now - networkState.lastSnapshotReceivedAt;
        networkState.lastSnapshotReceivedAt = now;
        networkState.deltas.push(delta);

        if (networkState.deltas.length > networkConfig.maxJitterSamples) {
            networkState.deltas.shift();
        }

        const average = calculateAverage(networkState.deltas);
        const jitter = calculateStandardDeviation(networkState.deltas, average);
        const adaptiveSamples = getAdaptiveBufferSamples(networkState.deltas, networkConfig);
        const adaptiveAverage = calculateAverage(adaptiveSamples);
        const adaptiveJitter = calculateStandardDeviation(adaptiveSamples, adaptiveAverage);
        const percentileBuffer = calculatePercentile(
            networkState.deltas,
            getAdaptiveBufferPercentile(networkConfig)
        );
        const nextBuffer = Math.max(
            percentileBuffer,
            adaptiveAverage + adaptiveJitter * networkConfig.jitterMultiplier
        );

        networkState.lastSnapshotDeltaMs = delta;
        networkState.averageSnapshotDeltaMs = average;
        networkState.jitterMs = jitter;
        networkState.bufferMs = clamp(
            nextBuffer,
            networkConfig.minBufferMs,
            networkConfig.maxBufferMs
        );
    }

    function syncServerClock(serverTime) {
        const nextOffset = Date.now() - serverTime;

        if (!hasServerClockSync) {
            networkState.serverOffset = nextOffset;
            hasServerClockSync = true;
            return;
        }

        networkState.serverOffset = networkState.serverOffset * 0.9 + nextOffset * 0.1;
    }

    function saveSnapshot(snapshot) {
        snapshots.push(snapshot);

        while (snapshots.length > networkConfig.maxSnapshots) {
            snapshots.shift();
        }
    }

    function isSnapshotNewerThanRenderBuffer(snapshot) {
        const latest = snapshots[snapshots.length - 1];

        if (!latest) {
            return true;
        }

        if (Number.isSafeInteger(snapshot.sequence) && Number.isSafeInteger(latest.sequence)) {
            return snapshot.sequence > latest.sequence;
        }

        return Number.isFinite(snapshot.time)
            && (!Number.isFinite(latest.time) || snapshot.time > latest.time);
    }

    function findSnapshotPair(renderTime) {
        let previous = snapshots[0];
        let next = snapshots[1];

        if (renderTime <= previous.time) {
            return { previous, next };
        }

        for (let index = 0; index < snapshots.length - 1; index++) {
            previous = snapshots[index];
            next = snapshots[index + 1];

            if (previous.time <= renderTime && next.time >= renderTime) {
                return { previous, next };
            }
        }

        return { previous, next };
    }

    function interpolatePlayers(previous, next, amount) {
        const renderedPlayers = {};
        const ids = new Set([
            ...Object.keys(previous.players),
            ...Object.keys(next.players)
        ]);

        for (const id of ids) {
            const previousPlayer = previous.players[id];
            const nextPlayer = next.players[id];

            if (!previousPlayer && nextPlayer) {
                renderedPlayers[id] = nextPlayer;
                continue;
            }

            if (previousPlayer && !nextPlayer) {
                continue;
            }

            renderedPlayers[id] = {
                ...nextPlayer,
                x: lerp(previousPlayer.x, nextPlayer.x, amount),
                y: lerp(previousPlayer.y, nextPlayer.y, amount),
                angle: lerpAngle(previousPlayer.angle, nextPlayer.angle, amount)
            };
        }

        return renderedPlayers;
    }

    function createRenderState(snapshot, players) {
        return {
            players,
            leaderboard: snapshot.leaderboard || [],
            mode: snapshot.mode || null,
            numbers: snapshot.numbers || null,
            territories: snapshot.territories,
            trails: snapshot.trails,
            trailIds: snapshot.trailIds || Object.keys(snapshot.trails || {}),
            preserveTrails: Boolean(snapshot.preserveTrails)
        };
    }

    function createInterpolatedRenderState(previous, next, players, amount) {
        return {
            players,
            leaderboard: next.leaderboard || previous.leaderboard || [],
            mode: next.mode || previous.mode || null,
            numbers: next.numbers || previous.numbers || null,
            territories: next.territories,
            trails: createPredictedTrailState(previous, next, players, amount),
            trailIds: previous.trailIds || Object.keys(previous.trails || {}),
            preserveTrails: Boolean(previous.preserveTrails)
        };
    }

    function createPredictedTrailState(previous, next, players, amount) {
        const baseTrails = previous.trails || {};

        if (!shouldPredictTrails(amount) || next.preserveTrails) {
            return baseTrails;
        }

        const activeNextTrailIds = new Set(next.trailIds || Object.keys(next.trails || {}));
        const territories = next.territories || previous.territories || {};
        let predictedTrails = null;

        for (const [id, trail] of Object.entries(baseTrails)) {
            if (!activeNextTrailIds.has(id) || !next.trails || !next.trails[id]) {
                continue;
            }

            const predictedTrail = createPredictedTrail(trail, players[id], territories[id]);

            if (predictedTrail === trail) {
                continue;
            }

            if (!predictedTrails) {
                predictedTrails = { ...baseTrails };
            }

            predictedTrails[id] = predictedTrail;
        }

        return predictedTrails || baseTrails;
    }

    function shouldPredictTrails(amount) {
        if (networkConfig.trailPredictionEnabled === false || amount <= 0) {
            return false;
        }

        const maxBufferMs = getFiniteConfigNumber(
            networkConfig.trailPredictionMaxBufferMs,
            getFiniteConfigNumber(networkConfig.minBufferMs, 100) + 40
        );

        return networkState.bufferMs <= maxBufferMs;
    }

    function createPredictedTrail(trail, player, territory) {
        if (!trail || !player || !Number.isFinite(player.x) || !Number.isFinite(player.y) || !Number.isFinite(player.angle)) {
            return trail;
        }

        const sample = createTrailPredictionSample(player);
        const shouldPredictLeft = !isPointInsideTerritory(sample.leftPoint, territory);
        const shouldPredictRight = !isPointInsideTerritory(sample.rightPoint, territory);
        const leftSegments = shouldPredictLeft
            ? appendPredictedPointToLastSegment(trail.leftSegments, sample.leftPoint)
            : trail.leftSegments;
        const rightSegments = shouldPredictRight
            ? appendPredictedPointToLastSegment(trail.rightSegments, sample.rightPoint)
            : trail.rightSegments;

        if (leftSegments === trail.leftSegments && rightSegments === trail.rightSegments) {
            return trail;
        }

        const leftFillPath = shouldPredictLeft
            ? appendPredictedPointToFillPath(trail.leftFillPath, sample.leftPoint)
            : trail.leftFillPath;
        const rightFillPath = shouldPredictRight
            ? appendPredictedPointToFillPath(trail.rightFillPath, sample.rightPoint)
            : trail.rightFillPath;
        const fillChanged = leftFillPath !== trail.leftFillPath || rightFillPath !== trail.rightFillPath;

        return {
            id: trail.id,
            color: trail.color,
            leftSegments,
            rightSegments,
            leftFillPath,
            rightFillPath,
            fillPolygon: fillChanged
                ? createTrailFillPolygon(leftFillPath, rightFillPath)
                : trail.fillPolygon
        };
    }

    function createTrailPredictionSample(player) {
        const halfWidth = getFiniteConfigNumber(networkConfig.trailPredictionPlayerHalfWidth, 35);
        const normalX = -Math.sin(player.angle);
        const normalY = Math.cos(player.angle);

        return {
            leftPoint: {
                x: player.x + normalX * halfWidth,
                y: player.y + normalY * halfWidth
            },
            rightPoint: {
                x: player.x - normalX * halfWidth,
                y: player.y - normalY * halfWidth
            }
        };
    }

    function appendPredictedPointToLastSegment(segments, point) {
        if (!Array.isArray(segments) || segments.length === 0) {
            return segments;
        }

        const lastIndex = segments.length - 1;
        const nextSegment = appendPredictedPoint(segments[lastIndex], point);

        if (nextSegment === segments[lastIndex]) {
            return segments;
        }

        const nextSegments = segments.slice();
        nextSegments[lastIndex] = nextSegment;

        return nextSegments;
    }

    function appendPredictedPointToFillPath(points, point) {
        if (!Array.isArray(points) || points.length === 0) {
            return points;
        }

        return appendPredictedPoint(points, point);
    }

    function appendPredictedPoint(points, point) {
        if (!Array.isArray(points) || points.length === 0 || !isValidPoint(point)) {
            return points;
        }

        const lastPoint = points[points.length - 1];

        if (!isValidPoint(lastPoint) || !isPredictionDistanceAllowed(lastPoint, point)) {
            return points;
        }

        return points.concat({
            x: point.x,
            y: point.y
        });
    }

    function isPredictionDistanceAllowed(first, second) {
        const distanceSquared = getDistanceSquared(first, second);
        const minDistance = getFiniteConfigNumber(networkConfig.trailPredictionMinPointDistance, 2);
        const maxDistance = getFiniteConfigNumber(networkConfig.trailPredictionMaxPointDistance, 180);

        return distanceSquared >= minDistance * minDistance
            && distanceSquared <= maxDistance * maxDistance;
    }

    function isPointInsideTerritory(point, territory) {
        if (!isValidPoint(point) || !territory) {
            return false;
        }

        return getTerritoryPolygons(territory)
            .some(polygon => isPointInsidePolygon(point, polygon));
    }

    function getTerritoryPolygons(territory) {
        if (territory && territory.polygon && Array.isArray(territory.polygon.rings)) {
            return [territory.polygon];
        }

        return Array.isArray(territory && territory.polygons)
            ? territory.polygons
            : [];
    }

    function isPointInsidePolygon(point, polygon) {
        return (polygon && polygon.rings || [])
            .some(ring => isPointInsideOrOnRing(point, ring));
    }

    function updatePlayerInfoCache(playerInfo, snapshotSequence) {
        for (const [id, info] of Object.entries(playerInfo || {})) {
            const cachedInfo = entityCache.playerInfo[id];
            const version = info[3];

            if (
                cachedInfo
                && Number.isFinite(version)
                && Number.isFinite(cachedInfo.version)
                && version < cachedInfo.version
            ) {
                continue;
            }

            entityCache.playerInfo[id] = {
                color: info[0],
                territoryX: info[1],
                territoryY: info[2],
                version,
                snapshotSequence,
                name: info[4],
                eliminations: info[5],
                lives: info[6],
                maxLives: info[7],
                catchBalance: info[8]
            };
        }
    }

    function updateTerritoryCache(territories, applyResult, snapshotSequence) {
        for (const [id, territory] of Object.entries(territories || {})) {
            const cachedTerritory = entityCache.territories[id];

            if (
                cachedTerritory
                && Number.isFinite(territory.version)
                && Number.isFinite(cachedTerritory.version)
                && territory.version < cachedTerritory.version
            ) {
                continue;
            }

            const base = territory.base || [0, 0];
            const polygon = unpackTerritoryPolygon(territory.polygon);

            if (!polygon) {
                markCacheInvalid(applyResult, "territories", id);
                continue;
            }

            entityCache.territories[id] = {
                id,
                color: territory.color,
                version: territory.version,
                snapshotSequence,
                baseX: base[0],
                baseY: base[1],
                polygon
            };
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }
    }

    function updateTerritoryOperations(operations, activeTrailIds, applyResult) {
        const failedIds = new Set();

        for (const [id, operation] of Object.entries(operations || {})) {
            const duplicateFailure = getFailedTerritoryOperation(id, operation);

            if (duplicateFailure) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure);
                continue;
            }

            if (shouldDeferTerritoryOperation(id, operation, activeTrailIds)) {
                pendingTerritoryOperations.set(id, operation);
                continue;
            }

            const operationResult = applyCaptureTerritoryOperation(id, operation);

            if (!operationResult.applied) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                markFailedTerritoryOperation(id, operation, operationResult);
                handleCaptureOperationFailure(id, operationResult, operation);
                continue;
            }

            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }

        applyPendingTerritoryOperations(activeTrailIds, applyResult, failedIds);

        return failedIds;
    }

    function shouldDeferTerritoryOperation(id, operation, activeTrailIds) {
        return operation
            && operation.type === "trailCapture"
            && activeTrailIds.has(id)
            && !hasFallbackTrailPoints(operation);
    }

    function applyPendingTerritoryOperations(activeTrailIds, applyResult, failedIds) {
        for (const [id, operation] of pendingTerritoryOperations.entries()) {
            if (activeTrailIds.has(id)) {
                continue;
            }

            const duplicateFailure = getFailedTerritoryOperation(id, operation);

            if (duplicateFailure) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure);
                continue;
            }

            const operationResult = applyCaptureTerritoryOperation(id, operation);

            if (!operationResult.applied) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                markFailedTerritoryOperation(id, operation, operationResult);
                handleCaptureOperationFailure(id, operationResult, operation);
                continue;
            }

            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }
    }

    function applyCaptureTerritoryOperation(id, operation) {
        if (!operation || operation.type !== "trailCapture") {
            return createCaptureOperationFailure("invalid_operation", {
                operationType: operation && operation.type
            });
        }

        const territory = entityCache.territories[id];

        if (!territory) {
            return createCaptureOperationFailure("missing_cached_territory", {
                expectedBaseVersion: operation.baseVersion,
                operationVersion: operation.version
            });
        }

        if (
            Number.isFinite(operation.version)
            && Number.isFinite(territory.version)
            && territory.version >= operation.version
        ) {
            return {
                applied: true,
                skipped: true
            };
        }

        if (territory.version !== operation.baseVersion) {
            return createCaptureOperationFailure("territory_version_mismatch", {
                localTerritoryVersion: territory.version,
                expectedBaseVersion: operation.baseVersion,
                operationVersion: operation.version
            });
        }

        const trailSegmentState = getCaptureTrailSegmentState(id, operation);
        const trailSegment = trailSegmentState.points;
        const startContact = unpackCaptureContact(operation.startContact);
        const endContact = unpackCaptureContact(operation.endContact);
        const keepAnchor = unpackPoint(operation.keepAnchor);

        if (!trailSegment) {
            return createCaptureOperationFailure("missing_or_incomplete_trail_segment", trailSegmentState.debug);
        }

        if (!startContact || !endContact || !keepAnchor) {
            return createCaptureOperationFailure("invalid_capture_geometry_reference", {
                hasStartContact: Boolean(startContact),
                hasEndContact: Boolean(endContact),
                hasKeepAnchor: Boolean(keepAnchor)
            });
        }

        const ring = territory.polygon && territory.polygon.rings && territory.polygon.rings[0];

        if (!Array.isArray(ring) || ring.length < 3) {
            return createCaptureOperationFailure("invalid_cached_territory_ring", {
                localTerritoryVersion: territory.version,
                ringLength: Array.isArray(ring) ? ring.length : 0
            });
        }

        const localStartContact = getLocalBoundaryContact(ring, startContact);
        const localEndContact = getLocalBoundaryContact(ring, endContact);

        if (!localStartContact || !localEndContact) {
            return createCaptureOperationFailure("boundary_contact_not_found", {
                ringLength: ring.length,
                hasLocalStartContact: Boolean(localStartContact),
                hasLocalEndContact: Boolean(localEndContact)
            });
        }

        const boundaryPathState = getCaptureBoundaryPath(ring, localEndContact, localStartContact, operation, keepAnchor);
        const boundaryPath = boundaryPathState.path;

        if (!boundaryPath) {
            return createCaptureOperationFailure("boundary_path_not_found", {
                boundaryPathCount: boundaryPathState.pathCount,
                ringLength: ring.length
            });
        }

        const trailPoints = createClippedTrailPoints(
            trailSegment,
            operation.trailSegmentLength,
            localStartContact.point,
            localEndContact.point
        );
        const nextRing = normalizePolygonRing(trailPoints.concat(boundaryPath));

        if (nextRing.length < 4) {
            return createCaptureOperationFailure("resulting_ring_too_short", {
                trailPointCount: trailPoints.length,
                boundaryPathPointCount: boundaryPath.length,
                nextRingLength: nextRing.length
            });
        }

        const validationResult = validateCaptureOperationResult(territory, ring, nextRing);

        if (!validationResult.valid) {
            return createCaptureOperationFailure(validationResult.reason, {
                ...validationResult.details,
                trailPointCount: trailPoints.length,
                boundaryPathPointCount: boundaryPath.length,
                boundaryPathSource: boundaryPathState.source
            });
        }

        entityCache.territories[id] = {
            ...territory,
            version: operation.version,
            polygon: {
                rings: [nextRing]
            }
        };

        return {
            applied: true
        };
    }

    function validateCaptureOperationResult(territory, previousRing, nextRing) {
        const previousArea = Math.abs(calculateRingArea(previousRing));
        const nextArea = Math.abs(calculateRingArea(nextRing));

        if (!Number.isFinite(nextArea) || nextArea <= geometryEpsilon) {
            return {
                valid: false,
                reason: "capture_result_invalid_area",
                details: {
                    nextArea
                }
            };
        }

        if (hasSelfIntersections(nextRing)) {
            return {
                valid: false,
                reason: "capture_result_self_intersection",
                details: {
                    nextArea,
                    previousArea,
                    pointCount: nextRing.length
                }
            };
        }

        if (Number.isFinite(previousArea) && previousArea > geometryEpsilon) {
            const tolerance = Math.max(
                captureAreaRegressionTolerance,
                previousArea * captureAreaRegressionRatioTolerance
            );

            if (nextArea + tolerance < previousArea) {
                return {
                    valid: false,
                    reason: "capture_result_area_regressed",
                    details: {
                        nextArea,
                        previousArea,
                        tolerance
                    }
                };
            }
        }

        const basePoint = getTerritoryBasePoint(territory);

        if (basePoint && !isPointInsideOrOnRing(basePoint, nextRing)) {
            return {
                valid: false,
                reason: "capture_result_lost_base",
                details: {
                    baseX: basePoint.x,
                    baseY: basePoint.y,
                    nextArea,
                    previousArea
                }
            };
        }

        return {
            valid: true
        };
    }

    function getTerritoryBasePoint(territory) {
        if (!territory
            || !Number.isFinite(territory.baseX)
            || !Number.isFinite(territory.baseY)) {
            return null;
        }

        return {
            x: territory.baseX,
            y: territory.baseY
        };
    }

    function getLocalBoundaryContact(ring, contact) {
        const indexedContact = createIndexedBoundaryContact(ring, contact);

        if (indexedContact) {
            return indexedContact;
        }

        return findClosestPolygonBoundaryContact(ring, contact.point);
    }

    function createIndexedBoundaryContact(ring, contact) {
        if (!contact
            || !Array.isArray(ring)
            || !Number.isInteger(contact.segmentIndex)
            || !Number.isFinite(contact.segmentT)) {
            return null;
        }

        const openRingLength = getOpenRingLength(ring);

        if (contact.segmentIndex < 0 || contact.segmentIndex >= openRingLength) {
            return null;
        }

        const segmentStart = getOpenRingPoint(ring, contact.segmentIndex);
        const segmentEnd = getOpenRingPoint(ring, (contact.segmentIndex + 1) % openRingLength);
        const projection = projectPointOnSegment(contact.point, segmentStart, segmentEnd);

        if (projection.distanceSquared > indexedBoundaryMaxDistanceSquared) {
            return null;
        }

        return {
            point: projection.point,
            segmentIndex: contact.segmentIndex,
            segmentT: projection.segmentT
        };
    }

    function getOpenRingLength(ring) {
        if (!Array.isArray(ring)) {
            return 0;
        }

        if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
            return ring.length - 1;
        }

        return ring.length;
    }

    function getOpenRingPoint(ring, index) {
        return ring[index];
    }

    function getCaptureBoundaryPath(ring, startContact, endContact, operation, keepAnchor) {
        if (Number.isInteger(operation.boundaryPathIndex)) {
            const indexedPath = createBoundaryPathByIndex(ring, startContact, endContact, operation.boundaryPathIndex);

            if (indexedPath && isBoundaryPathConsistentWithAnchor(indexedPath, keepAnchor)) {
                return {
                    path: indexedPath,
                    pathCount: 1,
                    source: "index"
                };
            }
        }

        const boundaryPaths = createBoundaryPaths(ring, startContact, endContact);

        return {
            path: selectBoundaryPathByAnchor(boundaryPaths, keepAnchor),
            pathCount: boundaryPaths.length,
            source: "anchor"
        };
    }

    function createBoundaryPathByIndex(ring, startContact, endContact, pathIndex) {
        const openRingLength = getOpenRingLength(ring);

        if (!startContact || !endContact || openRingLength < 3) {
            return null;
        }

        if (pathIndex === 0) {
            return removeConsecutiveDuplicatePoints(
                createForwardBoundaryPathFromRing(ring, openRingLength, startContact, endContact)
            );
        }

        if (pathIndex === 1) {
            return removeConsecutiveDuplicatePoints(
                createForwardBoundaryPathFromRing(ring, openRingLength, endContact, startContact).reverse()
            );
        }

        return null;
    }

    function createForwardBoundaryPathFromRing(ring, openRingLength, startContact, endContact) {
        if (startContact.segmentIndex === endContact.segmentIndex
            && endContact.segmentT >= startContact.segmentT) {
            return [startContact.point, endContact.point];
        }

        const path = [startContact.point];
        let vertexIndex = (startContact.segmentIndex + 1) % openRingLength;
        let guard = 0;

        while (guard <= openRingLength) {
            path.push(getOpenRingPoint(ring, vertexIndex));

            if (vertexIndex === endContact.segmentIndex) {
                break;
            }

            vertexIndex = (vertexIndex + 1) % openRingLength;
            guard++;
        }

        path.push(endContact.point);

        return path;
    }

    function isBoundaryPathConsistentWithAnchor(path, anchor) {
        if (!Array.isArray(path) || path.length < 2 || !anchor) {
            return false;
        }

        if (path.length > 2) {
            return getDistanceSquared(path[1], anchor) <= indexedBoundaryMaxDistanceSquared;
        }

        return getPointPathDistanceSquared(anchor, path) <= indexedBoundaryMaxDistanceSquared;
    }

    function getCaptureTrailSegment(id, operation) {
        return getCaptureTrailSegmentState(id, operation).points;
    }

    function getCaptureTrailSegmentState(id, operation) {
        const trail = entityCache.trails[id];
        const fallbackPoints = unpackPoints(operation.trailPoints);
        const trailTailPoints = unpackPoints(operation.trailTailPoints);
        const trailTailStart = Number.isInteger(operation.trailTailStart)
            ? operation.trailTailStart
            : null;

        const segments = trail && operation.trailSide === "right"
            ? trail.rightSegments
            : trail && trail.leftSegments;
        const segment = segments && segments[operation.trailSegmentIndex];
        const mergedSegment = createMergedTrailSegment(segment, trailTailStart, trailTailPoints);
        const debug = {
            hasCachedTrail: Boolean(trail),
            trailSide: operation.trailSide,
            cachedSideSegmentCount: Array.isArray(segments) ? segments.length : 0,
            trailSegmentIndex: operation.trailSegmentIndex,
            cachedSegmentLength: Array.isArray(segment) ? segment.length : 0,
            requiredSegmentLength: operation.trailSegmentLength,
            fallbackTrailPointCount: fallbackPoints.length,
            trailTailStart,
            trailTailPointCount: trailTailPoints.length,
            mergedSegmentLength: Array.isArray(mergedSegment) ? mergedSegment.length : 0
        };

        if (canUseCachedTrailSegment(segment, operation)) {
            return {
                points: segment,
                debug: {
                    ...debug,
                    trailPointSource: "cache"
                }
            };
        }

        if (canUseCachedTrailSegment(mergedSegment, operation)) {
            return {
                points: mergedSegment,
                debug: {
                    ...debug,
                    trailPointSource: "cache_tail"
                }
            };
        }

        if (fallbackPoints.length >= 2) {
            return {
                points: fallbackPoints,
                debug: {
                    ...debug,
                    trailPointSource: "fallback"
                }
            };
        }

        return {
            points: null,
            debug: {
                ...debug,
                trailPointSource: "none"
            }
        };
    }

    function createMergedTrailSegment(segment, trailTailStart, trailTailPoints) {
        if (!Array.isArray(trailTailPoints)
            || trailTailPoints.length === 0
            || !Number.isInteger(trailTailStart)
            || trailTailStart < 0) {
            return null;
        }

        const cachedPrefix = Array.isArray(segment) ? segment.slice(0, trailTailStart) : [];

        if (cachedPrefix.length !== trailTailStart) {
            return null;
        }

        return cachedPrefix.concat(trailTailPoints);
    }

    function createCaptureOperationFailure(reason, details = {}) {
        return {
            applied: false,
            reason,
            details
        };
    }

    function markFailedTerritoryOperation(id, operation, operationResult) {
        const key = createTerritoryOperationKey(id, operation);

        if (!key) {
            return;
        }

        failedTerritoryOperationKeys.set(key, {
            reason: operationResult && operationResult.reason || null,
            details: operationResult && operationResult.details || null
        });
    }

    function getFailedTerritoryOperation(id, operation) {
        const key = createTerritoryOperationKey(id, operation);

        return key ? failedTerritoryOperationKeys.get(key) : null;
    }

    function clearFailedTerritoryOperationKeys(id) {
        const prefix = `${id}:`;

        for (const key of failedTerritoryOperationKeys.keys()) {
            if (key.startsWith(prefix)) {
                failedTerritoryOperationKeys.delete(key);
            }
        }
    }

    function createTerritoryOperationKey(id, operation) {
        if (!id || !operation) {
            return null;
        }

        return [
            id,
            operation.type || "unknown",
            Number.isFinite(operation.baseVersion) ? operation.baseVersion : "base?",
            Number.isFinite(operation.version) ? operation.version : "version?",
            operation.trailSide || "side?",
            Number.isInteger(operation.trailSegmentIndex) ? operation.trailSegmentIndex : "segment?",
            Number.isInteger(operation.trailSegmentLength) ? operation.trailSegmentLength : "length?",
            Number.isInteger(operation.boundaryPathIndex) ? operation.boundaryPathIndex : "path?"
        ].join(":");
    }

    function createCaptureOperationDiagnosticsDetails(id, operationResult, operation) {
        const details = operationResult && operationResult.details || {};

        return {
            territoryId: id,
            operationType: operation && operation.type || null,
            baseVersion: finiteOrNull(operation && operation.baseVersion),
            operationVersion: finiteOrNull(operation && operation.version),
            trailSide: operation && operation.trailSide || null,
            trailSegmentIndex: Number.isInteger(operation && operation.trailSegmentIndex)
                ? operation.trailSegmentIndex
                : null,
            trailSegmentLength: Number.isInteger(operation && operation.trailSegmentLength)
                ? operation.trailSegmentLength
                : null,
            boundaryPathIndex: Number.isInteger(operation && operation.boundaryPathIndex)
                ? operation.boundaryPathIndex
                : null,
            hasFallbackTrailPoints: hasFallbackTrailPoints(operation),
            fallbackTrailPointCount: countPackedPoints(operation && operation.trailPoints),
            trailTailStart: Number.isInteger(operation && operation.trailTailStart)
                ? operation.trailTailStart
                : null,
            trailTailPointCount: countPackedPoints(operation && operation.trailTailPoints),
            resultDetails: details
        };
    }

    function countPackedPoints(points) {
        return Array.isArray(points) ? points.length : 0;
    }

    function hasFallbackTrailPoints(operation) {
        return unpackPoints(operation && operation.trailPoints).length >= 2;
    }

    function canUseCachedTrailSegment(segment, operation) {
        return Array.isArray(segment)
            && segment.length >= Math.max(2, operation.trailSegmentLength - 1);
    }

    function unpackCaptureContact(contact) {
        if (!Array.isArray(contact) || contact.length < 2) {
            return null;
        }

        const point = unpackPoint(contact);

        if (!point) {
            return null;
        }

        return {
            point,
            segmentIndex: Number.isInteger(contact[2]) ? contact[2] : null,
            segmentT: Number.isFinite(contact[3]) ? contact[3] : null
        };
    }

    function unpackTerritoryPolygon(polygon) {
        if (!isReferencedPolygon(polygon)) {
            return unpackPolygon(polygon);
        }

        updateTerritoryPointCache(polygon.points);

        let hasMissingPoint = false;
        const rings = (polygon.rings || [])
            .map(ring => (ring || []).map(pointId => {
                const point = entityCache.territoryPoints[pointId];

                if (!point) {
                    hasMissingPoint = true;
                    return null;
                }

                return point;
            }).filter(Boolean))
            .filter(ring => ring.length >= 3);

        return hasMissingPoint ? null : { rings };
    }

    function isReferencedPolygon(polygon) {
        return polygon
            && !Array.isArray(polygon)
            && Array.isArray(polygon.rings);
    }

    function updateTerritoryPointCache(points) {
        for (const point of points || []) {
            if (!Array.isArray(point) || point.length < 3) {
                continue;
            }

            const pointId = point[0];
            const x = point[1];
            const y = point[2];

            if (!Number.isInteger(pointId) || !Number.isFinite(x) || !Number.isFinite(y)) {
                continue;
            }

            entityCache.territoryPoints[pointId] = {
                x,
                y
            };
        }
    }

    function updateTrailCache(trails, applyResult, snapshotSequence) {
        for (const [id, update] of Object.entries(trails || {})) {
            const cachedTrail = entityCache.trails[id];
            const assembly = entityCache.trailAssemblies[id];
            const newestTrail = getNewestTrailState(cachedTrail, assembly);

            if (isTrailUpdateStale(update, snapshotSequence, newestTrail)) {
                continue;
            }

            if (update.full) {
                const fullTrail = createFullTrail(id, update, snapshotSequence);
                const shouldStage = Boolean(
                    update.partial
                    && cachedTrail
                    && !cachedTrail.isPartial
                    && isSameTrailGeneration(cachedTrail, fullTrail)
                );

                if (shouldStage) {
                    entityCache.trailAssemblies[id] = fullTrail;
                    continue;
                }

                entityCache.trails[id] = fullTrail;
                delete entityCache.trailAssemblies[id];
                continue;
            }

            const trail = assembly || cachedTrail;
            const patchedTrail = trail && createPatchedTrail(trail, update, snapshotSequence);

            if (!patchedTrail) {
                delete entityCache.trailAssemblies[id];
                markCacheInvalid(applyResult, "trails", id);
                continue;
            }

            if (assembly && update.partial) {
                entityCache.trailAssemblies[id] = patchedTrail;
                continue;
            }

            entityCache.trails[id] = patchedTrail;
            delete entityCache.trailAssemblies[id];
        }
    }

    function getNewestTrailState(cachedTrail, assembly) {
        if (!cachedTrail) {
            return assembly || null;
        }

        if (!assembly) {
            return cachedTrail;
        }

        if ((assembly.generation || 0) !== (cachedTrail.generation || 0)) {
            return (assembly.generation || 0) > (cachedTrail.generation || 0)
                ? assembly
                : cachedTrail;
        }

        return (assembly.snapshotSequence || 0) > (cachedTrail.snapshotSequence || 0)
            ? assembly
            : cachedTrail;
    }

    function isTrailUpdateStale(update, snapshotSequence, trail) {
        if (!trail) {
            return false;
        }

        const updateGeneration = Number.isSafeInteger(update.generation)
            ? update.generation
            : null;
        const trailGeneration = Number.isSafeInteger(trail.generation)
            ? trail.generation
            : null;

        if (
            updateGeneration !== null
            && trailGeneration !== null
            && updateGeneration !== trailGeneration
        ) {
            return updateGeneration < trailGeneration;
        }

        return Number.isSafeInteger(snapshotSequence)
            && Number.isSafeInteger(trail.snapshotSequence)
            && snapshotSequence <= trail.snapshotSequence;
    }

    function isSameTrailGeneration(first, second) {
        return Number.isSafeInteger(first && first.generation)
            && Number.isSafeInteger(second && second.generation)
            && first.generation === second.generation;
    }

    function expandPlayers(players, debug) {
        const expandedPlayers = {};

        for (const [id, player] of Object.entries(players || {})) {
            const info = entityCache.playerInfo[id] || {};

            expandedPlayers[id] = {
                id,
                x: player[0],
                y: player[1],
                angle: player[2],
                color: info.color || "#f5f7fb",
                name: info.name || "Jogador",
                eliminations: Number.isFinite(info.eliminations) ? info.eliminations : 0,
                lives: Number.isFinite(info.lives) ? info.lives : 0,
                maxLives: Number.isFinite(info.maxLives) ? info.maxLives : 0,
                catchBalance: Number.isFinite(info.catchBalance) ? info.catchBalance : 0,
                territoryX: Number.isFinite(info.territoryX) ? info.territoryX : player[0],
                territoryY: Number.isFinite(info.territoryY) ? info.territoryY : player[1]
            };

            if (debug && debug[id]) {
                expandedPlayers[id].debug = debug[id];
            }
        }

        return expandedPlayers;
    }

    function selectCachedEntities(cache, ids) {
        const selected = {};

        for (const id of ids || []) {
            if (cache[id]) {
                selected[id] = cache[id];
            }
        }

        return selected;
    }

    function getPreviousSnapshotEntities(key) {
        if (snapshots.length === 0) {
            return {};
        }

        return snapshots[snapshots.length - 1][key] || {};
    }

    function requestRecoveryForMissingCachedEntities(ids, selectedEntities, type, applyResult, ignoredIds = new Set()) {
        for (const id of ids || []) {
            if (ignoredIds.has(id)) {
                continue;
            }

            if (!selectedEntities[id]) {
                markCacheInvalid(applyResult, type, id);
            }
        }
    }

    function requestRecoveryForStaleCachedVersions(versions, selectedEntities, applyResult, ignoredIds = new Set()) {
        for (const [id, version] of Object.entries(versions || {})) {
            if (ignoredIds.has(id)) {
                continue;
            }

            const entity = selectedEntities[id];

            if (!entity || entity.version !== version) {
                markCacheInvalid(applyResult, "territories", id);
            }
        }
    }

    function createFullTrail(id, update, snapshotSequence) {
        const trail = {
            id,
            color: update.color,
            generation: update.generation,
            snapshotSequence,
            isPartial: Boolean(update.partial),
            leftSegments: unpackSegments(update.leftSegments),
            rightSegments: unpackSegments(update.rightSegments),
            leftFillPath: unpackPoints(update.leftFillPath),
            rightFillPath: unpackPoints(update.rightFillPath),
            fillPolygon: null
        };

        trail.fillPolygon = createTrailFillPolygon(trail.leftFillPath, trail.rightFillPath);

        return trail;
    }

    function createPatchedTrail(trail, update, snapshotSequence) {
        const leftSegments = applySegmentPatches(trail.leftSegments, update.leftPatches);
        const rightSegments = applySegmentPatches(trail.rightSegments, update.rightPatches);
        const leftFillPath = appendPathPoints(trail.leftFillPath, update.leftFillPoints, update.leftFillStart);
        const rightFillPath = appendPathPoints(trail.rightFillPath, update.rightFillPoints, update.rightFillStart);

        if (!leftSegments || !rightSegments || !leftFillPath || !rightFillPath) {
            return null;
        }

        const fillChanged = leftFillPath !== trail.leftFillPath
            || rightFillPath !== trail.rightFillPath;
        const color = update.color || trail.color;

        if (
            leftSegments === trail.leftSegments
            && rightSegments === trail.rightSegments
            && !fillChanged
            && color === trail.color
        ) {
            return {
                ...trail,
                generation: Number.isSafeInteger(update.generation)
                    ? update.generation
                    : trail.generation,
                snapshotSequence,
                isPartial: Boolean(update.partial)
            };
        }

        return {
            id: trail.id,
            color,
            generation: Number.isSafeInteger(update.generation)
                ? update.generation
                : trail.generation,
            snapshotSequence,
            isPartial: Boolean(update.partial),
            leftSegments,
            rightSegments,
            leftFillPath,
            rightFillPath,
            fillPolygon: fillChanged
                ? createTrailFillPolygon(leftFillPath, rightFillPath)
                : trail.fillPolygon
        };
    }

    function applySegmentPatches(segments, patches) {
        if (!Array.isArray(patches) || patches.length === 0) {
            return segments || [];
        }

        const sourceSegments = segments || [];
        const nextSegments = sourceSegments.slice();

        for (const patch of patches || []) {
            if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index > nextSegments.length) {
                return null;
            }

            if (patch.index === nextSegments.length) {
                nextSegments.push(unpackPoints(patch.points));
                continue;
            }

            const sourceSegment = sourceSegments[patch.index] || [];

            if (sourceSegment.length !== patch.start) {
                return null;
            }

            nextSegments[patch.index] = sourceSegment.concat(unpackPoints(patch.points));
        }

        return nextSegments;
    }

    function appendPathPoints(points, packedPoints, startIndex) {
        if (!Array.isArray(packedPoints) || packedPoints.length === 0) {
            return points || [];
        }

        const sourcePoints = points || [];

        if (sourcePoints.length !== startIndex) {
            return null;
        }

        return sourcePoints.concat(unpackPoints(packedPoints));
    }

    function requestResync(details = {}) {
        const now = performance.now();
        const interval = networkConfig.resyncRequestIntervalMs || 1000;

        if (typeof options.onResyncNeeded !== "function") {
            recordResyncSuppressed("missing_handler", details, now, interval);
            return;
        }

        if (now - lastResyncRequestedAt < interval) {
            recordResyncSuppressed("rate_limited", details, now, interval);
            return;
        }

        lastResyncRequestedAt = now;
        recordNetworkDiagnosticsEvent({
            type: "resyncRequested",
            reason: details.reason || null,
            details: details.details || null,
            invalidations: details.invalidations || null,
            bufferMs: networkState.bufferMs,
            snapshotInterArrivalMs: networkState.lastSnapshotDeltaMs,
            averageSnapshotDeltaMs: networkState.averageSnapshotDeltaMs,
            jitterMs: networkState.jitterMs
        });
        options.onResyncNeeded();
    }

    function recordResyncSuppressed(reason, details, now, interval) {
        recordNetworkDiagnosticsEvent({
            type: "resyncSuppressed",
            reason,
            sourceReason: details && details.reason || null,
            details: details && details.details || null,
            invalidations: details && details.invalidations || null,
            intervalMs: interval,
            nextAllowedInMs: Number.isFinite(lastResyncRequestedAt)
                ? Math.max(0, interval - (now - lastResyncRequestedAt))
                : 0,
            bufferMs: networkState.bufferMs,
            snapshotInterArrivalMs: networkState.lastSnapshotDeltaMs,
            averageSnapshotDeltaMs: networkState.averageSnapshotDeltaMs,
            jitterMs: networkState.jitterMs
        });
    }

    function createIgnoredTerritoryResyncIds(failedTerritoryOperationIds) {
        return new Set([
            ...suppressedCaptureOperationResyncIds,
            ...pendingTerritoryOperations.keys(),
            ...failedTerritoryOperationIds
        ]);
    }

    function handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure) {
        recordResyncSuppressed("duplicate_capture_operation_failure", {
            reason: duplicateFailure && duplicateFailure.reason || null,
            details: createCaptureOperationDiagnosticsDetails(id, duplicateFailure, operation),
            invalidations: {
                territories: 1,
                playerInfo: 0,
                trails: 0
            }
        }, performance.now(), networkConfig.resyncRequestIntervalMs || 1000);
    }

    function handleCaptureOperationFailure(id, operationResult, operation) {
        const details = createCaptureOperationDiagnosticsDetails(id, operationResult, operation);

        if (networkConfig.captureOperationResyncEnabled === false) {
            suppressedCaptureOperationResyncIds.add(id);
            recordResyncSuppressed("capture_operation_resync_disabled", {
                reason: operationResult && operationResult.reason || null,
                details,
                invalidations: {
                    territories: 1,
                    playerInfo: 0,
                    trails: 0
                }
            }, performance.now(), networkConfig.resyncRequestIntervalMs || 1000);
            return;
        }

        requestResync({
            reason: operationResult && operationResult.reason || null,
            details,
            invalidations: {
                territories: 1,
                playerInfo: 0,
                trails: 0
            }
        });
    }
}

function unpackPolygon(polygon) {
    return {
        rings: (polygon || [])
            .map(unpackPoints)
            .filter(ring => ring.length >= 3)
    };
}

function unpackSegments(segments) {
    return (segments || [])
        .map(unpackPoints)
        .filter(segment => segment.length >= 2);
}

function unpackPoints(points) {
    return (points || [])
        .map(unpackPoint)
        .filter(Boolean);
}

function unpackPoint(point) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        return null;
    }

    return {
        x: point[0],
        y: point[1]
    };
}

function isValidPoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}

function getFiniteConfigNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function createTrailFillPolygon(leftPath, rightPath) {
    const ring = leftPath.concat([...rightPath].reverse());

    if (ring.length < 3) {
        return null;
    }

    const closedRing = closeRing(ring);

    return closedRing.length >= 4 ? {
        rings: [closedRing]
    } : null;
}

function closeRing(ring) {
    const points = ring.filter(point => (
        point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y)
    ));

    if (points.length === 0) {
        return [];
    }

    const first = points[0];
    const last = points[points.length - 1];

    if (Math.abs(first.x - last.x) <= Number.EPSILON
        && Math.abs(first.y - last.y) <= Number.EPSILON) {
        return points;
    }

    return points.concat({
        x: first.x,
        y: first.y
    });
}

function createClippedTrailPoints(sidePoints, expectedLength, startPoint, endPoint) {
    const expectedPointCount = Number.isInteger(expectedLength) && expectedLength > 1
        ? expectedLength
        : sidePoints.length;
    const usablePoints = sidePoints.slice(0, expectedPointCount);
    const middlePoints = usablePoints.length >= expectedPointCount
        ? usablePoints.slice(1, -1)
        : usablePoints.slice(1);

    return removeConsecutiveDuplicatePoints([
        startPoint,
        ...middlePoints,
        endPoint
    ]);
}

function createBoundaryPaths(ring, startContact, endContact) {
    const openRing = getOpenRing(ring);

    if (!startContact || !endContact || openRing.length < 3) {
        return [];
    }

    const forwardPath = createForwardBoundaryPath(openRing, startContact, endContact);
    const reversePath = createForwardBoundaryPath(openRing, endContact, startContact).reverse();

    return [
        removeConsecutiveDuplicatePoints(forwardPath),
        removeConsecutiveDuplicatePoints(reversePath)
    ].filter(path => path.length >= 2);
}

function createForwardBoundaryPath(openRing, startContact, endContact) {
    if (startContact.segmentIndex === endContact.segmentIndex
        && endContact.segmentT >= startContact.segmentT) {
        return [startContact.point, endContact.point];
    }

    const path = [startContact.point];
    let vertexIndex = (startContact.segmentIndex + 1) % openRing.length;
    let guard = 0;

    while (guard <= openRing.length) {
        path.push(openRing[vertexIndex]);

        if (vertexIndex === endContact.segmentIndex) {
            break;
        }

        vertexIndex = (vertexIndex + 1) % openRing.length;
        guard++;
    }

    path.push(endContact.point);

    return path;
}

function selectBoundaryPathByAnchor(paths, anchor) {
    let selectedPath = null;
    let selectedDistance = Infinity;

    for (const path of paths || []) {
        const distance = getPointPathDistanceSquared(anchor, path);

        if (distance < selectedDistance) {
            selectedDistance = distance;
            selectedPath = path;
        }
    }

    return selectedPath && Number.isFinite(selectedDistance) ? selectedPath : null;
}

function getPointPathDistanceSquared(point, path) {
    let distance = Infinity;

    for (let index = 0; index < path.length - 1; index++) {
        distance = Math.min(distance, getPointSegmentDistanceSquared(point, path[index], path[index + 1]));
    }

    return distance;
}

function findClosestPolygonBoundaryContact(ring, point) {
    const openRing = getOpenRing(ring);
    let closestContact = null;

    for (let segmentIndex = 0; segmentIndex < openRing.length; segmentIndex++) {
        const projection = projectPointOnSegment(
            point,
            openRing[segmentIndex],
            openRing[(segmentIndex + 1) % openRing.length]
        );

        if (!closestContact || projection.distanceSquared < closestContact.distanceSquared) {
            closestContact = {
                point: projection.point,
                segmentIndex,
                segmentT: projection.segmentT,
                distanceSquared: projection.distanceSquared
            };
        }
    }

    return closestContact;
}

function projectPointOnSegment(point, segmentStart, segmentEnd) {
    const direction = subtractPoints(segmentEnd, segmentStart);
    const lengthSquared = direction.x * direction.x + direction.y * direction.y;
    const segmentT = lengthSquared <= geometryEpsilon
        ? 0
        : clamp((dotProduct(subtractPoints(point, segmentStart), direction) / lengthSquared), 0, 1);
    const projectedPoint = {
        x: segmentStart.x + direction.x * segmentT,
        y: segmentStart.y + direction.y * segmentT
    };

    return {
        point: projectedPoint,
        segmentT,
        distanceSquared: getDistanceSquared(point, projectedPoint)
    };
}

function getPointSegmentDistanceSquared(point, segmentStart, segmentEnd) {
    return projectPointOnSegment(point, segmentStart, segmentEnd).distanceSquared;
}

function normalizePolygonRing(points) {
    const ring = points
        .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(point => ({
            x: roundCoordinate(point.x),
            y: roundCoordinate(point.y)
        }));

    removeClosingDuplicatePoint(ring);
    const dedupedRing = removeConsecutiveDuplicatePoints(ring);

    removeCollinearPoints(dedupedRing);

    return closeRing(dedupedRing);
}

function getOpenRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
        return ring.slice(0, -1);
    }

    return ring.slice();
}

function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
}

function removeClosingDuplicatePoint(ring) {
    if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
        ring.pop();
    }
}

function removeCollinearPoints(ring) {
    let index = 0;

    while (ring.length >= 3 && index < ring.length) {
        const previous = ring[(index - 1 + ring.length) % ring.length];
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];

        if (isCollinear(previous, current, next)) {
            ring.splice(index, 1);
            index = Math.max(0, index - 1);
            continue;
        }

        index++;
    }
}

function isCollinear(first, second, third) {
    return Math.abs(crossCoordinates(first, second, third)) <= geometryEpsilon;
}

function crossCoordinates(first, second, third) {
    return (second.x - first.x) * (third.y - first.y)
        - (second.y - first.y) * (third.x - first.x);
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

function subtractPoints(first, second) {
    return {
        x: first.x - second.x,
        y: first.y - second.y
    };
}

function dotProduct(first, second) {
    return first.x * second.x + first.y * second.y;
}

function getDistanceSquared(first, second) {
    const x = first.x - second.x;
    const y = first.y - second.y;

    return x * x + y * y;
}

function calculateRingArea(ring) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 3) {
        return 0;
    }

    let area = 0;

    for (let index = 0; index < openRing.length; index++) {
        const current = openRing[index];
        const next = openRing[(index + 1) % openRing.length];

        area += current.x * next.y - next.x * current.y;
    }

    return area / 2;
}

function hasSelfIntersections(ring) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 4) {
        return false;
    }

    for (let firstIndex = 0; firstIndex < openRing.length; firstIndex++) {
        const firstStart = openRing[firstIndex];
        const firstEnd = openRing[(firstIndex + 1) % openRing.length];

        for (let secondIndex = firstIndex + 1; secondIndex < openRing.length; secondIndex++) {
            if (areAdjacentSegments(firstIndex, secondIndex, openRing.length)) {
                continue;
            }

            const secondStart = openRing[secondIndex];
            const secondEnd = openRing[(secondIndex + 1) % openRing.length];

            if (!doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd)) {
                continue;
            }

            if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
                return true;
            }
        }
    }

    return false;
}

function areAdjacentSegments(firstIndex, secondIndex, segmentCount) {
    return Math.abs(firstIndex - secondIndex) <= 1
        || (firstIndex === 0 && secondIndex === segmentCount - 1);
}

function doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.min(firstStart.x, firstEnd.x) <= Math.max(secondStart.x, secondEnd.x) + geometryEpsilon
        && Math.max(firstStart.x, firstEnd.x) + geometryEpsilon >= Math.min(secondStart.x, secondEnd.x)
        && Math.min(firstStart.y, firstEnd.y) <= Math.max(secondStart.y, secondEnd.y) + geometryEpsilon
        && Math.max(firstStart.y, firstEnd.y) + geometryEpsilon >= Math.min(secondStart.y, secondEnd.y);
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
    const firstToSecondStart = crossCoordinates(firstStart, firstEnd, secondStart);
    const firstToSecondEnd = crossCoordinates(firstStart, firstEnd, secondEnd);
    const secondToFirstStart = crossCoordinates(secondStart, secondEnd, firstStart);
    const secondToFirstEnd = crossCoordinates(secondStart, secondEnd, firstEnd);

    if (Math.abs(firstToSecondStart) <= geometryEpsilon && isPointOnSegment(secondStart, firstStart, firstEnd)) {
        return true;
    }

    if (Math.abs(firstToSecondEnd) <= geometryEpsilon && isPointOnSegment(secondEnd, firstStart, firstEnd)) {
        return true;
    }

    if (Math.abs(secondToFirstStart) <= geometryEpsilon && isPointOnSegment(firstStart, secondStart, secondEnd)) {
        return true;
    }

    if (Math.abs(secondToFirstEnd) <= geometryEpsilon && isPointOnSegment(firstEnd, secondStart, secondEnd)) {
        return true;
    }

    return (firstToSecondStart > 0) !== (firstToSecondEnd > 0)
        && (secondToFirstStart > 0) !== (secondToFirstEnd > 0);
}

function isPointOnSegment(point, segmentStart, segmentEnd) {
    return point.x >= Math.min(segmentStart.x, segmentEnd.x) - geometryEpsilon
        && point.x <= Math.max(segmentStart.x, segmentEnd.x) + geometryEpsilon
        && point.y >= Math.min(segmentStart.y, segmentEnd.y) - geometryEpsilon
        && point.y <= Math.max(segmentStart.y, segmentEnd.y) + geometryEpsilon;
}

function isPointInsideOrOnRing(point, ring) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return false;
    }

    const openRing = getOpenRing(ring);

    if (openRing.length < 3) {
        return false;
    }

    for (let index = 0; index < openRing.length; index++) {
        if (getPointSegmentDistanceSquared(
            point,
            openRing[index],
            openRing[(index + 1) % openRing.length]
        ) <= indexedBoundaryMaxDistanceSquared) {
            return true;
        }
    }

    let inside = false;

    for (let index = 0, previousIndex = openRing.length - 1;
        index < openRing.length;
        previousIndex = index++) {
        const current = openRing[index];
        const previous = openRing[previousIndex];
        const crossesY = (current.y > point.y) !== (previous.y > point.y);

        if (!crossesY) {
            continue;
        }

        const intersectionX = (previous.x - current.x) * (point.y - current.y)
            / (previous.y - current.y)
            + current.x;

        if (point.x < intersectionX) {
            inside = !inside;
        }
    }

    return inside;
}

function roundCoordinate(value) {
    return Math.round(value * coordinatePrecision) / coordinatePrecision;
}

function calculateAverage(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateStandardDeviation(values, average) {
    const variance = values
        .map(value => (value - average) ** 2)
        .reduce((sum, value) => sum + value, 0) / values.length;

    return Math.sqrt(variance);
}

function getAdaptiveBufferSamples(values, config) {
    if (!Array.isArray(values) || values.length === 0) {
        return [0];
    }

    const minSamplesForTrim = getPositiveIntegerConfigValue(
        config,
        "adaptiveBufferMinSamplesForTrim",
        10
    );

    if (values.length < minSamplesForTrim) {
        return values;
    }

    const trimRatio = clamp(
        getFiniteConfigNumberFromNetworkConfig(config, "adaptiveBufferTrimRatio", 0.1),
        0,
        0.4
    );
    const trimCount = Math.floor(values.length * trimRatio);

    if (trimCount <= 0) {
        return values;
    }

    return values
        .slice()
        .sort((first, second) => first - second)
        .slice(0, Math.max(1, values.length - trimCount));
}

function calculatePercentile(values, percentile) {
    if (!Array.isArray(values) || values.length === 0) {
        return 0;
    }

    const sortedValues = values
        .slice()
        .sort((first, second) => first - second);
    const safePercentile = clamp(percentile, 0, 1);
    const index = Math.min(
        sortedValues.length - 1,
        Math.ceil(sortedValues.length * safePercentile) - 1
    );

    return sortedValues[Math.max(0, index)];
}

function getAdaptiveBufferPercentile(config) {
    return clamp(
        getFiniteConfigNumberFromNetworkConfig(config, "adaptiveBufferPercentile", 0.9),
        0.5,
        1
    );
}

function getPositiveIntegerConfigValue(config, key, fallback) {
    const value = Number(networkConfigValue(config, key));

    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getFiniteConfigNumberFromNetworkConfig(config, key, fallback) {
    return getFiniteConfigNumberFromValue(networkConfigValue(config, key), fallback);
}

function getFiniteConfigNumberFromValue(value, fallback) {
    const number = Number(value);

    return Number.isFinite(number) ? number : fallback;
}

function networkConfigValue(config, key) {
    return config
        && Object.prototype.hasOwnProperty.call(config, key)
        ? config[key]
        : null;
}
