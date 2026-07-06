const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const {
    getPlayerTerritoryPolygon,
    initializePlayerTerritory
} = require("../state/territories");
const {
    findClosestPolygonBoundaryContact,
    isPointInPolygon
} = require("../utils/geometry");
const { clamp, distanceBetween, lerpAngle } = require("../utils/math");
const { getHighResolutionTime } = require("../utils/time");

const BOT_ID_PREFIX = "bot:";
const geometryEpsilon = 1e-7;

function createBotManager({ roomCode, players, territories, numberSystem, botCount = null, botDifficulty = null, runtimeConfig = null }) {
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
        update
    };

    function ensureBots() {
        pruneMissingBotIds(state, players);

        if (!config.bots.enabled) {
            return;
        }

        while (state.botIds.size < getTargetBotCount(state)) {
            const bot = createBot(roomCode, players, territories, state.nextBotNumber++, state.botDifficulty, runtimeConfig);

            if (!bot) {
                break;
            }

            state.botIds.add(bot.id);
        }
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
            state.pendingDecisionIds = [...state.botIds];
            state.decisionCycle++;
            diagnostics.cycle = state.decisionCycle;
            state.decisionContext = measureBotPhase(diagnostics, "correctNumbers", () => createBotDecisionContext(numberSystem));
        }

        if (state.pendingDecisionIds.length > 0 && !state.decisionContext) {
            state.decisionContext = measureBotPhase(diagnostics, "correctNumbers", () => createBotDecisionContext(numberSystem));
        }

        diagnostics.pendingBefore = state.pendingDecisionIds.length;

        measureBotPhase(diagnostics, "decisions", () => {
            const tickContext = createBotDecisionTickContext(state.decisionContext, diagnostics, nowMs);
            const maxDecisions = getMaxBotDecisionsPerTick();
            let processed = 0;

            while (processed < maxDecisions && state.pendingDecisionIds.length > 0) {
                const botId = state.pendingDecisionIds.shift();
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

function createEmptyBotDiagnostics() {
    return {
        cycle: 0,
        decisionsProcessed: 0,
        pendingAfter: 0,
        pendingBefore: 0,
        phases: {},
        selfTrailSafety: createEmptySelfTrailSafetyDiagnostics(),
        slowestPhase: null
    };
}

function createBotUpdateDiagnostics(state) {
    return {
        cycle: state.decisionCycle,
        decisionsProcessed: 0,
        pendingAfter: 0,
        pendingBefore: 0,
        phases: {},
        selfTrailSafety: createEmptySelfTrailSafetyDiagnostics(),
        slowestPhase: null
    };
}

function createEmptySelfTrailSafetyDiagnostics() {
    return {
        budgetHitCount: 0,
        bypassCount: 0,
        candidateCount: 0,
        decisionCount: 0,
        evaluatedCandidateCount: 0,
        evaluatedLocalCandidateCount: 0,
        filteredTrailPointCount: 0,
        filteredTrailSegmentCount: 0,
        localCandidateCount: 0,
        maxBudgetElapsedMs: 0,
        pathEvaluationCount: 0,
        pointDistanceCheckCount: 0,
        sampleCount: 0,
        segmentCrossCheckCount: 0,
        trailPointCount: 0,
        trailSegmentCount: 0,
        unsafeTargetCount: 0
    };
}

function createBotDecisionContext(numberSystem) {
    return {
        correctNumbers: getCorrectNumbers(numberSystem)
    };
}

function createBotDecisionTickContext(decisionContext, diagnostics, nowMs = Date.now()) {
    return {
        correctNumbers: decisionContext && Array.isArray(decisionContext.correctNumbers)
            ? decisionContext.correctNumbers
            : [],
        diagnostics,
        nowMs,
        selfTrailSegmentCache: new Map(),
        trailPointCache: new Map()
    };
}

function measureBotPhase(diagnostics, name, callback) {
    const startedAt = getHighResolutionTime();

    try {
        return callback();
    } finally {
        const durationMs = getHighResolutionTime() - startedAt;

        if (diagnostics && diagnostics.phases) {
            diagnostics.phases[name] = (diagnostics.phases[name] || 0) + durationMs;
        }
    }
}

function getSlowestBotPhase(phases) {
    let slowestPhase = null;

    for (const [name, durationMs] of Object.entries(phases || {})) {
        if (!Number.isFinite(durationMs)) {
            continue;
        }

        if (!slowestPhase || durationMs > slowestPhase.durationMs) {
            slowestPhase = {
                name,
                durationMs: roundToMilliseconds(durationMs)
            };
        }
    }

    return slowestPhase;
}

function getMaxBotDecisionsPerTick() {
    const value = Number(config.bots.maxDecisionsPerTick);

    return Number.isInteger(value) && value > 0 ? value : 2;
}

function getBotSelfTrailSafetyBudgetMs() {
    const value = Number(config.bots.selfTrailSafetyBudgetMs);

    return Number.isFinite(value) && value > 0 ? value : 4;
}

function getBotSelfTrailSafetyMaxCandidates() {
    const value = Number(config.bots.selfTrailSafetyMaxCandidates);

    return Number.isInteger(value) && value > 0 ? value : 24;
}

function getBotSelfTrailSafetyTrapMaxCandidates() {
    const value = Number(config.bots.selfTrailSafetyTrapMaxCandidates);

    return Number.isInteger(value) && value > 0 ? value : Math.max(36, getBotSelfTrailSafetyMaxCandidates());
}

function getBotSelfTrailSafetyMaxLocalCandidates() {
    const value = Number(config.bots.selfTrailSafetyMaxLocalCandidates);

    return Number.isInteger(value) && value > 0 ? value : 8;
}

function getBotSelfTrailLookaheadMaxDistance() {
    const value = Number(config.bots.selfTrailLookaheadMaxDistance);

    return Number.isFinite(value) && value > 0 ? value : config.world.playerSize * 12;
}

function getBotSelfTrailTrapLookaheadMaxDistance() {
    const value = Number(config.bots.selfTrailTrapLookaheadMaxDistance);

    return Number.isFinite(value) && value > 0
        ? value
        : Math.max(getBotSelfTrailLookaheadMaxDistance(), config.world.playerSize * 20);
}

function getBotSelfTrailEscapeMemoryMs() {
    const value = Number(config.bots.selfTrailEscapeMemoryMs);

    return Number.isFinite(value) && value > 0 ? value : 650;
}

function getSelfTrailSafetyDiagnostics(context) {
    const diagnostics = context && context.diagnostics;

    if (!diagnostics) {
        return null;
    }

    if (!diagnostics.selfTrailSafety) {
        diagnostics.selfTrailSafety = createEmptySelfTrailSafetyDiagnostics();
    }

    return diagnostics.selfTrailSafety;
}

function addSelfTrailSafetyDiagnosticValue(diagnostics, name, value) {
    if (!diagnostics || !Number.isFinite(value) || value <= 0) {
        return;
    }

    diagnostics[name] = (diagnostics[name] || 0) + value;
}

function recordSelfTrailSafetyBudgetElapsed(diagnostics, elapsedMs) {
    if (!diagnostics || !Number.isFinite(elapsedMs)) {
        return;
    }

    diagnostics.maxBudgetElapsedMs = Math.max(
        diagnostics.maxBudgetElapsedMs || 0,
        roundToMilliseconds(elapsedMs)
    );
}

function createSelfTrailSafetyBudget(diagnostics) {
    return {
        budgetHit: false,
        budgetMs: getBotSelfTrailSafetyBudgetMs(),
        diagnostics,
        startedAt: getHighResolutionTime()
    };
}

function hasSelfTrailSafetyBudgetRemaining(budget) {
    if (!budget || !Number.isFinite(budget.budgetMs) || budget.budgetMs <= 0) {
        return true;
    }

    const elapsedMs = getHighResolutionTime() - budget.startedAt;
    recordSelfTrailSafetyBudgetElapsed(budget.diagnostics, elapsedMs);

    if (elapsedMs <= budget.budgetMs) {
        return true;
    }

    markSelfTrailSafetyBudgetHit(budget);
    return false;
}

function finishSelfTrailSafetyBudget(budget) {
    if (!budget || !Number.isFinite(budget.startedAt)) {
        return;
    }

    const elapsedMs = getHighResolutionTime() - budget.startedAt;
    recordSelfTrailSafetyBudgetElapsed(budget.diagnostics, elapsedMs);

    if (Number.isFinite(budget.budgetMs) && elapsedMs > budget.budgetMs) {
        markSelfTrailSafetyBudgetHit(budget);
    }
}

function markSelfTrailSafetyBudgetHit(budget) {
    if (!budget || budget.budgetHit) {
        return;
    }

    budget.budgetHit = true;
    addSelfTrailSafetyDiagnosticValue(budget.diagnostics, "budgetHitCount", 1);
}

function roundToMilliseconds(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
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

function chooseBotTarget(bot, players, territories, numberSystem, context = null) {
    const diagnostics = context && context.diagnostics;
    const correctNumbers = context && Array.isArray(context.correctNumbers)
        ? context.correctNumbers
        : getCorrectNumbers(numberSystem);
    const nearestCorrect = findNearestPoint(bot, correctNumbers);
    const incomingMarkResponse = chooseIncomingMarkResponse(bot, players, territories, correctNumbers, context);

    if (incomingMarkResponse) {
        return incomingMarkResponse;
    }

    const pendingCaptureTarget = choosePendingCaptureConfirmationTarget(bot, territories);

    if (pendingCaptureTarget) {
        return pendingCaptureTarget;
    }

    const pendingTarget = choosePendingEliminationTarget(bot, players, territories, correctNumbers, context);

    if (pendingTarget) {
        return pendingTarget;
    }

    const threat = measureBotPhase(diagnostics, "threat", () => (
        evaluateThreat(bot, players, territories, correctNumbers, context)
    ));

    if (bot.catchBalance <= 0) {
        return nearestCorrect || getWanderTarget(bot);
    }

    if (threat.isThreatened) {
        return getReturnTarget(bot, territories);
    }

    const balanceCaptureTarget = measureBotPhase(diagnostics, "balanceCapture", () => (
        chooseBalanceCaptureTrailTarget(bot, players, territories, threat, context)
    ));

    if (balanceCaptureTarget && Math.random() >= config.bots.mistakeChance) {
        return balanceCaptureTarget;
    }

    const huntTarget = measureBotPhase(diagnostics, "hunt", () => (
        chooseHuntTarget(bot, players, territories, correctNumbers, threat, context)
    ));

    if (huntTarget && Math.random() >= config.bots.mistakeChance) {
        return huntTarget;
    }

    if (threat.canExpand) {
        return getExpansionTarget(bot, players, territories, threat, context);
    }

    return getReturnTarget(bot, territories);
}

function choosePendingEliminationTarget(bot, players, territories, correctNumbers, context = null) {
    if (!bot.pendingCatchEliminationTargets || bot.pendingCatchEliminationTargets.size === 0) {
        return null;
    }

    const number = findNearestPoint(bot, correctNumbers);

    if (!number) {
        return getReturnTarget(bot, territories);
    }

    const confirmTime = estimateTravelTime(bot, number);

    return canConfirmPendingEliminationsBeforeCounterattack(bot, players, territories, confirmTime, context)
        ? number
        : getReturnTarget(bot, territories);
}

function choosePendingCaptureConfirmationTarget(bot, territories) {
    if (bot.catchBalance <= 0
        || !bot.pendingCatchEliminationTargets
        || bot.pendingCatchEliminationTargets.size === 0
        || !hasAnyTrail(bot)) {
        return null;
    }

    return getReturnTarget(bot, territories);
}

function canConfirmPendingEliminationsBeforeCounterattack(bot, players, territories, confirmTime, context = null) {
    const requiredMargin = getMarkedCounterattackMarginSec();

    for (const targetId of bot.pendingCatchEliminationTargets || []) {
        const target = players.get(targetId);

        if (!target) {
            continue;
        }

        const targetReturnTime = estimateTravelTime(target, getReturnTarget(target, territories));

        if (confirmTime + requiredMargin >= targetReturnTime) {
            return false;
        }

        const counterattackTime = estimateOutgoingCounterattackTime(bot, target, targetReturnTime, context);

        if (Number.isFinite(counterattackTime) && confirmTime + requiredMargin >= counterattackTime) {
            return false;
        }
    }

    return true;
}

function estimateOutgoingCounterattackTime(marker, target, targetReturnTime, context = null) {
    if (!marker
        || !target
        || typeof marker.getCatchEliminationMarkedAt !== "function") {
        return Infinity;
    }

    const markedAt = marker.getCatchEliminationMarkedAt(target.id);

    if (!Number.isFinite(markedAt)) {
        return Infinity;
    }

    const nowMs = Number.isFinite(context && context.nowMs) ? context.nowMs : Date.now();
    const remainingGraceSec = Math.max(0, getCounterattackGraceMs(marker) - (nowMs - markedAt)) / 1000;

    return targetReturnTime >= remainingGraceSec
        ? targetReturnTime
        : Infinity;
}

function chooseIncomingMarkResponse(bot, players, territories, correctNumbers, context = null) {
    const incomingMarkers = getIncomingCatchMarkers(bot, players);

    if (incomingMarkers.length === 0) {
        return null;
    }

    return chooseMarkedCounterattackNumber(bot, incomingMarkers, correctNumbers, context)
        || getReturnTarget(bot, territories);
}

function getIncomingCatchMarkers(bot, players) {
    const markers = [];

    if (!bot || !players) {
        return markers;
    }

    for (const player of players.values()) {
        if (player.id === bot.id
            || !player.pendingCatchEliminationTargets
            || !player.pendingCatchEliminationTargets.has(bot.id)) {
            continue;
        }

        markers.push(player);
    }

    return markers;
}

function chooseMarkedCounterattackNumber(bot, incomingMarkers, correctNumbers, context = null) {
    if (!bot.pendingCatchEliminationTargets
        || bot.pendingCatchEliminationTargets.size === 0
        || !Array.isArray(correctNumbers)
        || correctNumbers.length === 0
        || !incomingMarkers.some(marker => bot.pendingCatchEliminationTargets.has(marker.id))) {
        return null;
    }

    const number = findNearestPoint(bot, correctNumbers);

    if (!number) {
        return null;
    }

    const botConfirmTime = estimateTravelTime(bot, number);
    const incomingConfirmTime = estimateIncomingMarkConfirmTime(incomingMarkers, correctNumbers);
    const counterattackRemainingTime = estimateIncomingCounterattackRemainingTime(bot, incomingMarkers, context);
    const effectiveBotConfirmTime = Math.max(botConfirmTime, counterattackRemainingTime);
    const requiredMargin = getMarkedCounterattackMarginSec();

    if (effectiveBotConfirmTime + requiredMargin >= incomingConfirmTime) {
        return null;
    }

    return botConfirmTime < counterattackRemainingTime
        ? createMarkedCounterattackWaitTarget(bot, number)
        : number;
}

function estimateIncomingMarkConfirmTime(incomingMarkers, correctNumbers) {
    let bestTime = Infinity;

    for (const marker of incomingMarkers) {
        const number = findNearestPoint(marker, correctNumbers);

        if (!number) {
            continue;
        }

        bestTime = Math.min(bestTime, estimateTravelTime(marker, number));
    }

    return bestTime;
}

function estimateIncomingCounterattackRemainingTime(bot, incomingMarkers, context = null) {
    const nowMs = Number.isFinite(context && context.nowMs) ? context.nowMs : Date.now();
    let remainingMs = Infinity;

    for (const marker of incomingMarkers) {
        if (!bot.pendingCatchEliminationTargets
            || !bot.pendingCatchEliminationTargets.has(marker.id)
            || typeof marker.getCatchEliminationMarkedAt !== "function") {
            continue;
        }

        const markedAt = marker.getCatchEliminationMarkedAt(bot.id);

        if (!Number.isFinite(markedAt)) {
            continue;
        }

        remainingMs = Math.min(
            remainingMs,
            Math.max(0, getCounterattackGraceMs(bot) - (nowMs - markedAt))
        );
    }

    return Number.isFinite(remainingMs) ? remainingMs / 1000 : Infinity;
}

function createMarkedCounterattackWaitTarget(bot, number) {
    const collisionRadius = config.numbers.radius + config.world.playerSize / 2;
    const waitRadius = collisionRadius + config.world.playerSize * 1.25;
    const deltaX = bot.x - number.x;
    const deltaY = bot.y - number.y;
    const distance = Math.hypot(deltaX, deltaY);
    const fallbackAngle = Number.isFinite(bot.angle) ? bot.angle + Math.PI : 0;
    const outward = distance > Number.EPSILON
        ? {
            x: deltaX / distance,
            y: deltaY / distance
        }
        : {
            x: Math.cos(fallbackAngle),
            y: Math.sin(fallbackAngle)
        };

    if (distance < waitRadius) {
        return clampPointToMap({
            x: number.x + outward.x * waitRadius,
            y: number.y + outward.y * waitRadius
        });
    }

    const orbitDirection = isExpansionDirection(bot.botAi && bot.botAi.orbitDirection)
        ? bot.botAi.orbitDirection
        : 1;
    const tangent = {
        x: -outward.y * orbitDirection,
        y: outward.x * orbitDirection
    };

    return clampPointToMap({
        x: bot.x + tangent.x * config.world.playerSize * 3,
        y: bot.y + tangent.y * config.world.playerSize * 3
    });
}

function getMarkedCounterattackMarginSec() {
    const margin = Number(config.bots.markedCounterattackMarginSec);

    return Number.isFinite(margin) ? Math.max(0, margin) : 0.25;
}

function getCounterattackGraceMs(player) {
    const runtimeConfig = player && player.runtimeConfig;
    const configuredValue = runtimeConfig
        && runtimeConfig.gameMode
        && runtimeConfig.gameMode.catch
        && runtimeConfig.gameMode.catch.counterattackGraceMs;
    const fallbackValue = config.gameMode
        && config.gameMode.catch
        && config.gameMode.catch.counterattackGraceMs;

    if (Number.isFinite(configuredValue) && configuredValue >= 0) {
        return configuredValue;
    }

    return Number.isFinite(fallbackValue) && fallbackValue >= 0 ? fallbackValue : 1200;
}


function getCorrectNumbers(numberSystem) {
    if (!numberSystem || typeof numberSystem.getTheme !== "function") {
        return [];
    }

    const theme = numberSystem.getTheme();
    const numbers = typeof numberSystem.getNumbersMap === "function"
        ? numberSystem.getNumbersMap()
        : new Map();

    if (!theme || typeof theme.check !== "function") {
        return [];
    }

    return [...numbers.values()]
        .filter(number => theme.check(number));
}

function evaluateThreat(bot, players, territories, correctNumbers, context = null) {
    const trailPoints = getTrailPointsCached(context, bot);

    if (trailPoints.length === 0 || correctNumbers.length === 0) {
        return {
            canExpand: true,
            isThreatened: false,
            marginSec: Infinity
        };
    }

    const returnTime = estimateTravelTime(bot, getReturnTarget(bot, territories));
    let bestEnemyTime = Infinity;

    for (const enemy of players.values()) {
        if (enemy.id === bot.id) {
            continue;
        }

        if (distanceBetween(bot.x, bot.y, enemy.x, enemy.y) > config.bots.dangerRadius) {
            continue;
        }

        bestEnemyTime = Math.min(
            bestEnemyTime,
            estimatePunishTime(enemy, trailPoints, correctNumbers)
        );
    }

    const marginSec = bestEnemyTime - returnTime;

    return {
        canExpand: marginSec > config.bots.expandMarginSec,
        isThreatened: marginSec < config.bots.safetyMarginSec,
        marginSec
    };
}

function estimatePunishTime(enemy, trailPoints, correctNumbers) {
    let bestTime = Infinity;

    for (const trailPoint of trailPoints) {
        const number = findNearestPoint(trailPoint, correctNumbers);

        if (!number) {
            continue;
        }

        bestTime = Math.min(
            bestTime,
            (distanceBetween(enemy.x, enemy.y, trailPoint.x, trailPoint.y)
                + distanceBetween(trailPoint.x, trailPoint.y, number.x, number.y)) / getPlayerMovementSpeed(enemy)
        );
    }

    return bestTime;
}

function chooseBalanceCaptureTrailTarget(bot, players, territories, threat = null, context = null) {
    if (bot.catchBalance <= 0
        || hasAnyTrail(bot)
        || !isPlayerInsideOwnTerritory(territories, bot)) {
        return null;
    }

    const returnTarget = getReturnTarget(bot, territories);
    let bestTarget = null;

    for (const enemy of players.values()) {
        if (enemy.id === bot.id) {
            continue;
        }

        const enemyTrailPoints = getTrailPointsCached(context, enemy);

        if (enemyTrailPoints.length < 2) {
            continue;
        }

        const trailPoint = findNearestPoint(bot, enemyTrailPoints);

        if (!trailPoint || !isBalanceCaptureTrailPointInRange(bot, trailPoint)) {
            continue;
        }

        const requiredMargin = getBalanceCaptureReturnMarginSec();
        const botCaptureTime = estimateBalanceCaptureTime(bot, trailPoint, returnTarget);
        const counterRisk = evaluateTrailMarkCounterattackRisk(bot, enemy, territories, trailPoint, botCaptureTime, requiredMargin);

        if (!counterRisk.safe) {
            continue;
        }

        const score = scoreBalanceCaptureTarget({
            bot,
            botCaptureTime,
            enemy,
            enemyReturnTime: counterRisk.enemyReturnTime,
            threat,
            trailPoint
        });

        if (!bestTarget || score > bestTarget.score) {
            bestTarget = {
                score,
                target: trailPoint
            };
        }
    }

    return bestTarget && bestTarget.target;
}

function isBalanceCaptureTrailPointInRange(bot, trailPoint) {
    const baseDistance = distanceBetween(bot.territoryX, bot.territoryY, trailPoint.x, trailPoint.y);
    const botDistance = distanceBetween(bot.x, bot.y, trailPoint.x, trailPoint.y);

    return baseDistance <= getBalanceCaptureBaseRadius()
        && botDistance <= getBalanceCaptureTrailRadius();
}

function estimateBalanceCaptureTime(bot, trailPoint, returnTarget) {
    return (
        distanceBetween(bot.x, bot.y, trailPoint.x, trailPoint.y)
        + distanceBetween(trailPoint.x, trailPoint.y, returnTarget.x, returnTarget.y)
    ) / getPlayerMovementSpeed(bot);
}

function scoreBalanceCaptureTarget(options) {
    const safetyScore = getThreatMarginSafetyScore(options.threat && options.threat.marginSec);
    const enemyVulnerability = getEnemyVulnerabilityScore(options.enemy, options.enemyReturnTime);
    const baseProximityScore = 1 - clamp(
        distanceBetween(options.bot.territoryX, options.bot.territoryY, options.trailPoint.x, options.trailPoint.y)
            / Math.max(getBalanceCaptureBaseRadius(), 1),
        0,
        1
    );

    return (options.enemyReturnTime - options.botCaptureTime) * 2.4
        + enemyVulnerability * 1.2
        + baseProximityScore
        + safetyScore * 0.6
        - options.botCaptureTime * 0.35;
}

function getBalanceCaptureBaseRadius() {
    const radius = Number(config.bots.balanceCaptureBaseRadius);

    return Number.isFinite(radius) && radius > 0 ? radius : config.bots.huntRadius;
}

function getBalanceCaptureTrailRadius() {
    const radius = Number(config.bots.balanceCaptureTrailRadius);

    return Number.isFinite(radius) && radius > 0 ? radius : config.bots.huntRadius;
}

function getBalanceCaptureReturnMarginSec() {
    const margin = Number(config.bots.balanceCaptureReturnMarginSec);

    return Number.isFinite(margin) ? Math.max(0, margin) : getMarkedCounterattackMarginSec();
}

function chooseHuntTarget(bot, players, territories, correctNumbers, threat = null, context = null) {
    if (correctNumbers.length === 0) {
        return null;
    }

    let bestHunt = null;

    for (const enemy of players.values()) {
        if (enemy.id === bot.id) {
            continue;
        }

        const enemyTrailPoints = getTrailPointsCached(context, enemy);

        if (enemyTrailPoints.length < 2) {
            continue;
        }

        const enemyTrailPoint = findNearestPoint(bot, enemyTrailPoints);

        if (!enemyTrailPoint) {
            continue;
        }

        if (distanceBetween(bot.x, bot.y, enemyTrailPoint.x, enemyTrailPoint.y) > config.bots.huntRadius) {
            continue;
        }

        const number = findNearestPoint(enemyTrailPoint, correctNumbers);

        if (!number) {
            continue;
        }

        const hasPendingTarget = bot.pendingCatchEliminationTargets
            && bot.pendingCatchEliminationTargets.has(enemy.id);
        const botTime = hasPendingTarget
            ? estimateTravelTime(bot, number)
            : (distanceBetween(bot.x, bot.y, enemyTrailPoint.x, enemyTrailPoint.y)
                + distanceBetween(enemyTrailPoint.x, enemyTrailPoint.y, number.x, number.y)) / getPlayerMovementSpeed(bot);
        const markPoint = hasPendingTarget ? null : enemyTrailPoint;
        const preliminaryEnemyReturnTime = estimateTravelTime(enemy, getReturnTarget(enemy, territories));
        const requiredMargin = getHuntRequiredMargin(bot, enemy, threat, preliminaryEnemyReturnTime);
        const counterRisk = markPoint
            ? evaluateTrailMarkCounterattackRisk(bot, enemy, territories, markPoint, botTime, requiredMargin)
            : {
                enemyReturnTime: preliminaryEnemyReturnTime,
                safe: botTime + requiredMargin < preliminaryEnemyReturnTime
            };

        if (!counterRisk.safe) {
            continue;
        }

        const enemyReturnTime = counterRisk.enemyReturnTime;
        const eliminationWindow = enemyReturnTime - botTime;
        const huntScore = scoreHuntTarget({
            bot,
            botTime,
            eliminationWindow,
            enemy,
            enemyReturnTime,
            threat
        });

        if (!bestHunt || huntScore > bestHunt.score) {
            bestHunt = {
                target: hasPendingTarget ? number : enemyTrailPoint,
                score: huntScore,
                time: botTime
            };
        }
    }

    return bestHunt && bestHunt.target;
}

function evaluateTrailMarkCounterattackRisk(bot, enemy, territories, trailPoint, confirmTime, requiredMargin = 0) {
    const enemyReturnTime = estimateTravelTime(enemy, getReturnTarget(enemy, territories));

    if (confirmTime + requiredMargin >= enemyReturnTime) {
        return {
            enemyReturnTime,
            safe: false
        };
    }

    const markTime = estimateTravelTime(bot, trailPoint);
    const counterattackTime = estimateProspectiveCounterattackTime(bot, markTime, enemyReturnTime);

    return {
        counterattackTime,
        enemyReturnTime,
        safe: !Number.isFinite(counterattackTime)
            || confirmTime + requiredMargin < counterattackTime
    };
}

function estimateProspectiveCounterattackTime(marker, markTime, targetReturnTime) {
    const graceSec = getCounterattackGraceMs(marker) / 1000;

    return targetReturnTime - markTime >= graceSec
        ? targetReturnTime
        : Infinity;
}

function getHuntRequiredMargin(bot, enemy, threat, enemyReturnTime) {
    const safetyScore = getThreatMarginSafetyScore(threat && threat.marginSec);
    const vulnerabilityScore = getEnemyVulnerabilityScore(enemy, enemyReturnTime);
    const aggression = clamp(
        (safetyScore * 0.55 + vulnerabilityScore * 0.45) * getBotDifficultyAggression(bot),
        0,
        1
    );
    const reduction = clamp(Number(config.bots.huntAggressiveMarginReduction), 0, 0.75);

    return config.bots.huntMarginSec * (1 - aggression * reduction);
}

function scoreHuntTarget(options) {
    const safetyScore = getThreatMarginSafetyScore(options.threat && options.threat.marginSec);
    const vulnerabilityScore = getEnemyVulnerabilityScore(options.enemy, options.enemyReturnTime);
    const difficultyAggression = getBotDifficultyAggression(options.bot);

    return options.eliminationWindow * 2.2
        + vulnerabilityScore * 1.4 * difficultyAggression
        + safetyScore * 0.8
        - options.botTime * 0.35;
}

function getEnemyVulnerabilityScore(enemy, enemyReturnTime) {
    if (!Number.isFinite(enemyReturnTime)) {
        return 0;
    }

    const distanceFromBase = distanceBetween(enemy.x, enemy.y, enemy.territoryX, enemy.territoryY);
    const distanceScore = clamp(
        distanceFromBase / Math.max(config.world.initialTerritoryRadius * 5, config.world.playerSize),
        0,
        1
    );
    const timeScore = clamp(enemyReturnTime / Math.max(config.bots.huntMarginSec * 4, 1), 0, 1);

    return Math.max(distanceScore, timeScore);
}

function getExpansionTarget(bot, players = new Map(), territories = null, threat = null, context = null) {
    const ai = getBotAi(bot);
    const distanceFromBase = distanceBetween(bot.x, bot.y, bot.territoryX, bot.territoryY);
    const riskProfile = getExpansionRiskProfile(bot, players, threat, context);

    if (!hasAnyTrail(bot) && !bot.isLeftTrailActive && !bot.isRightTrailActive) {
        ai.expansionPlan = null;
    }

    const plan = getExpansionPlan(bot, ai, distanceFromBase, players, riskProfile);

    updateExpansionPlanForRisk(bot, plan, riskProfile);

    if (distanceFromBase > plan.radius * 1.28) {
        plan.phase = "return";
    }

    if (plan.phase === "outbound") {
        if (distanceFromBase >= plan.radius * 0.96) {
            plan.phase = "arc";
            plan.arcStartAngle = getBaseRelativeAngle(bot, distanceFromBase);
        } else {
            return getExpansionPlanPoint(bot, plan.startAngle, plan.radius);
        }
    }

    if (plan.phase === "arc") {
        const currentAngle = getBaseRelativeAngle(bot, distanceFromBase);
        const arcStartAngle = Number.isFinite(plan.arcStartAngle)
            ? plan.arcStartAngle
            : plan.startAngle;
        const arcTargetAngle = arcStartAngle + plan.direction * plan.arcRadians;
        const arcProgress = Math.abs(getAngleDelta(arcStartAngle, currentAngle));
        const arcTarget = getExpansionPlanPoint(bot, arcTargetAngle, plan.radius);

        if (arcProgress >= Math.abs(plan.arcRadians) * 0.92
            || distanceBetween(bot.x, bot.y, arcTarget.x, arcTarget.y) < config.world.playerSize * 2) {
            plan.phase = "return";
        } else {
            return arcTarget;
        }
    }

    if (plan.phase === "return") {
        return getExpansionReturnTarget(bot, territories, plan, riskProfile);
    }

    return getReturnTarget(bot, territories);
}

function getExpansionPlan(bot, ai, distanceFromBase, players, riskProfile) {
    if (ai.expansionPlan) {
        return ai.expansionPlan;
    }

    const startAngle = getBaseRelativeAngle(bot, distanceFromBase);
    const radius = getExpansionRadius(bot, riskProfile);
    const arcRadians = getExpansionArcRadians(bot, riskProfile);

    ai.expansionPlan = {
        arcRadians,
        direction: chooseExpansionDirection(bot, players, startAngle, radius, arcRadians, ai.orbitDirection),
        phase: "outbound",
        radius,
        riskSafetyScore: riskProfile.safetyScore,
        startAngle
    };

    ai.orbitDirection *= Math.random() < 0.28 ? -1 : 1;
    return ai.expansionPlan;
}

function updateExpansionPlanForRisk(bot, plan, riskProfile) {
    if (!plan || plan.phase === "return") {
        return;
    }

    if (shouldReturnFromExpansionRisk(riskProfile)) {
        plan.phase = "return";
        return;
    }

    const nextRadius = getExpansionRadius(bot, riskProfile);
    const nextArcRadians = getExpansionArcRadians(bot, riskProfile);

    if (nextRadius > plan.radius) {
        plan.radius = Math.min(nextRadius, plan.radius * 1.12);
    }

    if (Math.abs(nextArcRadians) > Math.abs(plan.arcRadians)) {
        plan.arcRadians = Math.min(nextArcRadians, plan.arcRadians * 1.1);
    }

    plan.riskSafetyScore = riskProfile.safetyScore;
}

function shouldReturnFromExpansionRisk(riskProfile) {
    if (!riskProfile) {
        return false;
    }

    if (riskProfile.isThreatened) {
        return true;
    }

    const returnMargin = getExpansionRiskReturnMarginSec();

    return Number.isFinite(riskProfile.marginSec)
        && riskProfile.marginSec < returnMargin;
}

function getExpansionPlanPoint(bot, angle, radius) {
    return clampPointToMap({
        x: bot.territoryX + Math.cos(angle) * radius,
        y: bot.territoryY + Math.sin(angle) * radius
    });
}

function getExpansionRadius(bot, riskProfile = null) {
    const balanceBonus = Math.min(Math.max(bot.catchBalance - 1, 0), 4) * 0.09;
    const safetyBonus = getExpansionSafetyBonus(riskProfile, config.bots.expansionMaxRadiusBonus);
    const radius = config.bots.captureLoopRadius
        * (1.24 + balanceBonus)
        * getBotDifficultyExpansionMultiplier(bot)
        * (1 + safetyBonus);
    const maxRadius = config.world.mapRadius * 0.68;

    return Math.min(radius, maxRadius);
}

function getExpansionArcRadians(bot, riskProfile = null) {
    const balanceBonus = Math.min(Math.max(bot.catchBalance - 1, 0), 3) * 0.08;
    const safetyBonus = getExpansionSafetyBonus(riskProfile, config.bots.expansionMaxArcBonus);

    return (1.65 + balanceBonus)
        * getBotDifficultyExpansionMultiplier(bot)
        * (1 + safetyBonus);
}

function getExpansionSafetyBonus(riskProfile, maxBonus) {
    const bonus = Number(maxBonus);
    const safetyScore = riskProfile && Number.isFinite(riskProfile.safetyScore)
        ? riskProfile.safetyScore
        : 0;

    return clamp(safetyScore, 0, 1) * (Number.isFinite(bonus) ? Math.max(0, bonus) : 0);
}

function getExpansionRiskProfile(bot, players, threat = null, context = null) {
    const pressureDistance = getNearestEnemyPressureDistance(bot, players, context);
    const pressureScore = getExpansionPressureSafetyScore(pressureDistance);
    const marginScore = getThreatMarginSafetyScore(threat && threat.marginSec);
    const safetyScore = Math.min(pressureScore, marginScore);

    return {
        isThreatened: Boolean(threat && threat.isThreatened),
        marginSec: threat && Number.isFinite(threat.marginSec)
            ? threat.marginSec
            : Infinity,
        pressureDistance,
        pressureScore,
        safetyScore
    };
}

function getExpansionPressureSafetyScore(pressureDistance) {
    if (!Number.isFinite(pressureDistance)) {
        return 1;
    }

    const dangerRadius = Math.max(config.bots.dangerRadius, config.world.playerSize);
    const safeRadius = Math.max(Number(config.bots.expansionPressureRadius) || dangerRadius, dangerRadius + 1);

    return clamp((pressureDistance - dangerRadius) / (safeRadius - dangerRadius), 0, 1);
}

function getNearestEnemyPressureDistance(bot, players, context = null) {
    let nearestDistance = Infinity;
    const trailPoints = getTrailPointsCached(context, bot, {
        skipRecent: getSelfTrailClearanceRecentPointSkip()
    });
    const pressurePoints = createPressureSamplePoints(bot, trailPoints);

    for (const enemy of players.values()) {
        if (enemy.id === bot.id) {
            continue;
        }

        for (const point of pressurePoints) {
            nearestDistance = Math.min(
                nearestDistance,
                distanceBetween(enemy.x, enemy.y, point.x, point.y)
            );
        }
    }

    return nearestDistance;
}

function createPressureSamplePoints(bot, trailPoints) {
    const points = [{
        x: bot.x,
        y: bot.y
    }];
    const maxSamples = getExpansionPressureSampleCount();

    if (!Array.isArray(trailPoints) || trailPoints.length === 0) {
        return points;
    }

    const stride = Math.max(1, Math.ceil(trailPoints.length / maxSamples));

    for (let index = 0; index < trailPoints.length; index += stride) {
        points.push(trailPoints[index]);
    }

    const lastPoint = trailPoints[trailPoints.length - 1];

    if (lastPoint) {
        points.push(lastPoint);
    }

    return points;
}

function chooseExpansionDirection(bot, players, startAngle, radius, arcRadians, preferredDirection) {
    const directions = isExpansionDirection(preferredDirection)
        ? [preferredDirection, -preferredDirection]
        : [1, -1];
    let bestDirection = directions[0];
    let bestScore = -Infinity;

    for (const direction of directions) {
        const score = scoreExpansionDirection(bot, players, startAngle, radius, arcRadians, direction);

        if (score > bestScore) {
            bestDirection = direction;
            bestScore = score;
        }
    }

    return bestDirection;
}

function scoreExpansionDirection(bot, players, startAngle, radius, arcRadians, direction) {
    const sampleAngles = [
        startAngle,
        startAngle + direction * arcRadians * 0.5,
        startAngle + direction * arcRadians
    ];
    let nearestEnemyDistance = Infinity;

    for (const enemy of players.values()) {
        if (enemy.id === bot.id) {
            continue;
        }

        for (const angle of sampleAngles) {
            const point = getExpansionPlanPoint(bot, angle, radius);

            nearestEnemyDistance = Math.min(
                nearestEnemyDistance,
                distanceBetween(enemy.x, enemy.y, point.x, point.y)
            );
        }
    }

    return Number.isFinite(nearestEnemyDistance)
        ? nearestEnemyDistance
        : 0;
}

function isExpansionDirection(value) {
    return value === -1 || value === 1;
}

function getExpansionPressureSampleCount() {
    const count = Number(config.bots.expansionPressureSampleCount);

    return Number.isInteger(count) && count > 0 ? count : 24;
}

function getExpansionRiskReturnMarginSec() {
    const margin = Number(config.bots.expansionRiskReturnMarginSec);

    return Number.isFinite(margin) ? Math.max(0, margin) : config.bots.safetyMarginSec;
}

function getBaseRelativeAngle(bot, distanceFromBase) {
    if (distanceFromBase > 1) {
        return Math.atan2(bot.y - bot.territoryY, bot.x - bot.territoryX);
    }

    return getBotAi(bot).orbitPhase;
}

function getWanderTarget(bot) {
    const ai = getBotAi(bot);
    const radius = config.world.initialTerritoryRadius * 1.8;
    ai.orbitPhase += ai.orbitDirection * 0.45;

    return clampPointToMap({
        x: bot.territoryX + Math.cos(ai.orbitPhase) * radius,
        y: bot.territoryY + Math.sin(ai.orbitPhase) * radius
    });
}

function getExpansionReturnTarget(bot, territories, plan, riskProfile) {
    const territoryPolygon = getReturnTerritoryPolygon(bot, territories);

    if (!territoryPolygon || !plan) {
        return getReturnTarget(bot, territories);
    }

    const safetyScore = riskProfile && Number.isFinite(riskProfile.safetyScore)
        ? riskProfile.safetyScore
        : 0;

    if (safetyScore <= 0.1 || shouldReturnFromExpansionRisk(riskProfile)) {
        return getReturnTarget(bot, territories);
    }

    const distanceFromBase = distanceBetween(bot.x, bot.y, bot.territoryX, bot.territoryY);
    const currentAngle = getBaseRelativeAngle(bot, distanceFromBase);
    const leadRadians = getExpansionReturnLeadRadians(plan, riskProfile);
    const ledTarget = getAngledTerritoryReturnTarget(
        bot,
        territoryPolygon,
        currentAngle + plan.direction * leadRadians
    );

    return ledTarget || getReturnTarget(bot, territories);
}

function getExpansionReturnLeadRadians(plan, riskProfile) {
    const safetyScore = riskProfile && Number.isFinite(riskProfile.safetyScore)
        ? riskProfile.safetyScore
        : 0;
    const maxLead = Math.min(Math.abs(plan.arcRadians || 0) * 0.28, 0.58);

    return maxLead * clamp(safetyScore, 0, 1);
}

function getReturnTarget(player, territories = null) {
    const territoryPolygon = getReturnTerritoryPolygon(player, territories);

    if (!territoryPolygon) {
        return createReturnTarget(getBaseReturnTarget(player));
    }

    const nearestContact = findClosestPolygonBoundaryContact(territoryPolygon, player);
    const boundaryTarget = nearestContact && createInsideTerritoryReturnTarget(
        player,
        territoryPolygon,
        nearestContact.point
    );

    return boundaryTarget || createReturnTarget(getBaseReturnTarget(player));
}

function getReturnTerritoryPolygon(player, territories) {
    if (!player || !territories) {
        return null;
    }

    const polygon = getPlayerTerritoryPolygon(territories, player.id);

    return Array.isArray(polygon) && polygon.length > 0 ? polygon : null;
}

function isPlayerInsideOwnTerritory(territories, player) {
    const territoryPolygon = getReturnTerritoryPolygon(player, territories);

    return Boolean(territoryPolygon && isPointInPolygon(territoryPolygon, player.x, player.y));
}

function getAngledTerritoryReturnTarget(player, territoryPolygon, angle) {
    if (!Number.isFinite(angle)) {
        return null;
    }

    const anchor = getBaseReturnTarget(player);
    const farPoint = {
        x: anchor.x + Math.cos(angle) * config.world.mapRadius * 2,
        y: anchor.y + Math.sin(angle) * config.world.mapRadius * 2
    };
    const contact = findClosestPolygonBoundaryContact(territoryPolygon, farPoint);

    return contact
        ? createInsideTerritoryReturnTarget(player, territoryPolygon, contact.point)
        : null;
}

function createInsideTerritoryReturnTarget(player, territoryPolygon, boundaryPoint) {
    const anchor = getBaseReturnTarget(player);
    const direction = {
        x: anchor.x - boundaryPoint.x,
        y: anchor.y - boundaryPoint.y
    };
    const length = Math.hypot(direction.x, direction.y);

    if (length <= Number.EPSILON) {
        return createReturnTarget(anchor);
    }

    const unit = {
        x: direction.x / length,
        y: direction.y / length
    };
    const distances = [
        config.world.playerSize * 1.25,
        config.world.playerSize * 0.65,
        config.world.playerSize * 2,
        config.world.playerSize * 3
    ];

    for (const distance of distances) {
        const point = {
            x: boundaryPoint.x + unit.x * Math.min(distance, length),
            y: boundaryPoint.y + unit.y * Math.min(distance, length)
        };

        if (isPointInPolygon(territoryPolygon, point.x, point.y)) {
            return createReturnTarget(point);
        }
    }

    return isPointInPolygon(territoryPolygon, anchor.x, anchor.y)
        ? createReturnTarget(anchor)
        : null;
}

function getBaseReturnTarget(player) {
    return {
        x: player.territoryX,
        y: player.territoryY
    };
}

function createReturnTarget(point) {
    return {
        ...point,
        isReturnTarget: true
    };
}

function isReturnTarget(bot, target) {
    return Boolean(target && (
        target.isReturnTarget
        || distanceBetween(target.x, target.y, bot.territoryX, bot.territoryY) <= config.world.playerSize
    ));
}

function findNearestPoint(origin, points) {
    let nearest = null;
    let nearestDistanceSquared = Infinity;

    for (const point of points || []) {
        const deltaX = origin.x - point.x;
        const deltaY = origin.y - point.y;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY;

        if (distanceSquared < nearestDistanceSquared) {
            nearest = point;
            nearestDistanceSquared = distanceSquared;
        }
    }

    return nearest;
}

function getNearestDistanceSquared(origin, points, diagnostics = null) {
    const sourcePoints = points || [];
    let nearestDistanceSquared = Infinity;

    addSelfTrailSafetyDiagnosticValue(diagnostics, "pointDistanceCheckCount", sourcePoints.length);

    for (const point of sourcePoints) {
        const deltaX = origin.x - point.x;
        const deltaY = origin.y - point.y;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY;

        if (distanceSquared < nearestDistanceSquared) {
            nearestDistanceSquared = distanceSquared;
        }
    }

    return nearestDistanceSquared;
}

function getAngleDelta(fromAngle, toAngle) {
    return Math.atan2(
        Math.sin(toAngle - fromAngle),
        Math.cos(toAngle - fromAngle)
    );
}

function normalizeAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function estimateTravelTime(player, target) {
    return distanceBetween(player.x, player.y, target.x, target.y) / getPlayerMovementSpeed(player);
}

function getThreatMarginSafetyScore(marginSec) {
    if (!Number.isFinite(marginSec)) {
        return 1;
    }

    const safeMargin = Math.max(
        Number(config.bots.expansionGreedSafeMarginSec) || config.bots.expandMarginSec,
        config.bots.expandMarginSec + 0.1
    );

    return clamp(
        (marginSec - config.bots.expandMarginSec) / (safeMargin - config.bots.expandMarginSec),
        0,
        1
    );
}

function getBotDifficultyAggression(bot) {
    switch (bot && bot.difficulty) {
        case "hard":
            return 1.18;
        case "medium":
            return 1;
        default:
            return 0.82;
    }
}

function getBotDifficultyExpansionMultiplier(bot) {
    switch (bot && bot.difficulty) {
        case "hard":
            return 1.12;
        case "medium":
            return 1;
        default:
            return 0.9;
    }
}

function getPlayerMovementSpeed(player) {
    const speed = Number(
        player
        && player.runtimeConfig
        && player.runtimeConfig.movement
        && player.runtimeConfig.movement.speed
    );

    return Number.isFinite(speed) && speed > 0
        ? speed
        : config.movement.speed;
}

function applyDecisionNoise(angle, options = {}) {
    if (options.suppressNoise) {
        return angle;
    }

    if (!options.avoidingSelfTrail && Math.random() < config.bots.mistakeChance) {
        return angle + (Math.random() * 2 - 1) * Math.PI * 0.65;
    }

    const noiseScale = options.avoidingSelfTrail ? 0.25 : 1;

    return angle + (Math.random() * 2 - 1) * config.bots.angleNoiseRadians * noiseScale;
}

function chooseSelfTrailSafeAngle(bot, targetAngle, options = {}, context = null) {
    const diagnostics = getSelfTrailSafetyDiagnostics(context);
    addSelfTrailSafetyDiagnosticValue(diagnostics, "decisionCount", 1);

    const trailPoints = getTrailPointsCached(context, bot, { skipRecent: getSelfTrailClearanceRecentPointSkip() });
    const trailSegments = getSelfTrailSegmentsCached(context, bot, { skipRecent: getSelfTrailCollisionRecentPointSkip() });

    if ((trailPoints.length === 0 && trailSegments.length === 0) || !Number.isFinite(targetAngle)) {
        clearSelfTrailEscapeMemory(bot);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "bypassCount", 1);
        return {
            angle: targetAngle,
            avoidingSelfTrail: false
        };
    }

    const trailGeometry = createSelfTrailSafetyGeometry(bot, trailPoints, trailSegments, options, diagnostics);
    const nearestSelfTrailDistanceSquared = getNearestDistanceSquared(bot, trailGeometry.points, diagnostics);
    const bypassDistance = getSelfTrailLookaheadDistance(options) + config.bots.selfTrailAvoidDistance;

    if (
        trailGeometry.points.length === 0
        && trailGeometry.segments.length === 0
    ) {
        clearSelfTrailEscapeMemory(bot);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "bypassCount", 1);
        return {
            angle: targetAngle,
            avoidingSelfTrail: false
        };
    }

    if (
        nearestSelfTrailDistanceSquared > bypassDistance * bypassDistance
        && trailGeometry.segments.length === 0
    ) {
        clearSelfTrailEscapeMemory(bot);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "bypassCount", 1);
        return {
            angle: targetAngle,
            avoidingSelfTrail: false
        };
    }

    const budget = createSelfTrailSafetyBudget(diagnostics);
    const targetSafety = getSelfTrailPathSafety(bot, targetAngle, trailGeometry, options, budget, diagnostics);

    if (!isSelfTrailPathUnsafe(targetSafety)) {
        clearSelfTrailEscapeMemory(bot);
        finishSelfTrailSafetyBudget(budget);
        return {
            angle: targetAngle,
            avoidingSelfTrail: false
        };
    }

    addSelfTrailSafetyDiagnosticValue(diagnostics, "unsafeTargetCount", 1);

    const riskOptions = createSelfTrailRiskOptions(options, targetSafety, nearestSelfTrailDistanceSquared);
    const activeTrailGeometry = riskOptions.trapMode
        ? createSelfTrailSafetyGeometry(bot, trailPoints, trailSegments, riskOptions, diagnostics)
        : trailGeometry;
    const activeTargetSafety = riskOptions.trapMode
        ? getSelfTrailPathSafety(bot, targetAngle, activeTrailGeometry, riskOptions, budget, diagnostics)
        : targetSafety;
    const rememberedCandidate = chooseRememberedSelfTrailEscapeCandidate(
        bot,
        targetAngle,
        activeTrailGeometry,
        riskOptions,
        context,
        budget,
        diagnostics
    );

    if (rememberedCandidate) {
        finishSelfTrailSafetyBudget(budget);
        return {
            angle: rememberedCandidate.angle,
            avoidingSelfTrail: true,
            suppressNoise: true
        };
    }

    const candidates = limitSelfTrailAvoidanceCandidates(
        createSelfTrailAvoidanceCandidates(bot, targetAngle, riskOptions, activeTrailGeometry),
        riskOptions
    );
    addSelfTrailSafetyDiagnosticValue(diagnostics, "candidateCount", candidates.length);

    let bestAnyCandidate = {
        angle: targetAngle,
        safety: activeTargetSafety,
        score: scoreSelfTrailCandidate(targetAngle, targetAngle, activeTargetSafety, riskOptions)
    };
    let bestSafeCandidate = isSelfTrailPathUnsafe(activeTargetSafety)
        ? null
        : bestAnyCandidate;
    let bestNonCrossingCandidate = activeTargetSafety.crossesTrail || activeTargetSafety.budgetHit
        ? null
        : bestAnyCandidate;

    for (const angle of candidates) {
        if (!hasSelfTrailSafetyBudgetRemaining(budget)) {
            break;
        }

        if (Math.abs(getAngleDelta(angle, targetAngle)) <= 0.001) {
            continue;
        }

        addSelfTrailSafetyDiagnosticValue(diagnostics, "evaluatedCandidateCount", 1);

        const safety = getSelfTrailPathSafety(bot, angle, activeTrailGeometry, riskOptions, budget, diagnostics);
        const score = scoreSelfTrailCandidate(angle, targetAngle, safety, riskOptions);

        if (score > bestAnyCandidate.score) {
            bestAnyCandidate = {
                angle,
                safety,
                score
            };
        }

        if (!isSelfTrailPathUnsafe(safety) && (!bestSafeCandidate || score > bestSafeCandidate.score)) {
            bestSafeCandidate = {
                angle,
                safety,
                score
            };
        }

        if (!safety.crossesTrail && !safety.budgetHit && (!bestNonCrossingCandidate || score > bestNonCrossingCandidate.score)) {
            bestNonCrossingCandidate = {
                angle,
                safety,
                score
            };
        }
    }

    const bestCandidate = bestSafeCandidate
        || (hasSelfTrailSafetyBudgetRemaining(budget)
            ? chooseLocalSelfTrailEscapeCandidate(bot, targetAngle, activeTrailGeometry, candidates, riskOptions, budget, diagnostics)
            : null)
        || bestNonCrossingCandidate
        || bestAnyCandidate;

    rememberSelfTrailEscapeCandidate(bot, bestCandidate, activeTargetSafety, riskOptions, context);
    finishSelfTrailSafetyBudget(budget);

    return {
        angle: bestCandidate.angle,
        avoidingSelfTrail: true,
        suppressNoise: shouldSuppressSelfTrailEscapeNoise(activeTargetSafety, bestCandidate)
    };
}

function createSelfTrailRiskOptions(options = {}, targetSafety = {}, nearestSelfTrailDistanceSquared = Infinity) {
    const nearestDistance = Math.sqrt(nearestSelfTrailDistanceSquared);
    const trapMode = Boolean(
        targetSafety.crossesTrail
        || targetSafety.budgetHit
        || targetSafety.clearance < config.bots.selfTrailAvoidDistance * 1.25
        || nearestDistance < config.bots.selfTrailAvoidDistance * 1.4
    );

    if (!trapMode) {
        return options;
    }

    return {
        ...options,
        includeReturnRoute: true,
        selfTrailLookaheadDistance: getBotSelfTrailTrapLookaheadMaxDistance(),
        trapMode: true
    };
}

function chooseRememberedSelfTrailEscapeCandidate(bot, targetAngle, trailGeometry, options = {}, context = null, budget = null, diagnostics = null) {
    const ai = getBotAi(bot);
    const nowMs = getSelfTrailDecisionNowMs(context);

    if (!Number.isFinite(ai.selfTrailEscapeAngle)
        || !Number.isFinite(ai.selfTrailEscapeUntilMs)
        || ai.selfTrailEscapeUntilMs <= nowMs) {
        return null;
    }

    const safety = getSelfTrailPathSafety(bot, ai.selfTrailEscapeAngle, trailGeometry, options, budget, diagnostics);

    if (isSelfTrailPathUnsafe(safety)) {
        clearSelfTrailEscapeMemory(bot);
        return null;
    }

    return {
        angle: ai.selfTrailEscapeAngle,
        safety,
        score: scoreSelfTrailCandidate(ai.selfTrailEscapeAngle, targetAngle, safety, options)
    };
}

function rememberSelfTrailEscapeCandidate(bot, candidate, targetSafety = {}, options = {}, context = null) {
    if (!candidate || !Number.isFinite(candidate.angle)) {
        clearSelfTrailEscapeMemory(bot);
        return;
    }

    if (!options.trapMode && !isSelfTrailCriticalSafety(targetSafety)) {
        clearSelfTrailEscapeMemory(bot);
        return;
    }

    const ai = getBotAi(bot);
    const nowMs = getSelfTrailDecisionNowMs(context);

    ai.selfTrailEscapeAngle = candidate.angle;
    ai.selfTrailEscapeUntilMs = nowMs + getBotSelfTrailEscapeMemoryMs();
}

function clearSelfTrailEscapeMemory(bot) {
    if (!bot || !bot.botAi) {
        return;
    }

    bot.botAi.selfTrailEscapeAngle = null;
    bot.botAi.selfTrailEscapeUntilMs = 0;
}

function getSelfTrailDecisionNowMs(context = null) {
    return Number.isFinite(context && context.nowMs) ? context.nowMs : Date.now();
}

function shouldSuppressSelfTrailEscapeNoise(targetSafety = {}, candidate = null) {
    return isSelfTrailCriticalSafety(targetSafety)
        || !candidate
        || !candidate.safety
        || isSelfTrailPathUnsafe(candidate.safety, 0.8);
}

function isSelfTrailCriticalSafety(safety = {}) {
    return Boolean(
        safety.budgetHit
        || safety.crossesTrail
        || safety.clearance < config.bots.selfTrailAvoidDistance * 0.85
    );
}

function scoreSelfTrailCandidate(angle, targetAngle, safety, options = {}) {
    const targetPenaltyScale = options.allowReverse ? 0.35 : 0.85;
    const targetPenalty = Math.abs(getAngleDelta(angle, targetAngle))
        * config.bots.selfTrailAvoidDistance
        * targetPenaltyScale;
    const crossPenalty = safety.crossesTrail ? config.world.mapRadius * 10 : 0;
    const budgetPenalty = safety.budgetHit ? config.bots.selfTrailAvoidDistance * 2 : 0;
    const clearanceScore = Number.isFinite(safety.clearance)
        ? safety.clearance * 4
        : config.bots.selfTrailAvoidDistance * 4;

    return clearanceScore - targetPenalty - crossPenalty - budgetPenalty;
}

function createSelfTrailAvoidanceCandidates(bot, targetAngle, options = {}, trailGeometry = null) {
    const returnTarget = getReturnTarget(bot, options.territories);
    const returnAngle = Math.atan2(returnTarget.y - bot.y, returnTarget.x - bot.x);
    const baseAngles = options.allowReverse || options.includeReturnRoute
        ? [targetAngle, bot.angle, returnAngle].filter(Number.isFinite)
        : [targetAngle, bot.angle].filter(Number.isFinite);
    const offsets = options.allowReverse
        ? [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.45, -1.45, 1.9, -1.9, 2.45, -2.45, Math.PI]
        : [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.3, -1.3, 1.75, -1.75, 2.35, -2.35, Math.PI];
    const candidates = [];
    const seen = new Set();

    for (const baseAngle of baseAngles) {
        for (const offset of offsets) {
            addSelfTrailCandidate(candidates, seen, baseAngle + offset);
        }
    }

    const fullCircleSteps = options.allowReverse ? 32 : 24;

    for (let index = 0; index < fullCircleSteps; index++) {
        addSelfTrailCandidate(candidates, seen, targetAngle + (Math.PI * 2 * index) / fullCircleSteps);
    }

    if (options.trapMode) {
        addSelfTrailTrapEscapeCandidates(candidates, seen, bot, targetAngle, trailGeometry);
    }

    return candidates;
}

function addSelfTrailTrapEscapeCandidates(candidates, seen, bot, targetAngle, trailGeometry = null) {
    const feature = getNearestSelfTrailFeature(bot, trailGeometry);

    addSelfTrailCandidate(candidates, seen, bot.angle + Math.PI);
    addSelfTrailCandidate(candidates, seen, bot.angle + Math.PI / 2);
    addSelfTrailCandidate(candidates, seen, bot.angle - Math.PI / 2);

    if (!feature) {
        return;
    }

    if (Number.isFinite(feature.awayAngle)) {
        addSelfTrailCandidate(candidates, seen, feature.awayAngle);
        addSelfTrailCandidate(candidates, seen, feature.awayAngle + 0.45);
        addSelfTrailCandidate(candidates, seen, feature.awayAngle - 0.45);
        addSelfTrailCandidate(candidates, seen, feature.awayAngle + Math.PI / 2);
        addSelfTrailCandidate(candidates, seen, feature.awayAngle - Math.PI / 2);
    }

    if (Number.isFinite(feature.segmentAngle)) {
        addSelfTrailCandidate(candidates, seen, feature.segmentAngle);
        addSelfTrailCandidate(candidates, seen, feature.segmentAngle + Math.PI);
        addSelfTrailCandidate(candidates, seen, feature.segmentAngle + 0.55);
        addSelfTrailCandidate(candidates, seen, feature.segmentAngle - 0.55);
        addSelfTrailCandidate(candidates, seen, feature.segmentAngle + Math.PI + 0.55);
        addSelfTrailCandidate(candidates, seen, feature.segmentAngle + Math.PI - 0.55);
    }

    addSelfTrailCandidate(candidates, seen, targetAngle + Math.PI);
}

function getNearestSelfTrailFeature(bot, trailGeometry = null) {
    if (!bot || !trailGeometry) {
        return null;
    }

    let bestFeature = null;

    for (const point of trailGeometry.points || []) {
        const distanceSquared = getDistanceSquared(bot, point);

        if (!bestFeature || distanceSquared < bestFeature.distanceSquared) {
            bestFeature = createSelfTrailFeature(bot, point, distanceSquared, null);
        }
    }

    for (const segment of trailGeometry.segments || []) {
        const closestPoint = getClosestPointOnSegment(bot, segment.start, segment.end);
        const distanceSquared = getDistanceSquared(bot, closestPoint);
        const segmentAngle = Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x);

        if (!bestFeature || distanceSquared < bestFeature.distanceSquared) {
            bestFeature = createSelfTrailFeature(bot, closestPoint, distanceSquared, segmentAngle);
        }
    }

    return bestFeature;
}

