const config = require("../config/gameConfig");

/**
 * Navigation primitives shared by target selection and route safety.
 *
 * Keeping these helpers independent prevents either policy from importing the
 * other and makes the bot AI state ownership explicit.
 */

function getAngleDelta(fromAngle, toAngle) {
    return Math.atan2(
        Math.sin(toAngle - fromAngle),
        Math.cos(toAngle - fromAngle)
    );
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

function getSelfTrailClearanceRecentPointSkip() {
    return Math.max(10, Math.ceil((config.world.playerSize * 4) / config.territory.trailPointSpacing));
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

module.exports = {
    applyDecisionNoise,
    clampPointToMap,
    getAngleDelta,
    getBotAi,
    getSelfTrailClearanceRecentPointSkip
};
