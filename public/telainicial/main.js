const SERVER_ORIGIN = window.location.origin;
const STORAGE_KEYS = {
    name: "bolinhaJogadorNome",
    color: "bolinhaJogadorCor",
    difficulty: "bolinhaDificuldade"
};

const playerNameInput = document.getElementById("player-name");
const colorPicker = document.getElementById("color-picker");
const diffRow = document.querySelector(".diff-row");
const btnPlay = document.getElementById("btn-play");
const btnCriarSala = document.getElementById("btn-criar-sala");
const statusMessage = createStatusMessage();

let selectedColor = "#4a90e2";
let selectedDifficulty = "medium";

initializeScreen();

function initializeScreen() {
    loadPreferences();
    attachColorPicker();
    attachDifficultyButtons();
    attachPlayButton();
    attachCriarSalaButton();
    attachOverlayButtons();
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
    diffRow.addEventListener("click", event => {
        const button = event.target.closest(".diff-btn");
        if (!button) return;
        selectDifficulty(button.dataset.diff);
    });
}

function saveAndRedirect(targetPath) {
    const name = playerNameInput.value.trim() || "Jogador";
    selectedColor ||= "#63d2ff";
    selectedDifficulty ||= "medium";

    localStorage.setItem(STORAGE_KEYS.name, name);
    localStorage.setItem(STORAGE_KEYS.color, selectedColor);
    localStorage.setItem(STORAGE_KEYS.difficulty, selectedDifficulty);

    const targetUrl = new URL(targetPath, SERVER_ORIGIN);
    targetUrl.searchParams.set("playerName", name);
    targetUrl.searchParams.set("playerColor", selectedColor);
    targetUrl.searchParams.set("difficulty", selectedDifficulty);

    window.location.href = targetUrl.href;
}

function attachPlayButton() {
    btnPlay.addEventListener("click", async () => {
        statusMessage.update("Procurando salas disponíveis...");
        btnPlay.disabled = true;
        btnPlay.textContent = "Acessando...";
        
        try {
            // Make request to get available rooms
            const response = await fetch("/api/rooms-list");
            const data = await response.json();
            const rooms = data.rooms || [];
            
            if (rooms.length > 0) {
                // Room available, redirect to game with openRoom flag
                saveAndRedirect("/index.html?openRoom=1");
            } else {
                // No rooms, create one automatically
                saveAndRedirect("/index.html?createRoom=1");
            }
        } catch (error) {
            console.error("Error checking rooms:", error);
            // Fallback: go to game and let user handle it
            saveAndRedirect("/index.html?createRoom=1");
        }
    });
}

function attachCriarSalaButton() {
    if (!btnCriarSala) return;
    btnCriarSala.addEventListener("click", () => {
        statusMessage.update("Abrindo criação de sala...");
        btnCriarSala.disabled = true;
        // Go to game page; the room modal can be opened from there
        saveAndRedirect("/index.html?openRoom=1");
    });
}

function attachOverlayButtons() {
    document.querySelectorAll("[data-close]").forEach(button => {
        button.addEventListener("click", () => {
            const overlayId = button.dataset.close;
            document.getElementById(overlayId)?.classList.remove("open");
        });
    });

    document.getElementById("btn-help")?.addEventListener("click", () => {
        document.getElementById("overlay-help")?.classList.add("open");
    });

    document.getElementById("btn-sobre")?.addEventListener("click", () => {
        document.getElementById("overlay-sobre")?.classList.add("open");
    });

    // Tab navigation inside the help overlay
    document.querySelectorAll(".tab-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            const tabName = pill.dataset.tab;
            document.querySelectorAll(".tab-pill").forEach(p => p.classList.remove("active"));
            document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.remove("active"));
            pill.classList.add("active");
            const panel = document.getElementById(`tab-${tabName}`);
            if (panel) panel.classList.add("active");
        });
    });
}

function selectColor(color) {
    selectedColor = color;
    colorPicker.querySelectorAll(".color-swatch").forEach(swatch => {
        swatch.classList.toggle("selected", swatch.dataset.color === color);
    });
}

function selectDifficulty(difficulty) {
    selectedDifficulty = difficulty;
    diffRow.querySelectorAll(".diff-btn").forEach(button => {
        button.classList.remove("active-easy", "active-medium", "active-hard");
        if (button.dataset.diff === difficulty) {
            button.classList.add(`active-${difficulty}`);
        }
    });
}

function createStatusMessage() {
    const container = document.createElement("div");
    container.className = "status-message";
    container.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:10px 16px;border-radius:999px;background:rgba(0,0,0,0.7);color:#fff;font-size:0.95rem;backdrop-filter:blur(6px);z-index:1000;display:none;";
    document.body.appendChild(container);
    return {
        update(message) {
            container.textContent = message;
            container.style.display = "block";
        },
        hide() {
            container.style.display = "none";
        }
    };
}