function createSelfTrailFeature(bot, point, distanceSquared, segmentAngle) {
    return {
        awayAngle: Math.atan2(bot.y - point.y, bot.x - point.x),
        distanceSquared,
        point,
        segmentAngle
    };
}

function getClosestPointOnSegment(point, start, end) {
    const segmentX = end.x - start.x;
    const segmentY = end.y - start.y;
    const lengthSquared = segmentX * segmentX + segmentY * segmentY;

    if (lengthSquared <= geometryEpsilon) {
        return start;
    }

    const t = clamp(
        ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared,
        0,
        1
    );

    return {
        x: start.x + segmentX * t,
        y: start.y + segmentY * t
    };
}

function getDistanceSquared(first, second) {
    const deltaX = first.x - second.x;
    const deltaY = first.y - second.y;

    return deltaX * deltaX + deltaY * deltaY;
}

function limitSelfTrailAvoidanceCandidates(candidates, options = {}) {
    const maxCandidates = options.trapMode
        ? getBotSelfTrailSafetyTrapMaxCandidates()
        : getBotSelfTrailSafetyMaxCandidates();

    if (!Array.isArray(candidates) || candidates.length <= maxCandidates) {
        return candidates || [];
    }

    return candidates.slice(0, maxCandidates);
}

function chooseLocalSelfTrailEscapeCandidate(bot, targetAngle, trailGeometry, candidates, options = {}, budget = null, diagnostics = null) {
    const localOptions = {
        ...options,
        targetDistance: Math.max(config.world.playerSize * 4, config.bots.selfTrailAvoidDistance)
    };
    const localCandidates = (candidates || []).slice(0, getBotSelfTrailSafetyMaxLocalCandidates());
    let bestCandidate = null;

    addSelfTrailSafetyDiagnosticValue(diagnostics, "localCandidateCount", localCandidates.length);

    for (const angle of localCandidates) {
        if (!hasSelfTrailSafetyBudgetRemaining(budget)) {
            break;
        }

        addSelfTrailSafetyDiagnosticValue(diagnostics, "evaluatedLocalCandidateCount", 1);

        const safety = getSelfTrailPathSafety(bot, angle, trailGeometry, localOptions, budget, diagnostics);

        if (isSelfTrailPathUnsafe(safety)) {
            continue;
        }

        const score = scoreSelfTrailCandidate(angle, targetAngle, safety, options);

        if (!bestCandidate || score > bestCandidate.score) {
            bestCandidate = {
                angle,
                safety,
                score
            };
        }
    }

    return bestCandidate;
}

