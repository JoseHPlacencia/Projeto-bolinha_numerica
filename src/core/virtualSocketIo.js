function createVirtualSocketIo(options = {}) {
    const sendEvent = typeof options.sendEvent === "function"
        ? options.sendEvent
        : () => {};
    const onGlobalEmit = typeof options.onGlobalEmit === "function"
        ? options.onGlobalEmit
        : null;
    const sockets = new Map();
    const roomSocketIds = new Map();
    const acknowledgementCallbacks = new Map();
    let nextAcknowledgementId = 1;

    const io = {
        sockets: { sockets },
        getRoomSockets(roomCode) {
            const socketIds = roomSocketIds.get(roomCode);
            if (!socketIds) return [];
            const roomSockets = [];
            for (const socketId of socketIds) {
                const socket = sockets.get(socketId);
                if (socket) roomSockets.push(socket);
            }
            return roomSockets;
        },
        emit(event, ...args) {
            if (onGlobalEmit && onGlobalEmit(event, args) === true) {
                return true;
            }

            sendEvent({
                args,
                event,
                target: "global"
            });
            return true;
        },
        to(roomCode) {
            return {
                emit(event, ...args) {
                    sendEvent({
                        args,
                        event,
                        roomCode,
                        target: "room"
                    });
                    return true;
                }
            };
        }
    };

    return {
        acknowledge,
        ensureSocket,
        getSocket: socketId => sockets.get(socketId) || null,
        io,
        removeSocket,
        sockets
    };

    function ensureSocket(socketId, initialData = {}) {
        let socket = sockets.get(socketId);

        if (!socket) {
            socket = createVirtualSocket(socketId);
            sockets.set(socketId, socket);
        }

        synchronizeSocketData(socket.data, initialData);
        return socket;
    }

    function createVirtualSocket(socketId) {
        const joinedRooms = new Set();
        const socket = {
            connected: true,
            data: {},
            id: socketId,
            joinedRooms,
            join(roomCode) {
                joinedRooms.add(roomCode);
                let socketIds = roomSocketIds.get(roomCode);
                if (!socketIds) {
                    socketIds = new Set();
                    roomSocketIds.set(roomCode, socketIds);
                }
                socketIds.add(socketId);
            },
            leave(roomCode) {
                joinedRooms.delete(roomCode);
                const socketIds = roomSocketIds.get(roomCode);
                if (!socketIds) return;
                socketIds.delete(socketId);
                if (socketIds.size === 0) roomSocketIds.delete(roomCode);
            },
            emit(event, ...args) {
                return emitToSocket(socket, event, args, {});
            },
            timeout(timeoutMs) {
                return {
                    emit(event, ...args) {
                        return emitToSocket(socket, event, args, { timeoutMs });
                    }
                };
            }
        };

        socket.volatile = {
            emit(event, ...args) {
                return emitToSocket(socket, event, args, { volatile: true });
            }
        };

        return socket;
    }

    function emitToSocket(socket, event, rawArgs, emissionOptions) {
        const args = [...rawArgs];
        const callback = typeof args[args.length - 1] === "function"
            ? args.pop()
            : null;
        let acknowledgementId = null;

        if (callback) {
            acknowledgementId = `${socket.id}:${nextAcknowledgementId++}`;
            acknowledgementCallbacks.set(acknowledgementId, {
                callback,
                socketId: socket.id
            });
        }

        sendEvent({
            acknowledgementId,
            args,
            event,
            socketId: socket.id,
            target: "socket",
            timeoutMs: normalizeTimeout(emissionOptions.timeoutMs),
            volatile: emissionOptions.volatile === true
        });
        return true;
    }

    function acknowledge(message) {
        const pending = message && acknowledgementCallbacks.get(message.acknowledgementId);
        if (!pending) return false;

        acknowledgementCallbacks.delete(message.acknowledgementId);
        const error = message.error
            ? new Error(message.error.message || "Socket acknowledgement failed.")
            : null;
        pending.callback(error, message.acknowledgement);
        return true;
    }

    function removeSocket(socketId) {
        const socket = sockets.get(socketId);
        if (!socket) return false;

        socket.connected = false;
        sockets.delete(socketId);

        for (const roomCode of joinedRoomsFor(socket)) {
            socket.leave(roomCode);
        }

        for (const [acknowledgementId, pending] of acknowledgementCallbacks) {
            if (pending.socketId !== socketId) continue;
            acknowledgementCallbacks.delete(acknowledgementId);
            pending.callback(new Error("Socket disconnected before acknowledgement."));
        }

        return true;
    }
}

function joinedRoomsFor(socket) {
    return socket && socket.joinedRooms instanceof Set
        ? [...socket.joinedRooms]
        : [];
}

function synchronizeSocketData(target, source) {
    if (!source || typeof source !== "object") return;

    for (const key of [
        "captureOverlapAuditEnabled",
        "networkDiagnosticsEnabled",
        "networkDiagnosticsSnapshotCacheInvalidationCount",
        "networkDiagnosticsSnapshotResyncCount",
        "snapshotSchema"
    ]) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            target[key] = source[key];
        }
    }
}

function normalizeTimeout(rawTimeoutMs) {
    const timeoutMs = Number(rawTimeoutMs);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
}

module.exports = {
    createVirtualSocketIo
};
