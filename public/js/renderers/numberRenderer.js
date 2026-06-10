const NUMBER_RADIUS = 44;

const COLORS = [
    ["#4ade80", "#166534"],
    ["#f87171", "#7f1d1d"],
    ["#facc15", "#713f12"],
    ["#60a5fa", "#1e3a8a"],
    ["#c084fc", "#4a1d96"],
    ["#e2e8f0", "#1e293b"]
];

function getColorIndex(display) {
    const displayText = String(display);
    if (/^-\d/.test(displayText)) return 1;
    if (/^\d+$/.test(displayText)) return 0;
    if (displayText.includes("/")) return 2;
    if (displayText.startsWith("\u221A")) return 3;
    if (displayText === "\u03C0" || displayText === "e" || displayText === "\u03C6" || displayText.startsWith("\u221A")) return 4;
    return 5;
}

export function drawNumberLayer(ctx, numbers, viewportBounds) {
    if (!numbers || numbers.length === 0) return;

    if (!viewportBounds) return;
    const { minX, maxX, minY, maxY } = viewportBounds;
    const padding = NUMBER_RADIUS + 8;

    ctx.save();
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor   = "transparent";
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    for (const num of numbers) {
        const [, x, y, display] = num;

        if (x + padding < minX || x - padding > maxX || y + padding < minY || y - padding > maxY) continue;

        const colorIndex = getColorIndex(display);
        const [foregroundColor, backgroundColor] = COLORS[colorIndex];

        ctx.beginPath();
        ctx.arc(x, y, NUMBER_RADIUS, 0, 6.2832);
        ctx.fillStyle = backgroundColor;
        ctx.fill();

        ctx.lineWidth   = 3;
        ctx.strokeStyle = foregroundColor;
        ctx.stroke();

        const textLength = String(display).length;
        const fontSize = textLength > 5 ? 13 : textLength > 4 ? 15 : textLength > 3 ? 17 : textLength > 2 ? 19 : 22;
        ctx.font      = `900 ${fontSize}px Play,sans-serif`;
        ctx.fillStyle = foregroundColor;
        ctx.fillText(display, x, y);
    }

    ctx.restore();
}
