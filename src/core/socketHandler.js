const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { createRateLimiter } = require("../utils/rateLimiter");

/**
 * Registra todos os eventos de socket (input do jogo + salas)
 * 
 * @param {Object} io - Socket.IO Server instance
 * @param {Map} players - Mapa global de jogadores
 * @param {Object} sistemaRooms - Sistema de gerenciamento de salas
 */
function registerSocket(io, players, sistemaRooms) {
    io.on("connection", socket => {
        // Criar jogador no mapa global
        createPlayer(players, socket.id);
        
        // Registrar eventos de input
        registerInputEvents(socket, players);

        // Ao desconectar, remover jogador e salas
        socket.on("disconnect", () => {
            players.delete(socket.id);
            
            // Remover da sala (se estiver em uma)
            if (sistemaRooms) {
                sistemaRooms.sairSala(socket.id);
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

module.exports = registerSocket;