function addSelfTrailCandidate(candidates, seen, rawAngle) {
    const angle = normalizeAngle(rawAngle);
    const key = Math.round(angle * 1000);

    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    candidates.push(angle);
}

function isSelfTrailPathUnsafe(safety, thresholdScale = 1) {
    return safety.budgetHit
        || safety.crossesTrail
        || safety.clearance < config.bots.selfTrailAvoidDistance * thresholdScale;
}

function createSelfTrailSafetyGeometry(bot, trailPoints, trailSegments, options = {}, diagnostics = null) {
    const lookaheadDistance = getSelfTrailLookaheadDistance(options);
    const bounds = createBoundsAroundPoint(
        bot,
        lookaheadDistance + config.bots.selfTrailAvoidDistance + config.world.playerSize
    );
    const points = filterPointsByBounds(trailPoints, bounds);
    const segments = filterSegmentsByBounds(trailSegments, bounds);

    addSelfTrailSafetyDiagnosticValue(diagnostics, "trailPointCount", trailPoints.length);
    addSelfTrailSafetyDiagnosticValue(diagnostics, "trailSegmentCount", trailSegments.length);
    addSelfTrailSafetyDiagnosticValue(diagnostics, "filteredTrailPointCount", points.length);
    addSelfTrailSafetyDiagnosticValue(diagnostics, "filteredTrailSegmentCount", segments.length);

    return {
        bounds,
        lookaheadDistance,
        points,
        segments
    };
}

