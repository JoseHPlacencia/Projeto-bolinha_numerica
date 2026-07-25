import assert from "node:assert/strict";
import test from "node:test";
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
    cloneClientSnapshotState,
    createClientSnapshotState,
    createSnapshot: createServerSnapshot
} = require("../src/core/snapshotSerializer");
const { captureClosedTrail } = require("../src/systems/dominationSystem");

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
const snapshotGeometryApplicationPath = new URL(
    "../public/js/snapshotGeometryApplication.js",
    import.meta.url
);
const copyOnWriteTransactionPath = new URL(
    "../public/js/copyOnWriteTransaction.js",
    import.meta.url
);
const copyOnWriteTransactionSource = (await readFile(copyOnWriteTransactionPath, "utf8"))
    .replaceAll("export function ", "function ");
const rawSnapshotGeometryApplicationSource = await readFile(
    snapshotGeometryApplicationPath,
    "utf8"
);
const snapshotTrailWireFormatPath = new URL(
    "../public/js/snapshotTrailWireFormat.js",
    import.meta.url
);
const snapshotTrailWireFormatSource = (
    await readFile(snapshotTrailWireFormatPath, "utf8")
).replaceAll("export function ", "function ");
const snapshotGeometryImportMatch = source.match(
    /import\s*\{([^}]*)\}\s*from\s*"\.\/snapshotGeometry\.js";/
);
const snapshotApplicationGeometryImportMatch = rawSnapshotGeometryApplicationSource.match(
    /import\s*\{([^}]*)\}\s*from\s*"\.\/snapshotGeometry\.js";/
);
const snapshotGeometryImportedNames = [...new Set([
    ...getImportedNames(snapshotGeometryImportMatch),
    ...getImportedNames(snapshotApplicationGeometryImportMatch)
])];
const snapshotGeometryExportedNames = [
    ...snapshotGeometrySource.matchAll(
        /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g
    )
].map(match => match[1]);
const scopedSnapshotGeometrySource = [
    "const __snapshotGeometry = (() => {",
    snapshotGeometrySource.replaceAll("export function ", "function "),
    `return { ${snapshotGeometryExportedNames.join(", ")} };`,
    "})();",
    `const { ${snapshotGeometryImportedNames.join(", ")} } = __snapshotGeometry;`
].join("\n");
const snapshotDiagnosticsPath = new URL("../public/js/snapshotDiagnostics.js", import.meta.url);
const snapshotDiagnosticsSource = (await readFile(snapshotDiagnosticsPath, "utf8"))
    .replaceAll("export function ", "function ")
    .replaceAll("getFiniteConfigNumber", "getDiagnosticsFiniteConfigNumber");
const snapshotGeometryApplicationSource = rawSnapshotGeometryApplicationSource
    .replace(/import\s*\{[^}]*\}\s*from\s*"\.\/snapshotDiagnostics\.js";/, "")
    .replace(
        /import\s*\{[^}]*\}\s*from\s*"\.\/copyOnWriteTransaction\.js";/,
        copyOnWriteTransactionSource
    )
    .replace(
        /import\s*\{[^}]*\}\s*from\s*"\.\/snapshotTrailWireFormat\.js";/,
        snapshotTrailWireFormatSource
    )
    .replace(/import\s*\{[^}]*\}\s*from\s*"\.\/snapshotGeometry\.js";/, "");
