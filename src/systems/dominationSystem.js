const config = require("../config/gameConfig");
const {
    applyCapturedPolygon,
    getPlayerTerritoryPolygon
} = require("../state/territories");
const { getHighResolutionTime } = require("../utils/time");
const {
    calculatePolygonArea,
    createPolygonMetrics,
    createPolygonFromPoints,
    doBoundsContainPoint,
    doBoundsOverlap,
    findClosestPolygonBoundaryContact,
    getPolygonBounds,
    isPointInPolygon,
    subtractPolygon
} = require("../utils/geometry");
const {
    endPlayerGame,
    handlePlayerLifeLoss,
    handlePlayerVictory,
    handleSuccessfulTrailCapture
} = require("./catchModeSystem");
const { relocatePlayersAfterTerritoryChange } = require("./territoryRespawnSystem");

const geometryEpsilon = 1e-7;

function captureClosedTrail(player, territories, players, context = {}) {
    const diagnostics = getTrailDiagnostics(context);

    addTrailDiagnosticCount(diagnostics, "captureAttempts", 1);

    const capture = measureTrailPhase(diagnostics, "captureCreate", () => (
        createExternalTrailCapture(player, territories)
    ));

    if (!capture) {
        return null;
    }

    const territory = territories.get(player.id);
    const baseVersion = territory ? territory.version || 0 : 0;
    const baseTerritoryPolygon = territory ? clonePolygon(territory.polygon) : [];
    const ownerPolygon = measureTrailPhase(diagnostics, "captureOwnerPolygon", () => (
        getCaptureOwnerPolygon(capture)
    ));
    const newlyCapturedMetrics = measureTrailPhase(diagnostics, "captureNewPolygon", () => (
        createNewlyCapturedMetrics(capture, territory)
    ));
    const newlyCapturedPolygon = newlyCapturedMetrics.polygon;
    const ownerPolygonMetrics = createOwnerPolygonMetrics(capture, ownerPolygon);
    const changedPlayerIds = measureTrailPhase(diagnostics, "captureApplyTerritory", () => (
        applyCapturedPolygon(territories, player.id, newlyCapturedPolygon, {
            captureOverlapAudit: shouldAuditCaptureOverlaps(context),
            capturedMetrics: newlyCapturedMetrics,
            diagnostics,
            ownerPolygon,
            ownerPolygonMetrics,
            players,
            runtimeConfig: context.runtimeConfig
        })
    ));

    addTrailDiagnosticCount(diagnostics, "captureChangedPlayerCount", changedPlayerIds.size);

    measureTrailPhase(diagnostics, "captureStoreOperation", () => {
        storeCaptureOperation(
            territories,
            player.id,
            capture,
            baseVersion,
            changedPlayerIds,
            baseTerritoryPolygon,
            diagnostics
        );
    });
    measureTrailPhase(diagnostics, "captureDamagePlayers", () => {
        damagePlayersInsideCapturedPolygon(
            players,
            territories,
            player,
            newlyCapturedMetrics,
            context
        );
    });
    measureTrailPhase(diagnostics, "captureCounterattack", () => {
        handleSuccessfulTrailCapture(players, territories, player, context);
    });
    const relocationPlayerIds = new Set(changedPlayerIds);
    relocationPlayerIds.delete(player.id);

    const noRespawnPlayerIds = measureTrailPhase(diagnostics, "captureRelocatePlayers", () => (
        relocatePlayersAfterTerritoryChange(players, territories, relocationPlayerIds)
    ));

    measureTrailPhase(diagnostics, "captureEndNoRespawn", () => {
        endPlayersWithoutRespawn(players, territories, noRespawnPlayerIds, player, context);
    });
    measureTrailPhase(diagnostics, "captureVictoryCheck", () => {
        maybeEndGameWithVictory(players, territories, player, context);
    });

    return capture.polygon;
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

function shouldAuditCaptureOverlaps(context) {
    if (config.network.captureOverlapAuditEnabled === true) {
        return true;
    }

    const roomCode = context && context.roomCode;
    const sockets = context
        && context.io
        && context.io.sockets
        && context.io.sockets.sockets;

    if (!roomCode || !sockets || typeof sockets.values !== "function") {
        return false;
    }

    for (const socket of sockets.values()) {
        if (!socket || !socket.data || socket.data.captureOverlapAuditEnabled !== true) {
            continue;
        }

        if (socket.data.roomCode === roomCode || socket.data.spectatorRoomCode === roomCode) {
            return true;
        }
    }

    return false;
}

function getCaptureOwnerPolygon(capture) {
    const previewPolygon = capture && capture.operation && capture.operation.previewPolygon;

    return previewPolygon && previewPolygon[0]
        ? previewPolygon
        : capture.polygon;
}

function createNewlyCapturedMetrics(capture, previousTerritory) {
    const damageMetrics = createPolygonMetrics(capture.damagePolygon);

    if (damageMetrics.area > geometryEpsilon) {
        return damageMetrics;
    }

    if (!previousTerritory) {
        return createPolygonMetrics([]);
    }

    const differencePolygon = subtractPolygon(getCaptureOwnerPolygon(capture), previousTerritory.polygon);
    const differenceMetrics = createPolygonMetrics(differencePolygon);

    return differenceMetrics.area > geometryEpsilon
        ? differenceMetrics
        : createPolygonMetrics([]);
}

function createOwnerPolygonMetrics(capture, ownerPolygon) {
    const metrics = createPolygonMetrics(ownerPolygon);

    if (capture && capture.polygon === ownerPolygon && Number.isFinite(capture.area)) {
        metrics.area = capture.area;
    }

    return metrics;
}

function damagePlayersInsideCapturedPolygon(players, territories, attacker, capturedMetrics, context) {
    const capturedPolygon = capturedMetrics.polygon;
    const capturedBounds = capturedMetrics.bounds;

    if (!capturedBounds || capturedMetrics.area <= geometryEpsilon) {
        return;
    }

    for (const target of [...players.values()]) {
        if (!target || target.id === attacker.id) {
            continue;
        }

        const isTargetInsideCapture = doBoundsContainPoint(capturedBounds, target.x, target.y)
            && isPointInPolygon(capturedPolygon, target.x, target.y);

        if (!isTargetInsideCapture
            && !doesTrailTouchCapturedPolygon(target, capturedPolygon, capturedBounds)) {
            continue;
        }

        handlePlayerLifeLoss(players, territories, target, context, {
            attacker,
            reason: "captured"
        });
    }
}

function doesTrailTouchCapturedPolygon(player, capturedPolygon, capturedBounds) {
    return doSegmentsTouchPolygon(player.trailLeftSegments, capturedPolygon, capturedBounds)
        || doSegmentsTouchPolygon(player.trailRightSegments, capturedPolygon, capturedBounds);
}

function doSegmentsTouchPolygon(segments, polygon, polygonBounds) {
    if (!Array.isArray(segments) || !polygon || !polygon[0]) {
        return false;
    }

    for (const segment of segments) {
        if (!Array.isArray(segment) || segment.length === 0) {
            continue;
        }

        const segmentBounds = getPointListBounds(segment);

        if (!doBoundsOverlap(segmentBounds, polygonBounds)) {
            continue;
        }

        if (segment.some(point => (
            doBoundsContainPoint(polygonBounds, point.x, point.y)
            && isPointInPolygon(polygon, point.x, point.y)
        ))) {
            return true;
        }

        for (let index = 0; index < segment.length - 1; index++) {
            if (!doBoundsOverlap(getLineSegmentBounds(segment[index], segment[index + 1]), polygonBounds)) {
                continue;
            }

            if (doesSegmentCrossPolygon(segment[index], segment[index + 1], polygon)) {
                return true;
            }
        }
    }

    return false;
}

function getPointListBounds(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const point of points || []) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            continue;
        }

        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }

    return Number.isFinite(minX)
        ? { minX, minY, maxX, maxY }
        : null;
}

