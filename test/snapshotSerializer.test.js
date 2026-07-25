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
    shouldDeferTerritoryGeometry,
    shouldSendReliably
} = require("../src/core/snapshotLoop");
const { resetSocketSnapshotState } = require("../src/core/snapshotState");
const {
    createClientSnapshotState,
    createSnapshot,
    createSnapshotSharedFrame
} = require("../src/core/snapshotSerializer");
const {
    isClientSnapshotStateDraft
} = require("../src/core/snapshotClientState");
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

test("snapshot loop shares room-wide serialization without sharing client delta state", () => {
    const first = new Player("first", { x: -200, y: 0 });
    const second = new Player("second", { x: 200, y: 0 });
    const players = new Map([
        [first.id, first],
        [second.id, second]
    ]);
    const territories = createTerritories();
    const firstSocket = createSocket(first.id, { roomCode: "ROOM" });
    const secondSocket = createSocket(second.id, { roomCode: "ROOM" });
    const io = {
        sockets: {
            sockets: new Map([
                [firstSocket.id, firstSocket],
                [secondSocket.id, secondSocket]
            ])
        }
    };
    let serializeCalls = 0;
    const serializedNumbers = { nums: [[1, 0, 0, "1", 1, 123]], theme: null };
    const numberSystem = {
        serialize() {
            serializeCalls++;
            return serializedNumbers;
        }
    };

    initializePlayerTerritory(territories, first);
    initializePlayerTerritory(territories, second);
    sendSnapshot(io, players, territories, "ROOM", numberSystem, config);

    const firstSnapshot = firstSocket.emitted.find(event => event.event === "gameState").payload;
    const secondSnapshot = secondSocket.emitted.find(event => event.event === "gameState").payload;

    assert.equal(serializeCalls, 1);
    assert.equal(firstSnapshot.time, secondSnapshot.time);
    assert.strictEqual(firstSnapshot.numbers, secondSnapshot.numbers);
    assert.strictEqual(firstSnapshot.leaderboard, secondSnapshot.leaderboard);
    assert.strictEqual(firstSnapshot.roomConfig, secondSnapshot.roomConfig);
    assert.strictEqual(firstSnapshot.players[first.id], secondSnapshot.players[first.id]);
    assert.notStrictEqual(firstSnapshot.playerInfo, secondSnapshot.playerInfo);
    assert.notStrictEqual(firstSocket.data.snapshotState, secondSocket.data.snapshotState);
});

test("schema 3 caches room metadata and sends a compact leaderboard only when it changes", () => {
    const player = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState({ snapshotSchema: 3 });

    initializePlayerTerritory(territories, player);

    const firstSnapshot = createSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        config
    );
    const unchangedSnapshot = createSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        config
    );

    assert.equal(firstSnapshot.schema, 3);
    assert.equal(Array.isArray(firstSnapshot.players), true);
    assert.equal(firstSnapshot.players[0], player.id);
    assert.equal(Array.isArray(firstSnapshot.catchStatus), true);
    assert.ok(Array.isArray(firstSnapshot.leaderboard[0]));
    assert.deepEqual(firstSnapshot.leaderboard[0].slice(0, 2), [player.id, player.name]);
    assert.equal(typeof firstSnapshot.mode, "string");
    assert.ok(firstSnapshot.roomConfig);
    assert.equal(Object.hasOwn(unchangedSnapshot, "leaderboard"), false);
    assert.equal(Object.hasOwn(unchangedSnapshot, "mode"), false);
    assert.equal(Object.hasOwn(unchangedSnapshot, "roomConfig"), false);

    player.eliminations++;
    const changedSnapshot = createSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        config
    );

    assert.equal(changedSnapshot.leaderboard[0][3], 1);
    assert.equal(Object.hasOwn(changedSnapshot, "mode"), false);
    assert.equal(shouldSendReliably(changedSnapshot), true);
});

