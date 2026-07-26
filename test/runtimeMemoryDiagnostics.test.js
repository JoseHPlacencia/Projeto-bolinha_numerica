const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createRuntimeMemorySampler,
    createRuntimeMemorySnapshot,
    runDiagnosticGarbageCollection
} = require("../src/core/runtimeMemoryDiagnostics");
const {
    createRoomWorkerRuntime
} = require("../src/core/roomWorkerRuntime");

test("runtime memory snapshot labels process-wide and thread-local fields", () => {
    const snapshot = createRuntimeMemorySnapshot("room-worker", {
        arrayBuffers: 5,
        external: 7,
        heapTotal: 11,
        heapUsed: 9,
        rss: 20
    }, 1234);

    assert.deepEqual(snapshot, {
        schema: 1,
        scope: "room-worker",
        sampledAt: 1234,
        rssScope: "process",
        isolateFieldsScope: "thread",
        arrayBuffersBytes: 5,
        externalBytes: 7,
        heapTotalBytes: 11,
        heapUsedBytes: 9,
        rssBytes: 20
    });
});

test("runtime memory sampler bounds expensive process memory reads", () => {
    let now = 1000;
    let reads = 0;
    const sample = createRuntimeMemorySampler("gateway", {
        memoryUsage() {
            reads++;
            return {
                arrayBuffers: reads,
                external: reads,
                heapTotal: reads,
                heapUsed: reads,
                rss: reads
            };
        },
        now: () => now,
        sampleIntervalMs: 1000
    });

    const first = sample();
    now = 1500;
    assert.strictEqual(sample(), first);
    assert.equal(reads, 1);

    now = 2000;
    assert.notStrictEqual(sample(), first);
    assert.equal(reads, 2);

    sample(true);
    assert.equal(reads, 3);
});

test("diagnostic garbage collection requires an explicit request and opt-in", () => {
    let collections = 0;
    const collectGarbage = () => {
        collections++;
    };

    assert.equal(runDiagnosticGarbageCollection(true, {
        collectGarbage,
        configured: "false"
    }).executed, false);
    assert.equal(runDiagnosticGarbageCollection(false, {
        collectGarbage,
        configured: "true"
    }).executed, false);
    assert.equal(runDiagnosticGarbageCollection(true, {
        collectGarbage,
        configured: "true"
    }).executed, true);
    assert.equal(collections, 1);
});

test("room worker metrics expose isolate memory with explicit scope", () => {
    const runtime = createRoomWorkerRuntime();

    try {
        const metrics = runtime.getMetrics();
        const memory = metrics.memory;

        assert.equal(memory.scope, "room-worker");
        assert.equal(memory.rssScope, "process");
        assert.equal(memory.isolateFieldsScope, "thread");
        assert.ok(memory.heapUsedBytes > 0);
        assert.ok(memory.rssBytes >= memory.heapUsedBytes);
        assert.equal(metrics.connectionCount, 0);
        assert.equal(metrics.roomBindingCount, 0);
        assert.deepEqual(metrics.transport, {
            acknowledgementCount: 0,
            roomCount: 0,
            roomMembershipCount: 0,
            socketCount: 0
        });
    } finally {
        runtime.close();
    }
});
