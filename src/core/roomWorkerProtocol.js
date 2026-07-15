const workerMessageTypes = Object.freeze({
    ACKNOWLEDGEMENT: "acknowledgement",
    COMMAND: "command",
    DIRECTORY: "directory",
    EVENT: "event",
    EVENT_DELIVERED: "eventDelivered",
    METRICS: "metrics",
    READY: "ready",
    REQUEST: "request",
    RESPONSE: "response",
    SHUTDOWN: "shutdown"
});

module.exports = {
    workerMessageTypes
};
