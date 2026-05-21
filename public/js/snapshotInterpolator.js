import { clamp, lerp, lerpAngle } from "./sharedMath.js";

const coordinatePrecision = 1000;
const geometryEpsilon = 1e-7;

export function createSnapshotInterpolator(networkConfig, options = {}) {
    const snapshots = [];
    const entityCache = {
        playerInfo: {},
        territories: {},
        territoryPoints: {},
        trails: {}
    };
    const networkState = {
        bufferMs: networkConfig.initialBufferMs,
        serverOffset: 0,
        lastSnapshotReceivedAt: performance.now(),
        deltas: []
    };
    const debugState = {
        visiblePlayers: 0,
        visibleTerritories: 0,
        visibleTrails: 0
    };
    const pendingTerritoryOperations = new Map();
    const suppressedCaptureOperationResyncIds = new Set();
    let lastResyncRequestedAt = Number.NEGATIVE_INFINITY;

    return {
        getDebugState,
        getRenderState,
        processSnapshot
    };

    function processSnapshot(rawSnapshot) {
        const now = performance.now();
        const applyResult = createApplyResult();
        const snapshot = expandSnapshot(rawSnapshot, applyResult);

        updateAdaptiveBuffer(now);
        syncServerClock(snapshot.time);
        saveSnapshot(snapshot);

        return applyResult;
    }

    function getRenderState() {
        if (snapshots.length === 0) {
            return null;
        }

        if (snapshots.length === 1) {
            return createRenderState(snapshots[0], snapshots[0].players);
        }

        const serverNow = Date.now() - networkState.serverOffset;
        const renderTime = serverNow - networkState.bufferMs;
        const { previous, next } = findSnapshotPair(renderTime);
        const interval = next.time - previous.time || 1;
        const amount = clamp((renderTime - previous.time) / interval, 0, 1);

        return createInterpolatedRenderState(
            previous,
            next,
            interpolatePlayers(previous, next, amount)
        );
    }

    function getDebugState() {
        return {
            bufferMs: networkState.bufferMs,
            snapshotCount: snapshots.length,
            visiblePlayers: debugState.visiblePlayers,
            visibleTerritories: debugState.visibleTerritories,
            visibleTrails: debugState.visibleTrails
        };
    }

    function createApplyResult() {
        return {
            applied: true,
            invalidations: {
                playerInfo: [],
                territories: [],
                trails: []
            }
        };
    }

    function markCacheInvalid(applyResult, type, id) {
        if (!applyResult || !applyResult.invalidations || !id) {
            return;
        }

        const ids = applyResult.invalidations[type];

        if (!ids || ids.includes(id)) {
            applyResult.applied = false;
            return;
        }

        ids.push(id);
        applyResult.applied = false;
    }

    function expandSnapshot(rawSnapshot, applyResult) {
        if (rawSnapshot && rawSnapshot.schema === 2) {
            return expandCompactSnapshot(rawSnapshot, applyResult);
        }

        return expandLegacySnapshot(rawSnapshot);
    }

    function expandCompactSnapshot(rawSnapshot, applyResult) {
        updatePlayerInfoCache(rawSnapshot.playerInfo);
        updateTerritoryCache(rawSnapshot.territories, applyResult);
        updateTrailCache(rawSnapshot.trails, applyResult);
        const activeTrailIds = new Set(rawSnapshot.trailIds || []);
        const failedTerritoryOperationIds = updateTerritoryOperations(rawSnapshot.territoryOps, activeTrailIds, applyResult);
        const ignoredTerritoryResyncIds = createIgnoredTerritoryResyncIds(failedTerritoryOperationIds);

        const players = expandPlayers(rawSnapshot.players, rawSnapshot.debug);
        const territories = selectCachedEntities(entityCache.territories, rawSnapshot.territoryIds);
        const trails = rawSnapshot.preserveTrails
            ? getPreviousSnapshotEntities("trails")
            : selectCachedEntities(entityCache.trails, rawSnapshot.trailIds);

        requestRecoveryForMissingCachedEntities(rawSnapshot.territoryIds, territories, "territories", applyResult, ignoredTerritoryResyncIds);
        requestRecoveryForStaleCachedVersions(rawSnapshot.territoryVersions, territories, applyResult, ignoredTerritoryResyncIds);

        if (!rawSnapshot.preserveTrails) {
            requestRecoveryForMissingCachedEntities(rawSnapshot.trailIds, trails, "trails", applyResult);
        }

        debugState.visiblePlayers = Object.keys(players).length;
        debugState.visibleTerritories = Object.keys(territories).length;
        debugState.visibleTrails = Object.keys(trails).length;

        return {
            time: rawSnapshot.time,
            players,
            territories,
            trails
        };
    }

    function expandLegacySnapshot(rawSnapshot) {
        const snapshot = rawSnapshot || {
            time: Date.now(),
            players: {},
            territories: {},
            trails: {}
        };

        debugState.visiblePlayers = Object.keys(snapshot.players || {}).length;
        debugState.visibleTerritories = Object.keys(snapshot.territories || {}).length;
        debugState.visibleTrails = Object.keys(snapshot.trails || {}).length;

        return {
            time: snapshot.time,
            players: snapshot.players || {},
            territories: snapshot.territories || {},
            trails: snapshot.trails || {}
        };
    }

    function updateAdaptiveBuffer(now) {
        const delta = now - networkState.lastSnapshotReceivedAt;
        networkState.lastSnapshotReceivedAt = now;
        networkState.deltas.push(delta);

        if (networkState.deltas.length > networkConfig.maxJitterSamples) {
            networkState.deltas.shift();
        }

        const average = calculateAverage(networkState.deltas);
        const jitter = calculateStandardDeviation(networkState.deltas, average);
        const nextBuffer = average + jitter * networkConfig.jitterMultiplier;

        networkState.bufferMs = clamp(
            nextBuffer,
            networkConfig.minBufferMs,
            networkConfig.maxBufferMs
        );
    }

    function syncServerClock(serverTime) {
        const nextOffset = Date.now() - serverTime;
        networkState.serverOffset = networkState.serverOffset * 0.9 + nextOffset * 0.1;
    }

    function saveSnapshot(snapshot) {
        snapshots.push(snapshot);

        while (snapshots.length > networkConfig.maxSnapshots) {
            snapshots.shift();
        }
    }

    function findSnapshotPair(renderTime) {
        let previous = snapshots[0];
        let next = snapshots[1];

        if (renderTime <= previous.time) {
            return { previous, next };
        }

        for (let index = 0; index < snapshots.length - 1; index++) {
            previous = snapshots[index];
            next = snapshots[index + 1];

            if (previous.time <= renderTime && next.time >= renderTime) {
                return { previous, next };
            }
        }

        return { previous, next };
    }

    function interpolatePlayers(previous, next, amount) {
        const renderedPlayers = {};
        const ids = new Set([
            ...Object.keys(previous.players),
            ...Object.keys(next.players)
        ]);

        for (const id of ids) {
            const previousPlayer = previous.players[id];
            const nextPlayer = next.players[id];

            if (!previousPlayer && nextPlayer) {
                renderedPlayers[id] = nextPlayer;
                continue;
            }

            if (previousPlayer && !nextPlayer) {
                continue;
            }

            renderedPlayers[id] = {
                ...nextPlayer,
                x: lerp(previousPlayer.x, nextPlayer.x, amount),
                y: lerp(previousPlayer.y, nextPlayer.y, amount),
                angle: lerpAngle(previousPlayer.angle, nextPlayer.angle, amount)
            };
        }

        return renderedPlayers;
    }

    function createRenderState(snapshot, players) {
        return {
            players,
            territories: snapshot.territories,
            trails: snapshot.trails
        };
    }

    function createInterpolatedRenderState(previous, next, players) {
        return {
            players,
            territories: next.territories,
            trails: previous.trails
        };
    }

    function updatePlayerInfoCache(playerInfo) {
        for (const [id, info] of Object.entries(playerInfo || {})) {
            entityCache.playerInfo[id] = {
                color: info[0],
                territoryX: info[1],
                territoryY: info[2],
                version: info[3]
            };
        }
    }

    function updateTerritoryCache(territories, applyResult) {
        for (const [id, territory] of Object.entries(territories || {})) {
            const base = territory.base || [0, 0];
            const polygon = unpackTerritoryPolygon(territory.polygon);

            if (!polygon) {
                markCacheInvalid(applyResult, "territories", id);
                continue;
            }

            entityCache.territories[id] = {
                id,
                color: territory.color,
                version: territory.version,
                baseX: base[0],
                baseY: base[1],
                polygon
            };
            suppressedCaptureOperationResyncIds.delete(id);
        }
    }

    function updateTerritoryOperations(operations, activeTrailIds, applyResult) {
        const failedIds = new Set();

        for (const [id, operation] of Object.entries(operations || {})) {
            if (shouldDeferTerritoryOperation(id, operation, activeTrailIds)) {
                pendingTerritoryOperations.set(id, operation);
                continue;
            }

            if (!applyCaptureTerritoryOperation(id, operation)) {
                failedIds.add(id);
                markCacheInvalid(applyResult, "territories", id);
                handleCaptureOperationFailure(id);
                continue;
            }

            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
        }

        applyPendingTerritoryOperations(activeTrailIds, applyResult, failedIds);

        return failedIds;
    }

    function shouldDeferTerritoryOperation(id, operation, activeTrailIds) {
        return operation
            && operation.type === "trailCapture"
            && activeTrailIds.has(id)
            && !hasFallbackTrailPoints(operation);
    }

    function applyPendingTerritoryOperations(activeTrailIds, applyResult, failedIds) {
        for (const [id, operation] of pendingTerritoryOperations.entries()) {
            if (activeTrailIds.has(id)) {
                continue;
            }

            if (!applyCaptureTerritoryOperation(id, operation)) {
                failedIds.add(id);
                markCacheInvalid(applyResult, "territories", id);
                handleCaptureOperationFailure(id);
                continue;
            }

            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
        }
    }

    function applyCaptureTerritoryOperation(id, operation) {
        if (!operation || operation.type !== "trailCapture") {
            return false;
        }

        const territory = entityCache.territories[id];

        if (!territory || territory.version !== operation.baseVersion) {
            return false;
        }

        const trailSegment = getCaptureTrailSegment(id, operation);
        const startContact = unpackCaptureContact(operation.startContact);
        const endContact = unpackCaptureContact(operation.endContact);
        const keepAnchor = unpackPoint(operation.keepAnchor);

        if (!trailSegment || !startContact || !endContact || !keepAnchor) {
            return false;
        }

        const ring = territory.polygon && territory.polygon.rings && territory.polygon.rings[0];
        const localStartContact = findClosestPolygonBoundaryContact(ring, startContact.point);
        const localEndContact = findClosestPolygonBoundaryContact(ring, endContact.point);

        if (!localStartContact || !localEndContact) {
            return false;
        }

        const boundaryPath = selectBoundaryPathByAnchor(
            createBoundaryPaths(ring, localEndContact, localStartContact),
            keepAnchor
        );

        if (!boundaryPath) {
            return false;
        }

        const trailPoints = createClippedTrailPoints(
            trailSegment,
            operation.trailSegmentLength,
            localStartContact.point,
            localEndContact.point
        );
        const nextRing = normalizePolygonRing(trailPoints.concat(boundaryPath));

        if (nextRing.length < 4) {
            return false;
        }

        entityCache.territories[id] = {
            ...territory,
            version: operation.version,
            polygon: {
                rings: [nextRing]
            }
        };

        return true;
    }

    function getCaptureTrailSegment(id, operation) {
        const trail = entityCache.trails[id];
        const fallbackPoints = unpackPoints(operation.trailPoints);

        const segments = trail && operation.trailSide === "right"
            ? trail.rightSegments
            : trail && trail.leftSegments;
        const segment = segments && segments[operation.trailSegmentIndex];

        if (canUseCachedTrailSegment(segment, operation)) {
            return segment;
        }

        return fallbackPoints.length >= 2 ? fallbackPoints : null;
    }

    function hasFallbackTrailPoints(operation) {
        return unpackPoints(operation && operation.trailPoints).length >= 2;
    }

    function canUseCachedTrailSegment(segment, operation) {
        return Array.isArray(segment)
            && segment.length >= Math.max(2, operation.trailSegmentLength - 1);
    }

    function unpackCaptureContact(contact) {
        if (!Array.isArray(contact) || contact.length < 2) {
            return null;
        }

        const point = unpackPoint(contact);

        return point ? { point } : null;
    }

    function unpackTerritoryPolygon(polygon) {
        if (!isReferencedPolygon(polygon)) {
            return unpackPolygon(polygon);
        }

        updateTerritoryPointCache(polygon.points);

        let hasMissingPoint = false;
        const rings = (polygon.rings || [])
            .map(ring => (ring || []).map(pointId => {
                const point = entityCache.territoryPoints[pointId];

                if (!point) {
                    hasMissingPoint = true;
                    return null;
                }

                return point;
            }).filter(Boolean))
            .filter(ring => ring.length >= 3);

        return hasMissingPoint ? null : { rings };
    }

    function isReferencedPolygon(polygon) {
        return polygon
            && !Array.isArray(polygon)
            && Array.isArray(polygon.rings);
    }

    function updateTerritoryPointCache(points) {
        for (const point of points || []) {
            if (!Array.isArray(point) || point.length < 3) {
                continue;
            }

            const pointId = point[0];
            const x = point[1];
            const y = point[2];

            if (!Number.isInteger(pointId) || !Number.isFinite(x) || !Number.isFinite(y)) {
                continue;
            }

            entityCache.territoryPoints[pointId] = {
                x,
                y
            };
        }
    }

    function updateTrailCache(trails, applyResult) {
        for (const [id, update] of Object.entries(trails || {})) {
            if (update.full) {
                entityCache.trails[id] = createFullTrail(id, update);
                continue;
            }

            const trail = entityCache.trails[id];
            const patchedTrail = trail && createPatchedTrail(trail, update);

            if (!patchedTrail) {
                markCacheInvalid(applyResult, "trails", id);
                continue;
            }

            entityCache.trails[id] = patchedTrail;
        }
    }

    function expandPlayers(players, debug) {
        const expandedPlayers = {};

        for (const [id, player] of Object.entries(players || {})) {
            const info = entityCache.playerInfo[id] || {};

            expandedPlayers[id] = {
                id,
                x: player[0],
                y: player[1],
                angle: player[2],
                color: info.color || "#f5f7fb",
                territoryX: Number.isFinite(info.territoryX) ? info.territoryX : player[0],
                territoryY: Number.isFinite(info.territoryY) ? info.territoryY : player[1]
            };

            if (debug && debug[id]) {
                expandedPlayers[id].debug = debug[id];
            }
        }

        return expandedPlayers;
    }

    function selectCachedEntities(cache, ids) {
        const selected = {};

        for (const id of ids || []) {
            if (cache[id]) {
                selected[id] = cache[id];
            }
        }

        return selected;
    }

    function getPreviousSnapshotEntities(key) {
        if (snapshots.length === 0) {
            return {};
        }

        return snapshots[snapshots.length - 1][key] || {};
    }

    function requestRecoveryForMissingCachedEntities(ids, selectedEntities, type, applyResult, ignoredIds = new Set()) {
        for (const id of ids || []) {
            if (ignoredIds.has(id)) {
                continue;
            }

            if (!selectedEntities[id]) {
                markCacheInvalid(applyResult, type, id);
            }
        }
    }

    function requestRecoveryForStaleCachedVersions(versions, selectedEntities, applyResult, ignoredIds = new Set()) {
        for (const [id, version] of Object.entries(versions || {})) {
            if (ignoredIds.has(id)) {
                continue;
            }

            const entity = selectedEntities[id];

            if (!entity || entity.version !== version) {
                markCacheInvalid(applyResult, "territories", id);
            }
        }
    }

    function createFullTrail(id, update) {
        const trail = {
            id,
            color: update.color,
            leftSegments: unpackSegments(update.leftSegments),
            rightSegments: unpackSegments(update.rightSegments),
            leftFillPath: unpackPoints(update.leftFillPath),
            rightFillPath: unpackPoints(update.rightFillPath),
            fillPolygon: null
        };

        trail.fillPolygon = createTrailFillPolygon(trail.leftFillPath, trail.rightFillPath);

        return trail;
    }

    function createPatchedTrail(trail, update) {
        const leftSegments = applySegmentPatches(trail.leftSegments, update.leftPatches);
        const rightSegments = applySegmentPatches(trail.rightSegments, update.rightPatches);
        const leftFillPath = appendPathPoints(trail.leftFillPath, update.leftFillPoints, update.leftFillStart);
        const rightFillPath = appendPathPoints(trail.rightFillPath, update.rightFillPoints, update.rightFillStart);

        if (!leftSegments || !rightSegments || !leftFillPath || !rightFillPath) {
            return null;
        }

        return {
            id: trail.id,
            color: update.color || trail.color,
            leftSegments,
            rightSegments,
            leftFillPath,
            rightFillPath,
            fillPolygon: createTrailFillPolygon(leftFillPath, rightFillPath)
        };
    }

    function applySegmentPatches(segments, patches) {
        const nextSegments = (segments || []).map(segment => segment.slice());

        for (const patch of patches || []) {
            if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index > nextSegments.length) {
                return null;
            }

            if (patch.index === nextSegments.length) {
                nextSegments.push([]);
            }

            if (nextSegments[patch.index].length !== patch.start) {
                return null;
            }

            nextSegments[patch.index].push(...unpackPoints(patch.points));
        }

        return nextSegments;
    }

    function appendPathPoints(points, packedPoints, startIndex) {
        const nextPoints = (points || []).slice();

        if (!Array.isArray(packedPoints) || packedPoints.length === 0) {
            return nextPoints;
        }

        if (nextPoints.length !== startIndex) {
            return null;
        }

        nextPoints.push(...unpackPoints(packedPoints));

        return nextPoints;
    }

    function requestResync() {
        const now = performance.now();
        const interval = networkConfig.resyncRequestIntervalMs || 1000;

        if (typeof options.onResyncNeeded !== "function" || now - lastResyncRequestedAt < interval) {
            return;
        }

        lastResyncRequestedAt = now;
        options.onResyncNeeded();
    }

    function createIgnoredTerritoryResyncIds(failedTerritoryOperationIds) {
        return new Set([
            ...suppressedCaptureOperationResyncIds,
            ...pendingTerritoryOperations.keys(),
            ...failedTerritoryOperationIds
        ]);
    }

    function handleCaptureOperationFailure(id) {
        if (networkConfig.captureOperationResyncEnabled === false) {
            suppressedCaptureOperationResyncIds.add(id);
            return;
        }

        requestResync();
    }
}

