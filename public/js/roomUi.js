export function createRoomUi(socket, options = {}) {
    const elements = getRoomElements();

    if (!elements.roomMenuButton || !elements.roomModal) {
        return createEmptyRoomUi();
    }

    let currentFilter = "all";
    let allRooms = [];

    bindRoomModal(elements);
    bindExitButton(socket, elements, options);
    bindPrivateRoomToggle(elements);
    bindCreateRoom(socket, elements, options);
    bindJoinRoom(socket, elements, options);
    bindLeaveRoom(socket, elements);
    bindRoomFilters(elements, filter => {
        currentFilter = filter;
        renderRoomsList(socket, elements, allRooms, currentFilter, options);
    });

    socket.on("roomsList", rooms => {
        allRooms = Array.isArray(rooms) ? rooms : [];
        renderRoomsList(socket, elements, allRooms, currentFilter, options);
        if (typeof options.onRoomsList === "function") {
            options.onRoomsList(allRooms);
        }
    });

    socket.on("joinRoomResult", result => {
        elements.createRoomButton.disabled = false;
        elements.joinRoomButton.disabled = false;

        if (result && result.success) {
            setStatus(elements, `Entrou na sala: ${result.roomCode}`);
            elements.roomCodeDisplay.textContent = result.roomCode;
            elements.roomInfo.classList.remove("hidden");
            resetRoomForm(elements);
            closeModal(elements);
            if (typeof options.onJoinSuccess === "function") {
                options.onJoinSuccess(result);
            }
            return;
        }

        setStatus(elements, result && result.message ? result.message : "Erro ao entrar na sala.", true);

        if (typeof options.onJoinFailure === "function") {
            options.onJoinFailure(result);
        }
    });

    return {
        clearRoomInfo: () => clearRoomInfo(elements),
        closeModal: () => closeModal(elements),
        createRoom: roomOptions => createRoom(socket, elements, roomOptions, options),
        getRooms: () => [...allRooms],
        joinRoom: roomOptions => joinRoom(socket, elements, roomOptions, options),
        openModal: () => openModal(elements),
        resetActions: () => resetActions(elements)
    };
}

function createEmptyRoomUi() {
    return {
        clearRoomInfo() {},
        closeModal() {},
        createRoom() {},
        getRooms() {
            return [];
        },
        joinRoom() {},
        openModal() {},
        resetActions() {}
    };
}

function getRoomElements() {
    return {
        closeRoomMenuButton: document.getElementById("closeRoomMenuButton"),
        createPasswordLabel: document.querySelector("label[for='roomCreatePasswordInput']"),
        createRoomButton: document.getElementById("createRoomButton"),
        exitGameButton: document.getElementById("exitGameButton"),
        filterAllBtn: document.getElementById("filterAllBtn"),
        filterPrivateBtn: document.getElementById("filterPrivateBtn"),
        filterPublicBtn: document.getElementById("filterPublicBtn"),
        joinRoomButton: document.getElementById("joinRoomButton"),
        leaveRoomButton: document.getElementById("leaveRoomButton"),
        privateRoomCheckbox: document.getElementById("privateRoomCheckbox"),
        roomCodeDisplay: document.getElementById("roomCodeDisplay"),
        roomCodeInput: document.getElementById("roomCodeInput"),
        roomCreatePasswordInput: document.getElementById("roomCreatePasswordInput"),
        roomInfo: document.getElementById("roomInfo"),
        roomJoinPasswordInput: document.getElementById("roomJoinPasswordInput"),
        roomMenuButton: document.getElementById("roomMenuButton"),
        roomModal: document.getElementById("roomModal"),
        roomsList: document.getElementById("roomsList"),
        roomStatus: document.getElementById("roomStatus")
    };
}

function bindRoomModal(elements) {
    elements.roomMenuButton.addEventListener("click", () => {
        openModal(elements);
    });

    elements.closeRoomMenuButton.addEventListener("click", () => {
        closeModal(elements);
    });

    elements.roomModal.addEventListener("click", event => {
        if (event.target === elements.roomModal) {
            closeModal(elements);
        }
    });
}

function bindExitButton(socket, elements, options) {
    if (!elements.exitGameButton) return;

    elements.exitGameButton.addEventListener("click", () => {
        if (!confirm("Tem certeza que deseja sair dessa sala?")) {
            return;
        }

        socket.emit("leaveRoom");
        elements.roomInfo.classList.add("hidden");
        elements.roomCodeDisplay.textContent = "";
        setStatus(elements, "");
        closeModal(elements);

        if (typeof options.onExitGame === "function") {
            options.onExitGame();
        }
    });
}

function bindPrivateRoomToggle(elements) {
    elements.privateRoomCheckbox.addEventListener("change", () => {
        togglePrivatePassword(elements, elements.privateRoomCheckbox.checked);
    });
}

function bindCreateRoom(socket, elements, options) {
    elements.createRoomButton.addEventListener("click", () => {
        createRoom(socket, elements, {
            isPrivate: elements.privateRoomCheckbox.checked,
            password: elements.roomCreatePasswordInput.value.trim()
        }, options);
    });
}

function bindJoinRoom(socket, elements, options) {
    elements.joinRoomButton.addEventListener("click", () => {
        joinRoom(socket, elements, {
            password: elements.roomJoinPasswordInput.value.trim(),
            roomCode: elements.roomCodeInput.value.trim().toUpperCase()
        }, options);
    });
}

