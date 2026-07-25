const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createClientSnapshotState,
    createClientSnapshotStateDraft,
    isClientSnapshotStateDraft,
    materializeClientSnapshotStateDraft
} = require("../src/core/snapshotClientState");

test("snapshot state draft isolates writes until materialization", () => {
    const confirmed = createClientSnapshotState();

    confirmed.globalState.set("leaderboard", { signature: "initial" });
    confirmed.playerInfo.set("player", { version: 1 });
    confirmed.territories.set("player", { version: 2 });
    confirmed.trails.set("player", { generation: 1 });
    confirmed.territoryVisibility.set("player", 100);
    confirmed.trailVisibility.set("player", 100);
    confirmed.territoryPoints.set("0,0", 1);
    confirmed.nextTerritoryPointId = 2;

    const draft = createClientSnapshotStateDraft(confirmed);

    assert.equal(isClientSnapshotStateDraft(draft), true);
    assert.equal(draft.territories.get("player").version, 2);
    assert.equal(draft.territoryPoints instanceof Map, true);

    draft.globalState.set("leaderboard", { signature: "updated" });
    draft.territories.set("player", { version: 3 });
    draft.trails.delete("player");
    draft.territoryVisibility.clear();
    draft.trailVisibility.set("remote", 200);
    draft.territoryPoints.set("1,1", 2);
    draft.nextTerritoryPointId = 3;

    assert.equal(confirmed.territories.get("player").version, 2);
    assert.equal(confirmed.globalState.get("leaderboard").signature, "initial");
    assert.equal(confirmed.trails.has("player"), true);
    assert.equal(confirmed.territoryVisibility.has("player"), true);
    assert.equal(confirmed.trailVisibility.has("remote"), false);
    assert.equal(confirmed.territoryPoints.has("1,1"), false);
    assert.equal(confirmed.nextTerritoryPointId, 2);

    const committed = materializeClientSnapshotStateDraft(draft);

    assert.equal(isClientSnapshotStateDraft(committed), false);
    assert.equal(committed.globalState.get("leaderboard").signature, "updated");
    assert.equal(committed.territories.get("player").version, 3);
    assert.equal(committed.trails.has("player"), false);
    assert.equal(committed.territoryVisibility.size, 0);
    assert.equal(committed.trailVisibility.get("remote"), 200);
    assert.equal(committed.territoryPoints.get("1,1"), 2);
    assert.equal(committed.nextTerritoryPointId, 3);
    assert.strictEqual(committed.playerInfo, confirmed.playerInfo);
});

test("snapshot state draft preserves untouched map references", () => {
    const confirmed = createClientSnapshotState();

    for (let pointId = 1; pointId <= 10000; pointId++) {
        confirmed.territoryPoints.set(`${pointId},${pointId}`, pointId);
    }

    const untouched = materializeClientSnapshotStateDraft(
        createClientSnapshotStateDraft(confirmed)
    );

    assert.strictEqual(untouched.playerInfo, confirmed.playerInfo);
    assert.strictEqual(untouched.globalState, confirmed.globalState);
    assert.strictEqual(untouched.territories, confirmed.territories);
    assert.strictEqual(untouched.trails, confirmed.trails);
    assert.strictEqual(untouched.territoryVisibility, confirmed.territoryVisibility);
    assert.strictEqual(untouched.trailVisibility, confirmed.trailVisibility);
    assert.strictEqual(untouched.territoryPoints, confirmed.territoryPoints);

    const changedDraft = createClientSnapshotStateDraft(confirmed);
    changedDraft.territoryPoints.set("new", 10001);
    const changed = materializeClientSnapshotStateDraft(changedDraft);

    assert.notStrictEqual(changed.territoryPoints, confirmed.territoryPoints);
    assert.equal(changed.territoryPoints.size, 10001);
    assert.equal(confirmed.territoryPoints.size, 10000);
});

test("snapshot state draft implements Map iteration and deletion semantics", () => {
    const confirmed = createClientSnapshotState();

    confirmed.playerInfo.set("first", { version: 1 });
    confirmed.playerInfo.set("second", { version: 1 });

    const draft = createClientSnapshotStateDraft(confirmed);

    assert.equal(draft.playerInfo.delete("missing"), false);
    assert.equal(draft.playerInfo.delete("first"), true);
    draft.playerInfo.set("second", { version: 2 });
    draft.playerInfo.set("third", { version: 1 });

    assert.equal(draft.playerInfo.size, 2);
    assert.deepEqual(
        [...draft.playerInfo].map(([id, state]) => [id, state.version]),
        [
            ["second", 2],
            ["third", 1]
        ]
    );
});
