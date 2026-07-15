const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const roomManager = require("../src/core/roomManager");
const registerSocket = require("../src/core/socketHandler");
const { getPublicMatchCandidates } = require("../src/core/matchmaking");
const {
    createSocket,
    createMatchmakingRoom,
    createMatchmakingIo
} = require("./helpers/gameTestFixtures");

test("quick match candidates prioritize populated compatible public rooms", () => {
    const rooms = new Map([
        ["EMPTY", createMatchmakingRoom("EMPTY", { createdAt: 1 })],
        ["BUSY", createMatchmakingRoom("BUSY", { createdAt: 3, humanPlayers: 3 })],
        ["OLDER", createMatchmakingRoom("OLDER", { createdAt: 2, humanPlayers: 3 })],
        ["EASY", createMatchmakingRoom("EASY", { difficulty: "easy", humanPlayers: 8 })],
        ["PRIVATE", createMatchmakingRoom("PRIVATE", { humanPlayers: 8, isPrivate: true })],
        ["HIDDEN", createMatchmakingRoom("HIDDEN", { hiddenFromList: true, humanPlayers: 8 })],
        ["SYSTEM", createMatchmakingRoom("SYSTEM", { humanPlayers: 8, isSystemRoom: true })],
        ["FULL", createMatchmakingRoom("FULL", {
            humanPlayers: config.rooms.maxPlayersPerRoom
        })],
        ["CUSTOM_FULL", createMatchmakingRoom("CUSTOM_FULL", {
            humanPlayers: 3,
            maxPlayers: 3
        })]
    ]);

    assert.deepEqual(
        getPublicMatchCandidates(rooms, "medium").map(room => room.code),
        ["OLDER", "BUSY", "EMPTY"]
    );
});

test("quick match joins an existing compatible room without creating another", () => {
    const socket = createSocket("quick-player");
    const io = createMatchmakingIo(socket);
    const existingRoom = createMatchmakingRoom("EXISTING", { humanPlayers: 1 });
    let createRoomCalls = 0;
    const roomManager = {
        createBackgroundRoom() {
            return { success: false };
        },
        createRoom() {
            createRoomCalls++;
            return { success: false, message: "should not create" };
        },
        getPublicMatchCandidates(difficulty) {
            assert.equal(difficulty, "medium");
            return [existingRoom];
        },
        joinRoom(roomCode, joiningSocket) {
            assert.equal(roomCode, existingRoom.code);
            joiningSocket.data.roomCode = roomCode;
            return {
                room: existingRoom,
                spawn: { x: 0, y: 0 },
                success: true
            };
        },
        leaveRoom() {
            return null;
        },
        listRooms() {
            return [];
        },
        rooms: new Map([[existingRoom.code, existingRoom]])
    };

    registerSocket(io, roomManager);
    io.connect();
    socket.trigger("joinRoom", {
        difficulty: "medium",
        player: {
            color: "#ff2626",
            difficulty: "medium",
            name: "Jogador"
        },
        quickMatch: true
    });

    const result = socket.emitted.find(event => event.event === "joinRoomResult");

    assert.equal(createRoomCalls, 0);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.roomCode, existingRoom.code);
    assert.equal(result.payload.reusedRoom, true);
    assert.equal(existingRoom.players.has(socket.id), true);
});

test("quick match creates a public room when no compatible room is available", () => {
    const socket = createSocket("quick-player");
    const io = createMatchmakingIo(socket);
    const createdRoom = createMatchmakingRoom("CREATED");
    let createRoomCalls = 0;
    const roomManager = {
        createBackgroundRoom() {
            return { success: false };
        },
        createRoom(_io, options) {
            createRoomCalls++;
            assert.equal(options.difficulty, "hard");
            assert.equal(options.isPrivate, false);
            assert.equal(options.password, "");
            assert.deepEqual(options.customOptions, {});
            return {
                room: createdRoom,
                success: true
            };
        },
        destroyRoom() {
            throw new Error("new room should not be destroyed");
        },
        getPublicMatchCandidates() {
            return [];
        },
        joinRoom(roomCode, joiningSocket) {
            assert.equal(roomCode, createdRoom.code);
            joiningSocket.data.roomCode = roomCode;
            return {
                room: createdRoom,
                spawn: { x: 0, y: 0 },
                success: true
            };
        },
        leaveRoom() {
            return null;
        },
        listRooms() {
            return [];
        },
        rooms: new Map([[createdRoom.code, createdRoom]])
    };

    registerSocket(io, roomManager);
    io.connect();
    socket.trigger("joinRoom", {
        customOptions: {
            mapSize: 2
        },
        difficulty: "hard",
        isPrivate: true,
        password: "ignored",
        player: {
            difficulty: "hard",
            name: "Jogador"
        },
        quickMatch: true
    });

    const result = socket.emitted.find(event => event.event === "joinRoomResult");

    assert.equal(createRoomCalls, 1);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.roomCode, createdRoom.code);
    assert.equal(result.payload.reusedRoom, undefined);
    assert.equal(createdRoom.players.has(socket.id), true);
});
