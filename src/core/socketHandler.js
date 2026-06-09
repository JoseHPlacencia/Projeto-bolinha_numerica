const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const {
    deletePlayerTerritory,
    initializePlayerTerritory
} = require("../state/territories");
const { invalidateSnapshotCache } = require("./snapshotLoop");
const { createRateLimiter } = require("../utils/rateLimiter");

function registerSocket(io, roomManager) {
    io.on("connection", socket => {
        // Send current rooms list to newly connected client
        socket.emit("roomsList", buildRoomsList(roomManager));

        registerRoomEvents(socket, io, roomManager);
        registerInputEvents(socket, roomManager);

        socket.on("disconnect", () => {
            const leaveResult = roomManager.leaveRoom(socket);

            if (leaveResult && leaveResult.room && !leaveResult.destroyed) {
                io.to(leaveResult.room.code).emit("playerLeft", {
                    playerId: socket.id
                });
            }

            io.emit("roomsList", buildRoomsList(roomManager));
        });
    });
}

function buildRoomsList(roomManager) {
    const list = [];
    for (const [code, room] of roomManager.rooms) {
        list.push({
            code,
            playerCount: room.players.size,
            isPrivate: Boolean(room.isPrivate),
            createdAt: room.createdAt
        });
    }
    return list;
}

function registerRoomEvents(socket, io, roomManager) {
    socket.on("joinRoom", payload => {
        const createNewRoom = Boolean(payload && payload.createNewRoom);
        const requestedCode = String(payload && payload.roomCode || "").trim().toUpperCase();
        const password = String(payload && payload.password || "");
        const isPrivate = Boolean(payload && payload.isPrivate);

        if (createNewRoom) {
            const createResult = roomManager.createRoom(io, { isPrivate, password });

            if (!createResult.success) {
                socket.emit("joinRoomResult", { success: false, message: createResult.message });
                return;
            }

            // Join the new room
            const room = createResult.room;
            const territories = room.territories;
            socket.join(room.code);
            socket.data.roomCode = room.code;
            const player = createPlayer(room.players, socket.id, territories);
            initializePlayerTerritory(territories, player);
            room.lastActivity = Date.now();

            socket.emit("joinRoomResult", { success: true, roomCode: room.code });
            io.emit("roomsList", buildRoomsList(roomManager));
            return;
        }

        if (!requestedCode) {
            socket.emit("joinRoomResult", { success: false, message: "Room code is required." });
            return;
        }

        const joinResult = roomManager.joinRoom(requestedCode, socket, password);

        if (!joinResult.success) {
            socket.emit("joinRoomResult", { success: false, message: joinResult.message });
            return;
        }

        // Initialize player in the joined room
        const room = joinResult.room;
        const territories = room.territories;
        const player = createPlayer(room.players, socket.id, territories);
        initializePlayerTerritory(territories, player);

        socket.emit("joinRoomResult", { success: true, roomCode: requestedCode });
        io.emit("roomsList", buildRoomsList(roomManager));
    });

    socket.on("leaveRoom", () => {
        // Clean up player state before leaving
        const roomCode = socket.data && socket.data.roomCode;
        if (roomCode) {
            const room = roomManager.rooms.get(roomCode);
            if (room) {
                room.players.delete(socket.id);
                if (room.territories) {
                    deletePlayerTerritory(room.territories, socket.id);
                }
            }
        }

        const leaveResult = roomManager.leaveRoom(socket);

        if (leaveResult && leaveResult.room && !leaveResult.destroyed) {
            io.to(leaveResult.room.code).emit("playerLeft", { playerId: socket.id });
        }

        io.emit("roomsList", buildRoomsList(roomManager));
    });
}

