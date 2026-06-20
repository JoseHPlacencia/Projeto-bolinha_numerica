import { createCanvasRenderer } from "./renderer.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { getRenderFrameIntervalMs } from "./renderSettings.js";

let renderer = null;
let snapshots = null;
let currentPlayerId = null;
let currentGameConfig = null;
let running = false;
let frameCount = 0;
let renderedFrameCount = 0;
let renderTimeTotal = 0;
let lastRenderedAt = Number.NEGATIVE_INFINITY;
let debugMeasuredAt = performance.now();

self.addEventListener("message", event => {
    const message = event.data || {};

    if (message.type === "init") {
        initializeRenderer(message);
        return;
    }

    if (message.type === "resize") {
        if (renderer && message.layout) {
            renderer.resizeCanvas(message.layout);
        }
        return;
    }

    if (message.type === "config") {
        applyGameConfig(message.gameConfig);
        return;
    }

    if (message.type === "snapshot") {
        processSnapshot(message.snapshot);
        return;
    }

    if (message.type === "resetSnapshots") {
        resetSnapshots();
        return;
    }

    if (message.type === "playerId") {
        currentPlayerId = message.playerId;
    }
});

function initializeRenderer({ canvas, gameConfig, layout }) {
    currentGameConfig = gameConfig;
    renderer = createCanvasRenderer(canvas, gameConfig);
    renderer.resizeCanvas(layout);
    snapshots = createSnapshotInterpolator(gameConfig.network, {
        onResyncNeeded: () => {
            self.postMessage({
                type: "snapshotResync"
            });
        }
    });

    if (!running) {
        running = true;
        scheduleFrame(renderLoop);
    }
}

function applyGameConfig(nextConfig) {
    if (!currentGameConfig || !nextConfig) {
        return;
    }

    mergeObject(currentGameConfig, nextConfig);
    lastRenderedAt = Number.NEGATIVE_INFINITY;
}

function mergeObject(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            if (!target[key] || typeof target[key] !== "object") {
                target[key] = {};
            }
            mergeObject(target[key], value);
        } else {
            target[key] = value;
        }
    }
}

function processSnapshot(snapshot) {
    if (!snapshots) {
        return;
    }

    const applyResult = snapshots.processSnapshot(snapshot);

    if (applyResult && applyResult.applied === false) {
        self.postMessage({
            type: "snapshotCacheInvalid",
            invalidations: applyResult.invalidations
        });
    }
}

function resetSnapshots() {
    if (snapshots) {
        snapshots.reset();
    }
}

function renderLoop(timestamp = performance.now()) {
    scheduleFrame(renderLoop);

    if (!renderer || !snapshots || !currentPlayerId) {
        publishDebugState(0, false);
        return;
    }

    if (!shouldRenderFrame(timestamp)) {
        publishDebugState(0, false);
        return;
    }

    const state = snapshots.getRenderState();

    if (!state) {
        publishDebugState(0, false);
        return;
    }

    const startedAt = performance.now();
    renderer.renderWorld(state, currentPlayerId);
    publishDebugState(performance.now() - startedAt, true);
}

function shouldRenderFrame(now) {
    const interval = getRenderFrameIntervalMs(currentGameConfig);

    if (interval > 0 && now - lastRenderedAt < interval - 0.5) {
        return false;
    }

    lastRenderedAt = now;
    return true;
}

function scheduleFrame(callback) {
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(callback);
        return;
    }

    setTimeout(() => callback(performance.now()), 1000 / 60);
}

function publishDebugState(renderMs, rendered) {
    const now = performance.now();

    frameCount++;

    if (rendered) {
        renderedFrameCount++;
        renderTimeTotal += renderMs;
    }

    if (now - debugMeasuredAt < 500) {
        return;
    }

    const rendererState = renderer ? renderer.getDebugState() : {};

    self.postMessage({
        type: "debug",
        debug: {
            viewportBounds: rendererState.viewportBounds || null,
            workerFps: Math.round(renderedFrameCount * 1000 / (now - debugMeasuredAt)),
            workerLoopFps: Math.round(frameCount * 1000 / (now - debugMeasuredAt)),
            workerRenderMs: renderedFrameCount > 0 ? renderTimeTotal / renderedFrameCount : 0
        }
    });

    frameCount = 0;
    renderedFrameCount = 0;
    renderTimeTotal = 0;
    debugMeasuredAt = now;
}
