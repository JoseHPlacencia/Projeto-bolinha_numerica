const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { createRateLimiter } = require("../utils/rateLimiter");

function registerSocket(io, players, roomManager) {
    io.on("connection", socket => {
        createPlayer(players, socket.id);
        registerInputEvents(socket, players);
        registerRoomEvents(socket, roomManager);

        socket.on("disconnect", () => {
            players.delete(socket.id);
            if (socket.data.roomCode) {
                roomManager.leaveRoom(socket.data.roomCode, socket.id);
            }
        });
    });
}

function registerInputEvents(socket, players) {
    const inputGuard = createInputGuard(socket);

    socket.on("inputDown", rawAction => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputDown(players, socket.id, rawAction);
    });

    socket.on("inputUp", rawAction => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputUp(players, socket.id, rawAction);
    });

    socket.on("inputDirection", rawAngle => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputDirection(players, socket.id, rawAngle);
    });

    socket.on("inputDirectionEnd", () => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputDirectionEnd(players, socket.id);
    });
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


function registerRoomEvents(socket, roomManager) {
    socket.on("createRoom", settings => {
        const room = roomManager.createRoom({ settings });

        roomManager.joinRoom(room.code, socket.id, settings.password);
        socket.data.roomCode = room.code;
        socket.emit("roomCreated", room);
    });

    socket.on("joinRoom", payload => {
        const result = roomManager.joinRoom(payload.code, socket.id, payload.password);

        if (!result.ok) {
            socket.emit("roomError", result.reason);
            return;
        }

        socket.data.roomCode = payload.code;
        socket.emit("roomJoined", result.room);
    });

    socket.on("joinQuickTestRoom", () => {
        const result = roomManager.joinRoom("TESTE-0001", socket.id, "debug");

        if (result.ok) {
            socket.data.roomCode = "TESTE-0001";
            socket.emit("roomJoined", result.room);
        }
    });

    socket.on("requestSpectatorTarget", () => {
        socket.emit("spectatorTarget", roomManager.getSpectatorTarget());
    });
}

module.exports = registerSocket;
