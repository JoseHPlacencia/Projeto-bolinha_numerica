import { loadGameConfig } from "./js/config.js";
import { startClient } from "./js/gameClient.js";

initializeClient();

async function initializeClient() {
    try {
        const gameConfig = await loadGameConfig();
        startClient(gameConfig);

        // Auto-open room modal if redirected from tela inicial with openRoom=1
        const params = new URLSearchParams(window.location.search);
        setTimeout(() => {
            const roomModal = document.getElementById("roomModal");
            if (roomModal) {
                if (params.get("openRoom") === "1") {
                    // Just open the modal to let user choose a room
                    roomModal.classList.add("is-open");
                    roomModal.setAttribute("aria-hidden", "false");
                } else if (params.get("createRoom") === "1") {
                    // Open modal and auto-create a room
                    roomModal.classList.add("is-open");
                    roomModal.setAttribute("aria-hidden", "false");
                    // Trigger auto-create after a short delay
                    setTimeout(() => {
                        document.getElementById("createRoomButton")?.click();
                    }, 300);
                }
            }
        }, 300);
    } catch (error) {
        console.error("Failed to start client:", error);
    }
}
