export function drawPlayerLayer(context, state, currentPlayer, currentPlayerId) {
    for (const player of Object.values(state)) {
        if (player.id !== currentPlayerId) {
            drawPlayer(context, player);
        }
    }

    drawPlayer(context, currentPlayer);
}

function drawPlayer(context, player) {
    context.save();

    context.translate(player.x, player.y);
    context.rotate(player.angle);

    context.fillStyle = "rgba(0,0,0,.12)";
    context.fillRect(-30, -30, 70, 70);

    context.fillStyle = player.color;
    context.fillRect(-35, -35, 70, 70);

    context.lineWidth = 4;
    context.strokeStyle = "#000";
    context.strokeRect(-35, -35, 70, 70);

    context.fillStyle = "#fff";
    context.fillRect(18, -23, 12, 12);
    context.fillRect(18, 11, 12, 12);

    context.fillStyle = "#000";
    context.fillRect(24, -20, 6, 6);
    context.fillRect(24, 14, 6, 6);

    context.restore();
}
