const config = require("../config/gameConfig");
const { updatePlayers } = require("../systems/movementSystem");
const { updateTrails } = require("../systems/trailSystem");
const { handleNumberCollected } = require("../systems/catchModeSystem");
const { getHighResolutionTime } = require("../utils/time");

function startGameLoop(players, territories, io, roomCode, numberSystem, botManager = null) {
    const intervalMs = 1000 / config.loop.tickRate;
    let previousTime = getHighResolutionTime();

    return setInterval(() => {
        const now = getHighResolutionTime();
        const deltaTime = Math.min((now - previousTime) / 1000, config.loop.maxDeltaTime);
        previousTime = now;

        if (botManager) {
            botManager.update(Date.now());
        }

        updatePlayers(players, deltaTime);
        updateTrails(players, territories, { io, roomCode });

        const result = numberSystem
            ? numberSystem.update(Date.now())
            : { collisions: [], themeChanged: false };

        if (result.collisions.length > 0 && io) {
            for (const col of result.collisions) {
                handleNumberCollected(players, territories, col, { io, roomCode });

                const socket = io.sockets.sockets.get(col.playerId);
                if (socket) {
                    const player = players.get(col.playerId);

                    socket.emit("numberCollected", {
                        display: col.display,
                        value: col.value,
                        sets: col.sets,
                        belongsToTheme: col.belongsToTheme,
                        catchBalance: player ? player.catchBalance : 0,
                        eliminations: player ? player.eliminations : 0,
                        lives: player ? player.lives : 0,
                        maxLives: player ? player.maxLives : 0
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
