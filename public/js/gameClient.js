import { createFrameMonitor, isDebugEnabled } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createCanvasRenderer } from "./renderer.js";
import { desenharCamadaMinimap } from "./renderers/minimapRenderer.js";

// Importa as funções do sistema de território que criamos em territorioSystem.js
// criarEstadoTerritorio — cria a grade inicial com a base do jogador marcada
// atualizarTerritorio   — atualiza rastro e conquista área a cada frame
import { criarEstadoTerritorio, atualizarTerritorio } from "./territorioSystem.js";

export function startClient(gameConfig) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const renderer = createCanvasRenderer(canvas, gameConfig);
    const minimapCanvas = document.getElementById("minimap");
    const snapshots = createSnapshotInterpolator(gameConfig.network);
    const hud = createHud({ debugEnabled: isDebugEnabled() });
    const frameMonitor = createFrameMonitor();
    let myId = null;

    // Guarda o estado de território do jogador local (grade + rastro + flags).
    // Começa como null e é criado na primeira vez que recebemos os dados do jogador.
    let estadoTerritorio = null;

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

        // Pega os dados mais recentes do jogador local a partir do estado interpolado
        const jogadorAtual = state[myId];

        // Se ainda não criamos o estado de território e já temos dados do jogador,
        // criamos agora (só acontece uma vez, no primeiro frame com dados válidos)
        if (!estadoTerritorio && jogadorAtual) {
            estadoTerritorio = criarEstadoTerritorio(jogadorAtual, gameConfig.world);
        }

        // A cada frame, atualiza o território: registra rastro ou executa Flood Fill
        // Isso mantém a grade sincronizada com a posição atual do jogador
        if (estadoTerritorio && jogadorAtual) {
            atualizarTerritorio(estadoTerritorio, jogadorAtual, gameConfig.world);
        }

        // Passa o estadoTerritorio para o renderer poder desenhar o território no mundo
        renderer.renderWorld(state, myId, estadoTerritorio);

        // Passa o estadoTerritorio para o minimapa poder desenhar a grade de células
        desenharCamadaMinimap(minimapCanvas, state, myId, gameConfig.world, estadoTerritorio);
    }
}