function getLineSegmentBounds(startPoint, endPoint) {
    return {
        minX: Math.min(startPoint.x, endPoint.x),
        minY: Math.min(startPoint.y, endPoint.y),
        maxX: Math.max(startPoint.x, endPoint.x),
        maxY: Math.max(startPoint.y, endPoint.y)
    };
}

function doesSegmentCrossPolygon(startPoint, endPoint, polygon) {
    const ring = polygon[0] || [];

    for (let index = 0; index < ring.length - 1; index++) {
        const boundaryStart = coordinatesToPoint(ring[index]);
        const boundaryEnd = coordinatesToPoint(ring[index + 1]);

        if (segmentsIntersect(startPoint, endPoint, boundaryStart, boundaryEnd)) {
            return true;
        }
    }

    return false;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
    if (!doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd)) {
        return false;
    }

    const firstDirection = subtractPoints(firstEnd, firstStart);
    const secondDirection = subtractPoints(secondEnd, secondStart);
    const denominator = crossProduct(firstDirection, secondDirection);

    if (Math.abs(denominator) <= geometryEpsilon) {
        return false;
    }

    const startDelta = subtractPoints(secondStart, firstStart);
    const firstT = crossProduct(startDelta, secondDirection) / denominator;
    const secondT = crossProduct(startDelta, firstDirection) / denominator;

    return firstT >= -geometryEpsilon
        && firstT <= 1 + geometryEpsilon
        && secondT >= -geometryEpsilon
        && secondT <= 1 + geometryEpsilon;
}

function doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(Math.min(firstStart.x, firstEnd.x), Math.min(secondStart.x, secondEnd.x))
        <= Math.min(Math.max(firstStart.x, firstEnd.x), Math.max(secondStart.x, secondEnd.x)) + geometryEpsilon
        && Math.max(Math.min(firstStart.y, firstEnd.y), Math.min(secondStart.y, secondEnd.y))
        <= Math.min(Math.max(firstStart.y, firstEnd.y), Math.max(secondStart.y, secondEnd.y)) + geometryEpsilon;
}

function coordinatesToPoint(coordinates) {
    return {
        x: coordinates[0],
        y: coordinates[1]
    };
}

function subtractPoints(first, second) {
    return {
        x: first.x - second.x,
        y: first.y - second.y
    };
}

function crossProduct(first, second) {
    return first.x * second.y - first.y * second.x;
}

function endPlayersWithoutRespawn(players, territories, playerIds, attacker, context) {
    for (const playerId of playerIds || []) {
        const target = players.get(playerId);

        if (!target || target.id === attacker.id) {
            continue;
        }

        endPlayerGame(players, territories, target, context, {
            attacker,
            reason: "noRespawnSpace"
        });
    }
}

function maybeEndGameWithVictory(players, territories, player, context) {
    if (!player || !players.has(player.id) || !hasPlayerDominatedMap(territories, player)) {
        return false;
    }

    return handlePlayerVictory(players, territories, player, context);
}

function hasPlayerDominatedMap(territories, player) {
    const territory = territories.get(player.id);
    const runtimeConfig = player.runtimeConfig;
    const worldConfig = runtimeConfig && runtimeConfig.world ? runtimeConfig.world : config.world;
    const totalMapArea = Math.PI * worldConfig.mapRadius * worldConfig.mapRadius;
    const victoryRatio = Number.isFinite(config.territory.victoryAreaRatio)
        ? config.territory.victoryAreaRatio
        : 1;

    return territory
        && totalMapArea > 0
        && getTerritoryArea(territory) >= totalMapArea * victoryRatio;
}

function getTerritoryArea(territory) {
    return Number.isFinite(territory && territory.area)
        ? territory.area
        : calculatePolygonArea(territory && territory.polygon);
}

function createExternalTrailCapturePolygon(player, territories) {
    const capture = createExternalTrailCapture(player, territories);

    return capture ? capture.polygon : null;
}

function createExternalTrailCapture(player, territories) {
    if (!hasAnySideTrailSegment(player)) {
        return null;
    }

    const currentTerritory = getPlayerTerritoryPolygon(territories, player.id);
    const candidates = createTrailCaptureCandidates(player, currentTerritory);
    const bestCandidate = selectBestCaptureCandidate(
        currentTerritory,
        candidates,
        config.territory.minCaptureArea
    );

    if (!bestCandidate) {
        return null;
    }

    return bestCandidate;
}

function selectBestCaptureCandidate(currentTerritory, candidates, minAddedArea) {
    const currentArea = calculatePolygonArea(currentTerritory);
    let bestCandidate = null;

    for (const candidate of candidates) {
        const rankedCandidate = rankCaptureCandidate(currentArea, candidate);

        if (rankedCandidate.addedArea < minAddedArea) {
            continue;
        }

        if (!bestCandidate || isBetterCaptureCandidate(rankedCandidate, bestCandidate)) {
            bestCandidate = rankedCandidate;
        }
    }

    return bestCandidate;
}

