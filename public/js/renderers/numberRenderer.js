import { isPerformanceMode } from "../renderSettings.js";
import { isDarkVisualTheme } from "../visualTheme.js";

const NUMBER_RADIUS = 44;
const NUMBER_RING_WIDTH = 4;
const NEARBY_HALO_RADIUS = NUMBER_RADIUS + 9;
const NEARBY_DISTANCE_SQUARED = 450 ** 2;
const FULL_CIRCLE_RADIANS = Math.PI * 2;

function getNumberColors(colorSeed, numberId, darkTheme) {
    const seed = Number.isSafeInteger(colorSeed) && colorSeed >= 0
        ? colorSeed
        : Math.abs(Number(numberId) || 0);
    const hue = seed % 360;

    return darkTheme
        ? {
            accent: `hsl(${hue} 92% 68%)`,
            fill: `hsl(${hue} 72% 18%)`,
            text: `hsl(${hue} 55% 88%)`
        }
        : {
            accent: `hsl(${hue} 78% 32%)`,
            fill: `hsl(${hue} 76% 88%)`,
            text: `hsl(${hue} 65% 24%)`
        };
}

export function drawNumberLayer(context, numbers, viewportBounds, gameConfig, currentPlayer = null) {
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
        const [numberId, x, y, display, , colorSeed] = number;

        if (x + padding < minX || x - padding > maxX || y + padding < minY || y - padding > maxY) {
            continue;
        }

        const colors = getNumberColors(
            colorSeed,
            numberId,
            darkTheme
        );
        const isNearby = isNearPlayer(x, y, currentPlayer);

        if (isNearby) {
            context.save();
            context.globalAlpha = darkTheme ? 0.48 : 0.34;
            context.beginPath();
            context.arc(x, y, NEARBY_HALO_RADIUS, 0, FULL_CIRCLE_RADIANS);
            context.lineWidth = 2;
            context.strokeStyle = colors.accent;
            context.stroke();
            context.restore();
        }

        if (!performanceMode) {
            context.shadowColor = colors.accent;
            context.shadowBlur = darkTheme ? 24 : 12;
        }

        context.beginPath();
        context.arc(x, y, NUMBER_RADIUS, 0, FULL_CIRCLE_RADIANS);
        context.fillStyle = colors.fill;
        context.fill();

        context.lineWidth = NUMBER_RING_WIDTH;
        context.strokeStyle = colors.accent;
        context.stroke();
        context.shadowColor = "transparent";
        context.shadowBlur = 0;

        context.font = `700 ${getNumberFontSize(display)}px Play,sans-serif`;
        context.lineJoin = "round";
        context.lineWidth = 2.5;
        context.strokeStyle = darkTheme
            ? "rgba(0, 0, 0, 0.88)"
            : "rgba(255, 255, 255, 0.92)";
        context.strokeText(display, x, y);
        context.fillStyle = colors.text;
        context.fillText(display, x, y);
    }

    context.restore();
}

function getNumberFontSize(display) {
    const textLength = String(display).length;

    if (textLength > 4) {
        return 20;
    }
    if (textLength > 3) {
        return 23;
    }
    if (textLength > 2) {
        return 26;
    }

    return 30;
}

function isNearPlayer(x, y, player) {
    if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) {
        return false;
    }

    const deltaX = x - player.x;
    const deltaY = y - player.y;

    return deltaX * deltaX + deltaY * deltaY <= NEARBY_DISTANCE_SQUARED;
}
