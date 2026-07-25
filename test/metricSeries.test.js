"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MetricSeries, percentile } = require("../scripts/lib/metricSeries");

test("metric series summarizes all observations while bounding retained samples", () => {
    const series = new MetricSeries({ sampleLimit: 10, seed: 123 });

    for (let value = 1; value <= 1000; value++) {
        series.add(value);
    }

    const summary = series.summarize();
    assert.equal(summary.count, 1000);
    assert.equal(summary.samples, 10);
    assert.equal(summary.min, 1);
    assert.equal(summary.max, 1000);
    assert.equal(summary.mean, 500.5);
});

test("metric series ignores non-finite values and reports an empty distribution", () => {
    const series = new MetricSeries();

    assert.equal(series.add(Number.NaN), false);
    assert.equal(series.add(Number.POSITIVE_INFINITY), false);
    assert.deepEqual(series.summarize(), {
        count: 0,
        max: null,
        mean: null,
        min: null,
        p50: null,
        p95: null,
        p99: null,
        samples: 0
    });
});

test("percentile uses a nearest-rank boundary", () => {
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    assert.equal(percentile([1, 2, 3, 4], 0.99), 4);
});