function registerInputEvents(socket, roomManager) {
    const inputGuard = createInputGuard(socket);
    const viewportGuard = createViewportGuard(socket);

    socket.on("inputDown", rawAction => {
        if (!inputGuard.canHandleInput()) return;
        handleInputEvent(socket, roomManager, players => {
            handleInputDown(players, socket.id, rawAction);
        });
    });

    socket.on("inputUp", rawAction => {
        if (!inputGuard.canHandleInput()) return;
        handleInputEvent(socket, roomManager, players => {
            handleInputUp(players, socket.id, rawAction);
        });
    });

    socket.on("inputDirection", rawInput => {
        if (!inputGuard.canHandleInput()) return;
        handleInputEvent(socket, roomManager, players => {
            handleInputDirection(players, socket.id, rawInput);
        });
    });

    socket.on("inputDirectionEnd", () => {
        if (!inputGuard.canHandleInput()) return;
        handleInputEvent(socket, roomManager, players => {
            handleInputDirectionEnd(players, socket.id);
        });
    });

    socket.on("viewport", rawViewport => {
        if (!viewportGuard.canHandleInput()) return;
        handleInputEvent(socket, roomManager, players => {
            handleViewport(players, socket.id, rawViewport);
        });
    });

    socket.on("snapshotResync", () => {
        if (!viewportGuard.canHandleInput()) return;
        socket.data.snapshotState = null;
    });

    socket.on("snapshotCacheInvalid", rawInvalidations => {
        if (!viewportGuard.canHandleInput()) return;
        invalidateSnapshotCache(socket, rawInvalidations);
    });
}

function handleInputEvent(socket, roomManager, callback) {
    const roomCode = socket.data && socket.data.roomCode;
    if (!roomCode) return;
    const room = roomManager.rooms.get(roomCode);
    if (!room) return;
    callback(room.players);
}

function createInputGuard(socket) {
    return createSocketRateGuard(socket, config.security.inputRateLimit);
}

function createViewportGuard(socket) {
    return createSocketRateGuard(socket, config.security.viewportRateLimit);
}

function createSocketRateGuard(socket, rateLimitConfig) {
    const rateLimiter = createRateLimiter(rateLimitConfig);
    let violations = 0;

    return { canHandleInput };

    function canHandleInput() {
        if (rateLimiter.consume()) return true;
        violations++;
        if (violations >= rateLimitConfig.maxViolations) {
            socket.disconnect(true);
        }
        return false;
    }
}

function handleInputDown(players, playerId, rawAction) {
    const action = normalizeInputAction(rawAction);
    if (!isInputActionValid(action)) return;
    const player = players.get(playerId);
    if (player) player.pressAction(action);
}

function handleInputUp(players, playerId, rawAction) {
    const action = normalizeInputAction(rawAction);
    if (!isInputActionValid(action)) return;
    const player = players.get(playerId);
    if (player) player.releaseAction(action);
}

function handleInputDirection(players, playerId, rawInput) {
    const input = normalizeInputDirection(rawInput);
    if (!input) return;
    const player = players.get(playerId);
    if (player) player.setDirectionAngle(input.angle, input.source);
}

function handleInputDirectionEnd(players, playerId) {
    const player = players.get(playerId);
    if (player) player.clearDirectionAngle();
}

function handleViewport(players, playerId, rawViewport) {
    const viewport = normalizeViewport(rawViewport);
    const player = players.get(playerId);
    if (player && viewport) player.setViewport(viewport);
}

function normalizeInputAction(action) {
    return String(action || "").toLowerCase();
}

function isInputActionValid(action) {
    return Object.prototype.hasOwnProperty.call(config.inputActionAngles, action);
}

function normalizeInputDirection(rawInput) {
    const rawAngle = isInputDirectionPayload(rawInput) ? rawInput.angle : rawInput;
    const angle = normalizeInputAngle(rawAngle);
    if (angle === null) return null;
    return {
        angle,
        source: isInputDirectionPayload(rawInput)
            ? normalizeInputSource(rawInput.source)
            : null
    };
}

function isInputDirectionPayload(rawInput) {
    return rawInput !== null && typeof rawInput === "object";
}

function normalizeInputAngle(rawAngle) {
    const angle = Number(rawAngle);
    if (!Number.isFinite(angle)) return null;
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function normalizeInputSource(rawSource) {
    const source = String(rawSource || "").toLowerCase();
    return isInputSourceValid(source) ? source : null;
}

function isInputSourceValid(source) {
    return source === "mouse"
        || source === "pointer"
        || source === "keyboard"
        || source === "gamepad-left"
        || source === "gamepad-right"
        || source === "gamepad-dpad";
}

function normalizeViewport(rawViewport) {
    if (!rawViewport || typeof rawViewport !== "object") return null;
    const width = clampNumber(Number(rawViewport.width), 1, config.screen.virtualWidth * 2);
    const height = clampNumber(Number(rawViewport.height), 1, config.screen.virtualHeight * 2);
    const scale = clampNumber(Number(rawViewport.scale), 0.05, 4);
    if (width === null || height === null || scale === null) return null;
    return { width, height, scale };
}

function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) return null;
    return Math.min(Math.max(value, min), max);
}

module.exports = registerSocket;
