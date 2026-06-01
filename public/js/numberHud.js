/**
 * numberHud.js
<<<<<<< HEAD
 * Gerencia o painel de Conjunto Tema, placar e notificações de captura.
 */

export function createNumberHud() {
    const temaIcon    = document.getElementById("temaIcon");
    const temaName    = document.getElementById("temaName");
    const temaBar     = document.getElementById("temaTimerBar");
    const numCorrect  = document.getElementById("numCorrect");
    const numWrong    = document.getElementById("numWrong");
    const notifBox    = document.getElementById("captureNotif");

    let correct = 0;
    let wrong   = 0;
    let lastTema = null;

    return { update, processCapturas };

    function update(state, myId) {
        if (!state || !state.numbers) return;

        const tema = state.numbers.tema;
        if (tema) {
            // Atualizar ícone/nome apenas se mudou
            if (!lastTema || lastTema.id !== tema.id) {
                if (temaIcon) temaIcon.textContent = tema.icon;
                if (temaName) temaName.textContent = tema.label;
                lastTema = tema;
            }

            // Barra de progresso do timer
            if (temaBar && tema.trocaEm) {
                const now = Date.now();
                const total = 15000; // TEMA_INTERVAL_MS
                const restante = Math.max(0, tema.trocaEm - now);
                const pct = Math.round((restante / total) * 100);
                temaBar.style.width = `${pct}%`;
            }
        }

        // Processar capturas do meu jogador
        const me = state.players && myId ? state.players[myId] : null;
        if (me && me.capturas && me.capturas.length > 0) {
            processCapturas(me.capturas);
        }
    }

    function processCapturas(capturas) {
        for (const captura of capturas) {
            const ok = captura.pertenceAoTema;
            if (ok) correct++; else wrong++;

            if (numCorrect) numCorrect.textContent = correct;
            if (numWrong)   numWrong.textContent   = wrong;

            showNotif(captura, ok);
        }
    }

    function showNotif(captura, ok) {
        if (!notifBox) return;
        const el = document.createElement("div");
        el.className = `capture-notif ${ok ? "correct" : "wrong"}`;
        const conjLabel = captura.conjuntos
            ? captura.conjuntos.filter(c => c !== "racionais_nao").join(", ")
            : "";
        el.textContent = ok
            ? `✔ ${captura.display}  ∈  ${conjLabel}`
            : `✘ ${captura.display}  ∉  Tema Atual`;
        notifBox.appendChild(el);

        // Remover após animação (2.8s)
        setTimeout(() => {
            if (el.parentNode === notifBox) notifBox.removeChild(el);
        }, 2900);
    }
}
=======
 * HUD para o sistema de números:
 *  - Painel "Conjunto Tema" no topo/centro
 *  - Notificação de coleta no centro-inferior
 *
 * Usa DOM puro para performance em dispositivos fracos
 * (sem reflow pesado – apenas opacity/transform em elementos já existentes).
 */

export function createNumberHud() {
    // ── Tema ──────────────────────────────────────────────────────────────────
    const themePanel = createThemePanel();
    // ── Notificação ───────────────────────────────────────────────────────────
    const notifPanel = createNotifPanel();

    document.body.appendChild(themePanel.el);
    document.body.appendChild(notifPanel.el);

    let hideNotifTimer = null;

    return { updateTheme, showCollection };

    // ─── API ──────────────────────────────────────────────────────────────────

    /**
     * Atualiza o painel de tema com dados do snapshot.
     * @param {{ id, label, emoji, description }|null} theme
     * @param {number} secsLeft – segundos restantes no tema
     */
    function updateTheme(theme, secsLeft) {
        themePanel.update(theme, secsLeft);
    }

    /**
     * Exibe notificação de número coletado.
     * @param {{ display, value, sets, belongsToTheme }} data
     */
    function showCollection(data) {
        clearTimeout(hideNotifTimer);
        notifPanel.show(data);
        hideNotifTimer = setTimeout(() => notifPanel.hide(), 3200);
    }
}

