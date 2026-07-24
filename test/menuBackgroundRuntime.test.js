const assert = require("node:assert/strict");
const test = require("node:test");
const {
    DEFAULT_MENU_BACKGROUND_SNAPSHOT_RATE,
    MAX_MENU_BACKGROUND_SNAPSHOT_RATE,
    MENU_BACKGROUND_SNAPSHOT_RATE_ENV,
    MIN_MENU_BACKGROUND_SNAPSHOT_RATE,
    resolveMenuBackgroundSnapshotRate
} = require("../src/config/menuBackgroundRuntime");

test("menu background snapshot rate defaults to 10 updates per second", () => {
    assert.equal(
        resolveMenuBackgroundSnapshotRate(undefined),
        DEFAULT_MENU_BACKGROUND_SNAPSHOT_RATE
    );
    assert.equal(DEFAULT_MENU_BACKGROUND_SNAPSHOT_RATE, 10);
});

test("menu background snapshot rate accepts the supported range", () => {
    assert.equal(
        resolveMenuBackgroundSnapshotRate(String(MIN_MENU_BACKGROUND_SNAPSHOT_RATE)),
        MIN_MENU_BACKGROUND_SNAPSHOT_RATE
    );
    assert.equal(resolveMenuBackgroundSnapshotRate("10"), 10);
    assert.equal(
        resolveMenuBackgroundSnapshotRate(String(MAX_MENU_BACKGROUND_SNAPSHOT_RATE)),
        MAX_MENU_BACKGROUND_SNAPSHOT_RATE
    );
});

test("menu background snapshot rate rejects invalid values", () => {
    for (const value of ["0", "21", "10.5", "-1", "fast"]) {
        assert.throws(
            () => resolveMenuBackgroundSnapshotRate(value),
            error => (
                error instanceof RangeError
                && error.message.includes(MENU_BACKGROUND_SNAPSHOT_RATE_ENV)
            )
        );
    }
});
