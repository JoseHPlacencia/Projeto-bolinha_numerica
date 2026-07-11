const config = require("../config/gameConfig");
const {
    calculatePolygonArea,
    calculatePolygonIntersectionArea,
    createOperationalPolygon,
    getPolygonPointCount,
    subtractPolygonComponents,
    unionPolygons
} = require("../utils/geometry");
const { selectRetainedTerritoryPolygon } = require("./territoryRetention");
const {
    addCaptureApplyCount,
    measureCaptureApplyOperation,
    measureCaptureApplyPhase,
    recordCaptureApplyMax
} = require("./territoryDiagnostics");

const territoryChangeAreaEpsilon = 1;
const operationSimplifyMaxAreaDrift = config.world.playerSize * config.world.playerSize;
const territoryOperationPolygonCaches = new WeakMap();

/**
 * Boolean territory operations and their version-scoped simplification cache.
 *
 * This module returns polygons and metrics but never mutates authoritative
 * territory state or increments territory versions.
 */

function getOwnerCapturedPolygon(currentPolygon, capturedPolygon, operationPolygon) {
    return calculatePolygonArea(operationPolygon) > 0
        ? operationPolygon
        : unionPolygons(currentPolygon, capturedPolygon);
}

function subtractTerritoryPolygon(
    subjectTerritory,
    clippingPolygon,
    clippingOperation,
    subjectPlayer,
    options = {}
) {
    const diagnostics = options.diagnostics;
    const metrics = options.metrics;
    const phasePrefix = options.phasePrefix || "territoryOperation";
    const subjectPolygon = subjectTerritory && subjectTerritory.polygon || [];
    const subjectArea = getTerritoryArea(subjectTerritory);
    const subjectOperation = options.subjectOperation || getTerritoryOperationPolygon(
        subjectTerritory,
        metrics,
        diagnostics,
        options.subjectKind || "subject",
        `${phasePrefix}SimplifySubject`
    );
    const safeClippingOperation = clippingOperation || createIdentityOperationPolygon(
        clippingPolygon,
        getPolygonPointCount(clippingPolygon)
    );
    const operationSubjectArea = calculatePolygonArea(subjectOperation.polygon);
    const operationSubtract = measureCaptureApplyOperation(
        diagnostics,
        `${phasePrefix}Subtract`,
        () => subtractPolygonComponents(subjectOperation.polygon, safeClippingOperation.polygon)
    );
    let retainedPolygon = selectRetainedTerritoryPolygon(operationSubtract.value, subjectPlayer);
    let operationResultArea = calculatePolygonArea(retainedPolygon);
    const attemptedSimplified = subjectOperation.simplified || safeClippingOperation.simplified;
    const simplifyAreaDrift = getOperationSubtractAreaDrift(
        subjectOperation,
        safeClippingOperation
    );
    let usedFallback = false;
    let noOverlap = false;

    if (attemptedSimplified) {
        addCaptureApplyCount(metrics, "operationSubtractValidationCount", 1);
        const validation = measureCaptureApplyPhase(
            diagnostics,
            `${phasePrefix}SubtractValidation`,
            () => validateOperationalSubtract(
                subjectPolygon,
                clippingPolygon,
                retainedPolygon,
                {
                    diagnostics,
                    phasePrefix,
                    simplifyAreaDrift,
                    subjectArea
                }
            )
        );

        recordCaptureApplyMax(
            metrics,
            "operationSubtractMaxResidualOverlapArea",
            validation.residualOverlapArea
        );

        if (validation.noOverlap) {
            retainedPolygon = subjectPolygon;
            operationResultArea = subjectArea;
            noOverlap = true;
        } else if (!validation.valid) {
            addCaptureApplyCount(metrics, "operationSubtractValidationRejectedCount", 1);
            addCaptureApplyCount(metrics, "operationSubtractFallbackCount", 1);
            usedFallback = true;
            retainedPolygon = measureCaptureApplyPhase(
                diagnostics,
                `${phasePrefix}SubtractFallback`,
                () => selectRetainedTerritoryPolygon(
                    subtractPolygonComponents(subjectPolygon, clippingPolygon),
                    subjectPlayer
                )
            );
            operationResultArea = calculatePolygonArea(retainedPolygon);
        }
    }

    return {
        noOverlap,
        operationResultArea,
        operationSubjectArea: usedFallback || noOverlap
            ? subjectArea
            : operationSubjectArea,
        removedArea: Math.max(0, subjectArea - operationResultArea),
        retainedPolygon,
        usedFallback,
        usedSimplified: attemptedSimplified && !usedFallback && !noOverlap
    };
}

