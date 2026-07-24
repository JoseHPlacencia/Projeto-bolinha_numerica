const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const roomManager = require("../src/core/roomManager");
const { initializeRoomPlayer } = require("../src/core/roomPlayer");
const {
    getBotPlayerCount,
    getHumanPlayerCount
} = require("../src/systems/botSystem");
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
        assert.equal(createResult.room.snapshotRate, config.menuBackground.snapshotRate);
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
        assert.equal(backgroundResult.room.snapshotRate, config.menuBackground.snapshotRate);
        assert.equal(regularResult.room.snapshotRate, config.loop.snapshotRate);

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

test("custom room bots share total capacity and preserve the final human slots", () => {
    const roomCode = "BOTCAP";
    const io = createMatchmakingIo(createSocket("directory-viewer"));

    roomManager.destroyRoom(roomCode);

    try {
        const createResult = roomManager.createRoom(io, {
            customOptions: {
                botCount: 4,
                maxPlayers: 4
            },
            roomCode
        });

        assert.equal(createResult.success, true);
        assert.equal(createResult.room.targetBotCount, 4);
        assert.equal(getBotPlayerCount(createResult.room.players), 2);
        assert.equal(roomManager.listRooms().find(room => room.code === roomCode).occupiedCount, 2);

        const firstJoin = joinAndInitialize(createResult.room, "human-1");

        assert.ok(firstJoin.player);
        assert.equal(getHumanPlayerCount(createResult.room.players), 1);
        assert.equal(getBotPlayerCount(createResult.room.players), 1);

        const secondJoin = joinAndInitialize(createResult.room, "human-2");
        assert.equal(getHumanPlayerCount(createResult.room.players), 2);
        assert.equal(getBotPlayerCount(createResult.room.players), 0);

        roomManager.leaveRoom(secondJoin.socket);
        assert.equal(getHumanPlayerCount(createResult.room.players), 1);
        assert.equal(getBotPlayerCount(createResult.room.players), 1);

        joinAndInitialize(createResult.room, "human-2b");
        joinAndInitialize(createResult.room, "human-3");
        joinAndInitialize(createResult.room, "human-4");
        assert.equal(createResult.room.players.size, 4);

        const fullResult = roomManager.joinRoom(roomCode, createSocket("human-5"));
        assert.equal(fullResult.success, false);
        assert.match(fullResult.message, /full/i);
    } finally {
        roomManager.destroyRoom(roomCode);
    }

    function joinAndInitialize(room, playerId) {
        const socket = createSocket(playerId);
        const joinResult = roomManager.joinRoom(room.code, socket);

        assert.equal(joinResult.success, true);
        return {
            player: initializeRoomPlayer(
                room,
                socket.id,
                joinResult.alreadyJoined,
                { name: playerId },
                joinResult.spawn
            ),
            socket
        };
    }
});

test("human joins replace bots when a very small room starts full", () => {
    const roomCode = "BOTSM2";
    const io = createMatchmakingIo(createSocket("directory-viewer"));

    roomManager.destroyRoom(roomCode);

    try {
        const createResult = roomManager.createRoom(io, {
            customOptions: {
                botCount: 2,
                maxPlayers: 2
            },
            roomCode
        });

        assert.equal(createResult.success, true);
        assert.equal(getBotPlayerCount(createResult.room.players), 2);

        for (const playerId of ["small-human-1", "small-human-2"]) {
            const socket = createSocket(playerId);
            const joinResult = roomManager.joinRoom(roomCode, socket);

            assert.equal(joinResult.success, true);
            assert.ok(initializeRoomPlayer(
                createResult.room,
                socket.id,
                joinResult.alreadyJoined,
                { name: playerId },
                joinResult.spawn
            ));
        }

        assert.equal(getHumanPlayerCount(createResult.room.players), 2);
        assert.equal(getBotPlayerCount(createResult.room.players), 0);
        assert.equal(createResult.room.players.size, createResult.room.maxPlayers);
    } finally {
        roomManager.destroyRoom(roomCode);
    }
});
