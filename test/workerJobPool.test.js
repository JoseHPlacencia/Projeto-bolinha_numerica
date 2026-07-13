"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createWorkerJobPool } = require("../src/utils/workerJobPool");

test("worker pool executes jobs sequentially and applies backpressure", async () => {
    const pool = createWorkerJobPool({
        idleTimeoutMs: 100,
        workerPath: path.join(__dirname, "fixtures", "workerJobPoolEchoWorker.js")
    });
    const firstJob = submit(pool, "first");
    const rejectedJobId = pool.submit({ value: "rejected" }, () => {}, 1);
    const first = await firstJob;
    const second = await submit(pool, "second");

    assert.equal(rejectedJobId, null);
    assert.equal(first.threadId, second.threadId);
    assert.equal(second.value, "second");
});

function submit(pool, value) {
    return new Promise((resolve, reject) => {
        const jobId = pool.submit({ value }, response => {
            if (response.error) {
                reject(new Error(response.error.message));
                return;
            }

            resolve(response);
        }, 1);

        if (!jobId) {
            reject(new Error("worker job was not accepted"));
        }
    });
}