function getSelfTrailPathSafety(bot, targetAngle, trailGeometry, options = {}, budget = null, diagnostics = null) {
    const trailPoints = trailGeometry && Array.isArray(trailGeometry.points)
        ? trailGeometry.points
        : [];
    const trailSegments = trailGeometry && Array.isArray(trailGeometry.segments)
        ? trailGeometry.segments
        : [];
    let position = {
        x: bot.x,
        y: bot.y
    };
    let angle = bot.angle;
    let nearestDistanceSquared = Infinity;
    let budgetHit = false;
    let crossesTrail = false;
    const lookaheadDistance = Number.isFinite(trailGeometry && trailGeometry.lookaheadDistance)
        ? Math.min(trailGeometry.lookaheadDistance, getSelfTrailLookaheadDistance(options))
        : getSelfTrailLookaheadDistance(options);
    const sampleCount = getSelfTrailLookaheadSampleCount(lookaheadDistance);
    const stepDistance = lookaheadDistance / sampleCount;
    const stepDeltaTime = stepDistance / getBotMovementSpeed(bot);
    let previousSamples = createSelfTrailAvoidanceSamplePoints(position, angle);

    addSelfTrailSafetyDiagnosticValue(diagnostics, "pathEvaluationCount", 1);
    addSelfTrailSafetyDiagnosticValue(diagnostics, "sampleCount", sampleCount);

    for (let index = 0; index < sampleCount; index++) {
        if (!hasSelfTrailSafetyBudgetRemaining(budget)) {
            budgetHit = true;
            break;
        }

        angle = lerpAngle(angle, targetAngle, getSelfTrailSimulationRotationBlend(bot, stepDeltaTime));
        position = clampPointToMap({
            x: position.x + Math.cos(angle) * stepDistance,
            y: position.y + Math.sin(angle) * stepDistance
        });

        const currentSamples = createSelfTrailAvoidanceSamplePoints(position, angle);

        if (!crossesTrail && doesSamplePathCrossSelfTrail(previousSamples, currentSamples, trailSegments, diagnostics)) {
            crossesTrail = true;
        }

        for (const samplePoint of currentSamples) {
            nearestDistanceSquared = Math.min(
                nearestDistanceSquared,
                getNearestDistanceSquared(samplePoint, trailPoints, diagnostics)
            );
        }

        previousSamples = currentSamples;
    }

    return {
        budgetHit,
        clearance: Math.sqrt(nearestDistanceSquared),
        crossesTrail
    };
}

