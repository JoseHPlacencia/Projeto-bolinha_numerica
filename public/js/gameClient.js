import { createFrameMonitor, getDebugLevel } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createNumberHud } from "./numberHud.js";
import { createNetworkDiagnostics } from "./networkDiagnostics.js";
import { createMinimapRenderer } from "./renderers/minimapRenderer.js";
import { createRoomUi } from "./roomUi.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createWorldRenderer } from "./worldRenderer.js";
import { getRenderFrameIntervalMs } from "./renderSettings.js";

const DEFAULT_MINIMAP_FRAME_RATE = 15;

export function startClient(gameConfig, options = {}) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const minimapCanvas = document.getElementById("minimapCanvas");
    const renderer = createWorldRenderer(canvas, gameConfig, {
        active: options.renderingActive !== false,
        onSnapshotCacheInvalid: invalidations => socket.emit("snapshotCacheInvalid", invalidations),
        onSnapshotResync: () => socket.emit("snapshotResync")
    });
    const minimap = createMinimapRenderer(minimapCanvas, gameConfig);
    const snapshots = createSnapshotInterpolator(gameConfig.network, {
        onResyncNeeded: () => socket.emit("snapshotResync")
    });
    const networkDiagnostics = createNetworkDiagnostics(socket, snapshots, gameConfig.network);
    const debugLevel = getDebugLevel();
    const hud = createHud({ debugLevel });
    const numberHud = createNumberHud({
        container: document.getElementById("gameLayer")
    });
    const frameMonitor = createFrameMonitor();
    const isWorkerRenderer = renderer.getDebugState().mode === "worker";
    const workerMainUpdateIntervalMs = getMinimapUpdateIntervalMs(gameConfig);
    const portraitMobileQuery = window.matchMedia("(orientation: portrait) and (any-pointer: coarse)");
    let myId = null;
    let lastClientFrameAt = Number.NEGATIVE_INFINITY;
    let lastViewportSentAt = 0;
    let lastWorkerMainUpdateAt = Number.NEGATIVE_INFINITY;
    let spectatorFollowId = null;
    let renderingActive = options.renderingActive !== false;
    let animationFrame = null;

    createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles, {
        isEnabled: typeof options.isInputEnabled === "function"
            ? options.isInputEnabled
            : isGameInputEnabled
    });
    const roomUi = createRoomUi(socket, {
        gameConfig,
        getPlayerOptions: options.getPlayerOptions,
        onExitGame: options.onExitGame,
        onJoinFailure: options.onJoinFailure,
        onJoinStart: options.onJoinStart,
        onJoinSuccess: handleRoomJoinSuccess,
        onRoomsList: options.onRoomsList,
        requestFullscreen: options.requestFullscreen,
        requestGameplayReady: options.requestGameplayReady
    });
    window.addEventListener("resize", resizeCanvases);

    socket.on("connect", () => {
        myId = socket.id;
        renderer.setPlayerId(myId);
        sendViewportState(true);
    });

    socket.on("numberCollected", data => {
        numberHud.showCollection(data);
    });

    socket.on("gameOver", data => {
        resetSessionState();
        setSpectatorFollowId(data && data.spectatorFollowId);
        if (typeof options.onGameOver === "function") {
            options.onGameOver(data);
        }
    });

    socket.on("gameState", (snapshot, acknowledge) => {
        applyRoomConfig(snapshot && snapshot.roomConfig);
        syncSpectatorFromSnapshot(snapshot);
        renderer.processSnapshot(snapshot);
        const applyResult = snapshots.processSnapshot(snapshot);

        if (snapshot.numbers && snapshot.numbers.theme) {
            numberHud.updateTheme(snapshot.numbers.theme, snapshot.numbers.themeEndsIn || 0);
        }

        if (typeof acknowledge === "function") {
            acknowledge(createSnapshotAcknowledgement(applyResult));
            return;
        }

        if (applyResult && !applyResult.applied) {
            socket.emit("snapshotCacheInvalid", applyResult.invalidations);
        }
    });

    resizeCanvases();
    if (renderingActive) {
        animationFrame = requestAnimationFrame(render);
    }

    return {
        leaveCurrentRoom,
        networkDiagnostics,
        roomUi,
        setRenderingActive,
        setRenderingSettings,
        setVisualTheme,
        socket
    };

    function setVisualTheme(mode) {
        const visualTheme = {
            ...(gameConfig.visualTheme || {}),
            mode
        };

        gameConfig.visualTheme = visualTheme;
        renderer.updateConfig({ visualTheme });
    }

    function setRenderingSettings(settings) {
        const renderingSettings = {
            ...(gameConfig.renderingSettings || {}),
            ...settings
        };

        gameConfig.renderingSettings = renderingSettings;
        lastClientFrameAt = Number.NEGATIVE_INFINITY;
        renderer.updateConfig({ renderingSettings });
    }

    function render(now = performance.now()) {
        animationFrame = null;

        if (!renderingActive) {
            return;
        }

        animationFrame = requestAnimationFrame(render);

        if (!shouldRenderClientFrame(now)) {
            return;
        }

        frameMonitor.recordFrame(now);

        if (isWorkerRenderer && !shouldUpdateWorkerMainViews(now)) {
            return;
        }

        const state = snapshots.getRenderState();
        const cameraPlayerId = spectatorFollowId || myId;
        const currentPlayer = state && cameraPlayerId
            ? state.players[cameraPlayerId]
            : null;

        numberHud.updateBalance(currentPlayer);

        hud.update({
            frameStats: {
                frameMs: frameMonitor.getFrameMs(),
                fps: frameMonitor.getFps()
            },
            rendererStats: renderer.getDebugState(),
            snapshotStats: snapshots.getDebugState(),
            currentPlayer,
            currentPlayerId: cameraPlayerId,
            catchStatus: state && state.catchStatus,
            leaderboard: state && state.leaderboard,
            playerDebug: currentPlayer && currentPlayer.debug
        });

        if (!state || !cameraPlayerId) {
            minimap.clear();
            return;
        }

        if (!isWorkerRenderer) {
            renderer.renderWorld(state, cameraPlayerId);
        }

        minimap.render(state, cameraPlayerId);
    }

    function setRenderingActive(active) {
        const nextActive = Boolean(active);

        if (renderingActive === nextActive) {
            return;
        }

        renderingActive = nextActive;
        renderer.setActive(nextActive);

        if (!nextActive) {
            if (animationFrame !== null) {
                cancelAnimationFrame(animationFrame);
                animationFrame = null;
            }
            return;
        }

        lastClientFrameAt = Number.NEGATIVE_INFINITY;
        lastWorkerMainUpdateAt = Number.NEGATIVE_INFINITY;
        animationFrame = requestAnimationFrame(render);
    }

    function shouldRenderClientFrame(now) {
        const interval = getRenderFrameIntervalMs(gameConfig);

        if (interval > 0 && now - lastClientFrameAt < interval - 0.5) {
            return false;
        }

        lastClientFrameAt = now;
        return true;
    }

    function shouldUpdateWorkerMainViews(now) {
        if (now - lastWorkerMainUpdateAt < workerMainUpdateIntervalMs) {
            return false;
        }

        lastWorkerMainUpdateAt = now;
        return true;
    }

    function resizeCanvases() {
        renderer.resizeCanvas();
        minimap.resizeCanvas();
        sendViewportState(true);
    }

    function sendViewportState(force = false) {
        const now = performance.now();
        const interval = gameConfig.network.viewportReportIntervalMs;

        if (!force && now - lastViewportSentAt < interval) {
            return;
        }

        lastViewportSentAt = now;
        socket.emit("viewport", renderer.getViewportState());
    }

    function handleRoomJoinSuccess(result) {
        resetSessionState();
        setSpectatorFollowId(null);
        sendViewportState(true);

        if (typeof options.onJoinSuccess === "function") {
            options.onJoinSuccess(result);
        }
    }

    function resetSessionState() {
        snapshots.reset();
        renderer.resetSnapshots();
        minimap.clear();
        lastViewportSentAt = Number.NEGATIVE_INFINITY;
        lastWorkerMainUpdateAt = Number.NEGATIVE_INFINITY;
    }

    function leaveCurrentRoom() {
        if (socket.connected) {
            socket.emit("leaveRoom");
        }

        roomUi.clearRoomInfo();
        resetSessionState();
        setSpectatorFollowId(null);
    }

    function syncSpectatorFromSnapshot(snapshot) {
        if (!snapshot || !snapshot.spectator) {
            return;
        }

        setSpectatorFollowId(snapshot.spectator.followId);
    }

    function setSpectatorFollowId(playerId) {
        const nextPlayerId = typeof playerId === "string" && playerId
            ? playerId
            : null;

        if (spectatorFollowId === nextPlayerId) {
            return;
        }

        spectatorFollowId = nextPlayerId;
        renderer.setPlayerId(spectatorFollowId || myId);
    }

    function isGameInputEnabled() {
        return document.body.classList.contains("is-game-active")
            && !portraitMobileQuery.matches
            && !document.body.classList.contains("is-awaiting-orientation")
            && !document.body.classList.contains("is-game-ended")
            && !document.body.classList.contains("is-spectating");
    }

    function applyRoomConfig(roomConfig) {
        if (!roomConfig) {
            return;
        }

        mergeObject(gameConfig, roomConfig);
        if (typeof renderer.updateConfig === "function") {
            renderer.updateConfig(gameConfig);
        }
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

    function getMinimapUpdateIntervalMs(config) {
        const frameRate = Number(config && config.minimap && config.minimap.frameRate);

        if (frameRate === 0) {
            return 0;
        }

        const safeFrameRate = Number.isFinite(frameRate) && frameRate > 0
            ? frameRate
            : DEFAULT_MINIMAP_FRAME_RATE;

        return 1000 / safeFrameRate;
    }
}
