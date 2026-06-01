// ============================================================
// minimapRenderer.js — Minimapa (Território Próprio Apenas)
// ============================================================
//
// Exibe APENAS o estado do próprio jogador:
//   - Território dominado (polígono vetorial)
//   - Rastro ativo
//   - Ponto do próprio jogador
//
// Inimigos NÃO são exibidos:
//   - Menos poluição visual
//   - Foco pedagógico (o aluno vê seu próprio domínio)
//   - Melhor desempenho (sem iteração de todos os jogadores a cada frame)
//
// Renderização em dois passes:
//   1. Offscreen canvas: polígono de território (atualiza só quando minimapDirty=true)
//   2. Canvas principal: trail (atualiza todo frame pois muda continuamente)

import { CELULA_BASE, CELULA_RASTRO, TAMANHO_GRADE } from "../territorioSystem.js";

const TAMANHO_CELULA_MINIMAP = 150 / TAMANHO_GRADE;

// ─── Offscreen Canvas ─────────────────────────────────────────
let _offscreenCanvas = null;
let _offscreenCtx    = null;
let _offscreenColor  = null;

function _ensureOffscreen(tamanho) {
    if (!_offscreenCanvas) {
        _offscreenCanvas = document.createElement("canvas");
        _offscreenCanvas.width  = tamanho;
        _offscreenCanvas.height = tamanho;
        _offscreenCtx = _offscreenCanvas.getContext("2d");
    }
}

// ─── Função Principal ─────────────────────────────────────────
export function desenharCamadaMinimap(canvas, estado, idJogadorAtual, configMundo, estadoTerritorio) {
    const ctx    = canvas.getContext("2d");
    const tam    = canvas.width;
    const escala = (tam / 2) / configMundo.mapRadius;
    const cx     = tam / 2;
    const cy     = tam / 2;

    ctx.clearRect(0, 0, tam, tam);
    ctx.save();

    // Clip circular — tudo dentro do círculo
    ctx.beginPath();
    ctx.arc(cx, cy, cx, 0, Math.PI * 2);
    ctx.clip();

    // Fundo semi-opaco
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, tam, tam);

    // Círculo do mapa (área jogável)
    ctx.beginPath();
    ctx.arc(cx, cy, configMundo.mapRadius * escala, 0, Math.PI * 2);
    ctx.fillStyle = "#d8d8d8";
    ctx.fill();

    // ── Território do próprio jogador ─────────────────────────
    const jogador = estado[idJogadorAtual];
    if (jogador && estadoTerritorio) {
        _ensureOffscreen(tam);

        if (estadoTerritorio.polygon && estadoTerritorio.polygon.length >= 3) {
            _desenharPoligono(ctx, jogador.color, estadoTerritorio, cx, cy, escala, tam);
            _desenharTrail(ctx, estadoTerritorio.trail, jogador.color, cx, cy, escala);
        }

        _desenharPonto(ctx, jogador, cx, cy, escala);
    }

    ctx.restore();

    // Borda circular (fora do clip para não ser cortada)
    ctx.beginPath();
    ctx.arc(cx, cy, cx - 1, 0, Math.PI * 2);
    ctx.lineWidth   = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.stroke();
}

// ─── Polígono de Território (Offscreen) ───────────────────────
//
// O polígono é desenhado no offscreen e copiado para o canvas principal.
// Só redraw quando minimapDirty=true (território mudou) ou cor mudou.
// O trail é sempre desenhado direto no canvas principal (muda todo frame).
function _desenharPoligono(ctx, cor, estadoTerritorio, cx, cy, escala, tam) {
    const dirty   = estadoTerritorio.minimapDirty;
    const corNova = cor !== _offscreenColor;

    if (dirty || corNova || !_offscreenColor) {
        _redesenharOffscreen(cor, estadoTerritorio.polygon, cx, cy, escala, tam);
        _offscreenColor = cor;
        estadoTerritorio.minimapDirty = false;
    }

    ctx.globalAlpha = 1.0;
    ctx.drawImage(_offscreenCanvas, 0, 0);
}

function _redesenharOffscreen(cor, poly, cx, cy, escala, tam) {
    const ctx2 = _offscreenCtx;
    ctx2.clearRect(0, 0, tam, tam);
    if (!poly || poly.length < 3) return;

    // Fill semi-transparente
    ctx2.globalAlpha = 0.65;
    ctx2.fillStyle   = cor;
    _tracarPoligono(ctx2, poly, cx, cy, escala);
    ctx2.fill();

    // Borda opaca
    ctx2.globalAlpha = 0.90;
    ctx2.strokeStyle = cor;
    ctx2.lineWidth   = 1.5;
    ctx2.lineJoin    = "round";
    ctx2.lineCap     = "round";
    _tracarPoligono(ctx2, poly, cx, cy, escala);
    ctx2.stroke();

    ctx2.globalAlpha = 1.0;
}

function _tracarPoligono(ctx, poly, cx, cy, escala) {
    ctx.beginPath();
    ctx.moveTo(cx + poly[0].x * escala, cy + poly[0].y * escala);
    for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(cx + poly[i].x * escala, cy + poly[i].y * escala);
    }
    ctx.closePath();
}

// ─── Trail Ativo ──────────────────────────────────────────────
//
// Desenhado diretamente no canvas principal (não offscreen) para ter
// zero latência — muda continuamente enquanto o jogador está fora da base.
function _desenharTrail(ctx, trail, cor, cx, cy, escala) {
    if (!trail || trail.length < 2) return;

    ctx.globalAlpha = 0.92;
    ctx.strokeStyle = cor;
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.beginPath();
    ctx.moveTo(cx + trail[0].x * escala, cy + trail[0].y * escala);
    for (let i = 1; i < trail.length; i++) {
        ctx.lineTo(cx + trail[i].x * escala, cy + trail[i].y * escala);
    }
    ctx.stroke();

    // Realce branco central no trail (indica risco de auto-colisão)
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.globalAlpha = 1.0;
}

// ─── Ponto do Jogador ─────────────────────────────────────────
function _desenharPonto(ctx, jogador, cx, cy, escala) {
    const px = cx + jogador.x * escala;
    const py = cy + jogador.y * escala;

    // Sombra para legibilidade
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur  = 4;

    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = jogador.color;
    ctx.fill();

    ctx.shadowBlur  = 0;
    ctx.lineWidth   = 1.5;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
}
