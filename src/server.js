const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const config = require("./config/gameConfig");
const registerSocket = require("./core/socketHandler");
const startGameLoop = require("./core/gameLoop");
const startSnapshotLoop = require("./core/snapshotLoop");
const { criarSistemaRooms } = require("./systems/roomSystem");
const { registrarEventosSalas } = require("./core/roomSocketHandler");

const app = express();
const server = http.createServer(app);
const io = new Server(server, createSocketOptions());
const players = new Map();

// Inicializar sistema de salas
const sistemaRooms = criarSistemaRooms(config.rooms);

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

// Registrar eventos de socket (incluindo salas)
registerSocket(io, players, sistemaRooms);
registrarEventosSalas(io, sistemaRooms, players);

startGameLoop(players);
startSnapshotLoop(io, players);

server.listen(config.server.port, () => {
    console.log(`Server running at http://localhost:${config.server.port}`);
});

module.exports = {
    app,
    io,
    server
};

function createSocketOptions() {
    return {
        ...config.socket,
        transports: [...config.socket.transports]
    };
}
