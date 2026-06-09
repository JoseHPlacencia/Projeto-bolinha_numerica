/**
 * numberSystem.js
 * Sistema de Números Numéricos – Servidor
 *
 * Responsabilidades:
 *  - Gerar números dos conjuntos: Naturais, Inteiros Negativos, Frações, Raízes e Irracionais
 *  - Fazer spawn/respawn com espalhamento e distância mínima
 *  - Detectar colisão com jogadores (círculo × círculo)
 *  - Gerir o Conjunto Tema que alterna periodicamente
 *  - Publicar estado compacto no snapshot
 *
 * Otimizado para dispositivos fracos:
 *  - Estruturas simples (Map, arrays planos)
 *  - Sem dependências externas
 *  - Atualizações somente quando há mudança
 */

"use strict";

// ─── Variáveis Globais de Configuração ───────────────────────────────────────

const NUMBER_CONFIG = Object.freeze({
    // Raio visual do número no mundo (px world-space)
    radius: 40,

    // Distância mínima entre números spawnados
    minDistanceBetween: 180,

    // Distância mínima de jogadores no spawn
    minDistanceFromPlayer: 220,

    // Quantidade máxima de números ativos no mapa
    maxNumbers: 25,

    // Segundos até respawn após coleta
    respawnDelaySec: 4,

    // Segundos que o Conjunto Tema fica ativo antes de trocar
    themeIntervalSec: 20,

    // Tentativas máximas de encontrar posição válida
    maxSpawnAttempts: 80,

    // Pesos de spawn por conjunto (maior = aparece mais)
    // Naturais=1, Negativos=2, Frações=3, Raízes=3, Irracionais=1
    spawnWeights: Object.freeze({
        natural:   1,
        negativo:  2,
        fracao:    3,
        raiz:      3,
        irracional:1
    })
});

// Constantes irracionais disponíveis (até 2 dígitos de valor absoluto)
const IRRATIONALS = Object.freeze([
    { display: "π",   value: Math.PI,           approx: 3.14  },
    { display: "e",   value: Math.E,             approx: 2.72  },
    { display: "φ",   value: (1 + Math.sqrt(5)) / 2, approx: 1.62 },
    { display: "√2",  value: Math.SQRT2,         approx: 1.41  },
    { display: "√3",  value: Math.sqrt(3),       approx: 1.73  },
    { display: "√5",  value: Math.sqrt(5),       approx: 2.24  },
    { display: "√7",  value: Math.sqrt(7),       approx: 2.65  },
    { display: "√10", value: Math.sqrt(10),      approx: 3.16  },
    { display: "√11", value: Math.sqrt(11),      approx: 3.32  },
    { display: "√13", value: Math.sqrt(13),      approx: 3.61  },
    { display: "√17", value: Math.sqrt(17),      approx: 4.12  },
    { display: "√19", value: Math.sqrt(19),      approx: 4.36  },
    { display: "√23", value: Math.sqrt(23),      approx: 4.80  },
    { display: "√29", value: Math.sqrt(29),      approx: 5.39  },
    { display: "√31", value: Math.sqrt(31),      approx: 5.57  },
    { display: "√37", value: Math.sqrt(37),      approx: 6.08  },
    { display: "√41", value: Math.sqrt(41),      approx: 6.40  },
    { display: "√43", value: Math.sqrt(43),      approx: 6.56  },
    { display: "√47", value: Math.sqrt(47),      approx: 6.86  },
    { display: "√53", value: Math.sqrt(53),      approx: 7.28  },
    { display: "√59", value: Math.sqrt(59),      approx: 7.68  },
    { display: "√61", value: Math.sqrt(61),      approx: 7.81  },
    { display: "√67", value: Math.sqrt(67),      approx: 8.19  },
    { display: "√71", value: Math.sqrt(71),      approx: 8.43  },
    { display: "√73", value: Math.sqrt(73),      approx: 8.54  },
    { display: "√79", value: Math.sqrt(79),      approx: 8.89  },
    { display: "√83", value: Math.sqrt(83),      approx: 9.11  },
    { display: "√89", value: Math.sqrt(89),      approx: 9.43  },
    { display: "√97", value: Math.sqrt(97),      approx: 9.85  }
]);

