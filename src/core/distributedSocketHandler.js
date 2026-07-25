const config = require("../config/gameConfig");
const { invalidateSnapshotCache } = require("./snapshotLoop");
const { resetSocketSnapshotState } = require("./snapshotState");
const { createRateLimiter } = require("../utils/rateLimiter");
const {
    disableGatewayTransportDiagnostics,
    recordGatewaySocketEmission,
    setGatewayTransportDiagnosticsEnabled,
    takeGatewayTransportDiagnostics
} = require("./gatewayTransportDiagnostics");

function registerDistributedSocket(io, coordinator) {
    coordinator.on("roomsChanged", () => {
        io.emit("roomsList", coordinator.listRooms());
    });
    coordinator.on("workerEvent", message => {
        try {
            forwardWorkerEvent(io, coordinator, message);
        } finally {
            coordinator.confirmEventDelivery(
                message.workerId,
                message.event && message.event.deliveryId
            );
        }
    });
    coordinator.on("workerEventBatch", message => {
        forwardWorkerEventBatch(io, coordinator, message);
    });
    coordinator.on("workerUnavailable", message => {
        handleWorkerUnavailable(io, message);
    });
    coordinator.on("workerError", ({ error, workerId }) => {
        console.error(`Room worker ${workerId} failed:`, error);
    });

    io.on("connection", socket => {
        socket.emit("roomsList", coordinator.listRooms());
        registerRoomEvents(socket, io, coordinator);
        registerInputEvents(socket, coordinator);
        registerNetworkDiagnosticsEvents(socket, coordinator);
        registerMenuBackgroundEvents(socket, io, coordinator);

        socket.on("disconnect", () => {
            disableGatewayTransportDiagnostics(socket);
            leaveMenuBackground(socket);
            leaveDistributedRoom(socket, coordinator).catch(error => {
                console.error("Failed to remove disconnected player from room worker:", error);
            });
        });
    });
}

function registerRoomEvents(socket, io, coordinator) {
    socket.on("requestRoomsList", () => {
        socket.emit("roomsList", coordinator.listRooms());
    });

    socket.on("joinRoom", async payload => {
        if (socket.data.roomRequestPending) return;
        socket.data.roomRequestPending = true;
        let joinedWorkerRoom = false;

        try {
            leaveMenuBackground(socket);
            if (socket.data.remoteRoom) {
                await leaveDistributedRoom(socket, coordinator);
            }

            const request = normalizeJoinRequest(payload);
            let result = null;
            let reusedRoom = false;

            if (request.quickMatch) {
                for (const room of coordinator.getPublicMatchCandidates(request.difficulty)) {
                    result = await coordinator.joinRoom(
                        socket,
                        room.code,
                        "",
                        request.playerOptions
                    );
                    if (result && result.success) {
                        reusedRoom = true;
                        break;
                    }
                }
            }

            if (!result || !result.success) {
                if (request.createNewRoom || request.quickMatch) {
                    result = await coordinator.createAndJoinRoom(socket, {
                        password: request.quickMatch ? "" : request.password,
                        playerOptions: request.playerOptions,
                        roomOptions: {
                            customOptions: request.quickMatch ? {} : request.customOptions,
                            difficulty: request.difficulty,
                            isPrivate: request.quickMatch ? false : request.isPrivate,
                            password: request.quickMatch ? "" : request.password
                        }
                    });
                } else if (!request.roomCode) {
                    result = { success: false, message: "Room code is required." };
                } else {
                    result = await coordinator.joinRoom(
                        socket,
                        request.roomCode,
                        request.password,
                        request.playerOptions
                    );
                }
            }

            if (!result || !result.success || !result.room) {
                socket.emit("joinRoomResult", {
                    success: false,
                    message: result && result.message || "Room unavailable."
                });
                return;
            }

            joinedWorkerRoom = true;

            if (!socket.connected) {
                await coordinator.leaveRoom(socket);
                return;
            }

            await socket.join(result.room.code);
            socket.data.roomCode = result.room.code;
            socket.data.remoteRoom = true;
            socket.data.playerActive = true;
            delete socket.data.spectatorRoomCode;
            resetSocketSnapshotState(socket);
            socket.emit("joinRoomResult", {
                success: true,
                roomCode: result.room.code,
                reusedRoom
            });
            io.emit("roomsList", coordinator.listRooms());
        } catch (error) {
            console.error("Failed to join distributed room:", error);
            if (joinedWorkerRoom) {
                await coordinator.leaveRoom(socket).catch(() => {});
            }
            socket.emit("joinRoomResult", {
                success: false,
                message: "Room service is temporarily unavailable."
            });
        } finally {
            socket.data.roomRequestPending = false;
        }
    });

    socket.on("leaveRoom", async () => {
        if (socket.data.roomRequestPending) return;
        socket.data.roomRequestPending = true;

        try {
            leaveMenuBackground(socket);
            await leaveDistributedRoom(socket, coordinator);
            io.emit("roomsList", coordinator.listRooms());
        } catch (error) {
            console.error("Failed to leave distributed room:", error);
        } finally {
            socket.data.roomRequestPending = false;
        }
    });
}

