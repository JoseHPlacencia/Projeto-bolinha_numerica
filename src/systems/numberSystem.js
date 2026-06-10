"use strict";

const { isPointOwnedByPlayer } = require("../state/territories");

// ─── Config base ──────────────────────────────────────────────────────────────

const NUMBER_CONFIG = Object.freeze({
    radius: 40,
    minDistanceBetween: 180,
    minDistanceFromPlayer: 220,
    maxNumbers: 25,
    respawnDelaySec: 4,
    maxSpawnAttempts: 80
});

// ─── Tabela de primos (para geração rápida) ───────────────────────────────────

const PRIMES_UNDER_100 = Object.freeze([
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43,
    47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97
]);

const IRRATIONAL_CONSTANTS = Object.freeze([
    { display: "π",   value: Math.PI },
    { display: "e",   value: Math.E },
    { display: "φ",   value: (1 + Math.sqrt(5)) / 2 }
]);

// ─── Geradores de números ─────────────────────────────────────────────────────

function makeNatural() {
    const v = Math.floor(Math.random() * 100);
    return buildNumber(String(v), v, ["natural", "inteiro", "racional"]);
}

function makeNegative() {
    const v = -(Math.floor(Math.random() * 99) + 1);
    return buildNumber(String(v), v, ["negativo", "inteiro", "racional"]);
}

function makeFraction() {
    const dens = [2, 3, 4, 5, 6, 8, 10];
    const den  = dens[Math.floor(Math.random() * dens.length)];
    let   num  = Math.floor(Math.random() * (den * 2 - 1)) + 1;
    if (num === den) num = den - 1 || 1;
    const neg     = Math.random() < 0.3;
    const value   = (neg ? -num : num) / den;
    const display = `${neg ? "-" : ""}${num}/${den}`;
    const sets    = ["fracao", "racional"];
    if (neg) sets.push("negativo");
    return buildNumber(display, value, sets);
}

function makeRootIrrational() {
    const NON_PERFECT = [
        2,3,5,6,7,8,10,11,12,13,14,15,17,18,19,20,21,22,23,24,26,
        27,28,29,30,31,32,33,34,35,37,38,39,40,41,42,43,44,45,46,47,48,50,
        51,52,53,54,55,56,57,58,59,60,61,62,63,65,66,67,68,69,70,71,72,73,
        74,75,76,77,78,79,80,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99
    ];
    const n = NON_PERFECT[Math.floor(Math.random() * NON_PERFECT.length)];
    return buildNumber(`√${n}`, Math.sqrt(n), ["raiz", "irracional"]);
}

function makeRootPerfect() {
    const PERFECT = [1, 4, 9, 16, 25, 36, 49, 64, 81];
    const n = PERFECT[Math.floor(Math.random() * PERFECT.length)];
    return buildNumber(`√${n}`, Math.sqrt(n), ["raiz", "natural", "inteiro", "racional"]);
}

function makeIrrationalConst() {
    const item = IRRATIONAL_CONSTANTS[Math.floor(Math.random() * IRRATIONAL_CONSTANTS.length)];
    return buildNumber(item.display, item.value, ["irracional"]);
}

function makePrime() {
    const v = PRIMES_UNDER_100[Math.floor(Math.random() * PRIMES_UNDER_100.length)];
    return buildNumber(String(v), v, ["natural", "primo", "inteiro", "racional", "impar"]);
    // obs: 2 é primo e par; corrigido em buildNumber
}

function makeMultipleOf3() {
    const v = (Math.floor(Math.random() * 33) + 1) * 3; // 3..99
    return buildNumber(String(v), v, ["natural", "mult3", "inteiro", "racional"]);
}

function makeMultipleOf5() {
    const v = (Math.floor(Math.random() * 19) + 1) * 5; // 5..95
    return buildNumber(String(v), v, ["natural", "mult5", "inteiro", "racional"]);
}

function makeMultipleOf10() {
    const v = (Math.floor(Math.random() * 9) + 1) * 10; // 10..90
    return buildNumber(String(v), v, ["natural", "mult10", "mult5", "inteiro", "racional"]);
}

