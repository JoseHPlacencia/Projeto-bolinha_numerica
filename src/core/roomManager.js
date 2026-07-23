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
    getHumanPlayerCount,
    getTargetBotCount
} = require("../systems/botSystem");
const { createNumberSystem } = require("../systems/numberSystem");
const { createSpawn } = require("../systems/spawnSystem");
const {
    createRoomRuntimeConfig,
    serializeRoomSettings,
    validateRoomCustomOptions
} = require("./roomSettings");
const { getPublicMatchCandidates: selectPublicMatchCandidates } = require("./matchmaking");
const { calculateActiveBotTarget } = require("./roomCapacity");
const { resetSocketSnapshotState } = require("./snapshotState");
const { redirectSpectatorsAfterPlayerExit } = require("../systems/spectatorSystem");

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

    const customOptionsError = validateRoomCustomOptions(options.customOptions);

    if (customOptionsError) {
        return { success: false, message: customOptionsError };
    }

    const isPrivate = Boolean(options.isPrivate);
    const territories = createTerritories();
    const players = new Map();
    const difficultyKey = normalizeRoomDifficulty(options.difficulty);
    const runtimeConfig = createRoomRuntimeConfig(options.customOptions, difficultyKey);
    const requestedBotCount = options.botCount === null || options.botCount === undefined
        ? runtimeConfig.customOptions.botCount
        : options.botCount;
    const targetBotCount = runtimeConfig.customOptions.allowBots || isSystemRoom
        ? getTargetBotCount({ botCount: requestedBotCount })
        : 0;
    const numberSystem = createNumberSystem(
        runtimeConfig.world.mapRadius,
        players,
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
        diagnostics: {
            gameLoop: {}
        },
        gameLoopInterval: null,
        hiddenFromList: Boolean(options.hiddenFromList),
        snapshotLoopInterval: null,
        isPrivate,
        isSystemRoom,
        allowBots: targetBotCount > 0,
        maxPlayers: runtimeConfig.customOptions.maxPlayers,
        targetBotCount,
        runtimeConfig,
        passwordHash: null,
        passwordSalt: null
    };

    if (isPrivate && !isSystemRoom) {
        const password = String(options.password || "").trim();
        if (!password) {
            return { success: false, message: "Password is required for private rooms." };
        }
        if (password.length < config.rooms.privateRoomPasswordMinLength) {
            return {
                success: false,
                message: `Password must be at least ${config.rooms.privateRoomPasswordMinLength} characters long.`
            };
        }
        if (password.length > config.rooms.privateRoomPasswordMaxLength) {
            return {
                success: false,
                message: `Password cannot exceed ${config.rooms.privateRoomPasswordMaxLength} characters.`
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
        botCount: targetBotCount,
        botDifficulty: options.botDifficulty || difficultyKey,
        runtimeConfig,
        resolveBotCount: configuredTarget => (
            isSystemRoom
                ? configuredTarget
                : calculateActiveBotTarget(
                    room.maxPlayers,
                    getHumanPlayerCount(room.players),
                    configuredTarget
                )
        ),
        onBotRemoved: botId => {
            redirectSpectatorsAfterPlayerExit(
                io,
                roomCode,
                players,
                territories,
                botId,
                null,
                runtimeConfig
            );
        },
        onPopulationChanged: () => {
            handleRoomPopulationChanged(io, roomCode);
        }
    });
    room.botManager.ensureBots();
    room.gameLoopInterval = startGameLoop(
        players,
        territories,
        io,
        roomCode,
        numberSystem,
        room.botManager,
        runtimeConfig,
        room.diagnostics.gameLoop,
        {
            onRoomPopulationChanged: () => {
                handleRoomPopulationChanged(io, roomCode);
            }
        }
    );
    room.snapshotLoopInterval = startSnapshotLoop(io, players, territories, roomCode, numberSystem, runtimeConfig, room.diagnostics);

    rooms.set(roomCode, room);
    return { success: true, room };
}

