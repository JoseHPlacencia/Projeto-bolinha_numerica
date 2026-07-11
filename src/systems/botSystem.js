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
const { clamp, distanceBetween } = require("../utils/math");
const {
    addBotTargetingDiagnosticValue,
    createBotUpdateDiagnostics,
    createEmptyBotDiagnostics,
    getMaxBotDecisionsPerTick,
    getSlowestBotPhase,
    measureBotPhase
} = require("./botDiagnostics");
const { createBotRouteSafety } = require("./botRouteSafety");
const {
    getPointBoundsDistanceSquared,
    getPointIndex,
    getTrailPointsCached,
    getTrailTargetIndexCached,
    hasAnyTrail,
    hasAnyTrailCached,
    isFinitePoint,
    isValidBounds
} = require("./botTrailGeometry");

const BOT_ID_PREFIX = "bot:";
const geometryEpsilon = 1e-7;

const {
    chooseSelfTrailSafeAngle,
    clampPointToMap,
    getAngleDelta,
    getBotAi,
    getSelfTrailClearanceRecentPointSkip
} = createBotRouteSafety({ getReturnTarget });

/**
 * Bot manager and targeting policy.
 *
 * Expensive data shared by every bot belongs in the decision-cycle context;
 * geometry tied to bots processed in one server tick belongs in the tick
 * context shared with botRouteSafety. See .ai/docs/ARCHITECTURE.md before moving
 * work between those scopes.
 */

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