function bindLeaveRoom(socket, elements) {
    elements.leaveRoomButton.addEventListener("click", () => {
        socket.emit("leaveRoom");
        elements.roomInfo.classList.add("hidden");
        elements.roomCodeDisplay.textContent = "";
        setStatus(elements, "Saiu da sala.");
    });
}

function bindRoomFilters(elements, onFilterChange) {
    const buttons = [
        elements.filterAllBtn,
        elements.filterPublicBtn,
        elements.filterPrivateBtn
    ];

    buttons.forEach(button => {
        button.addEventListener("click", () => {
            buttons.forEach(item => item.classList.remove("rooms-filter__badge--active"));
            button.classList.add("rooms-filter__badge--active");
            onFilterChange(button.dataset.filter);
        });
    });
}

function createRoom(socket, elements, roomOptions = {}, options = {}) {
    const isPrivate = Boolean(roomOptions.isPrivate);
    const password = typeof roomOptions.password === "string"
        ? roomOptions.password.trim()
        : "";

    if (isPrivate && !password) {
        setStatus(elements, "Informe uma senha para sala privada.", true);
        return;
    }

    setStatus(elements, "Criando sala...");
    elements.createRoomButton.disabled = true;
    socket.emit("joinRoom", {
        createNewRoom: true,
        isPrivate,
        password,
        ...createPlayerPayload(options)
    });
}

function joinRoom(socket, elements, roomOptions = {}, options = {}) {
    const roomCode = typeof roomOptions.roomCode === "string"
        ? roomOptions.roomCode.trim().toUpperCase()
        : "";
    const password = typeof roomOptions.password === "string"
        ? roomOptions.password.trim()
        : "";

    if (!roomCode) {
        setStatus(elements, "Informe o código da sala.", true);
        return;
    }

    setStatus(elements, "Entrando na sala...");
    elements.joinRoomButton.disabled = true;
    socket.emit("joinRoom", {
        roomCode,
        password,
        ...createPlayerPayload(options)
    });
}

function renderRoomsList(socket, elements, rooms, currentFilter, options = {}) {
    const filteredRooms = rooms.filter(room => {
        if (currentFilter === "public") return !room.isPrivate;
        if (currentFilter === "private") return room.isPrivate;
        return true;
    });

    if (filteredRooms.length === 0) {
        elements.roomsList.innerHTML = `<li class="rooms-list__empty">Nenhuma sala encontrada.</li>`;
        return;
    }

    elements.roomsList.innerHTML = filteredRooms.map(room => `
        <li class="rooms-list__item">
            <span class="rooms-list__title">
                ${room.code}
                ${room.isPrivate ? '<span class="rooms-list__lock" aria-label="Sala privada">🔒</span>' : ""}
                &mdash; ${room.playerCount} jogador${room.playerCount !== 1 ? "es" : ""}
            </span>
            <button class="room-button rooms-list__join" data-code="${room.code}" data-private="${room.isPrivate ? "1" : "0"}" type="button">Entrar</button>
        </li>
    `).join("");

    elements.roomsList.querySelectorAll("[data-code]").forEach(button => {
        button.addEventListener("click", () => {
            elements.roomCodeInput.value = button.dataset.code;
            setStatus(elements, "");

            if (button.dataset.private === "1") {
                elements.roomJoinPasswordInput.focus();
                return;
            }

            joinRoom(socket, elements, {
                roomCode: button.dataset.code,
                password: ""
            }, options);
        });
    });
}

function createPlayerPayload(options = {}) {
    if (typeof options.getPlayerOptions !== "function") {
        return {};
    }

    const rawPlayer = options.getPlayerOptions();

    if (!rawPlayer || typeof rawPlayer !== "object") {
        return {};
    }

    const player = {};

    if (typeof rawPlayer.color === "string") {
        player.color = rawPlayer.color.trim();
    }

    if (typeof rawPlayer.name === "string") {
        player.name = rawPlayer.name.trim();
    }

    return Object.keys(player).length > 0 ? { player } : {};
}

function resetRoomForm(elements) {
    elements.roomCodeInput.value = "";
    elements.roomJoinPasswordInput.value = "";
    elements.roomCreatePasswordInput.value = "";
    elements.privateRoomCheckbox.checked = false;
    togglePrivatePassword(elements, false);
}

function togglePrivatePassword(elements, isPrivate) {
    elements.roomCreatePasswordInput.classList.toggle("hidden", !isPrivate);
    elements.createPasswordLabel.classList.toggle("hidden", !isPrivate);
}

function setStatus(elements, message, isError = false) {
    elements.roomStatus.textContent = message;
    elements.roomStatus.classList.toggle("is-error", isError);
}

function resetActions(elements) {
    elements.createRoomButton.disabled = false;
    elements.joinRoomButton.disabled = false;
}

function clearRoomInfo(elements) {
    elements.roomInfo.classList.add("hidden");
    elements.roomCodeDisplay.textContent = "";
    setStatus(elements, "");
    resetActions(elements);
}

function openModal(elements) {
    elements.roomModal.classList.add("is-open");
    elements.roomModal.setAttribute("aria-hidden", "false");
}

function closeModal(elements) {
    elements.roomModal.classList.remove("is-open");
    elements.roomModal.setAttribute("aria-hidden", "true");
}
