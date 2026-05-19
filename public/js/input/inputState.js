import { getAngleDelta, normalizeAngle } from "./directionalInput.js";

const DIRECTION_ANGLE_EPSILON = 0.025;
const DIRECTION_SEND_INTERVAL_MS = 33;
const DIRECTION_SOURCE_PRIORITY = Object.freeze({
    mouse: 0,
    "gamepad-left": 3,
    "gamepad-right": 3,
    pointer: 2,
    "gamepad-dpad": 3,
    keyboard: 3
});

export function createInputState(socket) {
    const activeDirections = new Map();
    let activeDirectionSource = null;
    let lastDirectionSentAt = 0;
    let lastSentDirection = null;

    // === BLOQUEIO DE INPUT DURANTE A MORTE ===
    // Quando habilitado = false, setDirection não envia nada ao servidor.
    // O jogador para de se mover no servidor assim que todas as direções ativas
    // forem limpadas via clearDirection (chamado por desabilitar()).
    let habilitado = true;

    return {
        clearDirection,
        setDirection,
        desabilitar,
        habilitar
    };

    // Desabilita o envio de input ao servidor e limpa todas as direções ativas.
    // Chamada quando o jogador morre — garante que o boneco pare imediatamente.
    function desabilitar() {
        habilitado = false;

        // Limpa cada fonte ativa para enviar "inputDirectionEnd" ao servidor
        // e parar o movimento do jogador. Array.from evita mutação durante iteração.
        for (const source of Array.from(activeDirections.keys())) {
            clearDirection(source, { force: true });
        }
    }

    // Reabilita o envio de input. Chamada quando o jogador reaparece.
    function habilitar() {
        habilitado = true;
    }

    function setDirection(source, angle, options = {}) {
        // Bloqueia novos inputs enquanto o jogador está morto
        if (!habilitado) return;

        if (!Number.isFinite(angle)) {
            return;
        }

        const normalizedAngle = normalizeAngle(angle);
        activeDirections.set(source, normalizedAngle);
        clearSupersededMouseDirection(source);

        if (!canSourceTakePriority(source)) {
            return;
        }

        const sourceChanged = activeDirectionSource !== source;
        activeDirectionSource = source;
        sendDirection(normalizedAngle, sourceChanged || options.force);
    }

    function clearDirection(source, options = {}) {
        if (!activeDirections.has(source) && !options.force) {
            return;
        }

        activeDirections.delete(source);

        if (activeDirectionSource !== source && activeDirectionSource !== null) {
            return;
        }

        const nextDirection = getHighestPriorityDirectionInput();

        if (nextDirection) {
            activeDirectionSource = nextDirection.source;
            sendDirection(nextDirection.angle, true);
            return;
        }

        activeDirectionSource = null;
        lastSentDirection = null;
        socket.emit("inputDirectionEnd");
    }

    function sendDirection(angle, force = false) {
        // Também bloqueia o envio enquanto desabilitado (defesa em profundidade)
        if (!habilitado) return;

        const now = performance.now();
        const changedEnough = lastSentDirection === null
            || Math.abs(getAngleDelta(lastSentDirection, angle)) >= DIRECTION_ANGLE_EPSILON;
        const canSend = now - lastDirectionSentAt >= DIRECTION_SEND_INTERVAL_MS;

        if (!force && (!changedEnough || !canSend)) {
            return;
        }

        lastDirectionSentAt = now;
        lastSentDirection = angle;
        socket.emit("inputDirection", angle);
    }

    function canSourceTakePriority(source) {
        return activeDirectionSource === null
            || getSourcePriority(source) >= getSourcePriority(activeDirectionSource);
    }

    function clearSupersededMouseDirection(source) {
        if (
            source !== "mouse"
            && activeDirectionSource === "mouse"
            && getSourcePriority(source) > getSourcePriority("mouse")
        ) {
            activeDirections.delete("mouse");
        }
    }

    function getHighestPriorityDirectionInput() {
        let highestPriorityDirection = null;

        for (const [source, angle] of activeDirections.entries()) {
            if (
                !highestPriorityDirection
                || getSourcePriority(source) > getSourcePriority(highestPriorityDirection.source)
            ) {
                highestPriorityDirection = { source, angle };
            }
        }

        return highestPriorityDirection;
    }
}

function getSourcePriority(source) {
    return DIRECTION_SOURCE_PRIORITY[source] || 0;
}
