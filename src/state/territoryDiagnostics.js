const { getHighResolutionTime } = require("../utils/time");

function getCaptureApplyDiagnostics(options) {
    return options && options.diagnostics || null;
}

function getCaptureApplyMetrics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    if (!diagnostics.captureApply || typeof diagnostics.captureApply !== "object") {
        diagnostics.captureApply = createCaptureApplyMetrics();
    }

    return ensureCaptureApplyMetrics(diagnostics.captureApply);
}

function createCaptureApplyMetrics() {
    return {
        boundsOverlapCount: 0,
        boundsRejectedCount: 0,
        calls: 0,
        candidateCount: 0,
        changedTerritoryCount: 0,
        emptyCapturedBoundsCount: 0,
        maxCapturedArea: 0,
        maxCapturedBoundsArea: 0,
        maxCapturedPointCount: 0,
        maxOwnerArea: 0,
        maxOwnerPointCount: 0,
        maxTerritoryCount: 0,
        missingOwnerTerritoryCount: 0,
        overlapCount: 0,
        overlapRejectedCount: 0,
        operationSimplifyAttemptCount: 0,
        operationSimplifyCacheHitCount: 0,
        operationSimplifyCapturedCount: 0,
        operationSimplifyHitCount: 0,
        operationSimplifyInputPointCount: 0,
        operationSimplifyMaxAreaDrift: 0,
        operationSimplifyMaxAreaDriftRatio: 0,
        operationSimplifyOutputPointCount: 0,
        operationSimplifySubjectCount: 0,
        operationSubtractFallbackCount: 0,
        operationSubtractMaxResidualOverlapArea: 0,
        operationSubtractValidationCount: 0,
        operationSubtractValidationRejectedCount: 0,
        overlapRepairQueueBudgetHitCount: 0,
        overlapRepairQueueChangedCount: 0,
        overlapRepairQueuePendingCount: 0,
        overlapRepairQueueProcessedCount: 0,
        overlapRepairQueueQueuedCount: 0,
        overlapRepairWorkerBackpressureCount: 0,
        overlapRepairWorkerChangedCount: 0,
        overlapRepairWorkerCompletedCount: 0,
        overlapRepairWorkerComputeMs: 0,
        overlapRepairWorkerDispatchedCount: 0,
        overlapRepairWorkerFailedCount: 0,
        overlapRepairWorkerInFlightCount: 0,
        overlapRepairWorkerIntersectionMs: 0,
        overlapRepairWorkerLatencyMs: 0,
        overlapRepairWorkerNoChangeCount: 0,
        overlapRepairWorkerStaleCount: 0,
        overlapRepairWorkerSubtractMs: 0,
        ownerChangedCount: 0,
        postCaptureOverlapBoundsRejectedCount: 0,
        postCaptureOverlapCheckCount: 0,
        postCaptureOverlapCount: 0,
        postCaptureOverlapFirst: null,
        postCaptureOverlapRepairChangedCount: 0,
        postCaptureOverlapRepairCount: 0,
        slowestOverlap: null,
        slowestSubtract: null,
        subtractChangedCount: 0,
        subtractCount: 0,
        subtractOperationClippingPointCount: 0,
        subtractOperationPointCount: 0,
        subtractPointCount: 0,
        subtractResultPointCount: 0
    };
}

function ensureCaptureApplyMetrics(metrics) {
    const defaults = createCaptureApplyMetrics();

    for (const [name, value] of Object.entries(defaults)) {
        if (!(name in metrics)) {
            metrics[name] = value;
        }
    }

    return metrics;
}

function measureCaptureApplyPhase(diagnostics, name, callback) {
    if (!diagnostics || !diagnostics.phases) {
        return callback();
    }

    const startedAt = getHighResolutionTime();

    try {
        return callback();
    } finally {
        const durationMs = getHighResolutionTime() - startedAt;
        diagnostics.phases[name] = (diagnostics.phases[name] || 0) + durationMs;
    }
}

function measureCaptureApplyOperation(diagnostics, name, callback) {
    if (!diagnostics || !diagnostics.phases) {
        return {
            durationMs: null,
            value: callback()
        };
    }

    const startedAt = getHighResolutionTime();

    try {
        const value = callback();
        const durationMs = getHighResolutionTime() - startedAt;
        diagnostics.phases[name] = (diagnostics.phases[name] || 0) + durationMs;
        return { durationMs, value };
    } catch (error) {
        const durationMs = getHighResolutionTime() - startedAt;
        diagnostics.phases[name] = (diagnostics.phases[name] || 0) + durationMs;
        throw error;
    }
}

function addCaptureApplyCount(metrics, name, value) {
    if (metrics && Number.isFinite(value) && value > 0) {
        metrics[name] = (metrics[name] || 0) + value;
    }
}

function recordCaptureApplyMax(metrics, name, value) {
    if (metrics && Number.isFinite(value)) {
        metrics[name] = Math.max(metrics[name] || 0, value);
    }
}

function recordSlowestCaptureApplyOverlap(metrics, detail) {
    if (!metrics || !Number.isFinite(detail.durationMs)) {
        return;
    }

    const durationMs = roundToMilliseconds(detail.durationMs);

    if (metrics.slowestOverlap && metrics.slowestOverlap.durationMs >= durationMs) {
        return;
    }

    metrics.slowestOverlap = {
        durationMs,
        hit: Boolean(detail.hit),
        playerId: detail.playerId,
        subjectPointCount: detail.subjectPointCount
    };
}

function recordSlowestCaptureApplySubtract(metrics, detail) {
    if (!metrics || !Number.isFinite(detail.durationMs)) {
        return;
    }

    const durationMs = roundToMilliseconds(detail.durationMs);

    if (metrics.slowestSubtract && metrics.slowestSubtract.durationMs >= durationMs) {
        return;
    }

    metrics.slowestSubtract = {
        changed: Boolean(detail.changed),
        clippingPointCount: detail.clippingPointCount,
        durationMs,
        operationClippingPointCount: detail.operationClippingPointCount,
        operationResultArea: roundToMilliseconds(detail.operationResultArea),
        operationSubjectArea: roundToMilliseconds(detail.operationSubjectArea),
        operationSubjectPointCount: detail.operationSubjectPointCount,
        playerId: detail.playerId,
        resultArea: roundToMilliseconds(detail.resultArea),
        resultPointCount: detail.resultPointCount,
        subjectArea: roundToMilliseconds(detail.subjectArea),
        subjectPointCount: detail.subjectPointCount,
        usedFallback: Boolean(detail.usedFallback),
        usedSimplified: Boolean(detail.usedSimplified)
    };
}

function roundToMilliseconds(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

module.exports = {
    addCaptureApplyCount,
    getCaptureApplyDiagnostics,
    getCaptureApplyMetrics,
    measureCaptureApplyOperation,
    measureCaptureApplyPhase,
    recordCaptureApplyMax,
    recordSlowestCaptureApplyOverlap,
    recordSlowestCaptureApplySubtract,
    roundToMilliseconds
};
