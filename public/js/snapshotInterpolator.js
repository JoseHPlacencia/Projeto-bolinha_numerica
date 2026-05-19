import { clamp, lerp, lerpAngle } from "./sharedMath.js";

export function createSnapshotInterpolator(networkConfig) {
    const snapshots = [];
    const networkState = {
        bufferMs: networkConfig.initialBufferMs,
        serverOffset: 0,
        lastSnapshotReceivedAt: performance.now(),
        deltas: []
    };

    return {
        getDebugState,
        getRenderState,
        processSnapshot
    };

    function processSnapshot(snapshot) {
        updateAdaptiveBuffer(performance.now());
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

        return createRenderState(next, interpolatePlayers(previous, next, amount));
    }

    function getDebugState() {
        return {
            bufferMs: networkState.bufferMs,
            snapshotCount: snapshots.length
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
        snapshots.push({
            time: snapshot.time,
            players: structuredClone(snapshot.players),
            territories: structuredClone(snapshot.territories || {}),
            trails: structuredClone(snapshot.trails || {}),
            numbers: structuredClone(snapshot.numbers || null)
        });

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
            trails: snapshot.trails,
            numbers: snapshot.numbers
        };
    }
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
