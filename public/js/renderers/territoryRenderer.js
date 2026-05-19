import { CELULA_BASE, TAMANHO_GRADE } from "../territorioSystem.js";

// drawTerritoryLayer — renderiza território de todos os jogadores no canvas principal.
//
// Ordem: inimigos primeiro (ficam abaixo), jogador local por cima.
// O jogador local usa white-erase antes do fill colorido para apagar
// qualquer camada inimiga que esteja embaixo, sem acúmulo de alpha.
export function drawTerritoryLayer(context, state, worldConfig, estadoTerritorio, idJogadorLocal) {
    // Inimigos: círculos semi-transparentes
    for (const player of Object.values(state)) {
        if (player.id === idJogadorLocal) continue;
        _drawCircle(context, player, worldConfig);
    }

    // Jogador local: polígono suave da grade (ou círculo de fallback)
    const jogadorLocal = state[idJogadorLocal];
    if (!jogadorLocal) return;

    if (estadoTerritorio) {
        _drawLocalTerritory(context, jogadorLocal, estadoTerritorio, worldConfig);
    } else {
        _drawCircle(context, jogadorLocal, worldConfig);
    }

    context.globalAlpha = 1.0;
}

// ─── Território Inimigo: Círculo Inicial ─────────────────────────────────────
function _drawCircle(context, player, worldConfig) {
    const r = worldConfig.initialTerritoryRadius;

    context.globalAlpha = 0.65;
    context.fillStyle = player.color;
    context.beginPath();
    context.arc(player.territoryX, player.territoryY, r, 0, Math.PI * 2);
    context.fill();

    context.globalAlpha = 1.0;
    context.strokeStyle = player.color;
    context.lineWidth = 5;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    context.arc(player.territoryX, player.territoryY, r, 0, Math.PI * 2);
    context.stroke();
}

// ─── Território Local: Polígono Suave + Rastro ────────────────────────────────
//
// Três passos:
//   0. White-erase  — preenche o polígono com branco opaco para apagar completamente
//                     qualquer círculo inimigo abaixo. Sem isso, o alpha do fill colorido
//                     misturaria com a cor inimiga e criaria sobreposição visual.
//   1. Fill colorido — semi-transparente com glow (efeito Paper.io)
//   2. Borda         — opaca, na cor do jogador
function _drawLocalTerritory(context, player, estadoTerritorio, worldConfig) {
    const { matrizTerritorio, caminhoAtual } = estadoTerritorio;
    const tamanhoCelula = (worldConfig.mapRadius * 2) / TAMANHO_GRADE;
    const { mapRadius } = worldConfig;

    const polygons = _buildOutlinePaths(matrizTerritorio, tamanhoCelula, mapRadius);

    if (polygons.length > 0) {
        // Passo 0: apaga território inimigo subjacente
        context.globalAlpha = 1.0;
        context.fillStyle = "#ffffff";
        for (const poly of polygons) { _drawSmoothedPolygon(context, poly); context.fill(); }

        // Passo 1: fill colorido com glow
        context.save();
        context.shadowColor = player.color;
        context.shadowBlur = 18;
        context.globalAlpha = 0.60;
        context.fillStyle = player.color;
        for (const poly of polygons) { _drawSmoothedPolygon(context, poly); context.fill(); }
        context.restore();

        // Passo 2: borda
        context.globalAlpha = 1.0;
        context.strokeStyle = player.color;
        context.lineWidth = 5;
        context.lineJoin = "round";
        context.lineCap = "round";
        for (const poly of polygons) { _drawSmoothedPolygon(context, poly); context.stroke(); }
    }

    // Rastro usando posições reais do jogador (sem zigzag de grade)
    if (caminhoAtual && caminhoAtual.length >= 2) {
        _drawTrail(context, caminhoAtual, player, worldConfig);
    }

    context.globalAlpha = 1.0;
}

