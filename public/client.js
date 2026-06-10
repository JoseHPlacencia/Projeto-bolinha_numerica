import { loadGameConfig } from "./js/config.js";
import { startClient } from "./js/gameClient.js";
import { createMenuBackground } from "./js/menuBackground.js";

const STORAGE_KEYS = {
    color: "bolinhaJogadorCor",
    difficulty: "bolinhaDificuldade",
    name: "bolinhaJogadorNome"
};

const DEFAULT_PLAYER_COLOR = "#ff2626";
const playerNameInput = document.getElementById("player-name");
const colorPicker = document.getElementById("color-picker");
const difficultyRow = document.querySelector(".diff-row");
const playButton = document.getElementById("btn-play");
const findRoomMenuButton = document.getElementById("btn-encontrar-sala");
const createRoomMenuButton = document.getElementById("btn-criar-sala");
const mainMenu = document.getElementById("mainMenu");
const gameLayer = document.getElementById("gameLayer");
const gameOverPanel = document.getElementById("gameOverPanel");
const gameOverTitle = document.getElementById("gameOverTitle");
const gameOverMessage = document.getElementById("gameOverMessage");
const gameOverReturnButton = document.getElementById("gameOverReturnButton");
const statusMessage = createStatusMessage();
const AUTO_START_TIMEOUT_MS = 10000;
const PLAY_BUTTON_IDLE_LABEL = "▶ Partida rápida";

let selectedColor = DEFAULT_PLAYER_COLOR;
let selectedDifficulty = "medium";
let gameClient = null;
let menuBackground = null;
let pendingAutoStart = null;
let pendingAutoStartTimer = null;
let pendingSocketConnectCleanup = null;
let pendingMenuRoomJoin = false;
let nextAutoStartId = 0;

initializeClient();

async function initializeClient() {
    try {
        const gameConfig = await loadGameConfig();
        menuBackground = createMenuBackground(gameConfig);
        gameClient = startClient(gameConfig, {
            getPlayerOptions,
            onExitGame: showMenu,
            onGameOver: showGameOver,
            onJoinFailure: handleJoinFailure,
            onJoinStart: handleRoomJoinStart,
            onJoinSuccess: handleJoinSuccess
        });

        initializeMenu();
    } catch (error) {
        console.error("Failed to start client:", error);
        statusMessage.update("Erro ao iniciar o jogo.");
    }
}

function initializeMenu() {
    loadPreferences();
    attachColorPicker();
    attachDifficultyButtons();
    attachPlayButton();
    attachFindRoomButton();
    attachCreateRoomButton();
    attachOverlayButtons();
    showMenu();
}

function loadPreferences() {
    const savedName = localStorage.getItem(STORAGE_KEYS.name);
    const savedColor = localStorage.getItem(STORAGE_KEYS.color);
    const savedDifficulty = localStorage.getItem(STORAGE_KEYS.difficulty);

    if (savedName) playerNameInput.value = savedName;
    if (savedColor) selectColor(savedColor);
    if (savedDifficulty) selectDifficulty(savedDifficulty);
}

function attachColorPicker() {
    colorPicker.addEventListener("click", event => {
        const swatch = event.target.closest(".color-swatch");
        if (!swatch) return;
        selectColor(swatch.dataset.color);
    });
}

function attachDifficultyButtons() {
    difficultyRow.addEventListener("click", event => {
        const button = event.target.closest(".diff-btn");
        if (!button) return;
        selectDifficulty(button.dataset.diff);
    });
}

function attachPlayButton() {
    playButton.addEventListener("click", () => {
        savePreferences();
        startPublicGame();
    });
}

function attachCreateRoomButton() {
    if (!createRoomMenuButton) return;

    createRoomMenuButton.addEventListener("click", () => {
        savePreferences();
        ensureSocketConnection();
        gameClient.roomUi.openCreateModal();
    });
}

function attachFindRoomButton() {
    if (!findRoomMenuButton) return;

    findRoomMenuButton.addEventListener("click", () => {
        savePreferences();
        ensureSocketConnection();
        gameClient.roomUi.openFindModal();
    });
}

function attachOverlayButtons() {
    gameOverReturnButton?.addEventListener("click", () => {
        hideGameOver();
        showMenu();
    });

    document.querySelectorAll("[data-close]").forEach(button => {
        button.addEventListener("click", () => {
            closeOverlay(button.dataset.close);
        });
    });

    document.getElementById("btn-help")?.addEventListener("click", () => {
        openOverlay("overlay-help");
    });

    document.getElementById("btn-sobre")?.addEventListener("click", () => {
        openOverlay("overlay-sobre");
    });

    document.querySelectorAll(".tab-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            const tabName = pill.dataset.tab;
            document.querySelectorAll(".tab-pill").forEach(item => item.classList.remove("active"));
            document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.remove("active"));
            pill.classList.add("active");
            document.getElementById(`tab-${tabName}`)?.classList.add("active");
        });
    });
}

