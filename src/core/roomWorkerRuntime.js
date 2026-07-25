const config = require("../config/gameConfig");
const roomManager = require("./roomManager");
const { applyPlayerInput } = require("./playerInput");
const { initializeRoomPlayer } = require("./roomPlayer");
const { invalidateSnapshotCache } = require("./snapshotLoop");
const { resetSocketSnapshotState } = require("./snapshotState");
const { redirectSpectatorsAfterPlayerExit } = require("../systems/spectatorSystem");
const { createVirtualSocketIo } = require("./virtualSocketIo");

function createRoomWorkerRuntime(options = {}) {
    const publishEvent = typeof options.publishEvent === "function"
        ? options.publishEvent
        : () => {};
    const publishDirectoryMessage = typeof options.publishDirectory === "function"
        ? options.publishDirectory
        : () => {};
    const virtualTransport = createVirtualSocketIo({
        sendEvent: publishEvent,
        onGlobalEmit(event) {
            if (event !== "roomsList") return false;
            publishDirectory();
            return true;
        }
    });
    const io = virtualTransport.io;

    return {
        acknowledge: virtualTransport.acknowledge,
        close,
        executeCommand,
        executeRequest,
        getDirectory,
        getMetrics,
        publishDirectory
    };

    async function executeRequest(operation, payload = {}) {
        switch (operation) {
            case "createAndJoinRoom":
                return createAndJoinRoom(payload);
            case "joinRoom":
                return joinRoom(payload);
            case "leaveRoom":
                return leaveRoom(payload);
            case "destroyRoom":
                return destroyRoom(payload.roomCode);
            case "getDirectory":
                return getDirectory();
            default:
                throw new Error(`Unknown room worker operation: ${operation}`);
        }
    }

    function executeCommand(operation, payload = {}) {
        switch (operation) {
            case "input":
                return handleInput(payload);
            case "snapshotSignal":
                return handleSnapshotSignal(payload);
            case "connectionData":
                return updateConnectionData(payload);
            default:
                return false;
        }
    }

    function createAndJoinRoom(payload) {
        const socket = ensureConnection(payload);
        const createResult = roomManager.createRoom(io, payload.roomOptions || {});

        if (!createResult.success || !createResult.room) {
            removeUnusedConnection(socket);
            return createResult;
        }

        const joinResult = joinCreatedRoom(createResult.room, socket, payload);

        if (!joinResult.success) {
            roomManager.destroyRoom(createResult.room.code);
            removeUnusedConnection(socket);
        }

        publishDirectory();
        return joinResult;
    }

    function joinRoom(payload) {
        const socket = ensureConnection(payload);
        const joinResult = roomManager.joinRoom(payload.roomCode, socket, payload.password || "");

        if (!joinResult.success || !joinResult.room) {
            removeUnusedConnection(socket);
            return joinResult;
        }

        const player = initializeRoomPlayer(
            joinResult.room,
            socket.id,
            joinResult.alreadyJoined,
            payload.playerOptions || {},
            joinResult.spawn
        );

        if (!player && !joinResult.alreadyJoined) {
            roomManager.leaveRoom(socket);
            removeUnusedConnection(socket);
            publishDirectory();
            return {
                success: false,
                message: "Don't have enough space to spawn in this room."
            };
        }

        publishDirectory();
        return createJoinResponse(joinResult.room, joinResult.alreadyJoined);
    }

    function joinCreatedRoom(room, socket, payload) {
        const joinResult = roomManager.joinRoom(room.code, socket, payload.password || "");

        if (!joinResult.success) {
            return joinResult;
        }

        const player = initializeRoomPlayer(
            room,
            socket.id,
            joinResult.alreadyJoined,
            payload.playerOptions || {},
            joinResult.spawn
        );

        if (!player && !joinResult.alreadyJoined) {
            roomManager.leaveRoom(socket);
            return {
                success: false,
                message: "Don't have enough space to spawn in this room."
            };
        }

        return createJoinResponse(room, joinResult.alreadyJoined);
    }

    function leaveRoom(payload) {
        const socket = virtualTransport.getSocket(payload.socketId);
        if (!socket) return { destroyed: false, roomCode: null };

        const roomCode = socket.data.roomCode || payload.roomCode || null;
        const room = roomCode ? roomManager.rooms.get(roomCode) : null;
        const wasActivePlayer = Boolean(room && room.players.has(socket.id));

        delete socket.data.spectatorRoomCode;
        delete socket.data.spectatorFollowId;

        const preserveRoom = hasRoomSpectators(roomCode, socket.id);
        const leaveResult = roomManager.leaveRoom(socket, { preserveRoom });

        if (leaveResult && leaveResult.room && !leaveResult.destroyed && wasActivePlayer) {
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

        virtualTransport.removeSocket(socket.id);
        publishDirectory();
        return {
            destroyed: Boolean(leaveResult && leaveResult.destroyed),
            roomCode
        };
    }

    function destroyRoom(roomCode) {
        const destroyed = roomManager.destroyRoom(roomCode);
        if (destroyed) publishDirectory();
        return { destroyed, roomCode };
    }

    function handleInput(payload) {
        const socket = virtualTransport.getSocket(payload.socketId);
        const roomCode = socket && socket.data.roomCode;
        const room = roomCode ? roomManager.rooms.get(roomCode) : null;

        return Boolean(room) && applyPlayerInput(
            room.players,
            payload.socketId,
            payload.inputType,
            payload.value
        );
    }

    function handleSnapshotSignal(payload) {
        const socket = virtualTransport.getSocket(payload.socketId);
        if (!socket) return false;

        if (payload.signal === "resync") {
            recordSnapshotResync(socket);
            resetSocketSnapshotState(socket);
            return true;
        }

        if (payload.signal === "cacheInvalid") {
            recordSnapshotCacheInvalidation(socket, payload.value);
            invalidateSnapshotCache(socket, payload.value);
            return true;
        }

        return false;
    }

    function updateConnectionData(payload) {
        const socket = virtualTransport.getSocket(payload.socketId);
        if (!socket || !payload.data || typeof payload.data !== "object") return false;

        for (const key of [
            "captureOverlapAuditEnabled",
            "networkDiagnosticsEnabled",
            "snapshotSchema"
        ]) {
            if (Object.prototype.hasOwnProperty.call(payload.data, key)) {
                socket.data[key] = payload.data[key];
            }
        }
        return true;
    }

    function ensureConnection(payload) {
        return virtualTransport.ensureSocket(payload.socketId, payload.socketData || {});
    }

    function removeUnusedConnection(socket) {
        if (!socket || socket.data.roomCode || socket.data.spectatorRoomCode) return;
        virtualTransport.removeSocket(socket.id);
    }

    function hasRoomSpectators(roomCode, excludedSocketId) {
        if (!roomCode) return false;

        for (const socket of virtualTransport.sockets.values()) {
            if (
                socket.id !== excludedSocketId
                && socket.data.spectatorRoomCode === roomCode
            ) {
                return true;
            }
        }
        return false;
    }

    function createJoinResponse(room, alreadyJoined) {
        return {
            alreadyJoined: Boolean(alreadyJoined),
            room: serializeRoom(room),
            success: true
        };
    }

    function serializeRoom(room) {
        const listedRoom = roomManager.listRooms().find(candidate => candidate.code === room.code);

        return listedRoom || {
            code: room.code,
            createdAt: room.createdAt,
            difficulty: room.difficulty,
            isPrivate: Boolean(room.isPrivate),
            maxPlayers: room.maxPlayers,
            playerCount: 0
        };
    }

    function getDirectory() {
        return roomManager.listRooms();
    }

    function getMetrics() {
        const listedRooms = new Map(
            roomManager.listRooms().map(room => [room.code, room])
        );
        let botCount = 0;
        let playerCount = 0;
        let tickDurationMs = 0;
        let tickDriftMs = 0;

        for (const room of roomManager.rooms.values()) {
            const listedRoom = listedRooms.get(room.code);
            botCount += finiteNonNegative(listedRoom && listedRoom.botCount);
            playerCount += finiteNonNegative(listedRoom && listedRoom.playerCount);
            tickDurationMs += finiteNonNegative(
                room.diagnostics && room.diagnostics.gameLoop.tickDurationMs
            );
            tickDriftMs += finiteSigned(
                room.diagnostics && room.diagnostics.gameLoop.tickDriftMs
            );
        }

        return {
            botCount,
            playerCount,
            roomCount: roomManager.rooms.size,
            tickDriftMs,
            tickDurationMs,
            updatedAt: Date.now()
        };
    }

    function publishDirectory() {
        publishDirectoryMessage(getDirectory());
    }

    function close() {
        for (const roomCode of [...roomManager.rooms.keys()]) {
            roomManager.destroyRoom(roomCode);
        }
        for (const socketId of [...virtualTransport.sockets.keys()]) {
            virtualTransport.removeSocket(socketId);
        }
    }
}

function finiteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function finiteSigned(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function recordSnapshotResync(socket) {
    const count = (socket.data.networkDiagnosticsSnapshotResyncCount || 0) + 1;
    socket.data.networkDiagnosticsSnapshotResyncCount = count;
    socket.data.networkDiagnosticsLastSnapshotResync = { at: Date.now(), count };
}

function recordSnapshotCacheInvalidation(socket, invalidations) {
    const count = (socket.data.networkDiagnosticsSnapshotCacheInvalidationCount || 0) + 1;
    socket.data.networkDiagnosticsSnapshotCacheInvalidationCount = count;
    socket.data.networkDiagnosticsLastSnapshotCacheInvalidation = {
        at: Date.now(),
        count,
        fullCacheReset: !hasInvalidationIds(invalidations),
        invalidations
    };
}

function hasInvalidationIds(invalidations) {
    if (!invalidations || typeof invalidations !== "object") return false;
    return ["playerInfo", "territories", "trails"].some(key => (
        Array.isArray(invalidations[key]) && invalidations[key].length > 0
    ));
}

module.exports = {
    createRoomWorkerRuntime
};
