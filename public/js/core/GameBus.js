// ============================================================
// core/GameBus.js — Event Bus + Constantes de Eventos
// ============================================================
//
// Barramento central de eventos do jogo. Sistemas comunicam-se
// por eventos nomeados SEM referências diretas entre si.
//
// POR QUE USAR UM BUS?
//   Sem o bus, cada módulo chama diretamente funções de outros:
//     gameClient.js → _mostrarFlashOperacao("A ∪ B")
//     gameClient.js → updateScore(area)
//     gameClient.js → educationalModule.notifyCapture(area)
//
//   Com o bus, o módulo de jogo apenas emite:
//     gameBus.emit(GameEvents.TERRITORY_CAPTURED, { area })
//
//   E qualquer módulo interessado — presente ou FUTURO — subscreve:
//     gameBus.on(GameEvents.TERRITORY_CAPTURED, ({ area }) => { ... })
//
//   Isso permite que módulos educacionais (quiz, pontuação, teoria)
//   se conectem ao jogo sem alterar uma linha do código do núcleo.
//
// EXTENSIBILIDADE:
//   Para adicionar um novo módulo educacional:
//     import { gameBus, GameEvents } from "./core/GameBus.js";
//     gameBus.on(GameEvents.TERRITORY_CAPTURED, ({ area, affectedEnemies }) => {
//         showSetUnionExplanation(area);
//     });
//
// Nenhuma alteração no código do jogo é necessária.

// ─── Constantes de Eventos ────────────────────────────────────
//
// Object.freeze garante que os nomes não sejam alterados acidentalmente.
// Usar sempre estas constantes em vez de strings literais — evita typos.
export const GameEvents = Object.freeze({
    // Território capturado pelo jogador local (operação A ∪ B)
    // payload: { capturedArea: [{x,y}], affectedEnemies: string[] }
    TERRITORY_CAPTURED: "territory:captured",

    // Território subtraído do jogador local por um inimigo (operação A − B)
    // payload: { poligono: [{x,y}] }
    TERRITORY_LOST: "territory:lost",

    // Território resetado para o círculo base (após respawn)
    // payload: {}
    TERRITORY_RESET: "territory:reset",

    // Jogador local morreu
    // payload: { cause: "self" | "intercepted" }
    PLAYER_DIED: "player:died",

    // Jogador local respawnou (movimento liberado pelo servidor)
    // payload: {}
    PLAYER_RESPAWNED: "player:respawned",

    // Rastro do jogador local foi interceptado por um inimigo
    // payload: {}
    TRAIL_INTERCEPTED: "trail:intercepted",
});

// ─── GameBus ──────────────────────────────────────────────────
class GameBus {
    constructor() {
        // Map<eventName, handler[]>
        this._listeners = new Map();
    }

    // Subscreve a um evento. Retorna função de cancelamento.
    on(event, handler) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, []);
        }
        this._listeners.get(event).push(handler);

        // Retorna unsubscribe para facilitar cleanup
        return () => {
            const list = this._listeners.get(event);
            if (!list) return;
            const idx = list.indexOf(handler);
            if (idx >= 0) list.splice(idx, 1);
        };
    }

    // Emite um evento com payload opcional.
    // Itera sobre uma cópia da lista para que handlers que chamem off()
    // durante a iteração não causem erros de índice.
    emit(event, data) {
        const list = this._listeners.get(event);
        if (!list || list.length === 0) return;
        for (const handler of list.slice()) {
            handler(data);
        }
    }
}

// Singleton — uma instância compartilhada por todos os módulos.
export const gameBus = new GameBus();
