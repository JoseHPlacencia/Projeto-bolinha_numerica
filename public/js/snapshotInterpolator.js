import { clamp, lerp, lerpAngle } from "./sharedMath.js";
import {
    calculateAdaptiveBufferMetrics,
    limitAdaptiveBufferIncrease
} from "./adaptiveBuffer.js";
import {
    createSnapshotDiagnostics
} from "./snapshotDiagnostics.js";
import {
    createSnapshotApplyResult,
    createSnapshotGeometryApplication
} from "./snapshotGeometryApplication.js";
import {
    createTrailFillPolygon,
    getDistanceSquared,
    isPointInsideOrOnRing,
    isValidPoint
} from "./snapshotGeometry.js";

/**
 * Applies schema-2 snapshots transactionally and exposes an interpolated view.
 * Cache mutations are staged until the whole snapshot is valid; sequence,
 * epoch, territory version and trail generation must remain monotonic.
 * See .ai/docs/SNAPSHOT_PROTOCOL.md.
 */

export function createSnapshotInterpolator(networkConfig, options = {}) {
    const snapshots = [];
    const entityCache = {
        playerInfo: {}
    };
    const networkState = {
        bufferMs: networkConfig.initialBufferMs,
        targetBufferMs: networkConfig.initialBufferMs,
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
    const retiredSnapshotEpochs = new Set();
    let currentSnapshotEpoch = null;
    let hasServerClockSync = false;
    let lastResyncRequestedAt = Number.NEGATIVE_INFINITY;
    let lastRenderTime = Number.NEGATIVE_INFINITY;
    const {
        getNetworkDiagnostics,
        recordNetworkDiagnosticsEvent,
        recordSnapshotNetworkDiagnostics,
        resetNetworkDiagnostics
    } = createSnapshotDiagnostics(networkConfig, getDebugState);
    const geometryApplication = createSnapshotGeometryApplication(networkConfig, {
        recordResyncSuppressed,
        requestResync
    });

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
        geometryApplication.reset();
        networkState.bufferMs = networkConfig.initialBufferMs;
        networkState.targetBufferMs = networkConfig.initialBufferMs;
        networkState.serverOffset = 0;
        networkState.lastSnapshotReceivedAt = null;
        networkState.deltas = [];
        networkState.lastSnapshotDeltaMs = 0;
        networkState.averageSnapshotDeltaMs = 0;
        networkState.jitterMs = 0;
        debugState.visiblePlayers = 0;
        debugState.visibleTerritories = 0;
        debugState.visibleTrails = 0;
        hasServerClockSync = false;
        lastRenderTime = Number.NEGATIVE_INFINITY;
    }

    function processSnapshot(rawSnapshot) {
        const now = performance.now();
        const applyResult = createSnapshotApplyResult();
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
            lastRenderTime = getMonotonicRenderTime(snapshots[0].time);
            return createRenderState(snapshots[0], snapshots[0].players);
        }

        const serverNow = Date.now() - networkState.serverOffset;
        const renderTime = getMonotonicRenderTime(serverNow - networkState.bufferMs);
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
            targetBufferMs: networkState.targetBufferMs,
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

    function expandSnapshot(rawSnapshot, applyResult) {
        if (rawSnapshot && rawSnapshot.schema === 2) {
            return expandCompactSnapshot(rawSnapshot, applyResult);
        }

        return expandLegacySnapshot(rawSnapshot);
    }

    function expandCompactSnapshot(rawSnapshot, applyResult) {
        const playerInfoCheckpoint = { ...entityCache.playerInfo };

        updatePlayerInfoCache(rawSnapshot.playerInfo, rawSnapshot.sequence);
        const geometry = geometryApplication.applySnapshotGeometry(
            rawSnapshot,
            applyResult,
            {
                territories: getPreviousSnapshotEntities("territories"),
                trails: getPreviousSnapshotEntities("trails")
            }
        );

        const players = expandPlayers(rawSnapshot.players, rawSnapshot.debug);

        if (!applyResult.applied) {
            entityCache.playerInfo = playerInfoCheckpoint;
        }

        debugState.visiblePlayers = Object.keys(players).length;
        debugState.visibleTerritories = Object.keys(geometry.territories).length;
        debugState.visibleTrails = Object.keys(geometry.trails).length;

        return {
            sequence: rawSnapshot.sequence,
            time: rawSnapshot.time,
            players,
            territories: geometry.territories,
            trails: geometry.trails,
            trailIds: geometry.trailIds,
            preserveTrails: Boolean(rawSnapshot.preserveTrails),
            catchStatus: normalizeCatchStatus(rawSnapshot.catchStatus),
            leaderboard: rawSnapshot.leaderboard || [],
            mode: rawSnapshot.mode || null,
            numbers: rawSnapshot.numbers || null
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
        networkState.targetBufferMs = clamp(
            nextBuffer,
            networkConfig.minBufferMs,
            networkConfig.maxBufferMs
        );
        networkState.bufferMs = limitAdaptiveBufferIncrease(
            networkState.bufferMs,
            networkState.targetBufferMs,
            delta,
            networkConfig
        );
    }

    function syncServerClock(serverTime) {
        const nextOffset = Date.now() - serverTime;

        if (!hasServerClockSync) {
            networkState.serverOffset = nextOffset;
            hasServerClockSync = true;
            return;
        }

        const smoothingFactor = clamp(
            getFiniteConfigNumber(networkConfig.serverClockSmoothingFactor, 0.1),
            0,
            1
        );
        const smoothedOffset = networkState.serverOffset * (1 - smoothingFactor)
            + nextOffset * smoothingFactor;
        const maxOffsetIncrease = Math.max(
            0,
            getFiniteConfigNumber(
                networkConfig.serverClockMaxOffsetIncreasePerSnapshotMs,
                2
            )
        );

        // A delayed packet increases Date.now() - serverTime even though the
        // clocks did not drift. Limit that direction because it moves the
        // render clock backwards; faster samples may correct it immediately.
        networkState.serverOffset = Math.min(
            smoothedOffset,
            networkState.serverOffset + maxOffsetIncrease
        );
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

    function getMonotonicRenderTime(candidateTime) {
        const latestSnapshot = snapshots[snapshots.length - 1];
        const latestTime = latestSnapshot && latestSnapshot.time;
        const fallbackTime = Number.isFinite(latestTime) ? latestTime : 0;
        const finiteCandidate = Number.isFinite(candidateTime) ? candidateTime : fallbackTime;
        const previousRenderTime = lastRenderTime;
        const monotonicCandidate = Number.isFinite(lastRenderTime)
            ? Math.max(lastRenderTime, finiteCandidate)
            : finiteCandidate;
        const canClampToLatestSnapshot = Number.isFinite(latestTime)
            && (!Number.isFinite(previousRenderTime) || latestTime >= previousRenderTime);

        lastRenderTime = canClampToLatestSnapshot
            ? Math.min(monotonicCandidate, latestTime)
            : monotonicCandidate;

        return lastRenderTime;
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

        if (!shouldPredictTrails(amount)) {
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
        return networkConfig.trailPredictionEnabled !== false && amount > 0;
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

    function getPreviousSnapshotEntities(key) {
        if (snapshots.length === 0) {
            return {};
        }

        return snapshots[snapshots.length - 1][key] || {};
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
