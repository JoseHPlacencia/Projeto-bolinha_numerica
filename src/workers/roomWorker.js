const { parentPort, workerData } = require("node:worker_threads");
const config = require("../config/gameConfig");
const { createRoomWorkerRuntime } = require("../core/roomWorkerRuntime");
const { workerMessageTypes } = require("../core/roomWorkerProtocol");
const {
    getTerritoryDifferenceKernelDiagnostics,
    initializeTerritoryDifferenceKernel
} = require("../utils/territoryDifferenceKernel");

const workerId = Number(workerData && workerData.workerId) || 0;
const volatileDeliveries = new Map();
const volatileDeliverySockets = new Map();
const pendingVolatileEvents = new Map();
let nextVolatileDeliveryId = 1;
const runtime = createRoomWorkerRuntime({
    publishDirectory: rooms => parentPort.postMessage({
        rooms,
        type: workerMessageTypes.DIRECTORY,
        workerId
    }),
    publishEvent
});
const metricsInterval = setInterval(publishMetrics, 2000);
metricsInterval.unref();

parentPort.on("message", handleMessage);
start().catch(error => {
    parentPort.postMessage({
        error: serializeError(error),
        type: workerMessageTypes.READY,
        workerId
    });
});

async function start() {
    await initializeTerritoryDifferenceKernel(config.territory.differenceKernel);
    parentPort.postMessage({
        kernel: getTerritoryDifferenceKernelDiagnostics(),
        type: workerMessageTypes.READY,
        workerId
    });
}

async function handleMessage(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === workerMessageTypes.REQUEST) {
        await handleRequest(message);
        return;
    }

    if (message.type === workerMessageTypes.COMMAND) {
        runtime.executeCommand(message.operation, message.payload);
        return;
    }

    if (message.type === workerMessageTypes.ACKNOWLEDGEMENT) {
        runtime.acknowledge(message);
        return;
    }

    if (message.type === workerMessageTypes.EVENT_DELIVERED) {
        handleEventDelivered(message.deliveryId);
        return;
    }

    if (message.type === workerMessageTypes.SHUTDOWN) {
        clearInterval(metricsInterval);
        runtime.close();
        process.exitCode = 0;
        parentPort.close();
    }
}

function publishMetrics() {
    parentPort.postMessage({
        metrics: runtime.getMetrics(),
        type: workerMessageTypes.METRICS,
        workerId
    });
}

function publishEvent(event) {
    if (!isCoalescibleVolatileEvent(event)) {
        postEvent(event);
        return;
    }

    if (volatileDeliveries.has(event.socketId)) {
        pendingVolatileEvents.set(event.socketId, event);
        return;
    }

    postVolatileEvent(event);
}

function postVolatileEvent(event) {
    const deliveryId = `${workerId}:volatile:${nextVolatileDeliveryId++}`;
    volatileDeliveries.set(event.socketId, deliveryId);
    volatileDeliverySockets.set(deliveryId, event.socketId);
    postEvent({ ...event, deliveryId });
}

function postEvent(event) {
    parentPort.postMessage({
        event,
        type: workerMessageTypes.EVENT,
        workerId
    });
}

function handleEventDelivered(deliveryId) {
    const socketId = volatileDeliverySockets.get(deliveryId);
    if (!socketId || volatileDeliveries.get(socketId) !== deliveryId) return;

    volatileDeliverySockets.delete(deliveryId);
    volatileDeliveries.delete(socketId);
    const pendingEvent = pendingVolatileEvents.get(socketId);
    if (!pendingEvent) return;

    pendingVolatileEvents.delete(socketId);
    postVolatileEvent(pendingEvent);
}

function isCoalescibleVolatileEvent(event) {
    return Boolean(
        event
        && event.target === "socket"
        && event.event === "gameState"
        && event.volatile === true
        && !event.acknowledgementId
    );
}

async function handleRequest(message) {
    try {
        const result = await runtime.executeRequest(message.operation, message.payload);
        parentPort.postMessage({
            requestId: message.requestId,
            result,
            type: workerMessageTypes.RESPONSE,
            workerId
        });
    } catch (error) {
        parentPort.postMessage({
            error: serializeError(error),
            requestId: message.requestId,
            type: workerMessageTypes.RESPONSE,
            workerId
        });
    }
}

function serializeError(error) {
    return {
        message: error && error.message ? error.message : String(error),
        name: error && error.name ? error.name : "Error",
        stack: error && error.stack ? error.stack : null
    };
}
