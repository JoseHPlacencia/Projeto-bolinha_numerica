const assert = require("node:assert/strict");
const test = require("node:test");
const {
    applySocketSnapshotProtocol,
    getSocketSnapshotSchema,
    normalizeSnapshotSchema,
    supportsCachedSnapshotGlobals
} = require("../src/core/snapshotProtocol");

test("snapshot protocol keeps unadvertised clients on schema 2", () => {
    const socket = {
        data: {},
        handshake: { auth: {} }
    };

    assert.equal(applySocketSnapshotProtocol(socket), 2);
    assert.equal(getSocketSnapshotSchema(socket), 2);
    assert.equal(supportsCachedSnapshotGlobals(socket.data.snapshotSchema), false);
});

test("snapshot protocol negotiates schema 3 and caps future versions", () => {
    const socket = {
        data: {},
        handshake: {
            auth: { snapshotSchema: 3 }
        }
    };

    assert.equal(applySocketSnapshotProtocol(socket), 3);
    assert.equal(getSocketSnapshotSchema(socket), 3);
    assert.equal(supportsCachedSnapshotGlobals(socket.data.snapshotSchema), true);
    assert.equal(normalizeSnapshotSchema(99), 3);
});

test("snapshot protocol rejects invalid or ambiguous schema values", () => {
    assert.equal(normalizeSnapshotSchema(undefined), 2);
    assert.equal(normalizeSnapshotSchema("invalid"), 2);
    assert.equal(normalizeSnapshotSchema(2), 2);
    assert.equal(normalizeSnapshotSchema(2.5), 2);
});
