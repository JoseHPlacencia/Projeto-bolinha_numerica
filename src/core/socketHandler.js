const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { createRateLimiter } = require("../utils/rateLimiter");

function registerSocket(io, players) {
    io.on("connection", socket => {
        createPlayer(players, socket.id);
        registerInputEvents(socket, players);

        // === RESPAWN + TERRITÓRIO INIMIGO ===
        // Registra os eventos de gameplay que vêm do cliente:
        //   "respawn"           — jogador morreu e pede reposicionamento
        //   "subtrairTerritorio" — jogador quer remover células do território inimigo
        registerGameEvents(socket, players, io);

        socket.on("disconnect", () => {
            players.delete(socket.id);
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

// ─── Eventos de Gameplay ───────────────────────────────────────────────────────
//
// Estes eventos complementam o sistema de input (teclado/gamepad/touch) e
// tratam de mecânicas do jogo que precisam de processamento no servidor.
function registerGameEvents(socket, players, io) {

    // === RESPAWN ===
    // Recebido no instante da morte (t=0).
    // 1. Congela o jogador no servidor (isDead = true bloqueia updatePlayer).
    // 2. Limpa qualquer input ativo para evitar movimento residual ao reviver.
    // 3. Teleporta para o centro da base — o próximo snapshot já reflete a nova posição.
    // O movimento volta a ser liberado apenas quando o cliente enviar "liberarMovimento"
    // (após os 5 s do overlay), garantindo sincronia precisa entre cliente e servidor.
    socket.on("respawn", () => {
        const player = players.get(socket.id);
        if (!player) return;

        player.isDead = true;
        player.directionAngle = null;
        player.lastAction = null;
        player.pressedActions.clear();

        player.x = player.territoryX;
        player.y = player.territoryY;
    });

    // === LIBERAR MOVIMENTO ===
    // Enviado pelo cliente após o timer de 5 s do overlay de morte terminar.
    // Só então o servidor volta a processar movimentação para este jogador.
    socket.on("liberarMovimento", () => {
        const player = players.get(socket.id);
        if (!player) return;
        player.isDead = false;
    });

    // === TERRITÓRIO INIMIGO ===
    // Recebido quando o jogador passou pelo território de um inimigo e retornou à
    // sua base — aquelas células devem ser removidas do domínio do inimigo.
    //
    // Dados esperados: { alvoId: string, celulas: string[] }
    //   alvoId  — socket ID do inimigo que perderá território
    //   celulas — array de "lin,col" das células a serem removidas
    //
    // O servidor apenas encaminha a mensagem ao inimigo correto, sem processar
    // a lógica de território (que vive no cliente de cada jogador).
    socket.on("subtrairTerritorio", data => {
        // Valida estrutura básica dos dados recebidos
        if (!data || typeof data !== "object") return;

        const { alvoId, celulas } = data;

        // Valida tipos antes de encaminhar
        if (typeof alvoId !== "string") return;
        if (!Array.isArray(celulas)) return;

        // Limita o número de células para evitar abuso (máximo = total de células da grade)
        if (celulas.length > 2500) return;

        // Valida o formato de cada célula ("lin,col" com números inteiros)
        const formatoValido = /^\d{1,2},\d{1,2}$/;
        if (!celulas.every(c => typeof c === "string" && formatoValido.test(c))) return;

        // Busca o socket do inimigo pelo ID — ele pode ter desconectado
        const socketAlvo = io.sockets.sockets.get(alvoId);
        if (!socketAlvo) return;

        // Encaminha o array de células diretamente para o cliente do inimigo.
        // O cliente receberá o evento "territorioSubtraido" e limpará sua grade.
        socketAlvo.emit("territorioSubtraido", celulas);
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
