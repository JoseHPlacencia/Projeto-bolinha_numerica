import { clamp, lerp, lerpAngle } from "./sharedMath.js";
import { calculateAdaptiveBufferMetrics } from "./adaptiveBuffer.js";
import {
    createSnapshotDiagnostics,
    finiteOrNull
} from "./snapshotDiagnostics.js";
import {
    calculateRingArea,
    createBoundaryPaths,
    createClippedTrailPoints,
    createTrailFillPolygon,
    findClosestPolygonBoundaryContact,
    getDistanceSquared,
    getPointPathDistanceSquared,
    hasSelfIntersections,
    isPointInsideOrOnRing,
    isValidPoint,
    normalizePolygonRing,
    removeConsecutiveDuplicatePoints,
    selectBoundaryPathByAnchor,
    unpackPoints,
    unpackPolygon,
    unpackSegments
} from "./snapshotGeometry.js";

const geometryEpsilon = 1e-7;
const indexedBoundaryMaxDistanceSquared = 4;
const captureAreaRegressionTolerance = 1;
const captureAreaRegressionRatioTolerance = 0.001;

/**
 * Applies schema-2 snapshots transactionally and exposes an interpolated view.
 * Cache mutations are staged until the whole snapshot is valid; sequence,
 * epoch, territory version and trail generation must remain monotonic.
 * See .ai/docs/SNAPSHOT_PROTOCOL.md.
 */

