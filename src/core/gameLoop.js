const config = require("../config/gameConfig");
const { updatePlayers } = require("../systems/movementSystem");
const { updateTrails } = require("../systems/trailSystem");
const { getHighResolutionTime } = require("../utils/time");

function startGameLoop(players, territories) {
    const intervalMs = 1000 / config.loop.tickRate;
    let previousTime = getHighResolutionTime();

    return setInterval(() => {
        const now = getHighResolutionTime();

        // Cap long frames so a paused process does not teleport players.
        const deltaTime = Math.min((now - previousTime) / 1000, config.loop.maxDeltaTime);
        previousTime = now;

        updatePlayers(players, deltaTime);
        updateTrails(players, territories);
    }, intervalMs);
}

module.exports = startGameLoop;
