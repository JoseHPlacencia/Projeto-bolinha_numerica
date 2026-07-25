"use strict";

const DEFAULT_SAMPLE_LIMIT = 100000;

class MetricSeries {
    constructor(options = {}) {
        this.count = 0;
        this.maximum = null;
        this.minimum = null;
        this.sampleLimit = normalizeSampleLimit(options.sampleLimit);
        this.samples = [];
        this.seed = normalizeSeed(options.seed);
        this.sum = 0;
    }

    add(rawValue) {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return false;

        this.count++;
        this.sum += value;
        this.minimum = this.minimum === null ? value : Math.min(this.minimum, value);
        this.maximum = this.maximum === null ? value : Math.max(this.maximum, value);

        if (this.samples.length < this.sampleLimit) {
            this.samples.push(value);
            return true;
        }

        const replacementIndex = Math.floor(this.nextRandom() * this.count);
        if (replacementIndex < this.sampleLimit) {
            this.samples[replacementIndex] = value;
        }
        return true;
    }

    summarize() {
        if (this.count === 0) {
            return {
                count: 0,
                max: null,
                mean: null,
                min: null,
                p50: null,
                p95: null,
                p99: null,
                samples: 0
            };
        }

        const sorted = [...this.samples].sort((first, second) => first - second);
        return {
            count: this.count,
            max: round(this.maximum),
            mean: round(this.sum / this.count),
            min: round(this.minimum),
            p50: round(percentile(sorted, 0.5)),
            p95: round(percentile(sorted, 0.95)),
            p99: round(percentile(sorted, 0.99)),
            samples: sorted.length
        };
    }

    nextRandom() {
        this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
        return this.seed / 0x100000000;
    }
}

function percentile(sortedValues, ratio) {
    if (sortedValues.length === 0) return null;
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * ratio) - 1)
    );
    return sortedValues[index];
}

function normalizeSampleLimit(value) {
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_SAMPLE_LIMIT;
}

function normalizeSeed(value) {
    return Number.isInteger(value) ? value >>> 0 : 0x5eed1234;
}

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

module.exports = {
    MetricSeries,
    percentile
};
