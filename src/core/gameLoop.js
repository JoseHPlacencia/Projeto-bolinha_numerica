const config = require("../config/gameConfig");
const { updatePlayers } = require("../systems/movementSystem");
const { getHighResolutionTime } = require("../utils/time");

function startRoomGameLoop(room) {
    const intervalMs = 1000 / config.loop.tickRate;
    let previousTime = getHighResolutionTime();

    return setInterval(() => {
        const now = getHighResolutionTime();
        const deltaTime = Math.min((now - previousTime) / 1000, config.loop.maxDeltaTime);
        previousTime = now;

        updatePlayers(room.players, deltaTime);
    }, intervalMs);
}

module.exports = {
    startRoomGameLoop
};
