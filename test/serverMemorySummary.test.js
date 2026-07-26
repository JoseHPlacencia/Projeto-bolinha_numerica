const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createServerMemoryDelta,
    createServerMemorySummary
} = require("../scripts/lib/serverMemorySummary");

function createMemory(multiplier, sampledAt = 1000) {
    return {
        arrayBuffersBytes: 1 * multiplier,
        externalBytes: 2 * multiplier,
        heapTotalBytes: 3 * multiplier,
        heapUsedBytes: 4 * multiplier,
        rssBytes: 100 * multiplier,
        sampledAt
    };
}

test("server memory summary sums isolate fields without duplicating process RSS", () => {
    const summary = createServerMemorySummary({
        gatewayMemory: createMemory(1),
        workerDiagnostics: [
            {
                id: 2,
                metrics: {
                    connectionCount: 6,
                    memory: createMemory(3, 1200),
                    playerCount: 5,
                    roomBindingCount: 5,
                    roomCount: 2
                }
            },
            {
                id: 1,
                metrics: {
                    connectionCount: 4,
                    memory: createMemory(2, 1100),
                    playerCount: 4,
                    roomBindingCount: 4,
                    roomCount: 1
                }
            }
        ]
    });

    assert.equal(summary.processRssBytes, 100);
    assert.deepEqual(summary.isolateTotals, {
        arrayBuffersBytes: 6,
        externalBytes: 12,
        heapTotalBytes: 18,
        heapUsedBytes: 24
    });
    assert.deepEqual(summary.workers.map(worker => worker.id), [1, 2]);
    assert.equal(summary.connectionCount, 10);
    assert.equal(summary.playerCount, 9);
    assert.equal(summary.roomBindingCount, 9);
    assert.equal(summary.roomCount, 3);
    assert.equal(summary.sampledAt, 1200);
});

test("server memory delta preserves signed changes per isolate", () => {
    const before = createServerMemorySummary({
        gatewayMemory: createMemory(2),
        workerDiagnostics: [{
            id: 1,
            metrics: { memory: createMemory(3), roomCount: 0 }
        }]
    });
    const after = createServerMemorySummary({
        gatewayMemory: createMemory(3),
        workerDiagnostics: [{
            id: 1,
            metrics: { memory: createMemory(2), roomCount: 0 }
        }]
    });
    const delta = createServerMemoryDelta(before, after);

    assert.equal(delta.processRssBytes, 100);
    assert.equal(delta.gateway.heapUsedBytes, 4);
    assert.equal(delta.workers[0].memory.heapUsedBytes, -4);
    assert.equal(delta.isolateTotals.heapUsedBytes, 0);
});
