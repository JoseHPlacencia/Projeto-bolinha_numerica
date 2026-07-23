"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    assessCapacityReport,
    createCapacityScenarios
} = require("../scripts/lib/capacityMatrix");

test("capacity matrix covers mixed and bot-heavy load at every large map limit", () => {
    const scenarios = createCapacityScenarios();

    assert.deepEqual(
        scenarios.map(({ mapSize, mode, playerCount, botCount, numberCount }) => ({
            botCount,
            mapSize,
            mode,
            numberCount,
            playerCount
        })),
        [
            { mapSize: 1, mode: "mixed", playerCount: 16, botCount: 2, numberCount: 32 },
            { mapSize: 1, mode: "bot-heavy", playerCount: 14, botCount: 14, numberCount: 32 },
            { mapSize: 1.5, mode: "mixed", playerCount: 25, botCount: 2, numberCount: 72 },
            { mapSize: 1.5, mode: "bot-heavy", playerCount: 23, botCount: 23, numberCount: 72 },
            { mapSize: 2, mode: "mixed", playerCount: 36, botCount: 2, numberCount: 128 },
            { mapSize: 2, mode: "bot-heavy", playerCount: 34, botCount: 34, numberCount: 128 }
        ]
    );
});

test("capacity assessment distinguishes budget warnings from invariant failures", () => {
    const healthy = createReport({ snapshotP99: 10, tickP99: 5 });
    const slow = createReport({ snapshotP99: 55, tickP99: 18 });
    const invalid = createReport({ invalidGeometrySamples: 1, snapshotP99: 10, tickP99: 5 });

    assert.equal(assessCapacityReport(healthy).status, "pass");
    assert.equal(assessCapacityReport(slow).status, "warn");
    assert.deepEqual(
        assessCapacityReport(slow).issues.map(issue => issue.name),
        ["tick-p99", "snapshot-batch-p99"]
    );
    assert.equal(assessCapacityReport(invalid).status, "fail");
});

function createReport(options = {}) {
    return {
        geometry: {
            invalidGeometrySamples: options.invalidGeometrySamples || 0,
            territoryVersionRegressions: 0,
            trailGenerationRegressions: 0
        },
        timing: {
            phases: {
                snapshots: { p99: options.snapshotP99 }
            },
            tickDurationMs: { p99: options.tickP99 }
        }
    };
}
