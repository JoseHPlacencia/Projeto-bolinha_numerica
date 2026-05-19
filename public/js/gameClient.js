import { createFrameMonitor, isDebugEnabled } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createCanvasRenderer } from "./renderer.js";
import { desenharCamadaMinimap } from "./renderers/minimapRenderer.js";

import {
    criarEstadoTerritorio,
    atualizarTerritorio,
    limparCelulasTerritorio
} from "./territorioSystem.js";

// Duração do overlay de morte e da trava de movimento (em ms).
const RESPAWN_DELAY_MS = 5000;

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
    let estadoTerritorio = null;

    // === ESTADO DE MORTE ===
    // isDead    — true enquanto o overlay de morte está visível
    // deathTime — timestamp do instante da morte (para o countdown)
    let isDead = false;
    let deathTime = null;

    // createInputControls agora retorna { desabilitar, habilitar }
    // para bloquear/liberar o envio de inputs ao servidor
    const controles = createInputControls(
        socket,
        gameConfig.inputBindings,
        gameConfig.inputActionAngles
    );

    window.addEventListener("resize", renderer.resizeCanvas);

    socket.on("connect", () => {
        myId = socket.id;
    });

    socket.on("gameState", snapshots.processSnapshot);

    // === TERRITÓRIO INIMIGO ===
    // O servidor encaminha este evento quando outro jogador passou pelo nosso
    // território e retornou à base — removemos as células do nosso domínio.
    socket.on("territorioSubtraido", celulas => {
        if (!estadoTerritorio || !Array.isArray(celulas)) return;
        limparCelulasTerritorio(estadoTerritorio, celulas);
    });

    renderer.resizeCanvas();
    render();

    // ─── Loop Principal de Renderização ──────────────────────────────────────
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

        if (!state || !myId) return;

        const jogadorAtual = state[myId];

        // === BLOQUEIO DURANTE MORTE ===
        // Enquanto isDead = true, suspendemos a atualização do território.
        // estadoTerritorio é preservado com as células BASE — a base fica visível
        // na tela e a câmera segue o jogador até o ponto de respawn na base.
        if (!isDead) {
            // Cria o estado de território na primeira vez que o jogador entra no jogo
            if (!estadoTerritorio && jogadorAtual) {
                estadoTerritorio = criarEstadoTerritorio(jogadorAtual, gameConfig.world);
            }

            if (estadoTerritorio && jogadorAtual) {
                const resultado = atualizarTerritorio(
                    estadoTerritorio,
                    jogadorAtual,
                    gameConfig.world,
                    state,
                    myId
                );

                // === AUTO-COLISÃO → MORTE ===
                if (resultado.morreu) {
                    _morrer();
                }

                // === TERRITÓRIO INIMIGO ===
                if (resultado.celulasSubtraidas) {
                    for (const [inimigoId, celulas] of Object.entries(resultado.celulasSubtraidas)) {
                        socket.emit("subtrairTerritorio", { alvoId: inimigoId, celulas });
                    }
                }
            }
        }

        // Durante a morte a câmera ignora a posição interpolada (que ainda pode estar
        // no local da morte) e centraliza IMEDIATAMENTE no centro da base do jogador.
        // territoryX/Y já está disponível no snapshot atual — sem esperar o próximo.
        const cameraOverride = (isDead && jogadorAtual)
            ? { x: jogadorAtual.territoryX, y: jogadorAtual.territoryY }
            : null;

        renderer.renderWorld(state, myId, estadoTerritorio, cameraOverride);
        desenharCamadaMinimap(minimapCanvas, state, myId, gameConfig.world, estadoTerritorio);

        // Overlay de morte desenhado por cima de tudo
        if (isDead && deathTime !== null) {
            _desenharOverlayMorte(canvas, deathTime);
        }
    }

    // ─── Lógica de Morte e Respawn ────────────────────────────────────────────
    //
    // Fluxo completo ao detectar auto-colisão:
    //
    //   t=0s  → _morrer() é chamado
    //           • atualizarTerritorio() JÁ limpou CELULA_RASTRO → VAZIA antes
    //             de retornar morreu:true — estadoTerritorio mantém apenas BASE
    //           • isDead = true            (ativa overlay, câmera fixa em territoryX/Y)
    //           • controles.desabilitar()  (bloqueia envio de inputs pelo cliente)
    //           • socket.emit("respawn")   (servidor: isDead=true, limpa inputs, teleporta
    //                                       para territoryX/Y — game loop para de mover)
    //           • cameraOverride usa territoryX/Y do snapshot atual → câmera instantânea
    //
    //   t=5s  → setTimeout dispara:
    //           • isDead = false              (remove overlay, câmera volta ao normal)
    //           • controles.habilitar()       (libera inputs no cliente)
    //           • socket.emit("liberarMovimento") (servidor: isDead=false, game loop retoma)
    //           • atualizarTerritorio() retoma com estado limpo (só BASE, sem rastro)
    function _morrer() {
        // estadoTerritorio é preservado: atualizarTerritorio() já converteu
        // todas as células RASTRO para VAZIA antes de retornar morreu:true.
        // Manter o estado deixa as células BASE visíveis durante o overlay e
        // garante que o jogador começa de dentro da própria base ao respawnar.
        isDead = true;
        deathTime = performance.now();

        controles.desabilitar();
        socket.emit("respawn");

        setTimeout(() => {
            isDead = false;
            controles.habilitar();
            // Notifica o servidor para retomar o game loop para este jogador.
            // Sincroniza com o timer do cliente — o servidor só move depois daqui.
            socket.emit("liberarMovimento");
        }, RESPAWN_DELAY_MS);
    }
}

// ─── Overlay de Morte ─────────────────────────────────────────────────────────
//
// Desenhado diretamente no canvas após todas as outras camadas.
// Mostra "VOCÊ MORREU" e o contador regressivo para o respawn.
function _desenharOverlayMorte(canvas, deathTime) {
    const ctx = canvas.getContext("2d");

    // Calcula segundos restantes (inclui o buffer de 0.2s → exibe "0" por 200ms)
    const decorrido = performance.now() - deathTime;
    const restante = Math.max(0, Math.ceil((RESPAWN_DELAY_MS - decorrido) / 1000));

    // Reseta a transformação para desenhar em coordenadas de pixel (não em espaço do mundo)
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Fundo escurecido
    ctx.fillStyle = "rgba(0, 0, 0, 0.58)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // "VOCÊ MORREU" em vermelho — tamanho proporcional ao canvas
    ctx.fillStyle = "#ff3333";
    ctx.font = `bold ${Math.round(canvas.height * 0.09)}px Arial, sans-serif`;
    ctx.fillText("VOCÊ MORREU", cx, cy - canvas.height * 0.07);

    // Contador regressivo em branco
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.round(canvas.height * 0.048)}px Arial, sans-serif`;
    ctx.fillText(`Respawnando em ${restante}s...`, cx, cy + canvas.height * 0.04);
}
