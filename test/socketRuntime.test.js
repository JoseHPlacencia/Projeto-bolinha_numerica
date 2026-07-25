const assert = require("node:assert/strict");
const test = require("node:test");
const {
    DEFAULT_SOCKET_COMPRESSION_LEVEL,
    MAX_SOCKET_COMPRESSION_LEVEL,
    MIN_SOCKET_COMPRESSION_LEVEL,
    resolveSocketCompressionLevel
} = require("../src/config/socketRuntime");

test("socket compression defaults to the production baseline", () => {
    assert.equal(
        resolveSocketCompressionLevel(undefined),
        DEFAULT_SOCKET_COMPRESSION_LEVEL
    );
    assert.equal(
        resolveSocketCompressionLevel(""),
        DEFAULT_SOCKET_COMPRESSION_LEVEL
    );
});

test("socket compression accepts every zlib level supported by the runtime", () => {
    for (
        let level = MIN_SOCKET_COMPRESSION_LEVEL;
        level <= MAX_SOCKET_COMPRESSION_LEVEL;
        level++
    ) {
        assert.equal(resolveSocketCompressionLevel(String(level)), level);
    }
});

test("socket compression rejects ambiguous or out-of-range values", () => {
    for (const value of ["0", "10", "1.5", "fast", "-1"]) {
        assert.throws(() => resolveSocketCompressionLevel(value), RangeError);
    }
});
