// ============================================================
// Sistema dos Números – numberSystem.js
// ============================================================

// ── Pesos de spawn (quanto maior o valor, mais frequente) ──
const SPAWN_WEIGHTS = {
    natural:  1,
    inteiro:  2,
    fracao:   2,
    raiz:     1.5,
    irracional: 1
};

// ── Tempo de respawn após colisão (ms) ──
const RESPAWN_DELAY_MS = 4000;

// ── Tempo que o Conjunto Tema fica visível antes de trocar (ms) ──
const TEMA_INTERVAL_MS = 15000;

// ── Quantidade máxima de números no mapa ──
const MAX_NUMBERS = 30;

// ── Distância mínima entre números ──
const MIN_DISTANCE_BETWEEN = 280;

// ── Distância mínima da borda do mapa ──
const MAP_RADIUS = 3000;
const MARGIN = 200;

// ── Conjuntos Tema disponíveis (inclui variantes e extensíveis) ──
const CONJUNTOS_TEMA = [
    { id: "naturais",       label: "Naturais (ℕ)",         icon: "ℕ" },
    { id: "inteiros",       label: "Inteiros (ℤ)",         icon: "ℤ" },
    { id: "negativos",      label: "Negativos (< 0)",      icon: "< 0" },
    { id: "positivos",      label: "Positivos (> 0)",      icon: "> 0" },
    { id: "pares",          label: "Pares",                icon: "2k" },
    { id: "impares",        label: "Ímpares",              icon: "2k+1" },
    { id: "racionais",      label: "Racionais (ℚ)",        icon: "ℚ" },
    { id: "irracionais",    label: "Irracionais",          icon: "π…" },
    // Reservado para modos futuros:
    // { id: "primos",      label: "Primos",               icon: "P" },
];

// ── Cores aleatórias para números ──
const NUMBER_COLORS = [
    "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF",
    "#F7A072", "#C77DFF", "#00C9A7", "#FFC6FF",
    "#FB8500", "#219EBC", "#8ECAE6", "#A8DADC"
];

let _nextId = 1;
function makeId() { return `num_${_nextId++}`; }

// ── Geração do valor numérico por conjunto ──
function gerarNumeroNatural() {
    const v = Math.floor(Math.random() * 99) + 0; // 0..99
    return {
        valor: v,
        display: String(v),
        conjuntos: classifyNatural(v)
    };
}

function gerarNumeroInteiroNegativo() {
    const v = -(Math.floor(Math.random() * 99) + 1); // -1..-99
    return {
        valor: v,
        display: String(v),
        conjuntos: ["inteiros", "negativos", (v % 2 === 0 ? "pares" : "impares"), "racionais"]
    };
}

function gerarFracao() {
    const numerador = Math.floor(Math.random() * 9) + 1;
    const denominador = Math.floor(Math.random() * 9) + 2;
    const valor = numerador / denominador;
    return {
        valor,
        display: `${numerador}/${denominador}`,
        conjuntos: ["racionais", "positivos"]
    };
}

function gerarRaiz() {
    // Raízes de números não perfeitos → irracionais; de perfeitos → naturais
    const radicandos = [2, 3, 5, 6, 7, 8, 10, 11, 12, 15, 17, 18, 20,
                        4, 9, 16, 25, 36, 49, 64, 81];
    const n = radicandos[Math.floor(Math.random() * radicandos.length)];
    const valor = Math.sqrt(n);
    const ehPerfeito = Number.isInteger(valor);
    return {
        valor,
        display: `√${n}`,
        conjuntos: ehPerfeito
            ? classifyNatural(Math.round(valor))
            : ["irracionais", "positivos", "racionais_nao"] // racionais_nao = não racional
    };
}

function gerarIrracional() {
    // Constantes irracionais conhecidas
    const opcoes = [
        { valor: Math.PI,        display: "π",      },
        { valor: Math.E,         display: "e",      },
        { valor: Math.SQRT2,     display: "√2",     },
        { valor: Math.LOG2E,     display: "log₂e",  },
        { valor: 1.618033988,    display: "φ",      }, // razão áurea
    ];
    const op = opcoes[Math.floor(Math.random() * opcoes.length)];
    return {
        valor: op.valor,
        display: op.display,
        conjuntos: ["irracionais", "positivos"]
    };
}

function classifyNatural(v) {
    const sets = ["naturais", "inteiros", "racionais", "positivos"];
    if (v === 0) sets.push("zero");
    if (v > 0)  sets.push(v % 2 === 0 ? "pares" : "impares");
    return sets;
}

// ── Seleção ponderada do tipo ──
function escolherTipo() {
    const entries = Object.entries(SPAWN_WEIGHTS);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [tipo, peso] of entries) {
        r -= peso;
        if (r <= 0) return tipo;
    }
    return "natural";
}

function gerarNumero() {
    const tipo = escolherTipo();
    let dados;
    switch (tipo) {
        case "natural":    dados = gerarNumeroNatural();       break;
        case "inteiro":    dados = gerarNumeroInteiroNegativo(); break;
        case "fracao":     dados = gerarFracao();              break;
        case "raiz":       dados = gerarRaiz();                break;
        case "irracional": dados = gerarIrracional();          break;
        default:           dados = gerarNumeroNatural();
    }
    return { ...dados, tipo };
}