function unpackPolygon(polygon) {
    return {
        rings: (polygon || [])
            .map(unpackPoints)
            .filter(ring => ring.length >= 3)
    };
}

function unpackSegments(segments) {
    return (segments || [])
        .map(unpackPoints)
        .filter(segment => segment.length >= 2);
}

function unpackPoints(points) {
    return (points || [])
        .map(unpackPoint)
        .filter(Boolean);
}

function unpackPoint(point) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        return null;
    }

    return {
        x: point[0],
        y: point[1]
    };
}

function createTrailFillPolygon(leftPath, rightPath) {
    const ring = leftPath.concat([...rightPath].reverse());

    if (ring.length < 3) {
        return null;
    }

    const closedRing = closeRing(ring);

    return closedRing.length >= 4 ? {
        rings: [closedRing]
    } : null;
}

function closeRing(ring) {
    const points = ring.filter(point => (
        point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y)
    ));

    if (points.length === 0) {
        return [];
    }

    const first = points[0];
    const last = points[points.length - 1];

    if (Math.abs(first.x - last.x) <= Number.EPSILON
        && Math.abs(first.y - last.y) <= Number.EPSILON) {
        return points;
    }

    return points.concat({
        x: first.x,
        y: first.y
    });
}

function createClippedTrailPoints(sidePoints, expectedLength, startPoint, endPoint) {
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
        path.push(openRing[vertexIndex]);

        if (vertexIndex === endContact.segmentIndex) {
            break;
        }

        vertexIndex = (vertexIndex + 1) % openRing.length;
        guard++;
    }

    path.push(endContact.point);

    return path;
}

