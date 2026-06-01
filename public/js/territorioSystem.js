// ============================================================
// territorioSystem.js — Sistema Vetorial de Território
// ============================================================
//
// Propriedade exclusiva: cada região do mapa pertence a NO MÁXIMO
// um jogador. Quando A captura uma área, o polígono da área capturada
// é enviado a TODOS os outros jogadores — cada um subtrai a interseção
// do próprio polígono. Não há sobreposição de domínio.
//
// Pipeline de captura:
//   1. Jogador retorna à base com trail ativo
//   2. _mergeTrail → newPolygon (território expandido) + capturedArea
//   3. capturedArea enviada a TODOS os inimigos via socket
//   4. Cada inimigo executa _polygonDifference(seuPoligono, capturedArea)
//   5. Resultado: apenas A possui a região capturada

// ─── Exports de Compatibilidade ───────────────────────────────
export const CELULA_BASE   = 1;
export const CELULA_RASTRO = 2;
export const CELULA_VAZIA  = 0;
export const TAMANHO_GRADE = 50;

// ─── Configurações ───────────────────────────────────────────
const POLYGON_POINTS     = 48;
const MIN_TRAIL_DIST_SQ  = 20 * 20;
const TRAIL_GRACE_SEGS   = 8;
const SIMPLIFY_ANGLE_DEG = 1.5;

// ─── Criação do Estado ────────────────────────────────────────
export function criarEstadoTerritorio(jogador, configMundo) {
    return {
        polygon: _criarCirculo(
            jogador.territoryX,
            jogador.territoryY,
            configMundo.initialTerritoryRadius,
            POLYGON_POINTS
        ),

        trail:            [],
        estaForaDaBase:   false,
        territorioDirty:  true,
        minimapDirty:     true,
        _cachedPolygons:  null,
        _renderPolygon:   null,

        // Centro e raio da base — usados para reset quando território é
        // completamente capturado por um inimigo.
        baseCenterX: jogador.territoryX,
        baseCenterY: jogador.territoryY,
        baseRadius:  configMundo.initialTerritoryRadius,

        // Aliases legados
        caminhoAtual:      [],
        rastro:            new Set(),
        matrizTerritorio:  null,
        regioesCapturadas: [],
    };
}

// ─── Atualização Principal ─────────────────────────────────────
//
// Retorna: { morreu: bool, inimigosAfetados: Object|null }
//   inimigosAfetados = { [enemyId]: [{x,y}] }
//
// DOMINAÇÃO EXCLUSIVA: inimigosAfetados contém TODOS os inimigos
// (não apenas aqueles cuja base está na área capturada). Cada inimigo
// subtrai a interseção localmente — se não há sobreposição, a operação
// retorna imediatamente sem alteração.
export function atualizarTerritorio(estadoTerritorio, jogador, configMundo, state, myId) {
    const emBase = _pointInPolygon(jogador.x, jogador.y, estadoTerritorio.polygon);

    if (emBase) {
        let inimigosAfetados = null;

        if (estadoTerritorio.estaForaDaBase && estadoTerritorio.trail.length >= 2) {
            const mergeResult = _mergeTrail(
                estadoTerritorio.polygon,
                estadoTerritorio.trail,
                estadoTerritorio.baseCenterX,
                estadoTerritorio.baseCenterY
            );
            const cleaned = _cleanupPolygon(mergeResult.newPolygon, 4);
            estadoTerritorio.polygon = _simplifyPolygon(cleaned, SIMPLIFY_ANGLE_DEG);
            estadoTerritorio.territorioDirty = true;
            estadoTerritorio.minimapDirty    = true;

            // Broadcast a capturedArea para TODOS os inimigos.
            // Propriedade exclusiva: qualquer sobreposição é removida no cliente do inimigo.
            // O _polygonDifference retorna o polígono intacto quando não há sobreposição,
            // então enviar para todos é seguro e garante consistência.
            if (state && myId && mergeResult.capturedArea && mergeResult.capturedArea.length >= 3) {
                for (const [id] of Object.entries(state)) {
                    if (id === myId) continue;
                    if (!inimigosAfetados) inimigosAfetados = {};
                    inimigosAfetados[id] = mergeResult.capturedArea;
                }
            }
        }

        estadoTerritorio.trail = [];
        estadoTerritorio.caminhoAtual = estadoTerritorio.trail;
        estadoTerritorio.estaForaDaBase = false;

        return { morreu: false, inimigosAfetados };

    } else {
        estadoTerritorio.estaForaDaBase = true;

        _addTrailPoint(estadoTerritorio.trail, jogador.x, jogador.y);
        estadoTerritorio.caminhoAtual = estadoTerritorio.trail;

        if (_checkSelfIntersection(estadoTerritorio.trail, TRAIL_GRACE_SEGS)) {
            estadoTerritorio.trail = [];
            estadoTerritorio.caminhoAtual = [];
            estadoTerritorio.estaForaDaBase = false;
            return { morreu: true, inimigosAfetados: null };
        }

        return { morreu: false, inimigosAfetados: null };
    }
}

