/**
 * numberRenderer.js
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
}