function registerInputEvents(socket, coordinator) {
    const inputGuard = createSocketRateGuard(
        socket,
        config.security.inputRateLimit,
        () => coordinator.hasActivePlayer(socket)
    );
    const viewportGuard = createSocketRateGuard(
        socket,
        config.security.viewportRateLimit,
        () => coordinator.hasActivePlayer(socket)
    );
    const snapshotGuard = createSocketRateGuard(
        socket,
        config.security.viewportRateLimit,
        () => Boolean(socket.data && (socket.data.remoteRoom || socket.data.spectatorRoomCode))
    );

    socket.on("inputDown", rawAction => {
        if (inputGuard.canHandleInput()) coordinator.sendInput(socket, "down", rawAction);
    });
    socket.on("inputUp", rawAction => {
        if (inputGuard.canHandleInput()) coordinator.sendInput(socket, "up", rawAction);
    });
    socket.on("inputDirection", rawInput => {
        if (inputGuard.canHandleInput()) coordinator.sendInput(socket, "direction", rawInput);
    });
    socket.on("inputDirectionEnd", () => {
        if (inputGuard.canHandleInput()) coordinator.sendInput(socket, "directionEnd");
    });
    socket.on("viewport", rawViewport => {
        if (viewportGuard.canHandleInput()) coordinator.sendInput(socket, "viewport", rawViewport);
    });
    socket.on("snapshotResync", () => {
        if (!snapshotGuard.canHandleInput()) return;
        recordSnapshotResync(socket);
        if (!coordinator.sendSnapshotSignal(socket, "resync")) {
            resetSocketSnapshotState(socket);
        }
    });
    socket.on("snapshotCacheInvalid", rawInvalidations => {
        if (!snapshotGuard.canHandleInput()) return;
        recordSnapshotCacheInvalidation(socket, rawInvalidations);
        if (!coordinator.sendSnapshotSignal(socket, "cacheInvalid", rawInvalidations)) {
            invalidateSnapshotCache(socket, rawInvalidations);
        }
    });
}

