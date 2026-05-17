const config = require("../config/gameConfig");
const { isPointOwnedByPlayer } = require("../state/territories");
const { distanceBetween } = require("../utils/math");
const { captureClosedTrail } = require("./dominationSystem");

function updateTrails(players, territories) {
    for (const player of players.values()) {
        updatePlayerTrail(player, territories);
    }
}

function updatePlayerTrail(player, territories) {
    const isInOwnTerritory = isPointOwnedByPlayer(territories, player.id, player.x, player.y);

    if (isInOwnTerritory) {
        closeTrailIfNeeded(player, territories);
        player.lastSafeTerritoryPoint = createTrailSample(player);
        return;
    }

    updateActiveTrail(player);
}

function closeTrailIfNeeded(player, territories) {
    if (!player.isDrawingTrail) {
        return;
    }

    addTrailSample(player, true);
    captureClosedTrail(player, territories);
    clearTrail(player);
}

function updateActiveTrail(player) {
    if (!player.isDrawingTrail) {
        startTrail(player);
    }

    addTrailPointIfNeeded(player);
}

function startTrail(player) {
    player.isDrawingTrail = true;
    clearTrailPoints(player);

    for (const sample of getInitialTrailSamples(player)) {
        appendTrailSample(player, sample);
    }
}

function addTrailPointIfNeeded(player) {
    const lastPoint = player.trailPoints[player.trailPoints.length - 1];

    if (!lastPoint || shouldAddTrailPoint(player, lastPoint)) {
        addTrailSample(player);
    }
}

function shouldAddTrailPoint(player, lastPoint) {
    return distanceBetween(player.x, player.y, lastPoint.x, lastPoint.y) >= config.territory.trailPointSpacing;
}

function getInitialTrailSamples(player) {
    const currentSample = createTrailSample(player);
    const previousSample = player.lastSafeTerritoryPoint;

    if (!previousSample || distanceBetween(previousSample.x, previousSample.y, currentSample.x, currentSample.y) <= Number.EPSILON) {
        return [currentSample];
    }

    return [
        normalizeTrailSample(previousSample),
        currentSample
    ];
}

function addTrailSample(player, force = false) {
    const sample = createTrailSample(player);
    const lastPoint = player.trailPoints[player.trailPoints.length - 1];

    if (!force && lastPoint && !shouldAddTrailPoint(player, lastPoint)) {
        return;
    }

    if (lastPoint && distanceBetween(sample.x, sample.y, lastPoint.x, lastPoint.y) <= Number.EPSILON) {
        return;
    }

    appendTrailSample(player, sample);
}

function appendTrailSample(player, sample) {
    const normalizedSample = normalizeTrailSample(sample);

    player.trailPoints.push({
        x: normalizedSample.x,
        y: normalizedSample.y
    });
    player.trailLeftPoints.push(normalizedSample.leftPoint);
    player.trailRightPoints.push(normalizedSample.rightPoint);
}

function createTrailSample(player) {
    const halfWidth = config.world.playerSize / 2;
    const normal = getPlayerNormal(player.angle);

    return {
        x: player.x,
        y: player.y,
        angle: player.angle,
        leftPoint: {
            x: player.x + normal.x * halfWidth,
            y: player.y + normal.y * halfWidth
        },
        rightPoint: {
            x: player.x - normal.x * halfWidth,
            y: player.y - normal.y * halfWidth
        }
    };
}

function normalizeTrailSample(sample) {
    if (sample.leftPoint && sample.rightPoint) {
        return {
            x: sample.x,
            y: sample.y,
            angle: sample.angle,
            leftPoint: clonePoint(sample.leftPoint),
            rightPoint: clonePoint(sample.rightPoint)
        };
    }

    const halfWidth = config.world.playerSize / 2;
    const normal = getPlayerNormal(sample.angle || 0);

    return {
        x: sample.x,
        y: sample.y,
        angle: sample.angle || 0,
        leftPoint: {
            x: sample.x + normal.x * halfWidth,
            y: sample.y + normal.y * halfWidth
        },
        rightPoint: {
            x: sample.x - normal.x * halfWidth,
            y: sample.y - normal.y * halfWidth
        }
    };
}

function clearTrail(player) {
    player.isDrawingTrail = false;
    clearTrailPoints(player);
}

function clearTrailPoints(player) {
    player.trailPoints = [];
    player.trailLeftPoints = [];
    player.trailRightPoints = [];
}

function serializeTrails(players) {
    const serializedTrails = {};

    for (const player of players.values()) {
        if (!player.trailPoints || player.trailPoints.length < 2) {
            continue;
        }

        const samples = getSerializedTrailSamples(player);

        serializedTrails[player.id] = {
            id: player.id,
            color: player.color,
            points: samples.points,
            leftPoints: samples.leftPoints,
            rightPoints: samples.rightPoints
        };
    }

    return serializedTrails;
}

function getSerializedTrailSamples(player) {
    const points = serializePoints(player.trailPoints);
    const leftPoints = serializePoints(player.trailLeftPoints);
    const rightPoints = serializePoints(player.trailRightPoints);
    const lastPoint = points[points.length - 1];

    if (!lastPoint || distanceBetween(player.x, player.y, lastPoint.x, lastPoint.y) > Number.EPSILON) {
        const currentSample = createTrailSample(player);

        points.push({
            x: currentSample.x,
            y: currentSample.y
        });
        leftPoints.push(currentSample.leftPoint);
        rightPoints.push(currentSample.rightPoint);
    }

    return {
        points,
        leftPoints,
        rightPoints
    };
}

function serializePoints(points) {
    return points.map(clonePoint);
}

function clonePoint(point) {
    return {
        x: point.x,
        y: point.y
    };
}

function getPlayerNormal(angle) {
    return {
        x: -Math.sin(angle),
        y: Math.cos(angle)
    };
}

module.exports = {
    clearTrail,
    createTrailSample,
    serializeTrails,
    updatePlayerTrail,
    updateTrails
};
