"use strict";

const { parentPort, threadId } = require("node:worker_threads");

parentPort.on("message", message => {
    setTimeout(() => {
        parentPort.postMessage({
            jobId: message.jobId,
            threadId,
            value: message.value
        });
    }, message.delayMs || 0);
});
