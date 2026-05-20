const SERVER_ORIGIN = "http://localhost:3000";
const SERVER_URL = `${SERVER_ORIGIN}/`;
const STORAGE_KEYS = {
  name: "bolinhaJogadorNome",
  color: "bolinhaJogadorCor",
  difficulty: "bolinhaDificuldade"
};

const playerNameInput = document.getElementById("player-name");
const colorPicker = document.getElementById("color-picker");
const diffRow = document.querySelector(".diff-row");
const btnPlay = document.getElementById("btn-play");
const statusMessage = createStatusMessage();

let selectedColor = "#63d2ff";
let selectedDifficulty = "medium";

initializeScreen();

function initializeScreen() {
  loadPreferences();
  attachColorPicker();
  attachDifficultyButtons();
  attachPlayButton();
  attachOverlayButtons();
}

function loadPreferences() {
  const savedName = localStorage.getItem(STORAGE_KEYS.name);
  const savedColor = localStorage.getItem(STORAGE_KEYS.color);
  const savedDifficulty = localStorage.getItem(STORAGE_KEYS.difficulty);

  if (savedName) {
    playerNameInput.value = savedName;
  }

  if (savedColor) {
    selectColor(savedColor);
  }

  if (savedDifficulty) {
    selectDifficulty(savedDifficulty);
  }
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

function attachPlayButton() {
  btnPlay.addEventListener("click", () => {
    const name = playerNameInput.value.trim() || "Jogador";
    selectedColor ||= "#63d2ff";
    selectedDifficulty ||= "medium";

    localStorage.setItem(STORAGE_KEYS.name, name);
    localStorage.setItem(STORAGE_KEYS.color, selectedColor);
    localStorage.setItem(STORAGE_KEYS.difficulty, selectedDifficulty);

    statusMessage.update("Abrindo servidor do jogo...");
    btnPlay.disabled = true;
    btnPlay.textContent = "Acessando...";

    const targetUrl = new URL(SERVER_ORIGIN);
    targetUrl.searchParams.set("playerName", name);
    targetUrl.searchParams.set("playerColor", selectedColor);
    targetUrl.searchParams.set("difficulty", selectedDifficulty);

    window.location.href = targetUrl.href;
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
