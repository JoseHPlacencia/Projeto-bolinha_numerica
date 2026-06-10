const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { initializePlayerTerritory, isPointOwnedByPlayer } = require("../state/territories");
const { distanceBetween } = require("../utils/math");

const BOT_ID_PREFIX = "bot:";

function createBotManager({ roomCode, players, territories, numberSystem }) {
    const state = {
        botIds: new Set(),
        lastDecisionAt: Number.NEGATIVE_INFINITY,
        nextBotNumber: 1
    };

    return {
        ensureBots,
        update
    };

    function ensureBots() {
        pruneMissingBotIds(state, players);

        if (!config.bots.enabled) {
            return;
        }

        while (state.botIds.size < getTargetBotCount()) {
            const bot = createBot(roomCode, players, territories, state.nextBotNumber++);
            state.botIds.add(bot.id);
        }
    }

    function update(nowMs) {
        ensureBots();

        if (nowMs - state.lastDecisionAt < config.bots.decisionIntervalMs) {
            return;
        }

        state.lastDecisionAt = nowMs;

        for (const botId of state.botIds) {
            const bot = players.get(botId);

            if (!bot) {
                continue;
            }

            updateBotDecision(bot, players, territories, numberSystem);
        }
    }
}

function createBot(roomCode, players, territories, botNumber) {
    const botConfig = config.bots;
    const nameIndex = (botNumber - 1) % botConfig.names.length;
    const colorIndex = (botNumber - 1) % botConfig.colors.length;
    const bot = createPlayer(players, `${BOT_ID_PREFIX}${roomCode}:${botNumber}`, territories, {
        color: botConfig.colors[colorIndex],
        difficulty: botConfig.difficulty,
        isBot: true,
        name: botConfig.names[nameIndex]
    });

    bot.botAi = {
        orbitDirection: Math.random() < 0.5 ? -1 : 1,
        orbitPhase: Math.random() * Math.PI * 2
    };
    initializePlayerTerritory(territories, bot);

    return bot;
}

function updateBotDecision(bot, players, territories, numberSystem) {
    const target = chooseBotTarget(bot, players, territories, numberSystem);

    if (!target) {
        bot.clearDirectionAngle();
        return;
    }

    const angle = applyDecisionNoise(Math.atan2(target.y - bot.y, target.x - bot.x));
    bot.setDirectionAngle(angle, "bot");
}

function chooseBotTarget(bot, players, territories, numberSystem) {
    const correctNumbers = getCorrectNumbers(bot, territories, numberSystem);
    const nearestCorrect = findNearestPoint(bot, correctNumbers);
    const pendingTarget = choosePendingEliminationTarget(bot, correctNumbers);

    if (pendingTarget) {
        return pendingTarget;
    }

    if (shouldAvoidOwnTrail(bot)) {
        return getReturnTarget(bot);
    }

    const threat = evaluateThreat(bot, players, correctNumbers);

    if (bot.catchBalance <= 0) {
        return nearestCorrect || getWanderTarget(bot);
    }

    if (threat.isThreatened) {
        return getReturnTarget(bot);
    }

    const huntTarget = chooseHuntTarget(bot, players, correctNumbers);

    if (huntTarget && Math.random() >= config.bots.mistakeChance) {
        return huntTarget;
    }

    if (threat.canExpand) {
        return getExpansionTarget(bot);
    }

    return getReturnTarget(bot);
}

function choosePendingEliminationTarget(bot, correctNumbers) {
    if (!bot.pendingCatchEliminationTargets || bot.pendingCatchEliminationTargets.size === 0) {
        return null;
    }

    return findNearestPoint(bot, correctNumbers);
}

function getCorrectNumbers(bot, territories, numberSystem) {
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
        .filter(number => theme.check(number))
        .filter(number => !isPointOwnedByPlayer(territories, bot.id, number.x, number.y));
}

function evaluateThreat(bot, players, correctNumbers) {
    const trailPoints = getTrailPoints(bot);

    if (trailPoints.length === 0 || correctNumbers.length === 0) {
        return {
            canExpand: true,
            isThreatened: false,
            marginSec: Infinity
        };
    }

    const returnTime = estimateTravelTime(bot, getReturnTarget(bot));
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
                + distanceBetween(trailPoint.x, trailPoint.y, number.x, number.y)) / config.movement.speed
        );
    }

    return bestTime;
}

