"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    calculateLinearSlope,
    getPercentile,
    keepSlowestSamples,
    summarizeDistribution,
    summarizeMemorySamples
} = require("../scripts/lib/botsSoakMetrics");

test("soak distributions calculate interpolated percentiles without mutating input", () => {
    const values = [40, 10, 30, 20];
    const summary = summarizeDistribution(values);

    assert.deepEqual(values, [40, 10, 30, 20]);
    assert.equal(summary.samples, 4);
    assert.equal(summary.min, 10);
    assert.equal(summary.mean, 25);
    assert.equal(summary.p50, 25);
    assert.equal(summary.p95, 38.5);
    assert.equal(summary.max, 40);
    assert.equal(getPercentile([], 0.95), null);
});

test("memory summary reports deltas and linear growth per thousand ticks", () => {
    const samples = [
        { tick: 0, heapUsed: 1000, rss: 4000, external: 100, arrayBuffers: 50 },
        { tick: 500, heapUsed: 2000, rss: 4500, external: 200, arrayBuffers: 75 },
        { tick: 1000, heapUsed: 3000, rss: 5000, external: 300, arrayBuffers: 100 }
    ];
    const summary = summarizeMemorySamples(samples, 1000);

    assert.equal(calculateLinearSlope(samples, "heapUsed"), 2);
    assert.equal(summary.heapUsedDeltaBytes, 2000);
    assert.equal(summary.rssDeltaBytes, 1000);
    assert.equal(summary.heapUsedSlopeBytesPer1000Ticks, 2000);
    assert.equal(summary.rssSlopeBytesPer1000Ticks, 1000);
});

test("slow tick collector retains only the requested largest samples", () => {
    const slowest = [];

    keepSlowestSamples(slowest, { tick: 1, durationMs: 2 }, 2);
    keepSlowestSamples(slowest, { tick: 2, durationMs: 5 }, 2);
    keepSlowestSamples(slowest, { tick: 3, durationMs: 3 }, 2);

    assert.deepEqual(slowest.map(sample => sample.tick), [2, 3]);
});
