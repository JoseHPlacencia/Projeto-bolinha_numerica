const assert = require("node:assert/strict");
const test = require("node:test");
const {
    prepareSocketEmission,
    resetAdaptiveSnapshotCompression
} = require("../src/core/adaptiveSnapshotCompression");

test("adaptive compression bypasses only the first writable snapshot after a drop", () => {
    const socket = createSocket();
    socket.conn.transport.writable = false;

    const dropped = prepareSocketEmission(socket, createOptions());
    assert.equal(dropped.compressionBypassed, false);
    assert.equal(socket.compressCalls.length, 0);

    socket.conn.transport.writable = true;
    const recovery = prepareSocketEmission(socket, createOptions());
    assert.equal(recovery.compressionBypassed, true);
    assert.deepEqual(socket.compressCalls, [false]);

    const regular = prepareSocketEmission(socket, createOptions());
    assert.equal(regular.compressionBypassed, false);
    assert.deepEqual(socket.compressCalls, [false]);
    assert.equal(socket.volatileReads, 3);
});

test("adaptive compression keeps reliable snapshots compressed", () => {
    const socket = createSocket();
    socket.conn.transport.writable = false;
    prepareSocketEmission(socket, createOptions());

    socket.conn.transport.writable = true;
    const reliable = prepareSocketEmission(socket, {
        adaptiveCompressionEnabled: true,
        eventName: "gameState",
        volatile: false
    });
    assert.equal(reliable.compressionBypassed, false);
    assert.equal(socket.compressCalls.length, 0);

    const recovery = prepareSocketEmission(socket, createOptions());
    assert.equal(recovery.compressionBypassed, true);
});

test("adaptive compression ignores other events and disabled configuration", () => {
    const socket = createSocket();
    socket.conn.transport.writable = false;

    prepareSocketEmission(socket, {
        adaptiveCompressionEnabled: true,
        eventName: "playerLeft",
        volatile: true
    });
    prepareSocketEmission(socket, {
        adaptiveCompressionEnabled: false,
        eventName: "gameState",
        volatile: true
    });

    socket.conn.transport.writable = true;
    const regular = prepareSocketEmission(socket, createOptions());
    assert.equal(regular.compressionBypassed, false);
    assert.equal(socket.compressCalls.length, 0);
});

test("adaptive compression reset discards a pending recovery", () => {
    const socket = createSocket();
    socket.conn.transport.writable = false;
    prepareSocketEmission(socket, createOptions());

    resetAdaptiveSnapshotCompression(socket);
    socket.conn.transport.writable = true;
    const regular = prepareSocketEmission(socket, createOptions());
    assert.equal(regular.compressionBypassed, false);
});

function createOptions() {
    return {
        adaptiveCompressionEnabled: true,
        eventName: "gameState",
        volatile: true
    };
}

function createSocket() {
    const socket = {
        compressCalls: [],
        conn: {
            transport: {
                writable: true
            }
        },
        compress(value) {
            this.compressCalls.push(value);
            return this;
        },
        volatileReads: 0
    };

    Object.defineProperty(socket, "volatile", {
        get() {
            this.volatileReads++;
            return this;
        }
    });
    return socket;
}
