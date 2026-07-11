const config = require("../config/gameConfig");
const {
    getPlayerTerritoryPolygon,
    isPointOwnedByPlayer,
    processTerritoryOverlapRepairQueue
} = require("../state/territories");
const {
    calculatePolygonArea,
    createPolygonFromPoints,
    findClosestPolygonBoundaryContact,
    findSegmentPolygonBoundaryContact,
    isPointInPolygon
} = require("../utils/geometry");
const { distanceBetween } = require("../utils/math");
const {
    createLinePrimitivesFromPoints,
    createPathPrimitiveIndex,
    createPathPrimitivesFromPoints,
    doesLineCrossPathPrimitive
} = require("../utils/pathSegments");
const { getHighResolutionTime } = require("../utils/time");
const {
    clearCatchEliminationMarksByMarker,
    clearCatchEliminationMarksForTarget,
    confirmCatchEliminationTargets,
    handlePlayerLifeLoss
} = require("./catchModeSystem");
const { captureClosedTrail } = require("./dominationSystem");
const { relocatePlayersAfterTerritoryChange } = require("./territoryRespawnSystem");

const geometryEpsilon = 1e-7;
const pathPrimitiveCache = new WeakMap();
const selfTrailLinePrimitiveCache = new WeakMap();
const trailSegmentBoundsCache = new WeakMap();

/**
 * Owns authoritative trail points and their derived line/arc indexes.
 * Generation changes and tombstones are required whenever a trail lifecycle
 * ends so delayed snapshots cannot restore stale geometry.
 */

const trailSides = Object.freeze({
    left: Object.freeze({
        activeKey: "isLeftTrailActive",
        lastPointKey: "lastLeftTrailPoint",
        segmentsKey: "trailLeftSegments",
        fillPathKey: "trailLeftFillPath"
    }),
    right: Object.freeze({
        activeKey: "isRightTrailActive",
        lastPointKey: "lastRightTrailPoint",
        segmentsKey: "trailRightSegments",
        fillPathKey: "trailRightFillPath"
    })
});

function createTrailUpdateDiagnostics() {
    return {
        activeTrailPlayers: 0,
        captureApply: createCaptureApplyDiagnostics(),
        captureAttempts: 0,
        captureChangedPlayerCount: 0,
        captureOperationReplayAccepted: 0,
        captureOperationReplayAreaMismatch: 0,
        captureOperationReplayInvalid: 0,
        captureOperationReplayRejected: 0,
        captures: 0,
        clearTrailCount: 0,
        closedTrailReturns: 0,
        fillPathCount: 0,
        fillPolygonCount: 0,
        ownerTrailBlockBoundsRejected: 0,
        ownerTrailBlockChecks: 0,
        ownerTrailBoundsRejected: 0,
        ownerTrailPrimitiveCandidates: 0,
        ownerTrailPrimitiveTests: 0,
        ownerTrailSegmentChecks: 0,
        pathPrimitiveBlockCount: 0,
        pathPrimitiveCacheHits: 0,
        pathPrimitiveCacheMisses: 0,
        pathPrimitiveCount: 0,
        pathPrimitiveInputPointCount: 0,
        selfPathPrimitiveBlockCount: 0,
        selfPathPrimitiveCacheHits: 0,
        selfPathPrimitiveCacheMisses: 0,
        selfPathPrimitiveCount: 0,
        selfPathPrimitiveInputPointCount: 0,
        selfTrailBlockBoundsRejected: 0,
        selfTrailBlockChecks: 0,
        selfTrailBoundsRejected: 0,
        selfTrailPrimitiveCandidates: 0,
        selfTrailPrimitiveTests: 0,
        selfTrailMovementBoundsRejected: 0,
        selfTrailRecentSegmentSkipped: 0,
        selfTrailSegmentBoundsRejected: 0,
        selfTrailSegmentCandidates: 0,
        phases: {},
        playersProcessed: 0,
        selfCollisionTests: 0,
        selfCollisions: 0,
        selfTrailSideBoundsRejected: 0,
        selfTrailSideCandidates: 0,
        selfTrailSegmentChecks: 0,
        slowestPhase: null,
        trailOwnerCacheHits: 0,
        trailOwnerCacheMisses: 0,
        trailOwnerCandidates: 0,
        trailOwnerChecks: 0,
        trailOwnerHits: 0,
        trailOwnerInsideRejected: 0,
        trailOwnerMovementBoundsRejected: 0,
        trailOwnerNoTrailRejected: 0,
        trailOwnerSideBoundsRejected: 0
    };
}