// ── Posicionamento com distância mínima ──
function posicaoAleatoria(existentes) {
    const maxR = MAP_RADIUS - MARGIN;
    for (let tentativa = 0; tentativa < 200; tentativa++) {
        const angle = Math.random() * Math.PI * 2;
        const dist  = Math.sqrt(Math.random()) * maxR;
        const x = Math.cos(angle) * dist;
        const y = Math.sin(angle) * dist;
        let longeOSuficiente = true;
        for (const n of existentes.values()) {
            const dx = n.x - x;
            const dy = n.y - y;
            if (Math.sqrt(dx * dx + dy * dy) < MIN_DISTANCE_BETWEEN) {
                longeOSuficiente = false;
                break;
            }
        }
        if (longeOSuficiente) return { x, y };
    }
    // Fallback: posição aleatória sem garantia
    const angle = Math.random() * Math.PI * 2;
    const dist  = Math.random() * maxR;
    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
}

// ── Cor aleatória ──
function corAleatoria() {
    return NUMBER_COLORS[Math.floor(Math.random() * NUMBER_COLORS.length)];
}

// ── Validação: número pertence ao conjunto tema? ──
function pertenceAoTema(numeroConjuntos, temaId) {
    switch (temaId) {
        case "naturais":    return numeroConjuntos.includes("naturais");
        case "inteiros":    return numeroConjuntos.includes("inteiros");
        case "negativos":   return numeroConjuntos.includes("negativos");
        case "positivos":   return numeroConjuntos.includes("positivos");
        case "pares":       return numeroConjuntos.includes("pares");
        case "impares":     return numeroConjuntos.includes("impares");
        case "racionais":   return numeroConjuntos.includes("racionais") && !numeroConjuntos.includes("racionais_nao");
        case "irracionais": return numeroConjuntos.includes("irracionais");
        // futuro: case "primos": return numeroConjuntos.includes("primos");
        default:            return false;
    }
}

// ────────────────────────────────────────────────────────────
// Estado global do sistema
// ────────────────────────────────────────────────────────────
let numeros = new Map();   // id → número no mapa
let temaAtual = CONJUNTOS_TEMA[0];
let temaIndex = 0;
let ultimaTrocaTema = Date.now();
let pendingRespawns = []; // { ao: timestamp }

function iniciarSistema() {
    // Preencher mapa inicial
    for (let i = 0; i < MAX_NUMBERS; i++) {
        spawnNumero();
    }
}

function spawnNumero() {
    if (numeros.size >= MAX_NUMBERS) return;
    const id = makeId();
    const pos = posicaoAleatoria(numeros);
    const dados = gerarNumero();
    numeros.set(id, {
        id,
        x: pos.x,
        y: pos.y,
        cor: corAleatoria(),
        ...dados
    });
}

function update() {
    const agora = Date.now();

    // Trocar tema periodicamente
    if (agora - ultimaTrocaTema >= TEMA_INTERVAL_MS) {
        temaIndex = (temaIndex + 1) % CONJUNTOS_TEMA.length;
        temaAtual = CONJUNTOS_TEMA[temaIndex];
        ultimaTrocaTema = agora;
    }

    // Processar respawns pendentes
    const ainda = [];
    for (const p of pendingRespawns) {
        if (agora >= p.ao) {
            spawnNumero();
        } else {
            ainda.push(p);
        }
    }
    pendingRespawns = ainda;

    // Manter população máxima
    while (numeros.size < MAX_NUMBERS && pendingRespawns.length === 0) {
        spawnNumero();
    }
}

/**
 * Chamado quando o trail de um jogador fecha sobre números.
 * Recebe array de ids de números capturados.
 * Retorna array de resultados { id, display, conjuntos, pertenceAoTema, valor }.
 */
function processarCaptura(idsCapturados) {
    const resultados = [];
    for (const id of idsCapturados) {
        const num = numeros.get(id);
        if (!num) continue;
        numeros.delete(id);
        pendingRespawns.push({ ao: Date.now() + RESPAWN_DELAY_MS });
        resultados.push({
            id,
            display: num.display,
            valor: num.valor,
            conjuntos: num.conjuntos,
            tipo: num.tipo,
            pertenceAoTema: pertenceAoTema(num.conjuntos, temaAtual.id)
        });
    }
    return resultados;
}

function serialize() {
    return {
        numeros: Array.from(numeros.values()).map(n => ({
            id: n.id,
            x: n.x,
            y: n.y,
            display: n.display,
            cor: n.cor,
            tipo: n.tipo,
            conjuntos: n.conjuntos,
            valor: n.valor
        })),
        tema: {
            id: temaAtual.id,
            label: temaAtual.label,
            icon: temaAtual.icon,
            trocaEm: ultimaTrocaTema + TEMA_INTERVAL_MS
        }
    };
}

module.exports = {
    iniciarSistema,
    update,
    processarCaptura,
    serialize,
    getNumeros: () => numeros,
    getTema: () => temaAtual,
    pertenceAoTema,
    SPAWN_WEIGHTS,
    TEMA_INTERVAL_MS
};
