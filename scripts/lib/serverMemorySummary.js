"use strict";

const ISOLATE_MEMORY_FIELDS = Object.freeze([
    "arrayBuffersBytes",
    "externalBytes",
    "heapTotalBytes",
    "heapUsedBytes"
]);

function createServerMemorySummary(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") return null;

    const gateway = normalizeMemorySnapshot(diagnostics.gatewayMemory);
    const workers = [];

    for (const worker of diagnostics.workerDiagnostics || []) {
        const workerId = Number(worker && worker.id);
        const metrics = worker && worker.metrics;
        const memory = normalizeMemorySnapshot(metrics && metrics.memory);

        if (!Number.isInteger(workerId) || !memory) continue;
        workers.push({
            connectionCount: finiteNonNegative(metrics && metrics.connectionCount),
            id: workerId,
            memory,
            playerCount: finiteNonNegative(metrics && metrics.playerCount),
            roomBindingCount: finiteNonNegative(metrics && metrics.roomBindingCount),
            roomCount: finiteNonNegative(
                (metrics && metrics.roomCount) ?? (worker && worker.roomCount)
            )
        });
    }
    workers.sort((left, right) => left.id - right.id);

    if (!gateway && workers.length === 0) return null;

    const isolateTotals = createEmptyIsolateMemory();
    if (gateway) addIsolateMemory(isolateTotals, gateway);
    for (const worker of workers) addIsolateMemory(isolateTotals, worker.memory);

    return {
        sampledAt: Math.max(
            finiteNonNegative(gateway && gateway.sampledAt),
            ...workers.map(worker => finiteNonNegative(worker.memory.sampledAt))
        ),
        processRssBytes: gateway
            ? gateway.rssBytes
            : workers[0].memory.rssBytes,
        gateway,
        isolateTotals,
        connectionCount: workers.reduce(
            (total, worker) => total + worker.connectionCount,
            0
        ),
        playerCount: workers.reduce(
            (total, worker) => total + worker.playerCount,
            0
        ),
        roomBindingCount: workers.reduce(
            (total, worker) => total + worker.roomBindingCount,
            0
        ),
        roomCount: workers.reduce(
            (total, worker) => total + worker.roomCount,
            0
        ),
        workers
    };
}

function createServerMemoryDelta(before, after) {
    if (!before || !after) return null;

    const workerBefore = new Map(
        (before.workers || []).map(worker => [worker.id, worker])
    );

    return {
        processRssBytes: subtract(after.processRssBytes, before.processRssBytes),
        gateway: subtractMemory(after.gateway, before.gateway, true),
        isolateTotals: subtractMemory(
            after.isolateTotals,
            before.isolateTotals
        ),
        workers: (after.workers || []).map(worker => ({
            id: worker.id,
            memory: subtractMemory(
                worker.memory,
                workerBefore.get(worker.id)?.memory,
                true
            )
        }))
    };
}

function normalizeMemorySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;

    const normalized = {
        arrayBuffersBytes: finiteNonNegative(snapshot.arrayBuffersBytes),
        externalBytes: finiteNonNegative(snapshot.externalBytes),
        heapTotalBytes: finiteNonNegative(snapshot.heapTotalBytes),
        heapUsedBytes: finiteNonNegative(snapshot.heapUsedBytes),
        rssBytes: finiteNonNegative(snapshot.rssBytes),
        sampledAt: finiteNonNegative(snapshot.sampledAt)
    };

    return normalized;
}

function createEmptyIsolateMemory() {
    return Object.fromEntries(ISOLATE_MEMORY_FIELDS.map(field => [field, 0]));
}

function addIsolateMemory(target, source) {
    for (const field of ISOLATE_MEMORY_FIELDS) {
        target[field] += finiteNonNegative(source && source[field]);
    }
}

function subtractMemory(after, before, includeRss = false) {
    if (!after || !before) return null;

    const fields = includeRss
        ? [...ISOLATE_MEMORY_FIELDS, "rssBytes"]
        : ISOLATE_MEMORY_FIELDS;

    return Object.fromEntries(fields.map(field => [
        field,
        subtract(after[field], before[field])
    ]));
}

function subtract(after, before) {
    return finiteNonNegative(after) - finiteNonNegative(before);
}

function finiteNonNegative(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0
        ? numericValue
        : 0;
}

module.exports = {
    ISOLATE_MEMORY_FIELDS,
    createServerMemoryDelta,
    createServerMemorySummary,
    normalizeMemorySnapshot
};
