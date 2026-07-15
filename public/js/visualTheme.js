export const VISUAL_THEME_LIGHT = "light";
export const VISUAL_THEME_DARK = "dark";

export function normalizeVisualTheme(theme) {
    return theme === VISUAL_THEME_LIGHT
        ? VISUAL_THEME_LIGHT
        : VISUAL_THEME_DARK;
}

export function isDarkVisualTheme(gameConfig) {
    return normalizeVisualTheme(gameConfig && gameConfig.visualTheme && gameConfig.visualTheme.mode)
        === VISUAL_THEME_DARK;
}

export function getMapPalette(gameConfig) {
    if (isDarkVisualTheme(gameConfig)) {
        return {
            border: "#38e8ff",
            fill: "#000000",
            glow: "rgba(56, 232, 255, 0.28)"
        };
    }

    return {
        border: "#222831",
        fill: "#ffffff",
        glow: "transparent"
    };
}
