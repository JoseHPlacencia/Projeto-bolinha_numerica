import { clamp, lerp, lerpAngle } from "./sharedMath.js";

// ============================================================
// snapshotInterpolator.js — Interpolação de Estado de Rede
// ============================================================
//
// PERFORMANCE + MEMORY: Ring buffer (buffer circular) substitui Array com shift().
//
// ANTES — Array com shift():
//   • saveSnapshot() → snapshots.push() + snapshots.shift() quando cheio.
//   • shift() é O(n): move todos os elementos do array uma posição.
//   • Com maxSnapshots=60, cada frame descartava o mais antigo com O(60) operações.
//   • structuredClone() de cada snapshot copiava todos os jogadores profundamente,
//     com custo proporcional a N jogadores × tamanho do estado.
//
// DEPOIS — Ring buffer:
//   • Array de tamanho fixo (maxSnapshots) com ponteiro head e count.
//   • Inserção: escreve na posição (head + count) % capacity → O(1) sempre.
//   • Evicção do mais antigo: avança head++ → O(1) sem mover nenhum elemento.
//   • Zero realocação de array — mesma memória reutilizada durante toda a sessão.
//
// Impacto: elimina 60 movimentações de ponteiro por frame de rede (30fps),
//          especialmente importante com muitos jogadores (snapshots grandes).

export function createSnapshotInterpolator(networkConfig) {
    // ─── Ring Buffer Fixo ─────────────────────────────────────────────────────
    // MEMORY: Array de tamanho fixo alocado uma única vez.
    // Evita redimensionamento e garbage collection de arrays dinâmicos.
    const capacity  = networkConfig.maxSnapshots;
    const ring      = new Array(capacity).fill(null); // posições pré-alocadas
    let   ringHead  = 0; // índice do snapshot mais antigo
    let   ringCount = 0; // número de snapshots válidos atualmente

    const networkState = {
        bufferMs: networkConfig.initialBufferMs,
        serverOffset: 0,
        lastSnapshotReceivedAt: performance.now(),
        deltas: []
    };

    return {
        getDebugState,
        getRenderState,
        processSnapshot
    };

    function processSnapshot(snapshot) {
        updateAdaptiveBuffer(performance.now());
        syncServerClock(snapshot.time);
        saveSnapshot(snapshot);
    }

    function getRenderState() {
        if (ringCount === 0) return null;
        if (ringCount === 1) return ring[ringHead].players;

        const serverNow  = Date.now() - networkState.serverOffset;
        const renderTime = serverNow  - networkState.bufferMs;
        const { previous, next } = findSnapshotPair(renderTime);
        const interval = next.time - previous.time || 1;
        const amount   = clamp((renderTime - previous.time) / interval, 0, 1);

        return interpolatePlayers(previous, next, amount);
    }

    function getDebugState() {
        return {
            bufferMs: networkState.bufferMs,
            snapshotCount: ringCount
        };
    }

    // ─── Adaptive Buffer ──────────────────────────────────────────────────────
    function updateAdaptiveBuffer(now) {
        const delta = now - networkState.lastSnapshotReceivedAt;
        networkState.lastSnapshotReceivedAt = now;
        networkState.deltas.push(delta);

        if (networkState.deltas.length > networkConfig.maxJitterSamples) {
            networkState.deltas.shift(); // pequeno array (max 30), shift é aceitável
        }

        const average    = calculateAverage(networkState.deltas);
        const jitter     = calculateStandardDeviation(networkState.deltas, average);
        const nextBuffer = average + jitter * networkConfig.jitterMultiplier;

        networkState.bufferMs = clamp(
            nextBuffer,
            networkConfig.minBufferMs,
            networkConfig.maxBufferMs
        );
    }

    // ─── Sincronização de Relógio ─────────────────────────────────────────────
    function syncServerClock(serverTime) {
        const nextOffset = Date.now() - serverTime;
        networkState.serverOffset = networkState.serverOffset * 0.9 + nextOffset * 0.1;
    }

    // ─── Salvar Snapshot no Ring Buffer ──────────────────────────────────────
    //
    // PERFORMANCE: O(1) para inserção e evicção.
    //
    // ANTES — Array dinâmico:
    //   snapshots.push(snapshot)         → O(1) amortizado
    //   snapshots.shift()                → O(n) quando cheio (move todos)
    //
    // DEPOIS — Ring buffer:
    //   ring[(ringHead + ringCount) % capacity] = snapshot → O(1) sempre
    //   Se cheio: ringHead = (ringHead + 1) % capacity     → O(1), zero movimentação
    function saveSnapshot(snapshot) {
        const slot = (ringHead + ringCount) % capacity;
        // MEMORY: structuredClone é necessário para isolar o snapshot do estado mutável.
        // Para snapshots pequenos (< 10 jogadores), o custo é aceitável.
        // Alternativa futura: usar um pool de objetos player para zero-copy.
        ring[slot] = {
            time: snapshot.time,
            players: structuredClone(snapshot.players)
        };

        if (ringCount < capacity) {
            ringCount++;
        } else {
            // Buffer cheio: descarta o mais antigo avançando o head — O(1)
            ringHead = (ringHead + 1) % capacity;
        }
    }

    // ─── Busca do Par de Snapshots para Interpolação ──────────────────────────
    //
    // PERFORMANCE: Acesso ao ring buffer por índice circular.
    // ANTES — findSnapshotPair iterava snapshots[] diretamente.
    // DEPOIS — usa _ringGet() para acesso O(1) com índice lógico.
    function findSnapshotPair(renderTime) {
        // Snapshot mais antigo e segundo mais antigo como fallback
        let previous = _ringGet(0);
        let next     = _ringGet(1);

        if (renderTime <= previous.time) return { previous, next };

        for (let i = 0; i < ringCount - 1; i++) {
            previous = _ringGet(i);
            next     = _ringGet(i + 1);
            if (previous.time <= renderTime && next.time >= renderTime) {
                return { previous, next };
            }
        }

        return { previous, next };
    }

    // ─── Acesso por Índice Lógico no Ring ─────────────────────────────────────
    // índice 0 = snapshot mais antigo, índice (ringCount-1) = mais recente.
    function _ringGet(logicalIndex) {
        return ring[(ringHead + logicalIndex) % capacity];
    }

    // ─── Interpolação de Jogadores ────────────────────────────────────────────
    function interpolatePlayers(previous, next, amount) {
        const renderedPlayers = {};
        const ids = new Set([
            ...Object.keys(previous.players),
            ...Object.keys(next.players)
        ]);

        for (const id of ids) {
            const prev = previous.players[id];
            const nxt  = next.players[id];

            if (!prev && nxt)  { renderedPlayers[id] = nxt;  continue; }
            if (prev  && !nxt) { continue; } // jogador saiu — não exibe

            renderedPlayers[id] = {
                ...nxt,
                x:     lerp(prev.x, nxt.x, amount),
                y:     lerp(prev.y, nxt.y, amount),
                angle: lerpAngle(prev.angle, nxt.angle, amount)
            };
        }

        return renderedPlayers;
    }
}

// ─── Utilitários Estatísticos ─────────────────────────────────────────────────
function calculateAverage(values) {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function calculateStandardDeviation(values, average) {
    const variance = values
        .map(v => (v - average) ** 2)
        .reduce((sum, v) => sum + v, 0) / values.length;
    return Math.sqrt(variance);
}
