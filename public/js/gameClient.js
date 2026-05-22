import { createFrameMonitor, getDebugLevel } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createMinimapRenderer } from "./renderers/minimapRenderer.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createCanvasRenderer } from "./renderer.js";

export function startClient(gameConfig) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const minimapCanvas = document.getElementById("minimapCanvas");
    const renderer = createCanvasRenderer(canvas, gameConfig);
    const minimap = createMinimapRenderer(minimapCanvas, gameConfig);
    const snapshots = createSnapshotInterpolator(gameConfig.network, {
        onResyncNeeded: () => socket.emit("snapshotResync")
    });
    const debugLevel = getDebugLevel();
    const hud = createHud({ debugLevel });
    const frameMonitor = createFrameMonitor();
    let myId = null;
    let lastViewportSentAt = 0;

    createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles);
    window.addEventListener("resize", resizeCanvases);

    socket.on("connect", () => {
        myId = socket.id;
        sendViewportState(true);
    });

    socket.on("gameState", (snapshot, acknowledge) => {
        const applyResult = snapshots.processSnapshot(snapshot);

        recordSnapshotDiagnostics(snapshot, applyResult);

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
        frameMonitor.recordFrame(performance.now());

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

        renderer.renderWorld(state, myId);
        minimap.render(state, myId);
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

    function recordSnapshotDiagnostics(snapshot, applyResult) {
        if (typeof window === "undefined") {
            return;
        }

        const diagnostics = {
            at: new Date().toISOString(),
            time: snapshot && snapshot.time,
            applied: !applyResult || applyResult.applied !== false,
            fullTerritoryIds: Object.keys((snapshot && snapshot.territories) || {}),
            territoryOperationIds: Object.keys((snapshot && snapshot.territoryOps) || {}),
            territoryOperations: summarizeTerritoryOperations(snapshot && snapshot.territoryOps),
            trailUpdateIds: Object.keys((snapshot && snapshot.trails) || {}),
            invalidations: applyResult && applyResult.invalidations,
            territoryOperationFailures: applyResult && applyResult.territoryOperationFailures || [],
            syncDebug: snapshot && snapshot.syncDebug
        };
        const log = Array.isArray(window.__snapshotDiagnosticsLog)
            ? window.__snapshotDiagnosticsLog
            : [];

        log.push(diagnostics);

        while (log.length > 200) {
            log.shift();
        }

        window.__lastSnapshotDiagnostics = diagnostics;
        window.__snapshotDiagnosticsLog = log;

        if (window.snapshotApplyDebug && diagnostics.territoryOperationFailures.length > 0) {
            console.warn("[snapshot] falha ao aplicar operação de território", diagnostics);
        }
    }

    function summarizeTerritoryOperations(operations) {
        const summaries = {};

        for (const [id, operation] of Object.entries(operations || {})) {
            summaries[id] = {
                baseVersion: operation.baseVersion,
                version: operation.version,
                trailSide: operation.trailSide,
                trailSegmentIndex: operation.trailSegmentIndex,
                trailSegmentLength: operation.trailSegmentLength,
                trailTailStart: Number.isInteger(operation.trailTailStart) ? operation.trailTailStart : null,
                trailTailPointCount: Array.isArray(operation.trailTailPoints) ? operation.trailTailPoints.length : 0,
                fallbackTrailPointCount: Array.isArray(operation.trailPoints) ? operation.trailPoints.length : 0
            };
        }

        return summaries;
    }
}
