const MEMORY_SNAPSHOT_SCHEMA = 1;
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
const DIAGNOSTIC_FORCE_GC_ENV = "VENNPERIO_DIAGNOSTIC_FORCE_GC";

function createRuntimeMemorySnapshot(
    scope,
    usage = process.memoryUsage(),
    sampledAt = Date.now()
) {
    return {
        schema: MEMORY_SNAPSHOT_SCHEMA,
        scope: String(scope || "unknown"),
        sampledAt: finiteNonNegative(sampledAt),
        rssScope: "process",
        isolateFieldsScope: "thread",
        arrayBuffersBytes: finiteNonNegative(usage && usage.arrayBuffers),
        externalBytes: finiteNonNegative(usage && usage.external),
        heapTotalBytes: finiteNonNegative(usage && usage.heapTotal),
        heapUsedBytes: finiteNonNegative(usage && usage.heapUsed),
        rssBytes: finiteNonNegative(usage && usage.rss)
    };
}

function createRuntimeMemorySampler(scope, options = {}) {
    const memoryUsage = typeof options.memoryUsage === "function"
        ? options.memoryUsage
        : () => process.memoryUsage();
    const now = typeof options.now === "function" ? options.now : Date.now;
    const sampleIntervalMs = Number.isFinite(options.sampleIntervalMs)
        ? Math.max(0, options.sampleIntervalMs)
        : DEFAULT_SAMPLE_INTERVAL_MS;
    let lastSnapshot = null;

    return function sampleRuntimeMemory(force = false) {
        const sampledAt = now();

        if (
            !force
            && lastSnapshot
            && sampledAt - lastSnapshot.sampledAt < sampleIntervalMs
        ) {
            return lastSnapshot;
        }

        lastSnapshot = createRuntimeMemorySnapshot(
            scope,
            memoryUsage(),
            sampledAt
        );
        return lastSnapshot;
    };
}

function runDiagnosticGarbageCollection(requested, options = {}) {
    const configured = options.configured === undefined
        ? process.env[DIAGNOSTIC_FORCE_GC_ENV]
        : options.configured;
    const collectGarbage = typeof options.collectGarbage === "function"
        ? options.collectGarbage
        : global.gc;
    const enabled = String(configured || "").trim().toLowerCase() === "true";
    const supported = typeof collectGarbage === "function";
    const executed = requested === true && enabled && supported;

    if (executed) {
        collectGarbage();
    }

    return {
        enabled,
        executed,
        requested: requested === true,
        supported
    };
}

function finiteNonNegative(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0
        ? numericValue
        : 0;
}

module.exports = {
    DEFAULT_SAMPLE_INTERVAL_MS,
    DIAGNOSTIC_FORCE_GC_ENV,
    MEMORY_SNAPSHOT_SCHEMA,
    createRuntimeMemorySampler,
    createRuntimeMemorySnapshot,
    runDiagnosticGarbageCollection
};