const testableSource = source.replace(
    'import { clamp, lerp, lerpAngle } from "./sharedMath.js";',
    [
        "const clamp = (value, min, max) => Math.max(min, Math.min(max, value));",
        "const lerp = (start, end, amount) => start + (end - start) * amount;",
        "const lerpAngle = lerp;"
    ].join("\n")
).replace(
    /import \{[^}]*\} from "\.\/adaptiveBuffer\.js";/,
    adaptiveBufferSource
).replace(
    /import \{\s*createSnapshotDiagnostics\s*\} from "\.\/snapshotDiagnostics\.js";/,
    snapshotDiagnosticsSource
).replace(
    /import \{[\s\S]*?\} from "\.\/snapshotGeometryApplication\.js";/,
    snapshotGeometryApplicationSource
).replace(
    /import \{[\s\S]*?\} from "\.\/snapshotGeometry\.js";/,
    scopedSnapshotGeometrySource
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`;
const {
    calculateAdaptiveBufferMetrics,
    createSnapshotApplyResult,
    createSnapshotGeometryApplication,
    createSnapshotInterpolator,
    limitAdaptiveBufferIncrease
} = await import(moduleUrl);
const viewportClippingPath = new URL("../public/js/renderers/viewportClipping.js", import.meta.url);
const viewportClippingSource = await readFile(viewportClippingPath, "utf8");
const viewportClippingUrl = `data:text/javascript;base64,${Buffer.from(viewportClippingSource).toString("base64")}`;
const { clipPolylineToBounds } = await import(viewportClippingUrl);

function getImportedNames(importMatch) {
    return importMatch
        ? importMatch[1].split(",").map(name => name.trim()).filter(Boolean)
        : [];
}

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

function createGeometryPayload(sequence, overrides = {}) {
    return {
        sequence,
        territories: {},
        territoryIds: [],
        territoryOps: {},
        territoryVersions: {},
        removedTerritoryIds: [],
        trails: {},
        trailIds: [],
        trailRemovals: {},
        removedTrailIds: [],
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

function createReferencedTerritory(version, points, ring) {
    return {
        version,
        color: "#00ffff",
        base: [0, 0],
        polygon: {
            points,
            rings: [ring]
        }
    };
}

test("snapshot geometry imports are part of the module's public exports", () => {
    const importMatch = source.match(
        /import\s*\{([^}]*)\}\s*from\s*"\.\/snapshotGeometry\.js";/
    );
    const applicationImportMatch = rawSnapshotGeometryApplicationSource.match(
        /import\s*\{([^}]*)\}\s*from\s*"\.\/snapshotGeometry\.js";/
    );
    const importedNames = [...new Set([
        ...getImportedNames(importMatch),
        ...getImportedNames(applicationImportMatch)
    ])];
    const exportedNames = new Set(
        [...snapshotGeometrySource.matchAll(
            /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g
        )].map(match => match[1])
    );
    const missingExports = importedNames.filter(name => !exportedNames.has(name));

    assert.ok(importMatch, "interpolator snapshotGeometry import block exists");
    assert.ok(applicationImportMatch, "application snapshotGeometry import block exists");
    assert.deepEqual(missingExports, []);
});

test("geometry application rolls back a staged trail patch after another section fails", () => {
    const application = createSnapshotGeometryApplication();
    const initialResult = createSnapshotApplyResult();
    const initialGeometry = application.applySnapshotGeometry(
        createGeometryPayload(1, {
            trailIds: ["player"],
            trails: {
                player: createFullTrail([
                    [0, 0],
                    [1, 0]
                ])
            }
        }),
        initialResult
    );
    const invalidResult = createSnapshotApplyResult();
    const patch = createTrailPatch(2, [[2, 0]]);

    application.applySnapshotGeometry(
        createGeometryPayload(2, {
            territories: {
                invalid: {
                    version: 1,
                    base: [0, 0],
                    polygon: {
                        points: [],
                        rings: [[999]]
                    }
                }
            },
            trailIds: ["player"],
            trails: { player: patch }
        }),
        invalidResult,
        initialGeometry
    );

    assert.equal(invalidResult.applied, false);
    assert.deepEqual(invalidResult.invalidations.territories, ["invalid"]);

    const recoveredResult = createSnapshotApplyResult();
    const recoveredGeometry = application.applySnapshotGeometry(
        createGeometryPayload(3, {
            trailIds: ["player"],
            trails: { player: patch }
        }),
        recoveredResult,
        initialGeometry
    );

    assert.equal(recoveredResult.applied, true);
    assert.equal(recoveredGeometry.trails.player.leftSegments[0].length, 3);
    assert.equal(recoveredGeometry.trails.player.leftSegments[0][2].x, 2);
});

test("geometry application rolls back referenced point definitions", () => {
    const application = createSnapshotGeometryApplication();
    const firstResult = createSnapshotApplyResult();

    application.applySnapshotGeometry(createGeometryPayload(1, {
        territoryIds: ["first"],
        territoryVersions: { first: 1 },
        territories: {
            first: createReferencedTerritory(1, [[900, 0, 0]], [900, 901, 902])
        }
    }), firstResult);

    assert.equal(firstResult.applied, false);

    const secondResult = createSnapshotApplyResult();

    application.applySnapshotGeometry(createGeometryPayload(2, {
        territoryIds: ["second"],
        territoryVersions: { second: 1 },
        territories: {
            second: createReferencedTerritory(1, [
                [901, 10, 0],
                [902, 0, 10]
            ], [900, 901, 902])
        }
    }), secondResult);

    assert.equal(secondResult.applied, false);
    assert.deepEqual(secondResult.invalidations.territories, ["second"]);

    const completeResult = createSnapshotApplyResult();
    const completeGeometry = application.applySnapshotGeometry(createGeometryPayload(3, {
        territoryIds: ["complete"],
        territoryVersions: { complete: 1 },
        territories: {
            complete: createReferencedTerritory(1, [
                [900, 0, 0],
                [901, 10, 0],
                [902, 0, 10]
            ], [900, 901, 902])
        }
    }), completeResult);

    assert.equal(completeResult.applied, true);
    assert.equal(completeGeometry.territories.complete.polygon.rings[0].length, 3);
});

test("geometry application rolls back when a transaction callback throws", () => {
    const callbackError = new Error("expected resync callback failure");
    const application = createSnapshotGeometryApplication({}, {
        requestResync() {
            throw callbackError;
        }
    });
    const initialResult = createSnapshotApplyResult();
    const initialGeometry = application.applySnapshotGeometry(createGeometryPayload(1, {
        trailIds: ["player"],
        trails: {
            player: createFullTrail([[0, 0], [1, 0]])
        }
    }), initialResult);
    const failingResult = createSnapshotApplyResult();

    assert.throws(() => application.applySnapshotGeometry(createGeometryPayload(2, {
        territoryOps: {
            missing: {
                type: "trailCapture",
                baseVersion: 1,
                version: 2
            }
        },
        trailIds: ["player"],
        trails: {
            player: createTrailPatch(2, [[2, 0], [3, 0]])
        }
    }), failingResult, initialGeometry), callbackError);

    const recoveredResult = createSnapshotApplyResult();
    const recoveredGeometry = application.applySnapshotGeometry(createGeometryPayload(3, {
        trailIds: ["player"],
        trails: {
            player: createTrailPatch(2, [[2, 0]])
        }
    }), recoveredResult, initialGeometry);

    assert.equal(recoveredResult.applied, true);
    assert.deepEqual(
        recoveredGeometry.trails.player.leftSegments[0].map(point => [point.x, point.y]),
        [[0, 0], [1, 0], [2, 0]]
    );
    assert.equal(initialGeometry.trails.player.leftSegments[0].length, 2);
});

test("capture operation failure requests only selective territory recovery", () => {
    let resyncRequestCount = 0;
    const suppressedReasons = [];
    const application = createSnapshotGeometryApplication({
        captureOperationResyncEnabled: false
    }, {
        recordResyncSuppressed(reason) {
            suppressedReasons.push(reason);
        },
        requestResync() {
            resyncRequestCount++;
        }
    });
    const initialResult = createSnapshotApplyResult();
    const initialGeometry = application.applySnapshotGeometry(createGeometryPayload(1, {
        territoryIds: ["player"],
        territoryVersions: { player: 1 },
        territories: {
            player: createTerritory(1, 20)
        }
    }), initialResult);
    const captureResult = createSnapshotApplyResult();

    application.applySnapshotGeometry(createGeometryPayload(2, {
        territoryIds: ["player"],
        territoryVersions: { player: 1 },
        territoryOps: {
            player: {
                type: "trailCapture",
                baseVersion: 1,
                version: 2,
                trailGeneration: 2,
                trailSide: "left",
                trailSegmentIndex: 0,
                trailSegmentLength: 4
            }
        }
    }), captureResult, initialGeometry);

    assert.equal(captureResult.applied, false);
    assert.deepEqual(captureResult.invalidations.territories, ["player"]);
    assert.equal(resyncRequestCount, 0);
    assert.deepEqual(suppressedReasons, ["capture_operation_resync_disabled"]);
});

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

test("adaptive buffer limits increases and does not accumulate batched allowances", () => {
    const config = {
        adaptiveBufferMaxIncreasePerSnapshotMs: 4,
        adaptiveBufferMaxIncreaseRateMsPerSecond: 80
    };

    assert.equal(limitAdaptiveBufferIncrease(100, 180, 50, config), 104);
    assert.equal(limitAdaptiveBufferIncrease(104, 180, 0, config), 104);
    assert.equal(limitAdaptiveBufferIncrease(150, 100, 50, config), 100);
});

test("delayed packets cannot move the synchronized server clock sharply backwards", () => {
    const originalDateNow = Date.now;
    let currentTime = 1000;

    Date.now = () => currentTime;

    try {
        const interpolator = createInterpolator({
            maxSnapshots: 3,
            serverClockMaxOffsetIncreasePerSnapshotMs: 2,
            serverClockSmoothingFactor: 0.1
        });

        interpolator.processSnapshot(createSnapshot(1, 1000));
        currentTime = 1050;
        interpolator.processSnapshot(createSnapshot(2, 1050));
        currentTime = 1250;
        interpolator.processSnapshot(createSnapshot(3, 1100));

        assert.equal(interpolator.getDebugState().serverOffsetMs, 2);
    } finally {
        Date.now = originalDateNow;
    }
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
        networkDiagnostics: {
            basePayloadBytes: "invalid",
            snapshotStateCommitMs: 0.02,
            snapshotStateDraftMs: 0.01,
            snapshotStateTerritoryPointCount: 3000,
            lastSnapshotStateCommit: {
                at: 2990,
                ageMs: 10,
                durationMs: 0.03,
                reliableId: 4
            }
        }
    }));

    const diagnostics = interpolator.getNetworkDiagnostics();

    assert.equal(diagnostics.events.length, 2);
    assert.equal(diagnostics.summary.samples, 2);
    assert.equal(diagnostics.summary.maxPayloadBytes, 200);
    assert.equal(diagnostics.current.lastServer.basePayloadBytes, null);
    assert.equal(diagnostics.current.lastServer.snapshotStateCommitMs, 0.02);
    assert.equal(diagnostics.current.lastServer.snapshotStateDraftMs, 0.01);
    assert.equal(diagnostics.current.lastServer.snapshotStateTerritoryPointCount, 3000);
    assert.equal(diagnostics.current.lastServer.lastSnapshotStateCommit.durationMs, 0.03);

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

test("render timeline does not move geometry backward", () => {
    const originalDateNow = Date.now;
    let currentTime = 1000;

    Date.now = () => currentTime;

    try {
        const interpolator = createInterpolator({ maxSnapshots: 2 });

        interpolator.processSnapshot(createSnapshot(1, 1000, {
            territoryIds: ["territory"],
            territoryVersions: { territory: 1 },
            territories: {
                territory: createTerritory(1, 10)
            }
        }));

        currentTime = 2000;
        interpolator.processSnapshot(createSnapshot(2, 2000, {
            territoryIds: ["territory"],
            territoryVersions: { territory: 2 },
            territories: {
                territory: createTerritory(2, 20)
            }
        }));

        currentTime = 1600;
        assert.equal(interpolator.getRenderState().territories.territory.version, 2);

        currentTime = 1400;
        assert.equal(interpolator.getRenderState().territories.territory.version, 2);
    } finally {
        Date.now = originalDateNow;
    }
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

test("schema 3 retains compact global fields when later snapshots omit them", () => {
    const interpolator = createInterpolator();

    const initialResult = interpolator.processSnapshot(createSnapshot(1, 1000, {
        schema: 3,
        mode: "sets",
        leaderboard: [
            ["leader", "Líder", 12.345, 4],
            ["second", "Segundo", 8, 1]
        ]
    }));
    const deltaSnapshot = createSnapshot(2, 1100, {
        schema: 3
    });
    delete deltaSnapshot.leaderboard;
    const deltaResult = interpolator.processSnapshot(deltaSnapshot);
    const state = interpolator.getRenderState();

    assert.equal(initialResult.applied, true);
    assert.equal(deltaResult.applied, true);
    assert.equal(state.mode, "sets");
    assert.deepEqual(state.leaderboard, [
        {
            id: "leader",
            name: "Líder",
            areaPercent: 12.345,
            eliminations: 4,
            rank: 1
        },
        {
            id: "second",
            name: "Segundo",
            areaPercent: 8,
            eliminations: 1,
            rank: 2
        }
    ]);
});

test("failed schema 3 geometry does not commit a global delta", () => {
    const interpolator = createInterpolator();

    interpolator.processSnapshot(createSnapshot(1, 1000, {
        schema: 3,
        mode: "sets",
        leaderboard: [["leader", "Líder", 10, 1]]
    }));
    const failedResult = interpolator.processSnapshot(createSnapshot(2, 1100, {
        schema: 3,
        leaderboard: [["other", "Outro", 20, 2]],
        territoryIds: ["missing"],
        territoryVersions: { missing: 2 },
        territoryOps: {
            missing: {
                type: "trailCapture",
                baseVersion: 1,
                version: 2,
                trailGeneration: 1,
                trailSide: "left",
                trailSegmentIndex: 0,
                trailSegmentLength: 2
            }
        }
    }));
    const state = interpolator.getRenderState();

    assert.equal(failedResult.applied, false);
    assert.deepEqual(state.leaderboard.map(entry => entry.id), ["leader"]);
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

test("pending reliable geometry does not freeze prediction for preserved trails", () => {
    const originalDateNow = Date.now;
    let currentTime = 1000;

    Date.now = () => currentTime;

    try {
        const interpolator = createInterpolator({
            maxSnapshots: 2,
            trailPredictionEnabled: true,
            trailPredictionPlayerHalfWidth: 35
        });

        interpolator.processSnapshot(createSnapshot(1, 1000, {
            players: {
                player: [10, 0, 0]
            },
            playerInfo: {
                player: ["#ff00ff", 0, 0, 1, "Player", 0, 1, 1, 0]
            },
            trailIds: ["player"],
            trails: {
                player: createFullTrail([[0, 35], [10, 35]])
            }
        }));

        currentTime = 2000;
        interpolator.processSnapshot(createSnapshot(2, 2000, {
            players: {
                player: [100, 0, 0]
            },
            preserveTrails: true,
            trailIds: ["player"]
        }));

        currentTime = 2100;
        const trail = interpolator.getRenderState().trails.player;
        const lastPoint = trail.leftSegments[0][trail.leftSegments[0].length - 1];

        assert.equal(trail.leftSegments[0].length, 3);
        assert.deepEqual([lastPoint.x, lastPoint.y], [100, 35]);
    } finally {
        Date.now = originalDateNow;
    }
});

test("high interpolation buffer does not disable bounded trail prediction", () => {
    const originalDateNow = Date.now;
    let currentTime = 1000;

    Date.now = () => currentTime;

    try {
        const interpolator = createInterpolator({
            initialBufferMs: 200,
            minBufferMs: 200,
            maxBufferMs: 200,
            maxSnapshots: 2,
            trailPredictionEnabled: true,
            trailPredictionMaxPointDistance: 87.5,
            trailPredictionPlayerHalfWidth: 35
        });

        interpolator.processSnapshot(createSnapshot(1, 1000, {
            players: {
                player: [10, 0, 0]
            },
            playerInfo: {
                player: ["#ff00ff", 0, 0, 1, "Player", 0, 1, 1, 0]
            },
            trailIds: ["player"],
            trails: {
                player: createFullTrail([[0, 35], [10, 35]])
            }
        }));

        currentTime = 2000;
        interpolator.processSnapshot(createSnapshot(2, 2000, {
            players: {
                player: [95, 0, 0]
            },
            preserveTrails: true,
            trailIds: ["player"]
        }));

        currentTime = 2200;
        const state = interpolator.getRenderState();
        const trail = state.trails.player;
        const lastPoint = trail.leftSegments[0][trail.leftSegments[0].length - 1];

        assert.equal(interpolator.getDebugState().bufferMs, 200);
        assert.equal(trail.leftSegments[0].length, 3);
        assert.deepEqual([lastPoint.x, lastPoint.y], [95, 35]);
    } finally {
        Date.now = originalDateNow;
    }
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

test("capture operation reuses the acknowledged trail instead of resending it", () => {
    const player = new Player("player", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState();
    const boundaryX = Math.sqrt(200 ** 2 - 50 ** 2);
    const trailPointCount = serverConfig.network.trailUpdateMaxPoints * 3;
    const trailSnapshots = [];
    let sequence = 0;
    let laggingClientState = null;

    initializePlayerTerritory(territories, player);
    player.trailLeftSegments = [[...createCaptureTrailPoints(
        boundaryX,
        trailPointCount,
        1200
    )]];

    for (let attempt = 0; attempt < 10; attempt++) {
        const snapshot = createServerSnapshot(
            players,
            territories,
            player.id,
            clientState,
            null,
            serverConfig
        );

        snapshot.sequence = ++sequence;
        snapshot.snapshotEpoch = 1;
        trailSnapshots.push(snapshot);

        if (attempt === 0) {
            laggingClientState = cloneClientSnapshotState(clientState);
        }

        if (snapshot.trails[player.id]
            && snapshot.trails[player.id].partial !== true) {
            break;
        }
    }

    assert.equal(trailSnapshots[0].trails[player.id].partial, true);
    assert.equal(clientState.trails.get(player.id).pointCount, trailPointCount);

    assert.ok(captureClosedTrail(player, territories, players));
    player.clearTrailState();

    const laggingCaptureSnapshot = createServerSnapshot(
        players,
        territories,
        player.id,
        laggingClientState,
        null,
        serverConfig
    );

    assert.equal(laggingCaptureSnapshot.territoryOps[player.id], undefined);
    assert.ok(laggingCaptureSnapshot.territories[player.id]);

    const captureSnapshot = createServerSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        serverConfig
    );
    const operation = captureSnapshot.territoryOps[player.id];

    captureSnapshot.sequence = ++sequence;
    captureSnapshot.snapshotEpoch = 1;
    assert.ok(operation);
    assert.equal(operation.trailPoints, undefined);
    assert.equal(operation.trailTailPoints, undefined);
    assert.ok(JSON.stringify(operation).length < 1000);
    assert.ok(captureSnapshot.removedTrailIds.includes(player.id));

    const interpolator = createInterpolator();
    let initialResult = null;

    for (const snapshot of trailSnapshots) {
        initialResult = interpolator.processSnapshot(snapshot);
        assert.equal(initialResult.applied, true);
    }

    const captureResult = interpolator.processSnapshot(captureSnapshot);
    const state = interpolator.getRenderState();

    assert.equal(initialResult.applied, true);
    assert.equal(captureResult.applied, true);
    assert.equal(state.territories[player.id].version, 2);
    assert.equal(state.trails[player.id], undefined);
});

test("capture operation uses the newest partial trail generation", () => {
    const player = new Player("player", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState();
    const interpolator = createInterpolator();
    const boundaryX = Math.sqrt(200 ** 2 - 50 ** 2);
    let sequence = 0;

    initializePlayerTerritory(territories, player);
    player.trailLeftSegments = [[
        ...Array.from({ length: 300 }, () => ({ x: 999, y: 999 }))
    ]];

    const oldTrailSnapshot = createServerSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        serverConfig
    );

    oldTrailSnapshot.sequence = ++sequence;
    oldTrailSnapshot.snapshotEpoch = 1;
    assert.equal(interpolator.processSnapshot(oldTrailSnapshot).applied, true);

    player.clearTrailState();
    const captureTrailGeneration = player.trailGeneration;
    player.trailLeftSegments = [[...createCaptureTrailPoints(boundaryX, 200, 1200)]];
    player.trailLeftFillPath = createLongTrailPoints(600, -20);
    player.trailRightFillPath = createLongTrailPoints(600, 20);

    const partialTrailSnapshot = createServerSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        serverConfig
    );

    partialTrailSnapshot.sequence = ++sequence;
    partialTrailSnapshot.snapshotEpoch = 1;
    assert.equal(partialTrailSnapshot.trails[player.id].partial, true);
    assert.equal(interpolator.processSnapshot(partialTrailSnapshot).applied, true);
    assert.equal(
        interpolator.getRenderState().trails[player.id].leftSegments[0].length,
        300,
        "the previous complete trail remains visible while the new generation is staged"
    );

    assert.ok(captureClosedTrail(player, territories, players));
    player.clearTrailState();

    const captureSnapshot = createServerSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        serverConfig
    );
    const operation = captureSnapshot.territoryOps[player.id];

    captureSnapshot.sequence = ++sequence;
    captureSnapshot.snapshotEpoch = 1;
    assert.equal(operation.trailGeneration, captureTrailGeneration);
    assert.ok(operation.trailTailStart > 0);

    const captureResult = interpolator.processSnapshot(captureSnapshot);

    assert.equal(captureResult.applied, true);
    assert.equal(interpolator.getRenderState().territories[player.id].version, 2);
    assert.equal(interpolator.getRenderState().trails[player.id], undefined);
});

test("very long capture falls back to a full territory definition", () => {
    const player = new Player("player", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState();
    const boundaryX = Math.sqrt(200 ** 2 - 50 ** 2);
    const trailPointCount = serverConfig.network.captureOperationMaxTrailPoints + 1;

    initializePlayerTerritory(territories, player);
    player.trailLeftSegments = [[...createCaptureTrailPoints(
        boundaryX,
        trailPointCount,
        1200
    )]];

    createServerSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        serverConfig
    );

    assert.ok(captureClosedTrail(player, territories, players));
    assert.equal(territories.get(player.id).lastCaptureOperation, undefined);
    player.clearTrailState();

    const captureSnapshot = createServerSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        serverConfig
    );

    assert.equal(captureSnapshot.territoryOps[player.id], undefined);
    assert.ok(captureSnapshot.territories[player.id]);
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

test("schema 3 compact trail updates preserve continuous client geometry", () => {
    const player = new Player("player", { x: 30.75, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const serverState = createClientSnapshotState({ snapshotSchema: 3 });
    const interpolator = createInterpolator();
    const leftPoints = [
        { x: 0.125, y: -20 },
        { x: 15.25, y: -19.5 },
        { x: 30.75, y: -18.25 }
    ];
    const rightPoints = [
        { x: 0.125, y: 20 },
        { x: 15.25, y: 20.5 },
        { x: 30.75, y: 21.75 }
    ];

    initializePlayerTerritory(territories, player);
    player.trailLeftSegments = [[...leftPoints]];
    player.trailRightSegments = [[...rightPoints]];
    player.trailLeftFillPath = [...leftPoints];
    player.trailRightFillPath = [...rightPoints];

    const fullSnapshot = createServerSnapshot(
        players,
        territories,
        player.id,
        serverState,
        null,
        serverConfig
    );

    fullSnapshot.sequence = 1;
    fullSnapshot.snapshotEpoch = 1;
    assert.equal(Array.isArray(fullSnapshot.trails[player.id]), true);
    assert.equal(fullSnapshot.trails[player.id][0], 1);
    assert.equal(interpolator.processSnapshot(fullSnapshot).applied, true);

    let renderState = interpolator.getRenderState();
    let renderedTrail = renderState.trails[player.id];

    assert.equal(renderState.players[player.id].x, 30.8);
    assert.deepEqual(
        renderedTrail.leftSegments[0].map(point => [point.x, point.y]),
        [
            [0.1, -20],
            [15.3, -19.5],
            [30.8, -18.2]
        ]
    );

    const nextLeft = { x: 46.875, y: -16.75 };
    const nextRight = { x: 46.875, y: 23.25 };

    player.trailLeftSegments[0].push(nextLeft);
    player.trailRightSegments[0].push(nextRight);
    player.trailLeftFillPath.push(nextLeft);
    player.trailRightFillPath.push(nextRight);

    const patchSnapshot = createServerSnapshot(
        players,
        territories,
        player.id,
        serverState,
        null,
        serverConfig
    );

    patchSnapshot.sequence = 2;
    patchSnapshot.snapshotEpoch = 1;
    assert.equal(patchSnapshot.trails[player.id][0], 0);
    assert.equal(interpolator.processSnapshot(patchSnapshot).applied, true);

    renderState = interpolator.getRenderState();
    renderedTrail = renderState.trails[player.id];
    assert.deepEqual(
        renderedTrail.leftSegments[0].at(-1),
        { x: 46.9, y: -16.7 }
    );
    assert.deepEqual(
        renderedTrail.rightSegments[0].at(-1),
        { x: 46.9, y: 23.3 }
    );
    assert.equal(renderedTrail.fillPolygon.rings[0].length, 9);
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

function createCaptureTrailPoints(boundaryX, count, extent) {
    return Array.from({ length: count }, (_value, index) => {
        const progress = index / (count - 1);
        const outerX = boundaryX + extent;

        if (progress <= 1 / 3) {
            return {
                x: boundaryX + (outerX - boundaryX) * progress * 3,
                y: -50
            };
        }

        if (progress <= 2 / 3) {
            return {
                x: outerX,
                y: -50 + (progress - 1 / 3) * 300
            };
        }

        return {
            x: outerX - (outerX - boundaryX) * (progress - 2 / 3) * 3,
            y: 50
        };
    });
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
