const config = require("../config/gameConfig");
const { updatePlayers } = require("../systems/movementSystem");
const { updateTrails } = require("../systems/trailSystem");
const { updateNumbers } = require("../systems/numberSystem");
const { getHighResolutionTime } = require("../utils/time");

// Per-room number state
const roomNumberStates = new Map();

/**
 * Start a game loop for a specific room.
 * Returns the interval handle.
 */
function startGameLoop(players, territories, io, roomCode) {
    const intervalMs = 1000 / config.loop.tickRate;
    let previousTime = getHighResolutionTime();

    // Initialize per-room number state tracking
    roomNumberStates.set(roomCode, { nextId: 1, numbers: new Map(), pending: [], theme: null, themeIdx: 0, themeNextSwitch: 0 });

    return setInterval(() => {
        const now = getHighResolutionTime();
        const deltaTime = Math.min((now - previousTime) / 1000, config.loop.maxDeltaTime);
        previousTime = now;

        updatePlayers(players, deltaTime);
        updateTrails(players, territories);

        // Update number system (uses shared global state per process; rooms share it)
        const nowMs = Date.now();
        const result = updateNumbers(players, config.world.mapRadius, nowMs);

        // Broadcast collisions and theme changes to clients in this room
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
