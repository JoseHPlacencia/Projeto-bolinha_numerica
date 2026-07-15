const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const config = require("./config/gameConfig");
const registerSocket = require("./core/socketHandler");
const roomManager = require("./core/roomManager");
const { createRoomCoordinator } = require("./core/roomCoordinator");
const {
    getTerritoryDifferenceKernelDiagnostics,
    initializeTerritoryDifferenceKernel
} = require("./utils/territoryDifferenceKernel");

const app = express();
const server = http.createServer(app);
const io = new Server(server, createSocketOptions());
const roomCoordinator = createRoomCoordinator({
    localRoomManager: roomManager,
    workerCount: config.server.roomWorkerCount
});
const publicPath = path.join(__dirname, "..", "public");
const sharedMathPath = path.join(__dirname, "utils", "math.js");

app.get("/game-config", (_request, response) => {
    response.json(config.client);
});

app.get("/shared/math.js", (_request, response) => {
    response.type("application/javascript");
    response.sendFile(sharedMathPath);
});

app.get("/", (_request, response) => {
    response.sendFile(path.join(publicPath, "index.html"));
});

app.use(express.static(publicPath));

registerSocket(io, roomCoordinator);
startServer().catch(handleServerStartFailure);

module.exports = {
    app,
    io,
    roomCoordinator,
    server
};

function createSocketOptions() {
    return {
        ...config.socket,
        transports: [...config.socket.transports]
    };
}

async function startServer() {
    await initializeTerritoryDifferenceKernel(config.territory.differenceKernel);
    logTerritoryDifferenceKernel();
    await roomCoordinator.start();
    roomManager.createBackgroundRoom(io);

    const host = process.env.HOST;

    if (host) {
        server.listen(config.server.port, host, logServerStart);
    } else {
        server.listen(config.server.port, logServerStart);
    }
}

function logTerritoryDifferenceKernel() {
    const kernel = getTerritoryDifferenceKernelDiagnostics();

    if (kernel.status === "ready") {
        console.log(`Territory difference kernel: ${kernel.activeKernel}`);
        return;
    }

    const reason = kernel.initializationError && kernel.initializationError.message
        || `configured as ${kernel.configuredKernel}`;

    console.warn(`Territory difference kernel fallback: polygon-clipping (${reason})`);
}

function handleServerStartFailure(error) {
    console.error("Failed to start server:", error);
    roomCoordinator.close().finally(() => {
        process.exitCode = 1;
    });
}

function logServerStart() {
    console.log(`Server running at http://localhost:${config.server.port}`);
    console.log(
        `Runtime allocation: ${config.server.coreCount} cores `
        + `(gateway + BOTS, ${config.server.roomWorkerCount} room workers)`
    );
}
