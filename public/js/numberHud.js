/**
 * numberHud.js
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