function selectBoundaryPathByAnchor(paths, anchor) {
    let selectedPath = null;
    let selectedDistance = Infinity;

    for (const path of paths || []) {
        const distance = getPointPathDistanceSquared(anchor, path);

        if (distance < selectedDistance) {
            selectedDistance = distance;
            selectedPath = path;
        }
    }

    return selectedPath && Number.isFinite(selectedDistance) ? selectedPath : null;
}

function getPointPathDistanceSquared(point, path) {
    let distance = Infinity;

    for (let index = 0; index < path.length - 1; index++) {
        distance = Math.min(distance, getPointSegmentDistanceSquared(point, path[index], path[index + 1]));
    }

    return distance;
}

function findClosestPolygonBoundaryContact(ring, point) {
    const openRing = getOpenRing(ring);
    let closestContact = null;

    for (let segmentIndex = 0; segmentIndex < openRing.length; segmentIndex++) {
        const projection = projectPointOnSegment(
            point,
            openRing[segmentIndex],
            openRing[(segmentIndex + 1) % openRing.length]
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

function projectPointOnSegment(point, segmentStart, segmentEnd) {
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
        distanceSquared: getDistanceSquared(point, projectedPoint)
    };
}

function getPointSegmentDistanceSquared(point, segmentStart, segmentEnd) {
    return projectPointOnSegment(point, segmentStart, segmentEnd).distanceSquared;
}

function normalizePolygonRing(points) {
    const ring = points
        .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(point => ({
            x: roundCoordinate(point.x),
            y: roundCoordinate(point.y)
        }));

    removeClosingDuplicatePoint(ring);
    const dedupedRing = removeConsecutiveDuplicatePoints(ring);

    removeCollinearPoints(dedupedRing);

    return closeRing(dedupedRing);
}

function getOpenRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
        return ring.slice(0, -1);
    }

    return ring.slice();
}

