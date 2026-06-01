/**
 * numberRenderer.js
<<<<<<< HEAD
 * Renderiza os números espalhados no mapa.
 */

const NUMBER_RADIUS = 38;
const FONT_LARGE  = "bold 26px Arial";
const FONT_SMALL  = "bold 20px Arial";
const GLOW_BLUR   = 18;

export function drawNumberLayer(context, state) {
    if (!state.numbers || !state.numbers.numeros) return;

    const tema = state.numbers.tema;

    for (const num of state.numbers.numeros) {
        drawNumero(context, num, tema);
    }
}

function drawNumero(context, num, tema) {
    const { x, y, display, cor } = num;
    const pertence = tema ? pertenceAoTema(num.conjuntos, tema.id) : false;

    context.save();
    context.translate(x, y);

    // Glow para números que pertencem ao tema atual
    if (pertence) {
        context.shadowBlur  = GLOW_BLUR;
        context.shadowColor = cor;
    }

    // Círculo de fundo
    context.beginPath();
    context.arc(0, 0, NUMBER_RADIUS, 0, Math.PI * 2);
    context.fillStyle = hexToRgba(cor, 0.22);
    context.fill();

    // Borda
    context.lineWidth = pertence ? 3.5 : 2;
    context.strokeStyle = cor;
    context.stroke();

    // Reset glow para o texto
    context.shadowBlur = 0;

    // Texto do número
    const font = display.length > 4 ? FONT_SMALL : FONT_LARGE;
    context.font = font;
    context.fillStyle = "#fff";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(display, 0, 0);

    context.restore();
}

// ── Helpers ──────────────────────────────────────────────────

function pertenceAoTema(conjuntos, temaId) {
    if (!conjuntos || !temaId) return false;
    switch (temaId) {
        case "naturais":    return conjuntos.includes("naturais");
        case "inteiros":    return conjuntos.includes("inteiros");
        case "negativos":   return conjuntos.includes("negativos");
        case "positivos":   return conjuntos.includes("positivos");
        case "pares":       return conjuntos.includes("pares");
        case "impares":     return conjuntos.includes("impares");
        case "racionais":   return conjuntos.includes("racionais") && !conjuntos.includes("racionais_nao");
        case "irracionais": return conjuntos.includes("irracionais");
        default:            return false;
    }
}

function hexToRgba(color, alpha) {
    // Supports hsl(...) passthrough and hex
    if (color.startsWith("hsl")) {
        return color.replace("hsl", "hsla").replace(")", `, ${alpha})`);
    }
    if (color.startsWith("#")) {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
=======
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
>>>>>>> 70aca42 (teste)
}