// ─── Subtração de Território por Ataque Inimigo ───────────────
//
// Recebe o polígono da área capturada pelo inimigo e subtrai a interseção.
//
// Caso especial: se 100% do território for capturado (resultado vazio),
// reseta para o círculo base inicial — o jogador continua vivo mas
// precisa reconquistar território a partir do zero.
export function subtrairAreaInimiga(estado, poligonoCapturado) {
    if (!estado || !estado.polygon || !poligonoCapturado || poligonoCapturado.length < 3) {
        if (estado) { estado.territorioDirty = true; estado.minimapDirty = true; }
        return;
    }

    const resultado = _polygonDifference(estado.polygon, poligonoCapturado);

    if (resultado === null || resultado.length === 0) {
        // Território completamente capturado: reseta para base inicial
        estado.polygon = _criarCirculo(
            estado.baseCenterX,
            estado.baseCenterY,
            estado.baseRadius,
            POLYGON_POINTS
        );
    } else if (resultado.length >= 4) {
        const cleaned = _cleanupPolygon(resultado, 4);
        if (cleaned.length >= 4) {
            estado.polygon = _simplifyPolygon(cleaned, SIMPLIFY_ANGLE_DEG);
        }
    }

    estado.territorioDirty = true;
    estado.minimapDirty    = true;
    estado._renderPolygon  = null;
    estado._cachedPolygons = null;
}

// Mantido por compatibilidade com código antigo
export function limparCelulasTerritorio(estado, celulas) {
    if (estado) { estado.territorioDirty = true; estado.minimapDirty = true; }
}

// Retorna a área em unidades² do polígono de território atual.
export function calcularAreaTerritorio(estado) {
    if (!estado || !estado.polygon || estado.polygon.length < 3) return 0;
    return _polygonArea(estado.polygon);
}

// Reseta o território para o círculo base inicial (chamado no respawn).
// O jogador perde todo o domínio conquistado e recomeça do zero.
export function resetarTerritorio(estado) {
    if (!estado) return;
    estado.polygon = _criarCirculo(
        estado.baseCenterX,
        estado.baseCenterY,
        estado.baseRadius,
        POLYGON_POINTS
    );
    estado.trail          = [];
    estado.caminhoAtual   = [];
    estado.estaForaDaBase = false;
    estado.territorioDirty  = true;
    estado.minimapDirty     = true;
    estado._renderPolygon   = null;
    estado._cachedPolygons  = null;
}

// ============================================================
// GEOMETRIA VETORIAL — Funções Internas
// ============================================================

// ─── Círculo Inicial ─────────────────────────────────────────
function _criarCirculo(cx, cy, radius, numPoints) {
    const pts = [];
    for (let i = 0; i < numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        pts.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    }
    return pts;
}

// ─── Ponto Dentro do Polígono (Ray Casting) ───────────────────
function _pointInPolygon(px, py, polygon) {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        if (((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// ─── Adição de Ponto ao Rastro ────────────────────────────────
function _addTrailPoint(trail, x, y) {
    const last = trail[trail.length - 1];
    if (last) {
        const dx = x - last.x, dy = y - last.y;
        if (dx * dx + dy * dy < MIN_TRAIL_DIST_SQ) return;
    }
    trail.push({ x, y });
}

// ─── Auto-Colisão do Rastro ───────────────────────────────────
function _checkSelfIntersection(trail, graceSegs) {
    const n = trail.length;
    if (n < 4) return false;
    const p3 = trail[n - 2];
    const p4 = trail[n - 1];
    const limit = n - 2 - graceSegs;
    for (let i = 0; i < limit - 1; i++) {
        if (_segmentsIntersect(trail[i], trail[i + 1], p3, p4)) return true;
    }
    return false;
}

// ─── Interseção de Segmentos (bool) ──────────────────────────
function _segmentsIntersect(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return false;
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
    return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
}

// ─── Interseção de Segmentos (ponto) ─────────────────────────
function _lineSegmentIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1x = bx - ax, d1y = by - ay;
    const d2x = dx - cx, d2y = dy - cy;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
    if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) {
        return { x: ax + t * d1x, y: ay + t * d1y, t };
    }
    return null;
}

// ─── Ponto Mais Próximo num Segmento ─────────────────────────
function _closestPointOnSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) return { x: ax, y: ay, distSq: (px - ax) ** 2 + (py - ay) ** 2 };
    const t  = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const cx = ax + t * dx, cy = ay + t * dy;
    return { x: cx, y: cy, distSq: (px - cx) ** 2 + (py - cy) ** 2 };
}