function registerNetworkDiagnosticsEvents(socket, coordinator) {
    const diagnosticsGuard = createSocketRateGuard(
        socket,
        config.security.viewportRateLimit,
        () => true
    );

    socket.on("networkDiagnostics", (rawOptions, acknowledge) => {
        if (!diagnosticsGuard.canHandleInput()) return;
        const enabled = !(rawOptions && rawOptions.enabled === false);
        const captureOverlapAudit = enabled
            && rawOptions
            && rawOptions.captureOverlapAudit === true;

        socket.data.networkDiagnosticsEnabled = enabled;
        socket.data.captureOverlapAuditEnabled = captureOverlapAudit;
        setGatewayTransportDiagnosticsEnabled(socket, enabled);
        coordinator.updateConnectionData(socket, {
            captureOverlapAuditEnabled: captureOverlapAudit,
            networkDiagnosticsEnabled: enabled
        });

        if (typeof acknowledge === "function") {
            acknowledge({
                captureOverlapAudit,
                enabled,
                gatewayDiagnostics: takeGatewayTransportDiagnostics(socket),
                serverTime: Date.now(),
                transport: getSocketTransportName(socket),
                workerDiagnostics: getWorkerDiagnostics(coordinator)
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
            transport: getSocketTransportName(socket),
            workerDiagnostics: getWorkerDiagnostics(coordinator)
        });
    });
}

function registerMenuBackgroundEvents(socket, io, coordinator) {
    socket.on("watchMenuBackground", () => {
        const createResult = coordinator.createBackgroundRoom(io);

        if (!createResult.success || !createResult.room) {
            socket.emit("menuBackgroundReady", {
                success: false,
                message: createResult.message || "Background room unavailable."
            });
            return;
        }

        const roomCode = createResult.room.code;
        socket.join(roomCode);
        socket.data.spectatorRoomCode = roomCode;
        socket.data.spectatorFollowId = null;
        resetSocketSnapshotState(socket);
        socket.emit("menuBackgroundReady", { success: true, roomCode });
    });

    socket.on("unwatchMenuBackground", () => {
        leaveMenuBackground(socket);
    });
}

async function leaveDistributedRoom(socket, coordinator) {
    if (!socket || !socket.data || !socket.data.remoteRoom) return null;

    const roomCode = socket.data.roomCode;
    if (roomCode) await socket.leave(roomCode);
    const result = await coordinator.leaveRoom(socket);

    socket.data.playerActive = false;
    delete socket.data.remoteRoom;
    delete socket.data.roomCode;
    delete socket.data.spectatorRoomCode;
    delete socket.data.spectatorFollowId;
    resetSocketSnapshotState(socket);
    return result;
}

function leaveMenuBackground(socket) {
    const roomCode = socket && socket.data && socket.data.spectatorRoomCode;
    const backgroundRoomCode = String(config.menuBackground.roomCode || "BOTS").trim().toUpperCase();

    if (!roomCode || roomCode !== backgroundRoomCode || socket.data.remoteRoom) return;
    socket.leave(roomCode);
    delete socket.data.spectatorRoomCode;
    delete socket.data.spectatorFollowId;
    resetSocketSnapshotState(socket);
}

function forwardWorkerEventBatch(io, coordinator, message) {
    const workerId = message && message.workerId;
    const events = Array.isArray(message && message.events)
        ? message.events
        : [];
    const deliveryIds = [];

    for (const event of events) {
        try {
            forwardWorkerEvent(io, coordinator, { event, workerId });
        } catch (error) {
            console.error(`Failed to forward room worker ${workerId} event:`, error);
        }

        if (event && event.deliveryId) {
            deliveryIds.push(event.deliveryId);
        }
    }

    if (deliveryIds.length > 0) {
        coordinator.confirmEventDeliveries(workerId, deliveryIds);
    }
}

function forwardWorkerEvent(io, coordinator, message) {
    const workerId = message && message.workerId;
    const emission = message && message.event;
    if (!emission || !emission.event) return;

    const args = Array.isArray(emission.args) ? emission.args : [];

    if (emission.target === "socket") {
        const socket = io.sockets.sockets.get(emission.socketId);
        if (!socket) {
            acknowledgeMissingSocket(coordinator, workerId, emission);
            return;
        }

        if (emission.event === "gameOver") {
            applyRemoteGameOverState(socket, args[0]);
        }

        emitToSocket(socket, coordinator, workerId, emission, args);
        return;
    }

    if (emission.target === "room") {
        io.to(emission.roomCode).emit(emission.event, ...args);
        return;
    }

    if (emission.target === "global") {
        io.emit(emission.event, ...args);
    }
}

function emitToSocket(socket, coordinator, workerId, emission, args) {
    if (emission.acknowledgementId) {
        if (emission.timeoutMs && typeof socket.timeout === "function") {
            recordGatewaySocketEmission(socket, emission.event, emission, () => (
                socket.timeout(emission.timeoutMs).emit(
                    emission.event,
                    ...args,
                    (error, acknowledgement) => {
                        coordinator.acknowledge(workerId, {
                            acknowledgement,
                            acknowledgementId: emission.acknowledgementId,
                            error: error ? { message: error.message || String(error) } : null
                        });
                    }
                )
            ));
        } else {
            recordGatewaySocketEmission(socket, emission.event, emission, () => (
                socket.emit(emission.event, ...args, acknowledgement => {
                    coordinator.acknowledge(workerId, {
                        acknowledgement,
                        acknowledgementId: emission.acknowledgementId,
                        error: null
                    });
                })
            ));
        }
        return;
    }

    const emitter = emission.volatile && socket.volatile ? socket.volatile : socket;
    recordGatewaySocketEmission(socket, emission.event, emission, () => (
        emitter.emit(emission.event, ...args)
    ));
}

function acknowledgeMissingSocket(coordinator, workerId, emission) {
    if (!emission.acknowledgementId) return;
    coordinator.acknowledge(workerId, {
        acknowledgementId: emission.acknowledgementId,
        error: { message: "Socket is no longer connected." }
    });
}

function applyRemoteGameOverState(socket, gameOver) {
    socket.data.playerActive = false;
    if (gameOver && gameOver.canSpectate && socket.data.roomCode) {
        socket.data.spectatorRoomCode = socket.data.roomCode;
        socket.data.spectatorFollowId = gameOver.spectatorFollowId || null;
    } else {
        delete socket.data.spectatorRoomCode;
        delete socket.data.spectatorFollowId;
    }
}

function handleWorkerUnavailable(io, message) {
    for (const socketId of message.affectedSocketIds || []) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        const roomCode = socket.data.roomCode;
        if (roomCode) socket.leave(roomCode);
        socket.data.playerActive = false;
        delete socket.data.remoteRoom;
        delete socket.data.roomCode;
        delete socket.data.spectatorRoomCode;
        delete socket.data.spectatorFollowId;
        socket.emit("gameOver", {
            canSpectate: false,
            reason: "roomUnavailable"
        });
    }
}