// Temas disponíveis (com variantes operacionais)
const THEMES = Object.freeze([
    {
        id: "natural",
        label: "Naturais",
        emoji: "🌿",
        description: "Colete números Naturais (≥ 0)",
        check: n => n.sets.has("natural")
    },
    {
        id: "inteiro",
        label: "Inteiros",
        emoji: "🔢",
        description: "Colete qualquer número Inteiro",
        check: n => n.sets.has("inteiro")
    },
    {
        id: "negativo",
        label: "Negativos",
        emoji: "➖",
        description: "Colete números menores que zero",
        check: n => n.sets.has("negativo")
    },
    {
        id: "fracao",
        label: "Frações",
        emoji: "⅓",
        description: "Colete números Racionais não-inteiros",
        check: n => n.sets.has("fracao")
    },
    {
        id: "raiz",
        label: "Raízes",
        emoji: "√",
        description: "Colete números com Raiz quadrada",
        check: n => n.sets.has("raiz")
    },
    {
        id: "irracional",
        label: "Irracionais",
        emoji: "∞",
        description: "Colete números Irracionais",
        check: n => n.sets.has("irracional")
    },
    // Variantes operacionais
    {
        id: "maior_zero",
        label: "Positivos",
        emoji: "➕",
        description: "Colete números maiores que zero",
        check: n => n.value > 0
    },
    {
        id: "menor_zero",
        label: "Negativos Estritos",
        emoji: "📉",
        description: "Colete números estritamente negativos",
        check: n => n.value < 0
    },
    {
        id: "par",
        label: "Pares",
        emoji: "2️⃣",
        description: "Colete Inteiros Pares",
        check: n => n.sets.has("inteiro") && Number.isInteger(n.value) && n.value % 2 === 0
    },
    {
        id: "impar",
        label: "Ímpares",
        emoji: "1️⃣",
        description: "Colete Inteiros Ímpares",
        check: n => n.sets.has("inteiro") && Number.isInteger(n.value) && Math.abs(n.value % 2) === 1
    }
    // Primos reservado para modo futuro:
    // { id: "primo", label: "Primos", check: n => isPrime(n.value), enabled: false }
]);

// ─── Estado Global ────────────────────────────────────────────────────────────

let _nextId    = 1;
let _numbers   = new Map();   // id → numberObject
let _pending   = [];          // [{spawnAt}] fila de respawns
let _theme     = null;        // tema atual
let _themeIdx  = 0;
let _themeNextSwitch = 0;

// ─── Geração de Números ───────────────────────────────────────────────────────

/**
 * Retorna o conjunto de peso acumulado para escolha ponderada.
 */
let _weightTable = null;
function getWeightTable() {
    if (_weightTable) return _weightTable;
    const w = NUMBER_CONFIG.spawnWeights;
    const entries = Object.entries(w);
    let total = 0;
    _weightTable = entries.map(([key, weight]) => {
        total += weight;
        return { key, cumulative: total };
    });
    _weightTable._total = total;
    return _weightTable;
}

function pickRandomSet() {
    const table = getWeightTable();
    const roll = Math.random() * table._total;
    for (const entry of table) {
        if (roll < entry.cumulative) return entry.key;
    }
    return table[table.length - 1].key;
}

/**
 * Gera um objeto de número com todos os metadados:
 *  display, value, sets (Set de strings)
 */
function generateNumber() {
    const setType = pickRandomSet();

    switch (setType) {
        case "natural":    return makeNatural();
        case "negativo":   return makeNegativo();
        case "fracao":     return makeFracao();
        case "raiz":       return makeRaiz();
        case "irracional": return makeIrracional();
        default:           return makeNatural();
    }
}

function makeNatural() {
    const v = Math.floor(Math.random() * 100); // 0–99
    return buildNumber(String(v), v, ["natural", "inteiro", "racional", v >= 0 ? "maior_zero_ou_zero" : null]);
}