// ─── Painel de Tema ───────────────────────────────────────────────────────────

function createThemePanel() {
    const el = document.createElement("div");
    el.id = "themePanel";
    el.innerHTML = `
        <div class="theme-inner">
            <span class="theme-emoji" id="themeEmoji">🎯</span>
            <div class="theme-text">
                <div class="theme-title">Conjunto Tema</div>
                <div class="theme-label" id="themeLabel">—</div>
                <div class="theme-desc" id="themeDesc"></div>
            </div>
            <div class="theme-timer" id="themeTimer"></div>
        </div>
    `;
    injectThemeStyles();

    const emojiEl = el.querySelector("#themeEmoji");
    const labelEl = el.querySelector("#themeLabel");
    const descEl  = el.querySelector("#themeDesc");
    const timerEl = el.querySelector("#themeTimer");

    function update(theme, secsLeft) {
        if (!theme) return;
        emojiEl.textContent = theme.emoji || "🎯";
        labelEl.textContent = theme.label || "—";
        descEl.textContent  = theme.description || "";
        timerEl.textContent = secsLeft > 0 ? `${secsLeft}s` : "";
    }

    return { el, update };
}

function injectThemeStyles() {
    if (document.getElementById("numberHudStyles")) return;
    const style = document.createElement("style");
    style.id = "numberHudStyles";
    style.textContent = `
        /* ── Tema ── */
        #themePanel {
            position: fixed;
            top: 14px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 200;
            pointer-events: none;
        }
        .theme-inner {
            display: flex;
            align-items: center;
            gap: 10px;
            background: rgba(15, 15, 25, 0.82);
            border: 1.5px solid rgba(255,255,255,0.15);
            border-radius: 40px;
            padding: 8px 20px 8px 14px;
            backdrop-filter: blur(6px);
            box-shadow: 0 4px 18px rgba(0,0,0,0.45);
        }
        .theme-emoji {
            font-size: 26px;
            line-height: 1;
        }
        .theme-text {
            display: flex;
            flex-direction: column;
        }
        .theme-title {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 1.2px;
            text-transform: uppercase;
            color: rgba(255,255,255,0.45);
            font-family: 'Segoe UI', sans-serif;
        }
        .theme-label {
            font-size: 17px;
            font-weight: 800;
            color: #fff;
            font-family: 'Segoe UI', sans-serif;
            line-height: 1.1;
        }
        .theme-desc {
            font-size: 11px;
            color: rgba(255,255,255,0.55);
            font-family: 'Segoe UI', sans-serif;
        }
        .theme-timer {
            font-size: 13px;
            font-weight: 700;
            color: rgba(255,220,80,0.9);
            font-family: 'Segoe UI', monospace;
            min-width: 30px;
            text-align: right;
        }

        /* ── Notificação ── */
        #collectNotif {
            position: fixed;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%) translateY(20px);
            z-index: 300;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.25s ease, transform 0.25s ease;
            font-family: 'Segoe UI', sans-serif;
        }
        #collectNotif.visible {
            opacity: 1;
            transform: translateX(-50%) translateY(0px);
        }
        .notif-card {
            display: flex;
            align-items: center;
            gap: 14px;
            background: rgba(10, 12, 20, 0.90);
            border-radius: 18px;
            padding: 12px 22px;
            box-shadow: 0 6px 28px rgba(0,0,0,0.55);
            border: 1.5px solid rgba(255,255,255,0.1);
            backdrop-filter: blur(8px);
            min-width: 220px;
        }
        .notif-bubble {
            width: 52px;
            height: 52px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 22px;
            font-weight: 900;
            color: #fff;
            flex-shrink: 0;
            border: 2px solid rgba(255,255,255,0.3);
        }
        .notif-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .notif-display {
            font-size: 22px;
            font-weight: 900;
            color: #fff;
            line-height: 1;
        }
        .notif-sets {
            font-size: 11px;
            color: rgba(255,255,255,0.55);
            line-height: 1.3;
        }
        .notif-theme-badge {
            font-size: 11px;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 20px;
            margin-top: 3px;
            display: inline-block;
            width: fit-content;
        }
        .notif-theme-badge.match {
            background: rgba(74, 222, 128, 0.25);
            color: #4ade80;
            border: 1px solid rgba(74, 222, 128, 0.5);
        }
        .notif-theme-badge.no-match {
            background: rgba(248, 113, 113, 0.2);
            color: #f87171;
            border: 1px solid rgba(248, 113, 113, 0.4);
        }
    `;
    document.head.appendChild(style);
}

