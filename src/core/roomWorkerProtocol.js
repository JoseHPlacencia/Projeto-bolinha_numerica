const workerMessageTypes = Object.freeze({
    ACKNOWLEDGEMENT: "acknowledgement",
    ACKNOWLEDGEMENT_BATCH: "acknowledgementBatch",
    COMMAND: "command",
    DIRECTORY: "directory",
    EVENT: "event",
    EVENT_BATCH: "eventBatch",
    EVENT_DELIVERED: "eventDelivered",
    EVENTS_DELIVERED: "eventsDelivered",
    METRICS: "metrics",
    READY: "ready",
    REQUEST: "request",
    RESPONSE: "response",
    SHUTDOWN: "shutdown"
});

module.exports = {
    workerMessageTypes
};
