const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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

test("distributed socket handler forwards an ordered batch and confirms it once", () => {
    const forwarded = [];
    const confirmations = [];
    const first = createBatchSocket("first", forwarded);
    const second = createBatchSocket("second", forwarded);
    const coordinator = new EventEmitter();

    coordinator.isDistributedRoomCoordinator = true;
    coordinator.listRooms = () => [];
    coordinator.confirmEventDeliveries = (workerId, deliveryIds) => {
        confirmations.push({ deliveryIds, workerId });
        return true;
    };
    const io = {
        emit(event, payload) {
            forwarded.push({ event, payload, target: "global" });
        },
        on() {
        },
        sockets: {
            sockets: new Map([
                [first.id, first],
                [second.id, second]
            ])
        },
        to(roomCode) {
            return {
                emit(event, payload) {
                    forwarded.push({ event, payload, roomCode, target: "room" });
                }
            };
        }
    };

    registerSocket(io, coordinator);
    coordinator.emit("workerEventBatch", {
        events: [
            {
                args: [{ value: 1 }],
                deliveryId: "delivery-1",
                event: "firstEvent",
                socketId: first.id,
                target: "socket",
                volatile: true
            },
            {
                args: [{ value: 2 }],
                deliveryId: "delivery-2",
                event: "secondEvent",
                socketId: second.id,
                target: "socket",
                volatile: true
            },
            {
                args: [{ value: 3 }],
                event: "roomEvent",
                roomCode: "ROOM",
                target: "room"
            }
        ],
        workerId: 2
    });

    assert.deepEqual(forwarded, [
        {
            event: "firstEvent",
            payload: { value: 1 },
            socketId: first.id,
            volatile: true
        },
        {
            event: "secondEvent",
            payload: { value: 2 },
            socketId: second.id,
            volatile: true
        },
        {
            event: "roomEvent",
            payload: { value: 3 },
            roomCode: "ROOM",
            target: "room"
        }
    ]);
    assert.deepEqual(confirmations, [{
        deliveryIds: ["delivery-1", "delivery-2"],
        workerId: 2
    }]);
});

function createBatchSocket(id, forwarded) {
    const socket = {
        data: {},
        id,
        emit(event, payload) {
            forwarded.push({ event, payload, socketId: id, volatile: false });
        }
    };

    socket.volatile = {
        emit(event, payload) {
            forwarded.push({ event, payload, socketId: id, volatile: true });
        }
    };
    return socket;
}
