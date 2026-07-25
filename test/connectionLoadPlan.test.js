"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createConnectionLoadPlan,
    createRoomAllocations,
    normalizeRamp
} = require("../scripts/lib/connectionLoadPlan");

test("massive connection plan preserves the 36-player limit in every arena", () => {
    const plan = createConnectionLoadPlan({
        arenaCapacity: 36,
        mapSize: 2,
        ramp: [36, 72, 100, 1800]
    });

    assert.equal(plan.maximumPlayers, 1800);
    assert.deepEqual(
        plan.stages.map(stage => stage.rooms.map(room => room.targetPlayers)),
        [
            [36],
            [36, 36],
            [36, 36, 28],
            Array(50).fill(36)
        ]
    );
    assert.ok(plan.stages.every(stage => (
        stage.rooms.every(room => room.targetPlayers <= 36)
    )));
});

test("room allocation keeps a partial final arena without exceeding capacity", () => {
    assert.deepEqual(createRoomAllocations(73, 36), [
        { index: 1, targetPlayers: 36 },
        { index: 2, targetPlayers: 36 },
        { index: 3, targetPlayers: 1 }
    ]);
});

test("massive connection plan respects map-scaled arena limits", () => {
    assert.throws(
        () => createConnectionLoadPlan({
            arenaCapacity: 36,
            mapSize: 1,
            ramp: [36]
        }),
        /exceeds the 16-player limit/
    );

    const plan = createConnectionLoadPlan({
        arenaCapacity: 16,
        mapSize: 1,
        ramp: [16, 32]
    });
    assert.equal(plan.maximumArenaCapacity, 16);
});

test("ramp rejects duplicate, descending and over-capacity targets", () => {
    assert.throws(() => normalizeRamp([36, 36], 1800), /strictly increasing/);
    assert.throws(() => normalizeRamp([72, 36], 1800), /strictly increasing/);
    assert.throws(() => normalizeRamp([1801], 1800), /from 1 to 1800/);
});