function savePreferences() {
    const name = playerNameInput.value.trim() || "Jogador";
    selectedColor ||= DEFAULT_PLAYER_COLOR;
    selectedDifficulty ||= "medium";

    localStorage.setItem(STORAGE_KEYS.name, name);
    localStorage.setItem(STORAGE_KEYS.color, selectedColor);
    localStorage.setItem(STORAGE_KEYS.difficulty, selectedDifficulty);
}

function selectColor(color) {
    const swatches = [...colorPicker.querySelectorAll(".color-swatch")];
    const selectedSwatch = swatches.find(swatch => swatch.dataset.color === color);
    selectedColor = selectedSwatch ? selectedSwatch.dataset.color : DEFAULT_PLAYER_COLOR;

    swatches.forEach(swatch => {
        swatch.classList.toggle("selected", swatch.dataset.color === selectedColor);
    });

    localStorage.setItem(STORAGE_KEYS.color, selectedColor);
}

function getPlayerOptions() {
    return {
        color: selectedColor || DEFAULT_PLAYER_COLOR,
        difficulty: selectedDifficulty || "medium",
        name: playerNameInput.value.trim() || "Jogador"
    };
}

function selectDifficulty(difficulty) {
    selectedDifficulty = difficulty;
    difficultyRow.querySelectorAll(".diff-btn").forEach(button => {
        button.classList.remove("active-easy", "active-medium", "active-hard");
        if (button.dataset.diff === difficulty) {
            button.classList.add(`active-${difficulty}`);
        }
    });
}

function beginAutoStartAttempt() {
    cancelAutoStartAttempt();

    const attempt = {
        id: ++nextAutoStartId,
        roomRequested: false
    };

    pendingAutoStart = attempt;
    startAutoStartTimer(attempt, "Tempo esgotado ao conectar ao servidor.");

    return attempt;
}

function startPublicGame() {
    const attempt = beginAutoStartAttempt();

    setMenuBusy(true, "Acessando...");
    gameClient.roomUi.resetActions();

    if (gameClient.socket.connected) {
        requestPublicRoom(attempt);
        return;
    }

    statusMessage.update("Conectando ao servidor...");
    waitForSocketConnection(attempt);
    gameClient.socket.connect();
}

function waitForSocketConnection(attempt) {
    clearPendingSocketConnectWait();

    const onConnect = () => {
        if (!isActiveAutoStartAttempt(attempt)) {
            return;
        }

        requestPublicRoom(attempt);
    };

    const onConnectError = error => {
        if (!isActiveAutoStartAttempt(attempt)) {
            return;
        }

        handleJoinFailure({
            message: error && error.message
                ? `Não foi possível conectar ao servidor: ${error.message}`
                : "Não foi possível conectar ao servidor."
        });
    };

    gameClient.socket.once("connect", onConnect);
    gameClient.socket.once("connect_error", onConnectError);

    pendingSocketConnectCleanup = () => {
        gameClient.socket.off("connect", onConnect);
        gameClient.socket.off("connect_error", onConnectError);
        pendingSocketConnectCleanup = null;
    };
}

function requestPublicRoom(attempt) {
    if (!isActiveAutoStartAttempt(attempt)) {
        return;
    }

    clearPendingSocketConnectWait();
    attempt.roomRequested = true;
    startAutoStartTimer(attempt, "Tempo esgotado ao entrar na sala.");
    statusMessage.update("Criando sala pública...");
    gameClient.roomUi.createRoom({ isPrivate: false, password: "" });
}

function startAutoStartTimer(attempt, message) {
    clearAutoStartTimer();
    pendingAutoStartTimer = setTimeout(() => {
        if (!isActiveAutoStartAttempt(attempt)) {
            return;
        }

        handleJoinFailure({ message });
    }, AUTO_START_TIMEOUT_MS);
}

function handleJoinSuccess() {
    if (pendingAutoStart) {
        finishAutoStartAttempt();
        showGame();
        statusMessage.hide();
        setMenuBusy(false);
        return;
    }

    if (pendingMenuRoomJoin) {
        pendingMenuRoomJoin = false;
        showGame();
        statusMessage.hide();
        setMenuBusy(false);
        return;
    }

    if (!document.body.classList.contains("is-game-active")) {
        gameClient.socket.emit("leaveRoom");
        gameClient.roomUi.clearRoomInfo();
    }

    statusMessage.hide();
    setMenuBusy(false);
}

function handleJoinFailure(result) {
    pendingMenuRoomJoin = false;

    if (!pendingAutoStart) {
        return;
    }

    finishAutoStartAttempt();
    gameClient.roomUi.resetActions();
    showMenu();
    statusMessage.update(result && result.message ? result.message : "Erro ao entrar na sala.");
    setMenuBusy(false);
}

function isActiveAutoStartAttempt(attempt) {
    return pendingAutoStart !== null && pendingAutoStart.id === attempt.id;
}

