const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { createRateLimiter } = require("../utils/rateLimiter");

function registerSocket(io, roomManager) {
    io.on("connection", socket => {
        registerRoomEvents(socket, io, roomManager);
        registerInputEvents(socket, roomManager);

        socket.on("disconnect", () => {
            const leaveResult = roomManager.leaveRoom(socket);

            if (leaveResult && leaveResult.room && !leaveResult.destroyed) {
                io.to(leaveResult.room.code).emit("playerLeft", {
                    playerId: socket.id
                });
            }
        });
    });
}

function registerRoomEvents(socket, io, roomManager) {
    socket.on("joinRoom", payload => {
        const createNewRoom = Boolean(payload && payload.createNewRoom);
        const requestedCode = String(payload && payload.roomCode || "").trim().toUpperCase();

        if (createNewRoom) {
            const createResult = roomManager.createRoom(io);

            if (!createResult.success) {
                socket.emit("joinRoomResult", {
                    success: false,
                    message: createResult.message
                });
                return;
            }

            const joinResult = roomManager.joinRoom(createResult.room.code, socket);

            if (!joinResult.success) {
                socket.emit("joinRoomResult", {
                    success: false,
                    message: joinResult.message
                });
                return;
            }

            socket.emit("joinRoomResult", {
                success: true,
                roomCode: createResult.room.code
            });
            return;
        }

        if (!requestedCode) {
            socket.emit("joinRoomResult", {
                success: false,
                message: "Room code is required."
            });
            return;
        }

        const joinResult = roomManager.joinRoom(requestedCode, socket);

        if (!joinResult.success) {
            socket.emit("joinRoomResult", {
                success: false,
                message: joinResult.message
            });
            return;
        }

        socket.emit("joinRoomResult", {
            success: true,
            roomCode: requestedCode
        });
    });

    socket.on("leaveRoom", () => {
        const leaveResult = roomManager.leaveRoom(socket);

        if (leaveResult && leaveResult.room && !leaveResult.destroyed) {
            io.to(leaveResult.room.code).emit("playerLeft", {
                playerId: socket.id
            });
        }
    });
}

function registerInputEvents(socket, roomManager) {
    const inputGuard = createInputGuard(socket);

    socket.on("inputDown", rawAction => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputEvent(socket, roomManager, (players) => {
            handleInputDown(players, socket.id, rawAction);
        });
    });

    socket.on("inputUp", rawAction => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputEvent(socket, roomManager, (players) => {
            handleInputUp(players, socket.id, rawAction);
        });
    });

    socket.on("inputDirection", rawAngle => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputEvent(socket, roomManager, (players) => {
            handleInputDirection(players, socket.id, rawAngle);
        });
    });

    socket.on("inputDirectionEnd", () => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputEvent(socket, roomManager, (players) => {
            handleInputDirectionEnd(players, socket.id);
        });
    });
}

function handleInputEvent(socket, roomManager, callback) {
    const room = roomManager.getRoomBySocketId(socket.id);

    if (!room) {
        return;
    }

    callback(room.players);
}

function createInputGuard(socket) {
    const rateLimiter = createRateLimiter(config.security.inputRateLimit);
    let violations = 0;

    return {
        canHandleInput
    };

    function canHandleInput() {
        if (rateLimiter.consume()) {
            return true;
        }

        violations++;

        if (violations >= config.security.inputRateLimit.maxViolations) {
            socket.disconnect(true);
        }

        return false;
    }
}

function handleInputDown(players, playerId, rawAction) {
    const action = normalizeInputAction(rawAction);

    if (!isInputActionValid(action)) {
        return;
    }

    const player = players.get(playerId);

    if (player) {
        player.pressAction(action);
    }
}

function handleInputUp(players, playerId, rawAction) {
    const action = normalizeInputAction(rawAction);

    if (!isInputActionValid(action)) {
        return;
    }

    const player = players.get(playerId);

    if (player) {
        player.releaseAction(action);
    }
}

function handleInputDirection(players, playerId, rawAngle) {
    const angle = normalizeInputAngle(rawAngle);

    if (angle === null) {
        return;
    }

    const player = players.get(playerId);

    if (player) {
        player.setDirectionAngle(angle);
    }
}

function handleInputDirectionEnd(players, playerId) {
    const player = players.get(playerId);

    if (player) {
        player.clearDirectionAngle();
    }
}

function normalizeInputAction(action) {
    return String(action || "").toLowerCase();
}

function isInputActionValid(action) {
    return Object.prototype.hasOwnProperty.call(config.inputActionAngles, action);
}

function normalizeInputAngle(rawAngle) {
    const angle = Number(rawAngle);

    if (!Number.isFinite(angle)) {
        return null;
    }

    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

module.exports = registerSocket;