function createCaptureApplyDiagnostics() {
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

function getTrailDiagnostics(context) {
    return context && context.trailDiagnostics || null;
}

function measureTrailPhase(diagnostics, name, callback) {
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

function addTrailDiagnosticCount(diagnostics, name, value) {
    if (!diagnostics || !Number.isFinite(value) || value <= 0) {
        return;
    }

    diagnostics[name] = (diagnostics[name] || 0) + value;
}

function getSlowestTrailPhase(phases) {
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

function roundToMilliseconds(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function updateTrails(players, territories, context = {}) {
    const diagnostics = createTrailUpdateDiagnostics();
    const nextContext = {
        ...context,
        ownerTrailCollisionSummaryCache: new Map(),
        trailDiagnostics: diagnostics
    };
    const repairedPlayerIds = measureTrailPhase(diagnostics, "overlapRepairQueue", () => (
        processTerritoryOverlapRepairQueue(territories, players, {
            diagnostics,
            players
        })
    ));

    if (repairedPlayerIds.size > 0) {
        addTrailDiagnosticCount(diagnostics, "captureChangedPlayerCount", repairedPlayerIds.size);
        measureTrailPhase(diagnostics, "overlapRepairQueueRelocatePlayers", () => {
            relocatePlayersAfterTerritoryChange(players, territories, repairedPlayerIds);
        });
    }

    for (const player of players.values()) {
        updatePlayerTrail(player, territories, players, nextContext);
    }

    diagnostics.slowestPhase = getSlowestTrailPhase(diagnostics.phases);
    return diagnostics;
}

function updatePlayerTrail(player, territories, players = new Map([[player.id, player]]), context = {}) {
    const diagnostics = getTrailDiagnostics(context);

    addTrailDiagnosticCount(diagnostics, "playersProcessed", 1);

    const territoryPolygon = measureTrailPhase(diagnostics, "territoryLookup", () => (
        getPlayerTerritoryPolygon(territories, player.id)
    ));
    const sample = measureTrailPhase(diagnostics, "sample", () => createTrailSample(player));
    const previousSample = {
        leftPoint: player.lastLeftTrailPoint,
        rightPoint: player.lastRightTrailPoint
    };
    const sideUpdates = measureTrailPhase(diagnostics, "sideUpdate", () => ({
        left: updateTrailSide(player, trailSides.left, sample.leftPoint, territoryPolygon),
        right: updateTrailSide(player, trailSides.right, sample.rightPoint, territoryPolygon)
    }));
    invalidateTrailOwnerCollisionSummary(context, player.id);

    const leftUpdate = sideUpdates.left;
    const rightUpdate = sideUpdates.right;
    const leftInside = leftUpdate.inside;
    const rightInside = rightUpdate.inside;
    const isInsideOwnTerritory = leftInside && rightInside;
    const hasTrailSegment = hasAnyTrailSegment(player);

    if (hasTrailSegment) {
        addTrailDiagnosticCount(diagnostics, "activeTrailPlayers", 1);
    }

    if (isInsideOwnTerritory && !hasTrailSegment) {
        measureTrailPhase(diagnostics, "clearEliminationMarks", () => {
            clearCatchEliminationMarksForTarget(players, player.id);
            clearCatchEliminationMarksByMarker(player);
        });
    }

    player.lastLeftTrailPoint = clonePoint(sample.leftPoint);
    player.lastRightTrailPoint = clonePoint(sample.rightPoint);

    const selfTrailCollision = !isInsideOwnTerritory && measureTrailPhase(diagnostics, "selfCollision", () => (
        hasSelfTrailCollision(player, previousSample, sample, context)
    ));

    if (selfTrailCollision) {
        addTrailDiagnosticCount(diagnostics, "selfCollisions", 1);
        handlePlayerLifeLoss(players, territories, player, context, {
            reason: "selfTrail"
        });
        invalidateTrailOwnerCollisionSummary(context, player.id);
        return;
    }

    if (!isInsideOwnTerritory) {
        measureTrailPhase(diagnostics, "ownerCrossing", () => {
            markCrossedTrailOwners(player, players, territories, previousSample, sample, context);
        });
    }

    if (isInsideOwnTerritory && hasTrailSegment) {
        addTrailDiagnosticCount(diagnostics, "closedTrailReturns", 1);
        let capturedPolygon = null;

        if (canCaptureClosedTrail(player)) {
            capturedPolygon = measureTrailPhase(diagnostics, "capture", () => (
                captureClosedTrail(player, territories, players, context)
            ));

            if (capturedPolygon) {
                addTrailDiagnosticCount(diagnostics, "captures", 1);
                confirmCatchEliminationTargets(players, territories, player, context);
                player.consumeCatchBalance(1);
                clearTrailOwnerCollisionSummaryCache(context);
            }
        }

        measureTrailPhase(diagnostics, "clearEliminationMarks", () => {
            clearCatchEliminationMarksForTarget(players, player.id);
            clearCatchEliminationMarksByMarker(player);
        });

        measureTrailPhase(diagnostics, "clearTrail", () => {
            addTrailDiagnosticCount(diagnostics, "clearTrailCount", 1);
            clearTrail(player);
            invalidateTrailOwnerCollisionSummary(context, player.id);
        });
        return;
    }

    measureTrailPhase(diagnostics, "fill", () => {
        updateTrailFill(player, sample, previousSample, territoryPolygon, leftUpdate, rightUpdate, diagnostics);
    });
}

function updateTrailSide(player, side, currentPoint, territoryPolygon) {
    const isInside = isPointInPolygon(territoryPolygon, currentPoint.x, currentPoint.y);

    if (isInside) {
        return {
            inside: true,
            path: closeActiveSideSegment(player, side, currentPoint, territoryPolygon)
        };
    }

    if (!player[side.activeKey]) {
        return {
            inside: false,
            path: startSideSegment(player, side, currentPoint, territoryPolygon)
        };
    } else {
        return {
            inside: false,
            path: appendPointToActiveSegment(player, side, currentPoint, false)
        };
    }
}

function startSideSegment(player, side, currentPoint, territoryPolygon) {
    const previousPoint = player[side.lastPointKey];
    const contact = previousPoint
        ? findSegmentPolygonBoundaryContact(territoryPolygon, previousPoint, currentPoint)
        : null;
    const boundaryPoint = contact
        ? contact.point
        : findClosestBoundaryPoint(territoryPolygon, currentPoint);
    const segment = [];

    appendPoint(segment, boundaryPoint, true);
    appendTrailEdgePoint(player, segment, currentPoint, {
        force: true,
        interpolate: Boolean(previousPoint)
    });
    player[side.segmentsKey].push(segment);
    player[side.activeKey] = true;

    return segment.slice();
}

function closeActiveSideSegment(player, side, currentPoint, territoryPolygon) {
    if (!player[side.activeKey]) {
        return [];
    }

    const segment = getActiveSegment(player, side);

    if (!segment) {
        player[side.activeKey] = false;
        return [];
    }

    const previousPoint = segment[segment.length - 1] || player[side.lastPointKey];
    const contact = previousPoint
        ? findSegmentPolygonBoundaryContact(territoryPolygon, previousPoint, currentPoint)
        : null;
    const boundaryPoint = contact
        ? contact.point
        : findClosestBoundaryPoint(territoryPolygon, previousPoint || currentPoint);

    const previousLength = segment.length;

    appendTrailEdgePoint(player, segment, boundaryPoint, {
        force: true,
        interpolate: Boolean(previousPoint)
    });
    player[side.activeKey] = false;

    if (segment.length < 2) {
        player[side.segmentsKey].pop();
        return [];
    }

    return previousLength > 0 ? segment.slice(previousLength - 1) : segment.slice();
}

function appendPointToActiveSegment(player, side, point, force) {
    const segment = getActiveSegment(player, side);

    if (!segment) {
        return [];
    }

    const previousPoint = segment[segment.length - 1];

    const previousLength = segment.length;

    if (!appendTrailEdgePoint(player, segment, point, { force })) {
        return [];
    }

    return previousPoint && previousLength > 0
        ? segment.slice(previousLength - 1)
        : segment.slice(previousLength);
}

function updateTrailFill(player, sample, previousSample, territoryPolygon, leftUpdate, rightUpdate, diagnostics = null) {
    if (!hasAnyTrailSegment(player)) {
        clearTrailFill(player);
        return;
    }

    if (!previousSample.leftPoint || !previousSample.rightPoint) {
        return;
    }

    const leftInside = leftUpdate.inside;
    const rightInside = rightUpdate.inside;
    const leftPath = createFillSideStepPath(
        territoryPolygon,
        previousSample.leftPoint,
        sample.leftPoint,
        leftInside,
        leftUpdate.path
    );
    const rightPath = createFillSideStepPath(
        territoryPolygon,
        previousSample.rightPoint,
        sample.rightPoint,
        rightInside,
        rightUpdate.path
    );

    if (leftPath.length < 2 || rightPath.length < 2) {
        return;
    }

    addTrailDiagnosticCount(diagnostics, "fillPathCount", 1);

    const stepPolygon = createTrailFillPolygon(leftPath, rightPath);

    if (calculatePolygonArea(stepPolygon) > geometryEpsilon) {
        addTrailDiagnosticCount(diagnostics, "fillPolygonCount", 1);
        appendFillPath(player, trailSides.left, leftPath);
        appendFillPath(player, trailSides.right, rightPath);
    }
}

function appendTrailEdgePoint(player, points, point, options = {}) {
    return appendPoint(points, point, Boolean(options.force), {
        interpolate: options.interpolate !== false,
        spacing: getTrailPointSpacing(player)
    });
}

function appendPoint(points, point, force, options = {}) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return false;
    }

    const lastPoint = points[points.length - 1];

    if (lastPoint) {
        const distance = distanceBetween(point.x, point.y, lastPoint.x, lastPoint.y);
        const spacing = getNormalizedTrailPointSpacing(options.spacing);

        if (distance <= Number.EPSILON || (!force && distance < spacing)) {
            return false;
        }

        if (options.interpolate) {
            return appendInterpolatedPoints(points, lastPoint, point, spacing, force);
        }
    }

    appendRawPoint(points, point);

    return true;
}

function appendInterpolatedPoints(points, startPoint, endPoint, spacing, force) {
    const distance = distanceBetween(endPoint.x, endPoint.y, startPoint.x, startPoint.y);
    const safeSpacing = getNormalizedTrailPointSpacing(spacing);
    const steps = Math.floor(distance / safeSpacing);
    const previousLength = points.length;

    for (let step = 1; step <= steps; step++) {
        const t = (safeSpacing * step) / distance;

        if (t >= 1 - geometryEpsilon) {
            appendRawPoint(points, endPoint);
            return points.length > previousLength;
        }

        appendRawPoint(points, {
            x: startPoint.x + (endPoint.x - startPoint.x) * t,
            y: startPoint.y + (endPoint.y - startPoint.y) * t
        });
    }

    if (force) {
        appendRawPoint(points, endPoint);
    }

    return points.length > previousLength;
}

function appendRawPoint(points, point) {
    const lastPoint = points[points.length - 1];

    if (lastPoint && arePointsEqual(lastPoint, point)) {
        return false;
    }

    points.push({
        x: point.x,
        y: point.y
    });

    return true;
}

function getActiveSegment(player, side) {
    const segments = player[side.segmentsKey];

    return segments[segments.length - 1];
}

function findClosestBoundaryPoint(territoryPolygon, point) {
    const contact = findClosestPolygonBoundaryContact(territoryPolygon, point);

    return contact ? contact.point : point;
}

function hasAnyTrailSegment(player) {
    return hasVisibleSegment(player.trailLeftSegments)
        || hasVisibleSegment(player.trailRightSegments);
}

function hasVisibleSegment(segments) {
    return segments.some(segment => segment.length >= 2);
}

function hasSelfTrailCollision(player, previousSample, sample, context = {}) {
    if (!previousSample.leftPoint || !previousSample.rightPoint) {
        return false;
    }

    const diagnostics = getTrailDiagnostics(context);

    addTrailDiagnosticCount(diagnostics, "selfCollisionTests", 1);

    const movementLines = measureTrailPhase(diagnostics, "selfCollisionPrepare", () => (
        createSelfMovementCollisionLines(previousSample, sample)
    ));
    const movementBounds = getBoundsUnion(movementLines.map(line => line.bounds));

    if (movementLines.length <= 0 || !movementBounds) {
        return false;
    }

    const summary = measureTrailPhase(diagnostics, "selfCollisionSummary", () => (
        createSelfTrailCollisionSummary(player, diagnostics)
    ));

    if (!summary.bounds) {
        return false;
    }

    if (!doBoundsOverlap(movementBounds, summary.bounds)) {
        addTrailDiagnosticCount(diagnostics, "selfTrailMovementBoundsRejected", 1);
        return false;
    }

    return doesSelfMovementCrossTrail(player, movementLines, summary, diagnostics);
}

function markCrossedTrailOwners(player, players, territories, previousSample, sample, context = {}) {
    if (!previousSample.leftPoint || !previousSample.rightPoint) {
        return;
    }

    const diagnostics = getTrailDiagnostics(context);
    const movementLines = createMovementCollisionLines(previousSample, sample);
    const movementBounds = getBoundsUnion(movementLines.map(line => line.bounds));

    if (movementLines.length <= 0 || !movementBounds) {
        return;
    }

    for (const trailOwner of players.values()) {
        if (trailOwner.id === player.id) {
            continue;
        }

        addTrailDiagnosticCount(diagnostics, "trailOwnerCandidates", 1);

        const summary = getTrailOwnerCollisionSummary(trailOwner, territories, context);

        if (!summary.active) {
            addTrailDiagnosticCount(diagnostics, summary.rejectCounterName, 1);
            continue;
        }

        addTrailDiagnosticCount(diagnostics, "trailOwnerChecks", 1);

        if (!doBoundsOverlap(movementBounds, summary.bounds)) {
            addTrailDiagnosticCount(diagnostics, "trailOwnerMovementBoundsRejected", 1);
            continue;
        }

        if (doesPlayerMovementCrossTrailOwner(movementLines, summary, diagnostics)) {
            addTrailDiagnosticCount(diagnostics, "trailOwnerHits", 1);
            player.queueCatchEliminationTarget(trailOwner.id);
        }
    }
}

function canCaptureClosedTrail(player) {
    return config.gameMode.mode !== "catch" || player.catchBalance > 0;
}

function doesPlayerMovementCrossTrailOwner(movementLines, summary, diagnostics = null) {
    let checkedPrimitiveCount = 0;

    for (const line of movementLines) {
        for (const side of summary.sides) {
            if (!doBoundsOverlap(line.bounds, side.bounds)) {
                addTrailDiagnosticCount(diagnostics, "trailOwnerSideBoundsRejected", 1);
                continue;
            }

            for (const segment of side.segments) {
                if (!doBoundsOverlap(line.bounds, segment.bounds)) {
                    addTrailDiagnosticCount(diagnostics, "ownerTrailBoundsRejected", 1);
                    continue;
                }

                const index = getTrailCollisionIndex(segment.points, null, diagnostics);
                const result = doesLineCrossPathIndex(
                    line.start,
                    line.end,
                    line.bounds,
                    index,
                    diagnostics,
                    "owner"
                );

                checkedPrimitiveCount += result.primitiveTests;

                if (result.crosses) {
                    addTrailDiagnosticCount(diagnostics, "ownerTrailSegmentChecks", checkedPrimitiveCount);
                    return true;
                }
            }
        }
    }

    addTrailDiagnosticCount(diagnostics, "ownerTrailSegmentChecks", checkedPrimitiveCount);
    return false;
}

function createMovementCollisionLines(previousSample, sample) {
    return [
        createMovementCollisionLine(previousSample.leftPoint, sample.leftPoint),
        createMovementCollisionLine(previousSample.rightPoint, sample.rightPoint)
    ].filter(Boolean);
}

function createMovementCollisionLine(startPoint, endPoint) {
    if (!startPoint || !endPoint || arePointsEqual(startPoint, endPoint)) {
        return null;
    }

    return {
        bounds: getLineBounds(startPoint, endPoint),
        end: endPoint,
        start: startPoint
    };
}

function getTrailOwnerCollisionSummary(trailOwner, territories, context = {}) {
    const diagnostics = getTrailDiagnostics(context);
    const cache = getTrailOwnerCollisionSummaryCache(context);
    const cached = cache && cache.get(trailOwner.id);

    if (cached) {
        addTrailDiagnosticCount(diagnostics, "trailOwnerCacheHits", 1);
        return cached;
    }

    addTrailDiagnosticCount(diagnostics, "trailOwnerCacheMisses", 1);

    const summary = createTrailOwnerCollisionSummary(trailOwner, territories, diagnostics);

    if (cache) {
        cache.set(trailOwner.id, summary);
    }

    return summary;
}

function createTrailOwnerCollisionSummary(trailOwner, territories, diagnostics = null) {
    if (!hasAnyTrailSegment(trailOwner)) {
        return {
            active: false,
            rejectCounterName: "trailOwnerNoTrailRejected"
        };
    }

    if (isPointOwnedByPlayer(
        territories,
        trailOwner.id,
        trailOwner.x,
        trailOwner.y
    )) {
        return {
            active: false,
            rejectCounterName: "trailOwnerInsideRejected"
        };
    }

    const sides = [
        createTrailOwnerSideCollisionSummary(trailOwner.trailLeftSegments, diagnostics),
        createTrailOwnerSideCollisionSummary(trailOwner.trailRightSegments, diagnostics)
    ].filter(side => side.segments.length > 0 && side.bounds);
    const bounds = getBoundsUnion(sides.map(side => side.bounds));

    if (!bounds) {
        return {
            active: false,
            rejectCounterName: "trailOwnerNoTrailRejected"
        };
    }

    return {
        active: true,
        bounds,
        sides
    };
}

function createTrailOwnerSideCollisionSummary(segments, diagnostics = null) {
    const segmentSummaries = [];
    let bounds = null;

    if (!Array.isArray(segments)) {
        return {
            bounds,
            segments: segmentSummaries
        };
    }

    for (const segment of segments) {
        const segmentBounds = getTrailSegmentPointBounds(segment);

        if (!segmentBounds) {
            continue;
        }

        segmentSummaries.push({
            bounds: segmentBounds,
            points: segment
        });
        bounds = mergeBounds(bounds, segmentBounds);
    }

    return {
        bounds,
        segments: segmentSummaries
    };
}

function getTrailSegmentPointBounds(points, maxPointCount = null) {
    if (!Array.isArray(points) || points.length < 2) {
        return null;
    }

    const sourcePointCount = Number.isInteger(maxPointCount)
        ? Math.min(points.length, Math.max(0, maxPointCount))
        : points.length;

    if (sourcePointCount < 2) {
        return null;
    }

    const lastPoint = points[sourcePointCount - 1];
    const cacheKey = Number.isInteger(maxPointCount) ? sourcePointCount : "all";
    const cached = trailSegmentBoundsCache.get(points);
    const cacheEntry = cached && cached.get(cacheKey);

    if (cacheEntry
        && cacheEntry.sourcePointCount === sourcePointCount
        && cacheEntry.lastX === lastPoint.x
        && cacheEntry.lastY === lastPoint.y) {
        return cacheEntry.validPointCount >= 2 ? cacheEntry.bounds : null;
    }

    const seed = getTrailSegmentPointBoundsCacheSeed(cached, points, sourcePointCount);
    let bounds = seed ? seed.bounds : null;
    let validPointCount = seed ? seed.validPointCount : 0;
    const startIndex = seed ? seed.sourcePointCount : 0;

    for (let index = startIndex; index < sourcePointCount; index++) {
        const point = points[index];

        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            continue;
        }

        validPointCount++;
        const pointBounds = {
            minX: point.x,
            minY: point.y,
            maxX: point.x,
            maxY: point.y
        };

        bounds = mergeBounds(bounds, pointBounds);
    }

    const nextCache = cached || new Map();

    nextCache.set(cacheKey, {
        bounds,
        lastX: lastPoint.x,
        lastY: lastPoint.y,
        sourcePointCount,
        validPointCount
    });
    trailSegmentBoundsCache.set(points, nextCache);

    return validPointCount >= 2 ? bounds : null;
}

function getTrailSegmentPointBoundsCacheSeed(cached, points, sourcePointCount) {
    if (!(cached instanceof Map)) {
        return null;
    }

    let bestEntry = null;

    for (const entry of cached.values()) {
        if (!entry
            || !entry.bounds
            || !Number.isInteger(entry.sourcePointCount)
            || entry.sourcePointCount <= 0
            || entry.sourcePointCount >= sourcePointCount) {
            continue;
        }

        const lastPoint = points[entry.sourcePointCount - 1];

        if (!lastPoint
            || lastPoint.x !== entry.lastX
            || lastPoint.y !== entry.lastY) {
            continue;
        }

        if (!bestEntry || entry.sourcePointCount > bestEntry.sourcePointCount) {
            bestEntry = entry;
        }
    }

    return bestEntry;
}

function getTrailOwnerCollisionSummaryCache(context) {
    if (!context || typeof context !== "object") {
        return null;
    }

    if (!(context.ownerTrailCollisionSummaryCache instanceof Map)) {
        context.ownerTrailCollisionSummaryCache = new Map();
    }

    return context.ownerTrailCollisionSummaryCache;
}

function invalidateTrailOwnerCollisionSummary(context, ownerId) {
    const cache = context && context.ownerTrailCollisionSummaryCache;

    if (cache instanceof Map) {
        cache.delete(ownerId);
    }
}

function clearTrailOwnerCollisionSummaryCache(context) {
    const cache = context && context.ownerTrailCollisionSummaryCache;

    if (cache instanceof Map) {
        cache.clear();
    }
}

function doesSelfMovementCrossTrail(player, movementLines, summary, diagnostics = null) {
    let checkedPrimitiveCount = 0;

    for (const line of movementLines) {
        for (const side of summary.sides) {
            if (!doBoundsOverlap(line.bounds, side.bounds)) {
                addTrailDiagnosticCount(diagnostics, "selfTrailSideBoundsRejected", 1);
                continue;
            }

            addTrailDiagnosticCount(diagnostics, "selfTrailSideCandidates", 1);

            for (const segment of side.segments) {
                const maxPointCount = getSelfTrailCollisionPointLimit(player, line.movingSide, side.side, segment.points);

                if (maxPointCount !== null && maxPointCount < 2) {
                    addTrailDiagnosticCount(diagnostics, "selfTrailRecentSegmentSkipped", 1);
                    continue;
                }

                const segmentBounds = maxPointCount !== null
                    ? getTrailSegmentPointBounds(segment.points, maxPointCount)
                    : segment.bounds;

                if (!segmentBounds || !doBoundsOverlap(line.bounds, segmentBounds)) {
                    addTrailDiagnosticCount(diagnostics, "selfTrailSegmentBoundsRejected", 1);
                    continue;
                }

                addTrailDiagnosticCount(diagnostics, "selfTrailSegmentCandidates", 1);

                const index = getSelfTrailCollisionIndex(segment.points, maxPointCount, diagnostics);
                const result = doesLineCrossPathIndex(
                    line.start,
                    line.end,
                    line.bounds,
                    index,
                    diagnostics,
                    "self"
                );

                checkedPrimitiveCount += result.primitiveTests;

                if (result.crosses) {
                    addTrailDiagnosticCount(diagnostics, "selfTrailSegmentChecks", checkedPrimitiveCount);
                    return true;
                }
            }
        }
    }

    addTrailDiagnosticCount(diagnostics, "selfTrailSegmentChecks", checkedPrimitiveCount);
    return false;
}

function createSelfMovementCollisionLines(previousSample, sample) {
    return [
        createSelfMovementCollisionLine(trailSides.left, previousSample.leftPoint, sample.leftPoint),
        createSelfMovementCollisionLine(trailSides.right, previousSample.rightPoint, sample.rightPoint)
    ].filter(Boolean);
}

function createSelfMovementCollisionLine(movingSide, startPoint, endPoint) {
    const line = createMovementCollisionLine(startPoint, endPoint);

    return line ? {
        ...line,
        movingSide
    } : null;
}

function createSelfTrailCollisionSummary(player, diagnostics = null) {
    const sides = [
        createSelfTrailSideCollisionSummary(player, trailSides.left),
        createSelfTrailSideCollisionSummary(player, trailSides.right)
    ].filter(side => side.segments.length > 0 && side.bounds);
    const bounds = getBoundsUnion(sides.map(side => side.bounds));

    return {
        bounds,
        sides
    };
}

function createSelfTrailSideCollisionSummary(player, side) {
    const segments = player[side.segmentsKey];
    const segmentSummaries = [];
    let bounds = null;

    if (!Array.isArray(segments)) {
        return {
            bounds,
            segments: segmentSummaries,
            side
        };
    }

    for (const segment of segments) {
        const segmentBounds = getTrailSegmentPointBounds(segment);

        if (!segmentBounds) {
            continue;
        }

        segmentSummaries.push({
            bounds: segmentBounds,
            points: segment
        });
        bounds = mergeBounds(bounds, segmentBounds);
    }

    return {
        bounds,
        segments: segmentSummaries,
        side
    };
}

function getSelfTrailCollisionPointLimit(player, movingSide, storedSide, segment) {
    const activeSegment = getActiveSegment(player, storedSide);

    if (segment !== activeSegment) {
        return null;
    }

    const recentPointSkip = getRecentSelfTrailCollisionPointSkip(player, movingSide, storedSide);
    const checkedSegmentEndIndex = segment.length - recentPointSkip;

    return Math.max(0, checkedSegmentEndIndex + 1);
}

function doesLineCrossPathIndex(startPoint, endPoint, movementBounds, index, diagnostics = null, counterPrefix = "owner") {
    if (!index || !Array.isArray(index.blocks) || index.blocks.length <= 0) {
        return {
            crosses: false,
            primitiveTests: 0
        };
    }

    if (!doBoundsOverlap(movementBounds, index.bounds)) {
        addTrailDiagnosticCount(diagnostics, `${counterPrefix}TrailBoundsRejected`, 1);

        return {
            crosses: false,
            primitiveTests: 0
        };
    }

    let blockChecks = 0;
    let blockBoundsRejected = 0;
    let primitiveCandidates = 0;
    let primitiveTests = 0;
    let crosses = false;

    for (const block of index.blocks) {
        blockChecks++;

        if (!doBoundsOverlap(movementBounds, block.bounds)) {
            blockBoundsRejected++;
            continue;
        }

        primitiveCandidates += block.primitives.length;

        for (const primitive of block.primitives) {
            primitiveTests++;

            if (doesLineCrossPathPrimitive(startPoint, endPoint, primitive)) {
                crosses = true;
                break;
            }
        }

        if (crosses) {
            break;
        }
    }

    addTrailDiagnosticCount(diagnostics, `${counterPrefix}TrailBlockChecks`, blockChecks);
    addTrailDiagnosticCount(diagnostics, `${counterPrefix}TrailBlockBoundsRejected`, blockBoundsRejected);
    addTrailDiagnosticCount(diagnostics, `${counterPrefix}TrailPrimitiveCandidates`, primitiveCandidates);
    addTrailDiagnosticCount(diagnostics, `${counterPrefix}TrailPrimitiveTests`, primitiveTests);

    return {
        crosses,
        primitiveTests
    };
}

function getTrailCollisionIndex(segment, maxPointCount = null, diagnostics = null) {
    if (!Array.isArray(segment)) {
        return createEmptyPathPrimitiveIndex();
    }

    const sourcePointCount = Number.isInteger(maxPointCount)
        ? Math.min(segment.length, Math.max(0, maxPointCount))
        : segment.length;

    if (sourcePointCount < 2) {
        return createEmptyPathPrimitiveIndex();
    }

    const cached = pathPrimitiveCache.get(segment);
    const cacheKey = Number.isInteger(maxPointCount) ? sourcePointCount : "all";
    const lastPoint = segment[sourcePointCount - 1];
    const cacheEntry = cached && cached.get(cacheKey);

    if (cacheEntry
        && cacheEntry.sourcePointCount === sourcePointCount
        && cacheEntry.lastX === lastPoint.x
        && cacheEntry.lastY === lastPoint.y) {
        addTrailDiagnosticCount(diagnostics, "pathPrimitiveCacheHits", 1);
        addTrailDiagnosticCount(diagnostics, "pathPrimitiveBlockCount", cacheEntry.index.blocks.length);
        addTrailDiagnosticCount(diagnostics, "pathPrimitiveCount", cacheEntry.primitives.length);
        addTrailDiagnosticCount(diagnostics, "pathPrimitiveInputPointCount", sourcePointCount);
        return cacheEntry.index;
    }

    const points = sourcePointCount === segment.length
        ? segment
        : segment.slice(0, sourcePointCount);
    const primitives = createPathPrimitivesFromPoints(points, {
        angleThresholdRadians: getPathSegmentAngleThresholdRadians(),
        maxArcSweepRadians: getPathSegmentArcMaxSweepRadians(),
        maxArcRadialDrift: getPathSegmentArcMaxRadialDrift()
    });
    const safePrimitives = primitives.length > 0
        ? primitives
        : createFallbackLinePrimitives(points);
    const index = createPathPrimitiveIndex(safePrimitives, {
        blockSize: getTrailSpatialBlockPrimitiveCount()
    });
    const nextCache = cached || new Map();

    nextCache.set(cacheKey, {
        index,
        lastX: lastPoint.x,
        lastY: lastPoint.y,
        primitives: safePrimitives,
        sourcePointCount
    });
    pathPrimitiveCache.set(segment, nextCache);

    addTrailDiagnosticCount(diagnostics, "pathPrimitiveCacheMisses", 1);
    addTrailDiagnosticCount(diagnostics, "pathPrimitiveBlockCount", index.blocks.length);
    addTrailDiagnosticCount(diagnostics, "pathPrimitiveCount", safePrimitives.length);
    addTrailDiagnosticCount(diagnostics, "pathPrimitiveInputPointCount", sourcePointCount);

    return index;
}

function getSelfTrailCollisionIndex(segment, maxPointCount = null, diagnostics = null) {
    if (!Array.isArray(segment)) {
        return createEmptyPathPrimitiveIndex();
    }

    const sourcePointCount = Number.isInteger(maxPointCount)
        ? Math.min(segment.length, Math.max(0, maxPointCount))
        : segment.length;

    if (sourcePointCount < 2) {
        return createEmptyPathPrimitiveIndex();
    }

    const cached = selfTrailLinePrimitiveCache.get(segment);
    const cacheKey = Number.isInteger(maxPointCount) ? sourcePointCount : "all";
    const lastPoint = segment[sourcePointCount - 1];
    const cacheEntry = cached && cached.get(cacheKey);

    if (cacheEntry
        && cacheEntry.sourcePointCount === sourcePointCount
        && cacheEntry.lastX === lastPoint.x
        && cacheEntry.lastY === lastPoint.y) {
        addTrailDiagnosticCount(diagnostics, "selfPathPrimitiveCacheHits", 1);
        addTrailDiagnosticCount(diagnostics, "selfPathPrimitiveBlockCount", cacheEntry.index.blocks.length);
        addTrailDiagnosticCount(diagnostics, "selfPathPrimitiveCount", cacheEntry.primitives.length);
        addTrailDiagnosticCount(diagnostics, "selfPathPrimitiveInputPointCount", sourcePointCount);
        return cacheEntry.index;
    }

    const points = sourcePointCount === segment.length
        ? segment
        : segment.slice(0, sourcePointCount);
    const primitives = createLinePrimitivesFromPoints(points, {
        angleThresholdRadians: getPathSegmentAngleThresholdRadians(),
        maxDeviation: getSelfTrailLineSimplifyTolerance()
    });
    const safePrimitives = primitives.length > 0
        ? primitives
        : createFallbackLinePrimitives(points);
    const index = createPathPrimitiveIndex(safePrimitives, {
        blockSize: getTrailSpatialBlockPrimitiveCount()
    });
    const nextCache = cached || new Map();

    nextCache.set(cacheKey, {
        index,
        lastX: lastPoint.x,
        lastY: lastPoint.y,
        primitives: safePrimitives,
        sourcePointCount
    });
    selfTrailLinePrimitiveCache.set(segment, nextCache);

    addTrailDiagnosticCount(diagnostics, "selfPathPrimitiveCacheMisses", 1);
    addTrailDiagnosticCount(diagnostics, "selfPathPrimitiveBlockCount", index.blocks.length);
    addTrailDiagnosticCount(diagnostics, "selfPathPrimitiveCount", safePrimitives.length);
    addTrailDiagnosticCount(diagnostics, "selfPathPrimitiveInputPointCount", sourcePointCount);

    return index;
}

function createEmptyPathPrimitiveIndex() {
    return {
        blocks: [],
        bounds: null,
        primitives: []
    };
}

function createFallbackLinePrimitives(points) {
    const primitives = [];

    for (let index = 0; index < points.length - 1; index++) {
        primitives.push({
            bounds: {
                minX: Math.min(points[index].x, points[index + 1].x),
                minY: Math.min(points[index].y, points[index + 1].y),
                maxX: Math.max(points[index].x, points[index + 1].x),
                maxY: Math.max(points[index].y, points[index + 1].y)
            },
            endIndex: index + 1,
            from: points[index],
            startIndex: index,
            to: points[index + 1],
            type: "line"
        });
    }

    return primitives;
}

function getPathSegmentAngleThresholdRadians() {
    return degreesToRadians(config.territory.pathSegmentAngleThresholdDegrees, 1);
}

function getPathSegmentArcMaxSweepRadians() {
    return degreesToRadians(config.territory.pathSegmentArcMaxSweepDegrees, 135);
}

function getPathSegmentArcMaxRadialDrift() {
    const value = Number(config.territory.pathSegmentArcMaxRadialDrift);

    return Number.isFinite(value) && value >= 0 ? value : 2;
}

function getSelfTrailLineSimplifyTolerance() {
    const value = Number(config.territory.selfTrailLineSimplifyTolerance);

    return Number.isFinite(value) && value >= 0 ? value : 1.5;
}

function getTrailSpatialBlockPrimitiveCount() {
    const value = Number(config.territory.trailSpatialBlockPrimitiveCount);

    return Number.isInteger(value) && value > 0 ? value : 48;
}

function degreesToRadians(value, fallbackDegrees) {
    const degrees = Number.isFinite(value) && value > 0 ? value : fallbackDegrees;

    return degrees * Math.PI / 180;
}

function getRecentSelfTrailCollisionPointSkip(player, movingSide, storedSide) {
    const baseSkip = movingSide === storedSide ? 3 : 2;

    if (!isPlayerSlidingOnMapBoundary(player)) {
        return baseSkip;
    }

    const boundaryTurnSkip = Math.ceil(
        (getRuntimeConfig(player).world.playerSize * 4) / getTrailPointSpacing(player)
    );

    return Math.max(baseSkip, boundaryTurnSkip);
}

function isPlayerSlidingOnMapBoundary(player) {
    return isBoundarySlideDirection(player.boundarySlideDirection)
        && Math.hypot(player.x, player.y) >= getMapMovementLimit(player) - getBoundarySlideTolerance(player);
}

function isBoundarySlideDirection(value) {
    return value === -1 || value === 1;
}

function getBoundarySlideTolerance(player = null) {
    const runtimeConfig = getRuntimeConfig(player);
    const configuredTolerance = Number(
        runtimeConfig.movement && runtimeConfig.movement.boundaryTouchTolerance
    );

    return Number.isFinite(configuredTolerance) && configuredTolerance > 0
        ? configuredTolerance
        : runtimeConfig.world.playerSize / 2;
}

function getMapMovementLimit(player = null) {
    const runtimeConfig = getRuntimeConfig(player);

    return runtimeConfig.world.mapRadius - runtimeConfig.world.playerSize / 2;
}

function clearTrail(player) {
    player.clearTrailState();
}

function clearTrailFill(player) {
    player.trailLeftFillPath = [];
    player.trailRightFillPath = [];
}

function createTrailSample(player) {
    const halfWidth = getRuntimeConfig(player).world.playerSize / 2;
    const normal = getPlayerNormal(player.angle);

    return {
        leftPoint: {
            x: player.x + normal.x * halfWidth,
            y: player.y + normal.y * halfWidth
        },
        rightPoint: {
            x: player.x - normal.x * halfWidth,
            y: player.y - normal.y * halfWidth
        }
    };
}

function getTrailPointSpacing(player = null) {
    const territoryConfig = getRuntimeConfig(player).territory;
    const baseSpacing = getNormalizedTrailPointSpacing(territoryConfig.trailPointSpacing);

    if (!isPlayerSlidingOnMapBoundary(player)) {
        return baseSpacing;
    }

    return Math.min(
        baseSpacing,
        getNormalizedTrailPointSpacing(territoryConfig.boundarySlideTrailPointSpacing, baseSpacing)
    );
}

function getNormalizedTrailPointSpacing(value, fallback = config.territory.trailPointSpacing) {
    const spacing = Number(value);

    return Number.isFinite(spacing) && spacing > Number.EPSILON
        ? spacing
        : Number(fallback) || 1;
}

function getRuntimeConfig(player = null) {
    return player && player.runtimeConfig && player.runtimeConfig.world
        ? player.runtimeConfig
        : config;
}

function clonePoint(point) {
    return {
        x: point.x,
        y: point.y
    };
}

function getPlayerNormal(angle) {
    return {
        x: -Math.sin(angle),
        y: Math.cos(angle)
    };
}

function appendFillPath(player, side, path) {
    if (!Array.isArray(player[side.fillPathKey])) {
        player[side.fillPathKey] = [];
    }

    const fillPath = player[side.fillPathKey];

    for (const point of path) {
        appendPoint(fillPath, point, true);
    }
}

function createTrailFillPolygon(leftPath, rightPath) {
    const polygon = createPolygonFromPoints(removeConsecutiveDuplicatePoints(
        leftPath.concat([...rightPath].reverse())
    ));

    return calculatePolygonArea(polygon) > geometryEpsilon ? polygon : [];
}

function createFillSideStepPath(territoryPolygon, previousPoint, currentPoint, currentInside, visiblePath = []) {
    if (Array.isArray(visiblePath) && visiblePath.length >= 2) {
        return visiblePath;
    }

    const previousInside = isPointInPolygon(territoryPolygon, previousPoint.x, previousPoint.y);

    if (previousInside && currentInside) {
        return createBoundaryPathBetweenPoints(territoryPolygon, previousPoint, currentPoint);
    }

    if (previousInside && !currentInside) {
        const contact = findSegmentPolygonBoundaryContact(territoryPolygon, previousPoint, currentPoint)
            || findClosestPolygonBoundaryContact(territoryPolygon, currentPoint);

        return contact ? [contact.point, currentPoint] : [];
    }

    if (!previousInside && currentInside) {
        const contact = findSegmentPolygonBoundaryContact(territoryPolygon, previousPoint, currentPoint)
            || findClosestPolygonBoundaryContact(territoryPolygon, previousPoint);

        return contact ? [previousPoint, contact.point] : [];
    }

    return [previousPoint, currentPoint];
}

function createBoundaryPathBetweenPoints(territoryPolygon, previousPoint, currentPoint) {
    const startContact = findClosestPolygonBoundaryContact(territoryPolygon, previousPoint);
    const endContact = findClosestPolygonBoundaryContact(territoryPolygon, currentPoint);

    return createShortestBoundaryPath(territoryPolygon[0], startContact, endContact);
}

function createShortestBoundaryPath(ring, startContact, endContact) {
    const boundaryPaths = createBoundaryPaths(ring, startContact, endContact);

    return boundaryPaths.sort((first, second) => calculatePathLength(first) - calculatePathLength(second))[0] || [];
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
        path.push(coordinatesToPoint(openRing[vertexIndex]));

        if (vertexIndex === endContact.segmentIndex) {
            break;
        }

        vertexIndex = (vertexIndex + 1) % openRing.length;
        guard++;
    }

    path.push(endContact.point);

    return path;
}

