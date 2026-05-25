const config = require("../config/gameConfig");
const {
    applyCapturedPolygon,
    getPlayerTerritoryPolygon
} = require("../state/territories");
const {
    calculatePolygonArea,
    createKnownSimplePolygonFromPoints,
    findClosestPolygonBoundaryContact
} = require("../utils/geometry");
const { getHighResolutionTime, getServerTime } = require("../utils/time");
const { relocatePlayersAfterTerritoryChange } = require("./territoryRespawnSystem");

const geometryEpsilon = 1e-7;
let nextCaptureTraceSequence = 1;

function captureClosedTrail(player, territories, players) {
    const captureTrace = createCaptureTrace(player);
    const capture = createExternalTrailCapture(player, territories, captureTrace);

    if (!capture) {
        return null;
    }

    const territory = territories.get(player.id);
    const baseVersion = territory ? territory.version || 0 : 0;
    const applyStartedAt = getHighResolutionTime();
    const changedPlayerIds = applyCapturedPolygon(territories, player.id, capture.polygon, {
        ownerPolygon: capture.operation && capture.operation.previewPolygon
    });

    recordCaptureTraceDuration(captureTrace, "serverApplyMs", applyStartedAt);

    const storeStartedAt = getHighResolutionTime();
    storeCaptureOperation(territories, player.id, capture, baseVersion, changedPlayerIds, captureTrace);
    recordCaptureTraceDuration(captureTrace, "storeMs", storeStartedAt);

    const relocationPlayerIds = new Set(changedPlayerIds);
    relocationPlayerIds.delete(player.id);

    const relocationStartedAt = getHighResolutionTime();
    relocatePlayersAfterTerritoryChange(players, territories, relocationPlayerIds);
    recordCaptureTraceDuration(captureTrace, "relocationMs", relocationStartedAt);
    finishCaptureTrace(captureTrace, capture, changedPlayerIds);

    return capture.polygon;
}

function createExternalTrailCapturePolygon(player, territories) {
    const capture = createExternalTrailCapture(player, territories);

    return capture ? capture.polygon : null;
}

function createExternalTrailCapture(player, territories, captureTrace = null) {
    const calculationStartedAt = getHighResolutionTime();

    const hasTrail = timeCaptureCalculationStep(
        captureTrace,
        "hasAnySideTrailSegment",
        () => hasAnySideTrailSegment(player)
    );

    if (!hasTrail) {
        return null;
    }

    const currentTerritory = timeCaptureCalculationStep(
        captureTrace,
        "getPlayerTerritoryPolygon",
        () => getPlayerTerritoryPolygon(territories, player.id),
        polygon => ({
            territoryPointCount: getPolygonPointCount(polygon)
        })
    );
    const candidates = timeCaptureCalculationStep(
        captureTrace,
        "createTrailCaptureCandidates.total",
        () => createTrailCaptureCandidates(player, currentTerritory, captureTrace),
        createdCandidates => ({
            candidateCount: createdCandidates.length,
            territoryPointCount: getPolygonPointCount(currentTerritory)
        })
    );
    const bestCandidate = timeCaptureCalculationStep(
        captureTrace,
        "selectBestCaptureCandidate.total",
        () => selectBestCaptureCandidate(
            currentTerritory,
            candidates,
            config.territory.minCaptureArea,
            captureTrace
        ),
        candidate => ({
            selected: Boolean(candidate),
            candidateCount: candidates.length,
            selectedPointCount: getPolygonPointCount(candidate && candidate.polygon)
        })
    );

    finishCaptureCalculationTrace(captureTrace, currentTerritory, candidates, bestCandidate, calculationStartedAt);

    if (!bestCandidate) {
        return null;
    }

    return bestCandidate;
}

function selectBestCaptureCandidate(currentTerritory, candidates, minAddedArea, captureTrace = null) {
    const currentArea = timeCaptureCalculationStep(
        captureTrace,
        "select.calculateCurrentArea",
        () => calculatePolygonArea(currentTerritory),
        () => ({
            territoryPointCount: getPolygonPointCount(currentTerritory)
        })
    );
    let bestCandidate = null;

    for (const candidate of candidates) {
        const rankedCandidate = timeCaptureCalculationStep(
            captureTrace,
            "select.rankCandidate.total",
            () => rankCaptureCandidate(currentArea, candidate, captureTrace),
            ranked => ({
                candidatePointCount: getPolygonPointCount(candidate.polygon),
                addedArea: ranked && ranked.addedArea
            })
        );

        if (rankedCandidate.addedArea < minAddedArea) {
            continue;
        }

        if (!bestCandidate || isBetterCaptureCandidate(rankedCandidate, bestCandidate)) {
            bestCandidate = rankedCandidate;
        }
    }

    return bestCandidate;
}

