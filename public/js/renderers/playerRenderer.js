import { isPointNearBounds } from "./viewportCulling.js";

const blinkStates = new Map();

export function drawPlayerLayer(context, state, currentPlayer, currentPlayerId, gameConfig, viewportBounds) {
    pruneBlinkStates(state, currentPlayerId);

    for (const player of Object.values(state)) {
        if (player.id !== currentPlayerId && isPlayerVisible(player, gameConfig, viewportBounds)) {
            drawPlayer(context, player, gameConfig);
        }
    }

    drawPlayer(context, currentPlayer, gameConfig);
}

function isPlayerVisible(player, gameConfig, viewportBounds) {
    return isPointNearBounds(player, viewportBounds, gameConfig.world.playerSize);
}

function drawPlayer(context, player, gameConfig) {
    context.save();
    context.translate(player.x, player.y);

    context.save();
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
    drawPlayerName(context, player, gameConfig);
    context.restore();
}

function drawPlayerName(context, player, gameConfig) {
    const name = String(player.name || "").trim();

    if (!name) {
        return;
    }

    const maxWidth = 150;
    const fontSize = 20;
    const offsetY = -(gameConfig.world.playerSize / 2) - 18;
    const label = name.length > 18 ? `${name.slice(0, 17)}...` : name;

    context.save();
    context.font = `700 ${fontSize}px Play, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";

    const measuredWidth = Math.min(maxWidth, context.measureText(label).width + 18);
    const labelHeight = 28;
    const x = -measuredWidth / 2;
    const y = offsetY - labelHeight / 2;

    context.fillStyle = "rgba(5, 8, 14, 0.62)";
    roundRect(context, x, y, measuredWidth, labelHeight, 6);
    context.fill();

    context.lineWidth = 2;
    context.strokeStyle = "rgba(255, 255, 255, 0.18)";
    context.stroke();

    context.fillStyle = "#fff";
    context.fillText(label, 0, offsetY, maxWidth - 14);
    context.restore();
}

function roundRect(context, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);

    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.lineTo(x + width - safeRadius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
    context.lineTo(x + width, y + height - safeRadius);
    context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
    context.lineTo(x + safeRadius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
    context.lineTo(x, y + safeRadius);
    context.quadraticCurveTo(x, y, x + safeRadius, y);
    context.closePath();
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

    if (state.startedAt === null) {
        if (state.gapUntil !== null) {
            if (now < state.gapUntil) {
                return 1;
            }

            state.startedAt = now;
            state.gapUntil = null;
        } else if (now >= state.nextBlinkAt) {
            state.startedAt = now;
            state.remainingBlinks = shouldDoubleBlink(blinkConfig) ? 1 : 0;
        }
    }

    if (state.startedAt === null) {
        return 1;
    }

    const duration = getBlinkDuration(blinkConfig);
    const progress = Math.min(1, (now - state.startedAt) / duration);

    if (progress >= 1) {
        state.startedAt = null;
        if (state.remainingBlinks > 0) {
            state.remainingBlinks--;
            state.gapUntil = now + getDoubleBlinkGap(blinkConfig);
        } else {
            state.nextBlinkAt = now + getRandomBlinkInterval(blinkConfig);
        }
        return 1;
    }

    return Math.abs(progress * 2 - 1);
}

function getBlinkState(playerId, blinkConfig, now) {
    let state = blinkStates.get(playerId);

    if (!state) {
        state = {
            nextBlinkAt: now + getRandomBlinkInterval(blinkConfig),
            startedAt: null,
            gapUntil: null,
            remainingBlinks: 0
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

function shouldDoubleBlink(blinkConfig) {
    const chance = Number(blinkConfig.doubleBlinkChance);
    const safeChance = Number.isFinite(chance) ? Math.max(0, Math.min(1, chance)) : 0.1;

    return Math.random() < safeChance;
}

function getDoubleBlinkGap(blinkConfig) {
    const gap = Number(blinkConfig.doubleBlinkGapMs);

    return Number.isFinite(gap) ? Math.max(0, gap) : 90;
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