test("schema 2 keeps the legacy global snapshot shape", () => {
    const player = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState({ snapshotSchema: 2 });

    initializePlayerTerritory(territories, player);
    const firstSnapshot = createSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        config
    );
    const secondSnapshot = createSnapshot(
        players,
        territories,
        player.id,
        clientState,
        null,
        config
    );

    assert.equal(firstSnapshot.schema, 2);
    assert.equal(Array.isArray(firstSnapshot.leaderboard[0]), false);
    assert.ok(secondSnapshot.leaderboard);
    assert.ok(secondSnapshot.roomConfig);
});

test("schema 4 alternates atomic reliable frames with compact transient state", () => {
    const player = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const socket = createSocket(player.id, {
        roomCode: "ROOM",
        snapshotSchema: 4
    });
    const io = { sockets: { sockets: new Map([[socket.id, socket]]) } };
    initializePlayerTerritory(territories, player);
    sendSnapshot(io, players, territories, "ROOM", null, config);

    assert.equal(socket.emitted.length, 1);
    assert.equal(socket.emitted[0].event, "gameReliableState");
    assert.ok(socket.emitted[0].payload.territories[player.id]);
    assert.ok(socket.emitted[0].payload.playerInfo[player.id]);
    assert.ok(socket.emitted[0].payload.roomConfig);
    assert.ok(Array.isArray(socket.emitted[0].payload.players));
    assert.equal(Object.hasOwn(socket.emitted[0].payload, "numbers"), true);

    player.x = 25;
    sendSnapshot(io, players, territories, "ROOM", null, config);

    assert.equal(socket.emitted[1].event, "gameState");
    assert.equal(socket.emitted[1].payload.schema, 4);
    assert.ok(Array.isArray(socket.emitted[1].payload.players));
    assert.equal(Object.hasOwn(socket.emitted[1].payload, "numbers"), true);
    assert.deepEqual(socket.emitted[1].payload.territoryIds, [player.id]);
    assert.equal(Object.hasOwn(socket.emitted[1].payload, "territories"), false);
    assert.equal(Object.hasOwn(socket.emitted[1].payload, "playerInfo"), false);
});

test("snapshot loop commits transactional state only after reliable acknowledgement", () => {
    const player = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const confirmedState = createClientSnapshotState();
    const socket = createSocket(player.id, {
        roomCode: "ROOM",
        snapshotState: confirmedState
    });
    const io = { sockets: { sockets: new Map([[socket.id, socket]]) } };
    const emissions = [];
    let acknowledge = null;

    socket.emit = (event, payload, callback) => {
        emissions.push({ event, payload, volatile: false });
        if (typeof callback === "function") {
            acknowledge = callback;
        }
    };
    socket.volatile = {
        emit(event, payload) {
            emissions.push({ event, payload, volatile: true });
        }
    };

    initializePlayerTerritory(territories, player);
    sendSnapshot(io, players, territories, "ROOM", null, config);

    assert.strictEqual(socket.data.snapshotState, confirmedState);
    assert.equal(confirmedState.territories.size, 0);
    assert.equal(confirmedState.territoryPoints.size, 0);
    assert.equal(isClientSnapshotStateDraft(socket.data.pendingReliableSnapshot.snapshotState), true);
    assert.ok(socket.data.pendingReliableSnapshot.snapshotState.territoryPoints.size > 0);

    player.x = 50;
    sendSnapshot(io, players, territories, "ROOM", null, config);

    assert.strictEqual(socket.data.snapshotState, confirmedState);
    assert.equal(confirmedState.territories.size, 0);
    assert.equal(emissions.at(-1).volatile, true);
    assert.equal(emissions.at(-1).payload.preserveTrails, true);

    acknowledge(null, { applied: true });

    assert.equal(socket.data.pendingReliableSnapshot, null);
    assert.equal(isClientSnapshotStateDraft(socket.data.snapshotState), false);
    assert.equal(socket.data.snapshotState.territories.has(player.id), true);
    assert.ok(socket.data.snapshotState.territoryPoints.size > 0);
});