function rankCaptureCandidate(currentArea, candidate, captureTrace = null) {
    const candidateArea = timeCaptureCalculationStep(
        captureTrace,
        "rank.useCandidateArea",
        () => candidate.area,
        () => ({
            candidatePointCount: getPolygonPointCount(candidate.polygon)
        })
    );
    const addedArea = timeCaptureCalculationStep(
        captureTrace,
        "rank.calculateAddedArea",
        () => candidateArea - currentArea,
        () => ({
            candidateArea,
            currentArea
        })
    );
    const overlapArea = currentArea;

    return {
        ...candidate,
        addedArea,
        overlapArea
    };
}

function isBetterCaptureCandidate(candidate, bestCandidate) {
    if (Math.abs(candidate.addedArea - bestCandidate.addedArea) > geometryEpsilon) {
        return candidate.addedArea > bestCandidate.addedArea;
    }

    return candidate.overlapArea < bestCandidate.overlapArea;
}

function createTrailCaptureCandidates(player, territoryPolygon, captureTrace = null) {
    const candidates = [];
    const trails = timeCaptureCalculationStep(
        captureTrace,
        "candidates.getTrailSegments",
        () => getTrailSegments(player),
        segments => ({
            segmentCount: segments.length
        })
    );

    for (const trail of trails) {
        const segmentCandidates = timeCaptureCalculationStep(
            captureTrace,
            "candidates.segment.total",
            () => createTrailCaptureCandidatesFromSegment(trail, territoryPolygon, captureTrace),
            result => ({
                trailSide: trail.side,
                trailSegmentIndex: trail.index,
                trailPointCount: Array.isArray(trail.points) ? trail.points.length : 0,
                candidateCount: result.length
            })
        );

        candidates.push(...segmentCandidates);
    }

    return candidates;
}

function createTrailCaptureCandidatesFromSegment(trail, territoryPolygon, captureTrace = null) {
    const candidates = [];
    const finiteSidePoints = timeCaptureCalculationStep(
        captureTrace,
        "segment.getFinitePoints",
        () => getFinitePoints(trail.points),
        points => ({
            trailSide: trail.side,
            trailSegmentIndex: trail.index,
            inputPointCount: Array.isArray(trail.points) ? trail.points.length : 0,
            outputPointCount: points.length
        })
    );

    if (finiteSidePoints.length < 2) {
        return candidates;
    }

    const startContact = timeCaptureCalculationStep(
        captureTrace,
        "segment.findStartBoundaryContact",
        () => findClosestPolygonBoundaryContact(territoryPolygon, finiteSidePoints[0]),
        () => ({
            trailSide: trail.side,
            trailSegmentIndex: trail.index,
            territoryPointCount: getPolygonPointCount(territoryPolygon)
        })
    );
    const endContact = timeCaptureCalculationStep(
        captureTrace,
        "segment.findEndBoundaryContact",
        () => findClosestPolygonBoundaryContact(territoryPolygon, finiteSidePoints[finiteSidePoints.length - 1]),
        () => ({
            trailSide: trail.side,
            trailSegmentIndex: trail.index,
            territoryPointCount: getPolygonPointCount(territoryPolygon)
        })
    );

    if (!startContact || !endContact) {
        return candidates;
    }

    const clippedSidePoints = timeCaptureCalculationStep(
        captureTrace,
        "segment.createBorderSnappedSidePoints",
        () => createBorderSnappedSidePoints(
            finiteSidePoints,
            startContact.point,
            endContact.point
        ),
        points => ({
            trailSide: trail.side,
            trailSegmentIndex: trail.index,
            pointCount: points.length
        })
    );
    const boundaryPaths = timeCaptureCalculationStep(
        captureTrace,
        "segment.createBoundaryPaths",
        () => createBoundaryPaths(territoryPolygon[0], endContact, startContact, captureTrace),
        paths => ({
            trailSide: trail.side,
            trailSegmentIndex: trail.index,
            pathCount: paths.length,
            maxPathPointCount: getMaxPathPointCount(paths),
            territoryPointCount: getPolygonPointCount(territoryPolygon)
        })
    );
    let bestCandidate = null;

    for (let boundaryPathIndex = 0; boundaryPathIndex < boundaryPaths.length; boundaryPathIndex++) {
        const boundaryPath = boundaryPaths[boundaryPathIndex];
        const points = timeCaptureCalculationStep(
            captureTrace,
            "candidate.createTrailBoundaryPoints",
            () => createTrailBoundaryCapturePoints(clippedSidePoints, boundaryPath),
            result => ({
                trailSide: trail.side,
                trailSegmentIndex: trail.index,
                boundaryPathIndex,
                boundaryPathPointCount: boundaryPath.length,
                resultPointCount: result.length
            })
        );
        const candidate = timeCaptureCalculationStep(
            captureTrace,
            "candidate.createPolygonAndArea",
            () => createTrailCandidateFromPoints(points, captureTrace),
            result => ({
                trailSide: trail.side,
                trailSegmentIndex: trail.index,
                boundaryPathIndex,
                inputPointCount: points.length,
                candidatePointCount: getPolygonPointCount(result && result.polygon),
                area: result && result.area
            })
        );

        if (candidate && isLargerAreaCandidate(candidate, bestCandidate)) {
            bestCandidate = {
                ...candidate,
                operation: timeCaptureCalculationStep(
                    captureTrace,
                    "candidate.createCaptureOperation",
                    () => createCaptureOperation(
                        trail,
                        clippedSidePoints,
                        startContact,
                        endContact,
                        boundaryPaths,
                        boundaryPathIndex,
                        candidate.polygon,
                        captureTrace
                    ),
                    operation => ({
                        trailSide: trail.side,
                        trailSegmentIndex: trail.index,
                        boundaryPathIndex,
                        previewPointCount: getPolygonPointCount(operation && operation.previewPolygon)
                    })
                )
            };
        }
    }

    if (bestCandidate) {
        candidates.push(bestCandidate);
    }

    return candidates;
}