export function createSnapshotInterpolator(networkConfig, options = {}) {
    const snapshots = [];
    const entityCache = {
        playerInfo: {},
        territories: {},
        territoryPoints: {},
        trails: {},
        trailAssemblies: {},
        trailTombstones: {}
    };
    const networkState = {
        bufferMs: networkConfig.initialBufferMs,
        serverOffset: 0,
        lastSnapshotReceivedAt: null,
        deltas: [],
        lastSnapshotDeltaMs: 0,
        averageSnapshotDeltaMs: 0,
        jitterMs: 0
    };
    const debugState = {
        visiblePlayers: 0,
        visibleTerritories: 0,
        visibleTrails: 0
    };
    const pendingTerritoryOperations = new Map();
    const suppressedCaptureOperationResyncIds = new Set();
    const failedTerritoryOperationKeys = new Map();
    const retiredSnapshotEpochs = new Set();
    let currentSnapshotEpoch = null;
    let hasServerClockSync = false;
    let lastResyncRequestedAt = Number.NEGATIVE_INFINITY;
    const {
        getNetworkDiagnostics,
        recordNetworkDiagnosticsEvent,
        recordSnapshotNetworkDiagnostics,
        resetNetworkDiagnostics
    } = createSnapshotDiagnostics(networkConfig, getDebugState);

    return {
        getDebugState,
        getNetworkDiagnostics,
        getRenderState,
        processSnapshot,
        reset
    };

    function reset() {
        resetSnapshotContinuity();
        currentSnapshotEpoch = null;
        retiredSnapshotEpochs.clear();
        resetNetworkDiagnostics();
        lastResyncRequestedAt = Number.NEGATIVE_INFINITY;
    }

    function resetSnapshotContinuity() {
        snapshots.length = 0;
        entityCache.playerInfo = {};
        entityCache.territories = {};
        entityCache.territoryPoints = {};
        entityCache.trails = {};
        entityCache.trailAssemblies = {};
        entityCache.trailTombstones = {};
        networkState.bufferMs = networkConfig.initialBufferMs;
        networkState.serverOffset = 0;
        networkState.lastSnapshotReceivedAt = null;
        networkState.deltas = [];
        networkState.lastSnapshotDeltaMs = 0;
        networkState.averageSnapshotDeltaMs = 0;
        networkState.jitterMs = 0;
        debugState.visiblePlayers = 0;
        debugState.visibleTerritories = 0;
        debugState.visibleTrails = 0;
        pendingTerritoryOperations.clear();
        suppressedCaptureOperationResyncIds.clear();
        failedTerritoryOperationKeys.clear();
        hasServerClockSync = false;
    }

    function processSnapshot(rawSnapshot) {
        const now = performance.now();
        const applyResult = createApplyResult();
        const epochResult = prepareSnapshotEpoch(rawSnapshot);

        if (epochResult.ignored) {
            applyResult.ignored = true;
            return applyResult;
        }

        const snapshot = expandSnapshot(rawSnapshot, applyResult);
        const shouldSave = applyResult.applied && isSnapshotNewerThanRenderBuffer(snapshot);

        if (shouldSave) {
            updateAdaptiveBuffer(now);
            syncServerClock(snapshot.time);
            saveSnapshot(snapshot);
        }
        recordSnapshotNetworkDiagnostics(rawSnapshot, snapshot, applyResult, now);

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
        const players = interpolatePlayers(previous, next, amount);

        return createInterpolatedRenderState(
            previous,
            next,
            players,
            amount
        );
    }

    function getDebugState() {
        return {
            bufferMs: networkState.bufferMs,
            serverOffsetMs: networkState.serverOffset,
            snapshotInterArrivalMs: networkState.lastSnapshotDeltaMs,
            averageSnapshotDeltaMs: networkState.averageSnapshotDeltaMs,
            jitterMs: networkState.jitterMs,
            snapshotEpoch: currentSnapshotEpoch,
            snapshotCount: snapshots.length,
            visiblePlayers: debugState.visiblePlayers,
            visibleTerritories: debugState.visibleTerritories,
            visibleTrails: debugState.visibleTrails
        };
    }

    function prepareSnapshotEpoch(rawSnapshot) {
        const snapshotEpoch = normalizeSnapshotEpoch(
            rawSnapshot && rawSnapshot.snapshotEpoch
        );

        if (snapshotEpoch === null) {
            return { changed: false, ignored: false };
        }

        if (currentSnapshotEpoch === null) {
            currentSnapshotEpoch = snapshotEpoch;
            return { changed: false, ignored: false };
        }

        if (snapshotEpoch === currentSnapshotEpoch) {
            return { changed: false, ignored: false };
        }

        if (retiredSnapshotEpochs.has(snapshotEpoch)) {
            return { changed: false, ignored: true };
        }

        retireSnapshotEpoch(currentSnapshotEpoch);
        resetSnapshotContinuity();
        currentSnapshotEpoch = snapshotEpoch;
        return { changed: true, ignored: false };
    }

    function retireSnapshotEpoch(snapshotEpoch) {
        retiredSnapshotEpochs.add(snapshotEpoch);

        while (retiredSnapshotEpochs.size > 32) {
            const oldestEpoch = retiredSnapshotEpochs.values().next().value;
            retiredSnapshotEpochs.delete(oldestEpoch);
        }
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
        const checkpoint = createSnapshotApplyCheckpoint();
        const removedTerritoryIds = normalizeEntityIds(rawSnapshot.removedTerritoryIds);
        const trailRemovals = normalizeTrailRemovals(
            rawSnapshot.trailRemovals,
            rawSnapshot.removedTrailIds
        );
        updatePlayerInfoCache(rawSnapshot.playerInfo, rawSnapshot.sequence);
        updateTerritoryCache(rawSnapshot.territories, applyResult, rawSnapshot.sequence);
        updateTrailCache(rawSnapshot.trails, applyResult, rawSnapshot.sequence);
        const activeTrailIds = new Set(rawSnapshot.trailIds || []);
        const failedTerritoryOperationIds = updateTerritoryOperations(rawSnapshot.territoryOps, activeTrailIds, applyResult);
        const ignoredTerritoryResyncIds = createIgnoredTerritoryResyncIds(failedTerritoryOperationIds);

        if (applyResult.applied) {
            applyTerritoryRemovals(removedTerritoryIds);
            applyTrailRemovals(trailRemovals, rawSnapshot.sequence);
        }

        const players = expandPlayers(rawSnapshot.players, rawSnapshot.debug);
        const selectedTerritories = selectCachedEntities(entityCache.territories, rawSnapshot.territoryIds);
        const selectedTrails = selectCachedEntities(entityCache.trails, rawSnapshot.trailIds);
        const availableTrails = selectAvailableTrailEntities(rawSnapshot.trailIds);
        const territories = mergeSnapshotEntities(
            getPreviousSnapshotEntities("territories"),
            selectedTerritories,
            removedTerritoryIds,
            hasExplicitRemovalProtocol(rawSnapshot)
        );
        const trails = rawSnapshot.preserveTrails
            ? getPreviousSnapshotEntities("trails")
            : mergeSnapshotEntities(
                getPreviousSnapshotEntities("trails"),
                selectedTrails,
                Object.keys(trailRemovals),
                hasExplicitRemovalProtocol(rawSnapshot)
            );

        requestRecoveryForMissingCachedEntities(rawSnapshot.territoryIds, selectedTerritories, "territories", applyResult, ignoredTerritoryResyncIds);
        requestRecoveryForStaleCachedVersions(rawSnapshot.territoryVersions, selectedTerritories, applyResult, ignoredTerritoryResyncIds);

        if (!rawSnapshot.preserveTrails) {
            requestRecoveryForMissingCachedEntities(rawSnapshot.trailIds, availableTrails, "trails", applyResult);
        }

        if (!applyResult.applied) {
            restoreSnapshotApplyCheckpoint(checkpoint);
        }

        debugState.visiblePlayers = Object.keys(players).length;
        debugState.visibleTerritories = Object.keys(territories).length;
        debugState.visibleTrails = Object.keys(trails).length;

        return {
            sequence: rawSnapshot.sequence,
            time: rawSnapshot.time,
            players,
            territories,
            trails,
            trailIds: Object.keys(trails),
            preserveTrails: Boolean(rawSnapshot.preserveTrails),
            catchStatus: normalizeCatchStatus(rawSnapshot.catchStatus),
            leaderboard: rawSnapshot.leaderboard || [],
            mode: rawSnapshot.mode || null,
            numbers: rawSnapshot.numbers || null
        };
    }

    function createSnapshotApplyCheckpoint() {
        return {
            entityCache: {
                playerInfo: { ...entityCache.playerInfo },
                territories: { ...entityCache.territories },
                territoryPoints: { ...entityCache.territoryPoints },
                trails: { ...entityCache.trails },
                trailAssemblies: { ...entityCache.trailAssemblies },
                trailTombstones: { ...entityCache.trailTombstones }
            },
            failedTerritoryOperationKeys: new Map(failedTerritoryOperationKeys),
            pendingTerritoryOperations: new Map(pendingTerritoryOperations),
            suppressedCaptureOperationResyncIds: new Set(suppressedCaptureOperationResyncIds)
        };
    }

    function restoreSnapshotApplyCheckpoint(checkpoint) {
        if (!checkpoint) {
            return;
        }

        entityCache.playerInfo = checkpoint.entityCache.playerInfo;
        entityCache.territories = checkpoint.entityCache.territories;
        entityCache.territoryPoints = checkpoint.entityCache.territoryPoints;
        entityCache.trails = checkpoint.entityCache.trails;
        entityCache.trailAssemblies = checkpoint.entityCache.trailAssemblies;
        entityCache.trailTombstones = checkpoint.entityCache.trailTombstones;
        replaceMapEntries(pendingTerritoryOperations, checkpoint.pendingTerritoryOperations);
        replaceMapEntries(failedTerritoryOperationKeys, checkpoint.failedTerritoryOperationKeys);
        replaceSetEntries(suppressedCaptureOperationResyncIds, checkpoint.suppressedCaptureOperationResyncIds);
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
            sequence: snapshot.sequence,
            time: snapshot.time,
            players: snapshot.players || {},
            territories: snapshot.territories || {},
            trails: snapshot.trails || {},
            trailIds: Object.keys(snapshot.trails || {}),
            preserveTrails: false,
            catchStatus: normalizeCatchStatus(snapshot.catchStatus),
            leaderboard: snapshot.leaderboard || [],
            mode: snapshot.mode || null,
            numbers: snapshot.numbers || null
        };
    }

    function updateAdaptiveBuffer(now) {
        if (!Number.isFinite(networkState.lastSnapshotReceivedAt)) {
            networkState.lastSnapshotReceivedAt = now;
            return;
        }

        const delta = now - networkState.lastSnapshotReceivedAt;
        networkState.lastSnapshotReceivedAt = now;
        networkState.deltas.push(delta);

        if (networkState.deltas.length > networkConfig.maxJitterSamples) {
            networkState.deltas.shift();
        }

        const metrics = calculateAdaptiveBufferMetrics(networkState.deltas, networkConfig);
        const nextBuffer = Math.max(
            metrics.percentile,
            metrics.adaptiveAverage + metrics.adaptiveJitter * networkConfig.jitterMultiplier
        );

        networkState.lastSnapshotDeltaMs = delta;
        networkState.averageSnapshotDeltaMs = metrics.average;
        networkState.jitterMs = metrics.jitter;
        networkState.bufferMs = clamp(
            nextBuffer,
            networkConfig.minBufferMs,
            networkConfig.maxBufferMs
        );
    }

    function syncServerClock(serverTime) {
        const nextOffset = Date.now() - serverTime;

        if (!hasServerClockSync) {
            networkState.serverOffset = nextOffset;
            hasServerClockSync = true;
            return;
        }

        networkState.serverOffset = networkState.serverOffset * 0.9 + nextOffset * 0.1;
    }

    function saveSnapshot(snapshot) {
        snapshots.push(snapshot);

        while (snapshots.length > networkConfig.maxSnapshots) {
            snapshots.shift();
        }
    }

    function isSnapshotNewerThanRenderBuffer(snapshot) {
        const latest = snapshots[snapshots.length - 1];

        if (!latest) {
            return true;
        }

        if (Number.isSafeInteger(snapshot.sequence) && Number.isSafeInteger(latest.sequence)) {
            return snapshot.sequence > latest.sequence;
        }

        return Number.isFinite(snapshot.time)
            && (!Number.isFinite(latest.time) || snapshot.time > latest.time);
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
            catchStatus: snapshot.catchStatus,
            leaderboard: snapshot.leaderboard || [],
            mode: snapshot.mode || null,
            numbers: snapshot.numbers || null,
            territories: snapshot.territories,
            trails: snapshot.trails,
            trailIds: snapshot.trailIds || Object.keys(snapshot.trails || {}),
            preserveTrails: Boolean(snapshot.preserveTrails)
        };
    }

    function createInterpolatedRenderState(previous, next, players, amount) {
        const geometrySnapshot = amount < 0.5 ? previous : next;

        return {
            players,
            catchStatus: next.catchStatus || previous.catchStatus,
            leaderboard: next.leaderboard || previous.leaderboard || [],
            mode: next.mode || previous.mode || null,
            numbers: next.numbers || previous.numbers || null,
            territories: geometrySnapshot.territories,
            trails: createPredictedTrailState(geometrySnapshot, players, amount),
            trailIds: geometrySnapshot.trailIds || Object.keys(geometrySnapshot.trails || {}),
            preserveTrails: Boolean(geometrySnapshot.preserveTrails)
        };
    }

    function createPredictedTrailState(snapshot, players, amount) {
        const baseTrails = snapshot.trails || {};

        if (!shouldPredictTrails(amount) || snapshot.preserveTrails) {
            return baseTrails;
        }

        const activeTrailIds = new Set(snapshot.trailIds || Object.keys(baseTrails));
        const territories = snapshot.territories || {};
        let predictedTrails = null;

        for (const [id, trail] of Object.entries(baseTrails)) {
            if (!activeTrailIds.has(id)) {
                continue;
            }

            const predictedTrail = createPredictedTrail(trail, players[id], territories[id]);

            if (predictedTrail === trail) {
                continue;
            }

            if (!predictedTrails) {
                predictedTrails = { ...baseTrails };
            }

            predictedTrails[id] = predictedTrail;
        }

        return predictedTrails || baseTrails;
    }

    function shouldPredictTrails(amount) {
        if (networkConfig.trailPredictionEnabled === false || amount <= 0) {
            return false;
        }

        const maxBufferMs = getFiniteConfigNumber(
            networkConfig.trailPredictionMaxBufferMs,
            getFiniteConfigNumber(networkConfig.minBufferMs, 100) + 40
        );

        return networkState.bufferMs <= maxBufferMs;
    }

    function createPredictedTrail(trail, player, territory) {
        if (!trail || !player || !Number.isFinite(player.x) || !Number.isFinite(player.y) || !Number.isFinite(player.angle)) {
            return trail;
        }

        if (trail.isPartial) {
            return trail;
        }

        const sample = createTrailPredictionSample(player);
        const shouldPredictLeft = !isPointInsideTerritory(sample.leftPoint, territory);
        const shouldPredictRight = !isPointInsideTerritory(sample.rightPoint, territory);
        const leftSegments = shouldPredictLeft
            ? appendPredictedPointToLastSegment(trail.leftSegments, sample.leftPoint)
            : trail.leftSegments;
        const rightSegments = shouldPredictRight
            ? appendPredictedPointToLastSegment(trail.rightSegments, sample.rightPoint)
            : trail.rightSegments;

        if (leftSegments === trail.leftSegments && rightSegments === trail.rightSegments) {
            return trail;
        }

        const leftFillPath = shouldPredictLeft
            ? appendPredictedPointToFillPath(trail.leftFillPath, sample.leftPoint)
            : trail.leftFillPath;
        const rightFillPath = shouldPredictRight
            ? appendPredictedPointToFillPath(trail.rightFillPath, sample.rightPoint)
            : trail.rightFillPath;
        const fillChanged = leftFillPath !== trail.leftFillPath || rightFillPath !== trail.rightFillPath;

        return {
            ...trail,
            leftSegments,
            rightSegments,
            leftFillPath,
            rightFillPath,
            fillPolygon: fillChanged
                ? createTrailFillPolygon(leftFillPath, rightFillPath)
                : trail.fillPolygon
        };
    }

    function createTrailPredictionSample(player) {
        const halfWidth = getFiniteConfigNumber(networkConfig.trailPredictionPlayerHalfWidth, 35);
        const normalX = -Math.sin(player.angle);
        const normalY = Math.cos(player.angle);

        return {
            leftPoint: {
                x: player.x + normalX * halfWidth,
                y: player.y + normalY * halfWidth
            },
            rightPoint: {
                x: player.x - normalX * halfWidth,
                y: player.y - normalY * halfWidth
            }
        };
    }

    function appendPredictedPointToLastSegment(segments, point) {
        if (!Array.isArray(segments) || segments.length === 0) {
            return segments;
        }

        const lastIndex = segments.length - 1;
        const nextSegment = appendPredictedPoint(segments[lastIndex], point);

        if (nextSegment === segments[lastIndex]) {
            return segments;
        }

        const nextSegments = segments.slice();
        nextSegments[lastIndex] = nextSegment;

        return nextSegments;
    }

    function appendPredictedPointToFillPath(points, point) {
        if (!Array.isArray(points) || points.length === 0) {
            return points;
        }

        return appendPredictedPoint(points, point);
    }

    function appendPredictedPoint(points, point) {
        if (!Array.isArray(points) || points.length === 0 || !isValidPoint(point)) {
            return points;
        }

        const lastPoint = points[points.length - 1];

        if (!isValidPoint(lastPoint) || !isPredictionDistanceAllowed(lastPoint, point)) {
            return points;
        }

        return points.concat({
            x: point.x,
            y: point.y
        });
    }

    function isPredictionDistanceAllowed(first, second) {
        const distanceSquared = getDistanceSquared(first, second);
        const minDistance = getFiniteConfigNumber(networkConfig.trailPredictionMinPointDistance, 2);
        const maxDistance = getFiniteConfigNumber(networkConfig.trailPredictionMaxPointDistance, 180);

        return distanceSquared >= minDistance * minDistance
            && distanceSquared <= maxDistance * maxDistance;
    }

    function isPointInsideTerritory(point, territory) {
        if (!isValidPoint(point) || !territory) {
            return false;
        }

        return getTerritoryPolygons(territory)
            .some(polygon => isPointInsidePolygon(point, polygon));
    }

    function getTerritoryPolygons(territory) {
        if (territory && territory.polygon && Array.isArray(territory.polygon.rings)) {
            return [territory.polygon];
        }

        return Array.isArray(territory && territory.polygons)
            ? territory.polygons
            : [];
    }

    function isPointInsidePolygon(point, polygon) {
        return (polygon && polygon.rings || [])
            .some(ring => isPointInsideOrOnRing(point, ring));
    }

    function updatePlayerInfoCache(playerInfo, snapshotSequence) {
        for (const [id, info] of Object.entries(playerInfo || {})) {
            const cachedInfo = entityCache.playerInfo[id];
            const version = info[3];

            if (
                cachedInfo
                && Number.isFinite(version)
                && Number.isFinite(cachedInfo.version)
                && version < cachedInfo.version
            ) {
                continue;
            }

            entityCache.playerInfo[id] = {
                color: info[0],
                territoryX: info[1],
                territoryY: info[2],
                version,
                snapshotSequence,
                name: info[4],
                eliminations: info[5],
                lives: info[6],
                maxLives: info[7],
                catchBalance: info[8]
            };
        }
    }

    function updateTerritoryCache(territories, applyResult, snapshotSequence) {
        for (const [id, territory] of Object.entries(territories || {})) {
            const cachedTerritory = entityCache.territories[id];

            if (
                cachedTerritory
                && Number.isFinite(territory.version)
                && Number.isFinite(cachedTerritory.version)
                && territory.version < cachedTerritory.version
            ) {
                continue;
            }

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
                snapshotSequence,
                baseX: base[0],
                baseY: base[1],
                polygon
            };
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }
    }

    function updateTerritoryOperations(operations, activeTrailIds, applyResult) {
        const failedIds = new Set();

        for (const [id, operation] of Object.entries(operations || {})) {
            const duplicateFailure = getFailedTerritoryOperation(id, operation);

            if (duplicateFailure) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure);
                continue;
            }

            if (shouldDeferTerritoryOperation(id, operation, activeTrailIds)) {
                pendingTerritoryOperations.set(id, operation);
                continue;
            }

            const operationResult = applyCaptureTerritoryOperation(id, operation);

            if (!operationResult.applied) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                markFailedTerritoryOperation(id, operation, operationResult);
                handleCaptureOperationFailure(id, operationResult, operation);
                continue;
            }

            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
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

            const duplicateFailure = getFailedTerritoryOperation(id, operation);

            if (duplicateFailure) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure);
                continue;
            }

            const operationResult = applyCaptureTerritoryOperation(id, operation);

            if (!operationResult.applied) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                markFailedTerritoryOperation(id, operation, operationResult);
                handleCaptureOperationFailure(id, operationResult, operation);
                continue;
            }

            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }
    }

    function applyCaptureTerritoryOperation(id, operation) {
        if (!operation || operation.type !== "trailCapture") {
            return createCaptureOperationFailure("invalid_operation", {
                operationType: operation && operation.type
            });
        }

        const territory = entityCache.territories[id];

        if (!territory) {
            return createCaptureOperationFailure("missing_cached_territory", {
                expectedBaseVersion: operation.baseVersion,
                operationVersion: operation.version
            });
        }

        if (
            Number.isFinite(operation.version)
            && Number.isFinite(territory.version)
            && territory.version >= operation.version
        ) {
            return {
                applied: true,
                skipped: true
            };
        }

        if (territory.version !== operation.baseVersion) {
            return createCaptureOperationFailure("territory_version_mismatch", {
                localTerritoryVersion: territory.version,
                expectedBaseVersion: operation.baseVersion,
                operationVersion: operation.version
            });
        }

        const trailSegmentState = getCaptureTrailSegmentState(id, operation);
        const trailSegment = trailSegmentState.points;
        const startContact = unpackCaptureContact(operation.startContact);
        const endContact = unpackCaptureContact(operation.endContact);
        const keepAnchor = unpackPoint(operation.keepAnchor);

        if (!trailSegment) {
            return createCaptureOperationFailure("missing_or_incomplete_trail_segment", trailSegmentState.debug);
        }

        if (!startContact || !endContact || !keepAnchor) {
            return createCaptureOperationFailure("invalid_capture_geometry_reference", {
                hasStartContact: Boolean(startContact),
                hasEndContact: Boolean(endContact),
                hasKeepAnchor: Boolean(keepAnchor)
            });
        }

        const ring = territory.polygon && territory.polygon.rings && territory.polygon.rings[0];

        if (!Array.isArray(ring) || ring.length < 3) {
            return createCaptureOperationFailure("invalid_cached_territory_ring", {
                localTerritoryVersion: territory.version,
                ringLength: Array.isArray(ring) ? ring.length : 0
            });
        }

        const localStartContact = getLocalBoundaryContact(ring, startContact);
        const localEndContact = getLocalBoundaryContact(ring, endContact);

        if (!localStartContact || !localEndContact) {
            return createCaptureOperationFailure("boundary_contact_not_found", {
                ringLength: ring.length,
                hasLocalStartContact: Boolean(localStartContact),
                hasLocalEndContact: Boolean(localEndContact)
            });
        }

        const boundaryPathState = getCaptureBoundaryPath(ring, localEndContact, localStartContact, operation, keepAnchor);
        const boundaryPath = boundaryPathState.path;

        if (!boundaryPath) {
            return createCaptureOperationFailure("boundary_path_not_found", {
                boundaryPathCount: boundaryPathState.pathCount,
                ringLength: ring.length
            });
        }

        const trailPoints = createClippedTrailPoints(
            trailSegment,
            operation.trailSegmentLength,
            localStartContact.point,
            localEndContact.point
        );
        const nextRing = normalizePolygonRing(trailPoints.concat(boundaryPath));

        if (nextRing.length < 4) {
            return createCaptureOperationFailure("resulting_ring_too_short", {
                trailPointCount: trailPoints.length,
                boundaryPathPointCount: boundaryPath.length,
                nextRingLength: nextRing.length
            });
        }

        const validationResult = validateCaptureOperationResult(territory, ring, nextRing);

        if (!validationResult.valid) {
            return createCaptureOperationFailure(validationResult.reason, {
                ...validationResult.details,
                trailPointCount: trailPoints.length,
                boundaryPathPointCount: boundaryPath.length,
                boundaryPathSource: boundaryPathState.source
            });
        }

        entityCache.territories[id] = {
            ...territory,
            version: operation.version,
            polygon: {
                rings: [nextRing]
            }
        };

        return {
            applied: true
        };
    }

    function validateCaptureOperationResult(territory, previousRing, nextRing) {
        const previousArea = Math.abs(calculateRingArea(previousRing));
        const nextArea = Math.abs(calculateRingArea(nextRing));

        if (!Number.isFinite(nextArea) || nextArea <= geometryEpsilon) {
            return {
                valid: false,
                reason: "capture_result_invalid_area",
                details: {
                    nextArea
                }
            };
        }

        if (hasSelfIntersections(nextRing)) {
            return {
                valid: false,
                reason: "capture_result_self_intersection",
                details: {
                    nextArea,
                    previousArea,
                    pointCount: nextRing.length
                }
            };
        }

        if (Number.isFinite(previousArea) && previousArea > geometryEpsilon) {
            const tolerance = Math.max(
                captureAreaRegressionTolerance,
                previousArea * captureAreaRegressionRatioTolerance
            );

            if (nextArea + tolerance < previousArea) {
                return {
                    valid: false,
                    reason: "capture_result_area_regressed",
                    details: {
                        nextArea,
                        previousArea,
                        tolerance
                    }
                };
            }
        }

        const basePoint = getTerritoryBasePoint(territory);

        if (basePoint && !isPointInsideOrOnRing(basePoint, nextRing)) {
            return {
                valid: false,
                reason: "capture_result_lost_base",
                details: {
                    baseX: basePoint.x,
                    baseY: basePoint.y,
                    nextArea,
                    previousArea
                }
            };
        }

        return {
            valid: true
        };
    }

    function getTerritoryBasePoint(territory) {
        if (!territory
            || !Number.isFinite(territory.baseX)
            || !Number.isFinite(territory.baseY)) {
            return null;
        }

        return {
            x: territory.baseX,
            y: territory.baseY
        };
    }

    function getLocalBoundaryContact(ring, contact) {
        const indexedContact = createIndexedBoundaryContact(ring, contact);

        if (indexedContact) {
            return indexedContact;
        }

        return findClosestPolygonBoundaryContact(ring, contact.point);
    }

    function createIndexedBoundaryContact(ring, contact) {
        if (!contact
            || !Array.isArray(ring)
            || !Number.isInteger(contact.segmentIndex)
            || !Number.isFinite(contact.segmentT)) {
            return null;
        }

        const openRingLength = getOpenRingLength(ring);

        if (contact.segmentIndex < 0 || contact.segmentIndex >= openRingLength) {
            return null;
        }

        const segmentStart = getOpenRingPoint(ring, contact.segmentIndex);
        const segmentEnd = getOpenRingPoint(ring, (contact.segmentIndex + 1) % openRingLength);
        const projection = projectPointOnSegment(contact.point, segmentStart, segmentEnd);

        if (projection.distanceSquared > indexedBoundaryMaxDistanceSquared) {
            return null;
        }

        return {
            point: projection.point,
            segmentIndex: contact.segmentIndex,
            segmentT: projection.segmentT
        };
    }

    function getOpenRingLength(ring) {
        if (!Array.isArray(ring)) {
            return 0;
        }

        if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
            return ring.length - 1;
        }

        return ring.length;
    }

    function getOpenRingPoint(ring, index) {
        return ring[index];
    }

    function getCaptureBoundaryPath(ring, startContact, endContact, operation, keepAnchor) {
        if (Number.isInteger(operation.boundaryPathIndex)) {
            const indexedPath = createBoundaryPathByIndex(ring, startContact, endContact, operation.boundaryPathIndex);

            if (indexedPath && isBoundaryPathConsistentWithAnchor(indexedPath, keepAnchor)) {
                return {
                    path: indexedPath,
                    pathCount: 1,
                    source: "index"
                };
            }
        }

        const boundaryPaths = createBoundaryPaths(ring, startContact, endContact);

        return {
            path: selectBoundaryPathByAnchor(boundaryPaths, keepAnchor),
            pathCount: boundaryPaths.length,
            source: "anchor"
        };
    }

    function createBoundaryPathByIndex(ring, startContact, endContact, pathIndex) {
        const openRingLength = getOpenRingLength(ring);

        if (!startContact || !endContact || openRingLength < 3) {
            return null;
        }

        if (pathIndex === 0) {
            return removeConsecutiveDuplicatePoints(
                createForwardBoundaryPathFromRing(ring, openRingLength, startContact, endContact)
            );
        }

        if (pathIndex === 1) {
            return removeConsecutiveDuplicatePoints(
                createForwardBoundaryPathFromRing(ring, openRingLength, endContact, startContact).reverse()
            );
        }

        return null;
    }

    function createForwardBoundaryPathFromRing(ring, openRingLength, startContact, endContact) {
        if (startContact.segmentIndex === endContact.segmentIndex
            && endContact.segmentT >= startContact.segmentT) {
            return [startContact.point, endContact.point];
        }

        const path = [startContact.point];
        let vertexIndex = (startContact.segmentIndex + 1) % openRingLength;
        let guard = 0;

        while (guard <= openRingLength) {
            path.push(getOpenRingPoint(ring, vertexIndex));

            if (vertexIndex === endContact.segmentIndex) {
                break;
            }

            vertexIndex = (vertexIndex + 1) % openRingLength;
            guard++;
        }

        path.push(endContact.point);

        return path;
    }

    function isBoundaryPathConsistentWithAnchor(path, anchor) {
        if (!Array.isArray(path) || path.length < 2 || !anchor) {
            return false;
        }

        if (path.length > 2) {
            return getDistanceSquared(path[1], anchor) <= indexedBoundaryMaxDistanceSquared;
        }

        return getPointPathDistanceSquared(anchor, path) <= indexedBoundaryMaxDistanceSquared;
    }

    function getCaptureTrailSegmentState(id, operation) {
        const trail = entityCache.trails[id];
        const fallbackPoints = unpackPoints(operation.trailPoints);
        const trailTailPoints = unpackPoints(operation.trailTailPoints);
        const trailTailStart = Number.isInteger(operation.trailTailStart)
            ? operation.trailTailStart
            : null;

        const segments = trail && operation.trailSide === "right"
            ? trail.rightSegments
            : trail && trail.leftSegments;
        const segment = segments && segments[operation.trailSegmentIndex];
        const mergedSegment = createMergedTrailSegment(segment, trailTailStart, trailTailPoints);
        const debug = {
            hasCachedTrail: Boolean(trail),
            trailSide: operation.trailSide,
            cachedSideSegmentCount: Array.isArray(segments) ? segments.length : 0,
            trailSegmentIndex: operation.trailSegmentIndex,
            cachedSegmentLength: Array.isArray(segment) ? segment.length : 0,
            requiredSegmentLength: operation.trailSegmentLength,
            fallbackTrailPointCount: fallbackPoints.length,
            trailTailStart,
            trailTailPointCount: trailTailPoints.length,
            mergedSegmentLength: Array.isArray(mergedSegment) ? mergedSegment.length : 0
        };

        if (canUseCachedTrailSegment(segment, operation)) {
            return {
                points: segment,
                debug: {
                    ...debug,
                    trailPointSource: "cache"
                }
            };
        }

        if (canUseCachedTrailSegment(mergedSegment, operation)) {
            return {
                points: mergedSegment,
                debug: {
                    ...debug,
                    trailPointSource: "cache_tail"
                }
            };
        }

        if (fallbackPoints.length >= 2) {
            return {
                points: fallbackPoints,
                debug: {
                    ...debug,
                    trailPointSource: "fallback"
                }
            };
        }

        return {
            points: null,
            debug: {
                ...debug,
                trailPointSource: "none"
            }
        };
    }

    function createMergedTrailSegment(segment, trailTailStart, trailTailPoints) {
        if (!Array.isArray(trailTailPoints)
            || trailTailPoints.length === 0
            || !Number.isInteger(trailTailStart)
            || trailTailStart < 0) {
            return null;
        }

        const cachedPrefix = Array.isArray(segment) ? segment.slice(0, trailTailStart) : [];

        if (cachedPrefix.length !== trailTailStart) {
            return null;
        }

        return cachedPrefix.concat(trailTailPoints);
    }

    function createCaptureOperationFailure(reason, details = {}) {
        return {
            applied: false,
            reason,
            details
        };
    }

    function markFailedTerritoryOperation(id, operation, operationResult) {
        const key = createTerritoryOperationKey(id, operation);

        if (!key) {
            return;
        }

        failedTerritoryOperationKeys.set(key, {
            reason: operationResult && operationResult.reason || null,
            details: operationResult && operationResult.details || null
        });
    }

    function getFailedTerritoryOperation(id, operation) {
        const key = createTerritoryOperationKey(id, operation);

        return key ? failedTerritoryOperationKeys.get(key) : null;
    }

    function clearFailedTerritoryOperationKeys(id) {
        const prefix = `${id}:`;

        for (const key of failedTerritoryOperationKeys.keys()) {
            if (key.startsWith(prefix)) {
                failedTerritoryOperationKeys.delete(key);
            }
        }
    }

    function createTerritoryOperationKey(id, operation) {
        if (!id || !operation) {
            return null;
        }

        return [
            id,
            operation.type || "unknown",
            Number.isFinite(operation.baseVersion) ? operation.baseVersion : "base?",
            Number.isFinite(operation.version) ? operation.version : "version?",
            operation.trailSide || "side?",
            Number.isInteger(operation.trailSegmentIndex) ? operation.trailSegmentIndex : "segment?",
            Number.isInteger(operation.trailSegmentLength) ? operation.trailSegmentLength : "length?",
            Number.isInteger(operation.boundaryPathIndex) ? operation.boundaryPathIndex : "path?"
        ].join(":");
    }

    function createCaptureOperationDiagnosticsDetails(id, operationResult, operation) {
        const details = operationResult && operationResult.details || {};

        return {
            territoryId: id,
            operationType: operation && operation.type || null,
            baseVersion: finiteOrNull(operation && operation.baseVersion),
            operationVersion: finiteOrNull(operation && operation.version),
            trailSide: operation && operation.trailSide || null,
            trailSegmentIndex: Number.isInteger(operation && operation.trailSegmentIndex)
                ? operation.trailSegmentIndex
                : null,
            trailSegmentLength: Number.isInteger(operation && operation.trailSegmentLength)
                ? operation.trailSegmentLength
                : null,
            boundaryPathIndex: Number.isInteger(operation && operation.boundaryPathIndex)
                ? operation.boundaryPathIndex
                : null,
            hasFallbackTrailPoints: hasFallbackTrailPoints(operation),
            fallbackTrailPointCount: countPackedPoints(operation && operation.trailPoints),
            trailTailStart: Number.isInteger(operation && operation.trailTailStart)
                ? operation.trailTailStart
                : null,
            trailTailPointCount: countPackedPoints(operation && operation.trailTailPoints),
            resultDetails: details
        };
    }

    function countPackedPoints(points) {
        return Array.isArray(points) ? points.length : 0;
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

        if (!point) {
            return null;
        }

        return {
            point,
            segmentIndex: Number.isInteger(contact[2]) ? contact[2] : null,
            segmentT: Number.isFinite(contact[3]) ? contact[3] : null
        };
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

    function updateTrailCache(trails, applyResult, snapshotSequence) {
        for (const [id, update] of Object.entries(trails || {})) {
            const cachedTrail = entityCache.trails[id];
            const assembly = entityCache.trailAssemblies[id];
            const newestTrail = getNewestTrailState(cachedTrail, assembly);
            const tombstone = entityCache.trailTombstones[id];

            if (
                isTrailUpdateStale(update, snapshotSequence, newestTrail)
                || isTrailUpdateBlockedByTombstone(update, snapshotSequence, tombstone)
            ) {
                continue;
            }

            delete entityCache.trailTombstones[id];

            if (update.full) {
                const fullTrail = createFullTrail(id, update, snapshotSequence);
                const shouldStage = Boolean(update.partial);

                if (shouldStage) {
                    if (cachedTrail && !cachedTrail.isPartial) {
                        entityCache.trailAssemblies[id] = fullTrail;
                    } else {
                        entityCache.trails[id] = fullTrail;
                        delete entityCache.trailAssemblies[id];
                    }
                    continue;
                }

                entityCache.trails[id] = fullTrail;
                delete entityCache.trailAssemblies[id];
                continue;
            }

            const trail = assembly || cachedTrail;
            const patchedTrail = trail && createPatchedTrail(trail, update, snapshotSequence);

            if (!patchedTrail) {
                delete entityCache.trailAssemblies[id];
                markCacheInvalid(applyResult, "trails", id);
                continue;
            }

            if (assembly && update.partial) {
                entityCache.trailAssemblies[id] = patchedTrail;
                continue;
            }

            entityCache.trails[id] = patchedTrail;
            delete entityCache.trailAssemblies[id];
        }
    }

    function isTrailUpdateBlockedByTombstone(update, snapshotSequence, tombstone) {
        if (!tombstone) {
            return false;
        }

        const updateGeneration = Number.isSafeInteger(update && update.generation)
            ? update.generation
            : null;
        const tombstoneGeneration = Number.isSafeInteger(tombstone.generation)
            ? tombstone.generation
            : null;

        if (
            updateGeneration !== null
            && tombstoneGeneration !== null
            && updateGeneration !== tombstoneGeneration
        ) {
            return updateGeneration < tombstoneGeneration;
        }

        return Number.isSafeInteger(snapshotSequence)
            && Number.isSafeInteger(tombstone.snapshotSequence)
            && snapshotSequence <= tombstone.snapshotSequence;
    }

    function getNewestTrailState(cachedTrail, assembly) {
        if (!cachedTrail) {
            return assembly || null;
        }

        if (!assembly) {
            return cachedTrail;
        }

        if ((assembly.generation || 0) !== (cachedTrail.generation || 0)) {
            return (assembly.generation || 0) > (cachedTrail.generation || 0)
                ? assembly
                : cachedTrail;
        }

        return (assembly.snapshotSequence || 0) > (cachedTrail.snapshotSequence || 0)
            ? assembly
            : cachedTrail;
    }

    function isTrailUpdateStale(update, snapshotSequence, trail) {
        if (!trail) {
            return false;
        }

        const updateGeneration = Number.isSafeInteger(update.generation)
            ? update.generation
            : null;
        const trailGeneration = Number.isSafeInteger(trail.generation)
            ? trail.generation
            : null;

        if (
            updateGeneration !== null
            && trailGeneration !== null
            && updateGeneration !== trailGeneration
        ) {
            return updateGeneration < trailGeneration;
        }

        return Number.isSafeInteger(snapshotSequence)
            && Number.isSafeInteger(trail.snapshotSequence)
            && snapshotSequence <= trail.snapshotSequence;
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
                name: info.name || "Jogador",
                eliminations: Number.isFinite(info.eliminations) ? info.eliminations : 0,
                lives: Number.isFinite(info.lives) ? info.lives : 0,
                maxLives: Number.isFinite(info.maxLives) ? info.maxLives : 0,
                catchBalance: Number.isFinite(info.catchBalance) ? info.catchBalance : 0,
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

    function selectAvailableTrailEntities(ids) {
        const selected = {};

        for (const id of ids || []) {
            const trail = getNewestTrailState(
                entityCache.trails[id],
                entityCache.trailAssemblies[id]
            );

            if (trail) {
                selected[id] = trail;
            }
        }

        return selected;
    }

    function mergeSnapshotEntities(previousEntities, selectedEntities, removedIds, useExplicitRemovals) {
        if (!useExplicitRemovals) {
            return selectedEntities;
        }

        const merged = {
            ...(previousEntities || {}),
            ...(selectedEntities || {})
        };

        for (const id of removedIds || []) {
            delete merged[id];
        }

        return merged;
    }

    function hasExplicitRemovalProtocol(snapshot) {
        return Array.isArray(snapshot && snapshot.removedTerritoryIds)
            || Array.isArray(snapshot && snapshot.removedTrailIds)
            || Boolean(
                snapshot
                && snapshot.trailRemovals
                && typeof snapshot.trailRemovals === "object"
            );
    }

    function normalizeEntityIds(ids) {
        return Array.isArray(ids)
            ? [...new Set(ids.filter(id => typeof id === "string" && id))]
            : [];
    }

    function normalizeTrailRemovals(removals, removedIds) {
        const normalized = {};

        for (const [id, generation] of Object.entries(removals || {})) {
            if (typeof id !== "string" || !id) {
                continue;
            }

            normalized[id] = Number.isSafeInteger(generation) ? generation : null;
        }

        for (const id of normalizeEntityIds(removedIds)) {
            if (!Object.prototype.hasOwnProperty.call(normalized, id)) {
                normalized[id] = null;
            }
        }

        return normalized;
    }

    function applyTerritoryRemovals(removedIds) {
        for (const id of removedIds || []) {
            delete entityCache.territories[id];
            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }
    }

    function applyTrailRemovals(removals, snapshotSequence) {
        for (const [id, generation] of Object.entries(removals || {})) {
            delete entityCache.trails[id];
            delete entityCache.trailAssemblies[id];
            entityCache.trailTombstones[id] = {
                generation,
                snapshotSequence
            };
        }
    }

    function replaceMapEntries(target, source) {
        target.clear();

        for (const [key, value] of source || []) {
            target.set(key, value);
        }
    }

    function replaceSetEntries(target, source) {
        target.clear();

        for (const value of source || []) {
            target.add(value);
        }
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

    function createFullTrail(id, update, snapshotSequence) {
        const trail = {
            id,
            color: update.color,
            generation: update.generation,
            snapshotSequence,
            isPartial: Boolean(update.partial),
            leftSegments: unpackSegments(update.leftSegments),
            rightSegments: unpackSegments(update.rightSegments),
            leftFillPath: unpackPoints(update.leftFillPath),
            rightFillPath: unpackPoints(update.rightFillPath),
            fillPolygon: null
        };

        trail.fillPolygon = createTrailFillPolygon(trail.leftFillPath, trail.rightFillPath);

        return trail;
    }

    function createPatchedTrail(trail, update, snapshotSequence) {
        const leftSegments = applySegmentPatches(trail.leftSegments, update.leftPatches);
        const rightSegments = applySegmentPatches(trail.rightSegments, update.rightPatches);
        const leftFillPath = appendPathPoints(trail.leftFillPath, update.leftFillPoints, update.leftFillStart);
        const rightFillPath = appendPathPoints(trail.rightFillPath, update.rightFillPoints, update.rightFillStart);

        if (!leftSegments || !rightSegments || !leftFillPath || !rightFillPath) {
            return null;
        }

        const fillChanged = leftFillPath !== trail.leftFillPath
            || rightFillPath !== trail.rightFillPath;
        const color = update.color || trail.color;

        if (
            leftSegments === trail.leftSegments
            && rightSegments === trail.rightSegments
            && !fillChanged
            && color === trail.color
        ) {
            return {
                ...trail,
                generation: Number.isSafeInteger(update.generation)
                    ? update.generation
                    : trail.generation,
                snapshotSequence,
                isPartial: Boolean(update.partial)
            };
        }

        return {
            id: trail.id,
            color,
            generation: Number.isSafeInteger(update.generation)
                ? update.generation
                : trail.generation,
            snapshotSequence,
            isPartial: Boolean(update.partial),
            leftSegments,
            rightSegments,
            leftFillPath,
            rightFillPath,
            fillPolygon: fillChanged
                ? createTrailFillPolygon(leftFillPath, rightFillPath)
                : trail.fillPolygon
        };
    }

    function applySegmentPatches(segments, patches) {
        if (!Array.isArray(patches) || patches.length === 0) {
            return segments || [];
        }

        const sourceSegments = segments || [];
        const nextSegments = sourceSegments.slice();

        for (const patch of patches || []) {
            if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index > nextSegments.length) {
                return null;
            }

            if (patch.index === nextSegments.length) {
                nextSegments.push(unpackPoints(patch.points));
                continue;
            }

            const sourceSegment = sourceSegments[patch.index] || [];

            if (sourceSegment.length !== patch.start) {
                return null;
            }

            nextSegments[patch.index] = sourceSegment.concat(unpackPoints(patch.points));
        }

        return nextSegments;
    }

    function appendPathPoints(points, packedPoints, startIndex) {
        if (!Array.isArray(packedPoints) || packedPoints.length === 0) {
            return points || [];
        }

        const sourcePoints = points || [];

        if (sourcePoints.length !== startIndex) {
            return null;
        }

        return sourcePoints.concat(unpackPoints(packedPoints));
    }

    function requestResync(details = {}) {
        const now = performance.now();
        const interval = networkConfig.resyncRequestIntervalMs || 1000;

        if (typeof options.onResyncNeeded !== "function") {
            recordResyncSuppressed("missing_handler", details, now, interval);
            return;
        }

        if (now - lastResyncRequestedAt < interval) {
            recordResyncSuppressed("rate_limited", details, now, interval);
            return;
        }

        lastResyncRequestedAt = now;
        recordNetworkDiagnosticsEvent({
            type: "resyncRequested",
            reason: details.reason || null,
            details: details.details || null,
            invalidations: details.invalidations || null,
            bufferMs: networkState.bufferMs,
            snapshotInterArrivalMs: networkState.lastSnapshotDeltaMs,
            averageSnapshotDeltaMs: networkState.averageSnapshotDeltaMs,
            jitterMs: networkState.jitterMs
        });
        options.onResyncNeeded();
    }

    function recordResyncSuppressed(reason, details, now, interval) {
        recordNetworkDiagnosticsEvent({
            type: "resyncSuppressed",
            reason,
            sourceReason: details && details.reason || null,
            details: details && details.details || null,
            invalidations: details && details.invalidations || null,
            intervalMs: interval,
            nextAllowedInMs: Number.isFinite(lastResyncRequestedAt)
                ? Math.max(0, interval - (now - lastResyncRequestedAt))
                : 0,
            bufferMs: networkState.bufferMs,
            snapshotInterArrivalMs: networkState.lastSnapshotDeltaMs,
            averageSnapshotDeltaMs: networkState.averageSnapshotDeltaMs,
            jitterMs: networkState.jitterMs
        });
    }

    function createIgnoredTerritoryResyncIds(failedTerritoryOperationIds) {
        return new Set([
            ...suppressedCaptureOperationResyncIds,
            ...pendingTerritoryOperations.keys(),
            ...failedTerritoryOperationIds
        ]);
    }

    function handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure) {
        recordResyncSuppressed("duplicate_capture_operation_failure", {
            reason: duplicateFailure && duplicateFailure.reason || null,
            details: createCaptureOperationDiagnosticsDetails(id, duplicateFailure, operation),
            invalidations: {
                territories: 1,
                playerInfo: 0,
                trails: 0
            }
        }, performance.now(), networkConfig.resyncRequestIntervalMs || 1000);
    }

    function handleCaptureOperationFailure(id, operationResult, operation) {
        const details = createCaptureOperationDiagnosticsDetails(id, operationResult, operation);

        if (networkConfig.captureOperationResyncEnabled === false) {
            suppressedCaptureOperationResyncIds.add(id);
            recordResyncSuppressed("capture_operation_resync_disabled", {
                reason: operationResult && operationResult.reason || null,
                details,
                invalidations: {
                    territories: 1,
                    playerInfo: 0,
                    trails: 0
                }
            }, performance.now(), networkConfig.resyncRequestIntervalMs || 1000);
            return;
        }

        requestResync({
            reason: operationResult && operationResult.reason || null,
            details,
            invalidations: {
                territories: 1,
                playerInfo: 0,
                trails: 0
            }
        });
    }
}

function normalizeCatchStatus(status) {
    const value = status && typeof status === "object" ? status : {};

    return {
        counterTargetCount: normalizeNonNegativeInteger(value.counterTargetCount),
        counterRiskArmed: Boolean(value.counterRiskArmed),
        counterRiskRemainingMs: normalizeRemainingMs(value.counterRiskRemainingMs),
        threatCount: normalizeNonNegativeInteger(value.threatCount),
        threatArmed: Boolean(value.threatArmed),
        threatRemainingMs: normalizeRemainingMs(value.threatRemainingMs)
    };
}

function normalizeSnapshotEpoch(value) {
    if (typeof value === "string" && value) {
        return value;
    }

    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeNonNegativeInteger(value) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeRemainingMs(value) {
    return Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : null;
}

function getFiniteConfigNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}
