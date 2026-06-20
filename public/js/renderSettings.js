export const DEFAULT_FPS_LIMIT = 60;
export const DEFAULT_PERFORMANCE_MODE = true;

const ALLOWED_FPS_LIMITS = new Set([0, 30, 60, 120]);

export function normalizeFpsLimit(value) {
    const fpsLimit = Number(value);

    return ALLOWED_FPS_LIMITS.has(fpsLimit)
        ? fpsLimit
        : DEFAULT_FPS_LIMIT;
}

export function isPerformanceMode(gameConfig) {
    const value = gameConfig && gameConfig.renderingSettings
        ? gameConfig.renderingSettings.performanceMode
        : undefined;

    return typeof value === "boolean"
        ? value
        : DEFAULT_PERFORMANCE_MODE;
}

export function getRenderFrameIntervalMs(gameConfig) {
    const fpsLimit = normalizeFpsLimit(
        gameConfig && gameConfig.renderingSettings
            ? gameConfig.renderingSettings.fpsLimit
            : DEFAULT_FPS_LIMIT
    );

    return fpsLimit > 0 ? 1000 / fpsLimit : 0;
}
