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
let pendingEventBatch = [];
let eventBatchScheduled = false;
let nextVolatileDeliveryId = 1;
const ipcMetrics = {
    acknowledgementBatchCount: 0,
    acknowledgementCount: 0,
    eventBatchCount: 0,
    eventCount: 0,
    lastAcknowledgementBatchSize: 0,
    lastEventBatchSize: 0,
    maxAcknowledgementBatchSize: 0,
    maxEventBatchSize: 0,
    volatileDeferredEventCount: 0,
    volatileDeliveredEventCount: 0,
    volatileReplacedEventCount: 0
};
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
        acknowledgeBatch([message]);
        return;
    }

    if (message.type === workerMessageTypes.ACKNOWLEDGEMENT_BATCH) {
        acknowledgeBatch(message.acknowledgements);
        return;
    }

    if (message.type === workerMessageTypes.EVENT_DELIVERED) {
        handleEventDelivered(message.deliveryId);
        return;
    }

    if (message.type === workerMessageTypes.EVENTS_DELIVERED) {
        handleEventsDelivered(message.deliveryIds);
        return;
    }

    if (message.type === workerMessageTypes.SHUTDOWN) {
        clearInterval(metricsInterval);
        runtime.close();
        flushEventBatch();
        process.exitCode = 0;
        parentPort.close();
    }
}

function publishMetrics() {
    parentPort.postMessage({
        metrics: {
            ...runtime.getMetrics(),
            ipc: {
                ...ipcMetrics,
                pendingEventBatchSize: pendingEventBatch.length,
                pendingVolatileEventCount: pendingVolatileEvents.size,
                volatileInFlightCount: volatileDeliveries.size
            }
        },
        type: workerMessageTypes.METRICS,
        workerId
    });
}

function acknowledgeBatch(acknowledgements) {
    if (!Array.isArray(acknowledgements) || acknowledgements.length === 0) {
        return;
    }

    ipcMetrics.acknowledgementBatchCount++;
    ipcMetrics.acknowledgementCount += acknowledgements.length;
    ipcMetrics.lastAcknowledgementBatchSize = acknowledgements.length;
    ipcMetrics.maxAcknowledgementBatchSize = Math.max(
        ipcMetrics.maxAcknowledgementBatchSize,
        acknowledgements.length
    );

    for (const acknowledgement of acknowledgements) {
        runtime.acknowledge(acknowledgement);
    }
}

function publishEvent(event) {
    if (!isCoalescibleVolatileEvent(event)) {
        postEvent(event);
        return;
    }

    if (volatileDeliveries.has(event.socketId)) {
        ipcMetrics.volatileDeferredEventCount++;
        if (pendingVolatileEvents.has(event.socketId)) {
            ipcMetrics.volatileReplacedEventCount++;
        }
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
    pendingEventBatch.push(event);
    scheduleEventBatch();
}

function scheduleEventBatch() {
    if (eventBatchScheduled) return;
    eventBatchScheduled = true;
    queueMicrotask(flushEventBatch);
}

function flushEventBatch() {
    eventBatchScheduled = false;
    if (pendingEventBatch.length === 0) return;

    const events = pendingEventBatch;
    pendingEventBatch = [];
    ipcMetrics.eventBatchCount++;
    ipcMetrics.eventCount += events.length;
    ipcMetrics.lastEventBatchSize = events.length;
    ipcMetrics.maxEventBatchSize = Math.max(
        ipcMetrics.maxEventBatchSize,
        events.length
    );
    parentPort.postMessage({
        events,
        type: workerMessageTypes.EVENT_BATCH,
        workerId
    });
}

function handleEventDelivered(deliveryId) {
    const socketId = volatileDeliverySockets.get(deliveryId);
    if (!socketId || volatileDeliveries.get(socketId) !== deliveryId) return;

    volatileDeliverySockets.delete(deliveryId);
    volatileDeliveries.delete(socketId);
    ipcMetrics.volatileDeliveredEventCount++;
    const pendingEvent = pendingVolatileEvents.get(socketId);
    if (!pendingEvent) return;

    pendingVolatileEvents.delete(socketId);
    postVolatileEvent(pendingEvent);
}

function handleEventsDelivered(deliveryIds) {
    if (!Array.isArray(deliveryIds)) return;
    for (const deliveryId of deliveryIds) {
        handleEventDelivered(deliveryId);
    }
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
