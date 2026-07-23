const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const {
    deletePlayerTerritory,
    initializePlayerTerritory
} = require("../state/territories");
const { distanceBetween } = require("../utils/math");
const {
    createBotUpdateDiagnostics,
    createEmptyBotDiagnostics,
    getMaxBotDecisionsPerTick,
    getSlowestBotPhase,
    measureBotPhase
} = require("./botDiagnostics");
const { BOT_ID_PREFIX, isBotPlayer } = require("./botIdentity");
const { applyDecisionNoise } = require("./botNavigation");
const { createBotRouteSafety } = require("./botRouteSafety");
const {
    chooseBotTarget,
    createBotDecisionContext,
    getReturnTarget,
    isReturnTarget
} = require("./botTargeting");

const { chooseSelfTrailSafeAngle } = createBotRouteSafety({ getReturnTarget });

/**
 * Coordinates bot lifecycle and distributes decisions across server ticks.
 *
 * Target selection and route safety are independent policies. This manager owns
 * only their shared cycle/tick contexts and preserves the public room API.
 */
function createBotManager({
    roomCode,
    players,
    territories,
    numberSystem,
    botCount = null,
    botDifficulty = null,
    runtimeConfig = null,
    resolveBotCount = null,
    onBotRemoved = null,
    onPopulationChanged = null
}) {
    const state = {
        botCount,
        botDifficulty,
        botIds: new Set(),
        decisionContext: null,
        decisionCycle: 0,
        lastDecisionAt: Number.NEGATIVE_INFINITY,
        nextBotNumber: 1,
        pendingDecisionIds: [],
        diagnostics: createEmptyBotDiagnostics()
    };

    return {
        ensureBots,
        getDiagnostics,
        releaseSlotForHuman,
        update
    };

    function ensureBots() {
        pruneMissingBotIds(state, players);

        if (!config.bots.enabled) {
            return;
        }

        const targetBotCount = resolveActiveBotTarget(state, resolveBotCount);
        let populationChanged = false;

        while (state.botIds.size > targetBotCount) {
            const botId = [...state.botIds].pop();

            if (!removeManagedBot(state, players, territories, botId, onBotRemoved)) {
                break;
            }
            populationChanged = true;
        }

        while (state.botIds.size < targetBotCount) {
            const bot = createBot(roomCode, players, territories, state.nextBotNumber++, state.botDifficulty, runtimeConfig);

            if (!bot) {
                break;
            }

            state.botIds.add(bot.id);
            populationChanged = true;
        }

        if (populationChanged && typeof onPopulationChanged === "function") {
            onPopulationChanged();
        }
    }

    function releaseSlotForHuman() {
        pruneMissingBotIds(state, players);
        const botId = [...state.botIds].pop();

        if (!removeManagedBot(state, players, territories, botId, onBotRemoved)) {
            return false;
        }

        if (typeof onPopulationChanged === "function") {
            onPopulationChanged();
        }
        return true;
    }

    function getDiagnostics() {
        return state.diagnostics;
    }

    function update(nowMs) {
        const diagnostics = createBotUpdateDiagnostics(state);

        measureBotPhase(diagnostics, "ensureBots", ensureBots);
        state.pendingDecisionIds = state.pendingDecisionIds.filter(botId => state.botIds.has(botId));

        if (state.pendingDecisionIds.length === 0 && nowMs - state.lastDecisionAt >= config.bots.decisionIntervalMs) {
            state.lastDecisionAt = nowMs;
            // Reverse once so pop() preserves insertion order without Array.shift()'s O(B) reindexing.
            state.pendingDecisionIds = [...state.botIds].reverse();
            state.decisionCycle++;
            diagnostics.cycle = state.decisionCycle;
            state.decisionContext = measureBotPhase(
                diagnostics,
                "correctNumbers",
                () => createBotDecisionContext(numberSystem, players)
            );
        }

        if (state.pendingDecisionIds.length > 0 && !state.decisionContext) {
            state.decisionContext = measureBotPhase(
                diagnostics,
                "correctNumbers",
                () => createBotDecisionContext(numberSystem, players)
            );
        }

        diagnostics.pendingBefore = state.pendingDecisionIds.length;

        measureBotPhase(diagnostics, "decisions", () => {
            const tickContext = createBotDecisionTickContext(
                state.decisionContext,
                diagnostics,
                nowMs
            );
            const maxDecisions = getMaxBotDecisionsPerTick();
            let processed = 0;

            while (processed < maxDecisions && state.pendingDecisionIds.length > 0) {
                const botId = state.pendingDecisionIds.pop();
                const bot = players.get(botId);

                if (!bot) {
                    continue;
                }

                updateBotDecision(bot, players, territories, numberSystem, tickContext);
                processed++;
            }

            diagnostics.decisionsProcessed = processed;
        });

        if (state.pendingDecisionIds.length === 0) {
            state.decisionContext = null;
        }

        diagnostics.pendingAfter = state.pendingDecisionIds.length;
        diagnostics.slowestPhase = getSlowestBotPhase(diagnostics.phases);
        state.diagnostics = diagnostics;

        return diagnostics;
    }
}

