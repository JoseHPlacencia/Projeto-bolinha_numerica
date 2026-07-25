const DEFAULT_SOCKET_COMPRESSION_LEVEL = 6;
const MAX_SOCKET_COMPRESSION_LEVEL = 9;
const MIN_SOCKET_COMPRESSION_LEVEL = 1;
const SOCKET_COMPRESSION_LEVEL_ENV = "VENNPERIO_SOCKET_COMPRESSION_LEVEL";

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

module.exports = {
    DEFAULT_SOCKET_COMPRESSION_LEVEL,
    MAX_SOCKET_COMPRESSION_LEVEL,
    MIN_SOCKET_COMPRESSION_LEVEL,
    SOCKET_COMPRESSION_LEVEL_ENV,
    resolveSocketCompressionLevel
};
