const MULTIPLIER_VALUES = Object.freeze([0.5, 0.75, 1, 1.5, 2]);
const LIVES_VALUES = Object.freeze([1, 2, 3, 4, 5]);
const DEFAULT_MAX_PLAYERS = 16;
const MIN_MAX_PLAYERS = 1;
const MAX_MAX_PLAYERS = 16;

export function createRoomUi(socket, options = {}) {
    const elements = getRoomElements();

    if (!elements.roomCreateModal && !elements.roomFindModal) {
        return createEmptyRoomUi();
    }

    let currentFilter = "all";
    let currentCodeFilter = "";
    let allRooms = [];

    bindRoomModal(elements);
    bindExitButton(socket, elements, options);
    bindPrivateRoomToggle(elements);
    bindCustomOptions(elements, options);
    bindCreateRoom(socket, elements, options);
    bindJoinRoom(socket, elements, options);
    bindLeaveRoom(socket, elements);
    bindRoomFilters(elements, filter => {
        currentFilter = filter;
        renderRoomsList(socket, elements, allRooms, currentFilter, currentCodeFilter, options);
    });
    bindRoomCodeFilter(elements, codeFilter => {
        currentCodeFilter = codeFilter;
        renderRoomsList(socket, elements, allRooms, currentFilter, currentCodeFilter, options);
    });
    bindRoomCodeCopy(elements);
    bindPasswordPopup(socket, elements, options);
    bindDetailsPopup(elements);

    socket.on("roomsList", rooms => {
        allRooms = Array.isArray(rooms) ? rooms : [];
        renderRoomsList(socket, elements, allRooms, currentFilter, currentCodeFilter, options);
        if (typeof options.onRoomsList === "function") {
            options.onRoomsList(allRooms);
        }
    });

    socket.on("joinRoomResult", result => {
        setJoiningState(elements);

        if (result && result.success) {
            setStatus(elements, `Entrou na sala: ${result.roomCode}`);
            showRoomInfo(elements, result.roomCode);
            resetRoomForm(elements, options);
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
        openCreateModal: () => openCreateModal(elements, options),
        openFindModal: () => openFindModal(socket, elements),
        openModal: () => openFindModal(socket, elements),
        quickMatch: () => quickMatch(socket, elements, options),
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
        quickMatch() {},
        resetActions() {}
    };
}

function getRoomElements() {
    return {
        closeCreateRoomButton: document.getElementById("closeCreateRoomButton"),
        closeFindRoomButton: document.getElementById("closeFindRoomButton"),
        closeRoomDetailsButton: document.getElementById("closeRoomDetailsButton"),
        closeRoomPasswordButton: document.getElementById("closeRoomPasswordButton"),
        confirmRoomPasswordButton: document.getElementById("confirmRoomPasswordButton"),
        createPasswordLabel: document.querySelector("label[for='roomCreatePasswordInput']"),
        createRoomButton: document.getElementById("createRoomButton"),
        customOptionsPanel: document.getElementById("customOptionsPanel"),
        exitGameButton: document.getElementById("exitGameButton"),
        filterAllBtn: document.getElementById("filterAllBtn"),
        filterPrivateBtn: document.getElementById("filterPrivateBtn"),
        filterPublicBtn: document.getElementById("filterPublicBtn"),
        gameRoomCodeDisplay: document.getElementById("gameRoomCodeDisplay"),
        gameRoomCodePanel: document.getElementById("gameRoomCodePanel"),
        joinRoomButton: document.getElementById("joinRoomButton"),
        leaveRoomButton: document.getElementById("leaveRoomButton"),
        privateRoomCheckbox: document.getElementById("privateRoomCheckbox"),
        roomAllowBotsCheckbox: document.getElementById("roomAllowBotsCheckbox"),
        roomCodeDisplay: document.getElementById("roomCodeDisplay"),
        roomCodeCopyStatus: document.getElementById("roomCodeCopyStatus"),
        roomCodeFilterInput: document.getElementById("roomCodeFilterInput"),
        roomCodeInput: document.getElementById("roomCodeInput"),
        roomCreatePasswordInput: document.getElementById("roomCreatePasswordInput"),
        roomCreateModal: document.getElementById("roomCreateModal"),
        roomCreateStatus: document.getElementById("roomCreateStatus"),
        roomDetailsBody: document.getElementById("roomDetailsBody"),
        roomDetailsModal: document.getElementById("roomDetailsModal"),
        roomDetailsTitle: document.getElementById("roomDetailsTitle"),
        roomFindModal: document.getElementById("roomFindModal"),
        roomFindStatus: document.getElementById("roomFindStatus"),
        roomInfo: document.getElementById("roomInfo"),
        roomJoinPasswordInput: document.getElementById("roomJoinPasswordInput"),
        roomMaxPlayersInput: document.getElementById("roomMaxPlayersInput"),
        roomMenuButton: document.getElementById("roomMenuButton"),
        roomPasswordModal: document.getElementById("roomPasswordModal"),
        roomPasswordPopupInput: document.getElementById("roomPasswordPopupInput"),
        roomPasswordPrompt: document.getElementById("roomPasswordPrompt"),
        roomsList: document.getElementById("roomsList"),
        toggleCustomOptionsButton: document.getElementById("toggleCustomOptionsButton"),
        copyRoomCodeButton: document.getElementById("copyRoomCodeButton")
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
            if (event.target !== modal) {
                return;
            }

            if (modal.classList.contains("room-modal--nested")) {
                closeNestedModal(modal);
                return;
            }

            closeModal(elements);
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
        clearRoomInfo(elements);
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

function bindCustomOptions(elements, options) {
    if (elements.toggleCustomOptionsButton && elements.customOptionsPanel) {
        elements.toggleCustomOptionsButton.addEventListener("click", () => {
            const isHidden = elements.customOptionsPanel.classList.toggle("hidden");
            elements.customOptionsPanel.setAttribute("aria-hidden", isHidden ? "true" : "false");
            if (!isHidden) {
                syncLivesDefault(elements, options);
            }
        });
    }

    getCustomOptionSliders(elements).forEach(label => {
        const input = label.querySelector("input[type='range']");
        if (!input) return;
        input.addEventListener("input", () => updateSliderValue(label));
        updateSliderValue(label);
    });
}

function bindCreateRoom(socket, elements, options) {
    if (!elements.createRoomButton) return;

    elements.createRoomButton.addEventListener("click", () => {
        const customOptions = getCustomOptions(elements, options);

        if (!isValidMaxPlayers(customOptions.maxPlayers)) {
            setStatus(
                elements,
                `A quantidade de jogadores deve ser um número inteiro de ${MIN_MAX_PLAYERS} a ${MAX_MAX_PLAYERS}.`,
                true
            );
            elements.roomMaxPlayersInput?.focus();
            elements.roomMaxPlayersInput?.reportValidity();
            return;
        }

        createRoom(socket, elements, {
            customOptions,
            isPrivate: elements.privateRoomCheckbox.checked,
            password: elements.roomCreatePasswordInput.value.trim()
        }, options);
    });
}

function bindJoinRoom(socket, elements, options) {
    if (!elements.joinRoomButton) return;

    elements.joinRoomButton.addEventListener("click", () => {
        joinRoom(socket, elements, {
            password: elements.roomJoinPasswordInput ? elements.roomJoinPasswordInput.value.trim() : "",
            roomCode: elements.roomCodeInput ? elements.roomCodeInput.value.trim().toUpperCase() : ""
        }, options);
    });
}

function bindLeaveRoom(socket, elements) {
    if (!elements.leaveRoomButton) return;

    elements.leaveRoomButton.addEventListener("click", () => {
        socket.emit("leaveRoom");
        clearRoomInfo(elements);
        setStatus(elements, "Saiu da sala.");
    });
}

function bindRoomCodeCopy(elements) {
    if (!elements.copyRoomCodeButton) {
        return;
    }

    elements.copyRoomCodeButton.addEventListener("click", async () => {
        const roomCode = String(elements.gameRoomCodeDisplay && elements.gameRoomCodeDisplay.textContent || "").trim();

        if (!roomCode) {
            return;
        }

        const copied = await copyTextToClipboard(roomCode);
        const message = copied
            ? `Código ${roomCode} copiado.`
            : "Não foi possível copiar o código.";

        if (elements.roomCodeCopyStatus) {
            elements.roomCodeCopyStatus.textContent = message;
        }

        elements.copyRoomCodeButton.classList.toggle("is-copied", copied);
        elements.copyRoomCodeButton.setAttribute(
            "aria-label",
            copied ? "Código copiado" : "Copiar código da sala"
        );

        window.setTimeout(() => {
            elements.copyRoomCodeButton.classList.remove("is-copied");
            elements.copyRoomCodeButton.setAttribute("aria-label", "Copiar código da sala");
        }, 1400);
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

function bindRoomCodeFilter(elements, onCodeFilterChange) {
    if (!elements.roomCodeFilterInput) return;

    elements.roomCodeFilterInput.addEventListener("input", () => {
        const code = elements.roomCodeFilterInput.value.trim().toUpperCase();
        elements.roomCodeFilterInput.value = code;
        onCodeFilterChange(code);
    });
}

function bindPasswordPopup(socket, elements, options) {
    if (elements.closeRoomPasswordButton) {
        elements.closeRoomPasswordButton.addEventListener("click", () => closePasswordPopup(elements));
    }

    if (elements.confirmRoomPasswordButton) {
        elements.confirmRoomPasswordButton.addEventListener("click", () => {
            const roomCode = elements.roomPasswordModal && elements.roomPasswordModal.dataset.roomCode;

            if (!roomCode) {
                return;
            }

            joinRoom(socket, elements, {
                password: elements.roomPasswordPopupInput ? elements.roomPasswordPopupInput.value.trim() : "",
                roomCode
            }, options);
        });
    }

    if (elements.roomPasswordPopupInput) {
        elements.roomPasswordPopupInput.addEventListener("keydown", event => {
            if (event.key === "Enter" && elements.confirmRoomPasswordButton) {
                elements.confirmRoomPasswordButton.click();
            }
        });
    }
}

function bindDetailsPopup(elements) {
    if (elements.closeRoomDetailsButton) {
        elements.closeRoomDetailsButton.addEventListener("click", () => {
            closeNestedModal(elements.roomDetailsModal);
        });
    }
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

    if (roomOptions.customOptions
        && roomOptions.customOptions.maxPlayers !== undefined
        && !isValidMaxPlayers(roomOptions.customOptions.maxPlayers)) {
        setStatus(
            elements,
            `A quantidade de jogadores deve ser um número inteiro de ${MIN_MAX_PLAYERS} a ${MAX_MAX_PLAYERS}.`,
            true
        );
        return;
    }

    setStatus(elements, "Criando sala...");
    if (elements.createRoomButton) {
        elements.createRoomButton.disabled = true;
    }
    const playerOpts = typeof options.getPlayerOptions === "function" ? options.getPlayerOptions() : {};
    requestFullscreen(options);
    requestGameplayReady(options, () => {
        notifyJoinStart(options);
        socket.emit("joinRoom", {
            createNewRoom: true,
            customOptions: roomOptions.customOptions || {},
            difficulty: playerOpts.difficulty || "medium",
            isPrivate,
            password,
            ...createPlayerPayload(options)
        });
    });
}

function quickMatch(socket, elements, options = {}) {
    const playerOptions = typeof options.getPlayerOptions === "function"
        ? options.getPlayerOptions()
        : {};

    setStatus(elements, "Procurando partida pública...");
    requestGameplayReady(options, () => {
        notifyJoinStart(options);
        socket.emit("joinRoom", {
            difficulty: playerOptions.difficulty || "medium",
            quickMatch: true,
            ...createPlayerPayload(options)
        });
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
        setStatus(elements, "Informe o codigo da sala.", true);
        return;
    }

    setStatus(elements, "Entrando na sala...");
    setJoiningState(elements, true);
    requestFullscreen(options);
    requestGameplayReady(options, () => {
        notifyJoinStart(options);
        socket.emit("joinRoom", {
            roomCode,
            password,
            ...createPlayerPayload(options)
        });
    });
}

function requestFullscreen(options) {
    if (typeof options.requestFullscreen === "function") {
        options.requestFullscreen();
    }
}

function requestGameplayReady(options, callback) {
    if (typeof options.requestGameplayReady === "function") {
        options.requestGameplayReady(callback);
        return;
    }

    callback();
}

function renderRoomsList(socket, elements, rooms, currentFilter, currentCodeFilter, options = {}) {
    if (!elements.roomsList) {
        return;
    }

    const filteredRooms = rooms.filter(room => {
        if (currentFilter === "public" && room.isPrivate) return false;
        if (currentFilter === "private" && !room.isPrivate) return false;
        if (currentCodeFilter && !String(room.code || "").includes(currentCodeFilter)) return false;
        return true;
    });

    if (filteredRooms.length === 0) {
        elements.roomsList.innerHTML = `<li class="rooms-list__empty">Nenhuma sala encontrada.</li>`;
        return;
    }

    elements.roomsList.innerHTML = filteredRooms.map(room => {
        const maxPlayers = Number.isInteger(room.maxPlayers)
            ? room.maxPlayers
            : DEFAULT_MAX_PLAYERS;
        const isFull = room.playerCount >= maxPlayers;

        return `
        <li class="rooms-list__item">
            <span class="rooms-list__title">
                <strong>${escapeHtml(room.code)}</strong>
                ${room.isPrivate ? '<span class="rooms-list__lock" aria-label="Sala privada">Privada</span>' : '<span class="rooms-list__lock">Publica</span>'}
                <small>${room.playerCount}/${maxPlayers} jogador${maxPlayers !== 1 ? "es" : ""}${room.botCount ? ` + ${room.botCount} bot${room.botCount !== 1 ? "s" : ""}` : ""}</small>
            </span>
            <span class="rooms-list__actions">
                <button class="room-icon-button rooms-list__details" data-info-code="${escapeAttribute(room.code)}" type="button" aria-label="Ver propriedades da sala">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                </button>
                <button class="room-button rooms-list__join" data-code="${escapeAttribute(room.code)}" data-private="${room.isPrivate ? "1" : "0"}" type="button"${isFull ? " disabled" : ""}>${isFull ? "Cheia" : "Entrar"}</button>
            </span>
        </li>
    `;
    }).join("");

    elements.roomsList.querySelectorAll("[data-info-code]").forEach(button => {
        button.addEventListener("click", () => {
            const room = filteredRooms.find(item => item.code === button.dataset.infoCode);
            openRoomDetails(elements, room);
        });
    });

    elements.roomsList.querySelectorAll("[data-code]").forEach(button => {
        button.addEventListener("click", () => {
            setStatus(elements, "");

            if (button.dataset.private === "1") {
                openPasswordPopup(elements, button.dataset.code);
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

function getCustomOptions(elements, options = {}) {
    const customOptions = {};

    syncLivesDefault(elements, options);

    getCustomOptionSliders(elements).forEach(label => {
        const input = label.querySelector("input[type='range']");
        const optionId = label.dataset.option;
        const type = label.dataset.type;

        if (!input || !optionId) {
            return;
        }

        customOptions[optionId] = type === "lives"
            ? LIVES_VALUES[getSliderIndex(input)]
            : MULTIPLIER_VALUES[getSliderIndex(input)];
    });

    if (!Number.isInteger(customOptions.lives)) {
        customOptions.lives = getDefaultLives(options);
    }

    customOptions.maxPlayers = Number(elements.roomMaxPlayersInput?.value);
    customOptions.allowBots = Boolean(elements.roomAllowBotsCheckbox?.checked);

    return customOptions;
}

function isValidMaxPlayers(value) {
    return Number.isInteger(value)
        && value >= MIN_MAX_PLAYERS
        && value <= MAX_MAX_PLAYERS;
}

function getCustomOptionSliders(elements) {
    return elements.customOptionsPanel
        ? [...elements.customOptionsPanel.querySelectorAll(".room-slider")]
        : [];
}

function updateSliderValue(label) {
    const input = label.querySelector("input[type='range']");
    const valueNode = label.querySelector("[data-value]");
    const type = label.dataset.type;

    if (!input || !valueNode) {
        return;
    }

    const index = getSliderIndex(input);
    valueNode.textContent = type === "lives"
        ? String(LIVES_VALUES[index])
        : formatMultiplier(MULTIPLIER_VALUES[index]);
}

function syncLivesDefault(elements, options = {}) {
    const livesLabel = elements.customOptionsPanel
        ? elements.customOptionsPanel.querySelector("[data-option='lives']")
        : null;
    const input = livesLabel ? livesLabel.querySelector("input[type='range']") : null;

    if (!input || input.dataset.touched === "1") {
        return;
    }

    const defaultLives = getDefaultLives(options);
    input.value = String(Math.max(0, LIVES_VALUES.indexOf(defaultLives)));
    updateSliderValue(livesLabel);

    input.addEventListener("input", () => {
        input.dataset.touched = "1";
    }, { once: true });
}

function getDefaultLives(options = {}) {
    const playerOptions = typeof options.getPlayerOptions === "function"
        ? options.getPlayerOptions()
        : {};
    const difficulty = playerOptions && playerOptions.difficulty || "medium";
    const livesByDifficulty = options.gameConfig
        && options.gameConfig.gameMode
        && options.gameConfig.gameMode.catch
        && options.gameConfig.gameMode.catch.livesByDifficulty;
    const lives = livesByDifficulty && livesByDifficulty[difficulty];

    return Number.isInteger(lives) ? lives : 2;
}

function getSliderIndex(input) {
    return Math.max(0, Math.min(4, Math.round(Number(input.value) || 0)));
}

function formatMultiplier(value) {
    return `${String(value).replace(".", ",")}x`;
}

function resetRoomForm(elements, options = {}) {
    if (elements.roomCodeInput) elements.roomCodeInput.value = "";
    if (elements.roomCodeFilterInput) elements.roomCodeFilterInput.value = "";
    if (elements.roomJoinPasswordInput) elements.roomJoinPasswordInput.value = "";
    if (elements.roomPasswordPopupInput) elements.roomPasswordPopupInput.value = "";
    if (elements.roomCreatePasswordInput) elements.roomCreatePasswordInput.value = "";
    if (elements.privateRoomCheckbox) elements.privateRoomCheckbox.checked = false;
    resetCustomOptions(elements, options);
    togglePrivatePassword(elements, false);
}

function resetCustomOptions(elements, options = {}) {
    getCustomOptionSliders(elements).forEach(label => {
        const input = label.querySelector("input[type='range']");
        if (!input) return;

        input.value = label.dataset.type === "lives"
            ? String(Math.max(0, LIVES_VALUES.indexOf(getDefaultLives(options))))
            : "2";
        delete input.dataset.touched;
        updateSliderValue(label);
    });

    if (elements.roomMaxPlayersInput) {
        elements.roomMaxPlayersInput.value = String(DEFAULT_MAX_PLAYERS);
    }

    if (elements.roomAllowBotsCheckbox) {
        elements.roomAllowBotsCheckbox.checked = true;
    }

    if (elements.customOptionsPanel) {
        elements.customOptionsPanel.classList.add("hidden");
        elements.customOptionsPanel.setAttribute("aria-hidden", "true");
    }
}

function togglePrivatePassword(elements, isPrivate) {
    if (elements.roomCreatePasswordInput) {
        elements.roomCreatePasswordInput.classList.toggle("hidden", !isPrivate);
    }

    if (elements.createPasswordLabel) {
        elements.createPasswordLabel.classList.toggle("hidden", !isPrivate);
    }
}

function openPasswordPopup(elements, roomCode) {
    if (!elements.roomPasswordModal) {
        return;
    }

    elements.roomPasswordModal.dataset.roomCode = roomCode;
    if (elements.roomPasswordPrompt) {
        elements.roomPasswordPrompt.textContent = `Informe a senha da sala ${roomCode}.`;
    }
    if (elements.roomPasswordPopupInput) {
        elements.roomPasswordPopupInput.value = "";
    }

    openRoomModal(elements.roomPasswordModal);
    elements.roomPasswordPopupInput?.focus();
}

function closePasswordPopup(elements) {
    if (!elements.roomPasswordModal) {
        return;
    }

    delete elements.roomPasswordModal.dataset.roomCode;
    if (elements.roomPasswordPopupInput) {
        elements.roomPasswordPopupInput.value = "";
    }
    closeNestedModal(elements.roomPasswordModal);
}

function openRoomDetails(elements, room) {
    if (!room || !elements.roomDetailsModal) {
        return;
    }

    if (elements.roomDetailsTitle) {
        elements.roomDetailsTitle.textContent = `Sala ${room.code}`;
    }

    if (elements.roomDetailsBody) {
        elements.roomDetailsBody.innerHTML = createRoomDetailsHtml(room);
    }

    openRoomModal(elements.roomDetailsModal);
}

function createRoomDetailsHtml(room) {
    const settings = room.settings || {};
    const custom = settings.customOptions || {};
    const world = settings.world || {};
    const movement = settings.movement || {};
    const numbers = settings.numbers || {};
    const lives = settings.gameMode && settings.gameMode.catch
        ? settings.gameMode.catch.roomLives
        : custom.lives;
    const maxPlayers = Number.isInteger(room.maxPlayers)
        ? room.maxPlayers
        : custom.maxPlayers || DEFAULT_MAX_PLAYERS;
    const allowBots = typeof room.allowBots === "boolean"
        ? room.allowBots
        : custom.allowBots !== false;

    return `
        <dl class="room-details__list">
            <div><dt>Privacidade</dt><dd>${room.isPrivate ? "Privada" : "Publica"}</dd></div>
            <div><dt>Dificuldade</dt><dd>${formatDifficulty(room.difficulty)}</dd></div>
            <div><dt>Jogadores</dt><dd>${room.playerCount}/${maxPlayers} humanos, ${room.botCount || 0} bots</dd></div>
            <div><dt>Bots</dt><dd>${allowBots ? "Permitidos" : "Desativados"}</dd></div>
            <div><dt>Mapa</dt><dd>${formatNumber(world.mapRadius)} unidades (${formatMultiplier(custom.mapSize || 1)})</dd></div>
            <div><dt>Velocidade</dt><dd>${formatNumber(movement.speed)} u/s (${formatMultiplier(custom.playerSpeed || 1)})</dd></div>
            <div><dt>Números</dt><dd>${numbers.maxNumbers || "-"} no mapa (${formatMultiplier(custom.numberDensity || 1)})</dd></div>
            <div><dt>Respawn</dt><dd>${formatNumber(numbers.respawnDelaySec, 1)}s (${formatMultiplier(custom.numberRespawn || 1)})</dd></div>
            <div><dt>Distribuição</dt><dd>${Math.round((numbers.spawnRadiusRatio || 0) * 100)}% do raio (${formatMultiplier(custom.numberSpread || 1)})</dd></div>
            <div><dt>Tema</dt><dd>${formatMultiplier(custom.themeDuration || 1)} da duração padrão</dd></div>
            <div><dt>Vidas</dt><dd>${lives || "-"}</dd></div>
        </dl>
    `;
}

function formatDifficulty(difficulty) {
    if (difficulty === "easy") return "Fácil";
    if (difficulty === "hard") return "Difícil";
    return "Médio";
}

function formatNumber(value, decimals = 0) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "-";
    }

    return number.toLocaleString("pt-BR", {
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals
    });
}

function setStatus(elements, message, isError = false) {
    for (const statusElement of getStatusElements(elements)) {
        statusElement.textContent = message;
        statusElement.classList.toggle("is-error", isError);
    }
}

function setJoiningState(elements, isJoining) {
    if (elements.joinRoomButton) elements.joinRoomButton.disabled = isJoining;
    if (elements.confirmRoomPasswordButton) elements.confirmRoomPasswordButton.disabled = isJoining;
    elements.roomsList?.querySelectorAll(".rooms-list__join").forEach(button => {
        button.disabled = isJoining;
    });
}

function resetActions(elements) {
    if (elements.createRoomButton) elements.createRoomButton.disabled = false;
    setJoiningState(elements, false);
}

function clearRoomInfo(elements) {
    if (elements.roomInfo) elements.roomInfo.classList.add("hidden");
    if (elements.roomCodeDisplay) elements.roomCodeDisplay.textContent = "";
    if (elements.gameRoomCodePanel) elements.gameRoomCodePanel.hidden = true;
    if (elements.gameRoomCodeDisplay) elements.gameRoomCodeDisplay.textContent = "";
    if (elements.roomCodeCopyStatus) elements.roomCodeCopyStatus.textContent = "";
    if (elements.copyRoomCodeButton) {
        elements.copyRoomCodeButton.classList.remove("is-copied");
        elements.copyRoomCodeButton.setAttribute("aria-label", "Copiar código da sala");
    }
    setStatus(elements, "");
    resetActions(elements);
}

function showRoomInfo(elements, roomCode) {
    const normalizedRoomCode = String(roomCode || "").trim().toUpperCase();

    if (!normalizedRoomCode) {
        clearRoomInfo(elements);
        return;
    }

    if (elements.roomCodeDisplay) {
        elements.roomCodeDisplay.textContent = normalizedRoomCode;
    }

    if (elements.roomInfo) {
        elements.roomInfo.classList.remove("hidden");
    }

    if (elements.gameRoomCodeDisplay) {
        elements.gameRoomCodeDisplay.textContent = normalizedRoomCode;
    }

    if (elements.gameRoomCodePanel) {
        elements.gameRoomCodePanel.hidden = false;
    }
}

async function copyTextToClipboard(value) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch {
            // Continue with the compatibility fallback.
        }
    }

    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.append(textArea);
    textArea.select();

    let copied = false;

    try {
        copied = document.execCommand("copy");
    } catch {
        copied = false;
    }

    textArea.remove();
    return copied;
}

function openCreateModal(elements, options = {}) {
    closeModal(elements);
    resetCustomOptions(elements, options);
    openRoomModal(elements.roomCreateModal);
}

function openFindModal(socket, elements) {
    closeModal(elements);
    openRoomModal(elements.roomFindModal);
    socket.emit("requestRoomsList");
}

function closeModal(elements) {
    for (const modal of getRoomModals(elements)) {
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
    }
}

function closeNestedModal(modal) {
    if (!modal) {
        return;
    }

    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
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
        elements.roomFindModal,
        elements.roomPasswordModal,
        elements.roomDetailsModal
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

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
}
