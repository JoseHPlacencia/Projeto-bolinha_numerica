const crypto = require("crypto");
const config = require("../config/gameConfig");
const { startGameLoop } = require("./gameLoop");
const { startSnapshotLoop } = require("./snapshotLoop");
const {
    createTerritories,
    deletePlayerTerritory
} = require("../state/territories");
const {
    createBotManager,
    getBotPlayerCount,
    getHumanPlayerCount
} = require("../systems/botSystem");
const { createNumberSystem } = require("../systems/numberSystem");
const { createSpawn } = require("../systems/spawnSystem");
const {
    createRoomRuntimeConfig,
    serializeRoomSettings
} = require("./roomSettings");

const rooms = new Map();
const socketIdToRoomCode = new Map();

function createRoom(io, options = {}) {
    if (rooms.size >= config.rooms.maxRooms) {
        return { success: false, message: "Maximum number of rooms reached." };
    }

    const roomCode = String(options.roomCode || "").trim().toUpperCase() || generateRoomCode();
    const isSystemRoom = Boolean(options.isSystemRoom);

    if (rooms.has(roomCode)) {
        return { success: false, message: "Room code already exists." };
    }

    const isPrivate = Boolean(options.isPrivate);
    const territories = createTerritories();
    const players = new Map();
    const difficultyKey = normalizeRoomDifficulty(options.difficulty);
    const runtimeConfig = createRoomRuntimeConfig(options.customOptions, difficultyKey);
    const numberSystem = createNumberSystem(
        runtimeConfig.world.mapRadius,
        players,
        territories,
        difficultyKey,
        runtimeConfig.numbers
    );

    const room = {
        code: roomCode,
        players,
        territories,
        numberSystem,
        botManager: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        difficulty: difficultyKey,
        gameLoopInterval: null,
        hiddenFromList: Boolean(options.hiddenFromList),
        snapshotLoopInterval: null,
        isPrivate,
        isSystemRoom,
        runtimeConfig,
        passwordHash: null,
        passwordSalt: null
    };

    if (isPrivate && !isSystemRoom) {
        const password = String(options.password || "").trim();
        if (!password) {
            return { success: false, message: "A senha é obrigatória para salas privadas." };
        }
        if (password.length < config.rooms.privateRoomPasswordMinLength) {
            return {
                success: false,
                message: `A senha deve ter pelo menos ${config.rooms.privateRoomPasswordMinLength} caracteres.`
            };
        }
        const { hash, salt } = createPasswordHash(password);
        room.passwordHash = hash;
        room.passwordSalt = salt;
    }

    room.botManager = createBotManager({
        roomCode,
        players,
        territories,
        numberSystem,
        botCount: options.botCount,
        botDifficulty: options.botDifficulty || difficultyKey,
        runtimeConfig
    });
    room.botManager.ensureBots();
    room.gameLoopInterval = startGameLoop(players, territories, io, roomCode, numberSystem, room.botManager, runtimeConfig);
    room.snapshotLoopInterval = startSnapshotLoop(io, players, territories, roomCode, numberSystem, runtimeConfig);

    rooms.set(roomCode, room);
    return { success: true, room };
}

function createBackgroundRoom(io) {
    const backgroundConfig = config.menuBackground || {};

    if (backgroundConfig.enabled === false) {
        return { success: false, message: "Menu background room is disabled." };
    }

    const roomCode = String(backgroundConfig.roomCode || "BOTS").trim().toUpperCase();

    if (rooms.has(roomCode)) {
        return { success: true, room: rooms.get(roomCode) };
    }

    return createRoom(io, {
        botCount: backgroundConfig.botCount,
        botDifficulty: backgroundConfig.difficulty,
        difficulty: backgroundConfig.difficulty,
        hiddenFromList: true,
        isPrivate: true,
        isSystemRoom: true,
        roomCode
    });
}

