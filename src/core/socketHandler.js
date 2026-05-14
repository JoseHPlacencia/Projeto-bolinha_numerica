const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { createRateLimiter } = require("../utils/rateLimiter");

function registerSocket(io, players) {
    io.on("connection", socket => {
        createPlayer(players, socket.id);
        registerInputEvents(socket, players);

        socket.on("disconnect", () => {
            players.delete(socket.id);
        });
    });
}

function registerInputEvents(socket, players) {
    const inputGuard = createInputGuard(socket);

    socket.on("inputDown", rawKey => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputDown(players, socket.id, rawKey);
    });

    socket.on("inputUp", rawKey => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputUp(players, socket.id, rawKey);
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

function handleInputDown(players, playerId, rawKey) {
    const key = normalizeInputKey(rawKey);

    if (!isInputKeyValid(key)) {
        return;
    }

    const player = players.get(playerId);

    if (player) {
        player.pressKey(key);
    }
}

function handleInputUp(players, playerId, rawKey) {
    const key = normalizeInputKey(rawKey);

    if (!isInputKeyValid(key)) {
        return;
    }

    const player = players.get(playerId);

    if (player) {
        player.releaseKey(key);
    }
}

function normalizeInputKey(key) {
    return String(key || "").toLowerCase();
}

function isInputKeyValid(key) {
    return Object.prototype.hasOwnProperty.call(config.inputAngles, key);
}

module.exports = registerSocket;