function buildNumber(display, value, rawSets) {
    const sets = new Set(rawSets.filter(Boolean));

    // Inferências automáticas
    if (value > 0)  sets.add("maior_zero");
    if (value < 0)  sets.add("menor_zero");
    if (value === 0) sets.add("zero");

    if (sets.has("inteiro") && Number.isInteger(value)) {
        if (value % 2 === 0) sets.add("par");  else sets.add("impar");
        const abs = Math.abs(value);
        // Primos pertencem aos naturais maiores que 1; negativos não entram.
        if (PRIMES_UNDER_100.includes(value)) sets.add("primo");
        // 2 é primo E par
        if (value === 2) { sets.add("par"); sets.delete("impar"); }
        // múltiplos
        if (abs % 3  === 0) sets.add("mult3");
        if (abs % 5  === 0) sets.add("mult5");
        if (abs % 10 === 0) sets.add("mult10");
    }

    return { display, value, sets };
}

// ─── Perfis de dificuldade ────────────────────────────────────────────────────
//
// Cada perfil define:
//   themeIntervalSec  – tempo (s) entre trocas de tema
//   generators        – array de { fn, weight } (peso relativo de spawn)
//   themes            – array de temas disponíveis neste modo
//
// Temas com operator:"union"       → exibem "A ∪ B" e checam (setA || setB)
// Temas com operator:"intersection"→ exibem "A ∩ B" e checam (setA && setB)

function makeTheme(id, label, emoji, description, check, operator, operands) {
    return Object.freeze({ id, label, emoji, description, check,
        operator: operator || null, operands: operands || null });
}

// ── Temas simples reutilizados ─────────────────────────────────────────────────

const T_NATURAL    = makeTheme("natural",  "Naturais",   "🌿", "Colete números Naturais (≥ 0)",             n => n.sets.has("natural"));
const T_PAR        = makeTheme("par",      "Pares",      "2️⃣", "Colete Inteiros Pares",                      n => n.sets.has("par"));
const T_IMPAR      = makeTheme("impar",    "Ímpares",    "1️⃣", "Colete Inteiros Ímpares",                    n => n.sets.has("impar"));
const T_PRIMO      = makeTheme("primo",    "Primos",     "✨", "Colete números Primos naturais",             n => n.sets.has("primo"));
const T_MULT3      = makeTheme("mult3",    "Múlt. de 3", "🔵", "Colete múltiplos de 3",                     n => n.sets.has("mult3"));
const T_MULT5      = makeTheme("mult5",    "Múlt. de 5", "🟠", "Colete múltiplos de 5",                     n => n.sets.has("mult5"));
const T_MAIOR_ZERO = makeTheme("maior_zero","Positivos", "➕", "Colete números maiores que zero",            n => n.value > 0);

const T_INTEIRO    = makeTheme("inteiro",  "Inteiros",   "🔢", "Colete qualquer número Inteiro",            n => n.sets.has("inteiro"));
const T_NEGATIVO   = makeTheme("negativo", "Negativos",  "➖", "Colete números menores que zero",           n => n.sets.has("negativo"));
const T_FRACAO     = makeTheme("fracao",   "Frações",    "⅓", "Colete Racionais não-inteiros",              n => n.sets.has("fracao"));
const T_RACIONAL   = makeTheme("racional", "Racionais",  "ℚ",  "Colete números Racionais (inteiros e frac.)",n => n.sets.has("racional"));
const T_RAIZ_PERF  = makeTheme("raiz_perf","Raízes exatas","√", "Colete raízes de quadrados perfeitos (naturais!)", n => n.sets.has("raiz") && n.sets.has("natural"));

const T_IRRACIONAL = makeTheme("irracional","Irracionais","∞", "Colete números Irracionais",               n => n.sets.has("irracional"));
const T_RAIZ_IRR   = makeTheme("raiz_irr", "√ Irracionais","√","Colete raízes irracionais",                n => n.sets.has("raiz") && n.sets.has("irracional"));
const T_MENOR_ZERO = makeTheme("menor_zero","Negativos estritos","📉","Colete números estritamente negativos",n => n.value < 0);

// ── Temas de UNIÃO (∪) — fácil e médio ────────────────────────────────────────

const T_U_PAR_PRIMO = makeTheme(
    "u_par_primo", "Pares ∪ Primos", "🔗",
    "Colete Pares OU Primos",
    n => n.sets.has("par") || n.sets.has("primo"),
    "union", ["par", "primo"]
);