function makeNegativo() {
    const v = -(Math.floor(Math.random() * 99) + 1); // -1 a -99
    return buildNumber(String(v), v, ["negativo", "inteiro", "racional"]);
}

function makeFracao() {
    // Numerador e denominador para fracoes simples legíveis
    const denominators = [2, 3, 4, 5, 6, 8, 10];
    const den = denominators[Math.floor(Math.random() * denominators.length)];
    let num = Math.floor(Math.random() * (den * 2 - 1)) + 1; // 1 até 2*den-1
    if (num === den) num = den - 1 || 1; // evitar inteiros
    const negative = Math.random() < 0.3;
    const sign = negative ? "-" : "";
    const value = (negative ? -num : num) / den;
    const display = `${sign}${num}/${den}`;
    const sets = ["fracao", "racional"];
    if (negative) sets.push("negativo");
    else sets.push("natural_fracionario"); // não é natural mas > 0
    return buildNumber(display, value, sets);
}

function makeRaiz() {
    // Raízes de não-quadrados perfeitos até √99 → irracional; quadrados → racional
    // Exibimos como "√N"
    let n;
    const isIrrational = Math.random() < 0.7;
    if (isIrrational) {
        // não-quadrado perfeito entre 2 e 99
        const nonPerfect = [2,3,5,6,7,8,10,11,12,13,14,15,17,18,19,20,21,22,23,24,26,
            27,28,29,30,31,32,33,34,35,37,38,39,40,41,42,43,44,45,46,47,48,50,
            51,52,53,54,55,56,57,58,59,60,61,62,63,65,66,67,68,69,70,71,72,73,
            74,75,76,77,78,79,80,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99];
        n = nonPerfect[Math.floor(Math.random() * nonPerfect.length)];
        return buildNumber(`√${n}`, Math.sqrt(n), ["raiz", "irracional", "racional_ext"]);
    } else {
        // quadrado perfeito: 1,4,9,16,25,36,49,64,81
        const perfect = [1,4,9,16,25,36,49,64,81];
        n = perfect[Math.floor(Math.random() * perfect.length)];
        return buildNumber(`√${n}`, Math.sqrt(n), ["raiz", "natural", "inteiro", "racional"]);
    }
}

function makeIrracional() {
    const item = IRRATIONALS[Math.floor(Math.random() * IRRATIONALS.length)];
    return buildNumber(item.display, item.value, ["irracional", "racional_ext"]);
}

function buildNumber(display, value, rawSets) {
    const sets = new Set(rawSets.filter(Boolean));
    // Inferência adicional de conjuntos
    if (sets.has("natural") && !sets.has("negativo")) sets.add("maior_zero_ou_zero");
    if (value > 0) sets.add("maior_zero");
    if (value < 0) sets.add("menor_zero");
    if (sets.has("inteiro") && Number.isInteger(value)) {
        if (value % 2 === 0) sets.add("par");
        else sets.add("impar");
    }
    return { display, value, sets };
}

// ─── Posicionamento ───────────────────────────────────────────────────────────

function trySpawnPosition(mapRadius, players) {
    const limit = mapRadius * 0.88;
    for (let i = 0; i < NUMBER_CONFIG.maxSpawnAttempts; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist  = Math.sqrt(Math.random()) * limit;
        const x     = Math.cos(angle) * dist;
        const y     = Math.sin(angle) * dist;

        if (!isPositionFarFromNumbers(x, y)) continue;
        if (!isPositionFarFromPlayers(x, y, players)) continue;

        return { x, y };
    }
    return null; // não encontrou (mapa lotado)
}

function isPositionFarFromNumbers(x, y) {
    const minD = NUMBER_CONFIG.minDistanceBetween;
    for (const num of _numbers.values()) {
        const dx = num.x - x, dy = num.y - y;
        if (dx * dx + dy * dy < minD * minD) return false;
    }
    return true;
}

function isPositionFarFromPlayers(x, y, players) {
    const minD = NUMBER_CONFIG.minDistanceFromPlayer;
    for (const p of players.values()) {
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy < minD * minD) return false;
    }
    return true;
}

