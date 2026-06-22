import { loadGameConfig } from "./js/config.js";
import { createAnnouncementsPanel } from "./js/announcements.js";
import { startClient } from "./js/gameClient.js";
import { createMenuBackground } from "./js/menuBackground.js";
import {
    DEFAULT_FPS_LIMIT,
    DEFAULT_PERFORMANCE_MODE,
    normalizeFpsLimit
} from "./js/renderSettings.js";
import {
    normalizeVisualTheme,
    VISUAL_THEME_DARK,
    VISUAL_THEME_LIGHT
} from "./js/visualTheme.js";

const STORAGE_KEYS = {
    color: "bolinhaJogadorCor",
    difficulty: "bolinhaDificuldade",
    fpsLimit: "vennperioFpsLimit",
    name: "bolinhaJogadorNome",
    performanceMode: "vennperioPerformanceMode",
    theme: "vennperioVisualTheme"
};

const DEFAULT_PLAYER_COLOR = "#ff2626";
const playerNameInput = document.getElementById("player-name");
const colorPicker = document.getElementById("color-picker");
const difficultyRow = document.querySelector(".diff-row");
const playButton = document.getElementById("btn-play");
const findRoomMenuButton = document.getElementById("btn-encontrar-sala");
const createRoomMenuButton = document.getElementById("btn-criar-sala");
const settingsButton = document.getElementById("btn-settings");
const themeButton = document.getElementById("btn-theme");
const fpsLimitSelect = document.getElementById("fpsLimitSelect");
const performanceModeCheckbox = document.getElementById("performanceModeCheckbox");
const performanceModeHint = document.getElementById("performanceModeHint");
const announcementsPanel = document.getElementById("announcementsPanel");
const mainMenu = document.getElementById("mainMenu");
const gameLayer = document.getElementById("gameLayer");
const gameOverPanel = document.getElementById("gameOverPanel");
const gameOverTitle = document.getElementById("gameOverTitle");
const gameOverMessage = document.getElementById("gameOverMessage");
const gameOverReturnButton = document.getElementById("gameOverReturnButton");
const gameOverSpectateButton = document.getElementById("gameOverSpectateButton");
const spectatorBackButton = document.getElementById("spectatorBackButton");
const statusMessage = createStatusMessage();
const AUTO_START_TIMEOUT_MS = 10000;
const PLAY_BUTTON_IDLE_LABEL = "▶ Partida rápida";
const mobileDeviceQuery = window.matchMedia("(any-pointer: coarse) and (max-width: 1024px)");
const portraitMobileQuery = window.matchMedia("(orientation: portrait) and (any-pointer: coarse)");

let selectedColor = DEFAULT_PLAYER_COLOR;
let selectedDifficulty = "medium";
let selectedFpsLimit = DEFAULT_FPS_LIMIT;
let selectedPerformanceMode = DEFAULT_PERFORMANCE_MODE;
let selectedTheme = normalizeVisualTheme(document.documentElement.dataset.theme);
let activeGameConfig = null;
let announcementsController = null;
let gameClient = null;
let menuBackground = null;
let pendingAutoStart = null;
let pendingAutoStartTimer = null;
let pendingSocketConnectCleanup = null;
let pendingMenuRoomJoin = false;
let pendingOrientationAction = null;
let orientationJoinStartedFromGate = false;
let nextAutoStartId = 0;

initializeClient();

async function initializeClient() {
    try {
        const gameConfig = await loadGameConfig();
        activeGameConfig = gameConfig;
        loadRenderingPreferences();
        applyVisualTheme(selectedTheme, { persist: false, updateClient: false });
        applyRenderingSettings({}, { persist: false, updateClient: false });
        menuBackground = createMenuBackground(gameConfig);
        gameClient = startClient(gameConfig, {
            getPlayerOptions,
            onExitGame: showMenu,
            onGameOver: showGameOver,
            onJoinFailure: handleJoinFailure,
            onJoinStart: handleRoomJoinStart,
            onJoinSuccess: handleJoinSuccess,
            requestFullscreen: requestMobileFullscreen,
            requestGameplayReady
        });

        initializeMenu();
    } catch (error) {
        console.error("Failed to start client:", error);
        statusMessage.update("Erro ao iniciar o jogo.");
    }
}

