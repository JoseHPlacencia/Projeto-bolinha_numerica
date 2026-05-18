export function getDebugLevel() {
    const params = new URLSearchParams(window.location.search);
    const debugLevel = Number(params.get("debug"));

    return Number.isFinite(debugLevel) ? Math.max(0, Math.trunc(debugLevel)) : 0;
}

export function createFrameMonitor() {
    let frameMs = 0;
    let frames = 0;
    let fps = 0;
    let lastFrameAt = null;
    let measuredAt = performance.now();
    let measuredFrameTime = 0;

    return {
        getFrameMs,
        getFps,
        recordFrame
    };

    function recordFrame(now) {
        if (lastFrameAt !== null) {
            measuredFrameTime += now - lastFrameAt;
            frames++;
        }

        lastFrameAt = now;

        if (now - measuredAt >= 500) {
            fps = Math.round(frames * 1000 / (now - measuredAt));
            frameMs = frames > 0 ? measuredFrameTime / frames : 0;
            frames = 0;
            measuredFrameTime = 0;
            measuredAt = now;
        }
    }

    function getFrameMs() {
        return frameMs;
    }

    function getFps() {
        return fps;
    }
}
