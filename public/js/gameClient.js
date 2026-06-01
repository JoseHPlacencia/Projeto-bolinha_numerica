import { createFrameMonitor, isDebugEnabled } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createCanvasRenderer } from "./renderer.js";

export function startClient(gameConfig) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const renderer = createCanvasRenderer(canvas, gameConfig);
    const snapshots = createSnapshotInterpolator(gameConfig.network);
    const hud = createHud({ debugEnabled: isDebugEnabled() });
    const frameMonitor = createFrameMonitor();
    let myId = null;
    let currentRoomCode = null;

    const inputState = createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles);
    inputState.setEnabled(false);

    const roomMenuButton = document.getElementById("roomMenuButton");
    const roomModal = document.getElementById("roomModal");
    const closeRoomMenuButton = document.getElementById("closeRoomMenuButton");
    const createRoomButton = document.getElementById("createRoomButton");
    const joinRoomButton = document.getElementById("joinRoomButton");
    const leaveRoomButton = document.getElementById("leaveRoomButton");
    const roomCodeInput = document.getElementById("roomCodeInput");
    const privateRoomCheckbox = document.getElementById("privateRoomCheckbox");
    const roomCreatePasswordInput = document.getElementById("roomCreatePasswordInput");
    const roomJoinPasswordInput = document.getElementById("roomJoinPasswordInput");
    const roomStatus = document.getElementById("roomStatus");
    const roomInfo = document.getElementById("roomInfo");
    const roomCodeDisplay = document.getElementById("roomCodeDisplay");
    const roomsList = document.getElementById("roomsList");
    const filterAllBtn = document.getElementById("filterAllBtn");
    const filterPublicBtn = document.getElementById("filterPublicBtn");
    const filterPrivateBtn = document.getElementById("filterPrivateBtn");
    const filterButtons = [filterAllBtn, filterPublicBtn, filterPrivateBtn];

    let currentRoomsData = [];
    let currentFilter = "all";

    roomMenuButton.addEventListener("click", toggleRoomMenu);
    closeRoomMenuButton.addEventListener("click", hideRoomMenu);
    createRoomButton.addEventListener("click", handleCreateRoom);
    joinRoomButton.addEventListener("click", handleJoinRoom);
    leaveRoomButton.addEventListener("click", handleLeaveRoom);
    roomCodeInput.addEventListener("input", sanitizeRoomCodeInput);
    privateRoomCheckbox.addEventListener("change", updateCreatePasswordField);
    roomCreatePasswordInput.addEventListener("input", sanitizePasswordInput);
    roomJoinPasswordInput.addEventListener("input", sanitizePasswordInput);

    filterButtons.forEach(btn => {
        btn.addEventListener("click", handleFilterChange);
    });

    updateCreatePasswordField();

    window.addEventListener("resize", renderer.resizeCanvas);
    window.addEventListener("keydown", handleKeyboardShortcuts);

    socket.on("connect", () => {
        myId = socket.id;
    });

    socket.on("disconnect", () => {
        currentRoomCode = null;
        updateRoomDisplay();
        setRoomStatus("Conexão perdida. Reconecte ou use o menu para entrar em outra sala.");
        openRoomMenu();
        inputState.setEnabled(false);
    });

    socket.on("joinRoomResult", result => {
        if (!result || !result.success) {
            setRoomStatus(result?.message || "Falha ao entrar na sala.", true);
            setRoomControlsEnabled(true);
            return;
        }

        currentRoomCode = result.roomCode;
        updateRoomDisplay();
        hideRoomMenu();
        setRoomStatus("");
        setRoomControlsEnabled(true);
        inputState.setEnabled(true);
        // After joining, request latest rooms list (server also broadcasts)
        socket.emit("listRooms");
    });

    socket.on("roomsList", updateRoomsList);

    socket.on("gameState", snapshots.processSnapshot);

    renderer.resizeCanvas();
    openRoomMenu();
    render();

    function render() {
        requestAnimationFrame(render);
        frameMonitor.recordFrame(performance.now());

        const state = snapshots.getRenderState();

        hud.update({
            frameStats: {
                frameMs: frameMonitor.getFrameMs(),
                fps: frameMonitor.getFps()
            },
            rendererStats: renderer.getDebugState(),
            snapshotStats: snapshots.getDebugState()
        });

        if (!state || !myId) {
            return;
        }

        renderer.renderWorld(state, myId);
    }

    function toggleRoomMenu() {
        if (roomModal.classList.contains("is-open")) {
            hideRoomMenu();
            return;
        }

        openRoomMenu();
    }

    function openRoomMenu() {
        roomModal.classList.add("is-open");
        roomModal.setAttribute("aria-hidden", "false");
        setRoomControlsEnabled(true);
        inputState.setEnabled(false);
    }

    function hideRoomMenu() {
        roomModal.classList.remove("is-open");
        roomModal.setAttribute("aria-hidden", "true");
        if (currentRoomCode) {
            inputState.setEnabled(true);
        }
    }

    function handleKeyboardShortcuts(event) {
        if (event.key !== "Escape") {
            return;
        }

        if (!currentRoomCode) {
            return;
        }

        event.preventDefault();

        if (roomModal.classList.contains("is-open")) {
            hideRoomMenu();
            return;
        }

        openRoomMenu();
    }

    function handleCreateRoom() {
        const roomCode = roomCodeInput.value.trim().toUpperCase();
        const isPrivate = privateRoomCheckbox.checked;
        const password = roomCreatePasswordInput.value.trim();

        if (isPrivate && password.length < gameConfig.rooms.privateRoomPasswordMinLength) {
            setRoomStatus(`A senha deve ter pelo menos ${gameConfig.rooms.privateRoomPasswordMinLength} caracteres.`, true);
            return;
        }

        setRoomStatus("Criando sala...");
        setRoomControlsEnabled(false);
        socket.emit("joinRoom", {
            createNewRoom: true,
            isPrivate,
            password
        });
    }

    function handleJoinRoom() {
        const roomCode = roomCodeInput.value.trim().toUpperCase();
        const password = roomJoinPasswordInput.value.trim();

        if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
            setRoomStatus("Código inválido. Use 6 caracteres alfanuméricos.", true);
            return;
        }

        if (password && password.length < gameConfig.rooms.privateRoomPasswordMinLength) {
            setRoomStatus(`A senha deve ter pelo menos ${gameConfig.rooms.privateRoomPasswordMinLength} caracteres.`, true);
            return;
        }

        setRoomStatus("Entrando na sala...");
        setRoomControlsEnabled(false);
        socket.emit("joinRoom", {
            createNewRoom: false,
            roomCode,
            password
        });
    }

    function handleLeaveRoom() {
        socket.emit("leaveRoom");
        currentRoomCode = null;
        updateRoomDisplay();
        setRoomStatus("Você saiu da sala.");
        openRoomMenu();
    }

    function sanitizeRoomCodeInput() {
        roomCodeInput.value = roomCodeInput.value
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(0, 6);
    }

    function sanitizePasswordInput(event) {
        const input = event.target;
        input.value = String(input.value)
            .replace(/\s/g, "")
            .slice(0, gameConfig.rooms.privateRoomPasswordMaxLength);
    }

    function updateRoomsList(rooms) {
        if (!Array.isArray(rooms) || !roomsList) return;

        currentRoomsData = [...rooms].sort((a, b) => b.playerCount - a.playerCount || a.code.localeCompare(b.code));
        renderFilteredRooms();
    }

    function renderFilteredRooms() {
        roomsList.innerHTML = "";

        const filtered = currentRoomsData.filter(r => {
            if (currentFilter === "public") return !r.isPrivate;
            if (currentFilter === "private") return r.isPrivate;
            return true;
        });

        if (filtered.length === 0) {
            const empty = document.createElement("li");
            empty.className = "rooms-list__empty";
            empty.textContent = currentFilter === "all" ? "Nenhuma sala ativa" : `Nenhuma sala ${currentFilter === "public" ? "pública" : "privada"}`;
            roomsList.appendChild(empty);
            return;
        }

        for (const r of filtered) {
            const li = document.createElement("li");
            li.className = "rooms-list__item";

            const title = document.createElement("span");
            title.textContent = `${r.code} (${r.playerCount})`;
            title.className = "rooms-list__title";

            const lock = document.createElement("span");
            lock.textContent = r.isPrivate ? "🔒" : "🔓";
            lock.className = "rooms-list__lock";

            const joinBtn = document.createElement("button");
            joinBtn.className = "room-button rooms-list__join";
            joinBtn.type = "button";
            joinBtn.textContent = "Entrar";
            joinBtn.addEventListener("click", () => {
                roomCodeInput.value = String(r.code || "");
                roomJoinPasswordInput.value = "";
                if (r.isPrivate) {
                    roomJoinPasswordInput.focus();
                }
                handleJoinRoom();
            });

            li.appendChild(title);
            li.appendChild(lock);
            li.appendChild(joinBtn);
            roomsList.appendChild(li);
        }
    }

    function handleFilterChange(event) {
        const newFilter = event.target.dataset.filter;
        if (newFilter === currentFilter) return;

        currentFilter = newFilter;

        filterButtons.forEach(btn => {
            btn.classList.toggle("rooms-filter__badge--active", btn.dataset.filter === newFilter);
        });

        renderFilteredRooms();
    }

    function updateCreatePasswordField() {
        const isPrivate = privateRoomCheckbox.checked;

        roomCreatePasswordInput.disabled = !isPrivate;
        roomCreatePasswordInput.classList.toggle("hidden", !isPrivate);
        roomCreatePasswordInput.previousElementSibling?.classList.toggle("hidden", !isPrivate);
    }

    function setRoomControlsEnabled(enabled) {
        createRoomButton.disabled = !enabled;
        joinRoomButton.disabled = !enabled;
        leaveRoomButton.disabled = !enabled;
        roomCodeInput.disabled = !enabled;
        privateRoomCheckbox.disabled = !enabled;
        roomCreatePasswordInput.disabled = !enabled || !privateRoomCheckbox.checked;
        roomJoinPasswordInput.disabled = !enabled;
        filterButtons.forEach(btn => {
            btn.disabled = !enabled;
        });
    }

    function setRoomStatus(message, isError = false) {
        roomStatus.textContent = message || "";
        roomStatus.classList.toggle("is-error", Boolean(isError));
    }

    function updateRoomDisplay() {
        if (currentRoomCode) {
            roomInfo.classList.remove("hidden");
            roomCodeDisplay.textContent = currentRoomCode;
            roomMenuButton.textContent = currentRoomCode;
            return;
        }

        roomInfo.classList.add("hidden");
        roomCodeDisplay.textContent = "";
        roomMenuButton.textContent = "Sala";
    }
}