// ─── Painel de Notificação ────────────────────────────────────────────────────

const SET_LABELS = {
    natural:    "Natural",
    inteiro:    "Inteiro",
    negativo:   "Negativo",
    fracao:     "Fração",
    raiz:       "Raiz",
    irracional: "Irracional",
    racional:   "Racional",
    par:        "Par",
    impar:      "Ímpar",
    maior_zero: "> 0",
    menor_zero: "< 0"
};

const SET_BG_COLORS = {
    natural:    "#166534",
    negativo:   "#7f1d1d",
    fracao:     "#713f12",
    raiz:       "#1e3a5f",
    irracional: "#4a1d96",
    default:    "#1e293b"
};

function getBgForSets(sets) {
    for (const key of Object.keys(SET_BG_COLORS)) {
        if (sets.includes(key)) return SET_BG_COLORS[key];
    }
    return SET_BG_COLORS.default;
}

function getColorForSets(sets) {
    if (sets.includes("natural"))    return "#4ade80";
    if (sets.includes("negativo"))   return "#f87171";
    if (sets.includes("fracao"))     return "#facc15";
    if (sets.includes("raiz"))       return "#60a5fa";
    if (sets.includes("irracional")) return "#c084fc";
    return "#e2e8f0";
}

function friendlySets(sets) {
    const priority = ["irracional","raiz","fracao","negativo","natural","inteiro","racional","par","impar"];
    const visible = [];
    for (const key of priority) {
        if (sets.includes(key) && SET_LABELS[key]) {
            visible.push(SET_LABELS[key]);
            if (visible.length >= 3) break;
        }
    }
    if (sets.includes("maior_zero") && !visible.includes("Natural")) visible.push("> 0");
    if (sets.includes("menor_zero")) visible.push("< 0");
    return visible.join(" · ");
}

function createNotifPanel() {
    const el = document.createElement("div");
    el.id = "collectNotif";
    el.innerHTML = `<div class="notif-card">
        <div class="notif-bubble" id="notifBubble">?</div>
        <div class="notif-info">
            <div class="notif-display" id="notifDisplay">—</div>
            <div class="notif-sets" id="notifSets"></div>
            <div class="notif-theme-badge" id="notifBadge"></div>
        </div>
    </div>`;

    const bubbleEl  = el.querySelector("#notifBubble");
    const displayEl = el.querySelector("#notifDisplay");
    const setsEl    = el.querySelector("#notifSets");
    const badgeEl   = el.querySelector("#notifBadge");

    function show(data) {
        const { display, sets, belongsToTheme } = data;
        const color = getColorForSets(sets);
        const bg    = getBgForSets(sets);

        bubbleEl.textContent         = display;
        bubbleEl.style.background    = bg;
        bubbleEl.style.borderColor   = color;
        displayEl.textContent        = display;
        displayEl.style.color        = color;
        setsEl.textContent           = friendlySets(sets);

        if (belongsToTheme) {
            badgeEl.textContent  = "✓ Tema correto!";
            badgeEl.className    = "notif-theme-badge match";
        } else {
            badgeEl.textContent  = "✗ Fora do tema";
            badgeEl.className    = "notif-theme-badge no-match";
        }

        el.classList.add("visible");
    }

    function hide() {
        el.classList.remove("visible");
    }

    return { el, show, hide };
}
>>>>>>> 70aca42 (teste)
