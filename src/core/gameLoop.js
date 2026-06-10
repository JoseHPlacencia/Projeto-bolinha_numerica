const config = require("../config/gameConfig");
const { updatePlayers } = require("../systems/movementSystem");
const { updateTrails } = require("../systems/trailSystem");
const { getHighResolutionTime } = require("../utils/time");

function startGameLoop(players, territories, io, roomCode, numberSystem) {
    const intervalMs = 1000 / config.loop.tickRate;
    let previousTime = getHighResolutionTime();

    return setInterval(() => {
        const now = getHighResolutionTime();
        const deltaTime = Math.min((now - previousTime) / 1000, config.loop.maxDeltaTime);
        previousTime = now;

        updatePlayers(players, deltaTime);
        updateTrails(players, territories);

        const result = numberSystem
            ? numberSystem.update(Date.now())
            : { collisions: [], themeChanged: false };

        if (result.collisions.length > 0 && io) {
            for (const col of result.collisions) {
                const socket = io.sockets.sockets.get(col.playerId);
                if (socket) {
                    socket.emit("numberCollected", {
                        display: col.display,
                        value: col.value,
                        sets: col.sets,
                        belongsToTheme: col.belongsToTheme
                    });
                }
            }
        }

        if (result.themeChanged && io && roomCode) {
            io.to(roomCode).emit("themeChanged");
        }
    }, intervalMs);
}

module.exports = { startGameLoop };
