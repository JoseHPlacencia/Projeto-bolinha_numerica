// ─── Frustum Culling ─────────────────────────────────────────
function _isVisible(x, y, radius, viewport) {
    if (!viewport) return true;
    return x + radius > viewport.minX && x - radius < viewport.maxX &&
           y + radius > viewport.minY && y - radius < viewport.maxY;
}

export function drawPlayerLayer(context, state, currentPlayer, currentPlayerId, viewport) {
    const PLAYER_CULL_RADIUS = 50; // um pouco maior que o sprite (35px half-size)

    for (const player of Object.values(state)) {
        if (player.id === currentPlayerId) continue;
        if (!_isVisible(player.x, player.y, PLAYER_CULL_RADIUS, viewport)) continue;
        drawPlayer(context, player);
    }

    // Jogador local sempre renderizado (câmera centralizada nele)
    drawPlayer(context, currentPlayer);
}

function drawPlayer(context, player) {
    context.save();

    context.translate(player.x, player.y);
    context.rotate(player.angle);

    // Sombra
    context.fillStyle = "rgba(0,0,0,.12)";
    context.fillRect(-30, -30, 70, 70);

    // Corpo
    context.fillStyle = player.color;
    context.fillRect(-35, -35, 70, 70);

    // Borda
    context.lineWidth   = 4;
    context.strokeStyle = "#000";
    context.strokeRect(-35, -35, 70, 70);

    // Olhos
    context.fillStyle = "#fff";
    context.fillRect(18, -23, 12, 12);
    context.fillRect(18,  11, 12, 12);

    context.fillStyle = "#000";
    context.fillRect(24, -20, 6, 6);
    context.fillRect(24,  14, 6, 6);

    context.restore();
}
