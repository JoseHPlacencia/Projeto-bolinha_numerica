import { createCanvasRenderer } from "./renderer.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";

let renderer = null;
let snapshots = null;
let currentPlayerId = null;
let running = false;
let frameCount = 0;
let renderedFrameCount = 0;
let renderTimeTotal = 0;
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

function renderLoop() {
    scheduleFrame(renderLoop);

    if (!renderer || !snapshots || !currentPlayerId) {
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