function normalizeJoinRequest(payload) {
    return {
        createNewRoom: Boolean(payload && payload.createNewRoom),
        customOptions: payload && typeof payload.customOptions === "object"
            ? payload.customOptions
            : {},
        difficulty: String(payload && payload.difficulty || "").trim().toLowerCase() || "medium",
        isPrivate: Boolean(payload && payload.isPrivate),
        password: String(payload && payload.password || ""),
        playerOptions: normalizePlayerOptions(payload && payload.player),
        quickMatch: Boolean(payload && payload.quickMatch),
        roomCode: String(payload && payload.roomCode || "").trim().toUpperCase()
    };
}

function normalizePlayerOptions(rawPlayer) {
    if (!rawPlayer || typeof rawPlayer !== "object") return {};
    return {
        color: String(rawPlayer.color || "").trim(),
        difficulty: String(rawPlayer.difficulty || "").trim(),
        name: String(rawPlayer.name || "").trim()
    };
}

function createSocketRateGuard(socket, rateLimitConfig, hasContext) {
    const rateLimiter = createRateLimiter(rateLimitConfig);
    let violations = 0;

    return {
        canHandleInput() {
            if (!hasContext()) return false;
            if (rateLimiter.consume()) return true;
            violations++;
            if (violations >= rateLimitConfig.maxViolations) socket.disconnect(true);
            return false;
        }
    };
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
        invalidations
    };
}

function getSocketTransportName(socket) {
    return socket
        && socket.conn
        && socket.conn.transport
        && socket.conn.transport.name
        ? socket.conn.transport.name
        : null;
}

function getWorkerDiagnostics(coordinator) {
    return coordinator && typeof coordinator.getWorkerDiagnostics === "function"
        ? coordinator.getWorkerDiagnostics()
        : [];
}

module.exports = registerDistributedSocket;