function joinRoom(roomCode, socket, password = "") {
    const normalizedRoomCode = String(roomCode || "").trim().toUpperCase();

    if (!normalizedRoomCode) {
        return { success: false, message: "Room code is required." };
    }

    const room = rooms.get(normalizedRoomCode);
    if (!room) {
        return { success: false, message: "Room not found." };
    }

    if (room.isSystemRoom) {
        return { success: false, message: "Room not available." };
    }

    if (room.isPrivate) {
        if (!password) {
            return { success: false, message: "Password is required for private rooms." };
        }
        if (!verifyPassword(password, room.passwordHash, room.passwordSalt)) {
            return { success: false, message: "Invalid room password." };
        }
    }

    const alreadyJoined = socket.data.roomCode === normalizedRoomCode && room.players.has(socket.id);

    if (!alreadyJoined && getHumanPlayerCount(room.players) >= config.rooms.maxPlayersPerRoom) {
        return { success: false, message: "Room is full." };
    }

    const spawn = alreadyJoined ? null : createSpawn(room.players, room.territories, room.runtimeConfig);

    if (!alreadyJoined && !spawn) {
        return { success: false, message: "NÃ£o hÃ¡ espaÃ§o suficiente para nascer nesta sala." };
    }

    if (socket.data.roomCode === normalizedRoomCode) {
        if (!alreadyJoined) {
            resetSocketSnapshotState(socket);
        }

        socketIdToRoomCode.set(socket.id, normalizedRoomCode);
        room.lastActivity = Date.now();
        return {
            success: true,
            room,
            alreadyJoined,
            spawn
        };
    }

    if (socket.data.roomCode && socket.data.roomCode !== normalizedRoomCode) {
        leaveRoom(socket);
    }

    socket.join(normalizedRoomCode);
    socket.data.roomCode = normalizedRoomCode;
    resetSocketSnapshotState(socket);
    socketIdToRoomCode.set(socket.id, normalizedRoomCode);
    room.lastActivity = Date.now();

    return { success: true, room, spawn };
}

function createPasswordHash(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.createHash("sha256").update(salt + password).digest("hex");
    return { salt, hash };
}

function verifyPassword(password, hash, salt) {
    if (!password || !hash || !salt) return false;
    const computedHash = crypto.createHash("sha256").update(salt + password).digest("hex");
    return computedHash === hash;
}

function leaveRoom(socket) {
    const roomCode = socket.data.roomCode || socketIdToRoomCode.get(socket.id);
    if (!roomCode) return null;

    const room = rooms.get(roomCode);
    if (!room) {
        socketIdToRoomCode.delete(socket.id);
        delete socket.data.roomCode;
        return null;
    }

    room.players.delete(socket.id);
    deletePlayerTerritory(room.territories, socket.id);
    socket.leave(roomCode);
    socketIdToRoomCode.delete(socket.id);
    resetSocketSnapshotState(socket);
    delete socket.data.roomCode;
    room.lastActivity = Date.now();

    const destroyed = getHumanPlayerCount(room.players) === 0;
    if (destroyed) {
        destroyRoom(roomCode);
    }

    return { room, destroyed };
}

function destroyRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return false;
    clearInterval(room.gameLoopInterval);
    clearInterval(room.snapshotLoopInterval);
    rooms.delete(roomCode);
    return true;
}

function getRoomBySocketId(socketId) {
    const roomCode = socketIdToRoomCode.get(socketId);
    return roomCode ? rooms.get(roomCode) || null : null;
}

function listRooms() {
    return Array.from(rooms.values())
        .filter(room => !room.hiddenFromList && !room.isSystemRoom)
        .map(room => ({
            code: room.code,
            botCount: getBotPlayerCount(room.players),
            playerCount: getHumanPlayerCount(room.players),
            difficulty: room.difficulty || "medium",
            isPrivate: Boolean(room.isPrivate),
            settings: serializeRoomSettings(room.runtimeConfig),
            createdAt: room.createdAt
        }));
}

function resetSocketSnapshotState(socket) {
    socket.data.snapshotState = null;
    socket.data.pendingReliableSnapshot = null;
    socket.data.nextReliableSnapshotId = 0;
}

function generateRoomCode() {
    const availableChars = config.rooms.roomCodeCharset;
    const length = config.rooms.roomCodeLength;

    for (let attempt = 0; attempt < config.rooms.roomCodeMaxGenerationAttempts; attempt++) {
        let code = "";
        for (let i = 0; i < length; i++) {
            const index = Math.floor(Math.random() * availableChars.length);
            code += availableChars[index];
        }
        if (!rooms.has(code)) return code;
    }

    throw new Error("Unable to generate unique room code.");
}

function normalizeRoomDifficulty(raw) {
    const d = String(raw || "").trim().toLowerCase();
    return d === "easy" || d === "hard" ? d : "medium";
}


module.exports = {
    createBackgroundRoom,
    createRoom,
    joinRoom,
    leaveRoom,
    listRooms,
    getRoomBySocketId,
    destroyRoom,
    rooms
};
