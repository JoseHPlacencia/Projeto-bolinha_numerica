import { clamp } from "./sharedMath.js";

/**
 * Calculates the network timing metrics used by the interpolation buffer.
 * The samples are sorted once so both outlier trimming and percentile lookup
 * share the same work.
 */
export function calculateAdaptiveBufferMetrics(values, config = {}) {
    if (!Array.isArray(values) || values.length === 0) {
        return createEmptyMetrics();
    }

    const overall = calculatePopulationStats(values);
    const sortedValues = [...values].sort((first, second) => first - second);
    const adaptiveSampleCount = getAdaptiveSampleCount(sortedValues.length, config);
    const adaptive = calculatePopulationStats(sortedValues, adaptiveSampleCount);
    const percentile = getPercentileFromSortedValues(
        sortedValues,
        getAdaptiveBufferPercentile(config)
    );

    return {
        adaptiveAverage: adaptive.average,
        adaptiveJitter: adaptive.standardDeviation,
        average: overall.average,
        jitter: overall.standardDeviation,
        percentile
    };
}

function createEmptyMetrics() {
    return {
        adaptiveAverage: 0,
        adaptiveJitter: 0,
        average: 0,
        jitter: 0,
        percentile: 0
    };
}

function calculatePopulationStats(values, count = values.length) {
    const sampleCount = Math.min(values.length, Math.max(0, count));

    if (sampleCount === 0) {
        return { average: 0, standardDeviation: 0 };
    }

    // Welford's method avoids a temporary deviations array and is numerically stable.
    let average = 0;
    let squaredDifferenceTotal = 0;

    for (let index = 0; index < sampleCount; index++) {
        const value = values[index];
        const difference = value - average;

        average += difference / (index + 1);
        squaredDifferenceTotal += difference * (value - average);
    }

    return {
        average,
        standardDeviation: Math.sqrt(Math.max(0, squaredDifferenceTotal / sampleCount))
    };
}

function getAdaptiveSampleCount(sampleCount, config) {
    const minSamplesForTrim = getPositiveIntegerConfigValue(
        config,
        "adaptiveBufferMinSamplesForTrim",
        10
    );

    if (sampleCount < minSamplesForTrim) {
        return sampleCount;
    }

    const trimRatio = clamp(
        getFiniteConfigNumber(config, "adaptiveBufferTrimRatio", 0.1),
        0,
        0.4
    );
    const trimCount = Math.floor(sampleCount * trimRatio);

    return Math.max(1, sampleCount - trimCount);
}

function getPercentileFromSortedValues(sortedValues, percentile) {
    const index = Math.min(
        sortedValues.length - 1,
        Math.ceil(sortedValues.length * percentile) - 1
    );

    return sortedValues[Math.max(0, index)];
}

function getAdaptiveBufferPercentile(config) {
    return clamp(
        getFiniteConfigNumber(config, "adaptiveBufferPercentile", 0.9),
        0.5,
        1
    );
}

function getPositiveIntegerConfigValue(config, key, fallback) {
    const value = Number(getConfigValue(config, key));

    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getFiniteConfigNumber(config, key, fallback) {
    const value = Number(getConfigValue(config, key));

    return Number.isFinite(value) ? value : fallback;
}

function getConfigValue(config, key) {
    return config && Object.prototype.hasOwnProperty.call(config, key)
        ? config[key]
        : null;
}
