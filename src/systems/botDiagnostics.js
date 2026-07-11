const config = require("../config/gameConfig");
const { getHighResolutionTime } = require("../utils/time");

function createEmptyBotDiagnostics() {
    return {
        cycle: 0,
        decisionsProcessed: 0,
        pendingAfter: 0,
        pendingBefore: 0,
        phases: {},
        selfTrailSafety: createEmptySelfTrailSafetyDiagnostics(),
        targeting: createEmptyBotTargetingDiagnostics(),
        slowestPhase: null
    };
}

function createBotUpdateDiagnostics(state) {
    return {
        cycle: state.decisionCycle,
        decisionsProcessed: 0,
        pendingAfter: 0,
        pendingBefore: 0,
        phases: {},
        selfTrailSafety: createEmptySelfTrailSafetyDiagnostics(),
        targeting: createEmptyBotTargetingDiagnostics(),
        slowestPhase: null
    };
}

function createEmptyBotTargetingDiagnostics() {
    return {
        balanceCandidateCount: 0,
        balanceEnemyEvaluations: 0,
        coordinatedNumberCacheHitCount: 0,
        coordinatedNumberCacheMissCount: 0,
        huntCandidateCount: 0,
        huntEnemyEvaluations: 0,
        returnTargetCacheHitCount: 0,
        returnTargetCacheMissCount: 0,
        trailBlockBoundsRejected: 0,
        trailBlockChecks: 0,
        trailIndexCacheHitCount: 0,
        trailIndexCacheMissCount: 0,
        trailPointChecks: 0,
        trailPointDistanceRejected: 0,
        trailPointTerritoryRejected: 0
    };
}

function createEmptySelfTrailSafetyDiagnostics() {
    return {
        budgetHitCount: 0,
        bypassCount: 0,
        candidateCount: 0,
        coarseEvaluationCount: 0,
        earlyExitCount: 0,
        decisionCount: 0,
        evaluatedCandidateCount: 0,
        evaluatedLocalCandidateCount: 0,
        fullEvaluationCount: 0,
        filteredTrailPointCount: 0,
        filteredTrailSegmentCount: 0,
        localCandidateCount: 0,
        maxBudgetElapsedMs: 0,
        pathEvaluationCount: 0,
        pointBlockBoundsRejected: 0,
        pointBlockChecks: 0,
        pointBlockCount: 0,
        pointDistanceCheckCount: 0,
        sampleCount: 0,
        safetyCacheHitCount: 0,
        safetyCacheMissCount: 0,
        selectedRefineCandidateCount: 0,
        segmentBlockBoundsRejected: 0,
        segmentBlockChecks: 0,
        segmentBlockCount: 0,
        segmentBoundsRejected: 0,
        segmentCrossCheckCount: 0,
        trailPointCount: 0,
        trailSegmentCount: 0,
        unsafeTargetCount: 0
    };
}

function measureBotPhase(diagnostics, name, callback) {
    const startedAt = getHighResolutionTime();

    try {
        return callback();
    } finally {
        const durationMs = getHighResolutionTime() - startedAt;

        if (diagnostics && diagnostics.phases) {
            diagnostics.phases[name] = (diagnostics.phases[name] || 0) + durationMs;
        }
    }
}

function getSlowestBotPhase(phases) {
    let slowestPhase = null;

    for (const [name, durationMs] of Object.entries(phases || {})) {
        if (!Number.isFinite(durationMs)) {
            continue;
        }

        if (!slowestPhase || durationMs > slowestPhase.durationMs) {
            slowestPhase = {
                name,
                durationMs: roundToMilliseconds(durationMs)
            };
        }
    }

    return slowestPhase;
}

function getMaxBotDecisionsPerTick() {
    const value = Number(config.bots.maxDecisionsPerTick);

    return Number.isInteger(value) && value > 0 ? value : 2;
}

function getBotTargetingDiagnostics(context) {
    const diagnostics = context && context.diagnostics;

    if (!diagnostics) {
        return null;
    }

    if (!diagnostics.targeting) {
        diagnostics.targeting = createEmptyBotTargetingDiagnostics();
    }

    return diagnostics.targeting;
}

function addBotTargetingDiagnosticValue(context, name, value) {
    if (!Number.isFinite(value) || value <= 0) {
        return;
    }

    const diagnostics = getBotTargetingDiagnostics(context);

    if (!diagnostics) {
        return;
    }

    diagnostics[name] = (diagnostics[name] || 0) + value;
}

function getBotSelfTrailSafetyBudgetMs() {
    const value = Number(config.bots.selfTrailSafetyBudgetMs);

    return Number.isFinite(value) && value > 0 ? value : 4;
}

function getBotSelfTrailSafetyMaxCandidates() {
    const value = Number(config.bots.selfTrailSafetyMaxCandidates);

    return Number.isInteger(value) && value > 0 ? value : 24;
}

function getBotSelfTrailSafetyTrapMaxCandidates() {
    const value = Number(config.bots.selfTrailSafetyTrapMaxCandidates);

    return Number.isInteger(value) && value > 0 ? value : Math.max(36, getBotSelfTrailSafetyMaxCandidates());
}

function getBotSelfTrailSafetyMaxLocalCandidates() {
    const value = Number(config.bots.selfTrailSafetyMaxLocalCandidates);

    return Number.isInteger(value) && value > 0 ? value : 8;
}

