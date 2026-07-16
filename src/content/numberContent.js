"use strict";

/**
 * Pedagogical number catalog.
 *
 * This module contains only immutable themes, weighted generators and
 * difficulty profiles. Runtime spawning and collision state stay in
 * `systems/numberSystem.js`.
 */
const PRIMES_UNDER_100 = Object.freeze([
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43,
    47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97
]);
const PRIMES_UNDER_100_SET = new Set(PRIMES_UNDER_100);

const IRRATIONAL_CONSTANTS = Object.freeze([
    { display: "π", value: Math.PI },
    { display: "e", value: Math.E },
    { display: "φ", value: (1 + Math.sqrt(5)) / 2 }
]);

const FRACTION_DENOMINATORS = Object.freeze([2, 3, 4, 5, 6, 8, 10]);
const NEGATIVE_FRACTION_DENOMINATORS = Object.freeze([2, 3, 4, 5, 6, 8]);
const PERFECT_ROOTS = Object.freeze([1, 4, 9, 16, 25, 36, 49, 64, 81]);
const NON_PERFECT_ROOTS = Object.freeze([
    2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 26,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 50,
    51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 65, 66, 67, 68, 69, 70, 71, 72, 73,
    74, 75, 76, 77, 78, 79, 80, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99
]);

function makeNatural() {
    const value = Math.floor(Math.random() * 100);
    return buildNumber(String(value), value, ["natural", "inteiro", "racional"]);
}

function makeNegative() {
    const value = -(Math.floor(Math.random() * 99) + 1);
    return buildNumber(String(value), value, ["negativo", "inteiro", "racional"]);
}

function makeFraction() {
    const isNegative = Math.random() < 0.3;
    const denominators = isNegative
        ? NEGATIVE_FRACTION_DENOMINATORS
        : FRACTION_DENOMINATORS;
    const denominator = pickRandomItem(denominators);
    const displayNumeratorLimit = isNegative || denominator === 10 ? 9 : 99;
    const numeratorLimit = Math.min(denominator * 2 - 1, displayNumeratorLimit);
    let numerator = Math.floor(Math.random() * numeratorLimit) + 1;

    if (numerator === denominator) {
        numerator = denominator - 1 || 1;
    }

    const value = (isNegative ? -numerator : numerator) / denominator;
    const display = `${isNegative ? "-" : ""}${numerator}/${denominator}`;
    const sets = ["fracao", "racional"];

    if (isNegative) {
        sets.push("negativo");
    }

    return buildNumber(display, value, sets);
}

function makeRootIrrational() {
    const radicand = pickRandomItem(NON_PERFECT_ROOTS);
    return buildNumber(`√${radicand}`, Math.sqrt(radicand), ["raiz", "irracional"]);
}

function makeRootPerfect() {
    const radicand = pickRandomItem(PERFECT_ROOTS);
    return buildNumber(`√${radicand}`, Math.sqrt(radicand), ["raiz", "natural", "inteiro", "racional"]);
}

function makeIrrationalConst() {
    const item = pickRandomItem(IRRATIONAL_CONSTANTS);
    return buildNumber(item.display, item.value, ["irracional"]);
}

function makePrime() {
    const value = pickRandomItem(PRIMES_UNDER_100);
    return buildNumber(String(value), value, ["natural", "primo", "inteiro", "racional"]);
}

function makeMultipleOf3() {
    const value = (Math.floor(Math.random() * 33) + 1) * 3;
    return buildNumber(String(value), value, ["natural", "mult3", "inteiro", "racional"]);
}

function makeMultipleOf5() {
    const value = (Math.floor(Math.random() * 19) + 1) * 5;
    return buildNumber(String(value), value, ["natural", "mult5", "inteiro", "racional"]);
}

function makeMultipleOf10() {
    const value = (Math.floor(Math.random() * 9) + 1) * 10;
    return buildNumber(String(value), value, ["natural", "mult10", "mult5", "inteiro", "racional"]);
}

