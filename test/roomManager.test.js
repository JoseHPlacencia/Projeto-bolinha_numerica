const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const roomManager = require("../src/core/roomManager");
const { getBotPlayerCount } = require("../src/systems/botSystem");
const {
    createSocket,
    createMatchmakingIo
} = require("./helpers/gameTestFixtures");

test("background BOTS room restarts when remaining bots are below half of the target", () => {
    const roomCode = String(config.menuBackground.roomCode || "BOTS").trim().toUpperCase();
    const viewer = createSocket("viewer", { spectatorRoomCode: roomCode });
    const io = createMatchmakingIo(viewer);

    roomManager.destroyRoom(roomCode);

    try {
        const createResult = roomManager.createBackgroundRoom(io);

        assert.equal(createResult.success, true);
        assert.equal(getBotPlayerCount(createResult.room.players), config.menuBackground.botCount);

        const firstRoom = createResult.room;
        const targetBotCount = firstRoom.targetBotCount;
        const remainingBotCount = Math.max(0, Math.ceil(targetBotCount / 2) - 1);
        const botIds = [...firstRoom.players.keys()];

        for (const botId of botIds.slice(remainingBotCount)) {
            firstRoom.players.delete(botId);
            firstRoom.territories.delete(botId);
        }

        assert.ok(getBotPlayerCount(firstRoom.players) * 2 < targetBotCount);

        const restartResult = roomManager.createBackgroundRoom(io);

        assert.equal(restartResult.success, true);
        assert.notEqual(restartResult.room, firstRoom);
        assert.equal(getBotPlayerCount(restartResult.room.players), targetBotCount);
        assert.ok(viewer.emitted.some(event => event.event === "menuBackgroundReady"));
    } finally {
        roomManager.destroyRoom(roomCode);
    }
});

test("room population updates do not replace the public directory with the BOTS directory", () => {
    const backgroundRoomCode = String(config.menuBackground.roomCode || "BOTS").trim().toUpperCase();
    const regularRoomCode = "LIST01";
    const viewer = createSocket("directory-viewer", {
        spectatorRoomCode: backgroundRoomCode
    });
    const io = createMatchmakingIo(viewer);

    roomManager.destroyRoom(backgroundRoomCode);
    roomManager.destroyRoom(regularRoomCode);

    try {
        const backgroundResult = roomManager.createBackgroundRoom(io);
        const regularResult = roomManager.createRoom(io, {
            customOptions: {
                allowBots: false,
                maxPlayers: 2
            },
            roomCode: regularRoomCode
        });

        assert.equal(backgroundResult.success, true);
        assert.equal(regularResult.success, true);

        io.emitted.length = 0;
        roomManager.handleRoomPopulationChanged(io, backgroundRoomCode);
        assert.equal(io.emitted.some(event => event.event === "roomsList"), false);

        roomManager.handleRoomPopulationChanged(io, regularRoomCode);
        const directoryEvent = io.emitted.find(event => event.event === "roomsList");

        assert.deepEqual(
            directoryEvent.payload.map(room => room.code),
            [regularRoomCode]
        );
    } finally {
        roomManager.destroyRoom(backgroundRoomCode);
        roomManager.destroyRoom(regularRoomCode);
    }
});