function doesSamplePathCrossSelfTrail(previousSamples, currentSamples, trailSegments, diagnostics = null) {
    if (!Array.isArray(trailSegments) || trailSegments.length === 0) {
        return false;
    }

    for (let index = 0; index < previousSamples.length; index++) {
        if (doesSegmentCrossSelfTrail(previousSamples[index], currentSamples[index], trailSegments, diagnostics)) {
            return true;
        }
    }

    return false;
}

function doesSegmentCrossSelfTrail(startPoint, endPoint, trailSegments, diagnostics = null) {
    if (arePointsEqual(startPoint, endPoint)) {
        return false;
    }

    let checkedSegmentCount = 0;

    for (const trailSegment of trailSegments) {
        checkedSegmentCount++;
        if (segmentsCross(startPoint, endPoint, trailSegment.start, trailSegment.end)) {
            addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentCrossCheckCount", checkedSegmentCount);
            return true;
        }
    }

    addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentCrossCheckCount", checkedSegmentCount);
    return false;
}

function createBoundsAroundPoint(point, radius) {
    const safeRadius = Number.isFinite(radius) && radius > 0
        ? radius
        : config.world.playerSize;

    return {
        maxX: point.x + safeRadius,
        maxY: point.y + safeRadius,
        minX: point.x - safeRadius,
        minY: point.y - safeRadius
    };
}

