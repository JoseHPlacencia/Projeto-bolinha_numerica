export function createNumberHud(options = {}) {
    const themePanel = createThemePanel();
    const notifPanel = createNotifPanel();
    const container = options.container || document.getElementById("gameLayer") || document.body;

    container.appendChild(themePanel.el);
    container.appendChild(notifPanel.el);

    let hideNotifTimer = null;

    return { updateBalance, updateTheme, showCollection };

    function updateBalance(player) {
        themePanel.updateBalance(player);
    }

    function updateTheme(theme, secsLeft) {
        themePanel.update(theme, secsLeft);
    }

    function showCollection(data) {
        clearTimeout(hideNotifTimer);
        notifPanel.show(data);
        hideNotifTimer = setTimeout(() => notifPanel.hide(), 1800);
    }
}

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
        <div class="theme-balance" id="themeBalance" aria-live="polite">
            <span>Saldo de acertos</span>
            <strong id="themeBalanceValue">0</strong>
        </div>
    `;
    const emojiEl = el.querySelector("#themeEmoji");
    const labelEl = el.querySelector("#themeLabel");
    const descEl  = el.querySelector("#themeDesc");
    const timerEl = el.querySelector("#themeTimer");
    const balanceEl = el.querySelector("#themeBalance");
    const balanceValueEl = el.querySelector("#themeBalanceValue");

    function update(theme, secsLeft) {
        if (!theme) return;
        emojiEl.textContent = theme.emoji || "🎯";
        labelEl.textContent = theme.label || "—";
        descEl.textContent  = theme.description || "";
        timerEl.textContent = secsLeft > 0 ? `${secsLeft}s` : "";

        // Visual accent for union/intersection themes
        const inner = el.querySelector(".theme-inner");
        if (inner) {
            inner.classList.remove("theme-op-union", "theme-op-intersection");
            if (theme.operator === "union")        inner.classList.add("theme-op-union");
            if (theme.operator === "intersection") inner.classList.add("theme-op-intersection");
        }
    }

    function updateBalance(player) {
        if (!balanceEl || !balanceValueEl) {
            return;
        }

        const balance = Number(player && player.catchBalance);

        if (!Number.isFinite(balance)) {
            balanceEl.hidden = true;
            return;
        }

        const roundedBalance = Math.round(balance);
        balanceEl.hidden = false;
        balanceEl.classList.toggle("theme-balance--positive", roundedBalance > 0);
        balanceEl.classList.toggle("theme-balance--negative", roundedBalance < 0);
        balanceEl.classList.toggle("theme-balance--neutral", roundedBalance === 0);
        balanceValueEl.textContent = roundedBalance > 0 ? `+${roundedBalance}` : String(roundedBalance);
    }

    return { el, update, updateBalance };
}

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
    primo:      "Primo",
    mult3:      "Múlt. 3",
    mult5:      "Múlt. 5",
    mult10:     "Múlt. 10",
    zero:       "Zero",
    maior_zero: "> 0",
    menor_zero: "< 0"
};

const SET_BG_COLORS = {
    natural:    "#166534",
    negativo:   "#7f1d1d",
    fracao:     "#713f12",
    raiz:       "#1e3a5f",
    irracional: "#4a1d96",
    primo:      "#7c3aed",
    mult3:      "#0e4c6e",
    mult5:      "#7a3a00",
    default:    "#1e293b"
};

function getBgForSets(sets) {
    for (const key of Object.keys(SET_BG_COLORS)) {
        if (sets.includes(key)) return SET_BG_COLORS[key];
    }
    return SET_BG_COLORS.default;
}

function getColorForSets(sets) {
    if (sets.includes("irracional")) return "#c084fc";
    if (sets.includes("raiz"))       return "#60a5fa";
    if (sets.includes("primo"))      return "#a78bfa";
    if (sets.includes("negativo"))   return "#f87171";
    if (sets.includes("fracao"))     return "#facc15";
    if (sets.includes("natural"))    return "#4ade80";
    if (sets.includes("mult3"))      return "#38bdf8";
    if (sets.includes("mult5"))      return "#fb923c";
    return "#e2e8f0";
}

function friendlySets(sets) {
    const priority = ["irracional","raiz","fracao","negativo","natural","inteiro","racional","primo","par","impar","mult3","mult5","mult10"];
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
