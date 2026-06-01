import { createFrameMonitor, isDebugEnabled } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createCanvasRenderer } from "./renderer.js";
import { desenharCamadaMinimap } from "./renderers/minimapRenderer.js";
import { gameBus, GameEvents } from "./core/GameBus.js";
import { createCollisionSystem } from "./systems/CollisionSystem.js";

import {
    criarEstadoTerritorio,
    atualizarTerritorio,
    subtrairAreaInimiga,
    calcularAreaTerritorio,
    resetarTerritorio
} from "./territorioSystem.js";

// ─── Constantes ───────────────────────────────────────────────
const RESPAWN_DELAY_MS    = 5000;
const ELEM_SIZE_SQ        = 100 * 100;   // área de 1 "elemento" do conjunto (u²)
const TRAIL_SYNC_INTERVAL = 2;           // frames entre sincronizações de trail
const TRAIL_KILL_COOLDOWN = 800;         // ms mínimos entre reportTrailKill

export function startClient(gameConfig) {
    const socket = io({ transports: gameConfig.socket.transports });

    // ─── Elementos DOM ────────────────────────────────────────
    const canvas        = document.getElementById("gameCanvas");
    const minimapCanvas = document.getElementById("minimap");
    const statsEl       = document.getElementById("statsTerritorio");
    const statsCardEl   = document.getElementById("statsCardinalidade");
    const opFlashEl     = document.getElementById("operacaoFlash");

    // ─── Sistemas ─────────────────────────────────────────────
    const renderer      = createCanvasRenderer(canvas, gameConfig);
    const snapshots     = createSnapshotInterpolator(gameConfig.network);
    const hud           = createHud({ debugEnabled: isDebugEnabled() });
    const frameMonitor  = createFrameMonitor();
    const collision     = createCollisionSystem(gameConfig.world);
    const controles     = createInputControls(
        socket,
        gameConfig.inputBindings,
        gameConfig.inputActionAngles
    );

    // ─── Estado do Jogo ───────────────────────────────────────
    let myId              = null;
    let estadoTerritorio  = null;
    let isDead            = false;
    let deathTime         = null;
    let frameCount        = 0;
    let lastKillReport    = 0;

    // ─── Feedback Visual via GameBus ──────────────────────────
    // Módulos educacionais futuros podem subscrever os mesmos eventos
    // sem alterar este arquivo.
    gameBus.on(GameEvents.TERRITORY_CAPTURED, () => _mostrarFlash("A ∪ B"));
    gameBus.on(GameEvents.TERRITORY_LOST,     () => _mostrarFlash("A − B"));

    // ─── Eventos de Rede ──────────────────────────────────────
    window.addEventListener("resize", renderer.resizeCanvas);

    socket.on("connect", () => { myId = socket.id; });
    socket.on("gameState", snapshots.processSnapshot);

    socket.on("territorioSubtraido", poligono => {
        if (!estadoTerritorio || !Array.isArray(poligono)) return;
        subtrairAreaInimiga(estadoTerritorio, poligono);
        gameBus.emit(GameEvents.TERRITORY_LOST, { poligono });
    });

    socket.on("trailIntercepted", () => {
        if (!isDead) {
            gameBus.emit(GameEvents.TRAIL_INTERCEPTED, {});
            _morrer("intercepted");
        }
    });

    renderer.resizeCanvas();
    render();

    // ─── Loop Principal ───────────────────────────────────────
    function render() {
        requestAnimationFrame(render);
        frameMonitor.recordFrame(performance.now());
        frameCount++;

        const state = snapshots.getRenderState();

        hud.update({
            frameStats:    { frameMs: frameMonitor.getFrameMs(), fps: frameMonitor.getFps() },
            rendererStats: renderer.getDebugState(),
            snapshotStats: snapshots.getDebugState()
        });

        if (!state || !myId) return;

        const jogadorAtual = state[myId];

        // ── Território ────────────────────────────────────────
        if (!isDead) {
            if (!estadoTerritorio && jogadorAtual) {
                estadoTerritorio = criarEstadoTerritorio(jogadorAtual, gameConfig.world);
            }

            if (estadoTerritorio && jogadorAtual) {
                const resultado = atualizarTerritorio(
                    estadoTerritorio, jogadorAtual, gameConfig.world, state, myId
                );

                if (resultado.morreu) {
                    gameBus.emit(GameEvents.PLAYER_DIED, { cause: "self" });
                    _morrer("self");
                }

                if (resultado.inimigosAfetados) {
                    for (const [id, poligono] of Object.entries(resultado.inimigosAfetados)) {
                        socket.emit("subtrairTerritorio", { alvoId: id, poligono });
                    }
                    gameBus.emit(GameEvents.TERRITORY_CAPTURED, {
                        affectedEnemies: Object.keys(resultado.inimigosAfetados)
                    });
                }

                if (frameCount % TRAIL_SYNC_INTERVAL === 0) {
                    socket.emit("syncTrail", estadoTerritorio.trail);
                }
            }
        }

        // ── Colisão com Rastro Inimigo (perpetrador-side) ─────
        //
        // Detecta se EU cruzei o rastro de algum inimigo.
        // Uso do CollisionSystem com spatialGrid:
        //   • buildEnemyTrailGrid: reconstrói a grade com todos os segmentos
        //     de rastro inimigos (chamado apenas quando fora do cooldown).
        //   • checkIfOnEnemyTrail: retorna o ownerId do inimigo cuja trilha
        //     estou cruzando, ou null.
        //
        // Quando um inimigo é detectado: reporto ao servidor que ELE deve morrer.
        // O debounce no servidor (1500ms) previne kills duplicados.
        if (!isDead && jogadorAtual) {
            const now = performance.now();
            if (now - lastKillReport >= TRAIL_KILL_COOLDOWN) {
                collision.buildEnemyTrailGrid(state, myId);
                const victimId = collision.checkIfOnEnemyTrail(jogadorAtual.x, jogadorAtual.y);
                if (victimId) {
                    lastKillReport = now;
                    socket.emit("reportTrailKill", { victimId });
                }
            }
        }

        // ── Render ────────────────────────────────────────────
        const cameraOverride = (isDead && jogadorAtual)
            ? { x: jogadorAtual.territoryX, y: jogadorAtual.territoryY }
            : null;

        renderer.renderWorld(state, myId, estadoTerritorio, cameraOverride);
        desenharCamadaMinimap(minimapCanvas, state, myId, gameConfig.world, estadoTerritorio);
        _atualizarStats(state);

        if (isDead && deathTime !== null) {
            _desenharOverlayMorte(canvas, deathTime);
        }
    }

    // ─── Morte e Respawn ──────────────────────────────────────
    function _morrer(cause = "self") {
        isDead    = true;
        deathTime = performance.now();

        resetarTerritorio(estadoTerritorio);

        controles.desabilitar();
        socket.emit("respawn");
        socket.emit("syncTrail", []);

        setTimeout(() => {
            isDead = false;
            controles.habilitar();
            socket.emit("liberarMovimento");
            gameBus.emit(GameEvents.PLAYER_RESPAWNED, {});
        }, RESPAWN_DELAY_MS);
    }

    // ─── HUD: Estatísticas Educacionais ──────────────────────
    //
    //   |A| = N  — cardinalidade: número de "elementos" (100×100 u² cada)
    //   X.XX%    — percentual do mapa dominado
    //
    // Throttled a cada 10 frames (~6x/s) para evitar recálculo todo frame.
    function _atualizarStats(state) {
        if (frameCount % 10 !== 0) return;

        const area    = calcularAreaTerritorio(estadoTerritorio);
        const mapArea = Math.PI * gameConfig.world.mapRadius ** 2;
        const pct     = ((area / mapArea) * 100).toFixed(2);
        const card    = Math.floor(area / ELEM_SIZE_SQ);
        const cor     = (state && myId && state[myId]) ? state[myId].color : "#ffffff";

        if (statsEl)     { statsEl.textContent     = `${pct}%`; statsEl.style.color     = cor; }
        if (statsCardEl) { statsCardEl.textContent = `|A| = ${card}`; statsCardEl.style.color = cor; }
    }

    // ─── Flash de Operação de Conjunto ───────────────────────
    function _mostrarFlash(notacao) {
        if (!opFlashEl) return;
        opFlashEl.textContent = notacao;
        opFlashEl.classList.remove("flash-ativo");
        void opFlashEl.offsetWidth; // força reflow para reiniciar animação
        opFlashEl.classList.add("flash-ativo");
    }
}

// ─── Overlay de Morte ─────────────────────────────────────────
function _desenharOverlayMorte(canvas, deathTime) {
    const ctx = canvas.getContext("2d");
    const elapsed  = performance.now() - deathTime;
    const restante = Math.max(0, Math.ceil((5000 - elapsed) / 1000));

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "rgba(0,0,0,0.58)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    ctx.fillStyle = "#ff3333";
    ctx.font      = `bold ${Math.round(canvas.height * 0.09)}px Arial, sans-serif`;
    ctx.fillText("VOCÊ MORREU", cx, cy - canvas.height * 0.07);

    ctx.fillStyle = "#ffffff";
    ctx.font      = `${Math.round(canvas.height * 0.048)}px Arial, sans-serif`;
    ctx.fillText(`Respawnando em ${restante}s...`, cx, cy + canvas.height * 0.04);
}