function rankCaptureCandidate(currentArea, candidate) {
    const addedArea = candidate.area - currentArea;

    return {
        ...candidate,
        addedArea,
        overlapArea: currentArea
    };
}

function isBetterCaptureCandidate(candidate, bestCandidate) {
    if (Math.abs(candidate.addedArea - bestCandidate.addedArea) > geometryEpsilon) {
        return candidate.addedArea > bestCandidate.addedArea;
    }

    return candidate.overlapArea < bestCandidate.overlapArea;
}

function createTrailCaptureCandidates(player, territoryPolygon) {
    const candidates = [];

    for (const trail of getTrailSegments(player)) {
        candidates.push(...createTrailCaptureCandidatesFromSegment(trail, territoryPolygon));
    }

    return candidates;
}

function createTrailCaptureCandidatesFromSegment(trail, territoryPolygon) {
    const candidates = [];
    const finiteSidePoints = getFinitePoints(trail.points);

    if (finiteSidePoints.length < 2) {
        return candidates;
    }

    const startContact = findClosestPolygonBoundaryContact(territoryPolygon, finiteSidePoints[0]);
    const endContact = findClosestPolygonBoundaryContact(territoryPolygon, finiteSidePoints[finiteSidePoints.length - 1]);

    if (!startContact || !endContact) {
        return candidates;
    }

    const clippedSidePoints = createBorderSnappedSidePoints(
        finiteSidePoints,
        startContact.point,
        endContact.point
    );
    const boundaryPaths = createBoundaryPaths(territoryPolygon[0], endContact, startContact);
    const segmentCandidates = [];
    let bestCandidate = null;

    for (let boundaryPathIndex = 0; boundaryPathIndex < boundaryPaths.length; boundaryPathIndex++) {
        const boundaryPath = boundaryPaths[boundaryPathIndex];
        const points = createTrailBoundaryCapturePoints(clippedSidePoints, boundaryPath);
        const candidate = createTrailCandidateFromPoints(points);

        if (candidate) {
            segmentCandidates.push({
                ...candidate,
                boundaryPathIndex
            });
        }
    }

    const damagePolygon = createSegmentDamagePolygon(segmentCandidates, territoryPolygon);

    for (const candidate of segmentCandidates) {
        const captureCandidate = {
            ...candidate,
            damagePolygon,
            operation: createCaptureOperation(
                trail,
                clippedSidePoints,
                startContact,
                endContact,
                boundaryPaths,
                candidate.boundaryPathIndex,
                candidate.polygon
            )
        };

        if (isLargerAreaCandidate(captureCandidate, bestCandidate)) {
            bestCandidate = captureCandidate;
        }
    }

    if (bestCandidate) {
        candidates.push(bestCandidate);
    }

    return candidates;
}

function createSegmentDamagePolygon(segmentCandidates, territoryPolygon) {
    if (segmentCandidates.length >= 2) {
        return clonePolygon(getSmallestAreaCandidate(segmentCandidates).polygon);
    }

    const candidate = segmentCandidates[0];

    if (!candidate) {
        return [];
    }

    const differencePolygon = subtractPolygon(candidate.polygon, territoryPolygon);

    return getPolygonArea(differencePolygon) > geometryEpsilon
        ? differencePolygon
        : [];
}

function getPolygonArea(polygon) {
    return Array.isArray(polygon) ? calculatePolygonArea(polygon) : 0;
}

function getSmallestAreaCandidate(candidates) {
    return candidates.reduce((smallestCandidate, candidate) => (
        !smallestCandidate || candidate.area < smallestCandidate.area
            ? candidate
            : smallestCandidate
    ), null);
}

function getTrailSegments(player) {
    const generation = Number.isSafeInteger(player && player.trailGeneration)
        ? player.trailGeneration
        : 0;

    return [
        ...getVisibleSegments(player.trailLeftSegments).map((points, index) => ({
            generation,
            side: "left",
            index,
            points
        })),
        ...getVisibleSegments(player.trailRightSegments).map((points, index) => ({
            generation,
            side: "right",
            index,
            points
        }))
    ];
}

