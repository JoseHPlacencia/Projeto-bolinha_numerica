const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const { Player } = require("../src/entities/player");
const {
    applyCapturedPolygon,
    createTerritories,
    initializePlayerTerritory,
    processTerritoryOverlapRepairQueue
} = require("../src/state/territories");
const {
    acknowledgeReliableSnapshot,
    assignSnapshotSequence,
    sendSnapshot,
    shouldDeferTerritoryGeometry
} = require("../src/core/snapshotLoop");
const { resetSocketSnapshotState } = require("../src/core/snapshotState");
const {
    createClientSnapshotState,
    createSnapshot
} = require("../src/core/snapshotSerializer");
const {
    createSocket,
    createCutTerritoryState,
    createRectanglePolygon,
    createDenseRectanglePolygon,
    processTerritoryRepairsUntil,
    createCircleLikePolygon,
    replaceTerritoryPolygon,
    createTrailTestPoints,
    getMaximumTerritoryOverlapArea
} = require("./helpers/gameTestFixtures");

test("snapshot reports incoming threat and outgoing counterattack risk", () => {
    const marker = new Player("marker", { x: 0, y: 0 });
    const trailOwner = new Player("trail-owner", { x: 1000, y: 1000 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    const territories = createTerritories();

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, trailOwner);
    marker.queueCatchEliminationTarget(trailOwner.id, Date.now() - 400);

    const markerSnapshot = createSnapshot(players, territories, marker.id, undefined, null, config);
    const ownerSnapshot = createSnapshot(players, territories, trailOwner.id, undefined, null, config);

    assert.equal(markerSnapshot.catchStatus.counterTargetCount, 1);
    assert.equal(markerSnapshot.catchStatus.counterRiskArmed, false);
    assert.ok(markerSnapshot.catchStatus.counterRiskRemainingMs > 0);
    assert.ok(markerSnapshot.catchStatus.counterRiskRemainingMs <= 800);
    assert.equal(markerSnapshot.catchStatus.threatCount, 0);
    assert.equal(markerSnapshot.catchStatus.threatRemainingMs, null);
    assert.equal(ownerSnapshot.catchStatus.counterTargetCount, 0);
    assert.equal(ownerSnapshot.catchStatus.counterRiskRemainingMs, null);
    assert.equal(ownerSnapshot.catchStatus.threatCount, 1);
    assert.equal(ownerSnapshot.catchStatus.threatArmed, false);
    assert.ok(ownerSnapshot.catchStatus.threatRemainingMs > 0);
    assert.ok(ownerSnapshot.catchStatus.threatRemainingMs <= 800);
});

test("snapshot uses hysteresis before explicitly removing territory and trail", () => {
    const viewer = new Player("viewer", { x: 0, y: 0 });
    const remote = new Player("remote", { x: 1400, y: 0 });
    const players = new Map([
        [viewer.id, viewer],
        [remote.id, remote]
    ]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState();

    initializePlayerTerritory(territories, viewer);
    initializePlayerTerritory(territories, remote);
    remote.trailLeftSegments = [[
        { x: 1300, y: -20 },
        { x: 1450, y: -20 }
    ]];
    remote.trailRightSegments = [[
        { x: 1300, y: 20 },
        { x: 1450, y: 20 }
    ]];

    const visibleSnapshot = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.ok(visibleSnapshot.territoryIds.includes(remote.id));
    assert.ok(visibleSnapshot.trailIds.includes(remote.id));

    viewer.x = -4000;
    clientState.territoryVisibility.set(remote.id, Date.now());
    clientState.trailVisibility.set(remote.id, Date.now());

    const retainedSnapshot = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.ok(retainedSnapshot.territoryIds.includes(remote.id));
    assert.ok(retainedSnapshot.trailIds.includes(remote.id));
    assert.equal(retainedSnapshot.removedTerritoryIds.includes(remote.id), false);
    assert.equal(retainedSnapshot.removedTrailIds.includes(remote.id), false);

    clientState.territoryVisibility.set(
        remote.id,
        Date.now() - config.network.interestRetentionMs - 10
    );
    clientState.trailVisibility.set(
        remote.id,
        Date.now() - config.network.interestRetentionMs - 10
    );

    const removedSnapshot = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.ok(removedSnapshot.removedTerritoryIds.includes(remote.id));
    assert.ok(removedSnapshot.removedTrailIds.includes(remote.id));
    assert.equal(removedSnapshot.trailRemovals[remote.id], remote.trailGeneration);
});

test("snapshot sends capture-affected territories with the capture owner", () => {
    const viewer = new Player("viewer", { x: 0, y: 0 });
    const owner = new Player("owner", { x: 120, y: 0 });
    const victim = new Player("victim", { x: 240, y: 0 });
    const players = new Map([
        [viewer.id, viewer],
        [owner.id, owner],
        [victim.id, victim]
    ]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState();

    initializePlayerTerritory(territories, viewer);
    initializePlayerTerritory(territories, owner);
    initializePlayerTerritory(territories, victim);
    createSnapshot(players, territories, viewer.id, clientState, null, config);

    replaceTerritoryPolygon(
        territories.get(owner.id),
        createCircleLikePolygon(owner.x, owner.y, 900, 2200)
    );
    replaceTerritoryPolygon(
        territories.get(victim.id),
        createRectanglePolygon(220, -20, 260, 20)
    );
    territories.get(owner.id).captureAffectedTerritoryIds = [victim.id];

    const snapshot = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.ok(snapshot.territories[owner.id]);
    assert.ok(snapshot.territories[victim.id]);
    assert.equal(snapshot.payloadBudget.sent.territories >= 2, true);
});

test("snapshots defer reliable geometry while dense overlap repair is unsettled", async () => {
    const owner = new Player("owner", { x: -75, y: 50 });
    const first = new Player("first", { x: 150, y: 25 });
    const second = new Player("second", { x: 150, y: 75 });
    const players = new Map([
        [owner.id, owner],
        [first.id, first],
        [second.id, second]
    ]);
    const territories = new Map([
        [owner.id, createCutTerritoryState(
            owner.id,
            createDenseRectanglePolygon(-100, 0, -50, 100, 160)
        )],
        [first.id, createCutTerritoryState(
            first.id,
            createDenseRectanglePolygon(80, 0, 180, 45, 160)
        )],
        [second.id, createCutTerritoryState(
            second.id,
            createDenseRectanglePolygon(80, 55, 180, 100, 160)
        )]
    ]);
    const socket = createSocket(owner.id, { roomCode: "ROOM" });
    const io = { sockets: { sockets: new Map([[socket.id, socket]]) } };
    const diagnostics = { phases: {} };

    sendSnapshot(io, players, territories, "ROOM", null);
    const confirmedOwnerVersion = socket.data.snapshotState.territories.get(owner.id).version;

    applyCapturedPolygon(
        territories,
        owner.id,
        createRectanglePolygon(-120, 0, -110, 10),
        {
            diagnostics,
            ownerPolygon: createDenseRectanglePolygon(0, 0, 120, 100, 160),
            players
        }
    );
    processTerritoryOverlapRepairQueue(territories, players, {
        diagnostics,
        players
    });

    assert.equal(shouldDeferTerritoryGeometry(territories), true);
    socket.emitted.length = 0;
    sendSnapshot(io, players, territories, "ROOM", null);

    const deferredSnapshot = socket.emitted.find(event => event.event === "gameState").payload;

    assert.deepEqual(deferredSnapshot.territories, {});
    assert.deepEqual(deferredSnapshot.territoryOps, {});
    assert.deepEqual(deferredSnapshot.trails, {});
    assert.equal(deferredSnapshot.preserveTrails, true);
    assert.equal(
        socket.data.snapshotState.territories.get(owner.id).version,
        confirmedOwnerVersion
    );

    await processTerritoryRepairsUntil(
        territories,
        players,
        diagnostics,
        () => getMaximumTerritoryOverlapArea(territories) <= 1
            && !shouldDeferTerritoryGeometry(territories)
    );

    assert.equal(shouldDeferTerritoryGeometry(territories), false);
});

test("ending a trail emits a generation tombstone", () => {
    const viewer = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[viewer.id, viewer]]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState();

    initializePlayerTerritory(territories, viewer);
    viewer.trailLeftSegments = [[
        { x: 0, y: -20 },
        { x: 100, y: -20 }
    ]];
    viewer.trailRightSegments = [[
        { x: 0, y: 20 },
        { x: 100, y: 20 }
    ]];

    createSnapshot(players, territories, viewer.id, clientState, null, config);
    const previousGeneration = viewer.trailGeneration;
    viewer.clearTrailState();

    const snapshot = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.ok(snapshot.removedTrailIds.includes(viewer.id));
    assert.equal(snapshot.trailRemovals[viewer.id], previousGeneration + 1);
});

test("large trails finish their initial sync and continue with patches", () => {
    const viewer = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[viewer.id, viewer]]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState();
    const pointCount = config.network.trailUpdateMaxPoints;

    initializePlayerTerritory(territories, viewer);
    viewer.trailLeftSegments = [[...createTrailTestPoints(pointCount, -20)]];
    viewer.trailRightSegments = [[...createTrailTestPoints(pointCount, 20)]];
    viewer.trailLeftFillPath = createTrailTestPoints(pointCount, -20);
    viewer.trailRightFillPath = createTrailTestPoints(pointCount, 20);

    const firstSnapshot = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.equal(firstSnapshot.trails[viewer.id].full, true);
    assert.equal(firstSnapshot.trails[viewer.id].partial, true);

    let latestSnapshot = firstSnapshot;

    for (let index = 0; index < 12; index++) {
        latestSnapshot = createSnapshot(
            players,
            territories,
            viewer.id,
            clientState,
            null,
            config
        );

        if (
            latestSnapshot.trails[viewer.id]
            && latestSnapshot.trails[viewer.id].partial !== true
        ) {
            break;
        }
    }

    assert.ok(latestSnapshot.trails[viewer.id]);
    assert.notEqual(latestSnapshot.trails[viewer.id].partial, true);

    clientState.trails.get(viewer.id).lastFullSentAt = 0;
    viewer.trailLeftSegments[0].push({ x: pointCount, y: -20 });
    viewer.trailRightSegments[0].push({ x: pointCount, y: 20 });
    viewer.trailLeftFillPath.push({ x: pointCount, y: -20 });
    viewer.trailRightFillPath.push({ x: pointCount, y: 20 });

    const continuedSnapshot = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );
    const continuedUpdate = continuedSnapshot.trails[viewer.id];

    assert.ok(continuedUpdate);
    assert.notEqual(continuedUpdate.full, true);
    assert.ok(
        (continuedUpdate.leftPatches || []).length > 0
        || (continuedUpdate.rightPatches || []).length > 0
    );
});

test("snapshot state reset increments the epoch without reusing reliable acknowledgements", () => {
    const socket = createSocket("snapshot-epoch");

    assert.equal(resetSocketSnapshotState(socket), "snapshot-epoch:1");

    const firstSnapshot = {};
    assignSnapshotSequence(socket, firstSnapshot);
    assert.equal(firstSnapshot.snapshotEpoch, "snapshot-epoch:1");

    socket.data.nextReliableSnapshotId = 7;
    assert.equal(resetSocketSnapshotState(socket), "snapshot-epoch:2");
    assert.equal(socket.data.nextReliableSnapshotId, 7);

    const secondSnapshot = {};
    assignSnapshotSequence(socket, secondSnapshot);
    assert.equal(secondSnapshot.snapshotEpoch, "snapshot-epoch:2");

    const currentPending = {
        epoch: "snapshot-epoch:2",
        id: 8,
        snapshotState: { current: true }
    };
    socket.data.pendingReliableSnapshot = currentPending;

    acknowledgeReliableSnapshot(socket, 8, { applied: true }, "snapshot-epoch:1");

    assert.strictEqual(socket.data.pendingReliableSnapshot, currentPending);
    assert.equal(socket.data.snapshotState, null);
});
