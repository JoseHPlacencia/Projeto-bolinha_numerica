const config = require("../config/gameConfig");
const { invalidateSnapshotCache } = require("./snapshotLoop");
const { resetSocketSnapshotState } = require("./snapshotState");
const { initializeRoomPlayer } = require("./roomPlayer");
const { applyPlayerInput } = require("./playerInput");
const { createRateLimiter } = require("../utils/rateLimiter");
const { redirectSpectatorsAfterPlayerExit } = require("../systems/spectatorSystem");
const { applySocketSnapshotProtocol } = require("./snapshotProtocol");
const {
    disableGatewayTransportDiagnostics,
    setGatewayTransportDiagnosticsEnabled,
    takeGatewayTransportDiagnostics
} = require("./gatewayTransportDiagnostics");

function registerSocket(io, roomManager) {
    if (roomManager && roomManager.isDistributedRoomCoordinator === true) {
        const registerDistributedSocket = require("./distributedSocketHandler");
        return registerDistributedSocket(io, roomManager);
    }

    io.on("connection", socket => {
        applySocketSnapshotProtocol(socket);
        socket.emit("roomsList", buildRoomsList(roomManager));

        registerRoomEvents(socket, io, roomManager);
        registerInputEvents(socket, roomManager);
        registerNetworkDiagnosticsEvents(socket);
        registerMenuBackgroundEvents(socket, io, roomManager);

        socket.on("disconnect", () => {
            disableGatewayTransportDiagnostics(socket);
            const roomCode = socket.data && socket.data.roomCode;
            leaveMenuBackground(socket);

            const leaveResult = roomManager.leaveRoom(socket, {
                preserveRoom: hasRoomSpectators(io, roomCode)
            });

            if (leaveResult && leaveResult.room && !leaveResult.destroyed) {
                redirectSpectatorsAfterPlayerExit(
                    io,
                    leaveResult.room.code,
                    leaveResult.room.players,
                    leaveResult.room.territories,
                    socket.id,
                    null,
                    leaveResult.room.runtimeConfig
                );
                io.to(leaveResult.room.code).emit("playerLeft", {
                    playerId: socket.id
                });
            }

            io.emit("roomsList", buildRoomsList(roomManager));
        });
    });
}

function registerNetworkDiagnosticsEvents(socket) {
    const diagnosticsGuard = createSocketRateGuard(socket, config.security.viewportRateLimit, () => true);

    socket.on("networkDiagnostics", (rawOptions, acknowledge) => {
        if (!diagnosticsGuard.canHandleInput()) return;

        const enabled = !(rawOptions && rawOptions.enabled === false);
        const captureOverlapAudit = enabled
            && rawOptions
            && rawOptions.captureOverlapAudit === true;
        socket.data.networkDiagnosticsEnabled = enabled;
        socket.data.captureOverlapAuditEnabled = captureOverlapAudit;
        setGatewayTransportDiagnosticsEnabled(socket, enabled);

        if (typeof acknowledge === "function") {
            acknowledge({
                captureOverlapAudit,
                enabled,
                gatewayDiagnostics: takeGatewayTransportDiagnostics(socket),
                serverTime: Date.now(),
                transport: getSocketTransportName(socket)
            });
        }
    });

    socket.on("networkDiagnosticsPing", (rawPayload, acknowledge) => {
        if (!diagnosticsGuard.canHandleInput() || typeof acknowledge !== "function") return;

        acknowledge({
            clientSentAt: rawPayload && rawPayload.clientSentAt,
            captureOverlapAudit: Boolean(socket.data.captureOverlapAuditEnabled),
            diagnosticsEnabled: Boolean(socket.data.networkDiagnosticsEnabled),
            gatewayDiagnostics: takeGatewayTransportDiagnostics(socket),
            serverTime: Date.now(),
            transport: getSocketTransportName(socket)
        });
    });
}

