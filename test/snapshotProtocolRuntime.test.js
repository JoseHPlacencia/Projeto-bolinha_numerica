const assert = require("node:assert/strict");
const test = require("node:test");
const {
    applySocketSnapshotProtocol,
    getSocketSnapshotSchema,
    normalizeSnapshotSchema,
    supportsCachedSnapshotGlobals,
    supportsSeparatedReliableState
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

test("snapshot protocol preserves schema 3 and caps future versions at schema 4", () => {
    const socket = {
        data: {},
        handshake: {
            auth: { snapshotSchema: 3 }
        }
    };

    assert.equal(applySocketSnapshotProtocol(socket), 3);
    assert.equal(getSocketSnapshotSchema(socket), 3);
    assert.equal(supportsCachedSnapshotGlobals(socket.data.snapshotSchema), true);
    assert.equal(supportsSeparatedReliableState(socket.data.snapshotSchema), false);
    assert.equal(normalizeSnapshotSchema(99), 4);
    assert.equal(supportsSeparatedReliableState(4), true);
});

test("snapshot protocol rejects invalid or ambiguous schema values", () => {
    assert.equal(normalizeSnapshotSchema(undefined), 2);
    assert.equal(normalizeSnapshotSchema("invalid"), 2);
    assert.equal(normalizeSnapshotSchema(2), 2);
    assert.equal(normalizeSnapshotSchema(2.5), 2);
});