function finishAutoStartAttempt() {
    pendingAutoStart = null;
    clearAutoStartTimer();
    clearPendingSocketConnectWait();
}

function cancelAutoStartAttempt() {
    pendingAutoStart = null;
    pendingMenuRoomJoin = false;
    clearAutoStartTimer();
    clearPendingSocketConnectWait();
}

function handleRoomJoinStart() {
    pendingMenuRoomJoin = !pendingAutoStart && document.body.classList.contains("is-menu-active");
}

function clearAutoStartTimer() {
    if (!pendingAutoStartTimer) {
        return;
    }

    clearTimeout(pendingAutoStartTimer);
    pendingAutoStartTimer = null;
}

function clearPendingSocketConnectWait() {
    if (typeof pendingSocketConnectCleanup !== "function") {
        return;
    }

    pendingSocketConnectCleanup();
}

function ensureSocketConnection() {
    if (!gameClient || gameClient.socket.connected) {
        return;
    }

    gameClient.socket.connect();
}

function showGame() {
    menuBackground?.stop();
    hideGameOver();
    closeAllOverlays();
    document.body.classList.remove("is-menu-active");
    document.body.classList.add("is-game-active");
    mainMenu.setAttribute("aria-hidden", "true");
    gameLayer.setAttribute("aria-hidden", "false");
}

function showMenu() {
    hideGameOver();
    closeAllOverlays();
    document.body.classList.remove("is-game-active");
    document.body.classList.add("is-menu-active");
    mainMenu.setAttribute("aria-hidden", "false");
    gameLayer.setAttribute("aria-hidden", "true");
    statusMessage.hide();
    setMenuBusy(false);
    menuBackground?.start();
}

function showGameOver(data = {}) {
    cancelAutoStartAttempt();
    menuBackground?.stop();
    setMenuBusy(false);
    statusMessage.hide();
    gameClient.roomUi.clearRoomInfo();

    const eliminatedBy = typeof data.eliminatedBy === "string" ? data.eliminatedBy.trim() : "";
    if (data.reason === "victory") {
        if (gameOverTitle) gameOverTitle.textContent = "Vitória";
        gameOverMessage.textContent = "Você dominou 100% do mapa.";
    } else if (data.reason === "selfTrail") {
        if (gameOverTitle) gameOverTitle.textContent = "Fim de jogo";
        gameOverMessage.textContent = "Você cruzou seu próprio rastro e perdeu a última vida.";
    } else if (data.reason === "captured") {
        if (gameOverTitle) gameOverTitle.textContent = "Fim de jogo";
        gameOverMessage.textContent = eliminatedBy
            ? `Você foi englobado pela captura de ${eliminatedBy} e ficou sem vidas.`
            : "Você foi englobado por uma captura e ficou sem vidas.";
    } else if (data.reason === "noRespawnSpace") {
        if (gameOverTitle) gameOverTitle.textContent = "Fim de jogo";
        gameOverMessage.textContent = "Seu território não tinha espaço suficiente para respawn.";
    } else if (eliminatedBy) {
        if (gameOverTitle) gameOverTitle.textContent = "Fim de jogo";
        gameOverMessage.textContent = `Suas vidas acabaram. Você foi eliminado por ${eliminatedBy}.`;
    } else {
        if (gameOverTitle) gameOverTitle.textContent = "Fim de jogo";
        gameOverMessage.textContent = "Suas vidas acabaram.";
    }

    document.body.classList.remove("is-menu-active");
    document.body.classList.add("is-game-active");
    mainMenu.setAttribute("aria-hidden", "true");
    gameLayer.setAttribute("aria-hidden", "false");
    gameOverPanel?.classList.add("is-open");
    gameOverPanel?.setAttribute("aria-hidden", "false");
    gameOverReturnButton?.focus();
}

function hideGameOver() {
    if (!gameOverPanel) {
        return;
    }

    gameOverPanel.classList.remove("is-open");
    gameOverPanel.setAttribute("aria-hidden", "true");
}

function setMenuBusy(isBusy, label = "Acessando...") {
    playButton.disabled = isBusy;
    if (findRoomMenuButton) findRoomMenuButton.disabled = isBusy;
    if (createRoomMenuButton) createRoomMenuButton.disabled = isBusy;
    playButton.textContent = isBusy ? label : PLAY_BUTTON_IDLE_LABEL;
}

function openOverlay(overlayId) {
    gameClient?.roomUi.closeModal();
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
}

function closeOverlay(overlayId) {
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
}

function closeAllOverlays() {
    gameClient?.roomUi.closeModal();
    document.querySelectorAll(".overlay.open").forEach(overlay => {
        overlay.classList.remove("open");
        overlay.setAttribute("aria-hidden", "true");
    });
}

function createStatusMessage() {
    const container = document.createElement("div");
    container.className = "status-message";
    document.body.appendChild(container);

    return {
        hide() {
            container.style.display = "none";
        },
        update(message) {
            container.textContent = message;
            container.style.display = "block";
        }
    };
}
