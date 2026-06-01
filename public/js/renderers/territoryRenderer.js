// ============================================================
// territoryRenderer.js — Renderização Vetorial de Território
// ============================================================
//
// ANTES: recebia matrizTerritorio (grade 50×50), construía um grafo
// de adjacência (Half-Edge Walk) para extrair contornos de células,
// e desenhava polígonos "escada" com Bézier nos cantos.
// Resultado: bordas serrilhadas com resolução limitada pela célula (60u).
//
// DEPOIS: recebe polygon [{x,y}] diretamente — as posições REAIS do
// jogador, capturadas com precisão float. O renderizador aplica Bézier
// quadrático sobre midpoints dos vértices do polígono, criando uma
// curva contínua e orgânica sem nenhum artefato de grade.
//
// A diferença visual:
//   ANTES — bordas em degraus, cantos de 90°, aparência "Minecraft"
//   DEPOIS — bordas fluidas, qualquer ângulo, aparência Paper.io real

// Compatibilidade: importamos as constantes mas não as usamos diretamente
// (matrizTerritorio não existe no novo sistema)
import { CELULA_BASE, TAMANHO_GRADE } from "../territorioSystem.js";

// ─── Frustum Culling ─────────────────────────────────────────
//
// Retorna true se o bounding circle da entidade intersecta o viewport AABB.
// Evita renderização de inimigos, círculos e rastros fora da tela.
function _isVisible(x, y, radius, viewport) {
    if (!viewport) return true;
    return x + radius > viewport.minX && x - radius < viewport.maxX &&
           y + radius > viewport.minY && y - radius < viewport.maxY;
}

// ─── Entry Point ─────────────────────────────────────────────
export function drawTerritoryLayer(context, state, worldConfig, estadoTerritorio, idJogadorLocal, viewport) {
    const baseR = worldConfig.initialTerritoryRadius + 100; // raio de culling conservador

    // Inimigos: círculos + rastros (apenas entidades visíveis no viewport)
    for (const player of Object.values(state)) {
        if (player.id === idJogadorLocal) continue;

        // Cull pelo centro de território (base circle) e posição atual
        const baseVisible    = _isVisible(player.territoryX, player.territoryY, baseR, viewport);
        const playerVisible  = _isVisible(player.x, player.y, worldConfig.playerSize, viewport);
        const trailVisible   = player.trail && player.trail.length >= 2 &&
                               _isVisible(player.x, player.y, baseR * 2, viewport);

        if (!baseVisible && !playerVisible && !trailVisible) continue;

        if (baseVisible) _drawEnemyCircle(context, player, worldConfig);
        if (trailVisible) _drawEnemyTrail(context, player.trail, player);
    }

    const jogadorLocal = state[idJogadorLocal];
    if (!jogadorLocal) return;

    if (estadoTerritorio && estadoTerritorio.polygon) {
        // MODO VETORIAL: polígono direto (sistema novo)
        _drawVectorTerritory(context, jogadorLocal, estadoTerritorio);
    } else if (estadoTerritorio && estadoTerritorio.matrizTerritorio) {
        // MODO GRADE: fallback para compatibilidade com estado legado
        _drawGridTerritory(context, jogadorLocal, estadoTerritorio, worldConfig);
    } else {
        _drawEnemyCircle(context, jogadorLocal, worldConfig);
    }

    context.globalAlpha = 1.0;
}

