const crypto = require("crypto");
const config = require("../config/gameConfig");
const { startGameLoop } = require("./gameLoop");
const { startSnapshotLoop } = require("./snapshotLoop");
const { createTerritories } = require("../state/territories");
const { initNumbers } = require("../systems/numberSystem");

const rooms = new Map();
const socketIdToRoomCode = new Map();

function createRoom(io, options = {}) {
    if (rooms.size >= config.rooms.maxRooms) {
        return { success: false, message: "Maximum number of rooms reached." };
    }

    const roomCode = generateRoomCode();
    const isPrivate = Boolean(options.isPrivate);
    const territories = createTerritories();
    const players = new Map();

    const room = {
        code: roomCode,
        players,
        territories,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        gameLoopInterval: null,
        snapshotLoopInterval: null,
        isPrivate,
        passwordHash: null,
        passwordSalt: null
    };

    if (isPrivate) {
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

    // Initialize number system for this room
    initNumbers(config.world.mapRadius, players);

    // Start game loop and snapshot loop for this room
    room.gameLoopInterval = startGameLoop(players, territories, io, roomCode);
    room.snapshotLoopInterval = startSnapshotLoop(io, players, territories, roomCode);

    rooms.set(roomCode, room);
    return { success: true, room };
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

    if (room.isPrivate) {
        if (!password) {
            return { success: false, message: "Password is required for private rooms." };
        }
        if (!verifyPassword(password, room.passwordHash, room.passwordSalt)) {
            return { success: false, message: "Invalid room password." };
        }
    }

    if (room.players.size >= config.rooms.maxPlayersPerRoom) {
        return { success: false, message: "Room is full." };
    }

    if (socket.data.roomCode && socket.data.roomCode !== normalizedRoomCode) {
        leaveRoom(socket);
    }

    socket.join(normalizedRoomCode);
    socket.data.roomCode = normalizedRoomCode;
    socketIdToRoomCode.set(socket.id, normalizedRoomCode);
    room.lastActivity = Date.now();

    return { success: true, room };
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
    const roomCode = socket.data.roomCode;
    if (!roomCode) return null;

    const room = rooms.get(roomCode);
    if (!room) {
        socketIdToRoomCode.delete(socket.id);
        delete socket.data.roomCode;
        return null;
    }

    room.players.delete(socket.id);
    socket.leave(roomCode);
    socketIdToRoomCode.delete(socket.id);
    delete socket.data.roomCode;
    room.lastActivity = Date.now();

    const destroyed = room.players.size === 0;
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

module.exports = {
    createRoom,
    joinRoom,
    leaveRoom,
    getRoomBySocketId,
    destroyRoom,
    rooms
};
