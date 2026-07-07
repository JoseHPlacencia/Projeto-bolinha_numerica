const config = require("../config/gameConfig");
const { updatePlayers } = require("../systems/movementSystem");
const { updateTrails } = require("../systems/trailSystem");
const {
    createCatchCombatFrame,
    handleNumberCollected,
    resolveCatchCombatFrame
} = require("../systems/catchModeSystem");
const { getHighResolutionTime } = require("../utils/time");

function startGameLoop(
    players,
    territories,
    io,
    roomCode,
    numberSystem,
    botManager = null,
    runtimeConfig = null,
    diagnostics = null,
    lifecycle = {}
) {
    const intervalMs = 1000 / config.loop.tickRate;
    let previousTime = getHighResolutionTime();
    let tick = 0;

    initializeGameLoopDiagnostics(diagnostics, intervalMs);

    return setInterval(() => {
        const now = getHighResolutionTime();
        const tickStartedAt = now;
        const tickIntervalMs = now - previousTime;
        const phaseDurations = {};
        const deltaTime = Math.min((now - previousTime) / 1000, config.loop.maxDeltaTime);
        const catchCombatFrame = createCatchCombatFrame(Date.now());
        const gameplayContext = {
            catchCombatFrame,
            io,
            onRoomPopulationChanged: lifecycle.onRoomPopulationChanged,
            roomCode,
            runtimeConfig
        };
        let botDiagnostics = null;
        let trailDiagnostics = null;
        previousTime = now;
        tick++;

        measurePhase(phaseDurations, "bots", () => {
            if (botManager) {
                botDiagnostics = botManager.update(Date.now());
            }
        });

        measurePhase(phaseDurations, "movement", () => {
            updatePlayers(players, deltaTime, runtimeConfig);
        });

        measurePhase(phaseDurations, "trails", () => {
            trailDiagnostics = updateTrails(players, territories, gameplayContext);
        });

        const result = measurePhase(phaseDurations, "numbers", () => (
            numberSystem
                ? numberSystem.update(Date.now())
                : { collisions: [], themeChanged: false }
        ));
        const collisions = Array.isArray(result && result.collisions) ? result.collisions : [];
        const numberCollectionEvents = [];

        measurePhase(phaseDurations, "numberEvents", () => {
            if (collisions.length <= 0) {
                return;
            }

            for (const col of collisions) {
                measurePhase(phaseDurations, "numberCollected", () => {
                    handleNumberCollected(players, territories, col, {
                        ...gameplayContext
                    });
                }, true);
                numberCollectionEvents.push(col);
            }
        });

        measurePhase(phaseDurations, "catchCombat", () => {
            resolveCatchCombatFrame(players, territories, gameplayContext);
        });

        measurePhase(phaseDurations, "numberNotifications", () => {
            if (!io) {
                return;
            }

            for (const col of numberCollectionEvents) {
                const socket = io.sockets.sockets.get(col.playerId);

                if (!socket) {
                    continue;
                }

                const player = players.get(col.playerId);

                socket.emit("numberCollected", {
                    display: col.display,
                    value: col.value,
                    sets: col.sets,
                    belongsToTheme: col.belongsToTheme,
                    catchBalance: player ? player.catchBalance : 0,
                    eliminations: player ? player.eliminations : 0,
                    lives: player ? player.lives : 0,
                    maxLives: player ? player.maxLives : 0
                });
            }
        });

        measurePhase(phaseDurations, "themeEvents", () => {
            if (result && result.themeChanged && io && roomCode) {
                io.to(roomCode).emit("themeChanged");
            }
        });

        updateGameLoopDiagnostics(diagnostics, {
            collisionCount: collisions.length,
            botDiagnostics,
            deltaTimeMs: deltaTime * 1000,
            expectedIntervalMs: intervalMs,
            numberCount: getNumberCount(numberSystem),
            phaseDurations,
            playerCount: players.size,
            roomCode,
            territoryCount: territories.size,
            themeChanged: Boolean(result && result.themeChanged),
            tick,
            tickDurationMs: getHighResolutionTime() - tickStartedAt,
            tickDriftMs: tickIntervalMs - intervalMs,
            tickIntervalMs,
            trailDiagnostics
        });
    }, intervalMs);
}