// ─── Construção dos Polígonos de Contorno (Half-Edge Walk) ───────────────────
//
// Para cada célula BASE emite as arestas de fronteira (BASE↔não-BASE) em sentido
// horário usando índices de vértice de grade (STRIDE = N+1).
// Percorre o grafo de adjacência para fechar polígonos contínuos.
function _buildOutlinePaths(matrizTerritorio, tamanhoCelula, mapRadius) {
    const N      = TAMANHO_GRADE;
    const STRIDE = N + 1;
    const MAX    = STRIDE * STRIDE; // 2601 para N=50

    const adj = new Array(MAX);

    function isBase(l, c) {
        if (l < 0 || l >= N || c < 0 || c >= N) return false;
        return matrizTerritorio[l][c] === CELULA_BASE;
    }

    for (let lin = 0; lin < N; lin++) {
        for (let col = 0; col < N; col++) {
            if (!isBase(lin, col)) continue;
            const TL = lin * STRIDE + col;
            const TR = lin * STRIDE + (col + 1);
            const BR = (lin + 1) * STRIDE + (col + 1);
            const BL = (lin + 1) * STRIDE + col;
            if (!isBase(lin - 1, col)) (adj[TL] || (adj[TL] = [])).push(TR);
            if (!isBase(lin, col + 1)) (adj[TR] || (adj[TR] = [])).push(BR);
            if (!isBase(lin + 1, col)) (adj[BR] || (adj[BR] = [])).push(BL);
            if (!isBase(lin, col - 1)) (adj[BL] || (adj[BL] = [])).push(TL);
        }
    }

    function idxToWorld(idx) {
        return {
            x: (idx % STRIDE) * tamanhoCelula - mapRadius,
            y: Math.floor(idx / STRIDE) * tamanhoCelula - mapRadius
        };
    }

    const polygons = [];
    const visited  = new Set();

    for (let from = 0; from < MAX; from++) {
        if (!adj[from]) continue;
        for (const to of adj[from]) {
            const key = from * MAX + to;
            if (visited.has(key)) continue;

            visited.add(key);
            const poly = [idxToWorld(from)];
            let cur = to;

            while (cur !== from) {
                poly.push(idxToWorld(cur));
                const nexts = adj[cur];
                if (!nexts) break;
                let moved = false;
                for (const next of nexts) {
                    const k = cur * MAX + next;
                    if (!visited.has(k)) { visited.add(k); cur = next; moved = true; break; }
                }
                if (!moved) break;
            }

            if (poly.length >= 3) polygons.push(poly);
        }
    }

    return polygons;
}

// ─── Polígono com Cantos Suavizados (Quadratic Bézier) ───────────────────────
//
// Cada vértice da grade (ângulo reto) vira ponto de controle de uma curva
// quadrática. Os midpoints dos segmentos adjacentes são os pontos de ancoragem.
// Resultado: cantos arredondados, visual orgânico sem pixelação.
function _drawSmoothedPolygon(context, polygon) {
    if (polygon.length < 3) return;
    context.beginPath();
    for (let i = 0; i < polygon.length; i++) {
        const prev = polygon[(i - 1 + polygon.length) % polygon.length];
        const curr = polygon[i];
        const next = polygon[(i + 1) % polygon.length];
        const mx1  = (prev.x + curr.x) / 2;
        const my1  = (prev.y + curr.y) / 2;
        const mx2  = (curr.x + next.x) / 2;
        const my2  = (curr.y + next.y) / 2;
        if (i === 0) context.moveTo(mx1, my1);
        else         context.lineTo(mx1, my1);
        context.quadraticCurveTo(curr.x, curr.y, mx2, my2);
    }
    context.closePath();
}

// ─── Rastro com Bézier Contínuo (Posições Reais) ─────────────────────────────
//
// Usa caminhoAtual {x,y} (posições reais capturadas com throttle de distância)
// para traçar uma linha suave. Quadratic bézier entre midpoints = sem zigzag.
// Largura proporcional ao playerSize. Realce branco interno = "rastro ativo".
function _drawTrail(context, pts, player, worldConfig) {
    const largura = (worldConfig.playerSize || 70) * 1.4;

    context.lineCap  = "round";
    context.lineJoin = "round";

    context.beginPath();
    context.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        context.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    if (pts.length > 1) context.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);

    context.globalAlpha = 1.0;
    context.strokeStyle = player.color;
    context.lineWidth   = largura;
    context.stroke();

    context.strokeStyle = "rgba(255,255,255,0.55)";
    context.lineWidth   = largura * 0.4;
    context.stroke();

    context.globalAlpha = 1.0;
}
