const config = require("../config/gameConfig");
const { createPlayer } = require("../entities/player");
const { initializePlayerTerritory, isPointOwnedByPlayer } = require("../state/territories");
const { clamp, distanceBetween, lerpAngle } = require("../utils/math");

const BOT_ID_PREFIX = "bot:";
const geometryEpsilon = 1e-7;

function createBotManager({ roomCode, players, territories, numberSystem, botCount = null, botDifficulty = null }) {
    const state = {
        botCount,
        botDifficulty,
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

        while (state.botIds.size < getTargetBotCount(state)) {
            const bot = createBot(roomCode, players, territories, state.nextBotNumber++, state.botDifficulty);
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

function createBot(roomCode, players, territories, botNumber, botDifficulty = null) {
    const botConfig = config.bots;
    const botNames = getBotNames(botConfig);
    const nameIndex = (botNumber - 1) % botNames.length;
    const colorIndex = (botNumber - 1) % botConfig.colors.length;
    const bot = createPlayer(players, `${BOT_ID_PREFIX}${roomCode}:${botNumber}`, territories, {
        color: botConfig.colors[colorIndex],
        difficulty: botDifficulty || botConfig.difficulty,
        isBot: true,
        name: botNames[nameIndex]
    });

    bot.botAi = {
        expansionPlan: null,
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

    const targetAngle = Math.atan2(target.y - bot.y, target.x - bot.x);
    const targetDistance = distanceBetween(bot.x, bot.y, target.x, target.y);
    const decision = chooseSelfTrailSafeAngle(bot, targetAngle, {
        allowReverse: isReturnTarget(bot, target),
        targetDistance
    });
    const angle = applyDecisionNoise(decision.angle, {
        avoidingSelfTrail: decision.avoidingSelfTrail
    });

    bot.setDirectionAngle(angle, "bot");
}

function chooseBotTarget(bot, players, territories, numberSystem) {
    const correctNumbers = getCorrectNumbers(bot, territories, numberSystem);
    const nearestCorrect = findNearestPoint(bot, correctNumbers);
    const pendingTarget = choosePendingEliminationTarget(bot, correctNumbers);

    if (pendingTarget) {
        return pendingTarget;
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

function getExpansionTarget(bot) {
    const ai = getBotAi(bot);
    const distanceFromBase = distanceBetween(bot.x, bot.y, bot.territoryX, bot.territoryY);

    if (!hasAnyTrail(bot) && !bot.isLeftTrailActive && !bot.isRightTrailActive) {
        ai.expansionPlan = null;
    }

    const plan = getExpansionPlan(bot, ai, distanceFromBase);

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
        return getReturnTarget(bot);
    }

    return getReturnTarget(bot);
}

function getExpansionPlan(bot, ai, distanceFromBase) {
    if (ai.expansionPlan) {
        return ai.expansionPlan;
    }

    ai.expansionPlan = {
        arcRadians: getExpansionArcRadians(bot),
        direction: ai.orbitDirection,
        phase: "outbound",
        radius: getExpansionRadius(bot),
        startAngle: getBaseRelativeAngle(bot, distanceFromBase)
    };

    ai.orbitDirection *= Math.random() < 0.28 ? -1 : 1;
    return ai.expansionPlan;
}

function getExpansionPlanPoint(bot, angle, radius) {
    return clampPointToMap({
        x: bot.territoryX + Math.cos(angle) * radius,
        y: bot.territoryY + Math.sin(angle) * radius
    });
}

function getExpansionRadius(bot) {
    const balanceBonus = Math.min(Math.max(bot.catchBalance - 1, 0), 4) * 0.09;
    const radius = config.bots.captureLoopRadius * (1.24 + balanceBonus);
    const maxRadius = config.world.mapRadius * 0.52;

    return Math.min(radius, maxRadius);
}

function getExpansionArcRadians(bot) {
    const balanceBonus = Math.min(Math.max(bot.catchBalance - 1, 0), 3) * 0.08;

    return 1.65 + balanceBonus;
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

function getReturnTarget(player) {
    return {
        x: player.territoryX,
        y: player.territoryY
    };
}

function isReturnTarget(bot, target) {
    return Boolean(target)
        && distanceBetween(target.x, target.y, bot.territoryX, bot.territoryY) <= config.world.playerSize;
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

function getNearestDistanceSquared(origin, points) {
    let nearestDistanceSquared = Infinity;

    for (const point of points || []) {
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
    return distanceBetween(player.x, player.y, target.x, target.y) / config.movement.speed;
}

function applyDecisionNoise(angle, options = {}) {
    if (!options.avoidingSelfTrail && Math.random() < config.bots.mistakeChance) {
        return angle + (Math.random() * 2 - 1) * Math.PI * 0.65;
    }

    const noiseScale = options.avoidingSelfTrail ? 0.25 : 1;

    return angle + (Math.random() * 2 - 1) * config.bots.angleNoiseRadians * noiseScale;
}

function chooseSelfTrailSafeAngle(bot, targetAngle, options = {}) {
    const trailPoints = getTrailPoints(bot, { skipRecent: getSelfTrailClearanceRecentPointSkip() });
    const trailSegments = getSelfTrailSegments(bot, { skipRecent: getSelfTrailCollisionRecentPointSkip() });

    if ((trailPoints.length === 0 && trailSegments.length === 0) || !Number.isFinite(targetAngle)) {
        return {
            angle: targetAngle,
            avoidingSelfTrail: false
        };
    }

    const targetSafety = getSelfTrailPathSafety(bot, targetAngle, trailPoints, trailSegments, options);

    if (!isSelfTrailPathUnsafe(targetSafety)) {
        return {
            angle: targetAngle,
            avoidingSelfTrail: false
        };
    }

    const candidates = createSelfTrailAvoidanceCandidates(bot, targetAngle, options);
    let bestAnyCandidate = {
        angle: targetAngle,
        safety: targetSafety,
        score: scoreSelfTrailCandidate(targetAngle, targetAngle, targetSafety, options)
    };
    let bestNonCrossingCandidate = targetSafety.crossesTrail
        ? null
        : bestAnyCandidate;

    for (const angle of candidates) {
        const safety = getSelfTrailPathSafety(bot, angle, trailPoints, trailSegments, options);
        const score = scoreSelfTrailCandidate(angle, targetAngle, safety, options);

        if (score > bestAnyCandidate.score) {
            bestAnyCandidate = {
                angle,
                safety,
                score
            };
        }

        if (!safety.crossesTrail && (!bestNonCrossingCandidate || score > bestNonCrossingCandidate.score)) {
            bestNonCrossingCandidate = {
                angle,
                safety,
                score
            };
        }
    }

    const bestCandidate = bestNonCrossingCandidate
        || chooseLocalSelfTrailEscapeCandidate(bot, targetAngle, trailPoints, trailSegments, candidates, options)
        || bestAnyCandidate;

    return {
        angle: bestCandidate.angle,
        avoidingSelfTrail: true
    };
}

function scoreSelfTrailCandidate(angle, targetAngle, safety, options = {}) {
    const targetPenaltyScale = options.allowReverse ? 0.35 : 0.85;
    const targetPenalty = Math.abs(getAngleDelta(angle, targetAngle))
        * config.bots.selfTrailAvoidDistance
        * targetPenaltyScale;
    const crossPenalty = safety.crossesTrail ? config.world.mapRadius * 10 : 0;
    const clearanceScore = Number.isFinite(safety.clearance)
        ? safety.clearance * 4
        : config.bots.selfTrailAvoidDistance * 4;

    return clearanceScore - targetPenalty - crossPenalty;
}

function createSelfTrailAvoidanceCandidates(bot, targetAngle, options = {}) {
    const returnTarget = getReturnTarget(bot);
    const returnAngle = Math.atan2(returnTarget.y - bot.y, returnTarget.x - bot.x);
    const baseAngles = options.allowReverse
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

    return candidates;
}

function chooseLocalSelfTrailEscapeCandidate(bot, targetAngle, trailPoints, trailSegments, candidates, options = {}) {
    const localOptions = {
        ...options,
        targetDistance: Math.max(config.world.playerSize * 4, config.bots.selfTrailAvoidDistance)
    };
    let bestCandidate = null;

    for (const angle of candidates) {
        const safety = getSelfTrailPathSafety(bot, angle, trailPoints, trailSegments, localOptions);

        if (safety.crossesTrail) {
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
    return safety.crossesTrail
        || safety.clearance < config.bots.selfTrailAvoidDistance * thresholdScale;
}

function getSelfTrailPathSafety(bot, targetAngle, trailPoints, trailSegments, options = {}) {
    let position = {
        x: bot.x,
        y: bot.y
    };
    let angle = bot.angle;
    let nearestDistanceSquared = Infinity;
    let crossesTrail = false;
    const lookaheadDistance = getSelfTrailLookaheadDistance(options);
    const sampleCount = getSelfTrailLookaheadSampleCount(lookaheadDistance);
    const stepDistance = lookaheadDistance / sampleCount;
    const stepDeltaTime = stepDistance / config.movement.speed;
    let previousSamples = createSelfTrailAvoidanceSamplePoints(position, angle);

    for (let index = 0; index < sampleCount; index++) {
        angle = lerpAngle(angle, targetAngle, getSelfTrailSimulationRotationBlend(stepDeltaTime));
        position = clampPointToMap({
            x: position.x + Math.cos(angle) * stepDistance,
            y: position.y + Math.sin(angle) * stepDistance
        });

        const currentSamples = createSelfTrailAvoidanceSamplePoints(position, angle);

        if (!crossesTrail && doesSamplePathCrossSelfTrail(previousSamples, currentSamples, trailSegments)) {
            crossesTrail = true;
        }

        for (const samplePoint of currentSamples) {
            nearestDistanceSquared = Math.min(
                nearestDistanceSquared,
                getNearestDistanceSquared(samplePoint, trailPoints)
            );
        }

        previousSamples = currentSamples;
    }

    return {
        clearance: Math.sqrt(nearestDistanceSquared),
        crossesTrail
    };
}

function doesSamplePathCrossSelfTrail(previousSamples, currentSamples, trailSegments) {
    if (!Array.isArray(trailSegments) || trailSegments.length === 0) {
        return false;
    }

    for (let index = 0; index < previousSamples.length; index++) {
        if (doesSegmentCrossSelfTrail(previousSamples[index], currentSamples[index], trailSegments)) {
            return true;
        }
    }

    return false;
}

function doesSegmentCrossSelfTrail(startPoint, endPoint, trailSegments) {
    if (arePointsEqual(startPoint, endPoint)) {
        return false;
    }

    for (const trailSegment of trailSegments) {
        if (segmentsCross(startPoint, endPoint, trailSegment.start, trailSegment.end)) {
            return true;
        }
    }

    return false;
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

function getSelfTrailSimulationRotationBlend(deltaTime) {
    const elapsedTicks = deltaTime * config.loop.tickRate;

    return clamp(1 - Math.pow(1 - config.movement.rotationStrength, elapsedTicks), 0, 1);
}

function getSelfTrailLookaheadDistance(options = {}) {
    const decisionDistance = config.movement.speed * (config.bots.decisionIntervalMs / 1000) * 2.5;
    const targetDistance = Number.isFinite(options.targetDistance)
        ? Math.min(options.targetDistance, config.world.mapRadius)
        : 0;

    return Math.max(config.world.playerSize * 3.5, decisionDistance, targetDistance);
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

function getTrailPoints(player, options = {}) {
    const points = [];

    appendTrailPoints(points, player.trailLeftSegments);
    appendTrailPoints(points, player.trailRightSegments);

    if (!options.skipRecent || points.length <= options.skipRecent) {
        return points;
    }

    return points.slice(0, points.length - options.skipRecent);
}

function getSelfTrailSegments(player, options = {}) {
    const segments = [];

    appendSelfTrailSegments(segments, player.trailLeftSegments, options.skipRecent);
    appendSelfTrailSegments(segments, player.trailRightSegments, options.skipRecent);

    return segments;
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
    getHumanPlayerCount,
    isBotPlayer
};
