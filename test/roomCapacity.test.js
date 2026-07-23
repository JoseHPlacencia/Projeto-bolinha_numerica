"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    calculateActiveBotTarget,
    calculateMapPlayerCapacity,
    calculateMapScaledPlayerLimit,
    getReservedHumanSlotCount
} = require("../src/core/roomCapacity");

test("map area limits player capacity without exceeding the requested ceiling", () => {
    assert.deepEqual(
        [0.5, 0.75, 1, 1.5, 2].map(mapSize => calculateMapPlayerCapacity(mapSize, 36)),
        [4, 9, 16, 25, 36]
    );
    assert.equal(calculateMapScaledPlayerLimit(0.5, 36, 36), 4);
    assert.equal(calculateMapScaledPlayerLimit(0.75, 36, 36), 9);
    assert.equal(calculateMapScaledPlayerLimit(1, 36, 36), 16);
    assert.equal(calculateMapScaledPlayerLimit(1.5, 36, 36), 25);
    assert.equal(calculateMapScaledPlayerLimit(2, 36, 36), 36);
    assert.equal(calculateMapScaledPlayerLimit(2, 8, 36), 8);
    assert.equal(calculateMapScaledPlayerLimit(0.5, 2, 36), 2);
    assert.equal(calculateMapPlayerCapacity(2), 36);
});

test("normal rooms reserve the final two positions for human players", () => {
    assert.equal(getReservedHumanSlotCount(16), 2);
    assert.equal(calculateActiveBotTarget(16, 12, 4), 2);
    assert.equal(calculateActiveBotTarget(16, 13, 4), 1);
    assert.equal(calculateActiveBotTarget(16, 14, 4), 0);
});

test("small rooms reduce the reservation so bots can still start the match", () => {
    assert.equal(getReservedHumanSlotCount(1), 0);
    assert.equal(getReservedHumanSlotCount(2), 0);
    assert.equal(getReservedHumanSlotCount(3), 1);
    assert.equal(calculateActiveBotTarget(1, 0, 2), 1);
    assert.equal(calculateActiveBotTarget(2, 0, 2), 2);
    assert.equal(calculateActiveBotTarget(3, 0, 3), 2);
});

test("human occupation progressively replaces bots within total capacity", () => {
    assert.equal(calculateActiveBotTarget(2, 0, 2), 2);
    assert.equal(calculateActiveBotTarget(2, 1, 2), 1);
    assert.equal(calculateActiveBotTarget(2, 2, 2), 0);
    assert.equal(calculateActiveBotTarget(4, 0, 4), 2);
    assert.equal(calculateActiveBotTarget(4, 1, 4), 1);
    assert.equal(calculateActiveBotTarget(4, 2, 4), 0);
});
