// ============================================================
// systems/CollisionSystem.js — Detecção de Colisão com Rastro
// ============================================================
//
// Detecta quando o jogador local cruza o rastro de um inimigo.
// Detecção feita do lado do PERPETRADOR (quem cruza), não da vítima.
//
// POR QUE PERPETRADOR-SIDE?
//   Abordagem anterior (vítima reporta própria morte):
//     - Vítima B verifica se inimigos A estão sobre SEU rastro
//     - Rastro de B = precisão máxima (local)
//     - Posição de A = do snapshot (tem lag de rede)
//
//   Nova abordagem (perpetrador reporta morte da vítima):
//     - Perpetrador A verifica se ELE está sobre rastro de B
//     - Rastro de B = do snapshot (tem lag, mas aceitável)
//     - Posição de A = do snapshot (mesmo instante temporal)
//     - Mais consistente: A e B lêem dados do mesmo snapshot
//
//   Debounce no servidor (1500ms por vítima) garante que
//   múltiplos perpetradores não causem mortes duplas.
//
// SPATIAL GRID (spatialGrid.js):
//   O jogo já possui uma grade espacial — aqui a integramos.
//   Em vez de O(N_inimigos × L_rastro) verificações por frame,
//   a grade reduz para O(candidatos na vizinhança) ≈ O(1) amortizado.
//
//   Para N=10 inimigos × L=120 pontos = 1200 checks/frame sem grid.
//   Com grid de células de 150u: tipicamente 5-20 candidatos por query.
//
//   Custo de manutenção: grid.clear() + inserção de todos os pontos
//   de rastro, executado uma vez a cada COOLDOWN (não todo frame).

import { createSpatialGrid } from "../spatialGrid.js";

// Tamanho de cada célula da grade (unidades do mundo).
// Deve ser >= 2 × colisão_radius para garantir que segmentos
// cujos endpoints estão em células adjacentes sejam encontrados.
const GRID_CELL_SIZE = 150;

// Segmentos iniciais do rastro do inimigo ignorados na detecção.
// Evita falsos positivos perto do ponto de saída da base inimiga.
const GRACE_SEGS = 6;

export function createCollisionSystem(worldConfig) {
    const diam   = worldConfig.mapRadius * 2;
    const grid   = createSpatialGrid(diam, diam, GRID_CELL_SIZE);
    const colRadius   = worldConfig.playerSize * 0.45;
    const colRadiusSq = colRadius * colRadius;
    // Query com margem extra para pegar segmentos cujos endpoints
    // estão além do raio de colisão mas cujo interior passa por ele.
    const queryRadius = colRadius + GRID_CELL_SIZE * 0.5;

    return { buildEnemyTrailGrid, checkIfOnEnemyTrail };

    // ─── buildEnemyTrailGrid ──────────────────────────────────
    //
    // Reconstrói a grade com todos os segmentos de rastro inimigos.
    // Chamado apenas quando o cooldown de kill permite nova detecção
    // (ver gameClient.js), não todo frame — custo amortizado.
    //
    // Insere AMBOS os endpoints de cada segmento para garantir
    // que segmentos cujo midpoint está fora do raio de query
    // sejam detectados corretamente.
    function buildEnemyTrailGrid(state, myId) {
        grid.clear();

        for (const [id, player] of Object.entries(state)) {
            if (id === myId) continue;
            const trail = player.trail;
            if (!trail || trail.length < GRACE_SEGS + 2) continue;

            for (let i = GRACE_SEGS; i < trail.length - 1; i++) {
                const p1 = trail[i];
                const p2 = trail[i + 1];
                // Cada segRef compartilhado entre os dois inserts (sem alocação extra)
                const segRef = { ownerId: id, p1, p2 };
                grid.insert(p1.x, p1.y, segRef);
                grid.insert(p2.x, p2.y, segRef);
            }
        }
    }

    // ─── checkIfOnEnemyTrail ──────────────────────────────────
    //
    // Verifica se (myX, myY) está sobre algum rastro inimigo.
    // Retorna o ownerId do inimigo cuja trilha foi cruzada, ou null.
    //
    // Algoritmo:
    //   1. Consulta grade no raio (colRadius + margem)
    //   2. Para cada segmento candidato, calcula distância² exata
    //   3. Retorna o primeiro ownerId com dist² < colRadiusSq
    function checkIfOnEnemyTrail(myX, myY) {
        const nearby = grid.query(myX, myY, queryRadius);

        for (const { ownerId, p1, p2 } of nearby) {
            if (_distToSegmentSq(myX, myY, p1, p2) < colRadiusSq) {
                return ownerId;
            }
        }

        return null;
    }
}

// ─── Distância² Ponto–Segmento ────────────────────────────────
//
// Retorna d² entre (px,py) e o segmento a→b.
// Sem Math.sqrt() — comparamos d² com r² diretamente.
function _distToSegmentSq(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq < 1e-10) {
        const ex = px - a.x, ey = py - a.y;
        return ex * ex + ey * ey;
    }

    const t  = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    return (px - cx) ** 2 + (py - cy) ** 2;
}