test("schema 3 global deltas wait for reliable acknowledgement", () => {
    const player = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const socket = createSocket(player.id, {
        roomCode: "ROOM",
        snapshotSchema: 3
    });
    const io = { sockets: { sockets: new Map([[socket.id, socket]]) } };
    const emissions = [];
    let acknowledge = null;

    socket.emit = (event, payload, callback) => {
        emissions.push({ event, payload, volatile: false });
        if (typeof callback === "function") {
            acknowledge = callback;
        }
    };
    socket.volatile = {
        emit(event, payload) {
            emissions.push({ event, payload, volatile: true });
        }
    };

    initializePlayerTerritory(territories, player);
    sendSnapshot(io, players, territories, "ROOM", null, config);

    assert.equal(emissions[0].payload.schema, 3);
    assert.ok(emissions[0].payload.leaderboard);
    assert.ok(emissions[0].payload.roomConfig);
    assert.equal(socket.data.snapshotState.globalState.size, 0);

    player.x = 25;
    sendSnapshot(io, players, territories, "ROOM", null, config);

    const volatileSnapshot = emissions.at(-1).payload;

    assert.equal(emissions.at(-1).volatile, true);
    assert.equal(Object.hasOwn(volatileSnapshot, "leaderboard"), false);
    assert.equal(Object.hasOwn(volatileSnapshot, "mode"), false);
    assert.equal(Object.hasOwn(volatileSnapshot, "roomConfig"), false);

    acknowledge(null, { applied: true });

    assert.equal(socket.data.snapshotState.globalState.has("leaderboard"), true);
    assert.equal(socket.data.snapshotState.globalState.has("roomMetadata"), true);
});

test("selective rejection invalidates materialized transactional geometry", () => {
    const player = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const socket = createSocket(player.id, { roomCode: "ROOM" });
    const io = { sockets: { sockets: new Map([[socket.id, socket]]) } };
    let acknowledge = null;

    socket.emit = (_event, _payload, callback) => {
        if (typeof callback === "function") {
            acknowledge = callback;
        }
    };

    initializePlayerTerritory(territories, player);
    sendSnapshot(io, players, territories, "ROOM", null, config);
    acknowledge(null, {
        applied: false,
        invalidations: {
            playerInfo: [],
            territories: [player.id],
            trails: []
        }
    });

    assert.equal(socket.data.pendingReliableSnapshot, null);
    assert.equal(isClientSnapshotStateDraft(socket.data.snapshotState), false);
    assert.equal(socket.data.snapshotState.playerInfo.has(player.id), true);
    assert.equal(socket.data.snapshotState.territories.has(player.id), false);
    assert.equal(socket.data.snapshotState.territoryPoints.size, 0);
    assert.equal(socket.data.snapshotState.nextTerritoryPointId, 1);
});

test("volatile snapshots reuse untouched confirmed geometry maps", () => {
    const player = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const socket = createSocket(player.id, {
        networkDiagnosticsEnabled: true,
        roomCode: "ROOM"
    });
    const io = { sockets: { sockets: new Map([[socket.id, socket]]) } };

    initializePlayerTerritory(territories, player);
    sendSnapshot(io, players, territories, "ROOM", null, config);

    const confirmedTerritories = socket.data.snapshotState.territories;
    const confirmedTerritoryPoints = socket.data.snapshotState.territoryPoints;

    player.x = 25;
    sendSnapshot(io, players, territories, "ROOM", null, config);

    const latestSnapshot = socket.emitted.at(-1).payload;

    assert.equal(socket.data.pendingReliableSnapshot, null);
    assert.strictEqual(socket.data.snapshotState.territories, confirmedTerritories);
    assert.strictEqual(socket.data.snapshotState.territoryPoints, confirmedTerritoryPoints);
    assert.equal(Number.isFinite(latestSnapshot.networkDiagnostics.snapshotStateDraftMs), true);
    assert.equal(Number.isFinite(latestSnapshot.networkDiagnostics.snapshotStateCommitMs), true);
    assert.equal(
        latestSnapshot.networkDiagnostics.snapshotStateTerritoryPointCount,
        confirmedTerritoryPoints.size
    );
    assert.equal(
        Number.isFinite(latestSnapshot.networkDiagnostics.lastSnapshotStateCommit.durationMs),
        true
    );
});

