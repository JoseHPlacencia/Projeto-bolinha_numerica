export function drawTerritoryLayer(context, state, worldConfig) {
    for (const player of Object.values(state)) {
        drawInitialTerritory(context, player, worldConfig);
        drawPlayerTerritory(context, player);
    }
}

function drawInitialTerritory(context, player, worldConfig) {
    context.globalAlpha = 0.66;
    context.fillStyle = player.color;

    context.beginPath();
    context.arc(
        player.territoryX,
        player.territoryY,
        worldConfig.initialTerritoryRadius,
        0,
        Math.PI * 2
    );
    context.fill();

    context.globalAlpha = 1;
    context.lineWidth = 6;
    context.strokeStyle = player.color;

    context.beginPath();
    context.arc(
        player.territoryX,
        player.territoryY,
        worldConfig.initialTerritoryRadius,
        0,
        Math.PI * 2
    );
    context.stroke();
}

function drawPlayerTerritory(context, player) {
    if (!Array.isArray(player.territory)) {
        return;
    }

    for (const polygon of player.territory) {
        drawPolygon(context, polygon, player.color);
    }
}

function drawPolygon(context, polygon, color) {
    if (!Array.isArray(polygon) || polygon.length < 3) {
        return;
    }

    context.save();
    context.globalAlpha = 0.22;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(polygon[0].x, polygon[0].y);

    for (let index = 1; index < polygon.length; index++) {
        context.lineTo(polygon[index].x, polygon[index].y);
    }

    context.closePath();
    context.fill();
    context.restore();
}