function hasAnySideTrailSegment(player) {
    return getVisibleSegments(player.trailLeftSegments).length > 0
        || getVisibleSegments(player.trailRightSegments).length > 0;
}

function getVisibleSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments.filter(segment => Array.isArray(segment) && segment.length >= 2);
}

function createTrailBoundaryCapturePoints(sidePoints, boundaryPath) {
    const finiteSidePoints = getFinitePoints(sidePoints);

    if (finiteSidePoints.length < 2 || boundaryPath.length < 2) {
        return [];
    }

    const lastSidePoint = finiteSidePoints[finiteSidePoints.length - 1];
    const boundaryPoints = arePointsEqual(lastSidePoint, boundaryPath[0])
        ? boundaryPath.slice(1)
        : boundaryPath;
    const points = finiteSidePoints.concat(boundaryPoints);

    return removeConsecutiveDuplicatePoints(points);
}

function createTrailCandidateFromPoints(points) {
    if (points.length < config.territory.minCaptureTrailPoints) {
        return null;
    }

    const polygon = createPolygonFromPoints(points);
    const area = calculatePolygonArea(polygon);

    if (area <= 0) {
        return null;
    }

    return { polygon, area };
}

function createCaptureOperation(
    trail,
    clippedSidePoints,
    startContact,
    endContact,
    boundaryPaths,
    capturedBoundaryPathIndex,
    previewPolygon
) {
    const keepBoundaryPath = boundaryPaths[capturedBoundaryPathIndex];

    if (!keepBoundaryPath || keepBoundaryPath.length < 2 || getPolygonPointCount(previewPolygon) < 4) {
        return null;
    }

    return {
        type: "trailCapture",
        trailGeneration: trail.generation,
        trailSide: trail.side,
        trailSegmentIndex: trail.index,
        trailSegmentLength: trail.points.length,
        trailPoints: clippedSidePoints.map(clonePoint),
        boundaryPathIndex: capturedBoundaryPathIndex,
        startContact: cloneContact(startContact),
        endContact: cloneContact(endContact),
        keepAnchor: createBoundaryPathAnchor(keepBoundaryPath),
        boundaryPathPointCount: keepBoundaryPath.length,
        previewPolygon
    };
}

function storeCaptureOperation(
    territories,
    playerId,
    capture,
    baseVersion,
    changedPlayerIds,
    baseTerritoryPolygon,
    diagnostics
) {
    const territory = territories.get(playerId);

    if (!territory) {
        return;
    }

    storeCaptureAffectedTerritoryIds(territories, territory, playerId, changedPlayerIds);

    if (!changedPlayerIds.has(playerId) || !capture.operation) {
        return;
    }

    const nextVersion = territory.version || 0;

    if (territory.captureOperationUnsafeVersion === nextVersion) {
        delete territory.lastCaptureOperation;
        return;
    }

    if (capture.operation.previewPolygon.length === 0) {
        return;
    }

    if (capture.operation.trailPoints.length > getCaptureOperationMaxTrailPoints()) {
        delete territory.lastCaptureOperation;
        return;
    }

    if (!arePolygonAreasClose(capture.operation.previewPolygon, territory.polygon)) {
        return;
    }

    const replayValidation = validateCaptureOperationReplay(
        capture.operation,
        baseTerritoryPolygon,
        territory.polygon
    );

    if (!replayValidation.valid) {
        addTrailDiagnosticCount(diagnostics, "captureOperationReplayRejected", 1);
        addTrailDiagnosticCount(
            diagnostics,
            getCaptureOperationReplayRejectionCounter(replayValidation.reason),
            1
        );
        delete territory.lastCaptureOperation;
        return;
    }

    addTrailDiagnosticCount(diagnostics, "captureOperationReplayAccepted", 1);

    territory.lastCaptureOperation = {
        type: "trailCapture",
        baseVersion,
        version: nextVersion,
        trailGeneration: capture.operation.trailGeneration,
        trailSide: capture.operation.trailSide,
        trailSegmentIndex: capture.operation.trailSegmentIndex,
        trailSegmentLength: capture.operation.trailSegmentLength,
        trailPoints: capture.operation.trailPoints,
        boundaryPathIndex: capture.operation.boundaryPathIndex,
        startContact: capture.operation.startContact,
        endContact: capture.operation.endContact,
        keepAnchor: capture.operation.keepAnchor
    };
}