function createBackgroundRoom(io) {
    const backgroundConfig = config.menuBackground || {};

    if (backgroundConfig.enabled === false) {
        return { success: false, message: "Menu background room is disabled." };
    }

    const roomCode = String(backgroundConfig.roomCode || "BOTS").trim().toUpperCase();
    const existingRoom = rooms.get(roomCode);

    if (existingRoom) {
        const restartResult = restartBackgroundRoomIfNeeded(io, existingRoom);

        return restartResult || { success: true, room: existingRoom };
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

function handleRoomPopulationChanged(io, roomCode) {
    const room = rooms.get(roomCode);

    if (!room) {
        return;
    }

    if (restartBackgroundRoomIfNeeded(io, room)) {
        return;
    }

    // System rooms live beside the gateway in distributed mode, but normal
    // rooms live in workers. Publishing this manager's local (empty) public
    // directory from BOTS would overwrite the coordinator's global list.
    if (room.hiddenFromList || room.isSystemRoom) {
        return;
    }

    io?.emit?.("roomsList", listRooms());
}

function restartBackgroundRoomIfNeeded(io, room) {
    if (!shouldRestartBackgroundRoom(room)) {
        return null;
    }

    return restartBackgroundRoom(io, room.code);
}

function shouldRestartBackgroundRoom(room) {
    if (!room || !room.isSystemRoom || room.code !== getBackgroundRoomCode()) {
        return false;
    }

    const targetBotCount = getRoomTargetBotCount(room);

    if (targetBotCount <= 0) {
        return false;
    }

    return getBotPlayerCount(room.players) * 2 < targetBotCount;
}

function restartBackgroundRoom(io, roomCode) {
    const normalizedRoomCode = String(roomCode || "").trim().toUpperCase();

    if (!normalizedRoomCode || !rooms.has(normalizedRoomCode)) {
        return null;
    }

    const viewerSockets = getRoomViewerSockets(io, normalizedRoomCode);

    destroyRoom(normalizedRoomCode);

    const backgroundConfig = config.menuBackground || {};
    const result = createRoom(io, {
        botCount: backgroundConfig.botCount,
        botDifficulty: backgroundConfig.difficulty,
        difficulty: backgroundConfig.difficulty,
        hiddenFromList: true,
        isPrivate: true,
        isSystemRoom: true,
        roomCode: normalizedRoomCode
    });

    if (!result.success || !result.room) {
        return result;
    }

    for (const socket of viewerSockets) {
        if (socket.data && socket.data.spectatorRoomCode === normalizedRoomCode) {
            socket.data.spectatorFollowId = null;
        }

        resetSocketSnapshotState(socket);
        socket.emit?.("menuBackgroundReady", {
            success: true,
            roomCode: normalizedRoomCode
        });
    }

    return result;
}

function getRoomTargetBotCount(room) {
    const backgroundConfig = config.menuBackground || {};

    return getTargetBotCount({
        botCount: room && Number.isInteger(room.targetBotCount)
            ? room.targetBotCount
            : backgroundConfig.botCount
    });
}

function getBackgroundRoomCode() {
    const backgroundConfig = config.menuBackground || {};

    return String(backgroundConfig.roomCode || "BOTS").trim().toUpperCase();
}

function getRoomViewerSockets(io, roomCode) {
    if (!io || !io.sockets || !io.sockets.sockets || typeof io.sockets.sockets.values !== "function") {
        return [];
    }

    return Array.from(io.sockets.sockets.values()).filter(socket => (
        socket
        && socket.data
        && (socket.data.roomCode === roomCode || socket.data.spectatorRoomCode === roomCode)
    ));
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

    if (!alreadyJoined) {
        while (room.players.size >= room.maxPlayers) {
            if (!room.botManager?.releaseSlotForHuman()) {
                return { success: false, message: "Room is full." };
            }
        }
    }

    const spawn = alreadyJoined ? null : createSpawn(room.players, room.territories, room.runtimeConfig);

    if (!alreadyJoined && !spawn) {
        return { success: false, message: "Don't have enough space to spawn in this room." };
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
    if (!password
        || password.length > config.rooms.privateRoomPasswordMaxLength
        || !hash
        || !salt) {
        return false;
    }

    const computedHash = crypto.createHash("sha256").update(salt + password).digest("hex");
    const computedBuffer = Buffer.from(computedHash, "hex");
    const storedBuffer = Buffer.from(hash, "hex");

    return computedBuffer.length === storedBuffer.length
        && crypto.timingSafeEqual(computedBuffer, storedBuffer);
}

function leaveRoom(socket, options = {}) {
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

    const destroyed = !options.preserveRoom
        && getHumanPlayerCount(room.players) === 0;
    if (destroyed) {
        destroyRoom(roomCode);
    } else {
        room.botManager?.ensureBots();
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

function listRooms() {
    return Array.from(rooms.values())
        .filter(room => !room.hiddenFromList && !room.isSystemRoom)
        .map(room => ({
            code: room.code,
            botCount: getBotPlayerCount(room.players),
            playerCount: getHumanPlayerCount(room.players),
            occupiedCount: room.players.size,
            difficulty: room.difficulty || "medium",
            isPrivate: Boolean(room.isPrivate),
            allowBots: room.allowBots,
            maxPlayers: room.maxPlayers,
            settings: serializeRoomSettings(room.runtimeConfig),
            createdAt: room.createdAt
        }));
}

function getPublicMatchCandidates(difficulty) {
    return selectPublicMatchCandidates(rooms, difficulty);
}

function generateRoomCode() {
    const availableChars = config.rooms.roomCodeCharset;
    const length = config.rooms.roomCodeLength;

    for (let attempt = 0; attempt < config.rooms.roomCodeMaxGenerationAttempts; attempt++) {
        let code = "";
        for (let characterIndex = 0; characterIndex < length; characterIndex++) {
            const index = crypto.randomInt(availableChars.length);
            code += availableChars[index];
        }

        if (!rooms.has(code)) {
            return code;
        }
    }

    throw new Error("Unable to generate unique room code.");
}

function normalizeRoomDifficulty(rawDifficulty) {
    const difficulty = String(rawDifficulty || "").trim().toLowerCase();

    return difficulty === "easy" || difficulty === "hard" ? difficulty : "medium";
}

module.exports = {
    createBackgroundRoom,
    createRoom,
    getPublicMatchCandidates,
    handleRoomPopulationChanged,
    joinRoom,
    leaveRoom,
    listRooms,
    destroyRoom,
    rooms
};
