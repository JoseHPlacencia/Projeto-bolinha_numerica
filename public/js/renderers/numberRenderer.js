/**
 * numberRenderer.js
 * Renderiza números flutuantes no canvas (world-space).
 * Robusto: sem shadow (pode falhar em OffscreenCanvas), sem alocações por frame.
 */

const NUMBER_RADIUS = 44;

const COLORS = [
    ["#4ade80", "#166534"],  // natural   - verde
    ["#f87171", "#7f1d1d"],  // negativo  - vermelho
    ["#facc15", "#713f12"],  // fracao    - amarelo
    ["#60a5fa", "#1e3a8a"],  // raiz      - azul
    ["#c084fc", "#4a1d96"],  // irracional- roxo
    ["#e2e8f0", "#1e293b"]   // default   - cinza
];

function getColorIndex(display) {
    const d = String(display);
    if (/^-\d/.test(d))                         return 1; // negativo
    if (/^\d+$/.test(d))                         return 0; // natural
    if (d.includes("/"))                         return 2; // fracao
    if (d.startsWith("\u221A"))                   return 3; // raiz √
    if (d === "\u03C0" || d === "e" || d === "\u03C6" || d.startsWith("\u221A")) return 4; // irracional π φ
    return 5;
}

export function drawNumberLayer(ctx, numbers, viewportBounds) {
    if (!numbers || numbers.length === 0) return;

    if (!viewportBounds) return;
    const { minX, maxX, minY, maxY } = viewportBounds;
    const pad = NUMBER_RADIUS + 8;

    ctx.save();
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    // Disable shadow entirely - safer for OffscreenCanvas
    ctx.shadowColor   = "transparent";
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    for (const num of numbers) {
        const [, x, y, display] = num;

        // Viewport culling
        if (x + pad < minX || x - pad > maxX || y + pad < minY || y - pad > maxY) continue;

        const ci = getColorIndex(display);
        const [fg, bg] = COLORS[ci];

        // ── Círculo de fundo ──────────────────────────────────────────────────
        ctx.beginPath();
        ctx.arc(x, y, NUMBER_RADIUS, 0, 6.2832);
        ctx.fillStyle = bg;
        ctx.fill();

        // ── Anel colorido ─────────────────────────────────────────────────────
        ctx.lineWidth   = 3;
        ctx.strokeStyle = fg;
        ctx.stroke();

        // ── Texto ─────────────────────────────────────────────────────────────
        const len      = String(display).length;
        const fontSize = len > 5 ? 13 : len > 4 ? 15 : len > 3 ? 17 : len > 2 ? 19 : 22;
        ctx.font      = `900 ${fontSize}px Arial,sans-serif`;
        ctx.fillStyle = fg;
        ctx.fillText(display, x, y);
    }

    ctx.restore();
}
