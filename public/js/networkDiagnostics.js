const DEFAULT_HISTORY_LIMIT = 240;
const DEFAULT_PING_INTERVAL_MS = 1000;
const DEFAULT_SLOW_BUFFER_MS = 150;
const DEFAULT_SLOW_SERVER_INTERVAL_MS = 80;
const DEFAULT_SLOW_LOOP_DRIFT_MS = 40;
const DEFAULT_SLOW_GAME_LOOP_MS = 12;
const DEFAULT_SLOW_SNAPSHOT_BUILD_MS = 16;
const DEFAULT_SLOW_PAYLOAD_MEASURE_MS = 8;
const DEFAULT_LARGE_PAYLOAD_BYTES = 10000;

export function createNetworkDiagnostics(socket, snapshots, networkConfig = {}) {
    const events = [];
    const pings = [];
    let timerId = null;
    let enabled = false;

    registerSocketEvents();

    const api = {
        clear,
        disable,
        enable,
        isRunning,
        ping,
        print,
        report,
        start,
        stop,
        table
    };

    exposeDiagnosticsApi(api);

    if (shouldAutoStart()) {
        start();
    }

    return api;

    function enable(options = {}) {
        enabled = true;
        return emitWithAck("networkDiagnostics", {
            captureOverlapAudit: options.captureOverlapAudit === true,
            enabled: true
        }).then(response => {
            recordEvent("diagnostics-enabled", response);
            return response;
        });
    }

    function disable() {
        enabled = false;
        stopTimer();
        return emitWithAck("networkDiagnostics", {
            enabled: false
        }).then(response => {
            recordEvent("diagnostics-disabled", response);
            return response;
        });
    }

    function start(options = {}) {
        const intervalMs = getPositiveNumber(
            options.intervalMs,
            getPositiveNumber(networkConfig.diagnosticsPingIntervalMs, DEFAULT_PING_INTERVAL_MS)
        );

        enabled = true;
        enable({
            captureOverlapAudit: options.captureOverlapAudit === true
        });
        stopTimer();
        timerId = setInterval(() => {
            ping().catch(() => null);

            if (options.log) {
                print();
            }
        }, intervalMs);

        ping().catch(() => null);

        return report();
    }

    function stop() {
        stopTimer();
        return report();
    }

    function ping() {
        const clientSentAt = Date.now();
        const perfSentAt = performance.now();

        return emitWithAck("networkDiagnosticsPing", {
            clientSentAt
        }).then(response => {
            const roundTripMs = performance.now() - perfSentAt;
            const serverTime = Number(response && response.serverTime);
            const sample = {
                at: Date.now(),
                clientSentAt,
                diagnosticsEnabled: Boolean(response && response.diagnosticsEnabled),
                roundTripMs,
                serverOffsetEstimateMs: Number.isFinite(serverTime)
                    ? serverTime - (clientSentAt + roundTripMs / 2)
                    : null,
                transport: response && response.transport || getTransportName()
            };

            pings.push(sample);
            trimHistory(pings);
            recordEvent("ping", sample);

            return sample;
        });
    }

    function report() {
        const snapshotDiagnostics = snapshots && typeof snapshots.getNetworkDiagnostics === "function"
            ? snapshots.getNetworkDiagnostics()
            : null;

        return {
            connected: Boolean(socket && socket.connected),
            enabled,
            running: isRunning(),
            transport: getTransportName(),
            ping: createPingSummary(),
            snapshots: snapshotDiagnostics,
            diagnosis: diagnoseNetwork(snapshotDiagnostics, createPingSummary()),
            clientEvents: events.slice(),
            pings: pings.slice()
        };
    }

    function print() {
        const data = report();
        const latestSnapshot = data.snapshots && data.snapshots.current
            ? data.snapshots.current.lastSnapshot
            : null;
        const server = latestSnapshot && latestSnapshot.server;
        const gameLoop = server && server.gameLoop;
        const gameLoopPhases = gameLoop && gameLoop.phases || {};
        const trailDiagnostics = gameLoop && gameLoop.trails;
        const trailPhases = trailDiagnostics && trailDiagnostics.phases || {};
        const captureApply = trailDiagnostics && trailDiagnostics.captureApply || {};
        const captureApplySlowestOverlap = captureApply.slowestOverlap || {};
        const captureApplySlowestSubtract = captureApply.slowestSubtract || {};
        const botDiagnostics = gameLoop && gameLoop.bot;
        const botPhases = botDiagnostics && botDiagnostics.phases || {};
        const botSelfTrail = botDiagnostics && botDiagnostics.selfTrailSafety || {};
        const botTargeting = botDiagnostics && botDiagnostics.targeting || {};
        const breakdown = latestSnapshot && latestSnapshot.server && latestSnapshot.server.snapshotBreakdown || {};
        const payloadBudget = breakdown.payloadBudget || {};
        const payloadBudgetDeferred = payloadBudget.deferred || {};
        const payloadOutlier = breakdown.payloadOutlier || null;
        const topPayloadSection = payloadOutlier && payloadOutlier.topSections && payloadOutlier.topSections[0] || {};
        const topPayloadTrail = payloadOutlier && payloadOutlier.topTrails && payloadOutlier.topTrails[0] || {};
        const resync = data.snapshots && data.snapshots.summary && data.snapshots.summary.resync || {};
        const serverResync = server && server.lastSnapshotResync || {};
        const serverCacheInvalidation = server && server.lastSnapshotCacheInvalidation || {};
        const lastResyncInvalidations = resync.lastInvalidations || {};
        const lastCacheInvalidations = serverCacheInvalidation.invalidations || {};
        const row = {
            diagnosis: data.diagnosis.reason,
            bufferMs: latestSnapshot && round(latestSnapshot.bufferMs),
            interArrivalMs: latestSnapshot && round(latestSnapshot.snapshotInterArrivalMs),
            jitterMs: latestSnapshot && round(latestSnapshot.jitterMs),
            rttMs: data.ping.last && round(data.ping.last.roundTripMs),
            sendType: latestSnapshot && latestSnapshot.server && latestSnapshot.server.sendType,
            serverIntervalMs: latestSnapshot && latestSnapshot.server && round(latestSnapshot.server.serverSendIntervalMs),
            loopDriftMs: latestSnapshot && latestSnapshot.server && round(latestSnapshot.server.loopDriftMs),
            gameLoopMs: gameLoop && round(gameLoop.tickDurationMs),
            gameLoopDriftMs: gameLoop && round(gameLoop.tickDriftMs),
            slowestPhase: gameLoop && gameLoop.slowestPhase && gameLoop.slowestPhase.name,
            trailsMs: round(gameLoopPhases.trails),
            trailSlowest: trailDiagnostics && trailDiagnostics.slowestPhase && trailDiagnostics.slowestPhase.name,
            trailSlowestMs: trailDiagnostics && trailDiagnostics.slowestPhase && round(trailDiagnostics.slowestPhase.durationMs),
            trailCaptureMs: round(trailPhases.capture),
            trailCaptureCreateMs: round(trailPhases.captureCreate),
            trailCaptureApplyMs: round(trailPhases.captureApplyTerritory),
            captureApplyCalls: captureApply.calls,
            captureApplyCandidates: captureApply.candidateCount,
            captureApplyBoundsRejected: captureApply.boundsRejectedCount,
            captureApplyBoundsOverlaps: captureApply.boundsOverlapCount,
            captureApplyOverlaps: captureApply.overlapCount,
            captureApplyOverlapRejected: captureApply.overlapRejectedCount,
            captureApplySubtractions: captureApply.subtractCount,
            captureApplyOperationSubtractPoints: captureApply.subtractOperationPointCount,
            captureApplyOperationClipPoints: captureApply.subtractOperationClippingPointCount,
            captureApplyChangedTerritories: captureApply.changedTerritoryCount,
            captureApplyPostOverlapChecks: captureApply.postCaptureOverlapCheckCount,
            captureApplyPostOverlaps: captureApply.postCaptureOverlapCount,
            captureApplyPostOverlapRepairChanged: captureApply.postCaptureOverlapRepairChangedCount,
            captureApplyPostOverlapRepairs: captureApply.postCaptureOverlapRepairCount,
            overlapRepairQueueProcessed: captureApply.overlapRepairQueueProcessedCount,
            overlapRepairQueueChanged: captureApply.overlapRepairQueueChangedCount,
            overlapRepairQueuePending: captureApply.overlapRepairQueuePendingCount,
            overlapRepairQueueBudgetHits: captureApply.overlapRepairQueueBudgetHitCount,
            overlapRepairWorkerDispatched: captureApply.overlapRepairWorkerDispatchedCount,
            overlapRepairWorkerCompleted: captureApply.overlapRepairWorkerCompletedCount,
            overlapRepairWorkerChanged: captureApply.overlapRepairWorkerChangedCount,
            overlapRepairWorkerNoChange: captureApply.overlapRepairWorkerNoChangeCount,
            overlapRepairWorkerStale: captureApply.overlapRepairWorkerStaleCount,
            overlapRepairWorkerFailed: captureApply.overlapRepairWorkerFailedCount,
            overlapRepairWorkerBackpressure: captureApply.overlapRepairWorkerBackpressureCount,
            overlapRepairWorkerInFlight: captureApply.overlapRepairWorkerInFlightCount,
            overlapRepairWorkerLatencyMs: round(captureApply.overlapRepairWorkerLatencyMs),
            overlapRepairWorkerComputeMs: round(captureApply.overlapRepairWorkerComputeMs),
            overlapRepairWorkerIntersectionMs: round(captureApply.overlapRepairWorkerIntersectionMs),
            overlapRepairWorkerSubtractMs: round(captureApply.overlapRepairWorkerSubtractMs),
            captureApplyCapturedPoints: captureApply.maxCapturedPointCount,
            captureApplySubtractPoints: captureApply.subtractPointCount,
            captureApplySlowestOverlapMs: round(captureApplySlowestOverlap.durationMs),
            captureApplySlowestOverlapPoints: captureApplySlowestOverlap.subjectPointCount,
            captureApplySlowestSubtractMs: round(captureApplySlowestSubtract.durationMs),
            captureApplySlowestSubtractPoints: captureApplySlowestSubtract.subjectPointCount,
            captureApplySlowestSubtractOperationPoints: captureApplySlowestSubtract.operationSubjectPointCount,
            captureApplySlowestSubtractClipPoints: captureApplySlowestSubtract.clippingPointCount,
            captureApplySlowestSubtractOperationClipPoints: captureApplySlowestSubtract.operationClippingPointCount,
            captureApplySlowestSubtractResultPoints: captureApplySlowestSubtract.resultPointCount,
            trailFillMs: round(trailPhases.fill),
            trailOwnerCrossingMs: round(trailPhases.ownerCrossing),
            trailSelfCollisionMs: round(trailPhases.selfCollision),
            trailOwnerBlockChecks: trailDiagnostics && trailDiagnostics.ownerTrailBlockChecks,
            trailOwnerBlockBoundsRejected: trailDiagnostics && trailDiagnostics.ownerTrailBlockBoundsRejected,
            trailOwnerBoundsRejected: trailDiagnostics && trailDiagnostics.ownerTrailBoundsRejected,
            trailOwnerPrimitiveCandidates: trailDiagnostics && trailDiagnostics.ownerTrailPrimitiveCandidates,
            trailOwnerPrimitiveTests: trailDiagnostics && trailDiagnostics.ownerTrailPrimitiveTests,
            trailOwnerSegmentChecks: trailDiagnostics && trailDiagnostics.ownerTrailSegmentChecks,
            trailOwnerCandidates: trailDiagnostics && trailDiagnostics.trailOwnerCandidates,
            trailOwnerCacheHits: trailDiagnostics && trailDiagnostics.trailOwnerCacheHits,
            trailOwnerCacheMisses: trailDiagnostics && trailDiagnostics.trailOwnerCacheMisses,
            trailOwnerMovementBoundsRejected: trailDiagnostics && trailDiagnostics.trailOwnerMovementBoundsRejected,
            trailOwnerSideBoundsRejected: trailDiagnostics && trailDiagnostics.trailOwnerSideBoundsRejected,
            trailSelfBlockChecks: trailDiagnostics && trailDiagnostics.selfTrailBlockChecks,
            trailSelfBlockBoundsRejected: trailDiagnostics && trailDiagnostics.selfTrailBlockBoundsRejected,
            trailSelfBoundsRejected: trailDiagnostics && trailDiagnostics.selfTrailBoundsRejected,
            trailSelfMovementBoundsRejected: trailDiagnostics && trailDiagnostics.selfTrailMovementBoundsRejected,
            trailSelfPrimitiveCandidates: trailDiagnostics && trailDiagnostics.selfTrailPrimitiveCandidates,
            trailSelfPrimitiveTests: trailDiagnostics && trailDiagnostics.selfTrailPrimitiveTests,
            trailSelfRecentSegmentSkipped: trailDiagnostics && trailDiagnostics.selfTrailRecentSegmentSkipped,
            trailSelfSegmentBoundsRejected: trailDiagnostics && trailDiagnostics.selfTrailSegmentBoundsRejected,
            trailSelfSegmentCandidates: trailDiagnostics && trailDiagnostics.selfTrailSegmentCandidates,
            trailSelfSideBoundsRejected: trailDiagnostics && trailDiagnostics.selfTrailSideBoundsRejected,
            trailSelfSideCandidates: trailDiagnostics && trailDiagnostics.selfTrailSideCandidates,
            trailSelfSegmentChecks: trailDiagnostics && trailDiagnostics.selfTrailSegmentChecks,
            trailPathPrimitiveBlockCount: trailDiagnostics && trailDiagnostics.pathPrimitiveBlockCount,
            trailPathPrimitiveCacheHits: trailDiagnostics && trailDiagnostics.pathPrimitiveCacheHits,
            trailPathPrimitiveCacheMisses: trailDiagnostics && trailDiagnostics.pathPrimitiveCacheMisses,
            trailPathPrimitiveCount: trailDiagnostics && trailDiagnostics.pathPrimitiveCount,
            trailPathPrimitiveInputPointCount: trailDiagnostics && trailDiagnostics.pathPrimitiveInputPointCount,
            trailSelfPathPrimitiveBlockCount: trailDiagnostics && trailDiagnostics.selfPathPrimitiveBlockCount,
            trailSelfPathPrimitiveCacheHits: trailDiagnostics && trailDiagnostics.selfPathPrimitiveCacheHits,
            trailSelfPathPrimitiveCacheMisses: trailDiagnostics && trailDiagnostics.selfPathPrimitiveCacheMisses,
            trailSelfPathPrimitiveCount: trailDiagnostics && trailDiagnostics.selfPathPrimitiveCount,
            trailSelfPathPrimitiveInputPointCount: trailDiagnostics && trailDiagnostics.selfPathPrimitiveInputPointCount,
            trailCaptures: trailDiagnostics && trailDiagnostics.captures,
            captureOperationReplayAccepted: trailDiagnostics && trailDiagnostics.captureOperationReplayAccepted,
            captureOperationReplayRejected: trailDiagnostics && trailDiagnostics.captureOperationReplayRejected,
            captureOperationReplayInvalid: trailDiagnostics && trailDiagnostics.captureOperationReplayInvalid,
            captureOperationReplayAreaMismatch: trailDiagnostics && trailDiagnostics.captureOperationReplayAreaMismatch,
            botsMs: round(gameLoopPhases.bots),
            botDecisions: botDiagnostics && botDiagnostics.decisionsProcessed,
            botPending: botDiagnostics && botDiagnostics.pendingAfter,
            botTargetingMs: round(botPhases.targeting),
            botBalanceCandidates: botTargeting.balanceCandidateCount,
            botBalanceEvaluations: botTargeting.balanceEnemyEvaluations,
            botHuntCandidates: botTargeting.huntCandidateCount,
            botHuntEvaluations: botTargeting.huntEnemyEvaluations,
            botTrailTargetBlockChecks: botTargeting.trailBlockChecks,
            botTrailTargetBlockRejected: botTargeting.trailBlockBoundsRejected,
            botTrailTargetPointChecks: botTargeting.trailPointChecks,
            botTrailTargetPointRejected: botTargeting.trailPointDistanceRejected,
            botTrailTargetTerritoryRejected: botTargeting.trailPointTerritoryRejected,
            botTrailTargetIndexHits: botTargeting.trailIndexCacheHitCount,
            botTrailTargetIndexMisses: botTargeting.trailIndexCacheMissCount,
            botSelfTrailMs: round(botPhases.selfTrailSafety),
            botSelfTrailBudgetHits: botSelfTrail.budgetHitCount,
            botSelfTrailBudgetMs: round(botSelfTrail.maxBudgetElapsedMs),
            botSelfTrailCandidates: botSelfTrail.candidateCount,
            botSelfTrailCoarseEvaluations: botSelfTrail.coarseEvaluationCount,
            botSelfTrailEarlyExits: botSelfTrail.earlyExitCount,
            botSelfTrailEvaluated: botSelfTrail.evaluatedCandidateCount,
            botSelfTrailFullEvaluations: botSelfTrail.fullEvaluationCount,
            botSelfTrailRefined: botSelfTrail.selectedRefineCandidateCount,
            botSelfTrailCacheHits: botSelfTrail.safetyCacheHitCount,
            botSelfTrailCacheMisses: botSelfTrail.safetyCacheMissCount,
            botSelfTrailSamples: botSelfTrail.sampleCount,
            botSelfTrailFilteredPoints: botSelfTrail.filteredTrailPointCount,
            botSelfTrailFilteredSegments: botSelfTrail.filteredTrailSegmentCount,
            botSelfTrailPointBlockChecks: botSelfTrail.pointBlockChecks,
            botSelfTrailPointBlockRejected: botSelfTrail.pointBlockBoundsRejected,
            botSelfTrailPointChecks: botSelfTrail.pointDistanceCheckCount,
            botSelfTrailSegmentBlockChecks: botSelfTrail.segmentBlockChecks,
            botSelfTrailSegmentBlockRejected: botSelfTrail.segmentBlockBoundsRejected,
            botSelfTrailSegmentChecks: botSelfTrail.segmentCrossCheckCount,
            numbersMs: round(gameLoopPhases.numbers),
            buildMs: latestSnapshot && latestSnapshot.server && round(latestSnapshot.server.snapshotBuildMs),
            payloadMeasureMs: latestSnapshot && latestSnapshot.server && round(latestSnapshot.server.payloadMeasureMs),
            payloadBytes: latestSnapshot && latestSnapshot.server && latestSnapshot.server.basePayloadBytes,
            payloadOutlierBytes: payloadOutlier && payloadOutlier.payloadBytes,
            payloadOutlierTopSection: topPayloadSection.section,
            payloadOutlierTopSectionBytes: topPayloadSection.bytes,
            payloadOutlierTopTrailPlayer: topPayloadTrail.playerId,
            payloadOutlierTopTrailBytes: topPayloadTrail.bytes,
            payloadOutlierTopTrailPoints: topPayloadTrail.pointCount,
            payloadOutlierTopTrailPatchPoints: topPayloadTrail.patchPointCount,
            territoryPayloads: breakdown.territoryPayloadCount,
            territoryOps: breakdown.territoryOperationCount,
            trailPatchPoints: breakdown.trailPatchPointCount,
            partialTrailUpdates: breakdown.partialTrailUpdateCount,
            partialTrailRemainingPoints: breakdown.partialTrailRemainingPointCount,
            payloadBudgetUsedBytes: payloadBudget.usedBytes,
            payloadBudgetDeferredBytes: payloadBudget.deferredBytes,
            payloadBudgetDeferredTerritories: payloadBudgetDeferred.territories,
            payloadBudgetDeferredTrails: payloadBudgetDeferred.trails,
            resyncRequests: resync.requested,
            resyncSuppressed: resync.suppressed,
            resyncPerMinute: round(resync.requestedPerMinute),
            resyncLastReason: resync.lastReason,
            resyncLastAgeMs: round(resync.lastAgeMs),
            resyncLastTerritories: lastResyncInvalidations.territories,
            resyncLastTrails: lastResyncInvalidations.trails,
            resyncLastPlayerInfo: lastResyncInvalidations.playerInfo,
            serverResyncRequests: server && server.snapshotResyncRequestCount,
            serverResyncLastAgeMs: round(serverResync.ageMs),
            cacheInvalidationEvents: resync.snapshotInvalidationEvents,
            cacheInvalidationPerMinute: round(resync.snapshotInvalidationsPerMinute),
            serverCacheInvalidations: server && server.snapshotCacheInvalidationCount,
            serverCacheInvalidationLastAgeMs: round(serverCacheInvalidation.ageMs),
            serverCacheInvalidationFullReset: serverCacheInvalidation.fullCacheReset,
            serverCacheInvalidationTerritories: lastCacheInvalidations.territories,
            serverCacheInvalidationTrails: lastCacheInvalidations.trails,
            serverCacheInvalidationPlayerInfo: lastCacheInvalidations.playerInfo,
            transport: data.transport
        };

        console.table([row]);
        return data;
    }

    function table(limit = 20) {
        const snapshotDiagnostics = snapshots && typeof snapshots.getNetworkDiagnostics === "function"
            ? snapshots.getNetworkDiagnostics()
            : { events: [] };
        const rows = (snapshotDiagnostics.events || [])
            .filter(event => event.type === "snapshot")
            .slice(-limit)
            .map(event => ({
                at: new Date(event.at).toLocaleTimeString(),
                bufferMs: round(event.bufferMs),
                interArrivalMs: round(event.snapshotInterArrivalMs),
                jitterMs: round(event.jitterMs),
                estimatedTransitMs: round(event.estimatedTransitMs),
                sendType: event.server && event.server.sendType,
                serverIntervalMs: event.server && round(event.server.serverSendIntervalMs),
                loopDriftMs: event.server && round(event.server.loopDriftMs),
                gameLoopMs: event.server && event.server.gameLoop && round(event.server.gameLoop.tickDurationMs),
                gameLoopDriftMs: event.server && event.server.gameLoop && round(event.server.gameLoop.tickDriftMs),
                slowestPhase: event.server && event.server.gameLoop && event.server.gameLoop.slowestPhase && event.server.gameLoop.slowestPhase.name,
                trailsMs: event.server && event.server.gameLoop && event.server.gameLoop.phases && round(event.server.gameLoop.phases.trails),
                trailSlowest: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.slowestPhase && event.server.gameLoop.trails.slowestPhase.name,
                trailSlowestMs: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.slowestPhase && round(event.server.gameLoop.trails.slowestPhase.durationMs),
                trailCaptureMs: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && round(event.server.gameLoop.trails.phases.capture),
                trailCaptureCreateMs: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && round(event.server.gameLoop.trails.phases.captureCreate),
                trailCaptureApplyMs: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && round(event.server.gameLoop.trails.phases.captureApplyTerritory),
                captureApplyCalls: getEventCaptureApply(event) && getEventCaptureApply(event).calls,
                captureApplyCandidates: getEventCaptureApply(event) && getEventCaptureApply(event).candidateCount,
                captureApplyBoundsRejected: getEventCaptureApply(event) && getEventCaptureApply(event).boundsRejectedCount,
                captureApplyBoundsOverlaps: getEventCaptureApply(event) && getEventCaptureApply(event).boundsOverlapCount,
                captureApplyOverlaps: getEventCaptureApply(event) && getEventCaptureApply(event).overlapCount,
                captureApplyOverlapRejected: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRejectedCount,
                captureApplySubtractions: getEventCaptureApply(event) && getEventCaptureApply(event).subtractCount,
                captureApplyOperationSubtractPoints: getEventCaptureApply(event) && getEventCaptureApply(event).subtractOperationPointCount,
                captureApplyChangedTerritories: getEventCaptureApply(event) && getEventCaptureApply(event).changedTerritoryCount,
                captureApplyPostOverlapChecks: getEventCaptureApply(event) && getEventCaptureApply(event).postCaptureOverlapCheckCount,
                captureApplyPostOverlaps: getEventCaptureApply(event) && getEventCaptureApply(event).postCaptureOverlapCount,
                captureApplyPostOverlapRepairChanged: getEventCaptureApply(event) && getEventCaptureApply(event).postCaptureOverlapRepairChangedCount,
                captureApplyPostOverlapRepairs: getEventCaptureApply(event) && getEventCaptureApply(event).postCaptureOverlapRepairCount,
                overlapRepairQueueProcessed: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairQueueProcessedCount,
                overlapRepairQueueChanged: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairQueueChangedCount,
                overlapRepairQueuePending: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairQueuePendingCount,
                overlapRepairQueueBudgetHits: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairQueueBudgetHitCount,
                overlapRepairWorkerDispatched: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerDispatchedCount,
                overlapRepairWorkerCompleted: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerCompletedCount,
                overlapRepairWorkerChanged: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerChangedCount,
                overlapRepairWorkerNoChange: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerNoChangeCount,
                overlapRepairWorkerStale: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerStaleCount,
                overlapRepairWorkerFailed: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerFailedCount,
                overlapRepairWorkerBackpressure: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerBackpressureCount,
                overlapRepairWorkerInFlight: getEventCaptureApply(event) && getEventCaptureApply(event).overlapRepairWorkerInFlightCount,
                overlapRepairWorkerLatencyMs: getEventCaptureApply(event) && round(getEventCaptureApply(event).overlapRepairWorkerLatencyMs),
                overlapRepairWorkerComputeMs: getEventCaptureApply(event) && round(getEventCaptureApply(event).overlapRepairWorkerComputeMs),
                overlapRepairWorkerIntersectionMs: getEventCaptureApply(event) && round(getEventCaptureApply(event).overlapRepairWorkerIntersectionMs),
                overlapRepairWorkerSubtractMs: getEventCaptureApply(event) && round(getEventCaptureApply(event).overlapRepairWorkerSubtractMs),
                captureApplyCapturedPoints: getEventCaptureApply(event) && getEventCaptureApply(event).maxCapturedPointCount,
                captureApplySubtractPoints: getEventCaptureApply(event) && getEventCaptureApply(event).subtractPointCount,
                captureApplySlowestOverlapMs: getEventCaptureApply(event) && getEventCaptureApply(event).slowestOverlap && round(getEventCaptureApply(event).slowestOverlap.durationMs),
                captureApplySlowestOverlapPoints: getEventCaptureApply(event) && getEventCaptureApply(event).slowestOverlap && getEventCaptureApply(event).slowestOverlap.subjectPointCount,
                captureApplySlowestSubtractMs: getEventCaptureApply(event) && getEventCaptureApply(event).slowestSubtract && round(getEventCaptureApply(event).slowestSubtract.durationMs),
                captureApplySlowestSubtractPoints: getEventCaptureApply(event) && getEventCaptureApply(event).slowestSubtract && getEventCaptureApply(event).slowestSubtract.subjectPointCount,
                captureApplySlowestSubtractOperationPoints: getEventCaptureApply(event) && getEventCaptureApply(event).slowestSubtract && getEventCaptureApply(event).slowestSubtract.operationSubjectPointCount,
                captureApplySlowestSubtractResultPoints: getEventCaptureApply(event) && getEventCaptureApply(event).slowestSubtract && getEventCaptureApply(event).slowestSubtract.resultPointCount,
                trailFillMs: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && round(event.server.gameLoop.trails.phases.fill),
                trailOwnerCrossingMs: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && round(event.server.gameLoop.trails.phases.ownerCrossing),
                trailSelfCollisionMs: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.phases && round(event.server.gameLoop.trails.phases.selfCollision),
                trailOwnerBlockChecks: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailBlockChecks,
                trailOwnerBlockBoundsRejected: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailBlockBoundsRejected,
                trailOwnerBoundsRejected: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailBoundsRejected,
                trailOwnerPrimitiveCandidates: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailPrimitiveCandidates,
                trailOwnerPrimitiveTests: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailPrimitiveTests,
                trailOwnerSegmentChecks: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.ownerTrailSegmentChecks,
                trailSelfBlockChecks: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailBlockChecks,
                trailSelfBlockBoundsRejected: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailBlockBoundsRejected,
                trailSelfBoundsRejected: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailBoundsRejected,
                trailSelfMovementBoundsRejected: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailMovementBoundsRejected,
                trailSelfPrimitiveCandidates: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailPrimitiveCandidates,
                trailSelfPrimitiveTests: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailPrimitiveTests,
                trailSelfRecentSegmentSkipped: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailRecentSegmentSkipped,
                trailSelfSegmentBoundsRejected: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSegmentBoundsRejected,
                trailSelfSegmentCandidates: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSegmentCandidates,
                trailSelfSideBoundsRejected: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSideBoundsRejected,
                trailSelfSideCandidates: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSideCandidates,
                trailSelfSegmentChecks: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfTrailSegmentChecks,
                trailPathPrimitiveBlockCount: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.pathPrimitiveBlockCount,
                trailPathPrimitiveCacheHits: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.pathPrimitiveCacheHits,
                trailPathPrimitiveCacheMisses: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.pathPrimitiveCacheMisses,
                trailPathPrimitiveCount: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.pathPrimitiveCount,
                trailPathPrimitiveInputPointCount: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.pathPrimitiveInputPointCount,
                trailSelfPathPrimitiveBlockCount: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfPathPrimitiveBlockCount,
                trailSelfPathPrimitiveCacheHits: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfPathPrimitiveCacheHits,
                trailSelfPathPrimitiveCacheMisses: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfPathPrimitiveCacheMisses,
                trailSelfPathPrimitiveCount: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfPathPrimitiveCount,
                trailSelfPathPrimitiveInputPointCount: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.selfPathPrimitiveInputPointCount,
                trailCaptures: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.captures,
                captureOperationReplayAccepted: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.captureOperationReplayAccepted,
                captureOperationReplayRejected: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.captureOperationReplayRejected,
                captureOperationReplayInvalid: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.captureOperationReplayInvalid,
                captureOperationReplayAreaMismatch: event.server && event.server.gameLoop && event.server.gameLoop.trails && event.server.gameLoop.trails.captureOperationReplayAreaMismatch,
                botsMs: event.server && event.server.gameLoop && event.server.gameLoop.phases && round(event.server.gameLoop.phases.bots),
                botDecisions: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.decisionsProcessed,
                botPending: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.pendingAfter,
                botSlowest: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.slowestPhase && event.server.gameLoop.bot.slowestPhase.name,
                botTargetingMs: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.phases && round(event.server.gameLoop.bot.phases.targeting),
                botBalanceCandidates: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.balanceCandidateCount,
                botBalanceEvaluations: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.balanceEnemyEvaluations,
                botHuntCandidates: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.huntCandidateCount,
                botHuntEvaluations: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.huntEnemyEvaluations,
                botTrailTargetBlockChecks: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.trailBlockChecks,
                botTrailTargetBlockRejected: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.trailBlockBoundsRejected,
                botTrailTargetPointChecks: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.trailPointChecks,
                botTrailTargetPointRejected: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.trailPointDistanceRejected,
                botTrailTargetTerritoryRejected: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.targeting && event.server.gameLoop.bot.targeting.trailPointTerritoryRejected,
                botSelfTrailMs: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.phases && round(event.server.gameLoop.bot.phases.selfTrailSafety),
                botSelfTrailBudgetHits: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.budgetHitCount,
                botSelfTrailBudgetMs: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && round(event.server.gameLoop.bot.selfTrailSafety.maxBudgetElapsedMs),
                botSelfTrailCandidates: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.candidateCount,
                botSelfTrailCoarseEvaluations: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.coarseEvaluationCount,
                botSelfTrailEarlyExits: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.earlyExitCount,
                botSelfTrailEvaluated: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.evaluatedCandidateCount,
                botSelfTrailFullEvaluations: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.fullEvaluationCount,
                botSelfTrailRefined: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.selectedRefineCandidateCount,
                botSelfTrailCacheHits: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.safetyCacheHitCount,
                botSelfTrailCacheMisses: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.safetyCacheMissCount,
                botSelfTrailSamples: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.sampleCount,
                botSelfTrailFilteredPoints: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.filteredTrailPointCount,
                botSelfTrailFilteredSegments: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.filteredTrailSegmentCount,
                botSelfTrailPointBlockChecks: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.pointBlockChecks,
                botSelfTrailPointBlockRejected: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.pointBlockBoundsRejected,
                botSelfTrailPointChecks: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.pointDistanceCheckCount,
                botSelfTrailSegmentBlockChecks: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.segmentBlockChecks,
                botSelfTrailSegmentBlockRejected: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.segmentBlockBoundsRejected,
                botSelfTrailSegmentChecks: event.server && event.server.gameLoop && event.server.gameLoop.bot && event.server.gameLoop.bot.selfTrailSafety && event.server.gameLoop.bot.selfTrailSafety.segmentCrossCheckCount,
                numbersMs: event.server && event.server.gameLoop && event.server.gameLoop.phases && round(event.server.gameLoop.phases.numbers),
                buildMs: event.server && round(event.server.snapshotBuildMs),
                payloadMeasureMs: event.server && round(event.server.payloadMeasureMs),
                payloadBytes: event.server && event.server.basePayloadBytes,
                payloadOutlierBytes: getEventPayloadOutlier(event) && getEventPayloadOutlier(event).payloadBytes,
                payloadOutlierTopSection: getTopPayloadSection(event) && getTopPayloadSection(event).section,
                payloadOutlierTopSectionBytes: getTopPayloadSection(event) && getTopPayloadSection(event).bytes,
                payloadOutlierTopTrailPlayer: getTopPayloadTrail(event) && getTopPayloadTrail(event).playerId,
                payloadOutlierTopTrailPoints: getTopPayloadTrail(event) && getTopPayloadTrail(event).pointCount,
                territoryPayloads: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.territoryPayloadCount,
                territoryOps: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.territoryOperationCount,
                trailPatchPoints: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.trailPatchPointCount,
                partialTrailUpdates: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.partialTrailUpdateCount,
                partialTrailRemainingPoints: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.partialTrailRemainingPointCount,
                payloadBudgetDeferredBytes: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.payloadBudget && event.server.snapshotBreakdown.payloadBudget.deferredBytes,
                payloadBudgetDeferredTerritories: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.payloadBudget && event.server.snapshotBreakdown.payloadBudget.deferred && event.server.snapshotBreakdown.payloadBudget.deferred.territories,
                payloadBudgetDeferredTrails: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.payloadBudget && event.server.snapshotBreakdown.payloadBudget.deferred && event.server.snapshotBreakdown.payloadBudget.deferred.trails,
                invalidatedTerritories: event.invalidations && event.invalidations.territories,
                invalidatedTrails: event.invalidations && event.invalidations.trails,
                invalidatedPlayerInfo: event.invalidations && event.invalidations.playerInfo,
                serverResyncRequests: event.server && event.server.snapshotResyncRequestCount,
                serverResyncLastAgeMs: event.server && event.server.lastSnapshotResync && round(event.server.lastSnapshotResync.ageMs),
                serverCacheInvalidations: event.server && event.server.snapshotCacheInvalidationCount,
                serverCacheInvalidationLastAgeMs: event.server && event.server.lastSnapshotCacheInvalidation && round(event.server.lastSnapshotCacheInvalidation.ageMs),
                serverCacheInvalidationTerritories: event.server && event.server.lastSnapshotCacheInvalidation && event.server.lastSnapshotCacheInvalidation.invalidations && event.server.lastSnapshotCacheInvalidation.invalidations.territories,
                reliableRetryCount: event.server && event.server.reliableRetryCount,
                preserveTrails: event.preserveTrails
            }));

        console.table(rows);
        return rows;
    }

    function getEventCaptureApply(event) {
        return event
            && event.server
            && event.server.gameLoop
            && event.server.gameLoop.trails
            && event.server.gameLoop.trails.captureApply;
    }

    function getEventPayloadOutlier(event) {
        return event
            && event.server
            && event.server.snapshotBreakdown
            && event.server.snapshotBreakdown.payloadOutlier;
    }

    function getTopPayloadSection(event) {
        const outlier = getEventPayloadOutlier(event);

        return outlier && outlier.topSections && outlier.topSections[0] || null;
    }

    function getTopPayloadTrail(event) {
        const outlier = getEventPayloadOutlier(event);

        return outlier && outlier.topTrails && outlier.topTrails[0] || null;
    }

    function clear() {
        events.length = 0;
        pings.length = 0;
    }

    function isRunning() {
        return timerId !== null;
    }

    function registerSocketEvents() {
        if (!socket || typeof socket.on !== "function") {
            return;
        }

        socket.on("connect", () => {
            recordEvent("socket-connect", {
                transport: getTransportName()
            });
        });
        socket.on("disconnect", reason => {
            recordEvent("socket-disconnect", {
                reason,
                transport: getTransportName()
            });
        });
        socket.on("connect_error", error => {
            recordEvent("socket-connect-error", {
                message: error && error.message
            });
        });

        const engine = socket.io && socket.io.engine;

        if (engine && typeof engine.on === "function") {
            engine.on("upgrade", transport => {
                recordEvent("transport-upgrade", {
                    transport: transport && transport.name || getTransportName()
                });
            });
        }
    }

    function emitWithAck(eventName, payload, timeoutMs = 2000) {
        return new Promise(resolve => {
            if (!socket || typeof socket.emit !== "function" || !socket.connected) {
                resolve({
                    error: "socket-not-connected"
                });
                return;
            }

            const emitter = typeof socket.timeout === "function"
                ? socket.timeout(timeoutMs)
                : socket;

            emitter.emit(eventName, payload, (error, response) => {
                if (error) {
                    resolve({
                        error: error.message || String(error)
                    });
                    return;
                }

                resolve(response || {});
            });
        });
    }

    function diagnoseNetwork(snapshotDiagnostics, pingSummary) {
        const current = snapshotDiagnostics && snapshotDiagnostics.current;
        const latest = current && current.lastSnapshot;
        const server = latest && latest.server;
        const slowBufferMs = getPositiveNumber(networkConfig.diagnosticsSlowBufferMs, DEFAULT_SLOW_BUFFER_MS);
        const slowServerIntervalMs = getPositiveNumber(networkConfig.diagnosticsSlowServerIntervalMs, DEFAULT_SLOW_SERVER_INTERVAL_MS);
        const slowLoopDriftMs = getPositiveNumber(networkConfig.diagnosticsSlowLoopDriftMs, DEFAULT_SLOW_LOOP_DRIFT_MS);
        const slowGameLoopMs = getPositiveNumber(networkConfig.diagnosticsSlowGameLoopMs, DEFAULT_SLOW_GAME_LOOP_MS);
        const slowSnapshotBuildMs = getPositiveNumber(networkConfig.diagnosticsSlowSnapshotBuildMs, DEFAULT_SLOW_SNAPSHOT_BUILD_MS);
        const slowPayloadMeasureMs = getPositiveNumber(networkConfig.diagnosticsSlowPayloadMeasureMs, DEFAULT_SLOW_PAYLOAD_MEASURE_MS);
        const largePayloadBytes = getPositiveNumber(networkConfig.diagnosticsLargePayloadBytes, DEFAULT_LARGE_PAYLOAD_BYTES);
        const gameLoop = server && server.gameLoop;

        if (!latest) {
            return {
                reason: "waiting-for-snapshots",
                detail: "No snapshot samples recorded yet."
            };
        }

        if (server && server.sendType === "reliable-retry") {
            return {
                reason: "reliable-snapshot-retry",
                detail: "Reliable snapshot retry is active; ACK or cache recovery may be delaying fresh state."
            };
        }

        if (server && isReliableBacklog(server)) {
            return {
                reason: "reliable-snapshot-pending",
                detail: "A reliable snapshot is pending and volatile snapshots are preserving cached state."
            };
        }

        if (gameLoop && gameLoop.tickDurationMs >= slowGameLoopMs) {
            return {
                reason: "server-game-loop-work",
                detail: createGameLoopDiagnosisDetail(gameLoop)
            };
        }

        if (server && server.loopDriftMs >= slowLoopDriftMs && gameLoop && gameLoop.tickDriftMs >= slowLoopDriftMs) {
            return {
                reason: "server-event-loop-drift",
                detail: createGameLoopDriftDetail(gameLoop)
            };
        }

        if (server && server.loopDriftMs >= slowLoopDriftMs) {
            return {
                reason: "server-loop-drift",
                detail: "Server snapshot loop drift exceeded the expected cadence; event-loop or tick processing is delaying sends."
            };
        }

        if (server && server.snapshotBuildMs >= slowSnapshotBuildMs) {
            return {
                reason: "server-snapshot-build",
                detail: "Server spent too long building the snapshot before sending it."
            };
        }

        if (server && server.payloadMeasureMs >= slowPayloadMeasureMs) {
            return {
                reason: "diagnostic-payload-measurement",
                detail: "Diagnostic JSON payload measurement is itself taking noticeable time."
            };
        }

        if (server && server.basePayloadBytes >= largePayloadBytes) {
            return {
                reason: "large-snapshot-payload",
                detail: "Serialized snapshot payload is large; territory, trail, or full-sync data may be driving buffer growth."
            };
        }

        if (latest.bufferMs >= slowBufferMs && latest.jitterMs >= 25) {
            return {
                reason: "client-jitter",
                detail: "Client received snapshots with high inter-arrival jitter."
            };
        }

        if (server && server.serverSendIntervalMs > slowServerIntervalMs) {
            return {
                reason: "server-send-gap",
                detail: "Server-side snapshot send interval exceeded the expected cadence."
            };
        }

        if (
            latest.snapshotInterArrivalMs > slowServerIntervalMs
            && (!server || !Number.isFinite(server.serverSendIntervalMs) || server.serverSendIntervalMs <= slowServerIntervalMs)
        ) {
            return {
                reason: "network-arrival-gap",
                detail: "Client received snapshots late while server send cadence looked normal."
            };
        }

        if (pingSummary.last && pingSummary.last.roundTripMs >= 160) {
            return {
                reason: "high-rtt",
                detail: "Socket.IO diagnostic ping has high round-trip time."
            };
        }

        if (latest.bufferMs >= slowBufferMs) {
            return {
                reason: "buffer-high-unclassified",
                detail: "Buffer is high, but no single network signal is dominant in the latest sample."
            };
        }

        return {
            reason: "network-stable",
            detail: "Latest network samples are within the configured thresholds."
        };
    }

    function createGameLoopDiagnosisDetail(gameLoop) {
        const slowestPhase = gameLoop && gameLoop.slowestPhase;

        if (!slowestPhase || !slowestPhase.name) {
            return "Server game loop work exceeded the expected per-tick budget.";
        }

        if (slowestPhase.name === "bots" && gameLoop.bot && gameLoop.bot.slowestPhase) {
            return `Server game loop exceeded budget; bots phase was slowest, subphase: ${gameLoop.bot.slowestPhase.name} (${round(gameLoop.bot.slowestPhase.durationMs)}ms).`;
        }

        if (slowestPhase.name === "trails" && gameLoop.trails && gameLoop.trails.slowestPhase) {
            return `Server game loop exceeded budget; trails phase was slowest, subphase: ${gameLoop.trails.slowestPhase.name} (${round(gameLoop.trails.slowestPhase.durationMs)}ms).`;
        }

        return `Server game loop exceeded budget; slowest phase: ${slowestPhase.name} (${round(slowestPhase.durationMs)}ms).`;
    }

    function createGameLoopDriftDetail(gameLoop) {
        const slowestPhase = gameLoop && gameLoop.slowestPhase;

        if (!slowestPhase || !slowestPhase.name) {
            return "Server game loop tick drift was high; another synchronous task may be blocking the event loop.";
        }

        if (slowestPhase.name === "bots" && gameLoop.bot && gameLoop.bot.slowestPhase) {
            return `Server game loop tick drift was high; bots subphase: ${gameLoop.bot.slowestPhase.name} (${round(gameLoop.bot.slowestPhase.durationMs)}ms).`;
        }

        if (slowestPhase.name === "trails" && gameLoop.trails && gameLoop.trails.slowestPhase) {
            return `Server game loop tick drift was high; trails subphase: ${gameLoop.trails.slowestPhase.name} (${round(gameLoop.trails.slowestPhase.durationMs)}ms).`;
        }

        return `Server game loop tick drift was high; last slowest phase: ${slowestPhase.name} (${round(slowestPhase.durationMs)}ms).`;
    }

    function createPingSummary() {
        return {
            samples: pings.length,
            last: pings[pings.length - 1] || null,
            averageRoundTripMs: averageFiniteValues(pings.map(sample => sample.roundTripMs)),
            maxRoundTripMs: maxFiniteValue(pings.map(sample => sample.roundTripMs))
        };
    }

    function isReliableBacklog(server) {
        return Boolean(server && (server.reliableBacklog || server.sendType === "volatile-pending"));
    }

    function recordEvent(type, detail = {}) {
        events.push({
            at: Date.now(),
            type,
            ...detail
        });
        trimHistory(events);
    }

    function trimHistory(values) {
        const limit = getPositiveInteger(networkConfig.diagnosticsHistoryLimit, DEFAULT_HISTORY_LIMIT);

        while (values.length > limit) {
            values.shift();
        }
    }

    function stopTimer() {
        if (timerId === null) {
            return;
        }

        clearInterval(timerId);
        timerId = null;
    }

    function getTransportName() {
        return socket
            && socket.io
            && socket.io.engine
            && socket.io.engine.transport
            && socket.io.engine.transport.name
            ? socket.io.engine.transport.name
            : null;
    }

    function shouldAutoStart() {
        if (typeof window === "undefined") {
            return false;
        }

        const params = new URLSearchParams(window.location.search);
        const value = params.get("netdiag") || params.get("networkDiagnostics");

        return value === "1" || value === "true" || value === "on";
    }
}

function exposeDiagnosticsApi(api) {
    if (typeof window === "undefined") {
        return;
    }

    window.VennperioNetworkDiagnostics = api;
}

function getPositiveNumber(value, fallback) {
    const number = Number(value);

    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getPositiveInteger(value, fallback) {
    const number = Math.trunc(Number(value));

    return Number.isInteger(number) && number > 0 ? number : fallback;
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

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
}
