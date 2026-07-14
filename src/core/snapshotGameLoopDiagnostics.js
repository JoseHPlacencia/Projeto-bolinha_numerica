/**
 * Normalizes game-loop diagnostics before they cross the Socket.IO boundary.
 * Gameplay systems produce the raw metrics; this module owns the stable,
 * network-safe representation consumed by diagnostics clients.
 */
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
        ownerTrailBlockBoundsRejected: trailDiagnostics.ownerTrailBlockBoundsRejected,
        ownerTrailBlockChecks: trailDiagnostics.ownerTrailBlockChecks,
        ownerTrailBoundsRejected: trailDiagnostics.ownerTrailBoundsRejected,
        ownerTrailPrimitiveCandidates: trailDiagnostics.ownerTrailPrimitiveCandidates,
        ownerTrailPrimitiveTests: trailDiagnostics.ownerTrailPrimitiveTests,
        ownerTrailSegmentChecks: trailDiagnostics.ownerTrailSegmentChecks,
        pathPrimitiveBlockCount: trailDiagnostics.pathPrimitiveBlockCount,
        pathPrimitiveCacheHits: trailDiagnostics.pathPrimitiveCacheHits,
        pathPrimitiveIncrementalUpdates: trailDiagnostics.pathPrimitiveIncrementalUpdates,
        pathPrimitiveCacheMisses: trailDiagnostics.pathPrimitiveCacheMisses,
        pathPrimitiveCount: trailDiagnostics.pathPrimitiveCount,
        pathPrimitiveInputPointCount: trailDiagnostics.pathPrimitiveInputPointCount,
        pathPrimitiveRebuiltPointCount: trailDiagnostics.pathPrimitiveRebuiltPointCount,
        pathPrimitiveReusedBlockCount: trailDiagnostics.pathPrimitiveReusedBlockCount,
        phases: { ...(trailDiagnostics.phases || {}) },
        playersProcessed: trailDiagnostics.playersProcessed,
        selfCollisionTests: trailDiagnostics.selfCollisionTests,
        selfCollisions: trailDiagnostics.selfCollisions,
        selfPathPrimitiveBlockCount: trailDiagnostics.selfPathPrimitiveBlockCount,
        selfPathPrimitiveCacheHits: trailDiagnostics.selfPathPrimitiveCacheHits,
        selfPathPrimitiveIncrementalUpdates: trailDiagnostics.selfPathPrimitiveIncrementalUpdates,
        selfPathPrimitiveCacheMisses: trailDiagnostics.selfPathPrimitiveCacheMisses,
        selfPathPrimitiveCount: trailDiagnostics.selfPathPrimitiveCount,
        selfPathPrimitiveInputPointCount: trailDiagnostics.selfPathPrimitiveInputPointCount,
        selfPathPrimitiveRebuiltPointCount: trailDiagnostics.selfPathPrimitiveRebuiltPointCount,
        selfPathPrimitiveReusedBlockCount: trailDiagnostics.selfPathPrimitiveReusedBlockCount,
        selfTrailBlockBoundsRejected: trailDiagnostics.selfTrailBlockBoundsRejected,
        selfTrailBlockChecks: trailDiagnostics.selfTrailBlockChecks,
        selfTrailBoundsRejected: trailDiagnostics.selfTrailBoundsRejected,
        selfTrailMovementBoundsRejected: trailDiagnostics.selfTrailMovementBoundsRejected,
        selfTrailPrimitiveCandidates: trailDiagnostics.selfTrailPrimitiveCandidates,
        selfTrailPrimitiveTests: trailDiagnostics.selfTrailPrimitiveTests,
        selfTrailRecentSegmentSkipped: trailDiagnostics.selfTrailRecentSegmentSkipped,
        selfTrailSegmentBoundsRejected: trailDiagnostics.selfTrailSegmentBoundsRejected,
        selfTrailSegmentCandidates: trailDiagnostics.selfTrailSegmentCandidates,
        selfTrailSideBoundsRejected: trailDiagnostics.selfTrailSideBoundsRejected,
        selfTrailSideCandidates: trailDiagnostics.selfTrailSideCandidates,
        selfTrailSegmentChecks: trailDiagnostics.selfTrailSegmentChecks,
        slowestPhase: trailDiagnostics.slowestPhase
            ? { ...trailDiagnostics.slowestPhase }
            : null,
        trailOwnerCacheHits: trailDiagnostics.trailOwnerCacheHits,
        trailOwnerCacheMisses: trailDiagnostics.trailOwnerCacheMisses,
        trailOwnerCandidates: trailDiagnostics.trailOwnerCandidates,
        trailOwnerChecks: trailDiagnostics.trailOwnerChecks,
        trailOwnerHits: trailDiagnostics.trailOwnerHits,
        trailOwnerInsideRejected: trailDiagnostics.trailOwnerInsideRejected,
        trailOwnerMovementBoundsRejected: trailDiagnostics.trailOwnerMovementBoundsRejected,
        trailOwnerNoTrailRejected: trailDiagnostics.trailOwnerNoTrailRejected,
        trailOwnerSideBoundsRejected: trailDiagnostics.trailOwnerSideBoundsRejected
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
        ownerTrailBlockBoundsRejected: finiteOrNull(trailDiagnostics.ownerTrailBlockBoundsRejected),
        ownerTrailBlockChecks: finiteOrNull(trailDiagnostics.ownerTrailBlockChecks),
        ownerTrailBoundsRejected: finiteOrNull(trailDiagnostics.ownerTrailBoundsRejected),
        ownerTrailPrimitiveCandidates: finiteOrNull(trailDiagnostics.ownerTrailPrimitiveCandidates),
        ownerTrailPrimitiveTests: finiteOrNull(trailDiagnostics.ownerTrailPrimitiveTests),
        ownerTrailSegmentChecks: finiteOrNull(trailDiagnostics.ownerTrailSegmentChecks),
        pathPrimitiveBlockCount: finiteOrNull(trailDiagnostics.pathPrimitiveBlockCount),
        pathPrimitiveCacheHits: finiteOrNull(trailDiagnostics.pathPrimitiveCacheHits),
        pathPrimitiveIncrementalUpdates: finiteOrNull(trailDiagnostics.pathPrimitiveIncrementalUpdates),
        pathPrimitiveCacheMisses: finiteOrNull(trailDiagnostics.pathPrimitiveCacheMisses),
        pathPrimitiveCount: finiteOrNull(trailDiagnostics.pathPrimitiveCount),
        pathPrimitiveInputPointCount: finiteOrNull(trailDiagnostics.pathPrimitiveInputPointCount),
        pathPrimitiveRebuiltPointCount: finiteOrNull(trailDiagnostics.pathPrimitiveRebuiltPointCount),
        pathPrimitiveReusedBlockCount: finiteOrNull(trailDiagnostics.pathPrimitiveReusedBlockCount),
        phases: normalizeGameLoopPhases(trailDiagnostics.phases),
        playersProcessed: finiteOrNull(trailDiagnostics.playersProcessed),
        selfCollisionTests: finiteOrNull(trailDiagnostics.selfCollisionTests),
        selfCollisions: finiteOrNull(trailDiagnostics.selfCollisions),
        selfPathPrimitiveBlockCount: finiteOrNull(trailDiagnostics.selfPathPrimitiveBlockCount),
        selfPathPrimitiveCacheHits: finiteOrNull(trailDiagnostics.selfPathPrimitiveCacheHits),
        selfPathPrimitiveIncrementalUpdates: finiteOrNull(trailDiagnostics.selfPathPrimitiveIncrementalUpdates),
        selfPathPrimitiveCacheMisses: finiteOrNull(trailDiagnostics.selfPathPrimitiveCacheMisses),
        selfPathPrimitiveCount: finiteOrNull(trailDiagnostics.selfPathPrimitiveCount),
        selfPathPrimitiveInputPointCount: finiteOrNull(trailDiagnostics.selfPathPrimitiveInputPointCount),
        selfPathPrimitiveRebuiltPointCount: finiteOrNull(trailDiagnostics.selfPathPrimitiveRebuiltPointCount),
        selfPathPrimitiveReusedBlockCount: finiteOrNull(trailDiagnostics.selfPathPrimitiveReusedBlockCount),
        selfTrailBlockBoundsRejected: finiteOrNull(trailDiagnostics.selfTrailBlockBoundsRejected),
        selfTrailBlockChecks: finiteOrNull(trailDiagnostics.selfTrailBlockChecks),
        selfTrailBoundsRejected: finiteOrNull(trailDiagnostics.selfTrailBoundsRejected),
        selfTrailMovementBoundsRejected: finiteOrNull(trailDiagnostics.selfTrailMovementBoundsRejected),
        selfTrailPrimitiveCandidates: finiteOrNull(trailDiagnostics.selfTrailPrimitiveCandidates),
        selfTrailPrimitiveTests: finiteOrNull(trailDiagnostics.selfTrailPrimitiveTests),
        selfTrailRecentSegmentSkipped: finiteOrNull(trailDiagnostics.selfTrailRecentSegmentSkipped),
        selfTrailSegmentBoundsRejected: finiteOrNull(trailDiagnostics.selfTrailSegmentBoundsRejected),
        selfTrailSegmentCandidates: finiteOrNull(trailDiagnostics.selfTrailSegmentCandidates),
        selfTrailSideBoundsRejected: finiteOrNull(trailDiagnostics.selfTrailSideBoundsRejected),
        selfTrailSideCandidates: finiteOrNull(trailDiagnostics.selfTrailSideCandidates),
        selfTrailSegmentChecks: finiteOrNull(trailDiagnostics.selfTrailSegmentChecks),
        slowestPhase: normalizeGameLoopSlowestPhase(trailDiagnostics.slowestPhase),
        trailOwnerCacheHits: finiteOrNull(trailDiagnostics.trailOwnerCacheHits),
        trailOwnerCacheMisses: finiteOrNull(trailDiagnostics.trailOwnerCacheMisses),
        trailOwnerCandidates: finiteOrNull(trailDiagnostics.trailOwnerCandidates),
        trailOwnerChecks: finiteOrNull(trailDiagnostics.trailOwnerChecks),
        trailOwnerHits: finiteOrNull(trailDiagnostics.trailOwnerHits),
        trailOwnerInsideRejected: finiteOrNull(trailDiagnostics.trailOwnerInsideRejected),
        trailOwnerMovementBoundsRejected: finiteOrNull(trailDiagnostics.trailOwnerMovementBoundsRejected),
        trailOwnerNoTrailRejected: finiteOrNull(trailDiagnostics.trailOwnerNoTrailRejected),
        trailOwnerSideBoundsRejected: finiteOrNull(trailDiagnostics.trailOwnerSideBoundsRejected)
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
        overlapRepairQueueBudgetHitCount: diagnostics.overlapRepairQueueBudgetHitCount,
        overlapRepairQueueChangedCount: diagnostics.overlapRepairQueueChangedCount,
        overlapRepairQueuePendingCount: diagnostics.overlapRepairQueuePendingCount,
        overlapRepairQueueProcessedCount: diagnostics.overlapRepairQueueProcessedCount,
        overlapRepairQueueQueuedCount: diagnostics.overlapRepairQueueQueuedCount,
        overlapRepairWorkerBackpressureCount: diagnostics.overlapRepairWorkerBackpressureCount,
        overlapRepairWorkerChangedCount: diagnostics.overlapRepairWorkerChangedCount,
        overlapRepairWorkerCompletedCount: diagnostics.overlapRepairWorkerCompletedCount,
        overlapRepairWorkerComputeMs: diagnostics.overlapRepairWorkerComputeMs,
        overlapRepairWorkerDispatchedCount: diagnostics.overlapRepairWorkerDispatchedCount,
        overlapRepairWorkerFailedCount: diagnostics.overlapRepairWorkerFailedCount,
        overlapRepairWorkerInFlightCount: diagnostics.overlapRepairWorkerInFlightCount,
        overlapRepairWorkerIntersectionMs: diagnostics.overlapRepairWorkerIntersectionMs,
        overlapRepairWorkerLatencyMs: diagnostics.overlapRepairWorkerLatencyMs,
        overlapRepairWorkerNoChangeCount: diagnostics.overlapRepairWorkerNoChangeCount,
        overlapRepairWorkerStaleCount: diagnostics.overlapRepairWorkerStaleCount,
        overlapRepairWorkerSubtractMs: diagnostics.overlapRepairWorkerSubtractMs,
        ownerChangedCount: diagnostics.ownerChangedCount,
        postCaptureOverlapBoundsRejectedCount: diagnostics.postCaptureOverlapBoundsRejectedCount,
        postCaptureOverlapCheckCount: diagnostics.postCaptureOverlapCheckCount,
        postCaptureOverlapCount: diagnostics.postCaptureOverlapCount,
        postCaptureOverlapFirst: diagnostics.postCaptureOverlapFirst
            ? { ...diagnostics.postCaptureOverlapFirst }
            : null,
        postCaptureOverlapRepairChangedCount: diagnostics.postCaptureOverlapRepairChangedCount,
        postCaptureOverlapRepairCount: diagnostics.postCaptureOverlapRepairCount,
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
        overlapRepairQueueBudgetHitCount: finiteOrNull(diagnostics.overlapRepairQueueBudgetHitCount),
        overlapRepairQueueChangedCount: finiteOrNull(diagnostics.overlapRepairQueueChangedCount),
        overlapRepairQueuePendingCount: finiteOrNull(diagnostics.overlapRepairQueuePendingCount),
        overlapRepairQueueProcessedCount: finiteOrNull(diagnostics.overlapRepairQueueProcessedCount),
        overlapRepairQueueQueuedCount: finiteOrNull(diagnostics.overlapRepairQueueQueuedCount),
        overlapRepairWorkerBackpressureCount: finiteOrNull(diagnostics.overlapRepairWorkerBackpressureCount),
        overlapRepairWorkerChangedCount: finiteOrNull(diagnostics.overlapRepairWorkerChangedCount),
        overlapRepairWorkerCompletedCount: finiteOrNull(diagnostics.overlapRepairWorkerCompletedCount),
        overlapRepairWorkerComputeMs: finiteOrNull(diagnostics.overlapRepairWorkerComputeMs),
        overlapRepairWorkerDispatchedCount: finiteOrNull(diagnostics.overlapRepairWorkerDispatchedCount),
        overlapRepairWorkerFailedCount: finiteOrNull(diagnostics.overlapRepairWorkerFailedCount),
        overlapRepairWorkerInFlightCount: finiteOrNull(diagnostics.overlapRepairWorkerInFlightCount),
        overlapRepairWorkerIntersectionMs: finiteOrNull(diagnostics.overlapRepairWorkerIntersectionMs),
        overlapRepairWorkerLatencyMs: finiteOrNull(diagnostics.overlapRepairWorkerLatencyMs),
        overlapRepairWorkerNoChangeCount: finiteOrNull(diagnostics.overlapRepairWorkerNoChangeCount),
        overlapRepairWorkerStaleCount: finiteOrNull(diagnostics.overlapRepairWorkerStaleCount),
        overlapRepairWorkerSubtractMs: finiteOrNull(diagnostics.overlapRepairWorkerSubtractMs),
        ownerChangedCount: finiteOrNull(diagnostics.ownerChangedCount),
        postCaptureOverlapBoundsRejectedCount: finiteOrNull(diagnostics.postCaptureOverlapBoundsRejectedCount),
        postCaptureOverlapCheckCount: finiteOrNull(diagnostics.postCaptureOverlapCheckCount),
        postCaptureOverlapCount: finiteOrNull(diagnostics.postCaptureOverlapCount),
        postCaptureOverlapFirst: normalizePostCaptureOverlap(diagnostics.postCaptureOverlapFirst),
        postCaptureOverlapRepairChangedCount: finiteOrNull(diagnostics.postCaptureOverlapRepairChangedCount),
        postCaptureOverlapRepairCount: finiteOrNull(diagnostics.postCaptureOverlapRepairCount),
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

