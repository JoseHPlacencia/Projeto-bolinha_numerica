const { parentPort } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");

const {
    calculatePolygonArea,
    calculatePolygonIntersectionArea,
    subtractPolygonComponents
} = require("../utils/geometry");
const { selectRetainedTerritoryPolygon } = require("../state/territoryRetention");

if (!parentPort) {
    throw new Error("Territory repair worker requires a parent port.");
}

parentPort.on("message", job => {
    const startedAt = performance.now();

    try {
        const result = processTerritoryRepairJob(job);

        parentPort.postMessage({
            jobId: job && job.jobId,
            result: {
                ...result,
                totalMs: performance.now() - startedAt
            }
        });
    } catch (error) {
        parentPort.postMessage({
            error: {
                message: error && error.message || String(error),
                stack: error && error.stack || null
            },
            jobId: job && job.jobId
        });
    }
});

function processTerritoryRepairJob(job) {
    const epsilon = Number.isFinite(job && job.areaEpsilon)
        ? Math.max(0, job.areaEpsilon)
        : 1;
    const first = job && job.first;
    const second = job && job.second;

    if (!first || !second) {
        throw new Error("Territory repair job is missing polygon snapshots.");
    }

    const intersectionStartedAt = performance.now();
    const overlapArea = calculatePolygonIntersectionArea(first.polygon, second.polygon);
    const intersectionMs = performance.now() - intersectionStartedAt;

    if (overlapArea <= epsilon) {
        return {
            changed: false,
            intersectionMs,
            overlapArea,
            subtractMs: 0
        };
    }

    const winner = job.winnerId === first.id ? first : second;
    const loser = job.loserId === first.id ? first : second;
    const previousArea = calculatePolygonArea(loser.polygon);
    const subtractStartedAt = performance.now();
    const retainedPolygon = selectRetainedTerritoryPolygon(
        subtractPolygonComponents(loser.polygon, winner.polygon),
        job.loserPlayer
    );
    const subtractMs = performance.now() - subtractStartedAt;
    const nextArea = calculatePolygonArea(retainedPolygon);

    return {
        changed: Math.abs(previousArea - nextArea) > epsilon,
        intersectionMs,
        nextArea,
        overlapArea,
        previousArea,
        retainedPolygon,
        subtractMs
    };
}
