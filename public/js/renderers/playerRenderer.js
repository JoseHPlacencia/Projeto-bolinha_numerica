const blinkStates = new Map();

export function drawPlayerLayer(context, state, currentPlayer, currentPlayerId, gameConfig) {
    pruneBlinkStates(state, currentPlayerId);

    for (const player of Object.values(state)) {
        if (player.id !== currentPlayerId) {
            drawPlayer(context, player, gameConfig);
        }
    }

    drawPlayer(context, currentPlayer, gameConfig);
}

function drawPlayer(context, player, gameConfig) {
    context.save();

    context.translate(player.x, player.y);
    context.rotate(player.angle);

    context.fillStyle = "rgba(0,0,0,.12)";
    context.fillRect(-30, -30, 70, 70);

    context.fillStyle = player.color;
    context.fillRect(-35, -35, 70, 70);

    context.lineWidth = 4;
    context.strokeStyle = "#000";
    context.strokeRect(-35, -35, 70, 70);

    drawEyes(context, player, gameConfig);

    context.restore();
}

function drawEyes(context, player, gameConfig) {
    const openness = getBlinkOpenness(player.id, gameConfig && gameConfig.player);

    drawEye(context, 18, -23, openness);
    drawEye(context, 18, 11, openness);
}

function drawEye(context, x, y, openness) {
    const eyeSize = 12;
    const pupilSize = 6;
    const eyeCenterX = x + eyeSize / 2;
    const visibleWidth = Math.max(2, eyeSize * openness);
    const visibleX = eyeCenterX - visibleWidth / 2;

    context.fillStyle = "#fff";
    context.fillRect(visibleX, y, visibleWidth, eyeSize);

    if (openness > 0.25) {
        const pupilWidth = Math.max(2, pupilSize * openness);
        const pupilX = x + 6;

        context.fillStyle = "#000";
        context.fillRect(pupilX, y + 3, pupilWidth, pupilSize);
        return;
    }

    context.fillStyle = "#000";
    context.fillRect(x + 6, y + 2, 2, eyeSize - 4);
}

function getBlinkOpenness(playerId, blinkConfig = {}) {
    const now = performance.now();
    const state = getBlinkState(playerId, blinkConfig, now);

    if (state.startedAt === null && now >= state.nextBlinkAt) {
        state.startedAt = now;
    }

    if (state.startedAt === null) {
        return 1;
    }

    const duration = getBlinkDuration(blinkConfig);
    const progress = Math.min(1, (now - state.startedAt) / duration);

    if (progress >= 1) {
        state.startedAt = null;
        state.nextBlinkAt = now + getRandomBlinkInterval(blinkConfig);
        return 1;
    }

    return Math.abs(progress * 2 - 1);
}

function getBlinkState(playerId, blinkConfig, now) {
    let state = blinkStates.get(playerId);

    if (!state) {
        state = {
            nextBlinkAt: now + getRandomBlinkInterval(blinkConfig),
            startedAt: null
        };
        blinkStates.set(playerId, state);
    }

    return state;
}

function getBlinkDuration(blinkConfig) {
    const duration = Number(blinkConfig.blinkDurationMs);

    return Number.isFinite(duration) ? Math.max(1, duration) : 140;
}

function getRandomBlinkInterval(blinkConfig) {
    const minInterval = getBlinkMinInterval(blinkConfig);
    const maxInterval = getBlinkMaxInterval(blinkConfig, minInterval);

    return minInterval + Math.random() * (maxInterval - minInterval);
}

function getBlinkMinInterval(blinkConfig) {
    const minInterval = Number(blinkConfig.blinkMinIntervalMs);

    return Number.isFinite(minInterval) ? Math.max(0, minInterval) : 2500;
}

function getBlinkMaxInterval(blinkConfig, minInterval) {
    const maxInterval = Number(blinkConfig.blinkMaxIntervalMs);

    return Number.isFinite(maxInterval) ? Math.max(minInterval, maxInterval) : 7000;
}

function pruneBlinkStates(players, currentPlayerId) {
    const visiblePlayerIds = new Set(Object.keys(players || {}));

    if (currentPlayerId) {
        visiblePlayerIds.add(currentPlayerId);
    }

    for (const playerId of blinkStates.keys()) {
        if (!visiblePlayerIds.has(playerId)) {
            blinkStates.delete(playerId);
        }
    }
}
