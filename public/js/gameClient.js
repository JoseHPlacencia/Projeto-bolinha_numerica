import { createFrameMonitor, getDebugLevel } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createMinimapRenderer } from "./renderers/minimapRenderer.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createWorldRenderer } from "./worldRenderer.js";

const WORKER_MAIN_UPDATE_INTERVAL_MS = 1000 / 15;

export function startClient(gameConfig) {
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
    const debugLevel = getDebugLevel();
    const hud = createHud({ debugLevel });
    const frameMonitor = createFrameMonitor();
    const isWorkerRenderer = renderer.getDebugState().mode === "worker";
    let myId = null;
    let lastViewportSentAt = 0;
    let lastWorkerMainUpdateAt = Number.NEGATIVE_INFINITY;

    createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles);
    window.addEventListener("resize", resizeCanvases);

    socket.on("connect", () => {
        myId = socket.id;
        renderer.setPlayerId(myId);
        sendViewportState(true);
    });

    socket.on("gameState", (snapshot, acknowledge) => {
        renderer.processSnapshot(snapshot);
        const applyResult = snapshots.processSnapshot(snapshot);

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

    function render() {
        requestAnimationFrame(render);
        const now = performance.now();

        frameMonitor.recordFrame(now);

        if (isWorkerRenderer && !shouldUpdateWorkerMainViews(now)) {
            return;
        }

        const state = snapshots.getRenderState();
        const currentPlayer = state && myId ? state.players[myId] : null;

        hud.update({
            frameStats: {
                frameMs: frameMonitor.getFrameMs(),
                fps: frameMonitor.getFps()
            },
            rendererStats: renderer.getDebugState(),
            snapshotStats: snapshots.getDebugState(),
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
        if (now - lastWorkerMainUpdateAt < WORKER_MAIN_UPDATE_INTERVAL_MS) {
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
}
