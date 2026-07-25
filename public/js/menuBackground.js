import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createSnapshotSocketAuth } from "./snapshotProtocol.js";
import { createWorldRenderer } from "./worldRenderer.js";
import { createRenderFrameLimiter } from "./renderSettings.js";

const RECONNECT_DELAY_MS = 2000;

export function createMenuBackground(gameConfig) {
    const canvas = document.getElementById("menuBackgroundCanvas");

    if (!canvas || typeof io !== "function") {
        return createNoopMenuBackground();
    }

    const socket = io({
        auth: createSnapshotSocketAuth(),
        transports: gameConfig.socket.transports,
        autoConnect: false,
        reconnection: false
    });
    const renderer = createWorldRenderer(canvas, gameConfig, {
        active: false,
        onSnapshotCacheInvalid: invalidations => socket.emit("snapshotCacheInvalid", invalidations),
        onSnapshotResync: () => socket.emit("snapshotResync")
    });
    const snapshots = createSnapshotInterpolator(gameConfig.network, {
        onResyncNeeded: () => socket.emit("snapshotResync")
    });
    const renderFrameLimiter = createRenderFrameLimiter(() => gameConfig);
    const isWorkerRenderer = renderer.getDebugState().mode === "worker";
    const context = isWorkerRenderer
        ? null
        : canvas.getContext("2d");

    let animationFrame = null;
    let followId = null;
    let reconnectTimer = null;
    let running = false;

    socket.on("connect", () => {
        socket.emit("watchMenuBackground");
    });

    socket.on("connect_error", () => {
        scheduleReconnect();
    });

    socket.on("disconnect", () => {
        setFollowId(null);
        snapshots.reset();
        renderer.resetSnapshots();

        if (running) {
            scheduleReconnect();
        }
    });

    socket.on("menuBackgroundReady", result => {
        if (!result || result.success === false) {
            scheduleReconnect();
        }
    });

    socket.on("gameState", (snapshot, acknowledge) => {
        const snapshotFollowId = getSnapshotFollowId(snapshot);
        if (snapshotFollowId) setFollowId(snapshotFollowId);

        const applyResult = processSnapshotSafely(snapshot);

        if (typeof acknowledge === "function") {
            acknowledge(createSnapshotAcknowledgement(applyResult));
        } else if (applyResult && applyResult.applied === false) {
            socket.emit("snapshotCacheInvalid", applyResult.invalidations);
        }

        if (applyResult && applyResult.applied === false) {
            return;
        }

        renderer.processSnapshot(snapshot);
    });

    return {
        setRenderingSettings,
        setVisualTheme,
        start,
        stop
    };

    function start() {
        if (running) {
            return;
        }

        running = true;
        renderer.setActive(true);
        setFollowId(null);
        renderFrameLimiter.reset();
        resizeCanvas();
        window.addEventListener("resize", resizeCanvas);
        socket.connect();
        if (!isWorkerRenderer) render();
    }

    function stop() {
        if (!running) {
            return;
        }

        running = false;
        renderer.setActive(false);
        clearReconnectTimer();
        window.removeEventListener("resize", resizeCanvas);

        if (socket.connected) {
            socket.emit("unwatchMenuBackground");
        }

        socket.disconnect();
        snapshots.reset();
        renderer.resetSnapshots();
        setFollowId(null);
        cancelRenderFrame();
        clearCanvas();
    }

    function render(now = performance.now()) {
        if (!running) {
            return;
        }

        animationFrame = requestAnimationFrame(render);

        if (!renderFrameLimiter.shouldRender(now)) {
            return;
        }

        const state = snapshots.getRenderState();
        const renderFollowId = pickFollowId(state);

        if (!state || !renderFollowId) {
            return;
        }

        setFollowId(renderFollowId);
        renderer.renderWorld(state, renderFollowId);
    }

    function setRenderingSettings(settings) {
        gameConfig.renderingSettings = {
            ...(gameConfig.renderingSettings || {}),
            ...settings
        };
        renderFrameLimiter.reset();
        renderer.updateConfig({ renderingSettings: gameConfig.renderingSettings });
    }

    function setVisualTheme(mode) {
        gameConfig.visualTheme = {
            ...(gameConfig.visualTheme || {}),
            mode
        };
        renderer.updateConfig({ visualTheme: gameConfig.visualTheme });
    }

    function pickFollowId(state) {
        if (!state || !state.players) {
            return null;
        }

        if (followId && state.players[followId]) {
            return followId;
        }

        return Object.keys(state.players)[0] || null;
    }

    function getSnapshotFollowId(snapshot) {
        const spectatorFollowId = snapshot
            && snapshot.spectator
            && snapshot.spectator.followId;

        if (spectatorFollowId) {
            return spectatorFollowId;
        }

        if (!followId && snapshot && snapshot.players) {
            return getFirstSnapshotPlayerId(snapshot.players);
        }

        return followId;
    }

    function getFirstSnapshotPlayerId(players) {
        if (Array.isArray(players)) {
            return typeof players[0] === "string" ? players[0] : null;
        }

        return Object.keys(players || {})[0] || null;
    }

    function setFollowId(nextFollowId) {
        const normalizedFollowId = nextFollowId || null;

        if (followId === normalizedFollowId) {
            return;
        }

        followId = normalizedFollowId;
        renderer.setPlayerId(followId);
    }

    function resizeCanvas() {
        renderer.resizeCanvas(createViewportLayout(gameConfig));
    }

    function scheduleReconnect() {
        if (!running || reconnectTimer || socket.connected) {
            return;
        }

        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;

            if (running && !socket.connected) {
                socket.connect();
            }
        }, RECONNECT_DELAY_MS);
    }

    function clearReconnectTimer() {
        if (!reconnectTimer) {
            return;
        }

        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    function cancelRenderFrame() {
        if (!animationFrame) {
            return;
        }

        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }

    function clearCanvas() {
        if (!context) {
            return;
        }

        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
    }

    function processSnapshotSafely(snapshot) {
        try {
            return snapshots.processSnapshot(snapshot);
        } catch (error) {
            console.error("Failed to apply menu snapshot; requesting a full resync.", error);
            snapshots.reset();
            renderer.resetSnapshots();

            return {
                applied: false,
                invalidations: {
                    playerInfo: [],
                    territories: [],
                    trails: []
                }
            };
        }
    }
}