function validateOperationalSubtract(
    subjectPolygon,
    clippingPolygon,
    retainedPolygon,
    options = {}
) {
    const subjectArea = Number.isFinite(options.subjectArea)
        ? options.subjectArea
        : calculatePolygonArea(subjectPolygon);
    const retainedArea = calculatePolygonArea(retainedPolygon);
    const removedArea = Math.max(0, subjectArea - retainedArea);

    if (retainedArea > subjectArea + territoryChangeAreaEpsilon) {
        return {
            noOverlap: false,
            residualOverlapArea: 0,
            valid: false
        };
    }

    if (retainedArea <= territoryChangeAreaEpsilon) {
        const exactOverlapArea = measureCaptureApplyPhase(
            options.diagnostics,
            `${options.phasePrefix}SubtractAmbiguousIntersection`,
            () => calculatePolygonIntersectionArea(subjectPolygon, clippingPolygon)
        );

        return {
            noOverlap: exactOverlapArea <= territoryChangeAreaEpsilon,
            residualOverlapArea: 0,
            valid: subjectArea - exactOverlapArea <= territoryChangeAreaEpsilon
        };
    }

    const residualOverlapArea = measureCaptureApplyPhase(
        options.diagnostics,
        `${options.phasePrefix}SubtractResidualIntersection`,
        () => calculatePolygonIntersectionArea(retainedPolygon, clippingPolygon)
    );

    if (residualOverlapArea > territoryChangeAreaEpsilon) {
        return {
            noOverlap: false,
            residualOverlapArea,
            valid: false
        };
    }

    const ambiguousAreaThreshold = Math.max(
        territoryChangeAreaEpsilon,
        Number(options.simplifyAreaDrift) || 0
    );

    if (removedArea <= ambiguousAreaThreshold) {
        const exactOverlapArea = measureCaptureApplyPhase(
            options.diagnostics,
            `${options.phasePrefix}SubtractAmbiguousIntersection`,
            () => calculatePolygonIntersectionArea(subjectPolygon, clippingPolygon)
        );

        if (exactOverlapArea <= territoryChangeAreaEpsilon) {
            return {
                noOverlap: true,
                residualOverlapArea,
                valid: true
            };
        }
    }

    return {
        noOverlap: false,
        residualOverlapArea,
        valid: true
    };
}

function getOperationSubtractAreaDrift(subjectOperation, clippingOperation) {
    return [subjectOperation, clippingOperation].reduce((sum, operation) => (
        sum + (Number.isFinite(operation && operation.areaDrift)
            ? Math.max(0, operation.areaDrift)
            : 0)
    ), 0);
}

function getTerritoryOperationPolygon(
    territory,
    metrics,
    diagnostics,
    kind = "subject",
    phaseName = "captureApplySimplifySubject"
) {
    const polygon = territory && territory.polygon || [];
    const pointCount = getPolygonPointCount(polygon);
    const options = createOperationSimplifyOptions(kind);

    if (pointCount < options.minInputPointCount) {
        return createIdentityOperationPolygon(polygon, pointCount);
    }

    const settingsKey = createOperationSimplifyKey(options);
    const cache = getTerritoryOperationPolygonCache(territory);
    const cachedOperation = cache && cache.entries.get(settingsKey);

    if (cachedOperation) {
        const cached = {
            ...cachedOperation.stats,
            cacheHit: true,
            polygon: cachedOperation.polygon
        };

        recordOperationSimplifyUse(metrics, kind, cached);
        return cached;
    }

    const operation = measureCaptureApplyPhase(diagnostics, phaseName, () => (
        createOperationalPolygon(polygon, options)
    ));
    const result = {
        ...operation,
        attempted: true,
        cacheHit: false
    };

    if (cache) {
        cache.entries.set(settingsKey, {
            polygon: result.polygon,
            stats: createOperationPolygonStats(result)
        });
    }
    recordOperationSimplifyUse(metrics, kind, result);

    return result;
}