function buildNumber(display, value, rawSets) {
    const sets = new Set(rawSets.filter(Boolean));

    if (value > 0) {
        sets.add("maior_zero");
    } else if (value < 0) {
        sets.add("menor_zero");
    } else {
        sets.add("zero");
    }

    if (sets.has("inteiro") && Number.isInteger(value)) {
        sets.add(value % 2 === 0 ? "par" : "impar");

        if (PRIMES_UNDER_100_SET.has(value)) {
            sets.add("primo");
        }

        const absoluteValue = Math.abs(value);

        if (absoluteValue % 3 === 0) sets.add("mult3");
        if (absoluteValue % 5 === 0) sets.add("mult5");
        if (absoluteValue % 10 === 0) sets.add("mult10");
    }

    return { display, value, sets };
}

function pickRandomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
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
    return Object.freeze({
        id,
        label,
        emoji,
        description,
        check,
        operator: operator || null,
        operands: operands || null
    });
}

// ── Temas simples reutilizados ─────────────────────────────────────────────────

const THEME_NATURAL    = makeTheme("natural",  "Naturais",   "🌿", "Colete números Naturais (≥ 0)",             n => n.sets.has("natural"));
const THEME_PAR        = makeTheme("par",      "Pares",      "2️⃣", "Colete Inteiros Pares",                      n => n.sets.has("par"));
const THEME_IMPAR      = makeTheme("impar",    "Ímpares",    "1️⃣", "Colete Inteiros Ímpares",                    n => n.sets.has("impar"));
const THEME_PRIMO      = makeTheme("primo",    "Primos",     "✨", "Colete números Primos naturais",             n => n.sets.has("primo"));
const THEME_MULT3      = makeTheme("mult3",    "Múlt. de 3", "🔵", "Colete múltiplos de 3",                     n => n.sets.has("mult3"));
const THEME_MULT5      = makeTheme("mult5",    "Múlt. de 5", "🟠", "Colete múltiplos de 5",                     n => n.sets.has("mult5"));
const THEME_MAIOR_ZERO = makeTheme("maior_zero","Positivos", "➕", "Colete números maiores que zero",            n => n.value > 0);

const THEME_INTEIRO    = makeTheme("inteiro",  "Inteiros",   "🔢", "Colete qualquer número Inteiro",            n => n.sets.has("inteiro"));
const THEME_NEGATIVO   = makeTheme("negativo", "Negativos",  "➖", "Colete números menores que zero",           n => n.sets.has("negativo"));
const THEME_FRACAO     = makeTheme("fracao",   "Frações",    "⅓", "Colete Racionais não-inteiros",              n => n.sets.has("fracao"));
const THEME_RACIONAL   = makeTheme("racional", "Racionais",  "ℚ",  "Colete números Racionais (inteiros e frac.)",n => n.sets.has("racional"));
const THEME_IRRACIONAL = makeTheme("irracional","Irracionais","∞", "Colete números Irracionais",               n => n.sets.has("irracional"));

// ── Temas de UNIÃO (∪) — fácil e médio ────────────────────────────────────────

const THEME_U_PAR_PRIMO = makeTheme(
    "u_par_primo", "Pares ∪ Primos", "🔗",
    "Colete Pares OU Primos",
    n => n.sets.has("par") || n.sets.has("primo"),
    "union", ["par", "primo"]
);

const THEME_U_MULT3_MULT5 = makeTheme(
    "u_mult3_mult5", "Mult.3 ∪ Mult.5", "🔗",
    "Colete múltiplos de 3 OU de 5",
    n => n.sets.has("mult3") || n.sets.has("mult5"),
    "union", ["mult3", "mult5"]
);

const THEME_U_PAR_MULT3 = makeTheme(
    "u_par_mult3", "Pares ∪ Mult.3", "🔗",
    "Colete Pares OU múltiplos de 3",
    n => n.sets.has("par") || n.sets.has("mult3"),
    "union", ["par", "mult3"]
);