function createSnapshotAcknowledgement(applyResult) {
    return {
        applied: !applyResult || applyResult.applied !== false,
        invalidations: applyResult && applyResult.invalidations
            ? applyResult.invalidations
            : {
                playerInfo: [],
                territories: [],
                trails: []
            }
    };
}

function createViewportLayout(gameConfig) {
    const width = getViewportDimension("innerWidth", gameConfig.screen.virtualWidth);
    const height = getViewportDimension("innerHeight", gameConfig.screen.virtualHeight);
    const pixelRatio = getPixelRatio();

    return {
        canvasHeight: Math.round(height * pixelRatio),
        canvasWidth: Math.round(width * pixelRatio),
        height,
        pixelRatio,
        scale: Math.min(
            width / gameConfig.screen.virtualWidth,
            height / gameConfig.screen.virtualHeight
        ),
        width
    };
}

function getViewportDimension(key, fallback) {
    const value = typeof window !== "undefined" ? Number(window[key]) : fallback;
    return Math.max(1, Math.round(Number.isFinite(value) ? value : fallback));
}

function getPixelRatio() {
    const value = typeof window !== "undefined" ? Number(window.devicePixelRatio) : 1;
    return Number.isFinite(value) && value > 0 ? value : 1;
}

function createNoopMenuBackground() {
    return {
        setRenderingSettings() {},
        setVisualTheme() {},
        start() {},
        stop() {}
    };
}
