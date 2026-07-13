const path = require("node:path");
const { createWorkerJobPool } = require("../utils/workerJobPool");

const workerPath = path.join(__dirname, "..", "workers", "territoryRepairWorker.js");
const pool = createWorkerJobPool({
    idleTimeoutMs: 30000,
    workerName: "Territory repair worker",
    workerPath
});

function submitTerritoryRepairJob(payload, onComplete, maxInFlight) {
    return pool.submit(payload, onComplete, maxInFlight);
}

function getTerritoryRepairWorkerPendingCount() {
    return pool.getPendingCount();
}

module.exports = {
    getTerritoryRepairWorkerPendingCount,
    submitTerritoryRepairJob
};