function filterPointsByBounds(points, bounds) {
    if (!Array.isArray(points) || points.length === 0) {
        return [];
    }

    return points.filter(point => isPointInBounds(point, bounds));
}

function filterSegmentsByBounds(segments, bounds) {
    if (!Array.isArray(segments) || segments.length === 0) {
        return [];
    }

    return segments.filter(segment => (
        segment
        && isFinitePoint(segment.start)
        && isFinitePoint(segment.end)
        && doBoundsOverlap(getSegmentBounds(segment.start, segment.end), bounds)
    ));
}

function isPointInBounds(point, bounds) {
    return isFinitePoint(point)
        && point.x >= bounds.minX
        && point.x <= bounds.maxX
        && point.y >= bounds.minY
        && point.y <= bounds.maxY;
}

function getSegmentBounds(start, end) {
    return {
        maxX: Math.max(start.x, end.x),
        maxY: Math.max(start.y, end.y),
        minX: Math.min(start.x, end.x),
        minY: Math.min(start.y, end.y)
    };
}

function doBoundsOverlap(firstBounds, secondBounds) {
    return firstBounds.minX <= secondBounds.maxX + geometryEpsilon
        && firstBounds.maxX + geometryEpsilon >= secondBounds.minX
        && firstBounds.minY <= secondBounds.maxY + geometryEpsilon
        && firstBounds.maxY + geometryEpsilon >= secondBounds.minY;
}

