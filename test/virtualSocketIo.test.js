const assert = require("node:assert/strict");
const test = require("node:test");
const { createVirtualSocketIo } = require("../src/core/virtualSocketIo");

test("virtual socket index exposes only sockets joined to a room", () => {
    const transport = createVirtualSocketIo();
    const first = transport.ensureSocket("first");
    const second = transport.ensureSocket("second");

    first.join("ROOM-A");
    second.join("ROOM-B");

    assert.deepEqual(transport.io.getRoomSockets("ROOM-A").map(socket => socket.id), ["first"]);
    assert.deepEqual(transport.io.getRoomSockets("ROOM-B").map(socket => socket.id), ["second"]);

    transport.removeSocket("first");
    assert.deepEqual(transport.io.getRoomSockets("ROOM-A"), []);
});

test("virtual socket forwards reliable acknowledgements to the worker callback", () => {
    const events = [];
    const transport = createVirtualSocketIo({ sendEvent: event => events.push(event) });
    const socket = transport.ensureSocket("player");
    let received = null;

    socket.timeout(500).emit("gameState", { sequence: 1 }, (error, acknowledgement) => {
        received = { error, acknowledgement };
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].timeoutMs, 500);
    assert.ok(events[0].acknowledgementId);

    transport.acknowledge({
        acknowledgement: { applied: true },
        acknowledgementId: events[0].acknowledgementId
    });

    assert.equal(received.error, null);
    assert.deepEqual(received.acknowledgement, { applied: true });
});