function getCapturedOperationPolygon(capturedPolygon, metrics, diagnostics) {
    const pointCount = getPolygonPointCount(capturedPolygon);
    const options = createOperationSimplifyOptions("clipping");

    if (pointCount < options.minInputPointCount) {
        return createIdentityOperationPolygon(capturedPolygon, pointCount);
    }

    const operation = measureCaptureApplyPhase(diagnostics, "captureApplySimplifyCaptured", () => (
        createOperationalPolygon(capturedPolygon, options)
    ));
    const result = {
        ...operation,
        attempted: true,
        cacheHit: false
    };

    recordOperationSimplifyUse(metrics, "clipping", result);

    return result;
}

function getTerritoryOperationPolygonCache(territory) {
    if (!territory || typeof territory !== "object") {
        return null;
    }

    const version = territory.version || 0;
    let cache = territoryOperationPolygonCaches.get(territory);

    if (!cache || cache.version !== version) {
        cache = {
            entries: new Map(),
            version
        };
        territoryOperationPolygonCaches.set(territory, cache);
    }

    return cache;
}

function createOperationSimplifyOptions(kind) {
    const territoryConfig = config.territory;
    const isClipping = kind === "clipping";

    return {
        maxAreaDrift: operationSimplifyMaxAreaDrift,
        maxAreaDriftRatio: territoryConfig.operationSimplifyMaxAreaDriftRatio,
        minInputPointCount: isClipping
            ? territoryConfig.operationSimplifyClippingMinPoints
            : territoryConfig.operationSimplifySubjectMinPoints,
        minPointCount: territoryConfig.operationSimplifyMinPoints,
        minTolerance: territoryConfig.operationSimplifyMinTolerance,
        targetPointCount: isClipping
            ? territoryConfig.operationSimplifyClippingTargetPoints
            : territoryConfig.operationSimplifySubjectTargetPoints,
        tolerance: territoryConfig.operationSimplifyTolerance
    };
}

function createOperationSimplifyKey(options) {
    return [
        options.maxAreaDrift,
        options.maxAreaDriftRatio,
        options.minInputPointCount,
        options.minPointCount,
        options.minTolerance,
        options.targetPointCount,
        options.tolerance
    ].join(":");
}

function createIdentityOperationPolygon(polygon, pointCount) {
    return {
        areaDrift: 0,
        areaDriftRatio: 0,
        attempted: false,
        cacheHit: false,
        inputPointCount: pointCount,
        outputPointCount: pointCount,
        polygon,
        simplified: false,
        tolerance: 0
    };
}

function createOperationPolygonStats(operation) {
    return {
        areaDrift: operation.areaDrift,
        areaDriftRatio: operation.areaDriftRatio,
        attempted: true,
        inputPointCount: operation.inputPointCount,
        outputPointCount: operation.outputPointCount,
        simplified: operation.simplified,
        tolerance: operation.tolerance
    };
}

function recordOperationSimplifyUse(metrics, kind, operation) {
    if (!metrics || !operation || !operation.attempted) {
        return;
    }

    addCaptureApplyCount(metrics, "operationSimplifyAttemptCount", 1);

    if (operation.cacheHit) {
        addCaptureApplyCount(metrics, "operationSimplifyCacheHitCount", 1);
    }

    if (!operation.simplified) {
        return;
    }

    addCaptureApplyCount(metrics, "operationSimplifyHitCount", 1);
    addCaptureApplyCount(metrics, "operationSimplifyInputPointCount", operation.inputPointCount);
    addCaptureApplyCount(metrics, "operationSimplifyOutputPointCount", operation.outputPointCount);
    recordCaptureApplyMax(metrics, "operationSimplifyMaxAreaDrift", operation.areaDrift);
    recordCaptureApplyMax(metrics, "operationSimplifyMaxAreaDriftRatio", operation.areaDriftRatio);

    if (kind === "clipping") {
        addCaptureApplyCount(metrics, "operationSimplifyCapturedCount", 1);
    } else {
        addCaptureApplyCount(metrics, "operationSimplifySubjectCount", 1);
    }
}


function clearTerritoryOperationPolygonCache(territory) {
    if (territory && typeof territory === "object") {
        territoryOperationPolygonCaches.delete(territory);
    }
}

function getTerritoryArea(territory) {
    return Number.isFinite(territory && territory.area)
        ? territory.area
        : calculatePolygonArea(territory && territory.polygon);
}

module.exports = {
    clearTerritoryOperationPolygonCache,
    createIdentityOperationPolygon,
    getCapturedOperationPolygon,
    getOwnerCapturedPolygon,
    getTerritoryOperationPolygon,
    subtractTerritoryPolygon
};