function normalizePostCaptureOverlap(detail) {
    if (!detail || typeof detail !== "object") {
        return null;
    }

    return {
        firstId: typeof detail.firstId === "string" ? detail.firstId : null,
        firstPointCount: finiteOrNull(detail.firstPointCount),
        firstVersion: finiteOrNull(detail.firstVersion),
        overlapArea: finiteOrNull(detail.overlapArea),
        secondId: typeof detail.secondId === "string" ? detail.secondId : null,
        secondPointCount: finiteOrNull(detail.secondPointCount),
        secondVersion: finiteOrNull(detail.secondVersion)
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
        subjectPointCount: finiteOrNull(detail.subjectPointCount)
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
        targeting: botDiagnostics.targeting
            ? { ...botDiagnostics.targeting }
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
        targeting: normalizeBotTargetingDiagnostics(botDiagnostics.targeting),
        slowestPhase: normalizeGameLoopSlowestPhase(botDiagnostics.slowestPhase)
    };
}

function normalizeBotTargetingDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    return {
        balanceCandidateCount: finiteOrNull(diagnostics.balanceCandidateCount),
        balanceEnemyEvaluations: finiteOrNull(diagnostics.balanceEnemyEvaluations),
        coordinatedNumberCacheHitCount: finiteOrNull(diagnostics.coordinatedNumberCacheHitCount),
        coordinatedNumberCacheMissCount: finiteOrNull(diagnostics.coordinatedNumberCacheMissCount),
        huntCandidateCount: finiteOrNull(diagnostics.huntCandidateCount),
        huntEnemyEvaluations: finiteOrNull(diagnostics.huntEnemyEvaluations),
        returnTargetCacheHitCount: finiteOrNull(diagnostics.returnTargetCacheHitCount),
        returnTargetCacheMissCount: finiteOrNull(diagnostics.returnTargetCacheMissCount),
        trailBlockBoundsRejected: finiteOrNull(diagnostics.trailBlockBoundsRejected),
        trailBlockChecks: finiteOrNull(diagnostics.trailBlockChecks),
        trailIndexCacheHitCount: finiteOrNull(diagnostics.trailIndexCacheHitCount),
        trailIndexCacheMissCount: finiteOrNull(diagnostics.trailIndexCacheMissCount),
        trailPointChecks: finiteOrNull(diagnostics.trailPointChecks),
        trailPointDistanceRejected: finiteOrNull(diagnostics.trailPointDistanceRejected),
        trailPointTerritoryRejected: finiteOrNull(diagnostics.trailPointTerritoryRejected)
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
        coarseEvaluationCount: finiteOrNull(diagnostics.coarseEvaluationCount),
        decisionCount: finiteOrNull(diagnostics.decisionCount),
        earlyExitCount: finiteOrNull(diagnostics.earlyExitCount),
        evaluatedCandidateCount: finiteOrNull(diagnostics.evaluatedCandidateCount),
        evaluatedLocalCandidateCount: finiteOrNull(diagnostics.evaluatedLocalCandidateCount),
        fullEvaluationCount: finiteOrNull(diagnostics.fullEvaluationCount),
        filteredTrailPointCount: finiteOrNull(diagnostics.filteredTrailPointCount),
        filteredTrailSegmentCount: finiteOrNull(diagnostics.filteredTrailSegmentCount),
        localCandidateCount: finiteOrNull(diagnostics.localCandidateCount),
        maxBudgetElapsedMs: finiteOrNull(diagnostics.maxBudgetElapsedMs),
        pathEvaluationCount: finiteOrNull(diagnostics.pathEvaluationCount),
        pointBlockBoundsRejected: finiteOrNull(diagnostics.pointBlockBoundsRejected),
        pointBlockChecks: finiteOrNull(diagnostics.pointBlockChecks),
        pointBlockCount: finiteOrNull(diagnostics.pointBlockCount),
        pointDistanceCheckCount: finiteOrNull(diagnostics.pointDistanceCheckCount),
        sampleCount: finiteOrNull(diagnostics.sampleCount),
        safetyCacheHitCount: finiteOrNull(diagnostics.safetyCacheHitCount),
        safetyCacheMissCount: finiteOrNull(diagnostics.safetyCacheMissCount),
        selectedRefineCandidateCount: finiteOrNull(diagnostics.selectedRefineCandidateCount),
        segmentBlockBoundsRejected: finiteOrNull(diagnostics.segmentBlockBoundsRejected),
        segmentBlockChecks: finiteOrNull(diagnostics.segmentBlockChecks),
        segmentBlockCount: finiteOrNull(diagnostics.segmentBlockCount),
        segmentBoundsRejected: finiteOrNull(diagnostics.segmentBoundsRejected),
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


function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

module.exports = {
    cloneGameLoopDiagnostics,
    normalizeGameLoopDiagnostics
};
