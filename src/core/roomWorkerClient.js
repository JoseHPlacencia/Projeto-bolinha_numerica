const { EventEmitter } = require("node:events");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { workerMessageTypes } = require("./roomWorkerProtocol");

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_START_TIMEOUT_MS = 15000;

class RoomWorkerClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.id = options.id;
        this.workerPath = options.workerPath || path.join(__dirname, "..", "workers", "roomWorker.js");
        this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
        this.startTimeoutMs = options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
        this.nextRequestId = 1;
        this.pendingRequests = new Map();
        this.worker = null;
        this.closing = false;
        this.ready = false;
        this.startPromise = null;
    }

    start() {
        if (this.startPromise) return this.startPromise;

        this.closing = false;
        this.worker = new Worker(this.workerPath, {
            workerData: { workerId: this.id }
        });
        this.worker.on("message", message => this.handleMessage(message));
        this.worker.on("error", error => this.handleFailure(error));
        this.worker.on("exit", code => this.handleExit(code));

        this.startPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Room worker ${this.id} did not start in time.`));
            }, this.startTimeoutMs);

            this.once("ready", message => {
                clearTimeout(timeout);
                if (message.error) {
                    reject(deserializeError(message.error));
                    return;
                }
                resolve(message);
            });
            this.once("startFailure", error => {
                clearTimeout(timeout);
                reject(error);
            });
        });

        return this.startPromise;
    }

    request(operation, payload = {}) {
        if (!this.worker || !this.ready) {
            return Promise.reject(new Error(`Room worker ${this.id} is unavailable.`));
        }

        const requestId = `${this.id}:${this.nextRequestId++}`;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Room worker operation timed out: ${operation}`));
            }, this.requestTimeoutMs);

            this.pendingRequests.set(requestId, { reject, resolve, timeout });
            this.worker.postMessage({
                operation,
                payload,
                requestId,
                type: workerMessageTypes.REQUEST
            });
        });
    }

    command(operation, payload = {}) {
        if (!this.worker || !this.ready) return false;
        this.worker.postMessage({
            operation,
            payload,
            type: workerMessageTypes.COMMAND
        });
        return true;
    }

    acknowledge(acknowledgement) {
        if (!this.worker || !this.ready) return false;
        this.worker.postMessage({
            ...acknowledgement,
            type: workerMessageTypes.ACKNOWLEDGEMENT
        });
        return true;
    }

    confirmEventDelivery(deliveryId) {
        if (!this.worker || !this.ready || !deliveryId) return false;
        this.worker.postMessage({
            deliveryId,
            type: workerMessageTypes.EVENT_DELIVERED
        });
        return true;
    }

    async close() {
        this.closing = true;
        this.ready = false;
        this.rejectPending(new Error(`Room worker ${this.id} is shutting down.`));

        if (!this.worker) return;

        const worker = this.worker;
        this.worker = null;
        worker.postMessage({ type: workerMessageTypes.SHUTDOWN });

        await Promise.race([
            new Promise(resolve => worker.once("exit", resolve)),
            new Promise(resolve => setTimeout(resolve, 1000))
        ]);

        if (worker.threadId !== -1) {
            await worker.terminate();
        }
    }

    handleMessage(message) {
        if (!message || typeof message !== "object") return;

        if (message.type === workerMessageTypes.READY) {
            this.ready = !message.error;
            this.emit("ready", message);
            return;
        }

        if (message.type === workerMessageTypes.RESPONSE) {
            const pending = this.pendingRequests.get(message.requestId);
            if (!pending) return;

            this.pendingRequests.delete(message.requestId);
            clearTimeout(pending.timeout);
            if (message.error) {
                pending.reject(deserializeError(message.error));
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (message.type === workerMessageTypes.DIRECTORY) {
            this.emit("directory", message.rooms || []);
            return;
        }

        if (message.type === workerMessageTypes.EVENT) {
            this.emit("workerEvent", message.event);
            return;
        }

        if (message.type === workerMessageTypes.METRICS) {
            this.emit("metrics", message.metrics || {});
        }
    }

    handleFailure(error) {
        if (!this.ready) this.emit("startFailure", error);
        this.rejectPending(error);
        this.emit("workerError", error);
    }

    handleExit(code) {
        const wasClosing = this.closing;
        const wasReady = this.ready;
        this.ready = false;
        this.worker = null;
        this.startPromise = null;
        const error = new Error(`Room worker ${this.id} exited with code ${code}.`);
        this.rejectPending(error);
        if (!wasReady && !wasClosing) this.emit("startFailure", error);
        this.emit("workerExit", { code, expected: wasClosing });
    }

    rejectPending(error) {
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
}

function deserializeError(serializedError) {
    const error = new Error(serializedError && serializedError.message || "Room worker failed.");
    error.name = serializedError && serializedError.name || "Error";
    if (serializedError && serializedError.stack) error.stack = serializedError.stack;
    return error;
}

module.exports = {
    RoomWorkerClient
};