// ─── Ciclo de Vida ────────────────────────────────────────────────────────────

function spawnOneNumber(mapRadius, players) {
    const pos = trySpawnPosition(mapRadius, players);
    if (!pos) return null;

    const numData  = generateNumber();
    const id       = _nextId++;
    const numObj   = {
        id,
        x:       pos.x,
        y:       pos.y,
        display: numData.display,
        value:   numData.value,
        sets:    numData.sets,   // Set<string> – somente servidor
        version: 1
    };
    _numbers.set(id, numObj);
    return numObj;
}

/**
 * Inicializa o mapa com números.
 */
function initNumbers(mapRadius, players) {
    _numbers.clear();
    _pending = [];
    for (let i = 0; i < NUMBER_CONFIG.maxNumbers; i++) {
        spawnOneNumber(mapRadius, players);
    }
    initTheme();
}

function initTheme() {
    _themeIdx         = Math.floor(Math.random() * THEMES.length);
    _theme            = THEMES[_themeIdx];
    _themeNextSwitch  = Date.now() + NUMBER_CONFIG.themeIntervalSec * 1000;
}

/**
 * Tick chamado pelo gameLoop (60 Hz). Leve: só verifica timers.
 * @param {Map} players
 * @param {number} mapRadius
 * @param {number} nowMs  - Date.now()
 * @returns {{collisions: Array, themeChanged: boolean}}
 */
function updateNumbers(players, mapRadius, nowMs) {
    let themeChanged = false;

    // Troca de tema
    if (nowMs >= _themeNextSwitch) {
        _themeIdx = (_themeIdx + 1) % THEMES.length;
        _theme    = THEMES[_themeIdx];
        _themeNextSwitch = nowMs + NUMBER_CONFIG.themeIntervalSec * 1000;
        themeChanged = true;
    }

    // Respawn de números pendentes
    while (_pending.length > 0 && _pending[0].spawnAt <= nowMs) {
        _pending.shift();
        if (_numbers.size < NUMBER_CONFIG.maxNumbers) {
            spawnOneNumber(mapRadius, players);
        }
    }

    // Completar mapa se abaixo do máximo e sem pending
    if (_numbers.size < NUMBER_CONFIG.maxNumbers && _pending.length === 0) {
        spawnOneNumber(mapRadius, players);
    }

    // Detecção de colisão
    const collisions = [];
    const playerRadius = 35; // metade do playerSize para cálculo de colisão
    const combinedRadius = NUMBER_CONFIG.radius + playerRadius;
    const cr2 = combinedRadius * combinedRadius;

    for (const [nid, num] of _numbers) {
        for (const player of players.values()) {
            const dx = player.x - num.x;
            const dy = player.y - num.y;
            if (dx * dx + dy * dy < cr2) {
                collisions.push({
                    numberId:  nid,
                    playerId:  player.id,
                    display:   num.display,
                    value:     num.value,
                    sets:      [...num.sets],    // array para serialização
                    belongsToTheme: _theme ? _theme.check(num) : false
                });
                _numbers.delete(nid);
                _pending.push({ spawnAt: nowMs + NUMBER_CONFIG.respawnDelaySec * 1000 });
                break;
            }
        }
    }

    return { collisions, themeChanged };
}

// ─── Serialização Compacta ────────────────────────────────────────────────────

/**
 * Snapshot compacto para enviar ao cliente.
 * Formato: { nums: [[id,x,y,display,value], ...], theme: {id,label,emoji,description}, themeEndsIn }
 */
function serializeNumbers() {
    const nums = [];
    for (const n of _numbers.values()) {
        // [id, x(int), y(int), display, value(float2)]
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
        theme: _theme ? {
            id:          _theme.id,
            label:       _theme.label,
            emoji:       _theme.emoji,
            description: _theme.description
        } : null,
        themeEndsIn: Math.max(0, Math.round((_themeNextSwitch - Date.now()) / 1000))
    };
}

module.exports = {
    NUMBER_CONFIG,
    THEMES,
    initNumbers,
    updateNumbers,
    serializeNumbers,
    getNumbersMap: () => _numbers
};
