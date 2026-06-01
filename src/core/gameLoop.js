const config = require("../config/gameConfig");
const { updatePlayers } = require("../systems/movementSystem");
const { updateTrails } = require("../systems/trailSystem");
<<<<<<< HEAD
const { getHighResolutionTime } = require("../utils/time");
const numberSystem = require("../systems/numberSystem");

numberSystem.iniciarSistema();

function startGameLoop(players, territories) {
=======
const { updateNumbers } = require("../systems/numberSystem");
const { getHighResolutionTime } = require("../utils/time");

let _io = null;
let _territories = null;

function startGameLoop(players, territories, io) {
    _io = io;
    _territories = territories;
>>>>>>> 70aca42 (teste)
    const intervalMs = 1000 / config.loop.tickRate;
    let previousTime = getHighResolutionTime();

    return setInterval(() => {
        const now = getHighResolutionTime();
<<<<<<< HEAD

        // Cap long frames so a paused process does not teleport players.
=======
>>>>>>> 70aca42 (teste)
        const deltaTime = Math.min((now - previousTime) / 1000, config.loop.maxDeltaTime);
        previousTime = now;

        updatePlayers(players, deltaTime);
        updateTrails(players, territories);
<<<<<<< HEAD
        numberSystem.update();
=======

        const nowMs = Date.now();
        const result = updateNumbers(players, config.world.mapRadius, nowMs);

        // Broadcast colisões e mudança de tema para os clientes envolvidos
        if (result.collisions.length > 0 && _io) {
            for (const col of result.collisions) {
                const socket = _io.sockets.sockets.get(col.playerId);
                if (socket) {
                    socket.emit("numberCollected", {
                        display:       col.display,
                        value:         col.value,
                        sets:          col.sets,
                        belongsToTheme: col.belongsToTheme
                    });
                }
            }
        }

        if (result.themeChanged && _io) {
            _io.emit("themeChanged");
        }
>>>>>>> 70aca42 (teste)
    }, intervalMs);
}

module.exports = startGameLoop;