const THEME_U_IMPAR_MULT5 = makeTheme(
    "u_impar_mult5", "Ímpares ∪ Mult.5", "🔗",
    "Colete Ímpares OU múltiplos de 5",
    n => n.sets.has("impar") || n.sets.has("mult5"),
    "union", ["impar", "mult5"]
);

const THEME_U_PRIMO_MULT3 = makeTheme(
    "u_primo_mult3", "Primos ∪ Mult.3", "🔗",
    "Colete Primos naturais OU múltiplos de 3",
    n => n.sets.has("primo") || n.sets.has("mult3"),
    "union", ["primo", "mult3"]
);

const THEME_U_NEGATIVO_PRIMO = makeTheme(
    "u_negativo_primo", "Negativos ∪ Primos", "🔗",
    "Colete Negativos OU Primos naturais",
    n => n.sets.has("negativo") || n.sets.has("primo"),
    "union", ["negativo", "primo"]
);

const THEME_U_FRACAO_PAR = makeTheme(
    "u_fracao_par", "Frações ∪ Pares", "🔗",
    "Colete Frações OU Inteiros Pares",
    n => n.sets.has("fracao") || n.sets.has("par"),
    "union", ["fracao", "par"]
);

const THEME_U_NEGATIVO_MULT5 = makeTheme(
    "u_negativo_mult5", "Negativos ∪ Mult.5", "🔗",
    "Colete Negativos OU múltiplos de 5",
    n => n.sets.has("negativo") || n.sets.has("mult5"),
    "union", ["negativo", "mult5"]
);

const THEME_U_NATURAL_FRACAO = makeTheme(
    "u_natural_fracao", "Naturais ∪ Frações", "🔗",
    "Colete Naturais OU Frações",
    n => n.sets.has("natural") || n.sets.has("fracao"),
    "union", ["natural", "fracao"]
);

const THEME_U_PAR_MULT5 = makeTheme(
    "u_par_mult5", "Pares ∪ Mult.5", "🔗",
    "Colete Pares OU múltiplos de 5",
    n => n.sets.has("par") || n.sets.has("mult5"),
    "union", ["par", "mult5"]
);

const THEME_U_FRACAO_NEGATIVO = makeTheme(
    "u_fracao_neg", "Frações ∪ Negativos", "🔗",
    "Colete Frações OU Negativos",
    n => n.sets.has("fracao") || n.sets.has("negativo"),
    "union", ["fracao", "negativo"]
);

const THEME_U_IRRACIONAL_FRACAO = makeTheme(
    "u_irracional_fracao", "Irracionais ∪ Frações", "🔗",
    "Colete Irracionais OU Frações",
    n => n.sets.has("irracional") || n.sets.has("fracao"),
    "union", ["irracional", "fracao"]
);

const THEME_U_NEGATIVO_RAIZ_IRR = makeTheme(
    "u_negativo_raiz_irr", "Negativos ∪ Raízes irr.", "🔗",
    "Colete Negativos OU raízes irracionais",
    n => n.sets.has("negativo") || (n.sets.has("raiz") && n.sets.has("irracional")),
    "union", ["negativo", "raiz_irr"]
);

// ── Temas de INTERSEÇÃO (∩) — difícil ─────────────────────────────────────────

const THEME_I_NATURAL_IMPAR = makeTheme(
    "i_nat_impar", "Naturais ∩ Ímpares", "⊗",
    "Colete Naturais que também são Ímpares",
    n => n.sets.has("natural") && n.sets.has("impar"),
    "intersection", ["natural", "impar"]
);

const THEME_I_INTEIRO_POSITIVO = makeTheme(
    "i_int_pos", "Inteiros positivos", "⊗",
    "Colete Inteiros maiores que zero",
    n => n.sets.has("inteiro") && n.value > 0,
    "intersection", ["inteiro", "maior_zero"]
);

