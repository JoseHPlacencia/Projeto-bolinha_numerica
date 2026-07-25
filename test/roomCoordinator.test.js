const assert = require("node:assert/strict");
const test = require("node:test");
const { createRoomCoordinator } = require("../src/core/roomCoordinator");

test("room coordinator runs a normal room in a worker and keeps its directory global", async () => {
    const coordinator = createRoomCoordinator({
        localRoomManager: {
            createBackgroundRoom() {
                throw new Error("BOTS should remain local and was not requested by this test.");
            }
        },
        workerCount: 1
    });
    const socket = {
        data: {},
        id: "coordinator-player"
    };
    let snapshotReceived = false;

    function handleWorkerEvent(event, workerId) {
        if (event.event !== "gameState" || event.socketId !== socket.id) return;
        snapshotReceived = true;
        if (event.acknowledgementId) {
            coordinator.acknowledge(workerId, {
                acknowledgement: { applied: true },
                acknowledgementId: event.acknowledgementId
            });
        }
    }

    coordinator.on("workerEvent", ({ event, workerId }) => {
        handleWorkerEvent(event, workerId);
    });
    coordinator.on("workerEventBatch", ({ events, workerId }) => {
        for (const event of events) {
            handleWorkerEvent(event, workerId);
        }
    });

    try {
        await coordinator.start();
        const joined = await coordinator.createAndJoinRoom(socket, {
            playerOptions: { color: "#00ffff", name: "Coordinator" },
            roomOptions: { difficulty: "medium", isPrivate: false }
        });

        assert.equal(joined.success, true);
        socket.data.playerActive = true;
        socket.data.roomCode = joined.room.code;
        assert.equal(coordinator.listRooms().length, 1);
        assert.equal(coordinator.listRooms()[0].playerCount, 1);
        assert.equal(coordinator.sendInput(socket, "direction", { angle: 0, source: "keyboard" }), true);

        await waitFor(() => snapshotReceived, 1500);
        const leaveResult = await coordinator.leaveRoom(socket);
        assert.equal(leaveResult.destroyed, true);
        await waitFor(() => coordinator.listRooms().length === 0, 500);
    } finally {
        await coordinator.close();
    }
});

test("room coordinator preserves private-room validation across the worker boundary", async () => {
    const coordinator = createRoomCoordinator({
        localRoomManager: { createBackgroundRoom() {} },
        workerCount: 1
    });
    const owner = { data: {}, id: "private-owner" };
    const guest = { data: {}, id: "private-guest" };

    try {
        await coordinator.start();
        const created = await coordinator.createAndJoinRoom(owner, {
            password: "correct-password",
            playerOptions: { name: "Owner" },
            roomOptions: {
                difficulty: "medium",
                isPrivate: true,
                password: "correct-password"
            }
        });

        assert.equal(created.success, true);
        assert.equal(coordinator.listRooms()[0].isPrivate, true);

        const rejected = await coordinator.joinRoom(
            guest,
            created.room.code,
            "wrong-password",
            { name: "Guest" }
        );
        assert.equal(rejected.success, false);
        assert.equal(rejected.message, "Invalid room password.");

        const joined = await coordinator.joinRoom(
            guest,
            created.room.code,
            "correct-password",
            { name: "Guest" }
        );
        assert.equal(joined.success, true);

        await coordinator.leaveRoom(guest);
        const ownerLeave = await coordinator.leaveRoom(owner);
        assert.equal(ownerLeave.destroyed, true);
    } finally {
        await coordinator.close();
    }
});

test("room worker batch preserves shared snapshot frame references across IPC", async () => {
    const coordinator = createRoomCoordinator({
        localRoomManager: { createBackgroundRoom() {} },
        workerCount: 1
    });
    const owner = { data: {}, id: "batch-owner" };
    const guest = { data: {}, id: "batch-guest" };
    let sharedSnapshots = null;

    coordinator.on("workerEventBatch", ({ events, workerId }) => {
        const deliveryIds = [];

        for (const event of events) {
            if (event.deliveryId) {
                deliveryIds.push(event.deliveryId);
            }
            if (event.acknowledgementId) {
                coordinator.acknowledge(workerId, {
                    acknowledgement: { applied: true },
                    acknowledgementId: event.acknowledgementId
                });
            }
        }

        if (deliveryIds.length > 0) {
            coordinator.confirmEventDeliveries(workerId, deliveryIds);
        }

        const snapshots = events
            .filter(event => (
                event.event === "gameState"
                && (event.socketId === owner.id || event.socketId === guest.id)
            ))
            .map(event => event.args[0]);

        if (snapshots.length === 2 && snapshots[0].time === snapshots[1].time) {
            sharedSnapshots = snapshots;
        }
    });

    try {
        await coordinator.start();
        const created = await coordinator.createAndJoinRoom(owner, {
            playerOptions: { name: "Owner" },
            roomOptions: { difficulty: "medium", isPrivate: false }
        });

        assert.equal(created.success, true);
        owner.data.playerActive = true;
        owner.data.roomCode = created.room.code;

        const joined = await coordinator.joinRoom(
            guest,
            created.room.code,
            "",
            { name: "Guest" }
        );

        assert.equal(joined.success, true);
        guest.data.playerActive = true;
        guest.data.roomCode = created.room.code;

        await waitFor(() => sharedSnapshots !== null, 1500);

        const [first, second] = sharedSnapshots;

        assert.strictEqual(first.leaderboard, second.leaderboard);
        assert.strictEqual(first.numbers, second.numbers);
        assert.strictEqual(first.roomConfig, second.roomConfig);
        assert.strictEqual(first.players[owner.id], second.players[owner.id]);

        await coordinator.leaveRoom(guest);
        await coordinator.leaveRoom(owner);
    } finally {
        await coordinator.close();
    }
});

async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("Condition was not reached before timeout.");
}