const T_U_MULT3_MULT5 = makeTheme(
    "u_mult3_mult5", "Mult.3 ∪ Mult.5", "🔗",
    "Colete múltiplos de 3 OU de 5",
    n => n.sets.has("mult3") || n.sets.has("mult5"),
    "union", ["mult3", "mult5"]
);

const T_U_PAR_MULT3 = makeTheme(
    "u_par_mult3", "Pares ∪ Mult.3", "🔗",
    "Colete Pares OU múltiplos de 3",
    n => n.sets.has("par") || n.sets.has("mult3"),
    "union", ["par", "mult3"]
);

const T_U_IMPAR_MULT5 = makeTheme(
    "u_impar_mult5", "Ímpares ∪ Mult.5", "🔗",
    "Colete Ímpares OU múltiplos de 5",
    n => n.sets.has("impar") || n.sets.has("mult5"),
    "union", ["impar", "mult5"]
);

const T_U_PRIMO_MULT3 = makeTheme(
    "u_primo_mult3", "Primos ∪ Mult.3", "🔗",
    "Colete Primos naturais OU múltiplos de 3",
    n => n.sets.has("primo") || n.sets.has("mult3"),
    "union", ["primo", "mult3"]
);

const T_U_NATURAL_PRIMO = makeTheme(
    "u_natural_primo", "Naturais ∪ Primos", "🔗",
    "Colete Naturais OU Primos",
    n => n.sets.has("natural") || n.sets.has("primo"),
    "union", ["natural", "primo"]
);

const T_U_INTEIRO_FRACAO = makeTheme(
    "u_inteiro_fracao", "Inteiros ∪ Frações", "🔗",
    "Colete Inteiros OU Frações",
    n => n.sets.has("inteiro") || n.sets.has("fracao"),
    "union", ["inteiro", "fracao"]
);

const T_U_NEGATIVO_PRIMO = makeTheme(
    "u_negativo_primo", "Negativos ∪ Primos", "🔗",
    "Colete Negativos OU Primos naturais",
    n => n.sets.has("negativo") || n.sets.has("primo"),
    "union", ["negativo", "primo"]
);

const T_U_FRACAO_PAR = makeTheme(
    "u_fracao_par", "Frações ∪ Pares", "🔗",
    "Colete Frações OU Inteiros Pares",
    n => n.sets.has("fracao") || n.sets.has("par"),
    "union", ["fracao", "par"]
);

const T_U_NEGATIVO_MULT5 = makeTheme(
    "u_negativo_mult5", "Negativos ∪ Mult.5", "🔗",
    "Colete Negativos OU múltiplos de 5",
    n => n.sets.has("negativo") || n.sets.has("mult5"),
    "union", ["negativo", "mult5"]
);

const T_U_NATURAL_FRACAO = makeTheme(
    "u_natural_fracao", "Naturais ∪ Frações", "🔗",
    "Colete Naturais OU Frações",
    n => n.sets.has("natural") || n.sets.has("fracao"),
    "union", ["natural", "fracao"]
);

const T_U_PAR_MULT5 = makeTheme(
    "u_par_mult5", "Pares ∪ Mult.5", "🔗",
    "Colete Pares OU múltiplos de 5",
    n => n.sets.has("par") || n.sets.has("mult5"),
    "union", ["par", "mult5"]
);

const T_U_RACIONAL_NEGATIVO = makeTheme(
    "u_racional_neg", "Racionais ∪ Negativos", "🔗",
    "Colete Racionais OU Negativos",
    n => n.sets.has("racional") || n.sets.has("negativo"),
    "union", ["racional", "negativo"]
);

const T_U_FRACAO_NEGATIVO = makeTheme(
    "u_fracao_neg", "Frações ∪ Negativos", "🔗",
    "Colete Frações OU Negativos",
    n => n.sets.has("fracao") || n.sets.has("negativo"),
    "union", ["fracao", "negativo"]
);

const T_U_IRRACIONAL_FRACAO = makeTheme(
    "u_irracional_fracao", "Irracionais ∪ Frações", "🔗",
    "Colete Irracionais OU Frações",
    n => n.sets.has("irracional") || n.sets.has("fracao"),
    "union", ["irracional", "fracao"]
);

const T_U_NEGATIVO_RAIZ_IRR = makeTheme(
    "u_negativo_raiz_irr", "Negativos ∪ Raízes irr.", "🔗",
    "Colete Negativos OU raízes irracionais",
    n => n.sets.has("negativo") || (n.sets.has("raiz") && n.sets.has("irracional")),
    "union", ["negativo", "raiz_irr"]
);

