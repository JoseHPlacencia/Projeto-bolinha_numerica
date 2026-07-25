const DEFAULT_SOCKET_COMPRESSION_LEVEL = 6;
const DEFAULT_SOCKET_COMPRESSION_THRESHOLD = 2048;
const MAX_SOCKET_COMPRESSION_LEVEL = 9;
const MAX_SOCKET_COMPRESSION_THRESHOLD = 65536;
const MIN_SOCKET_COMPRESSION_LEVEL = 1;
const MIN_SOCKET_COMPRESSION_THRESHOLD = 256;
const SOCKET_COMPRESSION_LEVEL_ENV = "VENNPERIO_SOCKET_COMPRESSION_LEVEL";
const SOCKET_COMPRESSION_THRESHOLD_ENV = "VENNPERIO_SOCKET_COMPRESSION_THRESHOLD";

function resolveSocketCompressionLevel(
    rawValue = process.env[SOCKET_COMPRESSION_LEVEL_ENV]
) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
        return DEFAULT_SOCKET_COMPRESSION_LEVEL;
    }

    const normalizedValue = String(rawValue).trim();
    const compressionLevel = Number(normalizedValue);

    if (
        !/^\d+$/.test(normalizedValue)
        || !Number.isInteger(compressionLevel)
        || compressionLevel < MIN_SOCKET_COMPRESSION_LEVEL
        || compressionLevel > MAX_SOCKET_COMPRESSION_LEVEL
    ) {
        throw new RangeError(
            `${SOCKET_COMPRESSION_LEVEL_ENV} must be an integer from `
            + `${MIN_SOCKET_COMPRESSION_LEVEL} to ${MAX_SOCKET_COMPRESSION_LEVEL}.`
        );
    }

    return compressionLevel;
}

function resolveSocketCompressionThreshold(
    rawValue = process.env[SOCKET_COMPRESSION_THRESHOLD_ENV]
) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
        return DEFAULT_SOCKET_COMPRESSION_THRESHOLD;
    }

    const normalizedValue = String(rawValue).trim();
    const threshold = Number(normalizedValue);

    if (
        !/^\d+$/.test(normalizedValue)
        || !Number.isInteger(threshold)
        || threshold < MIN_SOCKET_COMPRESSION_THRESHOLD
        || threshold > MAX_SOCKET_COMPRESSION_THRESHOLD
    ) {
        throw new RangeError(
            `${SOCKET_COMPRESSION_THRESHOLD_ENV} must be an integer from `
            + `${MIN_SOCKET_COMPRESSION_THRESHOLD} to `
            + `${MAX_SOCKET_COMPRESSION_THRESHOLD}.`
        );
    }

    return threshold;
}

module.exports = {
    DEFAULT_SOCKET_COMPRESSION_LEVEL,
    DEFAULT_SOCKET_COMPRESSION_THRESHOLD,
    MAX_SOCKET_COMPRESSION_LEVEL,
    MAX_SOCKET_COMPRESSION_THRESHOLD,
    MIN_SOCKET_COMPRESSION_LEVEL,
    MIN_SOCKET_COMPRESSION_THRESHOLD,
    SOCKET_COMPRESSION_LEVEL_ENV,
    SOCKET_COMPRESSION_THRESHOLD_ENV,
    resolveSocketCompressionLevel,
    resolveSocketCompressionThreshold
};