const THEME_I_RACIONAL_PAR_IMPAR = makeTheme(
    "i_rac_par_impar", "Racionais ∩ (Pares ∪ Ímpares)", "⊗",
    "Colete Racionais que são Inteiros Pares OU Ímpares",
    n => n.sets.has("racional") && (n.sets.has("par") || n.sets.has("impar")),
    "intersection", ["racional", "par_ou_impar"]
);

const THEME_I_NATURAL_PAR_MULT5 = makeTheme(
    "i_nat_par_mult5", "Naturais ∩ (Pares ∪ Mult.5)", "⊗",
    "Colete Naturais que são Pares OU múltiplos de 5",
    n => n.sets.has("natural") && (n.sets.has("par") || n.sets.has("mult5")),
    "intersection", ["natural", "par_ou_mult5"]
);

const THEME_I_IRRACIONAL_RAIZ = makeTheme(
    "i_irr_raiz", "Irracionais ∩ Raízes", "⊗",
    "Colete Irracionais que são raízes (√ de não-quadrados)",
    n => n.sets.has("irracional") && n.sets.has("raiz"),
    "intersection", ["irracional", "raiz"]
);

const HARD_NUMBER_THEMES = Object.freeze([
    THEME_NATURAL, THEME_INTEIRO, THEME_RACIONAL,
    THEME_IRRACIONAL, THEME_PAR, THEME_IMPAR,
    THEME_MAIOR_ZERO, THEME_I_NATURAL_IMPAR, THEME_I_IRRACIONAL_RAIZ,
    THEME_I_RACIONAL_PAR_IMPAR, THEME_I_NATURAL_PAR_MULT5,
    THEME_U_IRRACIONAL_FRACAO, THEME_U_NEGATIVO_RAIZ_IRR
]);

const NUMBER_PROFILES = Object.freeze({
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
            THEME_PAR, THEME_IMPAR, THEME_PRIMO, THEME_MULT3, THEME_MULT5,
            THEME_U_PAR_PRIMO, THEME_U_MULT3_MULT5, THEME_U_PAR_MULT5,
            THEME_U_PAR_MULT3, THEME_U_IMPAR_MULT5, THEME_U_PRIMO_MULT3
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
            THEME_NATURAL, THEME_INTEIRO, THEME_NEGATIVO, THEME_FRACAO,
            THEME_PAR, THEME_IMPAR, THEME_MAIOR_ZERO,
            THEME_U_NEGATIVO_PRIMO, THEME_U_PAR_MULT5, THEME_U_FRACAO_NEGATIVO,
            THEME_U_FRACAO_PAR, THEME_U_NEGATIVO_MULT5, THEME_U_NATURAL_FRACAO,
            THEME_I_INTEIRO_POSITIVO
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
        themes: HARD_NUMBER_THEMES
    })
});

// ─── Tabela de pesos por perfil (calculada uma vez por instância) ─────────────

function buildWeightTable(generators) {
    let total = 0;
    const entries = generators.map(({ fn, weight }) => {
        total += weight;
        return { fn, cumulative: total };
    });

    return { entries, total };
}

function pickGenerator(weightTable) {
    const roll = Math.random() * weightTable.total;

    for (const entry of weightTable.entries) {
        if (roll < entry.cumulative) {
            return entry.fn;
        }
    }

    return weightTable.entries[weightTable.entries.length - 1].fn;
}

// ─── Sistema de números (instância por sala) ──────────────────────────────────

function getNumberProfile(difficulty) {
    const key = difficulty === "easy" || difficulty === "hard"
        ? difficulty
        : "medium";

    return {
        key,
        profile: NUMBER_PROFILES[key]
    };
}

function createNumberGenerator(profile) {
    const weightTable = buildWeightTable(profile.generators);

    return () => pickGenerator(weightTable)();
}

module.exports = {
    createNumberGenerator,
    getNumberProfile
};
