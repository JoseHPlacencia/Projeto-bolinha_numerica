const test = require("node:test");
const assert = require("node:assert/strict");
const roomManager = require("../src/core/roomManager");
const registerSocket = require("../src/core/socketHandler");
const { createTerritories } = require("../src/state/territories");
const { createSocket } = require("./helpers/gameTestFixtures");

test("spectator input is ignored before rate limiting", () => {
    const spectator = createSocket("spectator", {
        roomCode: "ROOM",
        spectatorRoomCode: "ROOM"
    });
    const room = {
        code: "ROOM",
        players: new Map(),
        territories: createTerritories()
    };
    const roomManager = {
        createBackgroundRoom() {
            return { success: false };
        },
        leaveRoom() {
            return null;
        },
        listRooms() {
            return [];
        },
        rooms: new Map([[room.code, room]])
    };
    let connectionHandler = null;
    const io = {
        emit() {
        },
        on(event, handler) {
            if (event === "connection") connectionHandler = handler;
        },
        sockets: {
            sockets: new Map([[spectator.id, spectator]])
        },
        to() {
            return { emit() {} };
        }
    };

    registerSocket(io, roomManager);
    connectionHandler(spectator);

    for (let index = 0; index < 200; index++) {
        spectator.trigger("inputDirection", {
            angle: index / 10,
            source: "pointer"
        });
        spectator.trigger("inputDirectionEnd");
        spectator.trigger("viewport", {
            width: 1280,
            height: 720,
            scale: 1
        });
    }

    assert.equal(spectator.disconnectCalls, 0);
});