function getSocketTransportName(socket) {
    return socket
        && socket.conn
        && socket.conn.transport
        && socket.conn.transport.name
        ? socket.conn.transport.name
        : null;
}

function buildRoomsList(roomManager) {
    return roomManager.listRooms();
}

function registerRoomEvents(socket, io, roomManager) {
    socket.on("requestRoomsList", () => {
        socket.emit("roomsList", buildRoomsList(roomManager));
    });

    socket.on("joinRoom", payload => {
        leaveMenuBackground(socket);

        const createNewRoom = Boolean(payload && payload.createNewRoom);
        const quickMatch = Boolean(payload && payload.quickMatch);
        const requestedCode = String(payload && payload.roomCode || "").trim().toUpperCase();
        const password = String(payload && payload.password || "");
        const isPrivate = Boolean(payload && payload.isPrivate);
        const roomDifficulty = String(payload && payload.difficulty || "").trim().toLowerCase() || "medium";
        const customOptions = payload && typeof payload.customOptions === "object"
            ? payload.customOptions
            : {};
        const playerOptions = normalizePlayerOptions(payload && payload.player);

        if (quickMatch) {
            const matchedRoom = joinExistingPublicRoom(
                roomManager,
                socket,
                roomDifficulty,
                playerOptions
            );

            if (matchedRoom) {
                socket.emit("joinRoomResult", {
                    success: true,
                    roomCode: matchedRoom.code,
                    reusedRoom: true
                });
                io.emit("roomsList", buildRoomsList(roomManager));
                return;
            }
        }

        if (createNewRoom || quickMatch) {
            const createResult = roomManager.createRoom(io, {
                customOptions: quickMatch ? {} : customOptions,
                difficulty: roomDifficulty,
                isPrivate: quickMatch ? false : isPrivate,
                password: quickMatch ? "" : password
            });

            if (!createResult.success) {
                socket.emit("joinRoomResult", { success: false, message: createResult.message });
                return;
            }

            const joinResult = roomManager.joinRoom(createResult.room.code, socket, password);

            if (!joinResult.success) {
                roomManager.destroyRoom(createResult.room.code);
                socket.emit("joinRoomResult", { success: false, message: joinResult.message });
                return;
            }

            const player = initializeSocketPlayer(joinResult.room, socket, joinResult.alreadyJoined, playerOptions, joinResult.spawn);

            if (!player && !joinResult.alreadyJoined) {
                roomManager.leaveRoom(socket);
                roomManager.destroyRoom(createResult.room.code);
                socket.emit("joinRoomResult", {
                    success: false,
                    message: "Don't have enough space to spawn in this room."
                });
                return;
            }

            socket.emit("joinRoomResult", { success: true, roomCode: joinResult.room.code });
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

        const player = initializeSocketPlayer(joinResult.room, socket, joinResult.alreadyJoined, playerOptions, joinResult.spawn);

        if (!player && !joinResult.alreadyJoined) {
            roomManager.leaveRoom(socket);
            socket.emit("joinRoomResult", {
                success: false,
                message: "Don't have enough space to spawn in this room."
            });
            io.emit("roomsList", buildRoomsList(roomManager));
            return;
        }

        socket.emit("joinRoomResult", { success: true, roomCode: joinResult.room.code });
        io.emit("roomsList", buildRoomsList(roomManager));
    });

    socket.on("leaveRoom", () => {
        const roomCode = socket.data && socket.data.roomCode;
        leaveMenuBackground(socket);
        const leaveResult = roomManager.leaveRoom(socket, {
            preserveRoom: hasRoomSpectators(io, roomCode)
        });

        if (leaveResult && leaveResult.room && !leaveResult.destroyed) {
            redirectSpectatorsAfterPlayerExit(
                io,
                leaveResult.room.code,
                leaveResult.room.players,
                leaveResult.room.territories,
                socket.id,
                null,
                leaveResult.room.runtimeConfig
            );
            io.to(leaveResult.room.code).emit("playerLeft", { playerId: socket.id });
        }

        io.emit("roomsList", buildRoomsList(roomManager));
    });
}

function joinExistingPublicRoom(roomManager, socket, difficulty, playerOptions) {
    const candidates = typeof roomManager.getPublicMatchCandidates === "function"
        ? roomManager.getPublicMatchCandidates(difficulty)
        : [];

    for (const room of candidates) {
        const joinResult = roomManager.joinRoom(room.code, socket, "");

        if (!joinResult.success) {
            continue;
        }

        const player = initializeSocketPlayer(
            joinResult.room,
            socket,
            joinResult.alreadyJoined,
            playerOptions,
            joinResult.spawn
        );

        if (player || joinResult.alreadyJoined) {
            return joinResult.room;
        }

        roomManager.leaveRoom(socket);
    }

    return null;
}

function hasRoomSpectators(io, roomCode) {
    if (!io || !roomCode) {
        return false;
    }

    for (const connectedSocket of io.sockets.sockets.values()) {
        if (
            connectedSocket.data
            && connectedSocket.data.spectatorRoomCode === roomCode
        ) {
            return true;
        }
    }

    return false;
}

function registerMenuBackgroundEvents(socket, io, roomManager) {
    socket.on("watchMenuBackground", () => {
        const createResult = roomManager.createBackgroundRoom(io);

        if (!createResult.success || !createResult.room) {
            socket.emit("menuBackgroundReady", {
                success: false,
                message: createResult.message || "Background room unavailable."
            });
            return;
        }

        const roomCode = createResult.room.code;

        if (socket.data.spectatorRoomCode && socket.data.spectatorRoomCode !== roomCode) {
            socket.leave(socket.data.spectatorRoomCode);
        }

        socket.join(roomCode);
        socket.data.spectatorRoomCode = roomCode;
        socket.data.spectatorFollowId = null;
        resetSocketSnapshotState(socket);
        socket.emit("menuBackgroundReady", {
            success: true,
            roomCode
        });
    });

    socket.on("unwatchMenuBackground", () => {
        leaveMenuBackground(socket);
    });
}

function leaveMenuBackground(socket) {
    const roomCode = socket.data && socket.data.spectatorRoomCode;

    if (!roomCode) {
        return;
    }

    socket.leave(roomCode);
    delete socket.data.spectatorRoomCode;
    delete socket.data.spectatorFollowId;
    resetSocketSnapshotState(socket);
}

function initializeSocketPlayer(room, socket, alreadyJoined, playerOptions = {}, spawn = null) {
    return initializeRoomPlayer(room, socket.id, alreadyJoined, playerOptions, spawn);
}

function normalizePlayerOptions(rawPlayer) {
    if (!rawPlayer || typeof rawPlayer !== "object") {
        return {};
    }

    return {
        color: String(rawPlayer.color || "").trim(),
        difficulty: String(rawPlayer.difficulty || "").trim(),
        name: String(rawPlayer.name || "").trim()
    };
}

function registerInputEvents(socket, roomManager) {
    const inputGuard = createInputGuard(socket, roomManager);
    const viewportGuard = createViewportGuard(socket, roomManager);
    const snapshotGuard = createSnapshotGuard(socket);

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
        if (!snapshotGuard.canHandleInput()) return;
        recordSnapshotResync(socket);
        resetSocketSnapshotState(socket);
    });

    socket.on("snapshotCacheInvalid", rawInvalidations => {
        if (!snapshotGuard.canHandleInput()) return;
        recordSnapshotCacheInvalidation(socket, rawInvalidations);
        invalidateSnapshotCache(socket, rawInvalidations);
    });
}

