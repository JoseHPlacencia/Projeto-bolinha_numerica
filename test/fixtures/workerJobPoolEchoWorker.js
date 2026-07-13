"use strict";

const { parentPort, threadId } = require("node:worker_threads");

parentPort.on("message", message => {
    parentPort.postMessage({
        jobId: message.jobId,
        threadId,
        value: message.value
    });
});