function createSelfTrailAvoidanceSamplePoints(position, angle) {
    const halfWidth = config.world.playerSize / 2;
    const normal = {
        x: -Math.sin(angle),
        y: Math.cos(angle)
    };

    return [
        position,
        {
            x: position.x + normal.x * halfWidth,
            y: position.y + normal.y * halfWidth
        },
        {
            x: position.x - normal.x * halfWidth,
            y: position.y - normal.y * halfWidth
        }
    ];
}

function getSelfTrailSimulationRotationBlend(bot, deltaTime) {
    const elapsedTicks = deltaTime * config.loop.tickRate;
    const movement = getBotMovementConfig(bot);

    return clamp(1 - Math.pow(1 - movement.rotationStrength, elapsedTicks), 0, 1);
}

function getBotMovementSpeed(bot) {
    const speed = Number(getBotMovementConfig(bot).speed);

    return Number.isFinite(speed) && speed > 0 ? speed : config.movement.speed;
}

function getBotMovementConfig(bot) {
    const movement = bot && bot.runtimeConfig && bot.runtimeConfig.movement;
    const rotationStrength = Number(movement && movement.rotationStrength);

    return {
        rotationStrength: Number.isFinite(rotationStrength)
            ? clamp(rotationStrength, 0, 1)
            : config.movement.rotationStrength,
        speed: movement && movement.speed
    };
}

