const config = require("../config/gameConfig");
const {
    calculatePolygonArea,
    calculatePolygonCentroid,
    doBoundsContainPoint,
    getPolygonBounds,
    isCircleInsidePolygon
} = require("../utils/geometry");

const coarseGridSideSamples = 17;
const gridSideSamples = 41;

function relocatePlayersAfterTerritoryChange(players, territories, playerIds) {
    const noRespawnPlayerIds = new Set();

    for (const playerId of playerIds || []) {
        const player = players.get(playerId);

        if (!player) {
            continue;
        }

        if (!relocatePlayerAfterTerritoryChange(territories, player)) {
            noRespawnPlayerIds.add(player.id);
        }
    }

    return noRespawnPlayerIds;
}

function relocatePlayerAfterTerritoryChange(territories, player) {
    const territory = territories.get(player.id);

    if (!territory || getTerritoryArea(territory) <= 0) {
        return false;
    }

    const currentSpawnPoint = {
        x: player.territoryX,
        y: player.territoryY
    };
    const territoryBounds = getTerritoryBounds(territory);

    if (isPlayerFullyInsideTerritory(territory.polygon, currentSpawnPoint, territoryBounds)) {
        territory.baseX = currentSpawnPoint.x;
        territory.baseY = currentSpawnPoint.y;
        territory.color = player.color;
        return true;
    }

    const point = findSpawnPointInsideTerritory(territory.polygon, {
        bounds: territoryBounds,
        preferredPoints: [
            currentSpawnPoint,
            {
                x: territory.baseX,
                y: territory.baseY
            }
        ]
    });

    if (!point) {
        return false;
    }

    player.setSpawnPoint(point);
    territory.baseX = point.x;
    territory.baseY = point.y;
    territory.color = player.color;
    return true;
}

function findSpawnPointInsideTerritory(polygon, options = {}) {
    const bounds = options.bounds || getPolygonBounds(polygon);

    if (!bounds) {
        return null;
    }

    const center = calculatePolygonCentroid(polygon) || getBoundsCenter(bounds);
    const preferredPoints = [
        ...(Array.isArray(options.preferredPoints) ? options.preferredPoints : []),
        center,
        getBoundsCenter(bounds)
    ];

    for (const point of preferredPoints) {
        if (isPlayerFullyInsideTerritory(polygon, point, bounds)) {
            return point;
        }
    }

    return findClosestGridPointInsideTerritory(polygon, bounds, center, coarseGridSideSamples)
        || findClosestGridPointInsideTerritory(polygon, bounds, center, gridSideSamples);
}

function findClosestGridPointInsideTerritory(polygon, bounds, center, sampleCount) {
    let closestPoint = null;
    let closestDistanceSquared = Infinity;
    const stepX = getGridStep(bounds.minX, bounds.maxX, sampleCount);
    const stepY = getGridStep(bounds.minY, bounds.maxY, sampleCount);

    for (let row = 0; row < sampleCount; row++) {
        const y = interpolateBoundsValue(bounds.minY, bounds.maxY, row, sampleCount);

        for (let column = 0; column < sampleCount; column++) {
            const x = interpolateBoundsValue(bounds.minX, bounds.maxX, column, sampleCount);
            const point = { x, y };

            if (!isPlayerFullyInsideTerritory(polygon, point, bounds)) {
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

function getGridStep(min, max, sampleCount) {
    if (sampleCount <= 1) {
        return 0;
    }

    return (max - min) / (sampleCount - 1);
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

function isPlayerFullyInsideTerritory(polygon, point, bounds = null) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return false;
    }

    if (bounds && !doBoundsContainPoint(bounds, point.x, point.y)) {
        return false;
    }

    return isCircleInsidePolygon(
        polygon,
        point.x,
        point.y,
        config.world.playerSize / 2
    );
}

function getTerritoryArea(territory) {
    return Number.isFinite(territory && territory.area)
        ? territory.area
        : calculatePolygonArea(territory && territory.polygon);
}

function getTerritoryBounds(territory) {
    return territory && territory.bounds
        ? territory.bounds
        : getPolygonBounds(territory && territory.polygon);
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
