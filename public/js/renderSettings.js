export const DEFAULT_FPS_LIMIT = 60;
export const DEFAULT_PERFORMANCE_MODE = true;

const AUTOMATIC_FPS_LIMITS = Object.freeze([30, 60, 90, 120]);
const ALLOWED_FPS_LIMITS = new Set([0, ...AUTOMATIC_FPS_LIMITS]);
const DEFAULT_REFRESH_SAMPLE_DURATION_MS = 650;
const MINIMUM_REFRESH_SAMPLE_COUNT = 8;
const MAXIMUM_FRAME_INTERVAL_MS = 100;

export function normalizeFpsLimit(value) {
    const fpsLimit = Number(value);

    return ALLOWED_FPS_LIMITS.has(fpsLimit)
        ? fpsLimit
        : DEFAULT_FPS_LIMIT;
}

export function getClosestSupportedFpsLimit(refreshRate) {
    const normalizedRefreshRate = Number(refreshRate);

    if (!Number.isFinite(normalizedRefreshRate) || normalizedRefreshRate <= 0) {
        return DEFAULT_FPS_LIMIT;
    }

    return AUTOMATIC_FPS_LIMITS.reduce((closestLimit, candidateLimit) => (
        Math.abs(candidateLimit - normalizedRefreshRate)
            < Math.abs(closestLimit - normalizedRefreshRate)
            ? candidateLimit
            : closestLimit
    ));
}

export function detectPreferredFpsLimit(options = {}) {
    const requestFrame = options.requestAnimationFrame
        || globalThis.requestAnimationFrame?.bind(globalThis);
    const cancelFrame = options.cancelAnimationFrame
        || globalThis.cancelAnimationFrame?.bind(globalThis);
    const documentVisible = options.documentVisible !== undefined
        ? Boolean(options.documentVisible)
        : typeof document === "undefined" || document.visibilityState !== "hidden";
    const sampleDurationMs = normalizeSampleDuration(options.sampleDurationMs);

    if (typeof requestFrame !== "function" || !documentVisible) {
        return Promise.resolve(DEFAULT_FPS_LIMIT);
    }

    return new Promise(resolve => {
        const intervals = [];
        let firstTimestamp = null;
        let previousTimestamp = null;
        let pendingFrame = null;
        let settled = false;
        const timeout = setTimeout(finish, sampleDurationMs + 500);

        scheduleFrame();

        function scheduleFrame() {
            try {
                pendingFrame = requestFrame(sampleFrame);
            } catch {
                finish();
            }
        }

        function sampleFrame(timestamp) {
            pendingFrame = null;

            if (!Number.isFinite(timestamp)) {
                finish();
                return;
            }

            if (firstTimestamp === null) {
                firstTimestamp = timestamp;
            }

            if (previousTimestamp !== null) {
                const interval = timestamp - previousTimestamp;

                if (interval > 0 && interval <= MAXIMUM_FRAME_INTERVAL_MS) {
                    intervals.push(interval);
                }
            }

            previousTimestamp = timestamp;

            if (timestamp - firstTimestamp >= sampleDurationMs) {
                finish();
                return;
            }

            scheduleFrame();
        }

        function finish() {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);

            if (pendingFrame !== null && typeof cancelFrame === "function") {
                cancelFrame(pendingFrame);
            }

            resolve(getClosestSupportedFpsLimit(estimateRefreshRate(intervals)));
        }
    });
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

export function createRenderFrameLimiter(getGameConfig) {
    let lastRenderDeadline = Number.NEGATIVE_INFINITY;

    return {
        reset() {
            lastRenderDeadline = Number.NEGATIVE_INFINITY;
        },
        shouldRender(rawTimestamp) {
            const timestamp = Number(rawTimestamp);

            if (!Number.isFinite(timestamp)) return false;

            const gameConfig = typeof getGameConfig === "function"
                ? getGameConfig()
                : getGameConfig;
            const interval = getRenderFrameIntervalMs(gameConfig);

            if (interval <= 0 || !Number.isFinite(lastRenderDeadline)) {
                lastRenderDeadline = timestamp;
                return true;
            }

            const elapsed = timestamp - lastRenderDeadline;

            if (elapsed < interval - 0.5) {
                return false;
            }

            // Preserve the fractional deadline instead of snapping it to the
            // current VSync. This permits averages such as 90 FPS at 120 Hz.
            const elapsedIntervals = Math.max(1, Math.floor(elapsed / interval));
            lastRenderDeadline += elapsedIntervals * interval;
            return true;
        }
    };
}

function estimateRefreshRate(intervals) {
    if (!Array.isArray(intervals) || intervals.length < MINIMUM_REFRESH_SAMPLE_COUNT) {
        return DEFAULT_FPS_LIMIT;
    }

    const sortedIntervals = [...intervals].sort((first, second) => first - second);
    const middleIndex = Math.floor(sortedIntervals.length / 2);
    const medianInterval = sortedIntervals.length % 2 === 0
        ? (sortedIntervals[middleIndex - 1] + sortedIntervals[middleIndex]) / 2
        : sortedIntervals[middleIndex];

    return medianInterval > 0
        ? 1000 / medianInterval
        : DEFAULT_FPS_LIMIT;
}

function normalizeSampleDuration(value) {
    const duration = Number(value);

    return Number.isFinite(duration) && duration > 0
        ? duration
        : DEFAULT_REFRESH_SAMPLE_DURATION_MS;
}