function getCaptureOperationMaxTrailPoints() {
    const configuredLimit = Number(config.network.captureOperationMaxTrailPoints);

    return Number.isInteger(configuredLimit) && configuredLimit >= 2
        ? configuredLimit
        : Math.max(512, Number(config.network.trailUpdateMaxPoints) || 512) * 4;
}

function storeCaptureAffectedTerritoryIds(territories, territory, playerId, changedPlayerIds) {
    if (!changedPlayerIds || !changedPlayerIds.has(playerId)) {
        delete territory.captureAffectedTerritoryIds;
        return;
    }

    const affectedIds = [...changedPlayerIds]
        .filter(affectedId => affectedId !== playerId && territories.has(affectedId));

    if (affectedIds.length <= 0) {
        delete territory.captureAffectedTerritoryIds;
        return;
    }

    territory.captureAffectedTerritoryIds = affectedIds;
}

function validateCaptureOperationReplay(operation, basePolygon, finalPolygon) {
    const replayPolygon = createCaptureOperationReplayPolygon(operation, basePolygon);

    if (getPolygonPointCount(replayPolygon) < 4) {
        return {
            valid: false,
            reason: "invalid_replay_polygon"
        };
    }

    if (!areReplayPolygonAreasClose(replayPolygon, finalPolygon)) {
        return {
            valid: false,
            reason: "area_mismatch"
        };
    }

    return {
        valid: true
    };
}

function createCaptureOperationReplayPolygon(operation, basePolygon) {
    const ring = createPackedPointRing(basePolygon && basePolygon[0]);

    if (!operation || ring.length < 3) {
        return [];
    }

    const replayOperation = createClientReplayOperation(operation);

    if (!replayOperation.startContact
        || !replayOperation.endContact
        || !replayOperation.keepAnchor
        || replayOperation.trailPoints.length < 2) {
        return [];
    }

    const localStartContact = getLocalReplayBoundaryContact(ring, replayOperation.startContact);
    const localEndContact = getLocalReplayBoundaryContact(ring, replayOperation.endContact);

    if (!localStartContact || !localEndContact) {
        return [];
    }

    const boundaryPath = getReplayCaptureBoundaryPath(
        ring,
        localEndContact,
        localStartContact,
        replayOperation
    );

    if (!boundaryPath || boundaryPath.length < 2) {
        return [];
    }

    const trailPoints = createReplayClippedTrailPoints(
        replayOperation.trailPoints,
        replayOperation.trailSegmentLength,
        localStartContact.point,
        localEndContact.point
    );

    // Capture candidates are cheap to build under the simple-ring invariant,
    // but an operation sent over the network must prove that invariant after
    // coordinate packing. Otherwise the client would correctly reject it and
    // request geometry recovery.
    return createPolygonFromPoints(trailPoints.concat(boundaryPath));
}

function createPackedPointRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    return ring
        .filter(point => (
            Array.isArray(point)
            && Number.isFinite(point[0])
            && Number.isFinite(point[1])
        ))
        .map(point => ({
            x: packReplayCoordinate(point[0]),
            y: packReplayCoordinate(point[1])
        }));
}

function createClientReplayOperation(operation) {
    return {
        trailSegmentLength: operation.trailSegmentLength,
        trailPoints: getFinitePoints(operation.trailPoints).map(packReplayPoint),
        boundaryPathIndex: operation.boundaryPathIndex,
        startContact: packReplayContact(operation.startContact),
        endContact: packReplayContact(operation.endContact),
        keepAnchor: packReplayPoint(operation.keepAnchor)
    };
}

function packReplayContact(contact) {
    if (!contact || !contact.point) {
        return null;
    }

    return {
        point: packReplayPoint(contact.point),
        segmentIndex: Number.isInteger(contact.segmentIndex) ? contact.segmentIndex : null,
        segmentT: Number.isFinite(contact.segmentT)
            ? roundToPrecision(contact.segmentT, config.network.anglePrecision)
            : null
    };
}

function packReplayPoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return null;
    }

    return {
        x: packReplayCoordinate(point.x),
        y: packReplayCoordinate(point.y)
    };
}

function packReplayCoordinate(value) {
    return roundToPrecision(value, config.network.coordinatePrecision);
}

