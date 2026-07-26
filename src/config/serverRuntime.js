const os = require("node:os");

const MIN_SERVER_CORES = 2;
const MAX_SERVER_CORES = 4;
const SERVER_CORES_ENV = "VENNPERIO_SERVER_CORES";
const DEFAULT_ROOM_WORKER_IDLE_RECYCLE_MS = 60000;
const MIN_ROOM_WORKER_IDLE_RECYCLE_MS = 5000;
const MAX_ROOM_WORKER_IDLE_RECYCLE_MS = 3600000;
const ROOM_WORKER_IDLE_RECYCLE_MS_ENV = "VENNPERIO_ROOM_WORKER_IDLE_RECYCLE_MS";

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

function resolveRoomWorkerIdleRecycleMs(
    rawValue = process.env[ROOM_WORKER_IDLE_RECYCLE_MS_ENV]
) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
        return DEFAULT_ROOM_WORKER_IDLE_RECYCLE_MS;
    }

    const normalizedValue = String(rawValue).trim();
    const idleRecycleMs = Number(normalizedValue);

    if (idleRecycleMs === 0 && normalizedValue === "0") {
        return 0;
    }

    if (
        !/^\d+$/.test(normalizedValue)
        || !Number.isInteger(idleRecycleMs)
        || idleRecycleMs < MIN_ROOM_WORKER_IDLE_RECYCLE_MS
        || idleRecycleMs > MAX_ROOM_WORKER_IDLE_RECYCLE_MS
    ) {
        throw new RangeError(
            `${ROOM_WORKER_IDLE_RECYCLE_MS_ENV} must be 0 or an integer from `
            + `${MIN_ROOM_WORKER_IDLE_RECYCLE_MS} to ${MAX_ROOM_WORKER_IDLE_RECYCLE_MS}.`
        );
    }

    return idleRecycleMs;
}

module.exports = {
    DEFAULT_ROOM_WORKER_IDLE_RECYCLE_MS,
    MAX_SERVER_CORES,
    MAX_ROOM_WORKER_IDLE_RECYCLE_MS,
    MIN_SERVER_CORES,
    MIN_ROOM_WORKER_IDLE_RECYCLE_MS,
    ROOM_WORKER_IDLE_RECYCLE_MS_ENV,
    SERVER_CORES_ENV,
    resolveRoomWorkerIdleRecycleMs,
    resolveServerCoreCount
};