// ── Temas de INTERSEÇÃO (∩) — difícil ─────────────────────────────────────────

const T_I_PAR_PRIMO = makeTheme(
    "i_par_primo", "Pares ∩ Primos", "⊗",
    "Colete números que são Pares E Primos (só o 2!)",
    n => n.sets.has("par") && n.sets.has("primo"),
    "intersection", ["par", "primo"]
);

const T_I_NATURAL_IMPAR = makeTheme(
    "i_nat_impar", "Naturais ∩ Ímpares", "⊗",
    "Colete Naturais que também são Ímpares",
    n => n.sets.has("natural") && n.sets.has("impar"),
    "intersection", ["natural", "impar"]
);

const T_I_INTEIRO_POSITIVO = makeTheme(
    "i_int_pos", "Inteiros positivos", "⊗",
    "Colete Inteiros maiores que zero",
    n => n.sets.has("inteiro") && n.value > 0,
    "intersection", ["inteiro", "maior_zero"]
);

const T_I_RACIONAL_PAR_IMPAR = makeTheme(
    "i_rac_par_impar", "Racionais ∩ (Pares ∪ Ímpares)", "⊗",
    "Colete Racionais que são Inteiros Pares OU Ímpares",
    n => n.sets.has("racional") && (n.sets.has("par") || n.sets.has("impar")),
    "intersection", ["racional", "par_ou_impar"]
);

const T_I_NATURAL_PAR_MULT5 = makeTheme(
    "i_nat_par_mult5", "Naturais ∩ (Pares ∪ Mult.5)", "⊗",
    "Colete Naturais que são Pares OU múltiplos de 5",
    n => n.sets.has("natural") && (n.sets.has("par") || n.sets.has("mult5")),
    "intersection", ["natural", "par_ou_mult5"]
);

const T_I_RACIONAL_NEGATIVO = makeTheme(
    "i_rac_neg", "Racionais ∩ Negativos", "⊗",
    "Colete números Racionais E Negativos",
    n => n.sets.has("racional") && n.sets.has("negativo"),
    "intersection", ["racional", "negativo"]
);

const T_I_INTEIRO_NEGATIVO = makeTheme(
    "i_int_neg", "Inteiros ∩ Negativos", "⊗",
    "Colete números que são Inteiros E Negativos",
    n => n.sets.has("inteiro") && n.sets.has("negativo"),
    "intersection", ["inteiro", "negativo"]
);

const T_I_MULT3_MULT5 = makeTheme(
    "i_mult3_mult5", "Mult.3 ∩ Mult.5", "⊗",
    "Colete múltiplos de 3 E de 5 (mult. de 15!)",
    n => n.sets.has("mult3") && n.sets.has("mult5"),
    "intersection", ["mult3", "mult5"]
);

const T_I_NATURAL_PRIMO = makeTheme(
    "i_nat_primo", "Naturais ∩ Primos", "⊗",
    "Colete Naturais que também são Primos",
    n => n.sets.has("natural") && n.sets.has("primo"),
    "intersection", ["natural", "primo"]
);

const T_I_IRRACIONAL_RAIZ = makeTheme(
    "i_irr_raiz", "Irracionais ∩ Raízes", "⊗",
    "Colete Irracionais que são raízes (√ de não-quadrados)",
    n => n.sets.has("irracional") && n.sets.has("raiz"),
    "intersection", ["irracional", "raiz"]
);

const T_I_FRACAO_POSITIVO = makeTheme(
    "i_frac_pos", "Frações ∩ Positivos", "⊗",
    "Colete Frações que são maiores que zero",
    n => n.sets.has("fracao") && n.value > 0,
    "intersection", ["fracao", "maior_zero"]
);

// Fix: hard.themes não pode ter propriedades nomeadas — só array
const HARD_THEMES = Object.freeze([
    T_NATURAL, T_INTEIRO, T_RACIONAL,
    T_IRRACIONAL, T_PAR, T_IMPAR,
    T_MAIOR_ZERO, T_I_NATURAL_IMPAR, T_I_IRRACIONAL_RAIZ,
    T_I_RACIONAL_PAR_IMPAR, T_I_NATURAL_PAR_MULT5,
    T_U_IRRACIONAL_FRACAO, T_U_NEGATIVO_RAIZ_IRR
]);

