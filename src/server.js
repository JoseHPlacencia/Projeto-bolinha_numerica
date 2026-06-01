const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const config = require("./config/gameConfig");
const registerSocket = require("./core/socketHandler");
const startGameLoop = require("./core/gameLoop");
const startSnapshotLoop = require("./core/snapshotLoop");
const { createTerritories } = require("./state/territories");
<<<<<<< HEAD
=======
const { initNumbers } = require("./systems/numberSystem");
>>>>>>> 70aca42 (teste)

const app = express();
const server = http.createServer(app);
const io = new Server(server, createSocketOptions());
const players = new Map();
const territories = createTerritories();
const publicPath = path.join(__dirname, "..", "public");
const sharedMathPath = path.join(__dirname, "utils", "math.js");

app.get("/game-config", (_request, response) => {
    response.json(config.client);
});

app.get("/shared/math.js", (_request, response) => {
    response.type("application/javascript");
    response.sendFile(sharedMathPath);
});

app.use(express.static(publicPath));

registerSocket(io, players, territories);
<<<<<<< HEAD
startGameLoop(players, territories);
=======

// Inicializa números no mapa (sem jogadores ainda)
initNumbers(config.world.mapRadius, players);

startGameLoop(players, territories, io);
>>>>>>> 70aca42 (teste)
startSnapshotLoop(io, players, territories);

const host = process.env.HOST;

if (host) {
    server.listen(config.server.port, host, logServerStart);
} else {
    server.listen(config.server.port, logServerStart);
}

<<<<<<< HEAD
module.exports = {
    app,
    io,
    server
};
=======
module.exports = { app, io, server };
>>>>>>> 70aca42 (teste)

function createSocketOptions() {
    return {
        ...config.socket,
        transports: [...config.socket.transports]
    };
}

function logServerStart() {
    console.log(`Server running at http://localhost:${config.server.port}`);
}