function initializeMenu() {
    announcementsController = createAnnouncementsPanel(announcementsPanel);
    loadPreferences();
    attachColorPicker();
    attachDifficultyButtons();
    attachPlayButton();
    attachFindRoomButton();
    attachCreateRoomButton();
    attachSettingsControls();
    attachThemeButton();
    attachOverlayButtons();
    attachOrientationGate();
    syncThemeButton();
    syncSettingsControls();
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

function loadRenderingPreferences() {
    const savedFpsLimit = localStorage.getItem(STORAGE_KEYS.fpsLimit);
    const savedPerformanceMode = localStorage.getItem(STORAGE_KEYS.performanceMode);

    selectedFpsLimit = normalizeFpsLimit(
        savedFpsLimit === null ? DEFAULT_FPS_LIMIT : savedFpsLimit
    );
    selectedPerformanceMode = savedPerformanceMode === null
        ? DEFAULT_PERFORMANCE_MODE
        : savedPerformanceMode !== "false";
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
        requestMobileFullscreen();
        savePreferences();
        startPublicGame();
    });
}

function requestMobileFullscreen() {
    if (!mobileDeviceQuery.matches || document.fullscreenElement) {
        return;
    }

    const root = document.documentElement;
    const requestFullscreen = root.requestFullscreen || root.webkitRequestFullscreen;

    if (typeof requestFullscreen !== "function") {
        return;
    }

    try {
        const request = requestFullscreen.call(root, {
            navigationUI: "hide"
        });

        if (request && typeof request.catch === "function") {
            request.catch(() => {});
        }
    } catch {
        // Fullscreen support varies across mobile browsers.
    }
}

function attachThemeButton() {
    if (!themeButton) return;

    themeButton.addEventListener("click", () => {
        const nextTheme = selectedTheme === VISUAL_THEME_DARK
            ? VISUAL_THEME_LIGHT
            : VISUAL_THEME_DARK;

        applyVisualTheme(nextTheme);
    });
}

function attachSettingsControls() {
    settingsButton?.addEventListener("click", () => {
        syncSettingsControls();
        openOverlay("overlay-settings");
    });

    fpsLimitSelect?.addEventListener("change", () => {
        applyRenderingSettings({
            fpsLimit: fpsLimitSelect.value
        });
    });

    performanceModeCheckbox?.addEventListener("change", () => {
        applyRenderingSettings({
            performanceMode: performanceModeCheckbox.checked
        });
    });
}

function applyVisualTheme(theme, options = {}) {
    const {
        persist = true,
        updateClient = true
    } = options;

    selectedTheme = normalizeVisualTheme(theme);
    document.documentElement.dataset.theme = selectedTheme;

    if (activeGameConfig) {
        activeGameConfig.visualTheme = {
            ...(activeGameConfig.visualTheme || {}),
            mode: selectedTheme
        };
    }

    if (updateClient && gameClient && typeof gameClient.setVisualTheme === "function") {
        gameClient.setVisualTheme(selectedTheme);
    }

    if (persist) {
        localStorage.setItem(STORAGE_KEYS.theme, selectedTheme);
    }

    syncThemeButton();
}

function syncThemeButton() {
    if (!themeButton) return;

    const darkModeActive = selectedTheme === VISUAL_THEME_DARK;
    const label = darkModeActive ? "Modo claro" : "Modo escuro";

    themeButton.setAttribute("aria-pressed", String(darkModeActive));
    themeButton.setAttribute("aria-label", darkModeActive
        ? "Ativar modo claro"
        : "Ativar modo escuro");

    const labelElement = themeButton.querySelector("[data-theme-label]");
    if (labelElement) {
        labelElement.textContent = label;
    }
}

function applyRenderingSettings(settings, options = {}) {
    const {
        persist = true,
        updateClient = true
    } = options;

    if (Object.hasOwn(settings, "fpsLimit")) {
        selectedFpsLimit = normalizeFpsLimit(settings.fpsLimit);
    }

    if (Object.hasOwn(settings, "performanceMode")) {
        selectedPerformanceMode = Boolean(settings.performanceMode);
    }

    const renderingSettings = {
        fpsLimit: selectedFpsLimit,
        performanceMode: selectedPerformanceMode
    };

    document.documentElement.dataset.renderQuality = selectedPerformanceMode
        ? "performance"
        : "quality";

    if (activeGameConfig) {
        activeGameConfig.renderingSettings = {
            ...(activeGameConfig.renderingSettings || {}),
            ...renderingSettings
        };
    }

    if (updateClient) {
        gameClient?.setRenderingSettings?.(renderingSettings);
        menuBackground?.setRenderingSettings?.(renderingSettings);
    }

    if (persist) {
        localStorage.setItem(STORAGE_KEYS.fpsLimit, String(selectedFpsLimit));
        localStorage.setItem(STORAGE_KEYS.performanceMode, String(selectedPerformanceMode));
    }

    syncSettingsControls();
}

