"use strict";

function summarizeDistribution(values) {
    const sorted = (values || [])
        .filter(Number.isFinite)
        .sort((first, second) => first - second);

    if (sorted.length === 0) {
        return {
            samples: 0,
            min: null,
            mean: null,
            p50: null,
            p95: null,
            p99: null,
            max: null
        };
    }

    const sum = sorted.reduce((total, value) => total + value, 0);

    return {
        samples: sorted.length,
        min: roundMetric(sorted[0]),
        mean: roundMetric(sum / sorted.length),
        p50: roundMetric(getPercentile(sorted, 0.5)),
        p95: roundMetric(getPercentile(sorted, 0.95)),
        p99: roundMetric(getPercentile(sorted, 0.99)),
        max: roundMetric(sorted[sorted.length - 1])
    };
}

function getPercentile(sortedValues, percentile) {
    if (!Array.isArray(sortedValues) || sortedValues.length === 0) {
        return null;
    }

    const boundedPercentile = Math.max(0, Math.min(1, percentile));
    const position = boundedPercentile * (sortedValues.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);

    if (lowerIndex === upperIndex) {
        return sortedValues[lowerIndex];
    }

    const progress = position - lowerIndex;
    return sortedValues[lowerIndex]
        + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * progress;
}

function summarizeMemorySamples(samples, tickSpan) {
    const normalized = (samples || []).filter(sample => (
        sample
        && Number.isFinite(sample.tick)
        && Number.isFinite(sample.heapUsed)
        && Number.isFinite(sample.rss)
    ));

    if (normalized.length === 0) {
        return {
            samples: 0,
            heapUsed: summarizeDistribution([]),
            rss: summarizeDistribution([]),
            heapUsedDeltaBytes: null,
            rssDeltaBytes: null,
            heapUsedSlopeBytesPer1000Ticks: null,
            rssSlopeBytesPer1000Ticks: null
        };
    }

    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    const effectiveTickSpan = Number.isFinite(tickSpan) && tickSpan > 0
        ? tickSpan
        : Math.max(1, last.tick - first.tick);

    return {
        samples: normalized.length,
        heapUsed: summarizeDistribution(normalized.map(sample => sample.heapUsed)),
        rss: summarizeDistribution(normalized.map(sample => sample.rss)),
        external: summarizeDistribution(normalized.map(sample => sample.external)),
        arrayBuffers: summarizeDistribution(normalized.map(sample => sample.arrayBuffers)),
        heapUsedDeltaBytes: last.heapUsed - first.heapUsed,
        rssDeltaBytes: last.rss - first.rss,
        heapUsedSlopeBytesPer1000Ticks: roundMetric(
            calculateLinearSlope(normalized, "heapUsed") * 1000
        ),
        rssSlopeBytesPer1000Ticks: roundMetric(
            calculateLinearSlope(normalized, "rss") * 1000
        ),
        measuredTickSpan: effectiveTickSpan
    };
}

function calculateLinearSlope(samples, valueKey) {
    const validSamples = (samples || []).filter(sample => (
        Number.isFinite(sample && sample.tick)
        && Number.isFinite(sample && sample[valueKey])
    ));

    if (validSamples.length < 2) {
        return 0;
    }

    const meanTick = validSamples.reduce((sum, sample) => sum + sample.tick, 0)
        / validSamples.length;
    const meanValue = validSamples.reduce((sum, sample) => sum + sample[valueKey], 0)
        / validSamples.length;
    let covariance = 0;
    let variance = 0;

    for (const sample of validSamples) {
        const tickDelta = sample.tick - meanTick;

        covariance += tickDelta * (sample[valueKey] - meanValue);
        variance += tickDelta * tickDelta;
    }

    return variance > 0 ? covariance / variance : 0;
}

function keepSlowestSamples(samples, sample, limit = 10) {
    if (!Array.isArray(samples) || !sample || !Number.isFinite(sample.durationMs)) {
        return;
    }

    samples.push(sample);
    samples.sort((first, second) => second.durationMs - first.durationMs);

    if (samples.length > limit) {
        samples.length = limit;
    }
}

function createTerritoryOverlapDetail(options) {
    const {
        area,
        calculateArea,
        firstEntry,
        getPointCount,
        players,
        secondEntry,
        tick
    } = options || {};

    return {
        tick: Number.isFinite(tick) ? tick : null,
        area: roundMetric(area),
        first: createTerritoryOverlapSubject(
            firstEntry,
            players,
            calculateArea,
            getPointCount
        ),
        second: createTerritoryOverlapSubject(
            secondEntry,
            players,
            calculateArea,
            getPointCount
        )
    };
}

function createTerritoryOverlapSubject(entry, players, calculateArea, getPointCount) {
    const [id, territory] = Array.isArray(entry) ? entry : [null, null];
    const polygon = territory && territory.polygon;
    const player = players && typeof players.get === "function" ? players.get(id) : null;
    const cachedArea = territory && territory.area;

    return {
        id,
        version: Number.isFinite(territory && territory.version)
            ? territory.version
            : null,
        pointCount: typeof getPointCount === "function"
            ? getPointCount(polygon)
            : null,
        area: roundMetric(Number.isFinite(cachedArea)
            ? cachedArea
            : typeof calculateArea === "function" ? calculateArea(polygon) : null),
        bounds: copyRoundedBounds(territory && territory.bounds),
        base: copyRoundedPoint(territory && territory.baseX, territory && territory.baseY),
        owner: player
            ? {
                x: roundMetric(player.x),
                y: roundMetric(player.y),
                lives: Number.isFinite(player.lives) ? player.lives : null
            }
            : null
    };
}

function copyRoundedBounds(bounds) {
    if (!bounds) {
        return null;
    }

    const copy = {
        minX: roundMetric(bounds.minX),
        minY: roundMetric(bounds.minY),
        maxX: roundMetric(bounds.maxX),
        maxY: roundMetric(bounds.maxY)
    };

    return Object.values(copy).every(Number.isFinite) ? copy : null;
}

function copyRoundedPoint(x, y) {
    return Number.isFinite(x) && Number.isFinite(y)
        ? { x: roundMetric(x), y: roundMetric(y) }
        : null;
}

function roundMetric(value) {
    return Number.isFinite(value)
        ? Math.round(value * 1000) / 1000
        : null;
}

module.exports = {
    calculateLinearSlope,
    createTerritoryOverlapDetail,
    getPercentile,
    keepSlowestSamples,
    roundMetric,
    summarizeDistribution,
    summarizeMemorySamples
};
