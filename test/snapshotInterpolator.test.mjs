import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const serverConfig = require("../src/config/gameConfig");
const { Player } = require("../src/entities/player");
const {
    createTerritories,
    initializePlayerTerritory
} = require("../src/state/territories");
const {
    createClientSnapshotState,
    createSnapshot: createServerSnapshot
} = require("../src/core/snapshotSerializer");

const interpolatorPath = new URL("../public/js/snapshotInterpolator.js", import.meta.url);
const source = await readFile(interpolatorPath, "utf8");
const adaptiveBufferPath = new URL("../public/js/adaptiveBuffer.js", import.meta.url);
const adaptiveBufferSource = (await readFile(adaptiveBufferPath, "utf8")).replace(
    'import { clamp } from "./sharedMath.js";',
    ""
).replaceAll("getFiniteConfigNumber", "getAdaptiveFiniteConfigNumber");
const snapshotGeometryPath = new URL("../public/js/snapshotGeometry.js", import.meta.url);
const snapshotGeometrySource = (await readFile(snapshotGeometryPath, "utf8")).replace(
    'import { clamp } from "./sharedMath.js";',
    ""
).replaceAll("coordinatePrecision", "snapshotGeometryCoordinatePrecision")
    .replaceAll("geometryEpsilon", "snapshotGeometryEpsilon")
    .replaceAll(
        "indexedBoundaryMaxDistanceSquared",
        "snapshotGeometryIndexedBoundaryMaxDistanceSquared"
    );
const snapshotDiagnosticsPath = new URL("../public/js/snapshotDiagnostics.js", import.meta.url);
const snapshotDiagnosticsSource = (await readFile(snapshotDiagnosticsPath, "utf8"))
    .replaceAll("export function ", "function ")
    .replaceAll("getFiniteConfigNumber", "getDiagnosticsFiniteConfigNumber");