// ─── Território Local Vetorial ────────────────────────────────
//
// Três passes (mesma estrutura visual do sistema antigo, mas sobre polígono real):
//   0. White-erase  — apaga círculos inimigos sobrepostos (sem acúmulo de alpha)
//   1. Fill colorido — semi-transparente com glow (efeito Paper.io)
//   2. Borda         — opaca, na cor do jogador
//   3. Trail         — rastro ativo com realce branco
//
// PATH2D CACHING:
//   O polígono de território muda raramente (apenas em capturas).
//   Sem cache: beginPath + N×lineTo rebuilda o path a cada frame (60fps → 60 rebuilds/s).
//   Com cache: o Path2D é construído UMA VEZ quando territorioDirty=true e
//   reusado nas chamadas fill(path) e stroke(path) nos frames seguintes.
//   Para 96 vértices (Chaikin 1× sobre 48), isso elimina ~5760 lineTo/s desnecessários.
//
//   Path2D usa referência ao objeto no GPU — fill(path) e stroke(path) enviam
//   a path uma única vez ao compositor, sem overhead de JS por vértice.
//
// LÓGICA × VISUAL:
//   polygon (lógico) — vértices reais, colisão/merge. Nunca alterados aqui.
//   _renderPolygon   — Chaikin smooth, apenas para desenho.
//   _cachedPath      — Path2D do _renderPolygon, recriado apenas quando dirty.
function _drawVectorTerritory(context, player, estadoTerritorio) {
    const { polygon, trail } = estadoTerritorio;

    if (!polygon || polygon.length < 3) return;

    // Reconstrói polígono suavizado + Path2D quando o lógico mudou.
    if (estadoTerritorio.territorioDirty || !estadoTerritorio._renderPolygon) {
        estadoTerritorio._renderPolygon  = _chaikinSmooth(polygon, 1);
        estadoTerritorio._cachedPolygons = [polygon];
        estadoTerritorio._cachedPath     = _buildPath2D(estadoTerritorio._renderPolygon);
        estadoTerritorio.territorioDirty = false;
    }

    const path = estadoTerritorio._cachedPath;

    // Passo 0: white-erase — apaga território inimigo embaixo
    context.globalAlpha = 1.0;
    context.fillStyle   = "#ffffff";
    context.fill(path);

    // Passo 1: fill com glow
    context.save();
    context.shadowColor = player.color;
    context.shadowBlur  = 8;
    context.globalAlpha = 0.60;
    context.fillStyle   = player.color;
    context.fill(path);
    context.restore();

    // Passo 2: borda
    context.globalAlpha  = 1.0;
    context.strokeStyle  = player.color;
    context.lineWidth    = 5;
    context.lineJoin     = "round";
    context.lineCap      = "round";
    context.stroke(path);

    // Passo 3: rastro ativo
    if (trail && trail.length >= 2) {
        _drawTrail(context, trail, player);
    }

    context.globalAlpha = 1.0;
}

// ─── Chaikin Corner-Cutting (render-only) ────────────────────
//
// RENDER: Suavização que NUNCA sai do convex hull do polígono.
// Cada iteração substitui cada par de vértices (P₀, P₁) por:
//   Q = 0.75·P₀ + 0.25·P₁   (¼ do caminho a partir de P₀)
//   R = 0.25·P₀ + 0.75·P₁   (¾ do caminho a partir de P₀)
// Resultado: curva B-spline quadrática que converge para dentro.
//
// 1 iteração dobra o número de vértices (48 → 96) e cria curvas
// suficientemente suaves para o nível visual do Paper.io, sem
// sobrecarga excessiva de vértices (2 iterações → 192, desnecessário).
//
// Por que não quadraticCurveTo direto?
//   quadraticCurveTo(Vᵢ, midpoint) trata Vᵢ como ponto de CONTROLE,
//   não de passagem. O path nunca passa por Vᵢ — passa pelo midpoint.
//   Para segmentos longos, o desvio é grande → território parece inflado.
//   Chaikin cria pontos reais que ficam no caminho, sem desvio espúrio.
function _chaikinSmooth(pts, iterations) {
    let cur = pts;
    for (let iter = 0; iter < iterations; iter++) {
        const n    = cur.length;
        const next = new Array(n * 2);
        for (let i = 0; i < n; i++) {
            const p0 = cur[i];
            const p1 = cur[(i + 1) % n];
            next[i * 2    ] = { x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y };
            next[i * 2 + 1] = { x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y };
        }
        cur = next;
    }
    return cur;
}

// ─── Construtor de Path2D ─────────────────────────────────────
//
// Constrói um Path2D reutilizável a partir de um array de pontos.
// O objeto Path2D é imutável após criação — pode ser passado diretamente
// para context.fill(path) e context.stroke(path) sem recriar o path
// a cada frame. Usado pelo cache de território.
function _buildPath2D(pts) {
    const path = new Path2D();
    if (pts.length < 3) return path;
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
        path.lineTo(pts[i].x, pts[i].y);
    }
    path.closePath();
    return path;
}