function createBotDecisionTickContext(decisionContext, diagnostics, nowMs = Date.now()) {
    const correctNumbers = decisionContext && Array.isArray(decisionContext.correctNumbers)
        ? decisionContext.correctNumbers
        : [];

    return {
        coordinatedCorrectNumbersCache: new Map(),
        correctNumbers,
        diagnostics,
        numberContestIndex: decisionContext && decisionContext.numberContestIndex,
        nowMs,
        returnTargetCache: new Map(),
        selfTrailSegmentCache: new Map(),
        trailPointCache: new Map(),
        trailTargetIndexCache: new Map()
    };
}

function createBot(roomCode, players, territories, botNumber, botDifficulty = null, runtimeConfig = null) {
    const botConfig = config.bots;
    const botNames = getBotNames(botConfig);
    const nameIndex = (botNumber - 1) % botNames.length;
    const colorIndex = (botNumber - 1) % botConfig.colors.length;
    const bot = createPlayer(players, `${BOT_ID_PREFIX}${roomCode}:${botNumber}`, territories, {
        color: botConfig.colors[colorIndex],
        difficulty: botDifficulty || botConfig.difficulty,
        isBot: true,
        maxLives: runtimeConfig && runtimeConfig.gameMode && runtimeConfig.gameMode.catch
            ? runtimeConfig.gameMode.catch.roomLives
            : null,
        name: botNames[nameIndex],
        runtimeConfig
    });

    if (!bot) {
        return null;
    }

    bot.botAi = {
        expansionPlan: null,
        orbitDirection: Math.random() < 0.5 ? -1 : 1,
        orbitPhase: Math.random() * Math.PI * 2,
        selfTrailEscapeAngle: null,
        selfTrailEscapeUntilMs: 0
    };
    initializePlayerTerritory(territories, bot, runtimeConfig || config);

    return bot;
}

function updateBotDecision(bot, players, territories, numberSystem, context = null) {
    const diagnostics = context && context.diagnostics;
    const target = measureBotPhase(diagnostics, "targeting", () => (
        chooseBotTarget(bot, players, territories, numberSystem, context)
    ));

    if (!target) {
        bot.clearDirectionAngle();
        return;
    }

    const targetAngle = Math.atan2(target.y - bot.y, target.x - bot.x);
    const targetDistance = distanceBetween(bot.x, bot.y, target.x, target.y);
    const decision = measureBotPhase(diagnostics, "selfTrailSafety", () => chooseSelfTrailSafeAngle(bot, targetAngle, {
        allowReverse: isReturnTarget(bot, target),
        territories,
        targetDistance
    }, context));
    const angle = applyDecisionNoise(decision.angle, {
        avoidingSelfTrail: decision.avoidingSelfTrail,
        suppressNoise: decision.suppressNoise
    });

    bot.setDirectionAngle(angle, "bot");
}

function pruneMissingBotIds(state, players) {
    for (const botId of state.botIds) {
        if (!players.has(botId)) {
            state.botIds.delete(botId);
        }
    }
}

function resolveActiveBotTarget(state, resolveBotCount) {
    const configuredTarget = getTargetBotCount(state);

    if (typeof resolveBotCount !== "function") {
        return configuredTarget;
    }

    const resolvedTarget = Number(resolveBotCount(configuredTarget));

    return Number.isInteger(resolvedTarget) && resolvedTarget >= 0
        ? Math.min(configuredTarget, resolvedTarget)
        : configuredTarget;
}

function removeManagedBot(state, players, territories, botId, onBotRemoved) {
    if (!botId || !state.botIds.has(botId)) {
        return false;
    }

    state.botIds.delete(botId);
    state.pendingDecisionIds = state.pendingDecisionIds.filter(id => id !== botId);

    if (!players.has(botId)) {
        return false;
    }

    for (const player of players.values()) {
        player.clearCatchEliminationTarget?.(botId);
    }

    players.delete(botId);
    deletePlayerTerritory(territories, botId);

    if (typeof onBotRemoved === "function") {
        onBotRemoved(botId);
    }
    return true;
}

function getTargetBotCount(state = {}) {
    const count = state.botCount === null || state.botCount === undefined
        ? Number(config.bots.count)
        : Number(state.botCount);

    return Number.isInteger(count) && count > 0 ? count : 0;
}

function getBotNames(botConfig) {
    const names = Array.isArray(botConfig.reservedNames) && botConfig.reservedNames.length > 0
        ? botConfig.reservedNames
        : botConfig.names;

    return Array.isArray(names) && names.length > 0 ? names : ["Atlas"];
}

function getHumanPlayerCount(players) {
    let count = 0;

    for (const player of players.values()) {
        if (!isBotPlayer(player)) {
            count++;
        }
    }

    return count;
}

function getBotPlayerCount(players) {
    let count = 0;

    for (const player of players.values()) {
        if (isBotPlayer(player)) {
            count++;
        }
    }

    return count;
}

module.exports = {
    createBotManager,
    getBotPlayerCount,
    getTargetBotCount,
    getHumanPlayerCount,
    isBotPlayer
};
