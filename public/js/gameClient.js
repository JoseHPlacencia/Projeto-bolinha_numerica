import { createFrameMonitor, getDebugLevel } from "./debug.js";
import { createHud } from "./hud.js";
<<<<<<< HEAD
import { createNumberHud } from "./numberHud.js";
import { createInputControls } from "./input.js";
import { createMinimapRenderer } from "./renderers/minimapRenderer.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createCanvasRenderer } from "./renderer.js";
=======
import { createInputControls } from "./input.js";
import { createMinimapRenderer } from "./renderers/minimapRenderer.js";
import { createNumberHud } from "./numberHud.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createWorldRenderer } from "./worldRenderer.js";
>>>>>>> 70aca42 (teste)

export function startClient(gameConfig) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const minimapCanvas = document.getElementById("minimapCanvas");
<<<<<<< HEAD
    const renderer = createCanvasRenderer(canvas, gameConfig);
    const minimap = createMinimapRenderer(minimapCanvas, gameConfig);
    const snapshots = createSnapshotInterpolator(gameConfig.network);
=======
    const renderer = createWorldRenderer(canvas, gameConfig, {
        onSnapshotCacheInvalid: invalidations => socket.emit("snapshotCacheInvalid", invalidations),
        onSnapshotResync: () => socket.emit("snapshotResync")
    });
    const minimap = createMinimapRenderer(minimapCanvas, gameConfig);
    const snapshots = createSnapshotInterpolator(gameConfig.network, {
        onResyncNeeded: () => socket.emit("snapshotResync")
    });
>>>>>>> 70aca42 (teste)
    const debugLevel = getDebugLevel();
    const hud = createHud({ debugLevel });
    const numberHud = createNumberHud();
    const frameMonitor = createFrameMonitor();
    let myId = null;
<<<<<<< HEAD
=======
    let lastViewportSentAt = 0;
    let lastThemeData = null;
>>>>>>> 70aca42 (teste)

    createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles);
    window.addEventListener("resize", resizeCanvases);

    socket.on("connect", () => {
        myId = socket.id;
<<<<<<< HEAD
    });

    socket.on("gameState", snapshots.processSnapshot);
=======
        renderer.setPlayerId(myId);
        sendViewportState(true);
    });

    // Número coletado pelo próprio jogador
    socket.on("numberCollected", data => {
        numberHud.showCollection(data);
    });

    socket.on("gameState", (snapshot, acknowledge) => {
        renderer.processSnapshot(snapshot);
        const applyResult = snapshots.processSnapshot(snapshot);

        // Atualiza HUD de tema a cada snapshot
        if (snapshot.numbers && snapshot.numbers.theme) {
            lastThemeData = snapshot.numbers;
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
>>>>>>> 70aca42 (teste)

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

<<<<<<< HEAD
        numberHud.update(state, myId);

=======
>>>>>>> 70aca42 (teste)
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
<<<<<<< HEAD
=======
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
>>>>>>> 70aca42 (teste)
    }
}
