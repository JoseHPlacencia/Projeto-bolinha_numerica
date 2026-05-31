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
    const roomStatus = document.getElementById("roomStatus");
    const roomInfo = document.getElementById("roomInfo");
    const roomCodeDisplay = document.getElementById("roomCodeDisplay");

    roomMenuButton.addEventListener("click", toggleRoomMenu);
    closeRoomMenuButton.addEventListener("click", hideRoomMenu);
    createRoomButton.addEventListener("click", handleCreateRoom);
    joinRoomButton.addEventListener("click", handleJoinRoom);
    leaveRoomButton.addEventListener("click", handleLeaveRoom);
    roomCodeInput.addEventListener("input", sanitizeRoomCodeInput);

    window.addEventListener("resize", renderer.resizeCanvas);

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
    });

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

    function handleCreateRoom() {
        setRoomStatus("Criando sala...");
        setRoomControlsEnabled(false);
        socket.emit("joinRoom", { createNewRoom: true });
    }

    function handleJoinRoom() {
        const roomCode = roomCodeInput.value.trim().toUpperCase();

        if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
            setRoomStatus("Código inválido. Use 6 caracteres alfanuméricos.", true);
            return;
        }

        setRoomStatus("Entrando na sala...");
        setRoomControlsEnabled(false);
        socket.emit("joinRoom", { createNewRoom: false, roomCode });
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

    function setRoomControlsEnabled(enabled) {
        createRoomButton.disabled = !enabled;
        joinRoomButton.disabled = !enabled;
        leaveRoomButton.disabled = !enabled;
        roomCodeInput.disabled = !enabled;
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