// Rebuild profiles cleanly to avoid keyed-array issues
const PROFILES = Object.freeze({
    easy: Object.freeze({
        themeIntervalSec: 28,
        generators: Object.freeze([
            { fn: makeNatural,      weight: 5 },
            { fn: makePrime,        weight: 2 },
            { fn: makeMultipleOf3,  weight: 2 },
            { fn: makeMultipleOf5,  weight: 2 },
            { fn: makeMultipleOf10, weight: 1 }
        ]),
        themes: Object.freeze([
            T_PAR, T_IMPAR, T_PRIMO, T_MULT3, T_MULT5,
            T_U_PAR_PRIMO, T_U_MULT3_MULT5, T_U_PAR_MULT5,
            T_U_PAR_MULT3, T_U_IMPAR_MULT5, T_U_PRIMO_MULT3
        ])
    }),
    medium: Object.freeze({
        themeIntervalSec: 20,
        generators: Object.freeze([
            { fn: makeNatural,      weight: 3 },
            { fn: makeNegative,     weight: 3 },
            { fn: makeFraction,     weight: 3 },
            { fn: makePrime,        weight: 1 },
            { fn: makeMultipleOf3,  weight: 1 },
            { fn: makeMultipleOf5,  weight: 1 }
        ]),
        themes: Object.freeze([
            T_NATURAL, T_INTEIRO, T_NEGATIVO, T_FRACAO,
            T_PAR, T_IMPAR, T_MAIOR_ZERO,
            T_U_NEGATIVO_PRIMO, T_U_PAR_MULT5, T_U_FRACAO_NEGATIVO,
            T_U_FRACAO_PAR, T_U_NEGATIVO_MULT5, T_U_NATURAL_FRACAO,
            T_I_INTEIRO_POSITIVO
        ])
    }),
    hard: Object.freeze({
        themeIntervalSec: 14,
        generators: Object.freeze([
            { fn: makeNatural,         weight: 2 },
            { fn: makeNegative,        weight: 2 },
            { fn: makeFraction,        weight: 2 },
            { fn: makeRootIrrational,  weight: 3 },
            { fn: makeIrrationalConst, weight: 2 },
            { fn: makePrime,           weight: 1 },
            { fn: makeMultipleOf3,     weight: 1 },
            { fn: makeMultipleOf5,     weight: 1 },
            { fn: makeRootPerfect,     weight: 1 }
        ]),
        themes: HARD_THEMES
    })
});

// ─── Tabela de pesos por perfil (calculada uma vez por instância) ─────────────

function buildWeightTable(generators) {
    let total = 0;
    const table = generators.map(({ fn, weight }) => {
        total += weight;
        return { fn, cumulative: total };
    });
    table._total = total;
    return table;
}

function pickGenerator(weightTable) {
    const roll = Math.random() * weightTable._total;
    for (const entry of weightTable) {
        if (roll < entry.cumulative) return entry.fn;
    }
    return weightTable[weightTable.length - 1].fn;
}

// ─── Sistema de números (instância por sala) ──────────────────────────────────

function createNumberSystem(mapRadius, players, territories, difficulty) {
    const profileKey  = (difficulty === "easy" || difficulty === "hard") ? difficulty : "medium";
    const profile     = PROFILES[profileKey];
    const weightTable = buildWeightTable(profile.generators);
    const state       = createNumberState();

    initNumbers(state, mapRadius, players, weightTable, profile);

    return {
        difficulty:     profileKey,
        getNumbersMap:  () => state.numbers,
        getTheme:       () => state.theme,
        serialize:      () => serializeNumbers(state),
        update:         nowMs => updateNumbers(state, players, territories, mapRadius, nowMs, weightTable, profile)
    };
}

function createNumberState() {
    return {
        nextId:          1,
        numbers:         new Map(),
        pending:         [],
        theme:           null,
        themeIdx:        0,
        themeNextSwitch: 0
    };
}

function initNumbers(state, mapRadius, players, weightTable, profile) {
    state.numbers.clear();
    state.pending = [];
    state.nextId  = 1;

    for (let i = 0; i < NUMBER_CONFIG.maxNumbers; i++) {
        spawnOneNumber(state, mapRadius, players, weightTable);
    }

    initTheme(state, profile);
}