const testableSource = source.replace(
    'import { clamp, lerp, lerpAngle } from "./sharedMath.js";',
    [
        "const clamp = (value, min, max) => Math.max(min, Math.min(max, value));",
        "const lerp = (start, end, amount) => start + (end - start) * amount;",
        "const lerpAngle = lerp;"
    ].join("\n")
).replace(
    'import { calculateAdaptiveBufferMetrics } from "./adaptiveBuffer.js";',
    adaptiveBufferSource
).replace(
    /import \{\s*createSnapshotDiagnostics,\s*finiteOrNull\s*\} from "\.\/snapshotDiagnostics\.js";/,
    snapshotDiagnosticsSource
).replace(
    /import \{[\s\S]*?\} from "\.\/snapshotGeometry\.js";/,
    snapshotGeometrySource
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`;
const {
    calculateAdaptiveBufferMetrics,
    createSnapshotInterpolator
} = await import(moduleUrl);
const viewportClippingPath = new URL("../public/js/renderers/viewportClipping.js", import.meta.url);
const viewportClippingSource = await readFile(viewportClippingPath, "utf8");
const viewportClippingUrl = `data:text/javascript;base64,${Buffer.from(viewportClippingSource).toString("base64")}`;
const { clipPolylineToBounds } = await import(viewportClippingUrl);

function createInterpolator(overrides = {}) {
    return createSnapshotInterpolator({
        initialBufferMs: 0,
        minBufferMs: 0,
        maxBufferMs: 0,
        maxSnapshots: 1,
        jitterMultiplier: 0,
        adaptiveBufferEnabled: false,
        ...overrides
    });
}

function createSnapshot(sequence, time, overrides = {}) {
    return {
        schema: 2,
        snapshotEpoch: 1,
        sequence,
        time,
        players: {},
        playerInfo: {},
        territoryIds: [],
        territoryVersions: {},
        territories: {},
        territoryOps: {},
        removedTerritoryIds: [],
        trailIds: [],
        trails: {},
        removedTrailIds: [],
        trailRemovals: {},
        leaderboard: [],
        ...overrides
    };
}

function createTerritory(version, size) {
    return {
        version,
        color: "#00ffff",
        base: [0, 0],
        polygon: [[
            [0, 0],
            [size, 0],
            [size, size],
            [0, size]
        ]]
    };
}

function createFullTrail(points, options = {}) {
    return {
        full: true,
        partial: Boolean(options.partial),
        generation: options.generation ?? 1,
        color: "#ff00ff",
        leftSegments: [points],
        rightSegments: [points.map(([x, y]) => [x, y + 2])],
        leftFillPath: points,
        rightFillPath: points.map(([x, y]) => [x, y + 2])
    };
}

function createTrailPatch(start, points, options = {}) {
    return {
        generation: options.generation ?? 1,
        partial: Boolean(options.partial),
        color: "#ff00ff",
        leftPatches: [{
            index: 0,
            start,
            points
        }],
        rightPatches: [{
            index: 0,
            start,
            points: points.map(([x, y]) => [x, y + 2])
        }],
        leftFillStart: start,
        leftFillPoints: points,
        rightFillStart: start,
        rightFillPoints: points.map(([x, y]) => [x, y + 2])
    };
}

test("adaptive buffer shares one sorted sample set for trimming and percentile", () => {
    const metrics = calculateAdaptiveBufferMetrics([10, 10, 10, 100], {
        adaptiveBufferMinSamplesForTrim: 4,
        adaptiveBufferPercentile: 0.75,
        adaptiveBufferTrimRatio: 0.25
    });

    assert.equal(metrics.average, 32.5);
    assert.equal(metrics.adaptiveAverage, 10);
    assert.equal(metrics.adaptiveJitter, 0);
    assert.equal(metrics.percentile, 10);
});

test("network diagnostics keeps normalized bounded history and resets independently", () => {
    const interpolator = createInterpolator({ diagnosticsHistoryLimit: 2 });

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        networkDiagnostics: { basePayloadBytes: 100 }
    }));
    interpolator.processSnapshot(createSnapshot(2, 2000, {
        networkDiagnostics: { basePayloadBytes: 200 }
    }));
    interpolator.processSnapshot(createSnapshot(3, 3000, {
        networkDiagnostics: { basePayloadBytes: "invalid" }
    }));

    const diagnostics = interpolator.getNetworkDiagnostics();

    assert.equal(diagnostics.events.length, 2);
    assert.equal(diagnostics.summary.samples, 2);
    assert.equal(diagnostics.summary.maxPayloadBytes, 200);
    assert.equal(diagnostics.current.lastServer.basePayloadBytes, null);

    interpolator.reset();

    const resetDiagnostics = interpolator.getNetworkDiagnostics();

    assert.equal(resetDiagnostics.events.length, 0);
    assert.equal(resetDiagnostics.summary.samples, 0);
    assert.equal(resetDiagnostics.current.lastServer, null);
});

test("late snapshots do not regress territory or trail render state", () => {
    const interpolator = createInterpolator();
    const completePoints = [[0, 0], [1, 0], [2, 0], [3, 0]];

    interpolator.processSnapshot(createSnapshot(2, 2000, {
        territoryIds: ["territory"],
        territoryVersions: { territory: 2 },
        territories: {
            territory: createTerritory(2, 20)
        },
        trailIds: ["player"],
        trails: {
            player: createFullTrail(completePoints)
        }
    }));

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        territoryIds: ["territory"],
        territoryVersions: { territory: 1 },
        territories: {
            territory: createTerritory(1, 10)
        },
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[0, 0], [1, 0]])
        }
    }));

    const state = interpolator.getRenderState();

    assert.equal(state.territories.territory.version, 2);
    assert.equal(state.territories.territory.polygon.rings[0][1].x, 20);
    assert.equal(state.trails.player.leftSegments[0].length, 4);
});

test("catch status is normalized and exposed in render state", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        catchStatus: {
            counterTargetCount: 2.9,
            counterRiskArmed: true,
            counterRiskRemainingMs: -20,
            threatCount: 1,
            threatArmed: false,
            threatRemainingMs: 742.2
        }
    }));

    assert.deepEqual(interpolator.getRenderState().catchStatus, {
        counterTargetCount: 2,
        counterRiskArmed: true,
        counterRiskRemainingMs: 0,
        threatCount: 1,
        threatArmed: false,
        threatRemainingMs: 743
    });
});

test("invalid snapshots are not inserted into the render buffer", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        territoryIds: ["territory"],
        territoryVersions: { territory: 1 },
        territories: {
            territory: createTerritory(1, 20)
        }
    }));

    const result = interpolator.processSnapshot(createSnapshot(2, 2000, {
        territoryIds: ["territory"],
        territoryVersions: { territory: 2 },
        territories: {
            territory: {
                version: 2,
                color: "#00ffff",
                base: [0, 0],
                polygon: {
                    rings: [[1, 2, 3]],
                    points: []
                }
            }
        }
    }));

    const state = interpolator.getRenderState();

    assert.equal(result.applied, false);
    assert.equal(state.territories.territory.version, 1);
});

test("partial full trail is staged until its remaining patches arrive", () => {
    const interpolator = createInterpolator();
    const completePoints = [[0, 0], [1, 0], [2, 0], [3, 0]];

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        trailIds: ["player"],
        trails: {
            player: createFullTrail(completePoints)
        }
    }));

    interpolator.processSnapshot(createSnapshot(2, 2000, {
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[0, 0], [1, 0]], {
                partial: true
            })
        }
    }));

    let state = interpolator.getRenderState();
    assert.equal(state.trails.player.leftSegments[0].length, 4);

    interpolator.processSnapshot(createSnapshot(3, 3000, {
        trailIds: ["player"],
        trails: {
            player: createTrailPatch(2, [[2, 0], [3, 0]])
        }
    }));

    state = interpolator.getRenderState();
    assert.equal(state.trails.player.leftSegments[0].length, 4);
    assert.deepEqual(
        state.trails.player.leftSegments[0].map(point => [point.x, point.y]),
        completePoints
    );
});

test("a first partial trail renders progressively without invalidating the snapshot", () => {
    const interpolator = createInterpolator();
    const firstResult = interpolator.processSnapshot(createSnapshot(1, 1000, {
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[0, 0], [1, 0]], {
                partial: true
            })
        }
    }));

    assert.equal(firstResult.applied, true);
    assert.equal(
        interpolator.getRenderState().trails.player.leftSegments[0].length,
        2
    );

    const completedResult = interpolator.processSnapshot(createSnapshot(2, 2000, {
        trailIds: ["player"],
        trails: {
            player: createTrailPatch(2, [[2, 0], [3, 0]])
        }
    }));

    assert.equal(completedResult.applied, true);
    assert.equal(
        interpolator.getRenderState().trails.player.leftSegments[0].length,
        4
    );
});

test("geometry remains visible until an explicit removal arrives", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        territoryIds: ["territory"],
        territoryVersions: { territory: 1 },
        territories: {
            territory: createTerritory(1, 20)
        },
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[0, 0], [1, 0]])
        }
    }));
    interpolator.processSnapshot(createSnapshot(2, 2000));

    let state = interpolator.getRenderState();
    assert.ok(state.territories.territory);
    assert.ok(state.trails.player);

    interpolator.processSnapshot(createSnapshot(3, 3000, {
        removedTerritoryIds: ["territory"],
        removedTrailIds: ["player"],
        trailRemovals: {
            player: 2
        }
    }));

    state = interpolator.getRenderState();
    assert.equal(state.territories.territory, undefined);
    assert.equal(state.trails.player, undefined);
});

test("trail tombstone rejects late generations and accepts a newer full trail", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[0, 0], [1, 0]], {
                generation: 2
            })
        }
    }));
    interpolator.processSnapshot(createSnapshot(2, 2000, {
        removedTrailIds: ["player"],
        trailRemovals: {
            player: 3
        }
    }));
    interpolator.processSnapshot(createSnapshot(3, 3000, {
        trailIds: ["player"],
        trails: {
            player: createTrailPatch(2, [[2, 0]], {
                generation: 2
            })
        }
    }));

    assert.equal(interpolator.getRenderState().trails.player, undefined);

    interpolator.processSnapshot(createSnapshot(4, 4000, {
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[10, 0], [11, 0]], {
                generation: 3
            })
        }
    }));

    assert.deepEqual(
        interpolator.getRenderState().trails.player.leftSegments[0]
            .map(point => [point.x, point.y]),
        [[10, 0], [11, 0]]
    );
});

test("failed snapshots do not commit explicit removals", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[0, 0], [1, 0]])
        }
    }));

    const result = interpolator.processSnapshot(createSnapshot(2, 2000, {
        territoryIds: ["invalid"],
        territoryVersions: { invalid: 1 },
        territories: {
            invalid: {
                version: 1,
                color: "#fff",
                base: [0, 0],
                polygon: {
                    rings: [[999]],
                    points: []
                }
            }
        },
        removedTrailIds: ["player"],
        trailRemovals: {
            player: 2
        }
    }));

    assert.equal(result.applied, false);

    interpolator.processSnapshot(createSnapshot(3, 3000));
    assert.ok(interpolator.getRenderState().trails.player);
});

test("failed snapshots roll back staged trail patches", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[0, 0], [1, 0]])
        }
    }));

    const failedResult = interpolator.processSnapshot(createSnapshot(2, 2000, {
        territoryIds: ["invalid"],
        territoryVersions: { invalid: 1 },
        territories: {
            invalid: {
                version: 1,
                color: "#fff",
                base: [0, 0],
                polygon: {
                    rings: [[999]],
                    points: []
                }
            }
        },
        trailIds: ["player"],
        trails: {
            player: createTrailPatch(2, [[2, 0], [3, 0]])
        }
    }));

    assert.equal(failedResult.applied, false);

    const recoveredResult = interpolator.processSnapshot(createSnapshot(3, 3000, {
        trailIds: ["player"],
        trails: {
            player: createTrailPatch(2, [[2, 0]])
        }
    }));
    const trail = interpolator.getRenderState().trails.player;

    assert.equal(recoveredResult.applied, true);
    assert.deepEqual(
        trail.leftSegments[0].map(point => [point.x, point.y]),
        [[0, 0], [1, 0], [2, 0]]
    );
});

test("snapshot epoch change discards geometry from the previous spectator target", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        snapshotEpoch: 1,
        players: {
            first: [0, 0, 0]
        },
        playerInfo: {
            first: ["#00ffff", 0, 0, 1, "Primeiro", 0, 1, 1, 0]
        },
        territoryIds: ["first"],
        territoryVersions: { first: 1 },
        territories: {
            first: createTerritory(1, 10)
        },
        trailIds: ["first"],
        trails: {
            first: createFullTrail([[0, 0], [10, 0]])
        }
    }));

    interpolator.processSnapshot(createSnapshot(2, 2000, {
        snapshotEpoch: 2,
        players: {
            second: [100, 0, 0]
        },
        playerInfo: {
            second: ["#ff00ff", 100, 0, 1, "Segundo", 0, 1, 1, 0]
        },
        territoryIds: ["second"],
        territoryVersions: { second: 1 },
        territories: {
            second: createTerritory(1, 20)
        },
        trailIds: ["second"],
        trails: {
            second: createFullTrail([[100, 0], [110, 0]])
        }
    }));

    const state = interpolator.getRenderState();

    assert.deepEqual(Object.keys(state.players), ["second"]);
    assert.deepEqual(Object.keys(state.territories), ["second"]);
    assert.deepEqual(Object.keys(state.trails), ["second"]);
    assert.equal(interpolator.getDebugState().snapshotEpoch, 2);
});

test("snapshot from an older epoch is ignored after a reset", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        snapshotEpoch: "socket:1"
    }));
    interpolator.processSnapshot(createSnapshot(2, 2000, {
        snapshotEpoch: "socket:2",
        players: {
            current: [50, 0, 0]
        },
        playerInfo: {
            current: ["#00ffff", 50, 0, 1, "Atual", 0, 1, 1, 0]
        }
    }));

    const result = interpolator.processSnapshot(createSnapshot(3, 3000, {
        snapshotEpoch: "socket:1",
        players: {
            stale: [0, 0, 0]
        },
        playerInfo: {
            stale: ["#ff0000", 0, 0, 1, "Antigo", 0, 1, 1, 0]
        }
    }));

    assert.equal(result.applied, true);
    assert.equal(result.ignored, true);
    assert.deepEqual(Object.keys(interpolator.getRenderState().players), ["current"]);
});

test("territory capture and trail removal switch as one geometry state", () => {
    const originalDateNow = Date.now;
    let currentTime = 2000;

    Date.now = () => currentTime;

    try {
        const interpolator = createInterpolator({
            maxSnapshots: 2
        });

        const firstResult = interpolator.processSnapshot(createSnapshot(1, 1000, {
            territoryIds: ["player"],
            territoryVersions: { player: 1 },
            territories: {
                player: createTerritory(1, 10)
            },
            trailIds: ["player"],
            trails: {
                player: createFullTrail([[0, 0], [1, 0]])
            }
        }));
        const secondResult = interpolator.processSnapshot(createSnapshot(2, 2000, {
            territoryIds: ["player"],
            territoryVersions: { player: 2 },
            territories: {
                player: createTerritory(2, 20)
            },
            removedTrailIds: ["player"],
            trailRemovals: {
                player: 2
            }
        }));

        assert.equal(firstResult.applied, true);
        assert.equal(secondResult.applied, true);
        assert.equal(interpolator.getDebugState().snapshotCount, 2);

        currentTime = 1500;
        let state = interpolator.getRenderState();
        assert.equal(state.territories.player.version, 1);
        assert.ok(state.trails.player);

        currentTime = 3000;
        state = interpolator.getRenderState();
        assert.equal(state.territories.player.version, 2);
        assert.equal(state.trails.player, undefined);
    } finally {
        Date.now = originalDateNow;
    }
});

test("viewport clipping preserves the visible tail of a very long trail", () => {
    const points = Array.from({ length: 5000 }, (_value, index) => ({
        x: index * 4,
        y: Math.sin(index / 20) * 120
    }));
    const lastPoint = points[points.length - 1];
    const clippedSegments = clipPolylineToBounds(points, {
        minX: lastPoint.x - 1200,
        minY: lastPoint.y - 500,
        maxX: lastPoint.x + 100,
        maxY: lastPoint.y + 500
    });
    const visibleTail = clippedSegments[clippedSegments.length - 1];
    const clippedLastPoint = visibleTail[visibleTail.length - 1];

    assert.ok(clippedSegments.length > 0);
    assert.equal(clippedLastPoint.x, lastPoint.x);
    assert.equal(clippedLastPoint.y, lastPoint.y);
});

test("server and client keep a large growing trail monotonic across chunked updates", () => {
    const player = new Player("player", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const serverState = createClientSnapshotState();
    const interpolator = createInterpolator();
    const initialPointCount = serverConfig.network.trailUpdateMaxPoints + 220;
    let sequence = 0;
    let previousRenderedLength = 0;

    initializePlayerTerritory(territories, player);
    player.trailLeftSegments = [[...createLongTrailPoints(initialPointCount, -20)]];
    player.trailRightSegments = [[...createLongTrailPoints(initialPointCount, 20)]];
    player.trailLeftFillPath = createLongTrailPoints(initialPointCount, -20);
    player.trailRightFillPath = createLongTrailPoints(initialPointCount, 20);

    for (let index = 0; index < 12; index++) {
        const snapshot = createServerSnapshot(
            players,
            territories,
            player.id,
            serverState,
            null,
            serverConfig
        );

        snapshot.sequence = ++sequence;
        snapshot.time = sequence * 1000;
        const result = interpolator.processSnapshot(snapshot);
        const renderedTrail = interpolator.getRenderState().trails[player.id];
        const renderedLength = renderedTrail
            ? renderedTrail.leftSegments[0].length
            : 0;

        assert.equal(result.applied, true);
        assert.ok(renderedLength >= previousRenderedLength);
        previousRenderedLength = renderedLength;

        if (renderedLength === initialPointCount) {
            break;
        }
    }

    assert.equal(previousRenderedLength, initialPointCount);
    serverState.trails.get(player.id).lastFullSentAt = 0;

    for (let index = initialPointCount; index < initialPointCount + 80; index++) {
        appendLongTrailPoint(player, index);
        const snapshot = createServerSnapshot(
            players,
            territories,
            player.id,
            serverState,
            null,
            serverConfig
        );
        const update = snapshot.trails[player.id];

        snapshot.sequence = ++sequence;
        snapshot.time = sequence * 1000;
        assert.ok(update);
        assert.notEqual(update.full, true);

        const result = interpolator.processSnapshot(snapshot);
        const renderedLength = interpolator.getRenderState()
            .trails[player.id].leftSegments[0].length;

        assert.equal(result.applied, true);
        assert.ok(renderedLength >= previousRenderedLength);
        previousRenderedLength = renderedLength;
    }

    assert.equal(previousRenderedLength, initialPointCount + 80);
});

test("deterministic snapshot soak recovers from dropped and reordered geometry updates", () => {
    const interpolator = createInterpolator({ maxSnapshots: 1 });
    const random = createSeededRandom(0x51a7c0de);
    const points = [[0, -20], [4, -20]];
    const pending = [];
    let sequence = 0;
    let territoryVersion = 1;
    let previousTrailLength = 0;
    let previousTerritoryVersion = 0;

    const deliver = snapshot => {
        const result = interpolator.processSnapshot(snapshot);
        const state = interpolator.getRenderState();
        const trail = state && state.trails.player;
        const territory = state && state.territories.player;

        if (trail) {
            const trailLength = trail.leftSegments[0].length;

            assert.ok(trailLength >= previousTrailLength);
            previousTrailLength = trailLength;
        }

        if (territory) {
            assert.ok(territory.version >= previousTerritoryVersion);
            previousTerritoryVersion = territory.version;
        }

        return result;
    };

    for (let step = 2; step <= 500; step++) {
        const point = [step * 4, -20];
        const fullTrail = step === 2 || step % 19 === 0;
        const territoryChanged = step === 2 || step % 47 === 0;

        points.push(point);

        if (territoryChanged && step !== 2) {
            territoryVersion++;
        }

        const snapshot = createSnapshot(++sequence, sequence * 50, {
            territoryIds: ["player"],
            territoryVersions: { player: territoryVersion },
            territories: territoryChanged
                ? { player: createTerritory(territoryVersion, 20 + territoryVersion) }
                : {},
            trailIds: ["player"],
            trails: {
                player: fullTrail
                    ? createFullTrail(points)
                    : createTrailPatch(points.length - 2, [point])
            }
        });
        const shouldDrop = !fullTrail && random() < 0.12;

        if (!shouldDrop) {
            pending.push({
                deliverAt: step + Math.floor(random() * 5),
                snapshot
            });
        }

        const descending = random() < 0.5;
        const ready = pending
            .filter(item => item.deliverAt <= step)
            .sort((first, second) => descending
                ? second.snapshot.sequence - first.snapshot.sequence
                : first.snapshot.sequence - second.snapshot.sequence);

        for (const item of ready) {
            pending.splice(pending.indexOf(item), 1);
            deliver(item.snapshot);
        }
    }

    const finalSnapshot = createSnapshot(++sequence, sequence * 50, {
        territoryIds: ["player"],
        territoryVersions: { player: territoryVersion },
        territories: {
            player: createTerritory(territoryVersion, 20 + territoryVersion)
        },
        trailIds: ["player"],
        trails: {
            player: createFullTrail(points)
        }
    });

    const finalResult = deliver(finalSnapshot);

    assert.equal(finalResult.applied, true);
    assert.equal(
        interpolator.getRenderState().trails.player.leftSegments[0].length,
        points.length
    );

    for (const item of pending) {
        deliver(item.snapshot);
    }

    const finalState = interpolator.getRenderState();

    assert.equal(finalState.trails.player.leftSegments[0].length, points.length);
    assert.equal(finalState.territories.player.version, territoryVersion);
});

function createLongTrailPoints(count, y) {
    return Array.from({ length: count }, (_value, index) => ({
        x: index * 4,
        y
    }));
}


function appendLongTrailPoint(player, index) {
    const x = index * 4;

    player.trailLeftSegments[0].push({ x, y: -20 });
    player.trailRightSegments[0].push({ x, y: 20 });
    player.trailLeftFillPath.push({ x, y: -20 });
    player.trailRightFillPath.push({ x, y: 20 });
}

function createSeededRandom(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}
