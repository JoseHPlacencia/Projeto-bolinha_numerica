const assert = require("node:assert");
const { test } = require("node:test");
const {
    createRoom,
    joinRoom,
    leaveRoom,
    getRoomBySocketId,
    rooms
} = require("./roomManager.js");

const fakeIo = {
    to() {
        return {
            volatile: {
                emit() {
                    // no-op
                }
            }
        };
    }
};

function createSocket(id) {
    return {
        id,
        data: {},
        join() {},
        leave() {}
    };
}

test("createRoom generates a valid room code", () => {
    const result = createRoom(fakeIo);

    assert.strictEqual(result.success, true);
    assert.strictEqual(typeof result.room.code, "string");
    assert.strictEqual(result.room.code.length, 6);
    assert.ok(/^[A-Z0-9]{6}$/.test(result.room.code));
});

test("joinRoom associates socket with room and retrieves it by socket id", () => {
    const roomResult = createRoom(fakeIo);
    assert.strictEqual(roomResult.success, true);

    const socket = createSocket("player-1");
    const joinResult = joinRoom(roomResult.room.code, socket);

    assert.strictEqual(joinResult.success, true);
    assert.strictEqual(roomResult.room.players.has(socket.id), true);
    assert.strictEqual(getRoomBySocketId(socket.id), roomResult.room);
});

test("leaveRoom removes socket from room and destroys empty room", () => {
    const roomResult = createRoom(fakeIo);
    assert.strictEqual(roomResult.success, true);

    const socket = createSocket("player-2");
    const joinResult = joinRoom(roomResult.room.code, socket);
    assert.strictEqual(joinResult.success, true);

    const leaveResult = leaveRoom(socket);
    assert.strictEqual(leaveResult.destroyed, true);
    assert.strictEqual(rooms.has(roomResult.room.code), false);
    assert.strictEqual(getRoomBySocketId(socket.id), null);
});
