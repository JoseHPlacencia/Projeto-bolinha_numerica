"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    calculateLinearSlope,
    createTerritoryOverlapDetail,
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

test("territory overlap detail preserves the geometry and owner state of both subjects", () => {
    const players = new Map([
        ["alpha", { x: 12.3456, y: -8.7654, lives: 2 }]
    ]);
    const first = ["alpha", {
        area: 100.1236,
        baseX: 1,
        baseY: 2,
        bounds: { minX: 0, minY: -1, maxX: 10, maxY: 9 },
        polygon: [[[0, 0], [10, 0], [10, 10]]],
        version: 4
    }];
    const second = ["beta", {
        baseX: 20,
        baseY: 30,
        bounds: { minX: 5, minY: 5, maxX: 15, maxY: 15 },
        polygon: [[[5, 5], [15, 5], [15, 15]]],
        version: 7
    }];
    const detail = createTerritoryOverlapDetail({
        area: 25.5555,
        calculateArea: polygon => polygon === second[1].polygon ? 50.9876 : 0,
        firstEntry: first,
        getPointCount: polygon => polygon[0].length,
        players,
        secondEntry: second,
        tick: 600
    });

    assert.deepEqual(detail, {
        tick: 600,
        area: 25.556,
        first: {
            id: "alpha",
            version: 4,
            pointCount: 3,
            area: 100.124,
            bounds: { minX: 0, minY: -1, maxX: 10, maxY: 9 },
            base: { x: 1, y: 2 },
            owner: { x: 12.346, y: -8.765, lives: 2 }
        },
        second: {
            id: "beta",
            version: 7,
            pointCount: 3,
            area: 50.988,
            bounds: { minX: 5, minY: 5, maxX: 15, maxY: 15 },
            base: { x: 20, y: 30 },
            owner: null
        }
    });
});
