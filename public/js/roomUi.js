export function createRoomUi(socket, options = {}) {
    const elements = getRoomElements();

    if (!elements.roomCreateModal && !elements.roomFindModal) {
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
        openCreateModal: () => openCreateModal(elements),
        openFindModal: () => openFindModal(elements),
        openModal: () => openFindModal(elements),
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
        openCreateModal() {},
        openFindModal() {},
        openModal() {},
        resetActions() {}
    };
}

function getRoomElements() {
    return {
        closeCreateRoomButton: document.getElementById("closeCreateRoomButton"),
        closeFindRoomButton: document.getElementById("closeFindRoomButton"),
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
        roomCreateModal: document.getElementById("roomCreateModal"),
        roomCreateStatus: document.getElementById("roomCreateStatus"),
        roomFindModal: document.getElementById("roomFindModal"),
        roomFindStatus: document.getElementById("roomFindStatus"),
        roomInfo: document.getElementById("roomInfo"),
        roomJoinPasswordInput: document.getElementById("roomJoinPasswordInput"),
        roomMenuButton: document.getElementById("roomMenuButton"),
        roomsList: document.getElementById("roomsList")
    };
}

function bindRoomModal(elements) {
    if (elements.roomMenuButton) {
        elements.roomMenuButton.addEventListener("click", () => {
            openModal(elements);
        });
    }

    if (elements.closeCreateRoomButton) {
        elements.closeCreateRoomButton.addEventListener("click", () => {
            closeModal(elements);
        });
    }

    if (elements.closeFindRoomButton) {
        elements.closeFindRoomButton.addEventListener("click", () => {
            closeModal(elements);
        });
    }

    for (const modal of getRoomModals(elements)) {
        modal.addEventListener("click", event => {
            if (event.target === modal) {
                closeModal(elements);
            }
        });
    }
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
    if (!elements.privateRoomCheckbox) return;

    elements.privateRoomCheckbox.addEventListener("change", () => {
        togglePrivatePassword(elements, elements.privateRoomCheckbox.checked);
    });
}

function bindCreateRoom(socket, elements, options) {
    if (!elements.createRoomButton) return;

    elements.createRoomButton.addEventListener("click", () => {
        createRoom(socket, elements, {
            isPrivate: elements.privateRoomCheckbox.checked,
            password: elements.roomCreatePasswordInput.value.trim()
        }, options);
    });
}

function bindJoinRoom(socket, elements, options) {
    if (!elements.joinRoomButton) return;

    elements.joinRoomButton.addEventListener("click", () => {
        joinRoom(socket, elements, {
            password: elements.roomJoinPasswordInput.value.trim(),
            roomCode: elements.roomCodeInput.value.trim().toUpperCase()
        }, options);
    });
}

function bindLeaveRoom(socket, elements) {
    if (!elements.leaveRoomButton) return;

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
    ].filter(Boolean);

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
    notifyJoinStart(options);
    const playerOpts = typeof options.getPlayerOptions === "function" ? options.getPlayerOptions() : {};
    socket.emit("joinRoom", {
        createNewRoom: true,
        isPrivate,
        password,
        difficulty: playerOpts.difficulty || "medium",
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
    notifyJoinStart(options);
    socket.emit("joinRoom", {
        roomCode,
        password,
        ...createPlayerPayload(options)
    });
}

function renderRoomsList(socket, elements, rooms, currentFilter, options = {}) {
    if (!elements.roomsList) {
        return;
    }

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
                ${room.botCount ? ` + ${room.botCount} bot${room.botCount !== 1 ? "s" : ""}` : ""}
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

    if (typeof rawPlayer.difficulty === "string") {
        player.difficulty = rawPlayer.difficulty.trim();
    }

    return Object.keys(player).length > 0 ? { player } : {};
}

function resetRoomForm(elements) {
    if (elements.roomCodeInput) elements.roomCodeInput.value = "";
    if (elements.roomJoinPasswordInput) elements.roomJoinPasswordInput.value = "";
    if (elements.roomCreatePasswordInput) elements.roomCreatePasswordInput.value = "";
    if (elements.privateRoomCheckbox) elements.privateRoomCheckbox.checked = false;
    togglePrivatePassword(elements, false);
}

function togglePrivatePassword(elements, isPrivate) {
    if (elements.roomCreatePasswordInput) {
        elements.roomCreatePasswordInput.classList.toggle("hidden", !isPrivate);
    }

    if (elements.createPasswordLabel) {
        elements.createPasswordLabel.classList.toggle("hidden", !isPrivate);
    }
}

function setStatus(elements, message, isError = false) {
    for (const statusElement of getStatusElements(elements)) {
        statusElement.textContent = message;
        statusElement.classList.toggle("is-error", isError);
    }
}

function resetActions(elements) {
    if (elements.createRoomButton) elements.createRoomButton.disabled = false;
    if (elements.joinRoomButton) elements.joinRoomButton.disabled = false;
}

function clearRoomInfo(elements) {
    if (elements.roomInfo) elements.roomInfo.classList.add("hidden");
    if (elements.roomCodeDisplay) elements.roomCodeDisplay.textContent = "";
    setStatus(elements, "");
    resetActions(elements);
}

function openCreateModal(elements) {
    closeModal(elements);
    openRoomModal(elements.roomCreateModal);
}

function openFindModal(elements) {
    closeModal(elements);
    openRoomModal(elements.roomFindModal);
}

function closeModal(elements) {
    for (const modal of getRoomModals(elements)) {
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
    }
}

function openRoomModal(modal) {
    if (!modal) {
        return;
    }

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
}

function getRoomModals(elements) {
    return [
        elements.roomCreateModal,
        elements.roomFindModal
    ].filter(Boolean);
}

function getStatusElements(elements) {
    return [
        elements.roomCreateStatus,
        elements.roomFindStatus
    ].filter(Boolean);
}

function notifyJoinStart(options) {
    if (typeof options.onJoinStart === "function") {
        options.onJoinStart();
    }
}