function getBotSelfTrailSafetyRefineCandidates(trapMode = false) {
    const value = Number(
        trapMode
            ? config.bots.selfTrailSafetyTrapRefineCandidates
            : config.bots.selfTrailSafetyRefineCandidates
    );

    return Number.isInteger(value) && value > 0
        ? value
        : trapMode
            ? 8
            : 6;
}

function getBotSelfTrailSafetyCoarseLookaheadRatio() {
    const value = Number(config.bots.selfTrailSafetyCoarseLookaheadRatio);

    return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.6;
}

function getBotSelfTrailSafetyCriticalClearance() {
    const value = Number(config.bots.selfTrailSafetyCriticalClearanceRatio);
    const ratio = Number.isFinite(value) && value > 0 ? value : 0.72;

    return config.bots.selfTrailAvoidDistance * ratio;
}

function getBotSelfTrailSafetyBlockSize() {
    const value = Number(config.bots.selfTrailSafetyBlockSize);

    return Number.isInteger(value) && value > 0
        ? value
        : Math.max(8, Number(config.territory.trailSpatialBlockPrimitiveCount) || 48);
}

function getBotSelfTrailLookaheadMaxDistance() {
    const value = Number(config.bots.selfTrailLookaheadMaxDistance);

    return Number.isFinite(value) && value > 0 ? value : config.world.playerSize * 12;
}

function getBotSelfTrailTrapLookaheadMaxDistance() {
    const value = Number(config.bots.selfTrailTrapLookaheadMaxDistance);

    return Number.isFinite(value) && value > 0
        ? value
        : Math.max(getBotSelfTrailLookaheadMaxDistance(), config.world.playerSize * 20);
}

function getBotSelfTrailEscapeMemoryMs() {
    const value = Number(config.bots.selfTrailEscapeMemoryMs);

    return Number.isFinite(value) && value > 0 ? value : 650;
}

function getSelfTrailSafetyDiagnostics(context) {
    const diagnostics = context && context.diagnostics;

    if (!diagnostics) {
        return null;
    }

    if (!diagnostics.selfTrailSafety) {
        diagnostics.selfTrailSafety = createEmptySelfTrailSafetyDiagnostics();
    }

    return diagnostics.selfTrailSafety;
}

function addSelfTrailSafetyDiagnosticValue(diagnostics, name, value) {
    if (!diagnostics || !Number.isFinite(value) || value <= 0) {
        return;
    }

    diagnostics[name] = (diagnostics[name] || 0) + value;
}

function recordSelfTrailSafetyBudgetElapsed(diagnostics, elapsedMs) {
    if (!diagnostics || !Number.isFinite(elapsedMs)) {
        return;
    }

    diagnostics.maxBudgetElapsedMs = Math.max(
        diagnostics.maxBudgetElapsedMs || 0,
        roundToMilliseconds(elapsedMs)
    );
}

function createSelfTrailSafetyBudget(diagnostics) {
    return {
        budgetHit: false,
        budgetMs: getBotSelfTrailSafetyBudgetMs(),
        diagnostics,
        startedAt: getHighResolutionTime()
    };
}

function hasSelfTrailSafetyBudgetRemaining(budget) {
    if (!budget || !Number.isFinite(budget.budgetMs) || budget.budgetMs <= 0) {
        return true;
    }

    const elapsedMs = getHighResolutionTime() - budget.startedAt;
    recordSelfTrailSafetyBudgetElapsed(budget.diagnostics, elapsedMs);

    if (elapsedMs <= budget.budgetMs) {
        return true;
    }

    markSelfTrailSafetyBudgetHit(budget);
    return false;
}

function finishSelfTrailSafetyBudget(budget) {
    if (!budget || !Number.isFinite(budget.startedAt)) {
        return;
    }

    const elapsedMs = getHighResolutionTime() - budget.startedAt;
    recordSelfTrailSafetyBudgetElapsed(budget.diagnostics, elapsedMs);

    if (Number.isFinite(budget.budgetMs) && elapsedMs > budget.budgetMs) {
        markSelfTrailSafetyBudgetHit(budget);
    }
}

function markSelfTrailSafetyBudgetHit(budget) {
    if (!budget || budget.budgetHit) {
        return;
    }

    budget.budgetHit = true;
    addSelfTrailSafetyDiagnosticValue(budget.diagnostics, "budgetHitCount", 1);
}

function roundToMilliseconds(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

module.exports = {
    addBotTargetingDiagnosticValue,
    addSelfTrailSafetyDiagnosticValue,
    createBotUpdateDiagnostics,
    createEmptyBotDiagnostics,
    createSelfTrailSafetyBudget,
    finishSelfTrailSafetyBudget,
    getBotSelfTrailEscapeMemoryMs,
    getBotSelfTrailLookaheadMaxDistance,
    getBotSelfTrailSafetyBlockSize,
    getBotSelfTrailSafetyCoarseLookaheadRatio,
    getBotSelfTrailSafetyCriticalClearance,
    getBotSelfTrailSafetyMaxCandidates,
    getBotSelfTrailSafetyMaxLocalCandidates,
    getBotSelfTrailSafetyRefineCandidates,
    getBotSelfTrailSafetyTrapMaxCandidates,
    getBotSelfTrailTrapLookaheadMaxDistance,
    getMaxBotDecisionsPerTick,
    getSelfTrailSafetyDiagnostics,
    getSlowestBotPhase,
    hasSelfTrailSafetyBudgetRemaining,
    measureBotPhase
};
