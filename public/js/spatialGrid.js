// ============================================================
// spatialGrid.js — Grade Espacial para Colisão O(1)
// ============================================================
//
// COLLISION + PERFORMANCE + MULTIPLAYER READY:
//
// Problema clássico: detectar colisão entre N jogadores e M pontos de rastro
// exige O(N×M) comparações por frame — com 10 jogadores e 200 pontos de rastro
// cada, isso são 20.000 comparações/frame só para colisão de rastro.
//
// Solução: Spatial Hash Grid divide o espaço em células de tamanho fixo.
// Cada entidade (jogador, ponto de rastro) é inserida na(s) célula(s) que ocupa.
// Para checar colisão, buscamos apenas as células vizinhas — tipicamente 9 células
// vs M células totais. Complexidade: O(1) amortizado para lookup e inserção.
//
// MULTIPLAYER READY: A grid é recriada a cada frame (servidor ou cliente)
// e estruturada para funcionar como estado sem side-effects, facilitando
// a migração para arquitetura servidor-autoritativo futura.
//
// Uso:
//   const grid = createSpatialGrid(mapRadius * 2, mapRadius * 2, cellSize);
//   grid.insert(x, y, payload);           // insere entidade
//   const nearby = grid.query(x, y, r);   // busca vizinhos no raio r
//   grid.clear();                          // limpa para o próximo frame

export function createSpatialGrid(worldWidth, worldHeight, cellSize) {
    // Número de colunas/linhas da grade espacial
    const cols = Math.ceil(worldWidth  / cellSize);
    const rows = Math.ceil(worldHeight / cellSize);

    // MEMORY: Array plano de arrays (sparse). Cada entrada é uma lista de entidades
    // naquela célula da grade. Usamos null como marcador de célula vazia para
    // evitar iteração em células sem entidades.
    const cells = new Array(cols * rows).fill(null);

    // Offset para converter coordenadas de mundo (centro = 0,0) para índice de grade.
    const offsetX = worldWidth  / 2;
    const offsetY = worldHeight / 2;

    return { insert, query, clear, queryRect };

    // ─── Inserção ──────────────────────────────────────────────────────────────
    // Insere payload na célula correspondente à posição (x, y) no mundo.
    // O(1) amortizado.
    function insert(x, y, payload) {
        const idx = _cellIndex(x, y);
        if (idx < 0) return; // fora dos limites do mundo — ignora
        if (!cells[idx]) cells[idx] = [];
        cells[idx].push(payload);
    }

    // ─── Query Circular ────────────────────────────────────────────────────────
    // Retorna todas as entidades dentro do raio r da posição (x, y).
    // Busca apenas as células da bounding box do círculo, não o mundo todo.
    // O(k) onde k = número de entidades nas células vizinhas (tipicamente << N).
    function query(x, y, r) {
        const result = [];
        const minCol = Math.max(0, Math.floor((x - r + offsetX) / cellSize));
        const maxCol = Math.min(cols - 1, Math.floor((x + r + offsetX) / cellSize));
        const minRow = Math.max(0, Math.floor((y - r + offsetY) / cellSize));
        const maxRow = Math.min(rows - 1, Math.floor((y + r + offsetY) / cellSize));
        const r2     = r * r;

        for (let row = minRow; row <= maxRow; row++) {
            for (let col = minCol; col <= maxCol; col++) {
                const cell = cells[row * cols + col];
                if (!cell) continue;
                for (const item of cell) {
                    const dx = item.x - x;
                    const dy = item.y - y;
                    if (dx * dx + dy * dy <= r2) result.push(item);
                }
            }
        }

        return result;
    }

    // ─── Query Retangular ──────────────────────────────────────────────────────
    // Retorna entidades dentro do retângulo [x-hw, x+hw] × [y-hh, y+hh].
    // Mais eficiente que query circular quando a forma alvo é retangular (ex: AABB).
    function queryRect(x, y, hw, hh) {
        const result = [];
        const minCol = Math.max(0, Math.floor((x - hw + offsetX) / cellSize));
        const maxCol = Math.min(cols - 1, Math.floor((x + hw + offsetX) / cellSize));
        const minRow = Math.max(0, Math.floor((y - hh + offsetY) / cellSize));
        const maxRow = Math.min(rows - 1, Math.floor((y + hh + offsetY) / cellSize));

        for (let row = minRow; row <= maxRow; row++) {
            for (let col = minCol; col <= maxCol; col++) {
                const cell = cells[row * cols + col];
                if (!cell) continue;
                for (const item of cell) result.push(item);
            }
        }

        return result;
    }

    // ─── Limpeza ───────────────────────────────────────────────────────────────
    // MEMORY: Limpa apenas as células usadas (não itera o array inteiro).
    // Mantém os arrays internos para reutilização (evita GC de arrays por frame).
    function clear() {
        for (let i = 0; i < cells.length; i++) {
            if (cells[i]) cells[i].length = 0; // .length=0 reutiliza o array
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────
    function _cellIndex(x, y) {
        const col = Math.floor((x + offsetX) / cellSize);
        const row = Math.floor((y + offsetY) / cellSize);
        if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;
        return row * cols + col;
    }
}
