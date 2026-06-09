import { createFrameMonitor, getDebugLevel } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createMinimapRenderer } from "./renderers/minimapRenderer.js";
import { createNumberHud } from "./numberHud.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createWorldRenderer } from "./worldRenderer.js";

const WORKER_MAIN_UPDATE_INTERVAL_MS = 1000 / 15;

export function startClient(gameConfig) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const minimapCanvas = document.getElementById("minimapCanvas");
    const renderer = createWorldRenderer(canvas, gameConfig, {
        onSnapshotCacheInvalid: invalidations => socket.emit("snapshotCacheInvalid", invalidations),
        onSnapshotResync: () => socket.emit("snapshotResync")
    });
    const minimap = createMinimapRenderer(minimapCanvas, gameConfig);
    const snapshots = createSnapshotInterpolator(gameConfig.network, {
        onResyncNeeded: () => socket.emit("snapshotResync")
    });
    const debugLevel = getDebugLevel();
    const hud = createHud({ debugLevel });
    const numberHud = createNumberHud();
    const frameMonitor = createFrameMonitor();
    const isWorkerRenderer = renderer.getDebugState().mode === "worker";
    let myId = null;
    let lastViewportSentAt = 0;
    let lastWorkerMainUpdateAt = Number.NEGATIVE_INFINITY;

    createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles);
    window.addEventListener("resize", resizeCanvases);
    initRoomUI(socket);

    socket.on("connect", () => {
        myId = socket.id;
        renderer.setPlayerId(myId);
        sendViewportState(true);
    });

    // Number system events
    socket.on("numberCollected", data => {
        numberHud.showCollection(data);
    });

    socket.on("gameState", (snapshot, acknowledge) => {
        renderer.processSnapshot(snapshot);
        const applyResult = snapshots.processSnapshot(snapshot);

        // Update number HUD theme
        if (snapshot.numbers && snapshot.numbers.theme) {
            numberHud.updateTheme(snapshot.numbers.theme, snapshot.numbers.themeEndsIn || 0);
        }

        if (typeof acknowledge === "function") {
            acknowledge(createSnapshotAcknowledgement(applyResult));
            return;
        }

        if (applyResult && !applyResult.applied) {
            socket.emit("snapshotCacheInvalid", applyResult.invalidations);
        }
    });

    resizeCanvases();
    render();

    function render() {
        requestAnimationFrame(render);
        const now = performance.now();

        frameMonitor.recordFrame(now);

        if (isWorkerRenderer && !shouldUpdateWorkerMainViews(now)) {
            return;
        }

        const state = snapshots.getRenderState();
        const currentPlayer = state && myId ? state.players[myId] : null;

        hud.update({
            frameStats: {
                frameMs: frameMonitor.getFrameMs(),
                fps: frameMonitor.getFps()
            },
            rendererStats: renderer.getDebugState(),
            snapshotStats: snapshots.getDebugState(),
            playerDebug: currentPlayer && currentPlayer.debug
        });

        if (!state || !myId) {
            minimap.clear();
            return;
        }

        if (!isWorkerRenderer) {
            renderer.renderWorld(state, myId);
        }

        minimap.render(state, myId);
    }

    function shouldUpdateWorkerMainViews(now) {
        if (now - lastWorkerMainUpdateAt < WORKER_MAIN_UPDATE_INTERVAL_MS) {
            return false;
        }
        lastWorkerMainUpdateAt = now;
        return true;
    }

    function resizeCanvases() {
        renderer.resizeCanvas();
        minimap.resizeCanvas();
        sendViewportState(true);
    }

    function sendViewportState(force = false) {
        const now = performance.now();
        const interval = gameConfig.network.viewportReportIntervalMs;
        if (!force && now - lastViewportSentAt < interval) return;
        lastViewportSentAt = now;
        socket.emit("viewport", renderer.getViewportState());
    }

    function createSnapshotAcknowledgement(applyResult) {
        return {
            applied: !applyResult || applyResult.applied !== false,
            invalidations: applyResult && applyResult.invalidations
                ? applyResult.invalidations
                : { playerInfo: [], territories: [], trails: [] }
        };
    }
}

// ─── Room UI ──────────────────────────────────────────────────────────────────