// ─── Polígono com lineTo (sem deformação de Bézier) ──────────
//
// RENDER: Traça o polígono usando apenas moveTo + lineTo + closePath.
// Usado sobre o _renderPolygon (já suavizado por Chaikin), que tem
// vértices suficientemente próximos para que segmentos retos pareçam curvos.
// Evita o "blob" do quadraticCurveTo em segmentos longos.
function _drawLinePoly(context, pts) {
    if (pts.length < 3) return;
    context.beginPath();
    context.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
        context.lineTo(pts[i].x, pts[i].y);
    }
    context.closePath();
}

// ─── Polígono Suavizado com Quadratic Bézier ─────────────────
//
// RENDER: Esta é a função que transforma vértices "crus" do polígono
// em curvas orgânicas.
//
// Técnica: para cada vértice Vᵢ, calcula-se o midpoint M₁ entre Vᵢ₋₁
// e Vᵢ, e o midpoint M₂ entre Vᵢ e Vᵢ₊₁. O trecho desenhado vai de
// M₁ até M₂ com Vᵢ como ponto de controle (quadratic Bézier).
//
// Resultado: curva que passa suavemente por todos os midpoints, com
// tangente contínua em cada ponto. Não há cantos angulosos.
//
// No sistema antigo: os "vértices" eram cantos de células (ângulo exato
// de 90°), e o Bézier apenas arredondava esses cantos fixos.
// No sistema novo: os "vértices" são posições reais do jogador — ângulos
// arbitrários — e o Bézier cria uma interpolação naturalmente suave.
function _strokeSmoothPolygon(context, pts) {
    if (pts.length < 3) return;
    const n = pts.length;
    context.beginPath();

    // Começa no midpoint entre o último e o primeiro vértice
    const mx0 = (pts[n - 1].x + pts[0].x) / 2;
    const my0 = (pts[n - 1].y + pts[0].y) / 2;
    context.moveTo(mx0, my0);

    for (let i = 0; i < n; i++) {
        const curr = pts[i];
        const next = pts[(i + 1) % n];
        const mx   = (curr.x + next.x) / 2;
        const my   = (curr.y + next.y) / 2;
        // curr é o ponto de controle; mx,my é o ponto de passagem
        context.quadraticCurveTo(curr.x, curr.y, mx, my);
    }

    context.closePath();
}

// ─── Trail Vetorial ───────────────────────────────────────────
//
// Renderiza o rastro ativo do jogador usando as posições REAIS (float).
// Quadratic Bézier com midpoints → linha orgânica, sem zigzag de grade.
//
// Dois passes no mesmo path (sem recriar beginPath):
//   1. Largura total na cor do jogador
//   2. Faixa central branca semi-transparente (realce de atividade)
function _drawTrail(context, pts, player, worldConfig) {
    // Largura relativa ao tamanho visual do jogador (1.4 era excessivo — inflava o rastro)
    const w = 70 * 1.0;

    context.lineCap  = "round";
    context.lineJoin = "round";

    context.beginPath();
    context.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        context.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    if (pts.length > 1) {
        context.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    }

    // Pass 1: cor do jogador
    context.globalAlpha = 1.0;
    context.strokeStyle = player.color;
    context.lineWidth   = w;
    context.stroke();

    // Pass 2: realce branco (sem recriar o path)
    context.strokeStyle = "rgba(255,255,255,0.55)";
    context.lineWidth   = w * 0.35;
    context.stroke();

    context.globalAlpha = 1.0;
}

// ─── Rastro de Inimigo ────────────────────────────────────────
//
// Renderiza o rastro ativo de um jogador inimigo recebido via snapshot.
// Visual ligeiramente diferente do rastro local: opacidade reduzida para não
// poluir a tela, mas claramente visível como zona de perigo.
function _drawEnemyTrail(context, pts, player) {
    const w = 70 * 0.90;

    context.lineCap  = "round";
    context.lineJoin = "round";

    context.beginPath();
    context.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        context.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    if (pts.length > 1) {
        context.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    }

    // Pass 1: cor do inimigo, semi-transparente
    context.globalAlpha = 0.78;
    context.strokeStyle = player.color;
    context.lineWidth   = w;
    context.stroke();

    // Pass 2: realce branco (menos intenso que o rastro local)
    context.strokeStyle = "rgba(255,255,255,0.38)";
    context.lineWidth   = w * 0.30;
    context.stroke();

    context.globalAlpha = 1.0;
}

