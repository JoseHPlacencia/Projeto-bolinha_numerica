const assert = require("node:assert/strict");
const test = require("node:test");
const {
    DEFAULT_ADAPTIVE_SNAPSHOT_COMPRESSION_ENABLED,
    DEFAULT_SOCKET_COMPRESSION_LEVEL,
    MAX_SOCKET_COMPRESSION_LEVEL,
    MIN_SOCKET_COMPRESSION_LEVEL,
    resolveAdaptiveSnapshotCompressionEnabled,
    resolveSocketCompressionLevel
} = require("../src/config/socketRuntime");

test("adaptive snapshot compression defaults to disabled", () => {
    assert.equal(
        resolveAdaptiveSnapshotCompressionEnabled(undefined),
        DEFAULT_ADAPTIVE_SNAPSHOT_COMPRESSION_ENABLED
    );
    assert.equal(resolveAdaptiveSnapshotCompressionEnabled(""), false);
});

test("adaptive snapshot compression accepts explicit boolean values", () => {
    assert.equal(resolveAdaptiveSnapshotCompressionEnabled("true"), true);
    assert.equal(resolveAdaptiveSnapshotCompressionEnabled("1"), true);
    assert.equal(resolveAdaptiveSnapshotCompressionEnabled("false"), false);
    assert.equal(resolveAdaptiveSnapshotCompressionEnabled("0"), false);
});

test("adaptive snapshot compression rejects ambiguous values", () => {
    for (const value of ["yes", "enabled", "2", "-1"]) {
        assert.throws(
            () => resolveAdaptiveSnapshotCompressionEnabled(value),
            TypeError
        );
    }
});

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
