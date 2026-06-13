import { createFrameMonitor, getDebugLevel } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createNumberHud } from "./numberHud.js";
import { createNetworkDiagnostics } from "./networkDiagnostics.js";
import { createMinimapRenderer } from "./renderers/minimapRenderer.js";
import { createRoomUi } from "./roomUi.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createWorldRenderer } from "./worldRenderer.js";

const DEFAULT_MINIMAP_FRAME_RATE = 15;

export function startClient(gameConfig, options = {}) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const minimapCanvas = document.getElementById("minimapCanvas");
    const renderer = createWorldRenderer(canvas, gameConfig, {
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
    let myId = null;
    let lastViewportSentAt = 0;
    let lastWorkerMainUpdateAt = Number.NEGATIVE_INFINITY;

    createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles, {
        isEnabled: typeof options.isInputEnabled === "function"
            ? options.isInputEnabled
            : () => document.body.classList.contains("is-game-active")
    });
    const roomUi = createRoomUi(socket, {
        gameConfig,
        getPlayerOptions: options.getPlayerOptions,
        onExitGame: options.onExitGame,
        onJoinFailure: options.onJoinFailure,
        onJoinStart: options.onJoinStart,
        onJoinSuccess: handleRoomJoinSuccess,
        onRoomsList: options.onRoomsList
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
        if (typeof options.onGameOver === "function") {
            options.onGameOver(data);
        }
        socket.disconnect();
    });

    socket.on("gameState", (snapshot, acknowledge) => {
        applyRoomConfig(snapshot && snapshot.roomConfig);
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
    render();

    return {
        networkDiagnostics,
        roomUi,
        socket
    };

    function render() {
        requestAnimationFrame(render);
        const now = performance.now();

        frameMonitor.recordFrame(now);

        if (isWorkerRenderer && !shouldUpdateWorkerMainViews(now)) {
            return;
        }

        const state = snapshots.getRenderState();
        const currentPlayer = state && myId ? state.players[myId] : null;

        numberHud.updateBalance(currentPlayer);

        hud.update({
            frameStats: {
                frameMs: frameMonitor.getFrameMs(),
                fps: frameMonitor.getFps()
            },
            rendererStats: renderer.getDebugState(),
            snapshotStats: snapshots.getDebugState(),
            currentPlayer,
            currentPlayerId: myId,
            leaderboard: state && state.leaderboard,
            playerDebug: currentPlayer && currentPlayer.debug
        });

        if (!state || !myId) {
            minimap.clear();
            return;
        }

        if (!isWorkerRenderer) {
            renderer.renderWorld(state, myId);
        }

        minimap.render(state, myId);
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
