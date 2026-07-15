const os = require("node:os");

const MIN_SERVER_CORES = 2;
const MAX_SERVER_CORES = 4;
const SERVER_CORES_ENV = "VENNPERIO_SERVER_CORES";

function resolveServerCoreCount(
    rawValue = process.env[SERVER_CORES_ENV],
    availableCoreCount = getAvailableCoreCount()
) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
        return clampCoreCount(availableCoreCount);
    }

    const normalizedValue = String(rawValue).trim();
    const coreCount = Number(normalizedValue);

    if (
        !/^\d+$/.test(normalizedValue)
        || !Number.isInteger(coreCount)
        || coreCount < MIN_SERVER_CORES
        || coreCount > MAX_SERVER_CORES
    ) {
        throw new RangeError(
            `${SERVER_CORES_ENV} must be an integer from ${MIN_SERVER_CORES} to ${MAX_SERVER_CORES}.`
        );
    }

    return coreCount;
}

function getAvailableCoreCount() {
    if (typeof os.availableParallelism === "function") {
        return os.availableParallelism();
    }

    const cpus = os.cpus();
    return Array.isArray(cpus) && cpus.length > 0 ? cpus.length : MIN_SERVER_CORES;
}

function clampCoreCount(rawCoreCount) {
    const coreCount = Number.isFinite(Number(rawCoreCount))
        ? Math.floor(Number(rawCoreCount))
        : MIN_SERVER_CORES;

    return Math.min(MAX_SERVER_CORES, Math.max(MIN_SERVER_CORES, coreCount));
}

module.exports = {
    MAX_SERVER_CORES,
    MIN_SERVER_CORES,
    SERVER_CORES_ENV,
    resolveServerCoreCount
};
