const config = require("../config/gameConfig");
const { updatePlayers } = require("../systems/movementSystem");
const { updateTrails } = require("../systems/trailSystem");
const { handleNumberCollected } = require("../systems/catchModeSystem");
const { getHighResolutionTime } = require("../utils/time");

function startGameLoop(players, territories, io, roomCode, numberSystem, botManager = null, runtimeConfig = null, diagnostics = null) {
    const intervalMs = 1000 / config.loop.tickRate;
    let previousTime = getHighResolutionTime();
    let tick = 0;

    initializeGameLoopDiagnostics(diagnostics, intervalMs);

    return setInterval(() => {
        const now = getHighResolutionTime();
        const tickStartedAt = now;
        const tickIntervalMs = now - previousTime;
        const phaseDurations = {};
        const deltaTime = Math.min((now - previousTime) / 1000, config.loop.maxDeltaTime);
        let botDiagnostics = null;
        previousTime = now;
        tick++;

        measurePhase(phaseDurations, "bots", () => {
            if (botManager) {
                botDiagnostics = botManager.update(Date.now());
            }
        });

        measurePhase(phaseDurations, "movement", () => {
            updatePlayers(players, deltaTime, runtimeConfig);
        });

        measurePhase(phaseDurations, "trails", () => {
            updateTrails(players, territories, { io, roomCode });
        });

        const result = measurePhase(phaseDurations, "numbers", () => (
            numberSystem
                ? numberSystem.update(Date.now())
                : { collisions: [], themeChanged: false }
        ));
        const collisions = Array.isArray(result && result.collisions) ? result.collisions : [];

        measurePhase(phaseDurations, "numberEvents", () => {
            if (collisions.length <= 0 || !io) {
                return;
            }

            for (const col of collisions) {
                measurePhase(phaseDurations, "numberCollected", () => {
                    handleNumberCollected(players, territories, col, { io, roomCode });
                }, true);

                const socket = io.sockets.sockets.get(col.playerId);
                if (socket) {
                    const player = players.get(col.playerId);

                    socket.emit("numberCollected", {
                        display: col.display,
                        value: col.value,
                        sets: col.sets,
                        belongsToTheme: col.belongsToTheme,
                        catchBalance: player ? player.catchBalance : 0,
                        eliminations: player ? player.eliminations : 0,
                        lives: player ? player.lives : 0,
                        maxLives: player ? player.maxLives : 0
                    });
                }
            }
        });

        measurePhase(phaseDurations, "themeEvents", () => {
            if (result && result.themeChanged && io && roomCode) {
                io.to(roomCode).emit("themeChanged");
            }
        });

        updateGameLoopDiagnostics(diagnostics, {
            collisionCount: collisions.length,
            botDiagnostics,
            deltaTimeMs: deltaTime * 1000,
            expectedIntervalMs: intervalMs,
            numberCount: getNumberCount(numberSystem),
            phaseDurations,
            playerCount: players.size,
            roomCode,
            territoryCount: territories.size,
            themeChanged: Boolean(result && result.themeChanged),
            tick,
            tickDurationMs: getHighResolutionTime() - tickStartedAt,
            tickDriftMs: tickIntervalMs - intervalMs,
            tickIntervalMs
        });
    }, intervalMs);
}

function initializeGameLoopDiagnostics(diagnostics, expectedIntervalMs) {
    if (!diagnostics) {
        return;
    }

    diagnostics.schema = 1;
    diagnostics.expectedIntervalMs = expectedIntervalMs;
    diagnostics.tick = 0;
    diagnostics.tickIntervalMs = null;
    diagnostics.tickDriftMs = null;
    diagnostics.tickDurationMs = null;
    diagnostics.phases = {};
    diagnostics.slowestPhase = null;
}

function updateGameLoopDiagnostics(diagnostics, sample) {
    if (!diagnostics) {
        return;
    }

    diagnostics.schema = 1;
    diagnostics.updatedAt = Date.now();
    diagnostics.roomCode = sample.roomCode;
    diagnostics.tick = sample.tick;
    diagnostics.expectedIntervalMs = sample.expectedIntervalMs;
    diagnostics.tickIntervalMs = sample.tickIntervalMs;
    diagnostics.tickDriftMs = sample.tickDriftMs;
    diagnostics.tickDurationMs = sample.tickDurationMs;
    diagnostics.deltaTimeMs = sample.deltaTimeMs;
    diagnostics.playerCount = sample.playerCount;
    diagnostics.territoryCount = sample.territoryCount;
    diagnostics.numberCount = sample.numberCount;
    diagnostics.collisionCount = sample.collisionCount;
    diagnostics.bot = normalizeBotDiagnostics(sample.botDiagnostics);
    diagnostics.themeChanged = sample.themeChanged;
    diagnostics.phases = roundPhaseDurations(sample.phaseDurations);
    diagnostics.slowestPhase = getSlowestPhase(diagnostics.phases);
}

function normalizeBotDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== "object") {
        return null;
    }

    return {
        cycle: finiteOrNull(diagnostics.cycle),
        decisionsProcessed: finiteOrNull(diagnostics.decisionsProcessed),
        pendingAfter: finiteOrNull(diagnostics.pendingAfter),
        pendingBefore: finiteOrNull(diagnostics.pendingBefore),
        phases: normalizePhaseDurations(diagnostics.phases),
        slowestPhase: normalizeSlowestPhase(diagnostics.slowestPhase)
    };
}

function normalizePhaseDurations(phases) {
    const normalized = {};

    for (const [name, durationMs] of Object.entries(phases || {})) {
        normalized[name] = finiteOrNull(durationMs);
    }

    return normalized;
}

function normalizeSlowestPhase(slowestPhase) {
    if (!slowestPhase || typeof slowestPhase !== "object") {
        return null;
    }

    return {
        name: typeof slowestPhase.name === "string" ? slowestPhase.name : null,
        durationMs: finiteOrNull(slowestPhase.durationMs)
    };
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function measurePhase(phaseDurations, name, callback, accumulate = false) {
    const startedAt = getHighResolutionTime();

    try {
        return callback();
    } finally {
        const durationMs = getHighResolutionTime() - startedAt;
        phaseDurations[name] = accumulate
            ? (phaseDurations[name] || 0) + durationMs
            : durationMs;
    }
}

function roundPhaseDurations(phaseDurations) {
    const rounded = {};

    for (const [name, durationMs] of Object.entries(phaseDurations || {})) {
        rounded[name] = roundToMilliseconds(durationMs);
    }

    return rounded;
}

function getSlowestPhase(phaseDurations) {
    let slowest = null;

    for (const [name, durationMs] of Object.entries(phaseDurations || {})) {
        if (!Number.isFinite(durationMs)) {
            continue;
        }

        if (!slowest || durationMs > slowest.durationMs) {
            slowest = {
                name,
                durationMs
            };
        }
    }

    return slowest;
}

function getNumberCount(numberSystem) {
    if (!numberSystem || typeof numberSystem.getNumbersMap !== "function") {
        return null;
    }

    const numbers = numberSystem.getNumbersMap();

    return numbers && typeof numbers.size === "number" ? numbers.size : null;
}

function roundToMilliseconds(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

module.exports = { startGameLoop };
