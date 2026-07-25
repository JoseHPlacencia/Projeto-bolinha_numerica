const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../src/config/gameConfig");
const {
    DEFAULT_SOCKET_COMPRESSION_LEVEL,
    DEFAULT_SOCKET_COMPRESSION_THRESHOLD,
    MAX_SOCKET_COMPRESSION_LEVEL,
    MAX_SOCKET_COMPRESSION_THRESHOLD,
    MIN_SOCKET_COMPRESSION_LEVEL,
    MIN_SOCKET_COMPRESSION_THRESHOLD,
    resolveSocketCompressionLevel,
    resolveSocketCompressionThreshold
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

test("socket compression threshold uses a configurable bounded default", () => {
    assert.equal(
        resolveSocketCompressionThreshold(undefined),
        DEFAULT_SOCKET_COMPRESSION_THRESHOLD
    );
    assert.equal(
        resolveSocketCompressionThreshold(String(MIN_SOCKET_COMPRESSION_THRESHOLD)),
        MIN_SOCKET_COMPRESSION_THRESHOLD
    );
    assert.equal(
        resolveSocketCompressionThreshold(String(MAX_SOCKET_COMPRESSION_THRESHOLD)),
        MAX_SOCKET_COMPRESSION_THRESHOLD
    );

    for (const value of ["0", "255", "65537", "1.5", "large", "-1"]) {
        assert.throws(
            () => resolveSocketCompressionThreshold(value),
            RangeError
        );
    }
});

test("WebSocket compression disables context takeover so the threshold is effective", () => {
    assert.equal(
        config.socket.perMessageDeflate.serverNoContextTakeover,
        true
    );
    assert.ok(
        config.socket.perMessageDeflate.threshold
        >= MIN_SOCKET_COMPRESSION_THRESHOLD
    );
    assert.ok(
        config.socket.perMessageDeflate.threshold
        <= MAX_SOCKET_COMPRESSION_THRESHOLD
    );
});
