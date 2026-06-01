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
    // Enviado quando o jogador fecha um loop que captura território inimigo.
    // O polígono da área capturada é repassado ao inimigo para que ele
    // subtraia a interseção do próprio polígono de território.
    //
    // Dados esperados: { alvoId: string, poligono: [{x, y}, ...] }
    //   alvoId   — socket ID do inimigo que perderá território
    //   poligono — polígono da área capturada (coordenadas do mundo)
    socket.on("subtrairTerritorio", data => {
        if (!data || typeof data !== "object") return;

        const { alvoId, poligono } = data;

        if (typeof alvoId !== "string") return;
        if (!Array.isArray(poligono) || poligono.length < 3) return;
        if (poligono.length > 500) return; // limite de segurança

        // Valida que todos os vértices são objetos com x/y numéricos finitos
        const poligonoValido = poligono.every(
            v => v && typeof v.x === "number" && typeof v.y === "number" &&
                 Number.isFinite(v.x) && Number.isFinite(v.y)
        );
        if (!poligonoValido) return;

        const socketAlvo = io.sockets.sockets.get(alvoId);
        if (!socketAlvo) return;

        // Encaminha o polígono para o cliente do inimigo
        socketAlvo.emit("territorioSubtraido", poligono);
    });

    // === SYNC DE RASTRO ===
    // O cliente envia seu rastro ativo periodicamente para que o servidor
    // possa transmiti-lo nos snapshots — outros clientes usam isso para
    // renderizar rastros inimigos e detectar interseções.
    socket.on("syncTrail", trailData => {
        if (!Array.isArray(trailData)) return;
        if (trailData.length > 200) return;

        const player = players.get(socket.id);
        if (!player) return;

        const valid = trailData.every(
            p => p && typeof p.x === "number" && typeof p.y === "number" &&
                 Number.isFinite(p.x) && Number.isFinite(p.y)
        );
        if (!valid) return;

        player.trail = trailData;
    });

    // === INTERCEPTAÇÃO DE RASTRO ===
    // Enviado quando o dono do rastro detecta que um inimigo passou por cima
    // do seu rastro ativo. O dono do rastro (vítima) morre.
    //
    // Dados esperados: { victimId: string }
    //   victimId — socket ID do dono do rastro (que deve morrer)
    socket.on("reportTrailKill", data => {
        if (!data || typeof data.victimId !== "string") return;

        const victim = players.get(data.victimId);
        if (!victim || victim.isDead) return;

        // Debounce: ignora se a vítima já morreu recentemente
        const now = Date.now();
        if (now - victim._trailKilledAt < 1500) return;
        victim._trailKilledAt = now;

        // Mata o dono do rastro: congela, teleporta, limpa trail
        victim.isDead = true;
        victim.directionAngle = null;
        victim.lastAction = null;
        victim.pressedActions.clear();
        victim.x = victim.territoryX;
        victim.y = victim.territoryY;
        victim.trail = [];

        // Notifica o cliente da vítima para acionar o overlay de morte
        const victimSocket = io.sockets.sockets.get(data.victimId);
        if (victimSocket) {
            victimSocket.emit("trailIntercepted");
        }
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
