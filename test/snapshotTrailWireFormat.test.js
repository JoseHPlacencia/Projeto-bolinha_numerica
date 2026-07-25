const assert = require("node:assert/strict");
const test = require("node:test");
const {
    compactTrailUpdate,
    expandCompactTrailUpdate
} = require("../src/core/snapshotTrailWireFormat");

test("compact full trail preserves every packed coordinate and partial marker", () => {
    const update = {
        full: true,
        generation: 7,
        color: "#12abef",
        partial: true,
        remainingPointCount: 80,
        pointBudget: 512,
        leftSegments: [
            [[100.1, -20], [115.1, -19.5], [130.5, -18]]
        ],
        rightSegments: [
            [[100.1, 20], [115.1, 20.5], [130.5, 22]]
        ],
        leftFillPath: [[100.1, -20], [115.1, -19.5], [130.5, -18]],
        rightFillPath: [[100.1, 20], [115.1, 20.5], [130.5, 22]]
    };
    const compact = compactTrailUpdate(update);

    assert.equal(compact[0], 1);
    assert.deepEqual(expandCompactTrailUpdate(compact), update);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(update).length);
});

test("compact trail patch omits repeated color and restores patch indexes", () => {
    const update = {
        generation: 4,
        leftPatches: [{
            index: 1,
            start: 12,
            points: [[150, -20], [165, -18.7]]
        }],
        rightPatches: [{
            index: 1,
            start: 12,
            points: [[150, 20], [165, 21.3]]
        }],
        leftFillPoints: [[150, -20], [165, -18.7]],
        leftFillStart: 12,
        rightFillPoints: [[150, 20], [165, 21.3]],
        rightFillStart: 12
    };
    const compact = compactTrailUpdate(update);

    assert.equal(compact[0], 0);
    assert.deepEqual(expandCompactTrailUpdate(compact), update);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(update).length);
});

test("compact trail decoder rejects malformed positional updates", () => {
    assert.equal(expandCompactTrailUpdate([1, "invalid"]), null);
    assert.equal(expandCompactTrailUpdate([0, 1, 0, [[0, 0, [1]]]]), null);
    assert.equal(expandCompactTrailUpdate([9]), null);
});
