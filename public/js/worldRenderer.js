import { createCanvasRenderer, createCanvasViewportLayout } from "./renderer.js";

export function createWorldRenderer(canvas, gameConfig, options = {}) {
    if (!shouldUseWorker(canvas, options)) {
        return createMainWorldRenderer(canvas, gameConfig);
    }

    const workerRenderer = tryCreateWorkerWorldRenderer(canvas, gameConfig, options);

    return workerRenderer || createMainWorldRenderer(canvas, gameConfig);
}

function createMainWorldRenderer(canvas, gameConfig) {
    const renderer = createCanvasRenderer(canvas, gameConfig);

    return {
        getDebugState,
        getViewportState: renderer.getViewportState,
        processSnapshot,
        renderWorld: renderer.renderWorld,
        resetSnapshots,
        resizeCanvas: renderer.resizeCanvas,
        setActive,
        setPlayerId,
        updateConfig
    };

    function getDebugState() {
        return {
            ...renderer.getDebugState(),
            mode: "main"
        };
    }

    function processSnapshot() {
        return null;
    }

    function resetSnapshots() {
    }

    function setActive() {
    }

    function setPlayerId() {
    }

    function updateConfig() {
    }
}

function tryCreateWorkerWorldRenderer(canvas, gameConfig, options) {
    let worker = null;

    try {
        worker = new Worker(new URL("./renderWorker.js", import.meta.url), {
            type: "module"
        });
    } catch (error) {
        console.warn("Worker renderer unavailable; using main thread renderer.", error);
        return null;
    }

    let offscreenCanvas = null;

    try {
        offscreenCanvas = canvas.transferControlToOffscreen();
    } catch (error) {
        worker.terminate();
        console.warn("OffscreenCanvas transfer failed; using main thread renderer.", error);
        return null;
    }

    let layout = createCurrentLayout(canvas, gameConfig);
    let workerDebugState = {};
    let currentPlayerId = null;
    let active = options.active !== false;

    applyCanvasStyle(canvas, layout);
    worker.postMessage({
        type: "init",
        canvas: offscreenCanvas,
        gameConfig,
        layout,
        active
    }, [offscreenCanvas]);

    worker.addEventListener("message", event => {
        const message = event.data || {};

        if (message.type === "snapshotCacheInvalid") {
            if (typeof options.onSnapshotCacheInvalid === "function") {
                options.onSnapshotCacheInvalid(message.invalidations);
            }
            return;
        }

        if (message.type === "snapshotResync") {
            if (typeof options.onSnapshotResync === "function") {
                options.onSnapshotResync();
            }
            return;
        }

        if (message.type === "debug") {
            workerDebugState = message.debug || {};
        }
    });

    worker.addEventListener("error", error => {
        console.error("Worker renderer failed.", error);
    });

    return {
        getDebugState,
        getViewportState,
        processSnapshot,
        renderWorld,
        resetSnapshots,
        resizeCanvas,
        setActive,
        setPlayerId,
        updateConfig
    };

    function resizeCanvas() {
        layout = createCurrentLayout(canvas, gameConfig);
        applyCanvasStyle(canvas, layout);
        worker.postMessage({
            type: "resize",
            layout
        });
    }

    function renderWorld() {
    }

    function processSnapshot(snapshot) {
        worker.postMessage({
            type: "snapshot",
            snapshot
        });
    }

    function updateConfig(nextConfig) {
        worker.postMessage({
            type: "config",
            gameConfig: nextConfig
        });
    }

    function resetSnapshots() {
        worker.postMessage({
            type: "resetSnapshots"
        });
    }

    function setActive(nextActive) {
        const normalizedActive = Boolean(nextActive);

        if (active === normalizedActive) {
            return;
        }

        active = normalizedActive;
        worker.postMessage({
            type: "active",
            active
        });
    }

    function setPlayerId(playerId) {
        if (currentPlayerId === playerId) {
            return;
        }

        currentPlayerId = playerId;
        worker.postMessage({
            type: "playerId",
            playerId
        });
    }

    function getViewportState() {
        return {
            height: layout.height,
            scale: layout.scale,
            width: layout.width
        };
    }

    function getDebugState() {
        return {
            canvasHeight: layout.canvasHeight,
            canvasWidth: layout.canvasWidth,
            mode: "worker",
            pixelRatio: layout.pixelRatio,
            playerId: currentPlayerId,
            viewportBounds: workerDebugState.viewportBounds || null,
            viewportHeight: layout.height,
            viewportWidth: layout.width,
            workerFps: workerDebugState.workerFps || 0,
            workerRenderMs: workerDebugState.workerRenderMs || 0
        };
    }
}

function shouldUseWorker(canvas, options) {
    return options.worker !== false
        && !isWorkerDisabledByQuery()
        && typeof Worker === "function"
        && canvas
        && typeof canvas.transferControlToOffscreen === "function";
}

function isWorkerDisabledByQuery() {
    if (typeof window === "undefined") {
        return false;
    }

    const value = new URLSearchParams(window.location.search).get("worker");

    return value === "0" || value === "false" || value === "off";
}

function createCurrentLayout(canvas, gameConfig) {
    return createCanvasViewportLayout(
        gameConfig,
        getWindowWidth(gameConfig),
        getWindowHeight(gameConfig),
        getPixelRatio()
    );
}

function applyCanvasStyle(canvas, layout) {
    if (!canvas.style) {
        return;
    }

    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;
}

function getWindowWidth(gameConfig) {
    return typeof window !== "undefined" && Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : gameConfig.screen.virtualWidth;
}

function getWindowHeight(gameConfig) {
    return typeof window !== "undefined" && Number.isFinite(window.innerHeight)
        ? window.innerHeight
        : gameConfig.screen.virtualHeight;
}

function getPixelRatio() {
    return typeof window !== "undefined" && Number.isFinite(window.devicePixelRatio)
        ? window.devicePixelRatio || 1
        : 1;
}