function getTrailSegments(player) {
    return [
        ...getVisibleSegments(player.trailLeftSegments).map((points, index) => ({
            side: "left",
            index,
            points
        })),
        ...getVisibleSegments(player.trailRightSegments).map((points, index) => ({
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

function createTrailCandidateFromPoints(points, captureTrace = null) {
    if (points.length < config.territory.minCaptureTrailPoints) {
        return null;
    }

    const polygon = timeCaptureCalculationStep(
        captureTrace,
        "candidate.createKnownSimplePolygonFromPoints",
        () => createKnownSimplePolygonFromPoints(points),
        result => ({
            inputPointCount: points.length,
            polygonPointCount: getPolygonPointCount(result)
        })
    );

    const area = timeCaptureCalculationStep(
        captureTrace,
        "candidate.calculatePolygonArea",
        () => calculatePolygonArea(polygon),
        () => ({
            polygonPointCount: getPolygonPointCount(polygon)
        })
    );

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
    previewPolygon,
    captureTrace = null
) {
    const keepBoundaryPath = boundaryPaths[capturedBoundaryPathIndex];

    if (!keepBoundaryPath || keepBoundaryPath.length < 2 || getPolygonPointCount(previewPolygon) < 4) {
        return null;
    }

    return {
        type: "trailCapture",
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

function storeCaptureOperation(territories, playerId, capture, baseVersion, changedPlayerIds, captureTrace = null) {
    if (!changedPlayerIds.has(playerId) || !capture.operation) {
        return;
    }

    const territory = territories.get(playerId);

    if (!territory) {
        return;
    }

    const nextVersion = territory.version || 0;

    if (capture.operation.previewPolygon.length === 0) {
        return;
    }

    if (!arePolygonAreasClose(capture.operation.previewPolygon, territory.polygon)) {
        return;
    }

    territory.lastCaptureOperation = {
        type: "trailCapture",
        baseVersion,
        version: nextVersion,
        trailSide: capture.operation.trailSide,
        trailSegmentIndex: capture.operation.trailSegmentIndex,
        trailSegmentLength: capture.operation.trailSegmentLength,
        trailPoints: capture.operation.trailPoints,
        boundaryPathIndex: capture.operation.boundaryPathIndex,
        startContact: capture.operation.startContact,
        endContact: capture.operation.endContact,
        keepAnchor: capture.operation.keepAnchor,
        captureTrace
    };
}

function createCaptureTrace(player) {
    if (config.network.captureTimingDiagnosticsEnabled === false) {
        return null;
    }

    const sequence = nextCaptureTraceSequence++;
    const detectedAt = getServerTime();

    return {
        id: `${detectedAt.toString(36)}-${sequence}`,
        playerId: player.id,
        detectedAt,
        startedAtHr: getHighResolutionTime()
    };
}

function finishCaptureCalculationTrace(captureTrace, currentTerritory, candidates, bestCandidate, startedAt) {
    if (!captureTrace) {
        return;
    }

    captureTrace.calculationMs = getHighResolutionTime() - startedAt;
    captureTrace.baseTerritoryPointCount = getPolygonPointCount(currentTerritory);
    captureTrace.candidateCount = candidates.length;

    if (!bestCandidate) {
        return;
    }

    const operation = bestCandidate.operation || {};

    captureTrace.captureArea = bestCandidate.area;
    captureTrace.addedArea = bestCandidate.addedArea;
    captureTrace.operationTrailPointCount = Array.isArray(operation.trailPoints)
        ? operation.trailPoints.length
        : 0;
    captureTrace.operationBoundaryPathPointCount = Number.isInteger(operation.boundaryPathPointCount)
        ? operation.boundaryPathPointCount
        : 0;
    captureTrace.previewTerritoryPointCount = getPolygonPointCount(operation.previewPolygon);
}

function finishCaptureTrace(captureTrace, capture, changedPlayerIds) {
    if (!captureTrace) {
        return;
    }

    captureTrace.completedAt = getServerTime();
    captureTrace.totalMs = getHighResolutionTime() - captureTrace.startedAtHr;
    captureTrace.changedPlayerCount = changedPlayerIds.size;
    captureTrace.finalCapturedPointCount = getPolygonPointCount(capture && capture.polygon);

    delete captureTrace.startedAtHr;
}

function recordCaptureTraceDuration(captureTrace, key, startedAt) {
    if (!captureTrace) {
        return;
    }

    captureTrace[key] = getHighResolutionTime() - startedAt;
}

function timeCaptureCalculationStep(captureTrace, name, callback, createDetails = null) {
    if (!captureTrace) {
        return callback();
    }

    const startedAt = getHighResolutionTime();
    const result = callback();
    const elapsedMs = getHighResolutionTime() - startedAt;
    const details = typeof createDetails === "function"
        ? createDetails(result)
        : createDetails;

    recordCaptureCalculationStep(captureTrace, name, elapsedMs, details);

    return result;
}

function recordCaptureCalculationStep(captureTrace, name, elapsedMs, details = null) {
    if (!captureTrace || !name || !Number.isFinite(elapsedMs)) {
        return;
    }

    if (!captureTrace.calculationBreakdown) {
        captureTrace.calculationBreakdown = {};
    }

    const existingStep = captureTrace.calculationBreakdown[name] || {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        maxDetails: null
    };

    existingStep.count++;
    existingStep.totalMs += elapsedMs;

    if (elapsedMs >= existingStep.maxMs) {
        existingStep.maxMs = elapsedMs;
        existingStep.maxDetails = sanitizeCalculationDetails(details);
    }

    captureTrace.calculationBreakdown[name] = existingStep;
}

function sanitizeCalculationDetails(details) {
    if (!details || typeof details !== "object") {
        return null;
    }

    const sanitized = {};

    for (const [key, value] of Object.entries(details)) {
        if (Number.isFinite(value)) {
            sanitized[key] = Math.round(value * 1000) / 1000;
            continue;
        }

        if (typeof value === "string" || typeof value === "boolean") {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

function getPolygonPointCount(polygon) {
    return (polygon || []).reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0);
}

function getMaxPathPointCount(paths) {
    return (paths || []).reduce((max, path) => (
        Math.max(max, Array.isArray(path) ? path.length : 0)
    ), 0);
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

function createBoundaryPaths(ring, startContact, endContact, captureTrace = null) {
    const openRing = timeCaptureCalculationStep(
        captureTrace,
        "boundary.getOpenRing",
        () => getOpenRing(ring),
        result => ({
            ringPointCount: Array.isArray(ring) ? ring.length : 0,
            openRingPointCount: result.length
        })
    );

    if (openRing.length < 3) {
        return [];
    }

    const forwardPath = timeCaptureCalculationStep(
        captureTrace,
        "boundary.createForwardPath",
        () => createForwardBoundaryPath(openRing, startContact, endContact),
        result => ({
            pathPointCount: result.length,
            openRingPointCount: openRing.length
        })
    );
    const reversePath = timeCaptureCalculationStep(
        captureTrace,
        "boundary.createReversePath",
        () => createForwardBoundaryPath(openRing, endContact, startContact).reverse(),
        result => ({
            pathPointCount: result.length,
            openRingPointCount: openRing.length
        })
    );

    return timeCaptureCalculationStep(
        captureTrace,
        "boundary.dedupePaths",
        () => [
            removeConsecutiveDuplicatePoints(forwardPath),
            removeConsecutiveDuplicatePoints(reversePath)
        ].filter(path => path.length >= 2),
        result => ({
            pathCount: result.length,
            maxPathPointCount: getMaxPathPointCount(result)
        })
    );
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