// ─── Inserção de Ponto na Fronteira do Polígono ───────────────
function _insertOnPolygon(polygon, px, py) {
    let bestDist = Infinity, bestEdge = 0, bx = px, by = py;
    const n = polygon.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const cp = _closestPointOnSegment(px, py,
            polygon[i].x, polygon[i].y, polygon[j].x, polygon[j].y);
        if (cp.distSq < bestDist) {
            bestDist = cp.distSq; bestEdge = i; bx = cp.x; by = cp.y;
        }
    }
    const result = [...polygon];
    result.splice(bestEdge + 1, 0, { x: bx, y: by });
    return { polygon: result, insertedAt: bestEdge + 1 };
}

// ─── Índice do Vértice Mais Próximo ──────────────────────────
function _nearestVertexIndex(polygon, px, py) {
    let bestDist = Infinity, bestIdx = 0;
    for (let i = 0; i < polygon.length; i++) {
        const dx = polygon[i].x - px, dy = polygon[i].y - py;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
}

// ─── Fatia de Polígono ────────────────────────────────────────
function _polygonSlice(poly, from, to) {
    const n = poly.length;
    const result = [];
    let i = from;
    do {
        result.push(poly[i]);
        i = (i + 1) % n;
    } while (i !== to);
    result.push(poly[to]);
    return result;
}

// ─── Área do Polígono (Shoelace) ──────────────────────────────
function _polygonArea(poly) {
    let area = 0;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        area += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    }
    return Math.abs(area) * 0.5;
}

// ─── AABB do Polígono ─────────────────────────────────────────
function _polyBBox(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

// ─── Merge do Rastro no Polígono ──────────────────────────────
//
// Retorna { newPolygon, capturedArea }:
//   newPolygon   = polígono expandido (território novo)
//   capturedArea = região adicionada (bounded by trail + arco do polígono antigo)
//
// Seleção de candidatos — critério em ordem de prioridade:
//
//   1. BASE CENTER CHECK (primário, mais confiável):
//      O novo território DEVE conter o centro da base do jogador (baseCX/CY).
//      Isso é sempre verdade geometricamente: ao fechar um loop, o território
//      resultante engloba a base original mais a nova área capturada.
//      Se candA contém a base → candA = newPolygon, candB = capturedArea.
//      Se candB contém a base → candB = newPolygon, candA = capturedArea.
//
//   2. ÁREA (fallback):
//      Se o point-in-polygon falhar em ambos (borda do polígono tocando a base),
//      usa o critério anterior: maior área = novo território.
//      Cobre edge cases onde a base está exatamente na fronteira dos candidatos.
//
// POR QUE O CHECK DE ÁREA SOZINHO FALHA?
//   Quando o jogador faz um loop MUITO GRANDE envolvendo quase o mapa inteiro,
//   candB (área capturada) pode ser maior que candA (novo território sem a área
//   capturada). O critério de área inverte os candidatos, gerando território incorreto.
//   O base center check resolve este edge case de forma inequívoca.
function _mergeTrail(polygon, trail, baseCX, baseCY) {
    if (trail.length < 2) return { newPolygon: polygon, capturedArea: null };

    const exitPos   = trail[0];
    const returnPos = trail[trail.length - 1];

    const r1 = _insertOnPolygon(polygon, exitPos.x, exitPos.y);
    const r2 = _insertOnPolygon(r1.polygon, returnPos.x, returnPos.y);
    const p  = r2.polygon;

    const exitIdx   = _nearestVertexIndex(p, exitPos.x, exitPos.y);
    const returnIdx = _nearestVertexIndex(p, returnPos.x, returnPos.y);

    if (exitIdx === returnIdx) return { newPolygon: p, capturedArea: null };

    const trailMid = trail.slice(1, -1);

    const candA = [..._polygonSlice(p, returnIdx, exitIdx), ...trailMid];
    const candB = [..._polygonSlice(p, exitIdx, returnIdx), ...[...trailMid].reverse()];

    // Critério primário: o candidato que contém o centro da base = novo território
    if (baseCX !== undefined && baseCY !== undefined) {
        if (_pointInPolygon(baseCX, baseCY, candA)) {
            return { newPolygon: candA, capturedArea: candB };
        }
        if (_pointInPolygon(baseCX, baseCY, candB)) {
            return { newPolygon: candB, capturedArea: candA };
        }
    }

    // Fallback: o candidato maior = novo território (funciona para loops normais)
    if (_polygonArea(candA) >= _polygonArea(candB)) {
        return { newPolygon: candA, capturedArea: candB };
    }
    return { newPolygon: candB, capturedArea: candA };
}

// ─── Remoção de Pontos Muito Próximos ────────────────────────
function _cleanupPolygon(pts, minDist) {
    if (pts.length <= 4) return pts;
    const minDistSq = minDist * minDist;
    const result = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const prev = result[result.length - 1];
        const dx = pts[i].x - prev.x, dy = pts[i].y - prev.y;
        if (dx * dx + dy * dy >= minDistSq) result.push(pts[i]);
    }
    return result.length >= 4 ? result : pts;
}