function initializeGameLoopDiagnostics(diagnostics, expectedIntervalMs) {
    if (!diagnostics) {
        return;
    }

    diagnostics.schema = 1;
    diagnostics.expectedIntervalMs = expectedIntervalMs;
    diagnostics.tick = 0;
    diagnostics.tickIntervalMs = null;
    diagnostics.tickDriftMs = null;
    diagnostics.tickDurationMs = null;
    diagnostics.phases = {};
    diagnostics.slowestPhase = null;
}

function updateGameLoopDiagnostics(diagnostics, sample) {
    if (!diagnostics) {
        return;
    }

    diagnostics.schema = 1;
    diagnostics.updatedAt = Date.now();
    diagnostics.roomCode = sample.roomCode;
    diagnostics.tick = sample.tick;
    diagnostics.expectedIntervalMs = sample.expectedIntervalMs;
    diagnostics.tickIntervalMs = sample.tickIntervalMs;
    diagnostics.tickDriftMs = sample.tickDriftMs;
    diagnostics.tickDurationMs = sample.tickDurationMs;
    diagnostics.deltaTimeMs = sample.deltaTimeMs;
    diagnostics.playerCount = sample.playerCount;
    diagnostics.territoryCount = sample.territoryCount;
    diagnostics.numberCount = sample.numberCount;
    diagnostics.collisionCount = sample.collisionCount;
    diagnostics.bot = normalizeBotDiagnostics(sample.botDiagnostics);
    diagnostics.trails = normalizeTrailDiagnostics(sample.trailDiagnostics);
    diagnostics.themeChanged = sample.themeChanged;
    diagnostics.phases = roundPhaseDurations(sample.phaseDurations);
    diagnostics.slowestPhase = getSlowestPhase(diagnostics.phases);
}

function normalizeTrailDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    return {
        activeTrailPlayers: finiteOrNull(diagnostics.activeTrailPlayers),
        captureApply: normalizeCaptureApplyDiagnostics(diagnostics.captureApply),
        captureAttempts: finiteOrNull(diagnostics.captureAttempts),
        captureChangedPlayerCount: finiteOrNull(diagnostics.captureChangedPlayerCount),
        captureOperationReplayAccepted: finiteOrNull(diagnostics.captureOperationReplayAccepted),
        captureOperationReplayAreaMismatch: finiteOrNull(diagnostics.captureOperationReplayAreaMismatch),
        captureOperationReplayInvalid: finiteOrNull(diagnostics.captureOperationReplayInvalid),
        captureOperationReplayRejected: finiteOrNull(diagnostics.captureOperationReplayRejected),
        captures: finiteOrNull(diagnostics.captures),
        clearTrailCount: finiteOrNull(diagnostics.clearTrailCount),
        closedTrailReturns: finiteOrNull(diagnostics.closedTrailReturns),
        fillPathCount: finiteOrNull(diagnostics.fillPathCount),
        fillPolygonCount: finiteOrNull(diagnostics.fillPolygonCount),
        ownerTrailBlockBoundsRejected: finiteOrNull(diagnostics.ownerTrailBlockBoundsRejected),
        ownerTrailBlockChecks: finiteOrNull(diagnostics.ownerTrailBlockChecks),
        ownerTrailBoundsRejected: finiteOrNull(diagnostics.ownerTrailBoundsRejected),
        ownerTrailPrimitiveCandidates: finiteOrNull(diagnostics.ownerTrailPrimitiveCandidates),
        ownerTrailPrimitiveTests: finiteOrNull(diagnostics.ownerTrailPrimitiveTests),
        ownerTrailSegmentChecks: finiteOrNull(diagnostics.ownerTrailSegmentChecks),
        pathPrimitiveBlockCount: finiteOrNull(diagnostics.pathPrimitiveBlockCount),
        pathPrimitiveCacheHits: finiteOrNull(diagnostics.pathPrimitiveCacheHits),
        pathPrimitiveCacheMisses: finiteOrNull(diagnostics.pathPrimitiveCacheMisses),
        pathPrimitiveCount: finiteOrNull(diagnostics.pathPrimitiveCount),
        pathPrimitiveInputPointCount: finiteOrNull(diagnostics.pathPrimitiveInputPointCount),
        phases: normalizePhaseDurations(diagnostics.phases),
        playersProcessed: finiteOrNull(diagnostics.playersProcessed),
        selfCollisionTests: finiteOrNull(diagnostics.selfCollisionTests),
        selfCollisions: finiteOrNull(diagnostics.selfCollisions),
        selfPathPrimitiveBlockCount: finiteOrNull(diagnostics.selfPathPrimitiveBlockCount),
        selfPathPrimitiveCacheHits: finiteOrNull(diagnostics.selfPathPrimitiveCacheHits),
        selfPathPrimitiveCacheMisses: finiteOrNull(diagnostics.selfPathPrimitiveCacheMisses),
        selfPathPrimitiveCount: finiteOrNull(diagnostics.selfPathPrimitiveCount),
        selfPathPrimitiveInputPointCount: finiteOrNull(diagnostics.selfPathPrimitiveInputPointCount),
        selfTrailBlockBoundsRejected: finiteOrNull(diagnostics.selfTrailBlockBoundsRejected),
        selfTrailBlockChecks: finiteOrNull(diagnostics.selfTrailBlockChecks),
        selfTrailBoundsRejected: finiteOrNull(diagnostics.selfTrailBoundsRejected),
        selfTrailPrimitiveCandidates: finiteOrNull(diagnostics.selfTrailPrimitiveCandidates),
        selfTrailPrimitiveTests: finiteOrNull(diagnostics.selfTrailPrimitiveTests),
        selfTrailSegmentChecks: finiteOrNull(diagnostics.selfTrailSegmentChecks),
        slowestPhase: normalizeSlowestPhase(diagnostics.slowestPhase),
        trailOwnerChecks: finiteOrNull(diagnostics.trailOwnerChecks),
        trailOwnerHits: finiteOrNull(diagnostics.trailOwnerHits)
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
        postCaptureOverlapBoundsRejectedCount: finiteOrNull(diagnostics.postCaptureOverlapBoundsRejectedCount),
        postCaptureOverlapCheckCount: finiteOrNull(diagnostics.postCaptureOverlapCheckCount),
        postCaptureOverlapCount: finiteOrNull(diagnostics.postCaptureOverlapCount),
        postCaptureOverlapFirst: normalizePostCaptureOverlap(diagnostics.postCaptureOverlapFirst),
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
        subjectPointCount: finiteOrNull(detail.subjectPointCount),
        usedSimplified: Boolean(detail.usedSimplified)
    };
}

function normalizeBotDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    return {
        cycle: finiteOrNull(diagnostics.cycle),
        decisionsProcessed: finiteOrNull(diagnostics.decisionsProcessed),
        pendingAfter: finiteOrNull(diagnostics.pendingAfter),
        pendingBefore: finiteOrNull(diagnostics.pendingBefore),
        phases: normalizePhaseDurations(diagnostics.phases),
        selfTrailSafety: normalizeSelfTrailSafetyDiagnostics(diagnostics.selfTrailSafety),
        slowestPhase: normalizeSlowestPhase(diagnostics.slowestPhase)
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

function normalizePhaseDurations(phases) {
    const normalized = {};

    for (const [name, durationMs] of Object.entries(phases || {})) {
        normalized[name] = finiteOrNull(durationMs);
    }

    return normalized;
}

function normalizeSlowestPhase(slowestPhase) {
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

function measurePhase(phaseDurations, name, callback, accumulate = false) {
    const startedAt = getHighResolutionTime();

    try {
        return callback();
    } finally {
        const durationMs = getHighResolutionTime() - startedAt;
        phaseDurations[name] = accumulate
            ? (phaseDurations[name] || 0) + durationMs
            : durationMs;
    }
}

function roundPhaseDurations(phaseDurations) {
    const rounded = {};

    for (const [name, durationMs] of Object.entries(phaseDurations || {})) {
        rounded[name] = roundToMilliseconds(durationMs);
    }

    return rounded;
}

function getSlowestPhase(phaseDurations) {
    let slowest = null;

    for (const [name, durationMs] of Object.entries(phaseDurations || {})) {
        if (!Number.isFinite(durationMs)) {
            continue;
        }

        if (!slowest || durationMs > slowest.durationMs) {
            slowest = {
                name,
                durationMs
            };
        }
    }

    return slowest;
}

function getNumberCount(numberSystem) {
    if (!numberSystem || typeof numberSystem.getNumbersMap !== "function") {
        return null;
    }

    const numbers = numberSystem.getNumbersMap();

    return numbers && typeof numbers.size === "number" ? numbers.size : null;
}

function roundToMilliseconds(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

module.exports = { startGameLoop };
