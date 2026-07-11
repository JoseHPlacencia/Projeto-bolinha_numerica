import { isPerformanceMode } from "../renderSettings.js";
import { isDarkVisualTheme } from "../visualTheme.js";

const NUMBER_RADIUS = 44;
const FULL_CIRCLE_RADIANS = Math.PI * 2;

const NUMBER_COLORS = [
    ["#4ade80", "#166534"],
    ["#f87171", "#7f1d1d"],
    ["#facc15", "#713f12"],
    ["#60a5fa", "#1e3a8a"],
    ["#c084fc", "#4a1d96"],
    ["#e2e8f0", "#1e293b"]
];

function getColorIndex(display) {
    const displayText = String(display);

    if (/^-\d/.test(displayText)) {
        return 1;
    }
    if (/^\d+$/.test(displayText)) {
        return 0;
    }
    if (displayText.includes("/")) {
        return 2;
    }
    if (displayText.startsWith("\u221A")) {
        return 3;
    }
    if (displayText === "\u03C0" || displayText === "e" || displayText === "\u03C6") {
        return 4;
    }

    return 5;
}

export function drawNumberLayer(context, numbers, viewportBounds, gameConfig) {
    if (!numbers || numbers.length === 0 || !viewportBounds) {
        return;
    }

    const { minX, maxX, minY, maxY } = viewportBounds;
    const padding = NUMBER_RADIUS + 8;
    const darkTheme = isDarkVisualTheme(gameConfig);
    const performanceMode = isPerformanceMode(gameConfig);

    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.shadowColor = "transparent";
    context.shadowBlur = 0;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;

    for (const number of numbers) {
        const [, x, y, display] = number;

        if (x + padding < minX || x - padding > maxX || y + padding < minY || y - padding > maxY) {
            continue;
        }

        const colorIndex = getColorIndex(display);
        const [foregroundColor, backgroundColor] = NUMBER_COLORS[colorIndex];

        if (darkTheme && performanceMode) {
            context.save();
            context.globalAlpha = 0.2;
            context.beginPath();
            context.arc(x, y, NUMBER_RADIUS + 9, 0, FULL_CIRCLE_RADIANS);
            context.fillStyle = foregroundColor;
            context.fill();
            context.restore();
        }

        if (darkTheme && !performanceMode) {
            context.shadowColor = foregroundColor;
            context.shadowBlur = 28;
        }

        context.beginPath();
        context.arc(x, y, NUMBER_RADIUS, 0, FULL_CIRCLE_RADIANS);
        context.fillStyle = backgroundColor;
        context.fill();

        context.lineWidth = 3;
        context.strokeStyle = foregroundColor;
        context.stroke();
        context.shadowColor = "transparent";
        context.shadowBlur = 0;

        context.font = `900 ${getNumberFontSize(display)}px Play,sans-serif`;
        context.fillStyle = foregroundColor;
        context.fillText(display, x, y);
    }

    context.restore();
}

function getNumberFontSize(display) {
    const textLength = String(display).length;

    if (textLength > 5) {
        return 13;
    }
    if (textLength > 4) {
        return 15;
    }
    if (textLength > 3) {
        return 17;
    }
    if (textLength > 2) {
        return 19;
    }

    return 22;
}