// ─── Simplificação de Polígono ────────────────────────────────
function _simplifyPolygon(pts, angleThresholdDeg) {
    if (pts.length <= 8) return pts;
    const n = pts.length;
    const cosT = Math.cos(angleThresholdDeg * Math.PI / 180);
    const result = [];

    for (let i = 0; i < n; i++) {
        const prev = pts[(i - 1 + n) % n];
        const curr = pts[i];
        const next = pts[(i + 1) % n];
        const d1x = curr.x - prev.x, d1y = curr.y - prev.y;
        const d2x = next.x - curr.x, d2y = next.y - curr.y;
        const len1 = Math.hypot(d1x, d1y);
        const len2 = Math.hypot(d2x, d2y);
        if (len1 < 1e-6 || len2 < 1e-6) continue;
        const dot = (d1x * d2x + d1y * d2y) / (len1 * len2);
        if (dot <= cosT) result.push(curr);
    }

    return result.length >= 4 ? result : pts;
}

// ─── Polygon Difference Robusto (A - B) ───────────────────────
//
// Remove de `subject` a região que intersecta com `clip`.
//
// Retorna:
//   - Array de pontos ≥ 3: polígono resultante após remoção
//   - Array vazio []: subject estava COMPLETAMENTE dentro de clip
//     → caller deve resetar para território mínimo
//   - `subject` sem alteração: nenhuma sobreposição detectada
//
// Algoritmo:
//   1. Fast-exit: se nenhum vértice do subject está dentro do clip → sem sobreposição
//   2. Se TODOS os vértices estão dentro do clip → territory completamente capturada
//   3. Caso parcial: constrói lista aumentada (vértices + pontos de interseção),
//      mantém apenas vértices FORA do clip e pontos de interseção (fronteira).
//      Pontos de interseção criam "cuts" retos entre as regiões externas adjacentes.
function _polygonDifference(subject, clip) {
    if (!subject || subject.length < 3 || !clip || clip.length < 3) return subject;

    const n = subject.length;
    const m = clip.length;

    // Fast-exit por AABB antes do ray-casting: se as bounding boxes não se sobrepõem,
    // não pode haver interseção — evita O(n) ray-casting no caso comum (sem sobreposição).
    const sBbox = _polyBBox(subject);
    const cBbox = _polyBBox(clip);
    if (sBbox.maxX < cBbox.minX || sBbox.minX > cBbox.maxX ||
        sBbox.maxY < cBbox.minY || sBbox.minY > cBbox.maxY) {
        return subject;
    }

    // Classifica vértices do subject em relação ao clip
    let insideCount = 0;
    const vertexInside = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (_pointInPolygon(subject[i].x, subject[i].y, clip)) {
            vertexInside[i] = 1;
            insideCount++;
        }
    }

    if (insideCount === 0) return subject;       // sem sobreposição
    if (insideCount === n) return [];            // completamente capturado

    // Sobreposição parcial: constrói lista aumentada com pontos de interseção
    const augmented = [];
    for (let i = 0; i < n; i++) {
        const a = subject[i];
        const b = subject[(i + 1) % n];

        augmented.push({ x: a.x, y: a.y, isX: false, inside: vertexInside[i] === 1 });

        const edgeXs = [];
        for (let j = 0; j < m; j++) {
            const c = clip[j];
            const d = clip[(j + 1) % m];
            const pt = _lineSegmentIntersect(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
            if (pt) edgeXs.push({ x: pt.x, y: pt.y, isX: true, inside: false, t: pt.t });
        }
        edgeXs.sort((p, q) => p.t - q.t);
        for (const ix of edgeXs) augmented.push(ix);
    }

    const result = augmented
        .filter(v => !v.inside)
        .map(v => ({ x: v.x, y: v.y }));

    return result.length >= 3 ? result : subject;
}
