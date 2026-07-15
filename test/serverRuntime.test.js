const assert = require("node:assert/strict");
const test = require("node:test");
const {
    MAX_SERVER_CORES,
    MIN_SERVER_CORES,
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