function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
}

function removeClosingDuplicatePoint(ring) {
    if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
        ring.pop();
    }
}

function removeCollinearPoints(ring) {
    let index = 0;

    while (ring.length >= 3 && index < ring.length) {
        const previous = ring[(index - 1 + ring.length) % ring.length];
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];

        if (isCollinear(previous, current, next)) {
            ring.splice(index, 1);
            index = Math.max(0, index - 1);
            continue;
        }

        index++;
    }
}

function isCollinear(first, second, third) {
    return Math.abs(crossCoordinates(first, second, third)) <= geometryEpsilon;
}

function crossCoordinates(first, second, third) {
    return (second.x - first.x) * (third.y - first.y)
        - (second.y - first.y) * (third.x - first.x);
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

function subtractPoints(first, second) {
    return {
        x: first.x - second.x,
        y: first.y - second.y
    };
}

function dotProduct(first, second) {
    return first.x * second.x + first.y * second.y;
}

function getDistanceSquared(first, second) {
    const x = first.x - second.x;
    const y = first.y - second.y;

    return x * x + y * y;
}

function roundCoordinate(value) {
    return Math.round(value * coordinatePrecision) / coordinatePrecision;
}

function calculateAverage(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateStandardDeviation(values, average) {
    const variance = values
        .map(value => (value - average) ** 2)
        .reduce((sum, value) => sum + value, 0) / values.length;

    return Math.sqrt(variance);
}