function recordSnapshotResync(socket) {
    const count = (socket.data.networkDiagnosticsSnapshotResyncCount || 0) + 1;

    socket.data.networkDiagnosticsSnapshotResyncCount = count;
    socket.data.networkDiagnosticsLastSnapshotResync = {
        at: Date.now(),
        count
    };
}

function recordSnapshotCacheInvalidation(socket, invalidations) {
    const count = (socket.data.networkDiagnosticsSnapshotCacheInvalidationCount || 0) + 1;
    const invalidationCounts = countSnapshotInvalidations(invalidations);

    socket.data.networkDiagnosticsSnapshotCacheInvalidationCount = count;
    socket.data.networkDiagnosticsLastSnapshotCacheInvalidation = {
        at: Date.now(),
        count,
        fullCacheReset: !hasSnapshotInvalidationCounts(invalidationCounts),
        invalidations: invalidationCounts
    };
}

function countSnapshotInvalidations(invalidations) {
    return {
        playerInfo: countInvalidationIds(invalidations && invalidations.playerInfo),
        territories: countInvalidationIds(invalidations && invalidations.territories),
        trails: countInvalidationIds(invalidations && invalidations.trails)
    };
}

function countInvalidationIds(ids) {
    return Array.isArray(ids) ? ids.length : 0;
}