function roundToPrecision(value, precision) {
    const safePrecision = Number.isFinite(precision) && precision > 0 ? precision : 1;

    return Math.round(value * safePrecision) / safePrecision;
}

function getLocalReplayBoundaryContact(ring, contact) {
    const indexedContact = createIndexedReplayBoundaryContact(ring, contact);

    if (indexedContact) {
        return indexedContact;
    }

    return findClosestReplayBoundaryContact(ring, contact.point);
}

function createIndexedReplayBoundaryContact(ring, contact) {
    if (!contact
        || !Array.isArray(ring)
        || !Number.isInteger(contact.segmentIndex)
        || !Number.isFinite(contact.segmentT)) {
        return null;
    }

    const openRingLength = getOpenPointRingLength(ring);

    if (contact.segmentIndex < 0 || contact.segmentIndex >= openRingLength) {
        return null;
    }

    const segmentStart = ring[contact.segmentIndex];
    const segmentEnd = ring[(contact.segmentIndex + 1) % openRingLength];
    const projection = projectReplayPointOnSegment(contact.point, segmentStart, segmentEnd);
    const maxDistanceSquared = Number.isFinite(config.network.captureOperationIndexedBoundaryMaxDistanceSquared)
        ? config.network.captureOperationIndexedBoundaryMaxDistanceSquared
        : 4;

    if (projection.distanceSquared > maxDistanceSquared) {
        return null;
    }

    return {
        point: projection.point,
        segmentIndex: contact.segmentIndex,
        segmentT: projection.segmentT
    };
}

