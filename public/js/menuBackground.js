import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createWorldRenderer } from "./worldRenderer.js";

const RECONNECT_DELAY_MS = 2000;

export function createMenuBackground(gameConfig) {
    const canvas = document.getElementById("menuBackgroundCanvas");

    if (!canvas || typeof io !== "function") {
        return createNoopMenuBackground();
    }

    const socket = io({
        transports: gameConfig.socket.transports,
        autoConnect: false,
        reconnection: false
    });
    const renderer = createWorldRenderer(canvas, gameConfig, { worker: false });
    const snapshots = createSnapshotInterpolator(gameConfig.network, {
        onResyncNeeded: () => socket.emit("snapshotResync")
    });
    const context = canvas.getContext("2d");

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
        followId = null;
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
        if (snapshot && snapshot.spectator && snapshot.spectator.followId) {
            followId = snapshot.spectator.followId;
        }

        renderer.processSnapshot(snapshot);
        const applyResult = snapshots.processSnapshot(snapshot);

        if (typeof acknowledge === "function") {
            acknowledge(createSnapshotAcknowledgement(applyResult));
            return;
        }

        if (applyResult && applyResult.applied === false) {
            socket.emit("snapshotCacheInvalid", applyResult.invalidations);
        }
    });

    return {
        start,
        stop
    };

    function start() {
        if (running) {
            return;
        }

        running = true;
        followId = null;
        resizeCanvas();
        window.addEventListener("resize", resizeCanvas);
        socket.connect();
        render();
    }

    function stop() {
        if (!running) {
            return;
        }

        running = false;
        clearReconnectTimer();
        window.removeEventListener("resize", resizeCanvas);

        if (socket.connected) {
            socket.emit("unwatchMenuBackground");
        }

        socket.disconnect();
        snapshots.reset();
        renderer.resetSnapshots();
        followId = null;
        cancelRenderFrame();
        clearCanvas();
    }

    function render() {
        if (!running) {
            return;
        }

        animationFrame = requestAnimationFrame(render);

        const state = snapshots.getRenderState();
        const renderFollowId = pickFollowId(state);

        if (!state || !renderFollowId) {
            return;
        }

        followId = renderFollowId;
        renderer.renderWorld(state, renderFollowId);
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
        start() {},
        stop() {}
    };
}
