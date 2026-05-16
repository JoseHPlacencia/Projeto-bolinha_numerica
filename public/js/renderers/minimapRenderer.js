export function createMinimapRenderer(canvas, gameConfig) {
    const ctx = canvas.getContext("2d");
    const SIZE = canvas.width;
    const scale = (SIZE / 2) / gameConfig.world.mapRadius;
    const cx = SIZE / 2;
    const cy = SIZE / 2;

    return { render };

    function render(state, currentPlayerId) {
        const currentPlayer = state[currentPlayerId];

        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.save();

        ctx.beginPath();
        ctx.arc(cx, cy, cx, 0, Math.PI * 2);
        ctx.clip();

        ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
        ctx.fillRect(0, 0, SIZE, SIZE);

        ctx.beginPath();
        ctx.arc(cx, cy, gameConfig.world.mapRadius * scale, 0, Math.PI * 2);
        ctx.fillStyle = "#d8d8d8";
        ctx.fill();

        if (currentPlayer) {
            const baseX = cx + currentPlayer.baseX * scale;
            const baseY = cy + currentPlayer.baseY * scale;
            const baseR = Math.max(3, gameConfig.world.baseRadius * scale);

            ctx.globalAlpha = 0.45;
            ctx.beginPath();
            ctx.arc(baseX, baseY, baseR, 0, Math.PI * 2);
            ctx.fillStyle = currentPlayer.color;
            ctx.fill();
            ctx.globalAlpha = 1;

            const mx = cx + currentPlayer.x * scale;
            const my = cy + currentPlayer.y * scale;

            ctx.beginPath();
            ctx.arc(mx, my, 5, 0, Math.PI * 2);
            ctx.fillStyle = currentPlayer.color;
            ctx.fill();

            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#fff";
            ctx.stroke();
        }

        ctx.restore();

        ctx.beginPath();
        ctx.arc(cx, cy, cx - 1, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
        ctx.stroke();
    }
}