// ─── Território Inimigo: Círculo ─────────────────────────────
// Inimigos são representados por círculo porque não temos acesso
// ao polígono deles (existe apenas no cliente de cada um).
function _drawEnemyCircle(context, player, worldConfig) {
    const r = worldConfig.initialTerritoryRadius;

    context.globalAlpha = 0.65;
    context.fillStyle = player.color;
    context.beginPath();
    context.arc(player.territoryX, player.territoryY, r, 0, Math.PI * 2);
    context.fill();

    context.globalAlpha  = 1.0;
    context.strokeStyle  = player.color;
    context.lineWidth    = 5;
    context.lineJoin     = "round";
    context.lineCap      = "round";
    context.beginPath();
    context.arc(player.territoryX, player.territoryY, r, 0, Math.PI * 2);
    context.stroke();
}

// ─── Fallback: Território de Grade (sistema antigo) ──────────
//
// Mantido como fallback de compatibilidade caso um estado legado
// (com matrizTerritorio) seja passado ao renderer.
// Será removido quando todos os clientes migrarem para o sistema vetorial.
function _drawGridTerritory(context, player, estadoTerritorio, worldConfig) {
    const { matrizTerritorio, caminhoAtual } = estadoTerritorio;
    const tamanhoCelula = (worldConfig.mapRadius * 2) / TAMANHO_GRADE;
    const { mapRadius } = worldConfig;

    if (estadoTerritorio.territorioDirty || !estadoTerritorio._cachedPolygons) {
        estadoTerritorio._cachedPolygons = _buildOutlinePaths(matrizTerritorio, tamanhoCelula, mapRadius);
        estadoTerritorio.territorioDirty = false;
    }

    const polygons = estadoTerritorio._cachedPolygons;
    if (!polygons || polygons.length === 0) return;

    context.globalAlpha = 1.0;
    context.fillStyle = "#ffffff";
    for (const poly of polygons) { _strokeSmoothPolygon(context, poly); context.fill(); }

    context.save();
    context.shadowColor = player.color;
    context.shadowBlur  = 18;
    context.globalAlpha = 0.60;
    context.fillStyle   = player.color;
    for (const poly of polygons) { _strokeSmoothPolygon(context, poly); context.fill(); }
    context.restore();

    context.globalAlpha = 1.0;
    context.strokeStyle = player.color;
    context.lineWidth   = 5;
    context.lineJoin    = "round";
    context.lineCap     = "round";
    for (const poly of polygons) { _strokeSmoothPolygon(context, poly); context.stroke(); }

    if (caminhoAtual && caminhoAtual.length >= 2) {
        _drawTrail(context, caminhoAtual, player, worldConfig);
    }

    context.globalAlpha = 1.0;
}

// ─── Half-Edge Walk (apenas para o fallback de grade) ─────────
function _buildOutlinePaths(matrizTerritorio, tamanhoCelula, mapRadius) {
    const N = TAMANHO_GRADE, STRIDE = N + 1, MAX = STRIDE * STRIDE;
    const adj = new Array(MAX);

    function isBase(l, c) {
        if (l < 0 || l >= N || c < 0 || c >= N) return false;
        return matrizTerritorio[l][c] === CELULA_BASE;
    }

    for (let lin = 0; lin < N; lin++) {
        for (let col = 0; col < N; col++) {
            if (!isBase(lin, col)) continue;
            const TL = lin * STRIDE + col,   TR = lin * STRIDE + (col + 1);
            const BR = (lin+1)*STRIDE+(col+1), BL = (lin+1)*STRIDE+col;
            if (!isBase(lin-1, col)) (adj[TL]||(adj[TL]=[])).push(TR);
            if (!isBase(lin, col+1)) (adj[TR]||(adj[TR]=[])).push(BR);
            if (!isBase(lin+1, col)) (adj[BR]||(adj[BR]=[])).push(BL);
            if (!isBase(lin, col-1)) (adj[BL]||(adj[BL]=[])).push(TL);
        }
    }

    function idxToWorld(idx) {
        return { x: (idx % STRIDE) * tamanhoCelula - mapRadius,
                 y: Math.floor(idx / STRIDE) * tamanhoCelula - mapRadius };
    }

    const polygons = [], visited = new Set();
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