test("shared snapshot frame remains optional for direct serializer callers", () => {
    const player = new Player("viewer", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const numberSystem = { serialize: () => ({ nums: [], theme: null }) };

    initializePlayerTerritory(territories, player);
    const sharedFrame = createSnapshotSharedFrame(players, territories, numberSystem, config);
    const snapshot = createSnapshot(
        players,
        territories,
        player.id,
        createClientSnapshotState(),
        numberSystem,
        config,
        sharedFrame
    );

    assert.equal(Object.isFrozen(sharedFrame), true);
    assert.equal(snapshot.time, sharedFrame.time);
    assert.strictEqual(snapshot.numbers, sharedFrame.numbers);
    assert.strictEqual(snapshot.leaderboard, sharedFrame.leaderboard);
    assert.strictEqual(snapshot.roomConfig, sharedFrame.roomConfig);
});

test("snapshot interest culling excludes remote positions and numbers", () => {
    const viewer = new Player("viewer", { x: 0, y: 0 });
    const nearby = new Player("nearby", { x: 1000, y: 0 });
    const remote = new Player("remote", { x: 4000, y: 0 });
    const players = new Map([
        [viewer.id, viewer],
        [nearby.id, nearby],
        [remote.id, remote]
    ]);
    const territories = createTerritories();
    const numberSystem = {
        serialize: () => ({
            nums: [
                [1, 1200, 0, "1", 1, 100],
                [2, 4000, 0, "2", 2, 200]
            ],
            theme: null,
            themeEndsIn: 30
        })
    };

    initializePlayerTerritory(territories, viewer);
    initializePlayerTerritory(territories, nearby);
    initializePlayerTerritory(territories, remote);

    const snapshot = createSnapshot(
        players,
        territories,
        viewer.id,
        createClientSnapshotState(),
        numberSystem,
        config
    );

    assert.ok(snapshot.players[viewer.id]);
    assert.ok(snapshot.players[nearby.id]);
    assert.equal(snapshot.players[remote.id], undefined);
    assert.deepEqual(
        snapshot.numbers.nums.map(number => number[0]),
        [1]
    );
    assert.equal(snapshot.leaderboard.length, 3);
    assert.equal(snapshot.numbers.themeEndsIn, 30);
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

test("schema 4 accumulates trail points between reliable checkpoints", () => {
    const viewer = new Player("viewer", { x: 30, y: 0 });
    const players = new Map([[viewer.id, viewer]]);
    const territories = createTerritories();
    const clientState = createClientSnapshotState({ snapshotSchema: 4 });

    initializePlayerTerritory(territories, viewer);
    viewer.trailLeftSegments = [[
        { x: 0, y: -20 },
        { x: 15, y: -20 }
    ]];
    viewer.trailRightSegments = [[
        { x: 0, y: 20 },
        { x: 15, y: 20 }
    ]];
    viewer.trailLeftFillPath = [...viewer.trailLeftSegments[0]];
    viewer.trailRightFillPath = [...viewer.trailRightSegments[0]];

    const initial = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.ok(initial.trails[viewer.id]);

    const nextLeft = { x: 30, y: -18 };
    const nextRight = { x: 30, y: 22 };
    viewer.trailLeftSegments[0].push(nextLeft);
    viewer.trailRightSegments[0].push(nextRight);
    viewer.trailLeftFillPath.push(nextLeft);
    viewer.trailRightFillPath.push(nextRight);

    const deferred = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.equal(Object.hasOwn(deferred.trails, viewer.id), false);
    assert.ok(deferred.trailIds.includes(viewer.id));

    clientState.trails.get(viewer.id).lastUpdateSentAt = (
        Date.now() - config.network.trailCheckpointIntervalMs - 1
    );
    const checkpoint = createSnapshot(
        players,
        territories,
        viewer.id,
        clientState,
        null,
        config
    );

    assert.ok(checkpoint.trails[viewer.id]);
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