function initRoomUI(socket) {
    const roomMenuButton = document.getElementById("roomMenuButton");
    const exitGameButton = document.getElementById("exitGameButton");
    const roomModal = document.getElementById("roomModal");
    const closeRoomMenuButton = document.getElementById("closeRoomMenuButton");
    const createRoomButton = document.getElementById("createRoomButton");
    const joinRoomButton = document.getElementById("joinRoomButton");
    const leaveRoomButton = document.getElementById("leaveRoomButton");
    const roomCodeInput = document.getElementById("roomCodeInput");
    const roomJoinPasswordInput = document.getElementById("roomJoinPasswordInput");
    const roomCreatePasswordInput = document.getElementById("roomCreatePasswordInput");
    const privateRoomCheckbox = document.getElementById("privateRoomCheckbox");
    const roomStatus = document.getElementById("roomStatus");
    const roomInfo = document.getElementById("roomInfo");
    const roomCodeDisplay = document.getElementById("roomCodeDisplay");
    const roomsListEl = document.getElementById("roomsList");
    const filterAllBtn = document.getElementById("filterAllBtn");
    const filterPublicBtn = document.getElementById("filterPublicBtn");
    const filterPrivateBtn = document.getElementById("filterPrivateBtn");

    if (!roomMenuButton) return; // Room UI not present

    let currentFilter = "all";
    let allRooms = [];

    // Exit game button handler
    if (exitGameButton) {
        exitGameButton.addEventListener("click", () => {
            if (confirm("Tem certeza que deseja sair dessa sala?")) {
                socket.emit("leaveRoom");
                window.location.href = "/telainicial/index.html";
            }
        });
    }

    // Toggle private password field
    privateRoomCheckbox.addEventListener("change", () => {
        const isPrivate = privateRoomCheckbox.checked;
        roomCreatePasswordInput.classList.toggle("hidden", !isPrivate);
        document.querySelector("label[for='roomCreatePasswordInput']").classList.toggle("hidden", !isPrivate);
    });

    roomMenuButton.addEventListener("click", () => {
        roomModal.classList.add("is-open");
        roomModal.setAttribute("aria-hidden", "false");
    });

    closeRoomMenuButton.addEventListener("click", closeModal);

    roomModal.addEventListener("click", e => {
        if (e.target === roomModal) closeModal();
    });

    function closeModal() {
        roomModal.classList.remove("is-open");
        roomModal.setAttribute("aria-hidden", "true");
    }

    createRoomButton.addEventListener("click", () => {
        const isPrivate = privateRoomCheckbox.checked;
        const password = roomCreatePasswordInput.value.trim();

        if (isPrivate && !password) {
            setStatus("Informe uma senha para sala privada.", true);
            return;
        }

        setStatus("Criando sala...");
        createRoomButton.disabled = true;
        socket.emit("joinRoom", { createNewRoom: true, isPrivate, password });
    });

    joinRoomButton.addEventListener("click", () => {
        const code = roomCodeInput.value.trim().toUpperCase();
        const password = roomJoinPasswordInput.value.trim();

        if (!code) {
            setStatus("Informe o código da sala.", true);
            return;
        }

        setStatus("Entrando na sala...");
        joinRoomButton.disabled = true;
        socket.emit("joinRoom", { roomCode: code, password });
    });

    leaveRoomButton.addEventListener("click", () => {
        socket.emit("leaveRoom");
        roomInfo.classList.add("hidden");
        roomCodeDisplay.textContent = "";
        setStatus("Saiu da sala.");
    });

    // Filter buttons
    [filterAllBtn, filterPublicBtn, filterPrivateBtn].forEach(btn => {
        btn.addEventListener("click", () => {
            currentFilter = btn.dataset.filter;
            [filterAllBtn, filterPublicBtn, filterPrivateBtn].forEach(b => b.classList.remove("rooms-filter__badge--active"));
            btn.classList.add("rooms-filter__badge--active");
            renderRoomsList(allRooms);
        });
    });

    socket.on("roomsList", rooms => {
        allRooms = rooms;
        renderRoomsList(rooms);
    });

    socket.on("joinRoomResult", result => {
        createRoomButton.disabled = false;
        joinRoomButton.disabled = false;

        if (result.success) {
            setStatus(`Entrou na sala: ${result.roomCode}`);
            roomCodeDisplay.textContent = result.roomCode;
            roomInfo.classList.remove("hidden");
            roomCodeInput.value = "";
            roomJoinPasswordInput.value = "";
            roomCreatePasswordInput.value = "";
            privateRoomCheckbox.checked = false;
            roomCreatePasswordInput.classList.add("hidden");
            document.querySelector("label[for='roomCreatePasswordInput']").classList.add("hidden");
        } else {
            setStatus(result.message || "Erro ao entrar na sala.", true);
        }
    });

    socket.on("playerLeft", () => {
        // Another player left – list updated by roomsList event
    });

    function setStatus(msg, isError = false) {
        roomStatus.textContent = msg;
        roomStatus.classList.toggle("is-error", isError);
    }

    function renderRoomsList(rooms) {
        const filtered = rooms.filter(r => {
            if (currentFilter === "public") return !r.isPrivate;
            if (currentFilter === "private") return r.isPrivate;
            return true;
        });

        if (filtered.length === 0) {
            roomsListEl.innerHTML = `<li class="rooms-list__empty">Nenhuma sala encontrada.</li>`;
            return;
        }

        roomsListEl.innerHTML = filtered.map(r => `
            <li class="rooms-list__item">
                <span class="rooms-list__title">
                    ${r.code}
                    ${r.isPrivate ? '<span class="rooms-list__lock">🔒</span>' : ""}
                    — ${r.playerCount} jogador${r.playerCount !== 1 ? "es" : ""}
                </span>
                <button class="room-button rooms-list__join" data-code="${r.code}" type="button">Entrar</button>
            </li>
        `).join("");

        roomsListEl.querySelectorAll("[data-code]").forEach(btn => {
            btn.addEventListener("click", () => {
                roomCodeInput.value = btn.dataset.code;
                setStatus("");
            });
        });
    }
}
