import { createFrameMonitor, isDebugEnabled } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createCanvasRenderer } from "./renderer.js";

export function startClient(gameConfig) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const renderer = createCanvasRenderer(canvas, gameConfig);
    const snapshots = createSnapshotInterpolator(gameConfig.network);
    const hud = createHud({ debugEnabled: isDebugEnabled() });
    const frameMonitor = createFrameMonitor();
    let myId = null;

    createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles);
    window.addEventListener("resize", renderer.resizeCanvas);

    socket.on("connect", () => {
        myId = socket.id;
    });

    socket.on("gameState", snapshots.processSnapshot);

    renderer.resizeCanvas();
    render();

    function render() {
        requestAnimationFrame(render);
        frameMonitor.recordFrame(performance.now());

        const state = snapshots.getRenderState();

        hud.update({
            frameStats: {
                frameMs: frameMonitor.getFrameMs(),
                fps: frameMonitor.getFps()
            },
            rendererStats: renderer.getDebugState(),
            snapshotStats: snapshots.getDebugState()
        });

        if (!state || !myId) {
            return;
        }

        renderer.renderWorld(state, myId);
    }
}
