/**
 * Network diagnostics collected by the snapshot interpolator.
 *
 * The service owns its bounded event history and server payload normalizers.
 * Runtime interpolation state is observed through getDebugState, never mutated.
 */

export function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

export function createSnapshotDiagnostics(networkConfig, getDebugState) {
    if (typeof getDebugState !== "function") {
        throw new TypeError("snapshot diagnostics requires a debug-state reader");
    }

    const networkDiagnosticsState = {
        events: [],
        lastServer: null,
        lastSnapshot: null,
        lastResync: null,
        lastResyncSuppressed: null
    };

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
        const debug = getDebugState();
        const event = {
            type: "snapshot",
            at: Date.now(),
            perfAt: receivedAt,
            bufferMs: debug.bufferMs,
            snapshotInterArrivalMs: debug.snapshotInterArrivalMs,
            averageSnapshotDeltaMs: debug.averageSnapshotDeltaMs,
            jitterMs: debug.jitterMs,
            serverOffsetMs: debug.serverOffsetMs,
            snapshotCount: debug.snapshotCount,
            visiblePlayers: debug.visiblePlayers,
            visibleTerritories: debug.visibleTerritories,
            visibleTrails: debug.visibleTrails,
            preserveTrails: Boolean(snapshot && snapshot.preserveTrails),
            applied: !applyResult || applyResult.applied !== false,
            invalidations,
            server: serverDiagnostics
        };

        if (serverDiagnostics && Number.isFinite(serverDiagnostics.serverSentAt)) {
            event.estimatedTransitMs = event.at - (serverDiagnostics.serverSentAt + debug.serverOffsetMs);
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
        const overflow = networkDiagnosticsState.events.length - limit;

        if (overflow > 0) {
            networkDiagnosticsState.events.splice(0, overflow);
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
            maxCaptureApplyChangedTerritories: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).changedTerritoryCount)),
            maxCaptureApplyPostOverlapChecks: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).postCaptureOverlapCheckCount)),
            maxCaptureApplyPostOverlaps: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).postCaptureOverlapCount)),
            maxCaptureApplyPostOverlapRepairChanged: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).postCaptureOverlapRepairChangedCount)),
            maxCaptureApplyPostOverlapRepairs: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).postCaptureOverlapRepairCount)),
            maxOverlapRepairWorkerBackpressure: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerBackpressureCount)),
            maxOverlapRepairWorkerComputeMs: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerComputeMs)),
            maxOverlapRepairWorkerInFlight: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerInFlightCount)),
            maxOverlapRepairWorkerLatencyMs: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerLatencyMs)),
            maxCaptureApplyCapturedPoints: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).maxCapturedPointCount)),
            maxCaptureApplySubtractPoints: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).subtractPointCount)),
            maxCaptureApplyOperationSubtractPoints: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).subtractOperationPointCount)),
            maxCaptureApplySlowestOverlapMs: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).slowestOverlap && getEventCaptureApply(event).slowestOverlap.durationMs)),
            maxCaptureApplySlowestSubtractMs: maxFiniteValue(snapshotEvents.map(event => getEventCaptureApply(event) && getEventCaptureApply(event).slowestSubtract && getEventCaptureApply(event).slowestSubtract.durationMs)),
            maxTrailCaptureDamagePlayersMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.captureDamagePlayers)),
            maxTrailCaptureRelocatePlayersMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && event.server.gameLoop.trails.phases.captureRelocatePlayers)),
            maxTrailOwnerBlockChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailBlockChecks)),
            maxTrailOwnerBlockBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailBlockBoundsRejected)),
            maxTrailOwnerBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailBoundsRejected)),
            maxTrailOwnerPrimitiveCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailPrimitiveCandidates)),
            maxTrailOwnerPrimitiveTests: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailPrimitiveTests)),
            maxTrailOwnerSegmentChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailSegmentChecks)),
            maxTrailOwnerCacheHits: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.trailOwnerCacheHits)),
            maxTrailOwnerCacheMisses: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.trailOwnerCacheMisses)),
            maxTrailOwnerCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.trailOwnerCandidates)),
            maxTrailOwnerMovementBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.trailOwnerMovementBoundsRejected)),
            maxTrailOwnerSideBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.trailOwnerSideBoundsRejected)),
            maxTrailSelfBlockChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailBlockChecks)),
            maxTrailSelfBlockBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailBlockBoundsRejected)),
            maxTrailSelfBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailBoundsRejected)),
            maxTrailSelfMovementBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailMovementBoundsRejected)),
            maxTrailSelfPrimitiveCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailPrimitiveCandidates)),
            maxTrailSelfPrimitiveTests: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailPrimitiveTests)),
            maxTrailSelfRecentSegmentSkipped: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailRecentSegmentSkipped)),
            maxTrailSelfSegmentBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSegmentBoundsRejected)),
            maxTrailSelfSegmentCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSegmentCandidates)),
            maxTrailSelfSideBoundsRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSideBoundsRejected)),
            maxTrailSelfSideCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSideCandidates)),
            maxTrailSelfSegmentChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSegmentChecks)),
            maxTrailCaptures: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.captures)),
            maxGameLoopBotsMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.phases && event.server.gameLoop.phases.bots)),
            maxBotDecisionMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.phases && event.server.gameLoop.bot.phases.decisions)),
            maxBotSelfTrailSafetyMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.phases && event.server.gameLoop.bot.phases.selfTrailSafety)),
            maxBotSelfTrailBudgetHits: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.budgetHitCount)),
            maxBotSelfTrailBudgetElapsedMs: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.maxBudgetElapsedMs)),
            maxBotSelfTrailCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.candidateCount)),
            maxBotSelfTrailCoarseEvaluations: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.coarseEvaluationCount)),
            maxBotSelfTrailEarlyExits: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.earlyExitCount)),
            maxBotSelfTrailEvaluatedCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.evaluatedCandidateCount)),
            maxBotSelfTrailFullEvaluations: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.fullEvaluationCount)),
            maxBotSelfTrailRefinedCandidates: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.selectedRefineCandidateCount)),
            maxBotSelfTrailFilteredPoints: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.filteredTrailPointCount)),
            maxBotSelfTrailFilteredSegments: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.filteredTrailSegmentCount)),
            maxBotSelfTrailPointBlockChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.pointBlockChecks)),
            maxBotSelfTrailPointBlockRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.pointBlockBoundsRejected)),
            maxBotSelfTrailPointChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.pointDistanceCheckCount)),
            maxBotSelfTrailSegmentBlockChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.segmentBlockChecks)),
            maxBotSelfTrailSegmentBlockRejected: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.segmentBlockBoundsRejected)),
            maxBotSelfTrailSegmentChecks: maxFiniteValue(snapshotEvents.map(event => event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.segmentCrossCheckCount)),
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
            ownerTrailBlockBoundsRejected: finiteOrNull(value.ownerTrailBlockBoundsRejected),
            ownerTrailBlockChecks: finiteOrNull(value.ownerTrailBlockChecks),
            ownerTrailBoundsRejected: finiteOrNull(value.ownerTrailBoundsRejected),
            ownerTrailPrimitiveCandidates: finiteOrNull(value.ownerTrailPrimitiveCandidates),
            ownerTrailPrimitiveTests: finiteOrNull(value.ownerTrailPrimitiveTests),
            ownerTrailSegmentChecks: finiteOrNull(value.ownerTrailSegmentChecks),
            pathPrimitiveBlockCount: finiteOrNull(value.pathPrimitiveBlockCount),
            pathPrimitiveCacheHits: finiteOrNull(value.pathPrimitiveCacheHits),
            pathPrimitiveIncrementalUpdates: finiteOrNull(value.pathPrimitiveIncrementalUpdates),
            pathPrimitiveCacheMisses: finiteOrNull(value.pathPrimitiveCacheMisses),
            pathPrimitiveCount: finiteOrNull(value.pathPrimitiveCount),
            pathPrimitiveInputPointCount: finiteOrNull(value.pathPrimitiveInputPointCount),
            pathPrimitiveRebuiltPointCount: finiteOrNull(value.pathPrimitiveRebuiltPointCount),
            pathPrimitiveReusedBlockCount: finiteOrNull(value.pathPrimitiveReusedBlockCount),
            phases: normalizeGameLoopPhases(value.phases),
            playersProcessed: finiteOrNull(value.playersProcessed),
            selfCollisionTests: finiteOrNull(value.selfCollisionTests),
            selfCollisions: finiteOrNull(value.selfCollisions),
            selfPathPrimitiveBlockCount: finiteOrNull(value.selfPathPrimitiveBlockCount),
            selfPathPrimitiveCacheHits: finiteOrNull(value.selfPathPrimitiveCacheHits),
            selfPathPrimitiveIncrementalUpdates: finiteOrNull(value.selfPathPrimitiveIncrementalUpdates),
            selfPathPrimitiveCacheMisses: finiteOrNull(value.selfPathPrimitiveCacheMisses),
            selfPathPrimitiveCount: finiteOrNull(value.selfPathPrimitiveCount),
            selfPathPrimitiveInputPointCount: finiteOrNull(value.selfPathPrimitiveInputPointCount),
            selfPathPrimitiveRebuiltPointCount: finiteOrNull(value.selfPathPrimitiveRebuiltPointCount),
            selfPathPrimitiveReusedBlockCount: finiteOrNull(value.selfPathPrimitiveReusedBlockCount),
            selfTrailBlockBoundsRejected: finiteOrNull(value.selfTrailBlockBoundsRejected),
            selfTrailBlockChecks: finiteOrNull(value.selfTrailBlockChecks),
            selfTrailBoundsRejected: finiteOrNull(value.selfTrailBoundsRejected),
            selfTrailMovementBoundsRejected: finiteOrNull(value.selfTrailMovementBoundsRejected),
            selfTrailPrimitiveCandidates: finiteOrNull(value.selfTrailPrimitiveCandidates),
            selfTrailPrimitiveTests: finiteOrNull(value.selfTrailPrimitiveTests),
            selfTrailRecentSegmentSkipped: finiteOrNull(value.selfTrailRecentSegmentSkipped),
            selfTrailSegmentBoundsRejected: finiteOrNull(value.selfTrailSegmentBoundsRejected),
            selfTrailSegmentCandidates: finiteOrNull(value.selfTrailSegmentCandidates),
            selfTrailSideBoundsRejected: finiteOrNull(value.selfTrailSideBoundsRejected),
            selfTrailSideCandidates: finiteOrNull(value.selfTrailSideCandidates),
            selfTrailSegmentChecks: finiteOrNull(value.selfTrailSegmentChecks),
            slowestPhase: normalizeGameLoopSlowestPhase(value.slowestPhase),
            trailOwnerCacheHits: finiteOrNull(value.trailOwnerCacheHits),
            trailOwnerCacheMisses: finiteOrNull(value.trailOwnerCacheMisses),
            trailOwnerCandidates: finiteOrNull(value.trailOwnerCandidates),
            trailOwnerChecks: finiteOrNull(value.trailOwnerChecks),
            trailOwnerHits: finiteOrNull(value.trailOwnerHits),
            trailOwnerInsideRejected: finiteOrNull(value.trailOwnerInsideRejected),
            trailOwnerMovementBoundsRejected: finiteOrNull(value.trailOwnerMovementBoundsRejected),
            trailOwnerNoTrailRejected: finiteOrNull(value.trailOwnerNoTrailRejected),
            trailOwnerSideBoundsRejected: finiteOrNull(value.trailOwnerSideBoundsRejected)
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
            overlapRepairQueueBudgetHitCount: finiteOrNull(value.overlapRepairQueueBudgetHitCount),
            overlapRepairQueueChangedCount: finiteOrNull(value.overlapRepairQueueChangedCount),
            overlapRepairQueuePendingCount: finiteOrNull(value.overlapRepairQueuePendingCount),
            overlapRepairQueueProcessedCount: finiteOrNull(value.overlapRepairQueueProcessedCount),
            overlapRepairQueueQueuedCount: finiteOrNull(value.overlapRepairQueueQueuedCount),
            overlapRepairWorkerBackpressureCount: finiteOrNull(value.overlapRepairWorkerBackpressureCount),
            overlapRepairWorkerChangedCount: finiteOrNull(value.overlapRepairWorkerChangedCount),
            overlapRepairWorkerCompletedCount: finiteOrNull(value.overlapRepairWorkerCompletedCount),
            overlapRepairWorkerComputeMs: finiteOrNull(value.overlapRepairWorkerComputeMs),
            overlapRepairWorkerDispatchedCount: finiteOrNull(value.overlapRepairWorkerDispatchedCount),
            overlapRepairWorkerFailedCount: finiteOrNull(value.overlapRepairWorkerFailedCount),
            overlapRepairWorkerInFlightCount: finiteOrNull(value.overlapRepairWorkerInFlightCount),
            overlapRepairWorkerIntersectionMs: finiteOrNull(value.overlapRepairWorkerIntersectionMs),
            overlapRepairWorkerLatencyMs: finiteOrNull(value.overlapRepairWorkerLatencyMs),
            overlapRepairWorkerNoChangeCount: finiteOrNull(value.overlapRepairWorkerNoChangeCount),
            overlapRepairWorkerStaleCount: finiteOrNull(value.overlapRepairWorkerStaleCount),
            overlapRepairWorkerSubtractMs: finiteOrNull(value.overlapRepairWorkerSubtractMs),
            ownerChangedCount: finiteOrNull(value.ownerChangedCount),
            postCaptureOverlapBoundsRejectedCount: finiteOrNull(value.postCaptureOverlapBoundsRejectedCount),
            postCaptureOverlapCheckCount: finiteOrNull(value.postCaptureOverlapCheckCount),
            postCaptureOverlapCount: finiteOrNull(value.postCaptureOverlapCount),
            postCaptureOverlapFirst: normalizePostCaptureOverlap(value.postCaptureOverlapFirst),
            postCaptureOverlapRepairChangedCount: finiteOrNull(value.postCaptureOverlapRepairChangedCount),
            postCaptureOverlapRepairCount: finiteOrNull(value.postCaptureOverlapRepairCount),
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

    function normalizePostCaptureOverlap(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            firstId: typeof value.firstId === "string" ? value.firstId : null,
            firstPointCount: finiteOrNull(value.firstPointCount),
            firstVersion: finiteOrNull(value.firstVersion),
            overlapArea: finiteOrNull(value.overlapArea),
            secondId: typeof value.secondId === "string" ? value.secondId : null,
            secondPointCount: finiteOrNull(value.secondPointCount),
            secondVersion: finiteOrNull(value.secondVersion)
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
            subjectPointCount: finiteOrNull(value.subjectPointCount)
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
            targeting: normalizeBotTargetingDiagnostics(value.targeting),
            slowestPhase: normalizeGameLoopSlowestPhase(value.slowestPhase)
        };
    }

    function normalizeBotTargetingDiagnostics(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        return {
            balanceCandidateCount: finiteOrNull(value.balanceCandidateCount),
            balanceEnemyEvaluations: finiteOrNull(value.balanceEnemyEvaluations),
            coordinatedNumberCacheHitCount: finiteOrNull(value.coordinatedNumberCacheHitCount),
            coordinatedNumberCacheMissCount: finiteOrNull(value.coordinatedNumberCacheMissCount),
            huntCandidateCount: finiteOrNull(value.huntCandidateCount),
            huntEnemyEvaluations: finiteOrNull(value.huntEnemyEvaluations),
            returnTargetCacheHitCount: finiteOrNull(value.returnTargetCacheHitCount),
            returnTargetCacheMissCount: finiteOrNull(value.returnTargetCacheMissCount),
            trailBlockBoundsRejected: finiteOrNull(value.trailBlockBoundsRejected),
            trailBlockChecks: finiteOrNull(value.trailBlockChecks),
            trailIndexCacheHitCount: finiteOrNull(value.trailIndexCacheHitCount),
            trailIndexCacheMissCount: finiteOrNull(value.trailIndexCacheMissCount),
            trailPointChecks: finiteOrNull(value.trailPointChecks),
            trailPointDistanceRejected: finiteOrNull(value.trailPointDistanceRejected),
            trailPointTerritoryRejected: finiteOrNull(value.trailPointTerritoryRejected)
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
            coarseEvaluationCount: finiteOrNull(value.coarseEvaluationCount),
            decisionCount: finiteOrNull(value.decisionCount),
            earlyExitCount: finiteOrNull(value.earlyExitCount),
            evaluatedCandidateCount: finiteOrNull(value.evaluatedCandidateCount),
            evaluatedLocalCandidateCount: finiteOrNull(value.evaluatedLocalCandidateCount),
            fullEvaluationCount: finiteOrNull(value.fullEvaluationCount),
            filteredTrailPointCount: finiteOrNull(value.filteredTrailPointCount),
            filteredTrailSegmentCount: finiteOrNull(value.filteredTrailSegmentCount),
            localCandidateCount: finiteOrNull(value.localCandidateCount),
            maxBudgetElapsedMs: finiteOrNull(value.maxBudgetElapsedMs),
            pathEvaluationCount: finiteOrNull(value.pathEvaluationCount),
            pointBlockBoundsRejected: finiteOrNull(value.pointBlockBoundsRejected),
            pointBlockChecks: finiteOrNull(value.pointBlockChecks),
            pointBlockCount: finiteOrNull(value.pointBlockCount),
            pointDistanceCheckCount: finiteOrNull(value.pointDistanceCheckCount),
            sampleCount: finiteOrNull(value.sampleCount),
            selectedRefineCandidateCount: finiteOrNull(value.selectedRefineCandidateCount),
            segmentBlockBoundsRejected: finiteOrNull(value.segmentBlockBoundsRejected),
            segmentBlockChecks: finiteOrNull(value.segmentBlockChecks),
            segmentBlockCount: finiteOrNull(value.segmentBlockCount),
            segmentBoundsRejected: finiteOrNull(value.segmentBoundsRejected),
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

    function resetNetworkDiagnostics() {
        networkDiagnosticsState.events.length = 0;
        networkDiagnosticsState.lastServer = null;
        networkDiagnosticsState.lastSnapshot = null;
        networkDiagnosticsState.lastResync = null;
        networkDiagnosticsState.lastResyncSuppressed = null;
    }

    return {
        getNetworkDiagnostics,
        recordNetworkDiagnosticsEvent,
        recordSnapshotNetworkDiagnostics,
        resetNetworkDiagnostics
    };
}

function getFiniteConfigNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}
