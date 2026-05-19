const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const {
    deletePlayerTerritory,
    initializePlayerTerritory
} = require("../state/territories");
const { createRateLimiter } = require("../utils/rateLimiter");

function registerSocket(io, players, territories) {
    io.on("connection", socket => {
        const player = createPlayer(players, socket.id, territories);
        initializePlayerTerritory(territories, player);
        registerInputEvents(socket, players);

        socket.on("disconnect", () => {
            players.delete(socket.id);
            deletePlayerTerritory(territories, socket.id);
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

    socket.on("inputDirection", rawInput => {
        if (!inputGuard.canHandleInput()) {
            return;
        }

        handleInputDirection(players, socket.id, rawInput);
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

function handleInputDirection(players, playerId, rawInput) {
    const input = normalizeInputDirection(rawInput);

    if (!input) {
        return;
    }

    const player = players.get(playerId);

    if (!player) {
        return;
    }

    player.setDirectionAngle(input.angle, input.source);
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

function normalizeInputDirection(rawInput) {
    const rawAngle = isInputDirectionPayload(rawInput) ? rawInput.angle : rawInput;
    const angle = normalizeInputAngle(rawAngle);

    if (angle === null) {
        return null;
    }

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

    if (!Number.isFinite(angle)) {
        return null;
    }

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

module.exports = registerSocket;
