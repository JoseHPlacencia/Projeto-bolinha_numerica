import { loadGameConfig } from "./js/config.js";
import { startClient } from "./js/gameClient.js";

initializeClient();

async function initializeClient() {
    try {
        const gameConfig = await loadGameConfig();
        startClient(gameConfig);
    } catch (error) {
        console.error("Failed to start client:", error);
    }
}
