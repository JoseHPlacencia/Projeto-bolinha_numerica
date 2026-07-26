const assert = require("node:assert/strict");
const test = require("node:test");
const {
    DEFAULT_ROOM_WORKER_IDLE_RECYCLE_MS,
    MAX_SERVER_CORES,
    MIN_SERVER_CORES,
    resolveRoomWorkerIdleRecycleMs,
    resolveServerCoreCount
} = require("../src/config/serverRuntime");

test("server core count accepts every supported allocation", () => {
    assert.equal(resolveServerCoreCount("2", 8), 2);
    assert.equal(resolveServerCoreCount("3", 8), 3);
    assert.equal(resolveServerCoreCount("4", 8), 4);
});

test("server core count defaults to available capacity within safe bounds", () => {
    assert.equal(resolveServerCoreCount(undefined, 1), MIN_SERVER_CORES);
    assert.equal(resolveServerCoreCount(undefined, 3), 3);
    assert.equal(resolveServerCoreCount(undefined, 16), MAX_SERVER_CORES);
});

test("server core count rejects ambiguous or out-of-range values", () => {
    for (const value of ["1", "5", "2.5", "four", "-2"]) {
        assert.throws(() => resolveServerCoreCount(value, 4), RangeError);
    }
});

test("room worker idle recycling has a safe default and can be disabled", () => {
    assert.equal(
        resolveRoomWorkerIdleRecycleMs(undefined),
        DEFAULT_ROOM_WORKER_IDLE_RECYCLE_MS
    );
    assert.equal(resolveRoomWorkerIdleRecycleMs("0"), 0);
    assert.equal(resolveRoomWorkerIdleRecycleMs("5000"), 5000);
    assert.equal(resolveRoomWorkerIdleRecycleMs("3600000"), 3600000);
});

test("room worker idle recycling rejects unsafe intervals", () => {
    for (const value of ["1", "4999", "3600001", "5.5", "-1", "off"]) {
        assert.throws(() => resolveRoomWorkerIdleRecycleMs(value), RangeError);
    }
});