function calculatePathLength(points) {
    let length = 0;

    for (let index = 1; index < points.length; index++) {
        length += distanceBetween(points[index - 1].x, points[index - 1].y, points[index].x, points[index].y);
    }

    return length;
}

function getOpenRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    if (ring.length > 1 && areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        return ring.slice(0, -1);
    }

    return ring.slice();
}

function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
}

function coordinatesToPoint(coordinates) {
    return {
        x: coordinates[0],
        y: coordinates[1]
    };
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

function getLineBounds(startPoint, endPoint) {
    return {
        minX: Math.min(startPoint.x, endPoint.x),
        minY: Math.min(startPoint.y, endPoint.y),
        maxX: Math.max(startPoint.x, endPoint.x),
        maxY: Math.max(startPoint.y, endPoint.y)
    };
}

function getBoundsUnion(boundsList) {
    let bounds = null;

    for (const currentBounds of boundsList || []) {
        bounds = mergeBounds(bounds, currentBounds);
    }

    return bounds;
}

function mergeBounds(first, second) {
    if (!second) {
        return first;
    }

    if (!first) {
        return {
            minX: second.minX,
            minY: second.minY,
            maxX: second.maxX,
            maxY: second.maxY
        };
    }

    return {
        minX: Math.min(first.minX, second.minX),
        minY: Math.min(first.minY, second.minY),
        maxX: Math.max(first.maxX, second.maxX),
        maxY: Math.max(first.maxY, second.maxY)
    };
}

function doBoundsOverlap(first, second) {
    if (!first || !second) {
        return false;
    }

    return first.minX <= second.maxX + geometryEpsilon
        && first.maxX + geometryEpsilon >= second.minX
        && first.minY <= second.maxY + geometryEpsilon
        && first.maxY + geometryEpsilon >= second.minY;
}

function areCoordinatesEqual(first, second) {
    return first[0] === second[0] && first[1] === second[1];
}

module.exports = {
    updatePlayerTrail,
    updateTrails
};