function initTheme(state, profile) {
    state.themeIdx        = Math.floor(Math.random() * profile.themes.length);
    state.theme           = profile.themes[state.themeIdx];
    state.themeNextSwitch = Date.now() + profile.themeIntervalSec * 1000;
}

function spawnOneNumber(state, mapRadius, players, weightTable) {
    const pos = trySpawnPosition(state, mapRadius, players);
    if (!pos) return null;

    const numData = pickGenerator(weightTable)();
    const id      = state.nextId++;

    state.numbers.set(id, {
        id,
        x:       pos.x,
        y:       pos.y,
        display: numData.display,
        value:   numData.value,
        sets:    numData.sets,
        version: 1
    });

    return id;
}

function trySpawnPosition(state, mapRadius, players) {
    const limit = mapRadius * 0.88;
    for (let i = 0; i < NUMBER_CONFIG.maxSpawnAttempts; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist  = Math.sqrt(Math.random()) * limit;
        const x     = Math.cos(angle) * dist;
        const y     = Math.sin(angle) * dist;

        if (!isPosFarFromNumbers(state, x, y)) continue;
        if (!isPosFarFromPlayers(x, y, players)) continue;

        return { x, y };
    }
    return null;
}

function isPosFarFromNumbers(state, x, y) {
    const minD = NUMBER_CONFIG.minDistanceBetween;
    for (const num of state.numbers.values()) {
        const dx = num.x - x, dy = num.y - y;
        if (dx * dx + dy * dy < minD * minD) return false;
    }
    return true;
}

function isPosFarFromPlayers(x, y, players) {
    const minD = NUMBER_CONFIG.minDistanceFromPlayer;
    for (const p of players.values()) {
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy < minD * minD) return false;
    }
    return true;
}

function updateNumbers(state, players, territories, mapRadius, nowMs, weightTable, profile) {
    let themeChanged = false;

    // Troca de tema
    if (nowMs >= state.themeNextSwitch) {
        state.themeIdx        = (state.themeIdx + 1) % profile.themes.length;
        state.theme           = profile.themes[state.themeIdx];
        state.themeNextSwitch = nowMs + profile.themeIntervalSec * 1000;
        themeChanged          = true;
    }

    // Respawn pendente
    while (state.pending.length > 0 && state.pending[0].spawnAt <= nowMs) {
        state.pending.shift();
        if (state.numbers.size < NUMBER_CONFIG.maxNumbers) {
            spawnOneNumber(state, mapRadius, players, weightTable);
        }
    }

    // Completar mapa
    if (state.numbers.size < NUMBER_CONFIG.maxNumbers && state.pending.length === 0) {
        spawnOneNumber(state, mapRadius, players, weightTable);
    }

    // Colisões
    const collisions    = [];
    const playerRadius  = 35;
    const combinedR2    = (NUMBER_CONFIG.radius + playerRadius) ** 2;

    for (const [nid, num] of state.numbers) {
        for (const player of players.values()) {
            if (territories && isPointOwnedByPlayer(territories, player.id, num.x, num.y)) continue;

            const dx = player.x - num.x;
            const dy = player.y - num.y;
            if (dx * dx + dy * dy < combinedR2) {
                collisions.push({
                    numberId:       nid,
                    playerId:       player.id,
                    display:        num.display,
                    value:          num.value,
                    sets:           [...num.sets],
                    belongsToTheme: state.theme ? state.theme.check(num) : false
                });
                state.numbers.delete(nid);
                state.pending.push({ spawnAt: nowMs + NUMBER_CONFIG.respawnDelaySec * 1000 });
                break;
            }
        }
    }

    return { collisions, themeChanged };
}

function serializeNumbers(state) {
    const nums = [];
    for (const n of state.numbers.values()) {
        nums.push([
            n.id,
            Math.round(n.x),
            Math.round(n.y),
            n.display,
            parseFloat(n.value.toFixed(4))
        ]);
    }
    return {
        nums,
        theme: state.theme ? {
            id:          state.theme.id,
            label:       state.theme.label,
            emoji:       state.theme.emoji,
            description: state.theme.description,
            operator:    state.theme.operator  || null,
            operands:    state.theme.operands  || null
        } : null,
        themeEndsIn: Math.max(0, Math.round((state.themeNextSwitch - Date.now()) / 1000))
    };
}

module.exports = {
    NUMBER_CONFIG,
    PROFILES,
    createNumberSystem
};