function getSelfTrailLookaheadDistance(options = {}) {
    if (Number.isFinite(options.selfTrailLookaheadDistance) && options.selfTrailLookaheadDistance > 0) {
        return Math.min(options.selfTrailLookaheadDistance, getBotSelfTrailTrapLookaheadMaxDistance());
    }

    const decisionDistance = config.movement.speed * (config.bots.decisionIntervalMs / 1000) * 2.5;
    const targetDistance = Number.isFinite(options.targetDistance)
        ? Math.min(options.targetDistance, config.world.mapRadius)
        : 0;
    const uncappedDistance = Math.max(config.world.playerSize * 3.5, decisionDistance, targetDistance);

    return Math.min(uncappedDistance, getBotSelfTrailLookaheadMaxDistance());
}

function getSelfTrailLookaheadSampleCount(lookaheadDistance) {
    const distance = Number.isFinite(lookaheadDistance)
        ? lookaheadDistance
        : getSelfTrailLookaheadDistance();

    return Math.max(6, Math.ceil(distance / config.world.playerSize));
}

function getSelfTrailClearanceRecentPointSkip() {
    return Math.max(10, Math.ceil((config.world.playerSize * 4) / config.territory.trailPointSpacing));
}

function getSelfTrailCollisionRecentPointSkip() {
    return Math.max(4, Math.ceil((config.world.playerSize * 1.2) / config.territory.trailPointSpacing));
}

function getTrailPointsCached(context, player, options = {}) {
    if (!context || !context.trailPointCache || !player) {
        return getTrailPoints(player, options);
    }

    const skipRecent = Number.isFinite(options.skipRecent) ? options.skipRecent : 0;
    const cacheKey = `${player.id}:${skipRecent}`;

    if (!context.trailPointCache.has(cacheKey)) {
        context.trailPointCache.set(cacheKey, getTrailPoints(player, options));
    }

    return context.trailPointCache.get(cacheKey);
}

function getSelfTrailSegmentsCached(context, player, options = {}) {
    if (!context || !context.selfTrailSegmentCache || !player) {
        return getSelfTrailSegments(player, options);
    }

    const skipRecent = Number.isFinite(options.skipRecent) ? options.skipRecent : 0;
    const cacheKey = `${player.id}:${skipRecent}`;

    if (!context.selfTrailSegmentCache.has(cacheKey)) {
        context.selfTrailSegmentCache.set(cacheKey, getSelfTrailSegments(player, options));
    }

    return context.selfTrailSegmentCache.get(cacheKey);
}

function getTrailPoints(player, options = {}) {
    const points = [];
    const skipRecent = Number.isFinite(options.skipRecent)
        ? Math.max(0, Math.floor(options.skipRecent))
        : 0;

    appendTrailPoints(points, player.trailLeftSegments, skipRecent);
    appendTrailPoints(points, player.trailRightSegments, skipRecent);

    return points;
}

function getSelfTrailSegments(player, options = {}) {
    const segments = [];

    appendSelfTrailSegments(segments, player.trailLeftSegments, options.skipRecent);
    appendSelfTrailSegments(segments, player.trailRightSegments, options.skipRecent);

    return segments;
}

function appendTrailPoints(target, segments, skipRecent = 0) {
    if (!Array.isArray(segments)) {
        return;
    }

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];

        if (!Array.isArray(segment)) {
            continue;
        }

        const isLastSegment = segmentIndex === segments.length - 1;
        const usablePointCount = isLastSegment
            ? Math.max(0, segment.length - skipRecent)
            : segment.length;

        for (let pointIndex = 0; pointIndex < usablePointCount; pointIndex++) {
            const point = segment[pointIndex];

            if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
                target.push(point);
            }
        }
    }
}

function appendSelfTrailSegments(target, segments, skipRecent = 0) {
    if (!Array.isArray(segments)) {
        return;
    }

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];

        if (!Array.isArray(segment) || segment.length < 2) {
            continue;
        }

        const isLastSegment = segmentIndex === segments.length - 1;
        const usablePointCount = isLastSegment
            ? Math.max(0, segment.length - skipRecent)
            : segment.length;

        for (let pointIndex = 0; pointIndex < usablePointCount - 1; pointIndex++) {
            const start = segment[pointIndex];
            const end = segment[pointIndex + 1];

            if (isFinitePoint(start) && isFinitePoint(end)) {
                target.push({ start, end });
            }
        }
    }
}

function isFinitePoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}

function hasAnyTrail(player) {
    return getTrailPoints(player).length >= 2;
}

function segmentsCross(firstStart, firstEnd, secondStart, secondEnd) {
    if (!doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd)) {
        return false;
    }

    const firstDirection = subtractPoints(firstEnd, firstStart);
    const secondDirection = subtractPoints(secondEnd, secondStart);
    const denominator = crossProduct(firstDirection, secondDirection);

    if (Math.abs(denominator) <= geometryEpsilon) {
        return false;
    }

    const startDelta = subtractPoints(secondStart, firstStart);
    const firstT = crossProduct(startDelta, secondDirection) / denominator;
    const secondT = crossProduct(startDelta, firstDirection) / denominator;

    return firstT > geometryEpsilon
        && firstT <= 1 + geometryEpsilon
        && secondT > geometryEpsilon
        && secondT < 1 - geometryEpsilon;
}

function doSegmentBoundsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(Math.min(firstStart.x, firstEnd.x), Math.min(secondStart.x, secondEnd.x))
        <= Math.min(Math.max(firstStart.x, firstEnd.x), Math.max(secondStart.x, secondEnd.x)) + geometryEpsilon
        && Math.max(Math.min(firstStart.y, firstEnd.y), Math.min(secondStart.y, secondEnd.y))
        <= Math.min(Math.max(firstStart.y, firstEnd.y), Math.max(secondStart.y, secondEnd.y)) + geometryEpsilon;
}

function subtractPoints(first, second) {
    return {
        x: first.x - second.x,
        y: first.y - second.y
    };
}

function crossProduct(first, second) {
    return first.x * second.y - first.y * second.x;
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

function clampPointToMap(point) {
    const radius = Math.hypot(point.x, point.y);
    const limit = config.world.mapRadius - config.world.playerSize;

    if (radius <= limit) {
        return point;
    }

    const scale = limit / radius;

    return {
        x: point.x * scale,
        y: point.y * scale
    };
}

function getBotAi(bot) {
    if (!bot.botAi) {
        bot.botAi = {
            expansionPlan: null,
            orbitDirection: Math.random() < 0.5 ? -1 : 1,
            orbitPhase: Math.random() * Math.PI * 2,
            selfTrailEscapeAngle: null,
            selfTrailEscapeUntilMs: 0
        };
    }

    return bot.botAi;
}

function pruneMissingBotIds(state, players) {
    for (const botId of state.botIds) {
        if (!players.has(botId)) {
            state.botIds.delete(botId);
        }
    }
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

function isBotPlayer(player) {
    return Boolean(player && (player.isBot || String(player.id || "").startsWith(BOT_ID_PREFIX)));
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
    BOT_ID_PREFIX,
    createBotManager,
    getBotPlayerCount,
    getTargetBotCount,
    getHumanPlayerCount,
    isBotPlayer
};
