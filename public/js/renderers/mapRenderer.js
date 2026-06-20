import {
    getMapPalette,
    isDarkVisualTheme
} from "../visualTheme.js";
import { isPerformanceMode } from "../renderSettings.js";

export function drawMapLayer(context, worldConfig, gameConfig) {
    const borderWidth = 15;
    const palette = getMapPalette(gameConfig);

    context.beginPath();
    context.arc(0, 0, worldConfig.mapRadius, 0, Math.PI * 2);
    context.fillStyle = palette.fill;
    context.fill();

    if (isDarkVisualTheme(gameConfig)) {
        const performanceMode = isPerformanceMode(gameConfig);

        context.save();
        context.beginPath();
        context.arc(0, 0, worldConfig.mapRadius + borderWidth / 2, 0, Math.PI * 2);
        context.globalAlpha = performanceMode ? 0.9 : 0.72;
        context.lineWidth = performanceMode ? borderWidth * 2.8 : borderWidth * 1.5;
        context.strokeStyle = performanceMode ? palette.glow : palette.border;

        if (!performanceMode) {
            context.shadowColor = palette.border;
            context.shadowBlur = 36;
        }

        context.stroke();
        context.restore();
    }

    context.beginPath();
    context.arc(0, 0, worldConfig.mapRadius + borderWidth / 2, 0, Math.PI * 2);
    context.globalAlpha = 1;
    context.lineWidth = borderWidth;
    context.strokeStyle = palette.border;
    context.stroke();
}
