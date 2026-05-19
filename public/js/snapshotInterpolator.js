import { clamp, lerp, lerpAngle } from "./sharedMath.js";

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
    let lastResyncRequestedAt = Number.NEGATIVE_INFINITY;

    return {
        getDebugState,
        getRenderState,
        processSnapshot
    };

    function processSnapshot(rawSnapshot) {
        const now = performance.now();
        const snapshot = expandSnapshot(rawSnapshot);

        updateAdaptiveBuffer(now);
        syncServerClock(snapshot.time);
        saveSnapshot(snapshot);
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

    function expandSnapshot(rawSnapshot) {
        if (rawSnapshot && rawSnapshot.schema === 2) {
            return expandCompactSnapshot(rawSnapshot);
        }

        return expandLegacySnapshot(rawSnapshot);
    }

    function expandCompactSnapshot(rawSnapshot) {
        updatePlayerInfoCache(rawSnapshot.playerInfo);
        updateTerritoryCache(rawSnapshot.territories);
        updateTrailCache(rawSnapshot.trails);

        const players = expandPlayers(rawSnapshot.players, rawSnapshot.debug);
        const territories = selectCachedEntities(entityCache.territories, rawSnapshot.territoryIds);
        const trails = selectCachedEntities(entityCache.trails, rawSnapshot.trailIds);

        requestResyncForMissingCachedEntities(rawSnapshot.territoryIds, territories);
        requestResyncForStaleCachedVersions(rawSnapshot.territoryVersions, territories);
        requestResyncForMissingCachedEntities(rawSnapshot.trailIds, trails);

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

    function updateTerritoryCache(territories) {
        for (const [id, territory] of Object.entries(territories || {})) {
            const base = territory.base || [0, 0];
            const polygon = unpackTerritoryPolygon(territory.polygon);

            if (!polygon) {
                requestResync();
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
        }
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

    function updateTrailCache(trails) {
        for (const [id, update] of Object.entries(trails || {})) {
            if (update.full) {
                entityCache.trails[id] = createFullTrail(id, update);
                continue;
            }

            const trail = entityCache.trails[id];
            const patchedTrail = trail && createPatchedTrail(trail, update);

            if (!patchedTrail) {
                delete entityCache.trails[id];
                requestResync();
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

    function requestResyncForMissingCachedEntities(ids, selectedEntities) {
        for (const id of ids || []) {
            if (!selectedEntities[id]) {
                requestResync();
                return;
            }
        }
    }

    function requestResyncForStaleCachedVersions(versions, selectedEntities) {
        for (const [id, version] of Object.entries(versions || {})) {
            const entity = selectedEntities[id];

            if (!entity || entity.version !== version) {
                requestResync();
                return;
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

function calculateAverage(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateStandardDeviation(values, average) {
    const variance = values
        .map(value => (value - average) ** 2)
        .reduce((sum, value) => sum + value, 0) / values.length;

    return Math.sqrt(variance);
}
