"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createNumberSystem } = require("../src/systems/numberSystem");

test("spawned numbers keep a stable random color seed in snapshots", () => {
    const numberSystem = createNumberSystem(5000, new Map(), "easy", {
        maxNumbers: 12,
        maxSpawnAttempts: 100,
        minDistanceBetween: 1,
        minDistanceFromPlayer: 1
    });
    const firstNumbers = numberSystem.serialize().nums;
    const secondNumbers = numberSystem.serialize().nums;

    assert.equal(firstNumbers.length, 12);
    assert.deepEqual(secondNumbers, firstNumbers);

    for (const number of firstNumbers) {
        const colorSeed = number[5];

        assert.ok(Number.isSafeInteger(colorSeed));
        assert.ok(colorSeed >= 0 && colorSeed <= 0xffffffff);
    }
});
