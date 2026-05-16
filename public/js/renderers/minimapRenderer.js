export function drawMinimapLayer(canvas, state, currentPlayerId, worldConfig) {
    const ctx = canvas.getContext("2d");
    const SIZE = canvas.width;
    const scale = (SIZE / 2) / worldConfig.mapRadius;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const currentPlayer = state[currentPlayerId];

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();

    ctx.beginPath();
    ctx.arc(cx, cy, cx, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.beginPath();
    ctx.arc(cx, cy, worldConfig.mapRadius * scale, 0, Math.PI * 2);
    ctx.fillStyle = "#d8d8d8";
    ctx.fill();

    if (currentPlayer) {
        drawInitialTerritory(ctx, currentPlayer, worldConfig, cx, cy, scale);
        drawPlayerDot(ctx, currentPlayer, cx, cy, scale);
    }

    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, cx - 1, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.stroke();
}

function drawInitialTerritory(ctx, player, worldConfig, cx, cy, scale) {
    const territoryX = cx + player.territoryX * scale;
    const territoryY = cy + player.territoryY * scale;
    const territoryR = Math.max(3, worldConfig.initialTerritoryRadius * scale);

    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(territoryX, territoryY, territoryR, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.globalAlpha = 1;
}

function drawPlayerDot(ctx, player, cx, cy, scale) {
    const mx = cx + player.x * scale;
    const my = cy + player.y * scale;

    ctx.beginPath();
    ctx.arc(mx, my, 5, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
}
