const config = require("../config/gameConfig");
const { reconnectPlayerAsNew } = require("../entities/player");
const {
    initializePlayerTerritory
} = require("../state/territories");
const {
    calculatePolygonArea,
    calculatePolygonCentroid,
    getPolygonBounds,
    isCircleInsidePolygon
} = require("../utils/geometry");

const gridSideSamples = 41;

function relocatePlayersAfterTerritoryChange(players, territories, playerIds) {
    for (const playerId of playerIds || []) {
        const player = players.get(playerId);

        if (!player) {
            continue;
        }

        relocatePlayerAfterTerritoryChange(players, territories, player);
    }
}

function relocatePlayerAfterTerritoryChange(players, territories, player) {
    const territory = territories.get(player.id);

    if (!territory || calculatePolygonArea(territory.polygon) <= 0) {
        reconnectPlayerWithNewTerritory(players, territories, player);
        return;
    }

    const point = findSpawnPointInsideTerritory(territory.polygon);

    if (!point) {
        reconnectPlayerWithNewTerritory(players, territories, player);
        return;
    }

    player.setSpawnPoint(point);
    territory.baseX = point.x;
    territory.baseY = point.y;
    territory.color = player.color;
}

function reconnectPlayerWithNewTerritory(players, territories, player) {
    reconnectPlayerAsNew(players, player, territories);
    initializePlayerTerritory(territories, player);
}

function findSpawnPointInsideTerritory(polygon) {
    const bounds = getPolygonBounds(polygon);

    if (!bounds) {
        return null;
    }

    const center = calculatePolygonCentroid(polygon) || getBoundsCenter(bounds);

    if (isPlayerFullyInsideTerritory(polygon, center)) {
        return center;
    }

    return findClosestGridPointInsideTerritory(polygon, bounds, center);
}

function findClosestGridPointInsideTerritory(polygon, bounds, center) {
    let closestPoint = null;
    let closestDistanceSquared = Infinity;
    const stepX = getGridStep(bounds.minX, bounds.maxX);
    const stepY = getGridStep(bounds.minY, bounds.maxY);

    for (let row = 0; row < gridSideSamples; row++) {
        const y = interpolateBoundsValue(bounds.minY, bounds.maxY, row, gridSideSamples);

        for (let column = 0; column < gridSideSamples; column++) {
            const x = interpolateBoundsValue(bounds.minX, bounds.maxX, column, gridSideSamples);
            const point = { x, y };

            if (!isPlayerFullyInsideTerritory(polygon, point)) {
                continue;
            }

            const distanceSquared = getDistanceSquared(point, center);

            if (distanceSquared < closestDistanceSquared) {
                closestPoint = point;
                closestDistanceSquared = distanceSquared;
            }
        }
    }

    return closestPoint
        ? refineClosestPointInsideTerritory(polygon, center, closestPoint, stepX, stepY)
        : null;
}

function refineClosestPointInsideTerritory(polygon, center, startPoint, initialStepX, initialStepY) {
    let closestPoint = startPoint;
    let closestDistanceSquared = getDistanceSquared(startPoint, center);
    let stepX = initialStepX / 2;
    let stepY = initialStepY / 2;

    for (let iteration = 0; iteration < 5; iteration++) {
        for (let yOffset = -1; yOffset <= 1; yOffset++) {
            for (let xOffset = -1; xOffset <= 1; xOffset++) {
                const point = {
                    x: closestPoint.x + xOffset * stepX,
                    y: closestPoint.y + yOffset * stepY
                };

                if (!isPlayerFullyInsideTerritory(polygon, point)) {
                    continue;
                }

                const distanceSquared = getDistanceSquared(point, center);

                if (distanceSquared < closestDistanceSquared) {
                    closestPoint = point;
                    closestDistanceSquared = distanceSquared;
                }
            }
        }

        stepX /= 2;
        stepY /= 2;
    }

    return closestPoint;
}

function getGridStep(min, max) {
    if (gridSideSamples <= 1) {
        return 0;
    }

    return (max - min) / (gridSideSamples - 1);
}

function getBoundsCenter(bounds) {
    return {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2
    };
}

function interpolateBoundsValue(min, max, index, count) {
    if (count <= 1) {
        return (min + max) / 2;
    }

    return min + (max - min) * (index / (count - 1));
}

function isPlayerFullyInsideTerritory(polygon, point) {
    return isCircleInsidePolygon(
        polygon,
        point.x,
        point.y,
        config.world.playerSize / 2
    );
}

function getDistanceSquared(first, second) {
    const deltaX = first.x - second.x;
    const deltaY = first.y - second.y;

    return deltaX * deltaX + deltaY * deltaY;
}

module.exports = {
    findSpawnPointInsideTerritory,
    relocatePlayersAfterTerritoryChange
};