function chooseHuntTarget(bot, players, correctNumbers) {
    if (correctNumbers.length === 0) {
        return null;
    }

    let bestHunt = null;

    for (const enemy of players.values()) {
        if (enemy.id === bot.id || !hasAnyTrail(enemy)) {
            continue;
        }

        const enemyTrailPoint = findNearestPoint(bot, getTrailPoints(enemy));

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
                + distanceBetween(enemyTrailPoint.x, enemyTrailPoint.y, number.x, number.y)) / config.movement.speed;
        const enemyReturnTime = estimateTravelTime(enemy, getReturnTarget(enemy));

        if (botTime + config.bots.huntMarginSec >= enemyReturnTime) {
            continue;
        }

        if (!bestHunt || botTime < bestHunt.time) {
            bestHunt = {
                target: hasPendingTarget ? number : enemyTrailPoint,
                time: botTime
            };
        }
    }

    return bestHunt && bestHunt.target;
}

function shouldAvoidOwnTrail(bot) {
    const trailPoints = getTrailPoints(bot, { skipRecent: 10 });

    if (trailPoints.length === 0) {
        return false;
    }

    const projectedPoint = {
        x: bot.x + Math.cos(bot.angle) * config.world.playerSize * 2,
        y: bot.y + Math.sin(bot.angle) * config.world.playerSize * 2
    };

    return getNearestDistance(projectedPoint, trailPoints) < config.bots.selfTrailAvoidDistance;
}

function getExpansionTarget(bot) {
    const ai = getBotAi(bot);
    const distanceFromBase = distanceBetween(bot.x, bot.y, bot.territoryX, bot.territoryY);

    if (distanceFromBase > config.bots.captureLoopRadius * 1.65) {
        return getReturnTarget(bot);
    }

    const baseAngle = distanceFromBase > 1
        ? Math.atan2(bot.y - bot.territoryY, bot.x - bot.territoryX)
        : ai.orbitPhase;
    const radius = config.bots.captureLoopRadius * (bot.catchBalance > 1 ? 1.15 : 1);
    const targetAngle = baseAngle + ai.orbitDirection * 1.15;

    return clampPointToMap({
        x: bot.territoryX + Math.cos(targetAngle) * radius,
        y: bot.territoryY + Math.sin(targetAngle) * radius
    });
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

function getReturnTarget(player) {
    return {
        x: player.territoryX,
        y: player.territoryY
    };
}

function findNearestPoint(origin, points) {
    let nearest = null;
    let nearestDistance = Infinity;

    for (const point of points || []) {
        const distance = distanceBetween(origin.x, origin.y, point.x, point.y);

        if (distance < nearestDistance) {
            nearest = point;
            nearestDistance = distance;
        }
    }

    return nearest;
}

function getNearestDistance(origin, points) {
    const nearest = findNearestPoint(origin, points);

    return nearest ? distanceBetween(origin.x, origin.y, nearest.x, nearest.y) : Infinity;
}

function estimateTravelTime(player, target) {
    return distanceBetween(player.x, player.y, target.x, target.y) / config.movement.speed;
}

function applyDecisionNoise(angle) {
    if (Math.random() < config.bots.mistakeChance) {
        return angle + (Math.random() * 2 - 1) * Math.PI * 0.65;
    }

    return angle + (Math.random() * 2 - 1) * config.bots.angleNoiseRadians;
}

function getTrailPoints(player, options = {}) {
    const points = [];

    appendTrailPoints(points, player.trailLeftSegments);
    appendTrailPoints(points, player.trailRightSegments);

    if (!options.skipRecent || points.length <= options.skipRecent) {
        return points;
    }

    return points.slice(0, points.length - options.skipRecent);
}

function appendTrailPoints(target, segments) {
    for (const segment of segments || []) {
        for (const point of segment || []) {
            if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
                target.push(point);
            }
        }
    }
}

function hasAnyTrail(player) {
    return getTrailPoints(player).length >= 2;
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
            orbitDirection: Math.random() < 0.5 ? -1 : 1,
            orbitPhase: Math.random() * Math.PI * 2
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

function getTargetBotCount() {
    const count = Number(config.bots.count);

    return Number.isInteger(count) && count > 0 ? count : 0;
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
    getHumanPlayerCount,
    isBotPlayer
};