function syncSettingsControls() {
    if (fpsLimitSelect) {
        fpsLimitSelect.value = String(selectedFpsLimit);
    }

    if (performanceModeCheckbox) {
        performanceModeCheckbox.checked = selectedPerformanceMode;
    }

    if (performanceModeHint) {
        performanceModeHint.textContent = selectedPerformanceMode
            ? "Usa halos simplificados para manter a renderização mais leve."
            : "Ativa halos multicamada mais suaves e intensos, com maior custo gráfico.";
    }
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
    gameOverReturnButton?.addEventListener("click", returnToMenuAfterGame);
    spectatorBackButton?.addEventListener("click", returnToMenuAfterGame);

    gameOverSpectateButton?.addEventListener("click", () => {
        hideGameOver();
        document.body.classList.remove("is-game-ended");
        document.body.classList.add("is-spectating");
        spectatorBackButton.hidden = false;
        spectatorBackButton.focus();
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
    clearAutoStartTimer();
    attempt.roomRequested = true;
    statusMessage.update("Procurando partida pública...");
    gameClient.roomUi.quickMatch();
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
    orientationJoinStartedFromGate = false;

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
    const message = result && result.message ? result.message : "Erro ao entrar na sala.";

    if (orientationJoinStartedFromGate && !pendingAutoStart) {
        orientationJoinStartedFromGate = false;
        gameClient.roomUi.resetActions();
        showMenu();
        statusMessage.update(message);
        setMenuBusy(false);
        return;
    }

    if (!pendingAutoStart) {
        return;
    }

    finishAutoStartAttempt();
    gameClient.roomUi.resetActions();
    showMenu();
    statusMessage.update(message);
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
    if (pendingAutoStart) {
        startAutoStartTimer(pendingAutoStart, "Tempo esgotado ao entrar na sala.");
    }

    pendingMenuRoomJoin = !pendingAutoStart && document.body.classList.contains("is-menu-active");
}

function attachOrientationGate() {
    portraitMobileQuery.addEventListener("change", continuePendingOrientationAction);
}

function requestGameplayReady(action) {
    if (typeof action !== "function") {
        return;
    }

    if (!portraitMobileQuery.matches) {
        action();
        return;
    }

    pendingOrientationAction = action;
    orientationJoinStartedFromGate = true;
    clearAutoStartTimer();
    showGame();
    document.body.classList.add("is-awaiting-orientation");
}

function continuePendingOrientationAction() {
    if (portraitMobileQuery.matches || typeof pendingOrientationAction !== "function") {
        return;
    }

    const action = pendingOrientationAction;
    pendingOrientationAction = null;
    document.body.classList.remove("is-awaiting-orientation");
    action();
}

function cancelPendingOrientationAction() {
    pendingOrientationAction = null;
    orientationJoinStartedFromGate = false;
    document.body.classList.remove("is-awaiting-orientation");
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
    document.body.classList.remove("is-game-ended", "is-menu-active", "is-spectating");
    document.body.classList.add("is-game-active");
    if (spectatorBackButton) spectatorBackButton.hidden = true;
    mainMenu.setAttribute("aria-hidden", "true");
    gameLayer.setAttribute("aria-hidden", "false");
}

function showMenu() {
    cancelPendingOrientationAction();
    hideGameOver();
    closeAllOverlays();
    document.body.classList.remove("is-game-active", "is-game-ended", "is-spectating");
    document.body.classList.add("is-menu-active");
    if (spectatorBackButton) spectatorBackButton.hidden = true;
    mainMenu.setAttribute("aria-hidden", "false");
    gameLayer.setAttribute("aria-hidden", "true");
    statusMessage.hide();
    setMenuBusy(false);
    menuBackground?.start();
    announcementsController?.refresh();
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
    } else if (data.reason === "counterattack") {
        if (gameOverTitle) gameOverTitle.textContent = "Fim de jogo";
        gameOverMessage.textContent = eliminatedBy
            ? `${eliminatedBy} completou uma captura e contra-atacou sua marca.`
            : "Um jogador completou uma captura e contra-atacou sua marca.";
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
    document.body.classList.remove("is-spectating");
    document.body.classList.add("is-game-active", "is-game-ended");
    if (gameOverSpectateButton) {
        gameOverSpectateButton.hidden = data.reason === "victory" || !data.canSpectate;
    }
    if (spectatorBackButton) spectatorBackButton.hidden = true;
    mainMenu.setAttribute("aria-hidden", "true");
    gameLayer.setAttribute("aria-hidden", "false");
    gameOverPanel?.classList.add("is-open");
    gameOverPanel?.setAttribute("aria-hidden", "false");
    gameOverReturnButton?.focus();
}

function returnToMenuAfterGame() {
    gameClient?.leaveCurrentRoom?.();
    hideGameOver();
    showMenu();
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
