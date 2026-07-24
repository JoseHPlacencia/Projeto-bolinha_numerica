const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../src/config/gameConfig");
const {
    resolveSnapshotRate,
    startSnapshotLoop
} = require("../src/core/snapshotLoop");

test("snapshot loop schedules the configured room rate", context => {
    const scheduledIntervals = [];

    context.mock.method(global, "setInterval", (_callback, intervalMs) => {
        scheduledIntervals.push(intervalMs);
        return { intervalMs };
    });

    const backgroundLoop = startSnapshotLoop(
        null,
        new Map(),
        new Map(),
        "BOTS",
        null,
        null,
        null,
        { snapshotRate: config.menuBackground.snapshotRate }
    );
    const regularLoop = startSnapshotLoop(
        null,
        new Map(),
        new Map(),
        "ROOM",
        null
    );

    assert.deepEqual(scheduledIntervals, [100, 50]);
    assert.equal(backgroundLoop.intervalMs, 100);
    assert.equal(regularLoop.intervalMs, 50);
});

test("snapshot loop rate falls back to the regular room rate", () => {
    assert.equal(resolveSnapshotRate(undefined), config.loop.snapshotRate);
    assert.equal(resolveSnapshotRate(0), config.loop.snapshotRate);
    assert.equal(resolveSnapshotRate(10.5), config.loop.snapshotRate);
    assert.equal(resolveSnapshotRate(10), 10);
});