function findClosestReplayBoundaryContact(ring, point) {
    const openRingLength = getOpenPointRingLength(ring);
    let closestContact = null;

    for (let segmentIndex = 0; segmentIndex < openRingLength; segmentIndex++) {
        const projection = projectReplayPointOnSegment(
            point,
            ring[segmentIndex],
            ring[(segmentIndex + 1) % openRingLength]
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

function getReplayCaptureBoundaryPath(ring, startContact, endContact, operation) {
    if (Number.isInteger(operation.boundaryPathIndex)) {
        const indexedPath = createReplayBoundaryPathByIndex(
            ring,
            startContact,
            endContact,
            operation.boundaryPathIndex
        );

        if (indexedPath && isReplayBoundaryPathConsistentWithAnchor(indexedPath, operation.keepAnchor)) {
            return indexedPath;
        }
    }

    return selectBoundaryPathByAnchor(
        createReplayBoundaryPaths(ring, startContact, endContact),
        operation.keepAnchor
    );
}

function createReplayBoundaryPathByIndex(ring, startContact, endContact, pathIndex) {
    if (pathIndex === 0) {
        return removeConsecutiveDuplicatePoints(createReplayForwardBoundaryPath(ring, startContact, endContact));
    }

    if (pathIndex === 1) {
        return removeConsecutiveDuplicatePoints(createReplayForwardBoundaryPath(ring, endContact, startContact).reverse());
    }

    return null;
}

function createReplayBoundaryPaths(ring, startContact, endContact) {
    return [
        removeConsecutiveDuplicatePoints(createReplayForwardBoundaryPath(ring, startContact, endContact)),
        removeConsecutiveDuplicatePoints(createReplayForwardBoundaryPath(ring, endContact, startContact).reverse())
    ].filter(path => path.length >= 2);
}

function createReplayForwardBoundaryPath(ring, startContact, endContact) {
    const openRingLength = getOpenPointRingLength(ring);

    if (!startContact || !endContact || openRingLength < 3) {
        return [];
    }

    if (startContact.segmentIndex === endContact.segmentIndex
        && endContact.segmentT >= startContact.segmentT) {
        return [startContact.point, endContact.point];
    }

    const path = [startContact.point];
    let vertexIndex = (startContact.segmentIndex + 1) % openRingLength;
    let guard = 0;

    while (guard <= openRingLength) {
        path.push(ring[vertexIndex]);

        if (vertexIndex === endContact.segmentIndex) {
            break;
        }

        vertexIndex = (vertexIndex + 1) % openRingLength;
        guard++;
    }

    path.push(endContact.point);

    return path;
}

function isReplayBoundaryPathConsistentWithAnchor(path, anchor) {
    if (!Array.isArray(path) || path.length < 2 || !anchor) {
        return false;
    }

    if (path.length > 2) {
        return getReplayDistanceSquared(path[1], anchor) <= 4;
    }

    return getReplayPointPathDistanceSquared(anchor, path) <= 4;
}

function selectBoundaryPathByAnchor(paths, anchor) {
    let selectedPath = null;
    let selectedDistance = Infinity;

    for (const path of paths || []) {
        const distance = getReplayPointPathDistanceSquared(anchor, path);

        if (distance < selectedDistance) {
            selectedDistance = distance;
            selectedPath = path;
        }
    }

    return selectedPath && Number.isFinite(selectedDistance) ? selectedPath : null;
}

function createReplayClippedTrailPoints(sidePoints, expectedLength, startPoint, endPoint) {
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

function getOpenPointRingLength(ring) {
    if (!Array.isArray(ring)) {
        return 0;
    }

    if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
        return ring.length - 1;
    }

    return ring.length;
}

function projectReplayPointOnSegment(point, segmentStart, segmentEnd) {
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
        distanceSquared: getReplayDistanceSquared(point, projectedPoint)
    };
}

function getReplayPointPathDistanceSquared(point, path) {
    let distance = Infinity;

    for (let index = 0; index < path.length - 1; index++) {
        distance = Math.min(distance, projectReplayPointOnSegment(point, path[index], path[index + 1]).distanceSquared);
    }

    return distance;
}

function getReplayDistanceSquared(first, second) {
    const x = first.x - second.x;
    const y = first.y - second.y;

    return x * x + y * y;
}

function dotProduct(first, second) {
    return first.x * second.x + first.y * second.y;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function areReplayPolygonAreasClose(first, second) {
    const firstArea = calculatePolygonArea(first);
    const secondArea = calculatePolygonArea(second);

    return Math.abs(firstArea - secondArea) <= Math.max(10, secondArea * 0.005);
}

function getCaptureOperationReplayRejectionCounter(reason) {
    if (reason === "area_mismatch") {
        return "captureOperationReplayAreaMismatch";
    }

    return "captureOperationReplayInvalid";
}

function getPolygonPointCount(polygon) {
    return (polygon || []).reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0);
}

function createBoundaryPathAnchor(path) {
    if (path.length > 2) {
        return clonePoint(path[1]);
    }

    return {
        x: (path[0].x + path[path.length - 1].x) / 2,
        y: (path[0].y + path[path.length - 1].y) / 2
    };
}

function cloneContact(contact) {
    return {
        point: clonePoint(contact.point),
        segmentIndex: contact.segmentIndex,
        segmentT: contact.segmentT
    };
}

function arePolygonAreasClose(first, second) {
    const firstArea = calculatePolygonArea(first);
    const secondArea = calculatePolygonArea(second);

    return Math.abs(firstArea - secondArea) <= Math.max(1, secondArea * 0.001);
}

function createBoundaryPaths(ring, startContact, endContact) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 3) {
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

function getOpenRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    if (ring.length > 1 && areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        return ring.slice(0, -1);
    }

    return ring.slice();
}

function getFinitePoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(point => ({
            x: point.x,
            y: point.y
        }));
}

function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
}

function createBorderSnappedSidePoints(sidePoints, startPoint, endPoint) {
    return removeConsecutiveDuplicatePoints([
        startPoint,
        ...sidePoints.slice(1, -1),
        endPoint
    ]);
}

function isLargerAreaCandidate(candidate, bestCandidate) {
    return !bestCandidate || candidate.area > bestCandidate.area + geometryEpsilon;
}

function coordinatesToPoint(coordinates) {
    return {
        x: coordinates[0],
        y: coordinates[1]
    };
}

function clonePoint(point) {
    return {
        x: point.x,
        y: point.y
    };
}

function clonePolygon(polygon) {
    if (!Array.isArray(polygon)) {
        return [];
    }

    return polygon.map(ring => (
        Array.isArray(ring)
            ? ring.map(coordinates => [coordinates[0], coordinates[1]])
            : []
    ));
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

function areCoordinatesEqual(first, second) {
    return first[0] === second[0] && first[1] === second[1];
}

module.exports = {
    captureClosedTrail,
    createExternalTrailCapturePolygon
};