function hasSnapshotInvalidationCounts(invalidations) {
    return Boolean(invalidations)
        && (
            invalidations.playerInfo > 0
            || invalidations.territories > 0
            || invalidations.trails > 0
        );
}

function handleInputEvent(socket, roomManager, callback) {
    const roomCode = socket.data && socket.data.roomCode;
    if (!roomCode) return;
    const room = roomManager.rooms.get(roomCode);
    if (!room) return;
    callback(room.players);
}

function createInputGuard(socket, roomManager) {
    return createSocketRateGuard(
        socket,
        config.security.inputRateLimit,
        () => hasActivePlayerRoomContext(socket, roomManager)
    );
}

function createViewportGuard(socket, roomManager) {
    return createSocketRateGuard(
        socket,
        config.security.viewportRateLimit,
        () => hasActivePlayerRoomContext(socket, roomManager)
    );
}

function createSnapshotGuard(socket) {
    return createSocketRateGuard(socket, config.security.viewportRateLimit, hasSnapshotContext);
}

function createSocketRateGuard(socket, rateLimitConfig, hasContext = hasPlayerRoomContext) {
    const rateLimiter = createRateLimiter(rateLimitConfig);
    let violations = 0;

    return { canHandleInput };

    function canHandleInput() {
        if (!hasContext(socket)) {
            return false;
        }

        if (rateLimiter.consume()) return true;
        violations++;
        if (violations >= rateLimitConfig.maxViolations) {
            socket.disconnect(true);
        }
        return false;
    }
}

function hasPlayerRoomContext(socket) {
    return Boolean(socket.data && socket.data.roomCode);
}

function hasActivePlayerRoomContext(socket, roomManager) {
    const roomCode = socket.data && socket.data.roomCode;
    const room = roomCode && roomManager && roomManager.rooms
        ? roomManager.rooms.get(roomCode)
        : null;

    return Boolean(room && room.players && room.players.has(socket.id));
}

function hasSnapshotContext(socket) {
    return Boolean(socket.data && (socket.data.roomCode || socket.data.spectatorRoomCode));
}

function handleInputDown(players, playerId, rawAction) {
    applyPlayerInput(players, playerId, "down", rawAction);
}

function handleInputUp(players, playerId, rawAction) {
    applyPlayerInput(players, playerId, "up", rawAction);
}

function handleInputDirection(players, playerId, rawInput) {
    applyPlayerInput(players, playerId, "direction", rawInput);
}

function handleInputDirectionEnd(players, playerId) {
    applyPlayerInput(players, playerId, "directionEnd");
}

function handleViewport(players, playerId, rawViewport) {
    applyPlayerInput(players, playerId, "viewport", rawViewport);
}

module.exports = registerSocket;
