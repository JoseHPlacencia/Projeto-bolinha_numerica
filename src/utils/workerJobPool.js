const { Worker } = require("node:worker_threads");

function createWorkerJobPool(options) {
    const workerPath = options && options.workerPath;
    const workerName = options && options.workerName || "Worker";
    const idleTimeoutMs = getPositiveInteger(options && options.idleTimeoutMs, 30000);
    let nextJobId = 1;
    let worker = null;
    let workerIdleTimer = null;
    const pendingJobs = new Map();

    if (typeof workerPath !== "string" || !workerPath) {
        throw new TypeError("worker job pool requires a worker path");
    }

    return {
        getPendingCount: () => pendingJobs.size,
        submit
    };

    function submit(payload, onComplete, maxInFlight) {
        if (typeof onComplete !== "function"
            || !Number.isInteger(maxInFlight)
            || maxInFlight <= 0
            || pendingJobs.size >= maxInFlight) {
            return null;
        }

        clearWorkerIdleTimer();
        const jobId = nextJobId++;
        let activeWorker;

        try {
            activeWorker = getOrCreateWorker();
        } catch (error) {
            queueMicrotask(() => onComplete({
                error: serializeError(error),
                jobId
            }));
            return jobId;
        }

        pendingJobs.set(jobId, onComplete);

        try {
            activeWorker.postMessage({
                ...payload,
                jobId
            });
        } catch (error) {
            pendingJobs.delete(jobId);
            queueMicrotask(() => onComplete({
                error: serializeError(error),
                jobId
            }));
        }

        return jobId;
    }

    function getOrCreateWorker() {
        if (worker) {
            return worker;
        }

        const createdWorker = new Worker(workerPath);

        worker = createdWorker;
        createdWorker.on("message", handleWorkerMessage);
        createdWorker.on("error", error => {
            if (worker !== createdWorker) {
                return;
            }

            failPendingJobs(error);
            worker = null;
        });
        createdWorker.on("exit", code => {
            if (worker !== createdWorker) {
                return;
            }

            if (code !== 0) {
                failPendingJobs(new Error(`${workerName} exited with code ${code}.`));
            }
            worker = null;
        });
        createdWorker.unref();
        return createdWorker;
    }

    function handleWorkerMessage(message) {
        const jobId = message && message.jobId;
        const onComplete = pendingJobs.get(jobId);

        if (!onComplete) {
            return;
        }

        pendingJobs.delete(jobId);
        onComplete(message);
        scheduleWorkerIdleTermination();
    }

    function failPendingJobs(error) {
        const failure = { error: serializeError(error) };
        const callbacks = [...pendingJobs.values()];

        pendingJobs.clear();

        for (const onComplete of callbacks) {
            onComplete(failure);
        }

        scheduleWorkerIdleTermination();
    }

    function scheduleWorkerIdleTermination() {
        if (!worker || pendingJobs.size > 0 || workerIdleTimer) {
            return;
        }

        workerIdleTimer = setTimeout(() => {
            workerIdleTimer = null;

            if (!worker || pendingJobs.size > 0) {
                return;
            }

            const idleWorker = worker;

            worker = null;
            idleWorker.terminate().catch(() => {});
        }, idleTimeoutMs);
        workerIdleTimer.unref();
    }

    function clearWorkerIdleTimer() {
        if (!workerIdleTimer) {
            return;
        }

        clearTimeout(workerIdleTimer);
        workerIdleTimer = null;
    }
}

function serializeError(error) {
    return {
        message: error && error.message || String(error),
        stack: error && error.stack || null
    };
}

function getPositiveInteger(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
    createWorkerJobPool
};
