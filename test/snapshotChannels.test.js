const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createTransientStateSnapshot
} = require("../src/core/snapshotChannels");

test("schema 4 strips reliable cache deltas from transient simulation state", () => {
    const snapshot = createSnapshot(4);
    const transient = createTransientStateSnapshot(snapshot);

    assert.deepEqual(transient.players, snapshot.players);
    assert.deepEqual(transient.numbers, snapshot.numbers);
    assert.deepEqual(transient.catchStatus, snapshot.catchStatus);
    assert.deepEqual(transient.territoryIds, snapshot.territoryIds);
    assert.deepEqual(transient.trailIds, snapshot.trailIds);
    assert.equal(Object.hasOwn(transient, "territories"), false);
    assert.equal(Object.hasOwn(transient, "trails"), false);
    assert.equal(Object.hasOwn(transient, "playerInfo"), false);
    assert.equal(Object.hasOwn(transient, "roomConfig"), false);
});

test("legacy snapshot schemas keep their original gameState payload", () => {
    const snapshot = createSnapshot(3);

    assert.strictEqual(createTransientStateSnapshot(snapshot), snapshot);
});

function createSnapshot(schema) {
    return {
        schema,
        sequence: 7,
        snapshotEpoch: 2,
        time: 1234,
        players: ["player", 10, 20, 0],
        playerInfo: {
            player: ["#0ff", 0, 0, 1, "Player", 0, 3, 3, 0]
        },
        territoryIds: ["player"],
        territoryVersions: { player: 1 },
        territories: {
            player: {
                version: 1
            }
        },
        territoryOps: {},
        removedTerritoryIds: [],
        trailIds: ["player"],
        trails: {
            player: [1, 1]
        },
        removedTrailIds: [],
        trailRemovals: {},
        leaderboard: [["player", "Player", 1, 0]],
        mode: "sets",
        roomConfig: { map: { radius: 3000 } },
        catchStatus: [0, 0, null, 0, 0, null],
        numbers: { nums: [] }
    };
}