function createBotDecisionContext(numberSystem, players) {
    const correctNumbers = getCorrectNumbers(numberSystem);

    return {
        correctNumbers,
        numberContestIndex: createNumberContestIndex(players, correctNumbers)
    };
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

function chooseBotTarget(bot, players, territories, numberSystem, context = null) {
    const diagnostics = context && context.diagnostics;
    const correctNumbers = context && Array.isArray(context.correctNumbers)
        ? context.correctNumbers
        : getCorrectNumbers(numberSystem);
    const nearestCorrect = findNearestCoordinatedCorrectNumber(bot, players, correctNumbers, bot, context);
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

    const number = findNearestCoordinatedCorrectNumber(bot, players, correctNumbers, bot, context);

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

        const targetReturnTime = estimateTravelTime(target, getReturnTargetCached(context, target, territories));

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

    return chooseMarkedCounterattackNumber(bot, players, incomingMarkers, correctNumbers, context)
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

function chooseMarkedCounterattackNumber(bot, players, incomingMarkers, correctNumbers, context = null) {
    if (!bot.pendingCatchEliminationTargets
        || bot.pendingCatchEliminationTargets.size === 0
        || !Array.isArray(correctNumbers)
        || correctNumbers.length === 0
        || !incomingMarkers.some(marker => bot.pendingCatchEliminationTargets.has(marker.id))) {
        return null;
    }

    const number = findNearestCoordinatedCorrectNumber(bot, players, correctNumbers, bot, context);

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

    const returnTime = estimateTravelTime(bot, getReturnTargetCached(context, bot, territories));
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
        || hasAnyTrailCached(context, bot)
        || !isPlayerInsideOwnTerritory(territories, bot)) {
        return null;
    }

    const diagnostics = context && context.diagnostics;
    const returnTarget = getReturnTargetCached(context, bot, territories);
    const candidates = measureBotPhase(diagnostics, "balanceCapture.candidates", () => (
        getEnemyTrailTargetCandidates(bot, players, territories, {
            baseMaxDistance: getBalanceCaptureBaseRadius(),
            basePoint: {
                x: bot.territoryX,
                y: bot.territoryY
            },
            maxDistance: getBalanceCaptureTrailRadius(),
            maxEnemyCandidates: getBalanceCaptureMaxEnemyCandidates()
        }, context)
    ));
    let bestTarget = null;

    addBotTargetingDiagnosticValue(context, "balanceCandidateCount", candidates.length);

    for (const candidate of candidates) {
        const enemy = candidate.enemy;
        const trailPoint = candidate.trailPoint;

        if (!enemy || !trailPoint || !isBalanceCaptureTrailPointInRange(bot, trailPoint)) {
            continue;
        }

        addBotTargetingDiagnosticValue(context, "balanceEnemyEvaluations", 1);
        const requiredMargin = getBalanceCaptureReturnMarginSec();
        const botCaptureTime = estimateBalanceCaptureTime(bot, trailPoint, returnTarget);
        const counterRisk = measureBotPhase(diagnostics, "balanceCapture.risk", () => (
            evaluateTrailMarkCounterattackRisk(bot, enemy, territories, trailPoint, botCaptureTime, requiredMargin, context)
        ));

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

function getBalanceCaptureMaxEnemyCandidates() {
    return getPositiveIntegerOption(config.bots.balanceCaptureMaxEnemyCandidates, 8);
}

function getHuntMaxEnemyCandidates() {
    return getPositiveIntegerOption(config.bots.huntMaxEnemyCandidates, 8);
}

function getPositiveIntegerOption(value, fallback) {
    const number = Number(value);

    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function getPositiveNumberOption(value, fallback) {
    const number = Number(value);

    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function chooseHuntTarget(bot, players, territories, correctNumbers, threat = null, context = null) {
    if (correctNumbers.length === 0) {
        return null;
    }

    const diagnostics = context && context.diagnostics;
    const candidates = measureBotPhase(diagnostics, "hunt.candidates", () => (
        getEnemyTrailTargetCandidates(bot, players, territories, {
            maxDistance: config.bots.huntRadius,
            maxEnemyCandidates: getHuntMaxEnemyCandidates()
        }, context)
    ));
    let bestHunt = null;

    addBotTargetingDiagnosticValue(context, "huntCandidateCount", candidates.length);

    for (const candidate of candidates) {
        const enemy = candidate.enemy;
        const enemyTrailPoint = candidate.trailPoint;

        if (!enemy || !enemyTrailPoint) {
            continue;
        }

        addBotTargetingDiagnosticValue(context, "huntEnemyEvaluations", 1);
        const number = findNearestCoordinatedCorrectNumber(bot, players, correctNumbers, enemyTrailPoint, context);

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
        const preliminaryEnemyReturnTime = estimateTravelTime(enemy, getReturnTargetCached(context, enemy, territories));
        const requiredMargin = getHuntRequiredMargin(bot, enemy, threat, preliminaryEnemyReturnTime);
        const counterRisk = markPoint
            ? measureBotPhase(diagnostics, "hunt.risk", () => (
                evaluateTrailMarkCounterattackRisk(bot, enemy, territories, markPoint, botTime, requiredMargin, context)
            ))
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

function evaluateTrailMarkCounterattackRisk(bot, enemy, territories, trailPoint, confirmTime, requiredMargin = 0, context = null) {
    const enemyReturnTime = estimateTravelTime(enemy, getReturnTargetCached(context, enemy, territories));

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

function getReturnTargetCached(context, player, territories = null) {
    if (!context || !context.returnTargetCache || !player) {
        return getReturnTarget(player, territories);
    }

    if (context.returnTargetCache.has(player.id)) {
        addBotTargetingDiagnosticValue(context, "returnTargetCacheHitCount", 1);
        return context.returnTargetCache.get(player.id);
    }

    addBotTargetingDiagnosticValue(context, "returnTargetCacheMissCount", 1);
    const target = getReturnTarget(player, territories);

    context.returnTargetCache.set(player.id, target);
    return target;
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

function distanceSquaredBetween(first, second) {
    if (!isFinitePoint(first) || !isFinitePoint(second)) {
        return Infinity;
    }

    const deltaX = first.x - second.x;
    const deltaY = first.y - second.y;

    return deltaX * deltaX + deltaY * deltaY;
}

function findNearestCoordinatedCorrectNumber(bot, players, correctNumbers, origin = bot, context = null) {
    return findNearestPoint(
        origin || bot,
        getCoordinatedCorrectNumbersForBot(bot, players, correctNumbers, context)
    );
}

function getCoordinatedCorrectNumbersForBot(bot, players, correctNumbers, context = null) {
    if (!Array.isArray(correctNumbers) || correctNumbers.length === 0) {
        return [];
    }

    if (!bot || !players || typeof players.values !== "function") {
        return correctNumbers;
    }

    if (context && context.coordinatedCorrectNumbersCache) {
        const cacheKey = bot.id;

        if (context.coordinatedCorrectNumbersCache.has(cacheKey)) {
            addBotTargetingDiagnosticValue(context, "coordinatedNumberCacheHitCount", 1);
            return context.coordinatedCorrectNumbersCache.get(cacheKey);
        }

        addBotTargetingDiagnosticValue(context, "coordinatedNumberCacheMissCount", 1);
        const coordinatedNumbers = getUncachedCoordinatedCorrectNumbersForBot(
            bot,
            players,
            correctNumbers,
            context
        );

        context.coordinatedCorrectNumbersCache.set(cacheKey, coordinatedNumbers);
        return coordinatedNumbers;
    }

    return getUncachedCoordinatedCorrectNumbersForBot(bot, players, correctNumbers, context);
}

function getUncachedCoordinatedCorrectNumbersForBot(bot, players, correctNumbers, context = null) {
    return correctNumbers.filter(number => (
        !isNumberClearlyClaimedByCloserBot(bot, players, number, context && context.numberContestIndex)
    ));
}

function isNumberClearlyClaimedByCloserBot(bot, players, number, contestIndex = null) {
    if (!isFinitePoint(bot) || !isFinitePoint(number)) {
        return false;
    }

    const botDistance = distanceBetween(bot.x, bot.y, number.x, number.y);
    const indexedCompetitor = getIndexedNumberCompetitor(contestIndex, number, bot.id);

    if (indexedCompetitor) {
        return isClearlyCloserToNumber(indexedCompetitor.distance, botDistance);
    }

    for (const player of players.values()) {
        if (!player
            || player.id === bot.id
            || !isNumberContestantBot(player)
            || !isFinitePoint(player)) {
            continue;
        }

        const otherDistance = distanceBetween(player.x, player.y, number.x, number.y);

        if (isClearlyCloserToNumber(otherDistance, botDistance)) {
            return true;
        }
    }

    return false;
}

function createNumberContestIndex(players, correctNumbers) {
    const index = new Map();

    if (!players || typeof players.values !== "function" || !Array.isArray(correctNumbers)) {
        return index;
    }

    const contestants = [...players.values()].filter(player => (
        isNumberContestantBot(player) && isFinitePoint(player)
    ));

    for (const number of correctNumbers) {
        if (!isFinitePoint(number)) {
            continue;
        }

        let closestDistance = Infinity;
        let closestPlayerId = null;
        let secondClosestDistance = Infinity;
        let secondClosestPlayerId = null;

        for (const contestant of contestants) {
            const distance = distanceBetween(contestant.x, contestant.y, number.x, number.y);

            if (distance < closestDistance) {
                secondClosestDistance = closestDistance;
                secondClosestPlayerId = closestPlayerId;
                closestDistance = distance;
                closestPlayerId = contestant.id;
            } else if (distance < secondClosestDistance) {
                secondClosestDistance = distance;
                secondClosestPlayerId = contestant.id;
            }
        }

        index.set(number, {
            closest: createNumberContestant(closestPlayerId, closestDistance),
            secondClosest: createNumberContestant(secondClosestPlayerId, secondClosestDistance)
        });
    }

    return index;
}

function createNumberContestant(playerId, distance) {
    return playerId === null ? null : { distance, playerId };
}

function getIndexedNumberCompetitor(contestIndex, number, botId) {
    if (!(contestIndex instanceof Map)) {
        return null;
    }

    const entry = contestIndex.get(number);

    if (!entry || !entry.closest) {
        return null;
    }

    return entry.closest.playerId === botId
        ? entry.secondClosest
        : entry.closest;
}

function isNumberContestantBot(player) {
    return isBotPlayer(player)
        && player.lives !== 0
        && (
            player.catchBalance <= 0
            || Boolean(player.pendingCatchEliminationTargets && player.pendingCatchEliminationTargets.size > 0)
        );
}

function isClearlyCloserToNumber(otherDistance, botDistance) {
    if (!Number.isFinite(otherDistance)
        || !Number.isFinite(botDistance)
        || otherDistance >= botDistance) {
        return false;
    }

    return botDistance - otherDistance >= getNumberContestAdvantageDistance()
        || otherDistance <= botDistance * getNumberContestAdvantageRatio();
}

function getNumberContestAdvantageDistance() {
    const distance = Number(config.bots.numberContestAdvantageDistance);

    return Number.isFinite(distance) && distance >= 0 ? distance : config.world.playerSize * 2;
}

function getNumberContestAdvantageRatio() {
    const ratio = Number(config.bots.numberContestAdvantageRatio);

    return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : 0.75;
}

function getEnemyTrailTargetCandidates(bot, players, territories, options = {}, context = null) {
    const summaries = getEnemyTrailTargetSummaries(bot, players, options, context);
    const candidates = [];

    for (const summary of summaries) {
        const trailPoint = findNearestMarkableTrailPoint(
            bot,
            territories,
            summary.pointIndex,
            options,
            context
        );

        if (!trailPoint) {
            continue;
        }

        candidates.push({
            enemy: summary.enemy,
            trailPoint
        });
    }

    return candidates;
}

function getEnemyTrailTargetSummaries(bot, players, options = {}, context = null) {
    const summaries = [];
    const maxEnemyCandidates = getPositiveIntegerOption(options.maxEnemyCandidates, Infinity);

    if (!players || typeof players.values !== "function") {
        return summaries;
    }

    for (const enemy of players.values()) {
        if (!enemy
            || enemy.id === bot.id
            || enemy.lives === 0) {
            continue;
        }

        const pointIndex = getTrailTargetIndexCached(context, enemy);

        if (!pointIndex || pointIndex.points.length < 2) {
            continue;
        }

        const boundsDistanceSquared = getTargetQueryBoundsDistanceSquared(bot, pointIndex.bounds, options);

        if (!Number.isFinite(boundsDistanceSquared)) {
            addBotTargetingDiagnosticValue(context, "trailBlockBoundsRejected", 1);
            continue;
        }

        summaries.push({
            boundsDistanceSquared,
            enemy,
            pointIndex
        });
    }

    summaries.sort((first, second) => first.boundsDistanceSquared - second.boundsDistanceSquared);

    return Number.isFinite(maxEnemyCandidates)
        ? summaries.slice(0, maxEnemyCandidates)
        : summaries;
}

function getTargetQueryBoundsDistanceSquared(bot, bounds, options = {}) {
    if (!isValidBounds(bounds)) {
        return Infinity;
    }

    const maxDistance = getPositiveNumberOption(options.maxDistance, Infinity);
    const maxDistanceSquared = maxDistance * maxDistance;
    const originDistanceSquared = getPointBoundsDistanceSquared(bot, bounds);

    if (originDistanceSquared > maxDistanceSquared + geometryEpsilon) {
        return Infinity;
    }

    const basePoint = isFinitePoint(options.basePoint) ? options.basePoint : null;
    const baseMaxDistance = getPositiveNumberOption(options.baseMaxDistance, Infinity);

    if (basePoint) {
        const baseDistanceSquared = getPointBoundsDistanceSquared(basePoint, bounds);

        if (baseDistanceSquared > baseMaxDistance * baseMaxDistance + geometryEpsilon) {
            return Infinity;
        }

        return Math.max(originDistanceSquared, baseDistanceSquared);
    }

    return originDistanceSquared;
}

function findNearestMarkableTrailPoint(bot, territories, trailPointsOrIndex, options = {}, context = null) {
    const territoryPolygon = getReturnTerritoryPolygon(bot, territories);
    let territoryRejectedCount = 0;

    if (!territoryPolygon) {
        return findNearestTrailPointByQuery(bot, trailPointsOrIndex, options, context);
    }

    const trailPoint = findNearestTrailPointByQuery(bot, trailPointsOrIndex, {
        ...options,
        predicate: point => {
            const markable = isTrailPointMarkableByBot(territoryPolygon, point);

            if (!markable) {
                territoryRejectedCount++;
            }

            return markable;
        }
    }, context);

    addBotTargetingDiagnosticValue(context, "trailPointTerritoryRejected", territoryRejectedCount);

    return trailPoint;
}

function isTrailPointMarkableByBot(territoryPolygon, point) {
    return isFinitePoint(point)
        && !isPointInPolygon(territoryPolygon, point.x, point.y);
}

function findNearestTrailPointByQuery(origin, pointIndexOrPoints, options = {}, context = null) {
    const pointIndex = getPointIndex(pointIndexOrPoints);
    const sourcePoints = pointIndex
        ? pointIndex.points
        : pointIndexOrPoints || [];
    const maxDistance = getPositiveNumberOption(options.maxDistance, Infinity);
    const maxDistanceSquared = maxDistance * maxDistance;
    const basePoint = isFinitePoint(options.basePoint) ? options.basePoint : null;
    const baseMaxDistance = getPositiveNumberOption(options.baseMaxDistance, Infinity);
    const baseMaxDistanceSquared = baseMaxDistance * baseMaxDistance;
    const predicate = typeof options.predicate === "function"
        ? options.predicate
        : null;
    let nearest = null;
    let nearestDistanceSquared = Infinity;
    let blockChecks = 0;
    let blockBoundsRejected = 0;
    let pointChecks = 0;
    let pointDistanceRejected = 0;

    if (pointIndex && pointIndex.blocks.length > 0) {
        const orderedBlocks = [];

        for (const block of pointIndex.blocks) {
            blockChecks++;
            const blockDistanceSquared = getPointBoundsDistanceSquared(origin, block.bounds);

            if (blockDistanceSquared > maxDistanceSquared + geometryEpsilon) {
                blockBoundsRejected++;
                continue;
            }

            if (basePoint
                && getPointBoundsDistanceSquared(basePoint, block.bounds) > baseMaxDistanceSquared + geometryEpsilon) {
                blockBoundsRejected++;
                continue;
            }

            orderedBlocks.push({
                block,
                distanceSquared: blockDistanceSquared
            });
        }

        orderedBlocks.sort((first, second) => first.distanceSquared - second.distanceSquared);

        for (const item of orderedBlocks) {
            if (item.distanceSquared > nearestDistanceSquared + geometryEpsilon) {
                blockBoundsRejected++;
                continue;
            }

            for (const point of item.block.points) {
                pointChecks++;

                if (!isFinitePoint(point)) {
                    continue;
                }

                const distanceSquared = distanceSquaredBetween(origin, point);

                if (distanceSquared > maxDistanceSquared + geometryEpsilon
                    || (basePoint && distanceSquaredBetween(basePoint, point) > baseMaxDistanceSquared + geometryEpsilon)) {
                    pointDistanceRejected++;
                    continue;
                }

                if (predicate && !predicate(point)) {
                    continue;
                }

                if (distanceSquared < nearestDistanceSquared) {
                    nearest = point;
                    nearestDistanceSquared = distanceSquared;
                }
            }
        }

        addBotTargetingDiagnosticValue(context, "trailBlockChecks", blockChecks);
        addBotTargetingDiagnosticValue(context, "trailBlockBoundsRejected", blockBoundsRejected);
        addBotTargetingDiagnosticValue(context, "trailPointChecks", pointChecks);
        addBotTargetingDiagnosticValue(context, "trailPointDistanceRejected", pointDistanceRejected);

        return nearest;
    }

    for (const point of sourcePoints) {
        pointChecks++;

        if (!isFinitePoint(point)) {
            continue;
        }

        const distanceSquared = distanceSquaredBetween(origin, point);

        if (distanceSquared > maxDistanceSquared + geometryEpsilon
            || (basePoint && distanceSquaredBetween(basePoint, point) > baseMaxDistanceSquared + geometryEpsilon)) {
            pointDistanceRejected++;
            continue;
        }

        if (predicate && !predicate(point)) {
            continue;
        }

        if (distanceSquared < nearestDistanceSquared) {
            nearest = point;
            nearestDistanceSquared = distanceSquared;
        }
    }

    addBotTargetingDiagnosticValue(context, "trailPointChecks", pointChecks);
    addBotTargetingDiagnosticValue(context, "trailPointDistanceRejected", pointDistanceRejected);

    return nearest;
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
    createBotManager,
    getBotPlayerCount,
    getTargetBotCount,
    getHumanPlayerCount,
    isBotPlayer
};
