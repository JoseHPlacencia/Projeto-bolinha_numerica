const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { startRoomGameLoop } = require("./gameLoop");
const { startRoomSnapshotLoop } = require("./snapshotLoop");

const rooms = new Map();
const socketIdToRoomCode = new Map();

function createRoom(io) {
    if (rooms.size >= config.rooms.maxRooms) {
        return {
            success: false,
            message: "Maximum number of rooms reached."
        };
    }

    const roomCode = generateRoomCode();
    const room = {
        code: roomCode,
        players: new Map(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
        gameLoopInterval: null,
        snapshotLoopInterval: null
    };

    room.gameLoopInterval = startRoomGameLoop(room);
    room.snapshotLoopInterval = startRoomSnapshotLoop(io, room);
    rooms.set(roomCode, room);

    return {
        success: true,
        room
    };
}

function joinRoom(roomCode, socket) {
    const normalizedRoomCode = String(roomCode || "").trim().toUpperCase();

    if (!normalizedRoomCode) {
        return {
            success: false,
            message: "Room code is required."
        };
    }

    const room = rooms.get(normalizedRoomCode);

    if (!room) {
        return {
            success: false,
            message: "Room not found."
        };
    }

    if (room.players.size >= config.rooms.maxPlayersPerRoom) {
        return {
            success: false,
            message: "Room is full."
        };
    }

    if (socket.data.roomCode && socket.data.roomCode !== normalizedRoomCode) {
        leaveRoom(socket);
    }

    socket.join(normalizedRoomCode);
    socket.data.roomCode = normalizedRoomCode;
    socketIdToRoomCode.set(socket.id, normalizedRoomCode);
    createPlayer(room.players, socket.id);
    room.lastActivity = Date.now();

    return {
        success: true,
        room
    };
}

function leaveRoom(socket) {
    const roomCode = socket.data.roomCode;

    if (!roomCode) {
        return null;
    }

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

    return {
        room,
        destroyed
    };
}

function destroyRoom(roomCode) {
    const room = rooms.get(roomCode);

    if (!room) {
        return false;
    }

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

        if (!rooms.has(code)) {
            return code;
        }
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
