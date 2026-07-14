const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const { getPublicMatchCandidates } = require("../src/core/matchmaking");
const roomManager = require("../src/core/roomManager");
const {
    createRoomRuntimeConfig,
    normalizeRoomCustomOptions,
    serializeRoomSettings,
    validateRoomCustomOptions
} = require("../src/core/roomSettings");
const { Player } = require("../src/entities/player");
const {
    applyCapturedPolygon,
    createTerritories,
    getTerritoryOverlapRepairQueueDiagnostics,
    initializePlayerTerritory,
    isPointOwnedByPlayer,
    processTerritoryOverlapRepairQueue
} = require("../src/state/territories");
const {
    calculatePolygonIntersectionArea,
    calculatePolygonArea,
    doPolygonsHavePositiveAreaOverlap,
    getPolygonBounds,
    subtractKnownSimplePolygonComponents,
    subtractPolygon,
    subtractPolygonComponents,
    unionPolygons
} = require("../src/utils/geometry");
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
const registerSocket = require("../src/core/socketHandler");
const {
    createBotManager,
    getBotPlayerCount,
    getHumanPlayerCount
} = require("../src/systems/botSystem");
const { updatePlayer, updatePlayers } = require("../src/systems/movementSystem");
const { updatePlayerTrail, updateTrails } = require("../src/systems/trailSystem");
const {
    clearCatchEliminationMarksForTarget,
    confirmCatchEliminationTargets,
    createCatchCombatFrame,
    endPlayerGame,
    handleNumberCollected,
    handlePlayerLifeLoss,
    handleSuccessfulTrailCapture,
    resolveCatchCombatFrame
} = require("../src/systems/catchModeSystem");
const {
    activateSpectator,
    pickHighestRankedPlayerId,
    redirectSpectatorsAfterPlayerExit
} = require("../src/systems/spectatorSystem");

test("trail fill is generated in every cardinal movement direction", () => {
    const directions = [
        ["east", 0],
        ["south", Math.PI / 2],
        ["west", Math.PI],
        ["north", -Math.PI / 2]
    ];

    for (const [name, angle] of directions) {
        const player = new Player(`trail-${name}`, { x: 0, y: 0 }, {
            color: "#ff0000"
        });
        const players = new Map([[player.id, player]]);
        const territories = createTerritories();

        initializePlayerTerritory(territories, player);
        player.angle = angle;
        updatePlayerTrail(player, territories, players);

        for (let step = 1; step <= 30; step++) {
            player.x = Math.cos(angle) * config.territory.trailPointSpacing * step;
            player.y = Math.sin(angle) * config.territory.trailPointSpacing * step;
            updatePlayerTrail(player, territories, players);
        }

        assert.ok(player.trailLeftFillPath.length >= 2, `${name} left fill path`);
        assert.ok(player.trailRightFillPath.length >= 2, `${name} right fill path`);
    }
});

function createSquareTerritory(size) {
    return {
        polygon: [[
            [0, 0],
            [size, 0],
            [size, size],
            [0, size],
            [0, 0]
        ]]
    };
}

test("territory cut keeps the component containing its owner", () => {
    const { territories, capturedPolygon } = createCutScenario();
    const players = new Map([[
        "victim",
        createCutPlayerState({
            x: 15,
            y: 50
        })
    ]]);

    applyCapturedPolygon(territories, "attacker", capturedPolygon, {
        ownerPolygon: capturedPolygon,
        players
    });

    assert.equal(isPointOwnedByPlayer(territories, "victim", 15, 50), true);
    assert.equal(isPointOwnedByPlayer(territories, "victim", 80, 50), false);
    assert.equal(calculatePolygonArea(territories.get("victim").polygon), 3000);
});

test("territory cut follows the owner's trail connection while the owner is outside", () => {
    const { territories, capturedPolygon } = createCutScenario();
    const players = new Map([[
        "victim",
        createCutPlayerState({
            x: 130,
            y: 50,
            isLeftTrailActive: true,
            isRightTrailActive: true,
            trailLeftSegments: [[
                { x: 0, y: 45 },
                { x: -30, y: 45 },
                { x: -30, y: 140 },
                { x: 130, y: 140 },
                { x: 130, y: 50 }
            ]],
            trailRightSegments: [[
                { x: 0, y: 55 },
                { x: -40, y: 55 },
                { x: -40, y: 150 },
                { x: 130, y: 150 },
                { x: 130, y: 50 }
            ]]
        })
    ]]);

    applyCapturedPolygon(territories, "attacker", capturedPolygon, {
        ownerPolygon: capturedPolygon,
        players
    });

    assert.equal(isPointOwnedByPlayer(territories, "victim", 15, 50), true);
    assert.equal(isPointOwnedByPlayer(territories, "victim", 80, 50), false);
    assert.equal(calculatePolygonArea(territories.get("victim").polygon), 3000);
});

function createSocket(id, data = {}) {
    const emitted = [];
    const handlers = new Map();
    const socket = {
        connected: true,
        data: { ...data },
        disconnectCalls: 0,
        emitted,
        handlers,
        id,
        disconnect() {
            socket.connected = false;
            socket.disconnectCalls++;
        },
        emit(event, payload, acknowledge) {
            emitted.push({ event, payload });
            if (typeof acknowledge === "function") {
                acknowledge(null, { applied: true });
            }
        },
        join() {
        },
        leave() {
        },
        on(event, handler) {
            handlers.set(event, handler);
        },
        timeout() {
            return socket;
        },
        trigger(event, ...args) {
            const handler = handlers.get(event);
            if (handler) handler(...args);
        }
    };

    socket.volatile = {
        emit: socket.emit.bind(socket)
    };

    return socket;
}

test("self-trail life loss clears pending remote elimination marks", () => {
    const attacker = new Player("attacker", { x: 1000, y: 1000 }, { maxLives: 3 });
    const target = new Player("target", { x: 0, y: 0 }, { maxLives: 3 });
    const players = new Map([
        [attacker.id, attacker],
        [target.id, target]
    ]);
    const territories = createTerritories();

    initializePlayerTerritory(territories, attacker);
    initializePlayerTerritory(territories, target);
    target.x += config.world.initialTerritoryRadius * 2;
    attacker.queueCatchEliminationTarget(target.id);

    handlePlayerLifeLoss(players, territories, target, {}, {
        reason: "selfTrail"
    });

    assert.equal(target.lives, 2);
    assert.equal(attacker.pendingCatchEliminationTargets.has(target.id), false);

    handleNumberCollected(players, territories, {
        playerId: attacker.id,
        belongsToTheme: true
    });

    assert.equal(target.lives, 2);
});

test("returning to the territory clears every mark against the target", () => {
    const marker = new Player("marker", { x: 0, y: 0 }, { maxLives: 3 });
    const trailOwner = new Player("trail-owner", { x: 1000, y: 1000 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    marker.queueCatchEliminationTarget(trailOwner.id);

    clearCatchEliminationMarksForTarget(players, trailOwner.id);

    assert.equal(marker.lives, 3);
    assert.equal(trailOwner.eliminations, 0);
    assert.equal(marker.pendingCatchEliminationTargets.has(trailOwner.id), false);
});

test("trail update clears the mark when its owner reenters the territory", () => {
    const marker = new Player("marker", { x: 1000, y: 1000 }, { maxLives: 3 });
    const trailOwner = new Player("trail-owner", { x: 0, y: 0 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    const territories = createTerritories();

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, trailOwner);
    marker.queueCatchEliminationTarget(trailOwner.id);
    trailOwner.angle = 0;
    trailOwner.isLeftTrailActive = true;
    trailOwner.isRightTrailActive = true;
    trailOwner.lastLeftTrailPoint = { x: 250, y: 35 };
    trailOwner.lastRightTrailPoint = { x: 250, y: -35 };
    trailOwner.trailLeftSegments = [[
        { x: 200, y: 35 },
        { x: 250, y: 35 }
    ]];
    trailOwner.trailRightSegments = [[
        { x: 200, y: -35 },
        { x: 250, y: -35 }
    ]];

    updatePlayerTrail(trailOwner, territories, players);

    assert.equal(marker.pendingCatchEliminationTargets.has(trailOwner.id), false);
    assert.equal(trailOwner.trailLeftSegments.length, 0);
    assert.equal(trailOwner.trailRightSegments.length, 0);
});

test("trail update clears outgoing marks when the marker returns to their territory", () => {
    const marker = new Player("marker", { x: 0, y: 0 }, { maxLives: 3 });
    const trailOwner = new Player("trail-owner", { x: 1000, y: 1000 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    const territories = createTerritories();

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, trailOwner);
    trailOwner.x += config.world.initialTerritoryRadius * 2;
    marker.queueCatchEliminationTarget(trailOwner.id);
    marker.angle = 0;
    marker.isLeftTrailActive = true;
    marker.isRightTrailActive = true;
    marker.lastLeftTrailPoint = { x: 250, y: 35 };
    marker.lastRightTrailPoint = { x: 250, y: -35 };
    marker.trailLeftSegments = [[
        { x: 200, y: 35 },
        { x: 250, y: 35 }
    ]];
    marker.trailRightSegments = [[
        { x: 200, y: -35 },
        { x: 250, y: -35 }
    ]];

    updatePlayerTrail(marker, territories, players);
    handleNumberCollected(players, territories, {
        playerId: marker.id,
        belongsToTheme: true
    });

    assert.equal(marker.pendingCatchEliminationTargets.has(trailOwner.id), false);
    assert.equal(marker.eliminations, 0);
    assert.equal(trailOwner.lives, 3);
});

test("a player inside their territory is immune to marks and mark damage", () => {
    const marker = new Player("marker", { x: 1000, y: 1000 }, { maxLives: 3 });
    const protectedPlayer = new Player("protected", { x: 0, y: 0 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [protectedPlayer.id, protectedPlayer]
    ]);
    const territories = createTerritories();

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, protectedPlayer);
    marker.queueCatchEliminationTarget(protectedPlayer.id);

    handleNumberCollected(players, territories, {
        playerId: marker.id,
        belongsToTheme: true
    });

    assert.equal(protectedPlayer.lives, 3);
    assert.equal(marker.eliminations, 0);
    assert.equal(marker.pendingCatchEliminationTargets.has(protectedPlayer.id), false);
});

test("being engulfed by a capture still removes life inside the territory", () => {
    const attacker = new Player("attacker", { x: 1000, y: 1000 }, { maxLives: 3 });
    const protectedPlayer = new Player("protected", { x: 0, y: 0 }, { maxLives: 3 });
    const players = new Map([
        [attacker.id, attacker],
        [protectedPlayer.id, protectedPlayer]
    ]);
    const territories = createTerritories();

    initializePlayerTerritory(territories, attacker);
    initializePlayerTerritory(territories, protectedPlayer);

    handlePlayerLifeLoss(players, territories, protectedPlayer, {}, {
        attacker,
        reason: "captured"
    });

    assert.equal(protectedPlayer.lives, 2);
});

test("crossing a stale trail does not mark its owner while they are protected", () => {
    const crosser = new Player("crosser", { x: 1000, y: 1000 }, { maxLives: 3 });
    const protectedPlayer = new Player("protected", { x: 0, y: 0 }, { maxLives: 3 });
    const players = new Map([
        [crosser.id, crosser],
        [protectedPlayer.id, protectedPlayer]
    ]);
    const territories = createTerritories();

    initializePlayerTerritory(territories, crosser);
    initializePlayerTerritory(territories, protectedPlayer);
    crosser.x = 50;
    crosser.y = 0;
    crosser.angle = 0;
    crosser.lastLeftTrailPoint = { x: -50, y: 35 };
    crosser.lastRightTrailPoint = { x: -50, y: -35 };
    protectedPlayer.trailLeftSegments = [[
        { x: 0, y: -100 },
        { x: 0, y: 100 }
    ]];
    protectedPlayer.trailRightSegments = [[
        { x: 10, y: -100 },
        { x: 10, y: 100 }
    ]];

    updatePlayerTrail(crosser, territories, players);

    assert.equal(
        crosser.pendingCatchEliminationTargets.has(protectedPlayer.id),
        false
    );
});

test("a cleared mark cannot be confirmed after the target returns", () => {
    const marker = new Player("marker", { x: 0, y: 0 }, { maxLives: 3 });
    const trailOwner = new Player("trail-owner", { x: 1000, y: 1000 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    const territories = createTerritories();
    const combatFrame = createCatchCombatFrame();
    const context = {
        catchCombatFrame: combatFrame,
        runtimeConfig: config
    };

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, trailOwner);
    marker.queueCatchEliminationTarget(trailOwner.id);

    clearCatchEliminationMarksForTarget(players, trailOwner.id);
    handleNumberCollected(players, territories, {
        playerId: marker.id,
        belongsToTheme: true
    }, context);
    resolveCatchCombatFrame(players, territories, context);

    assert.equal(trailOwner.lives, 3);
    assert.equal(marker.eliminations, 0);
    assert.equal(marker.pendingCatchEliminationTargets.has(trailOwner.id), false);
});

test("a correct collection still confirms a mark while the target is outside", () => {
    const marker = new Player("marker", { x: 0, y: 0 }, { maxLives: 3 });
    const trailOwner = new Player("trail-owner", { x: 1000, y: 1000 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    const territories = createTerritories();
    const combatFrame = createCatchCombatFrame();
    const context = {
        catchCombatFrame: combatFrame,
        runtimeConfig: config
    };

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, trailOwner);
    trailOwner.x += config.world.initialTerritoryRadius * 2;
    marker.queueCatchEliminationTarget(trailOwner.id);

    handleNumberCollected(players, territories, {
        playerId: marker.id,
        belongsToTheme: true
    }, context);
    resolveCatchCombatFrame(players, territories, context);

    assert.equal(marker.lives, 3);
    assert.equal(trailOwner.lives, 2);
    assert.equal(marker.eliminations, 1);
    assert.equal(trailOwner.eliminations, 0);
});

test("a successful stored-balance capture can confirm a pending mark without collecting a number", () => {
    const marker = new Player("marker", { x: 0, y: 0 }, { maxLives: 3 });
    const trailOwner = new Player("trail-owner", { x: 1000, y: 1000 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    const territories = createTerritories();
    const context = {
        catchCombatFrame: createCatchCombatFrame()
    };

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, trailOwner);
    trailOwner.x += config.world.initialTerritoryRadius * 2;
    marker.queueCatchEliminationTarget(trailOwner.id);

    confirmCatchEliminationTargets(players, territories, marker, context);
    resolveCatchCombatFrame(players, territories, context);

    assert.equal(trailOwner.lives, 2);
    assert.equal(marker.eliminations, 1);
    assert.equal(marker.pendingCatchEliminationTargets.has(trailOwner.id), false);
});

test("return before the countdown ends cancels the counterattack", () => {
    const marker = new Player("marker", { x: 0, y: 0 }, { maxLives: 3 });
    const trailOwner = new Player("trail-owner", { x: 1000, y: 1000 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    const territories = createTerritories();
    const context = {
        catchCombatFrame: createCatchCombatFrame(2000),
        runtimeConfig: config
    };

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, trailOwner);
    marker.x += config.world.initialTerritoryRadius * 2;
    marker.queueCatchEliminationTarget(trailOwner.id, 1000);

    handleSuccessfulTrailCapture(players, territories, trailOwner, context);
    resolveCatchCombatFrame(players, territories, context);

    assert.equal(marker.lives, 3);
    assert.equal(trailOwner.eliminations, 0);
    assert.equal(marker.pendingCatchEliminationTargets.has(trailOwner.id), false);
});

test("return after the countdown ends executes and clears the counterattack", () => {
    const marker = new Player("marker", { x: 0, y: 0 }, { maxLives: 3 });
    const trailOwner = new Player("trail-owner", { x: 1000, y: 1000 }, { maxLives: 3 });
    const players = new Map([
        [marker.id, marker],
        [trailOwner.id, trailOwner]
    ]);
    const territories = createTerritories();
    const context = {
        catchCombatFrame: createCatchCombatFrame(2300),
        runtimeConfig: config
    };

    initializePlayerTerritory(territories, marker);
    initializePlayerTerritory(territories, trailOwner);
    marker.x += config.world.initialTerritoryRadius * 2;
    marker.queueCatchEliminationTarget(trailOwner.id, 1000);

    handleSuccessfulTrailCapture(players, territories, trailOwner, context);
    resolveCatchCombatFrame(players, territories, context);

    assert.equal(marker.lives, 2);
    assert.equal(trailOwner.eliminations, 1);
    assert.equal(marker.pendingCatchEliminationTargets.has(trailOwner.id), false);
});

test("a player can lose at most one life in the same combat tick", () => {
    const target = new Player("target", { x: 0, y: 0 }, { maxLives: 3 });
    const players = new Map([[target.id, target]]);
    const territories = createTerritories();
    const context = {
        catchCombatFrame: createCatchCombatFrame(2000)
    };

    initializePlayerTerritory(territories, target);
    target.x += config.world.initialTerritoryRadius * 2;

    handlePlayerLifeLoss(players, territories, target, context, {
        reason: "selfTrail"
    });
    handlePlayerLifeLoss(players, territories, target, context, {
        reason: "captured"
    });

    assert.equal(target.lives, 2);
});

test("simultaneous confirmations award only one elimination and one life loss", () => {
    const firstAttacker = new Player("first-attacker", { x: -1000, y: 0 }, { maxLives: 3 });
    const secondAttacker = new Player("second-attacker", { x: 1000, y: 0 }, { maxLives: 3 });
    const target = new Player("target", { x: 0, y: 0 }, { maxLives: 3 });
    const players = new Map([
        [firstAttacker.id, firstAttacker],
        [secondAttacker.id, secondAttacker],
        [target.id, target]
    ]);
    const territories = createTerritories();
    const context = {
        catchCombatFrame: createCatchCombatFrame(2000),
        runtimeConfig: config
    };

    initializePlayerTerritory(territories, firstAttacker);
    initializePlayerTerritory(territories, secondAttacker);
    initializePlayerTerritory(territories, target);
    target.x += config.world.initialTerritoryRadius * 2;
    firstAttacker.queueCatchEliminationTarget(target.id);
    secondAttacker.queueCatchEliminationTarget(target.id);

    handleNumberCollected(players, territories, {
        playerId: firstAttacker.id,
        belongsToTheme: true
    }, context);
    handleNumberCollected(players, territories, {
        playerId: secondAttacker.id,
        belongsToTheme: true
    }, context);
    resolveCatchCombatFrame(players, territories, context);

    assert.equal(target.lives, 2);
    assert.equal(firstAttacker.eliminations + secondAttacker.eliminations, 1);
});

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

test("capture apply repairs post-capture owner territory overlaps", () => {
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", createRectanglePolygon(0, 0, 10, 10))],
        ["neighbor", createCutTerritoryState("neighbor", createRectanglePolygon(8, 8, 20, 20))]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(territories, "attacker", createRectanglePolygon(-5, 0, 0, 10), {
        captureOverlapAudit: true,
        diagnostics
    });

    assert.equal(diagnostics.captureApply.postCaptureOverlapCount, 1);
    assert.equal(diagnostics.captureApply.postCaptureOverlapRepairCount, 1);
    assert.equal(diagnostics.captureApply.postCaptureOverlapRepairChangedCount, 1);
    assert.equal(diagnostics.captureApply.postCaptureOverlapFirst.firstId, "attacker");
    assert.equal(diagnostics.captureApply.postCaptureOverlapFirst.secondId, "neighbor");
    assert.ok(diagnostics.captureApply.postCaptureOverlapFirst.overlapArea > 0);
    assert.equal(
        calculatePolygonIntersectionArea(
            territories.get("attacker").polygon,
            territories.get("neighbor").polygon
        ),
        0
    );
    assert.equal(isPointOwnedByPlayer(territories, "neighbor", 9, 9), false);
});

test("capture apply repairs overlaps involving changed non-owner territories", () => {
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", createRectanglePolygon(0, 0, 10, 10))],
        ["victim", createCutTerritoryState("victim", createRectanglePolygon(12, 0, 30, 10))],
        ["third", createCutTerritoryState("third", createRectanglePolygon(25, 0, 40, 10))]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(territories, "attacker", createRectanglePolygon(10, 0, 15, 10), {
        diagnostics,
        ownerPolygon: createRectanglePolygon(0, 0, 15, 10)
    });

    assert.equal(
        calculatePolygonIntersectionArea(
            territories.get("victim").polygon,
            territories.get("third").polygon
        ),
        0
    );
    assert.equal(isPointOwnedByPlayer(territories, "third", 27, 5), false);
    assert.equal(diagnostics.captureApply.postCaptureOverlapRepairChangedCount >= 1, true);
});

test("capture overlap audit ignores territories that only touch at the edge", () => {
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", createRectanglePolygon(0, 0, 10, 10))],
        ["neighbor", createCutTerritoryState("neighbor", createRectanglePolygon(10, 0, 20, 10))]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(territories, "attacker", createRectanglePolygon(-5, 0, 0, 10), {
        captureOverlapAudit: true,
        diagnostics
    });

    assert.equal(diagnostics.captureApply.postCaptureOverlapCount, 0);
});

test("overlap repair queue uses one subtraction for dense territories", async () => {
    const initialOwnerPolygon = createDenseRectanglePolygon(0, 0, 100, 100, 160);
    const expandedOwnerPolygon = createDenseRectanglePolygon(-10, 0, 100, 100, 160);
    const victimPolygon = createDenseRectanglePolygon(80, 0, 180, 100, 160);
    const territories = new Map([
        ["owner", createCutTerritoryState("owner", initialOwnerPolygon)],
        ["victim", createCutTerritoryState("victim", victimPolygon)]
    ]);
    const players = new Map([[
        "victim",
        createCutPlayerState({
            x: 150,
            y: 50
        })
    ]]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-10, 0, 0, 100),
        {
            diagnostics,
            ownerPolygon: expandedOwnerPolygon,
            players
        }
    );

    assert.ok(calculatePolygonIntersectionArea(
        territories.get("owner").polygon,
        territories.get("victim").polygon
    ) > 1);

    await processTerritoryRepairsUntil(
        territories,
        players,
        diagnostics,
        () => calculatePolygonIntersectionArea(
            territories.get("owner").polygon,
            territories.get("victim").polygon
        ) <= 1
    );

    assert.ok(calculatePolygonIntersectionArea(
        territories.get("owner").polygon,
        territories.get("victim").polygon
    ) <= 1);
    assert.equal(diagnostics.phases.overlapRepairQueuePairIntersection, undefined);
    assert.ok(diagnostics.captureApply.overlapRepairWorkerDispatchedCount >= 1);
    assert.ok(diagnostics.captureApply.overlapRepairWorkerCompletedCount >= 1);
    assert.ok(diagnostics.captureApply.overlapRepairWorkerChangedCount >= 1);
});

test("dense territories touching at the edge are not changed by overlap repair", () => {
    const initialOwnerPolygon = createDenseRectanglePolygon(0, 0, 100, 100, 160);
    const expandedOwnerPolygon = createDenseRectanglePolygon(-10, 0, 100, 100, 160);
    const neighborPolygon = createDenseRectanglePolygon(100, 0, 200, 100, 160);
    const territories = new Map([
        ["owner", createCutTerritoryState("owner", initialOwnerPolygon)],
        ["neighbor", createCutTerritoryState("neighbor", neighborPolygon)]
    ]);
    const diagnostics = { phases: {} };
    const neighborVersion = territories.get("neighbor").version;

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-10, 0, 0, 100),
        {
            diagnostics,
            ownerPolygon: expandedOwnerPolygon
        }
    );
    processTerritoryOverlapRepairQueue(territories, new Map(), {
        diagnostics
    });

    assert.equal(
        calculatePolygonIntersectionArea(
            territories.get("owner").polygon,
            territories.get("neighbor").polygon
        ),
        0
    );
    assert.equal(territories.get("neighbor").version, neighborVersion);
    assert.equal(diagnostics.captureApply.postCaptureOverlapCount, 0);
    assert.equal(diagnostics.phases.overlapRepairQueuePairIntersection, undefined);
    assert.equal(diagnostics.phases.overlapRepairQueuePairAreaConfirmation, undefined);
    assert.equal(diagnostics.phases.overlapRepairQueuePairSubtract, undefined);
    assert.equal(diagnostics.phases.overlapRepairQueuePairSubtractAmbiguousIntersection, undefined);
});

test("stale territory repair worker results are discarded by version", async () => {
    const initialOwnerPolygon = createDenseRectanglePolygon(0, 0, 100, 100, 160);
    const expandedOwnerPolygon = createDenseRectanglePolygon(-10, 0, 100, 100, 160);
    const victimPolygon = createDenseRectanglePolygon(80, 0, 180, 100, 160);
    const replacementPolygon = createRectanglePolygon(300, 0, 400, 100);
    const territories = new Map([
        ["owner", createCutTerritoryState("owner", initialOwnerPolygon)],
        ["victim", createCutTerritoryState("victim", victimPolygon)]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-10, 0, 0, 100),
        {
            diagnostics,
            ownerPolygon: expandedOwnerPolygon
        }
    );
    processTerritoryOverlapRepairQueue(territories, new Map(), {
        diagnostics
    });

    assert.ok(diagnostics.captureApply.overlapRepairWorkerDispatchedCount >= 1);
    replaceTerritoryPolygon(territories.get("victim"), replacementPolygon);
    const replacementVersion = territories.get("victim").version;

    await processTerritoryRepairsUntil(
        territories,
        new Map(),
        diagnostics,
        () => diagnostics.captureApply.overlapRepairWorkerStaleCount >= 1
    );

    assert.equal(territories.get("victim").version, replacementVersion);
    assert.equal(isPointOwnedByPlayer(territories, "victim", 350, 50), true);
    assert.equal(isPointOwnedByPlayer(territories, "victim", 90, 50), false);
    assert.equal(diagnostics.captureApply.overlapRepairWorkerChangedCount, 0);
});

test("pending dense overlap repair restarts after another owner mutation", async () => {
    const initialOwnerPolygon = createDenseRectanglePolygon(-100, 0, -50, 100, 160);
    const firstOwnerPolygon = createDenseRectanglePolygon(0, 0, 100, 100, 160);
    const secondOwnerPolygon = createDenseRectanglePolygon(0, 0, 120, 100, 160);
    const territories = new Map([
        ["owner", createCutTerritoryState("owner", initialOwnerPolygon)],
        ["first", createCutTerritoryState(
            "first",
            createDenseRectanglePolygon(80, 0, 180, 30, 160)
        )],
        ["second", createCutTerritoryState(
            "second",
            createDenseRectanglePolygon(80, 35, 180, 65, 160)
        )],
        ["third", createCutTerritoryState(
            "third",
            createDenseRectanglePolygon(80, 70, 180, 100, 160)
        )]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-120, 0, -110, 10),
        {
            diagnostics,
            ownerPolygon: firstOwnerPolygon
        }
    );
    processTerritoryOverlapRepairQueue(territories, new Map(), {
        diagnostics
    });

    assert.ok(diagnostics.captureApply.overlapRepairWorkerDispatchedCount >= 1);
    assert.ok(
        diagnostics.captureApply.overlapRepairWorkerBackpressureCount >= 1
            || diagnostics.captureApply.overlapRepairQueueBudgetHitCount >= 1,
        "remaining repair should be deferred by worker capacity or the tick budget"
    );
    const queueBeforeMutation = getTerritoryOverlapRepairQueueDiagnostics(territories);

    assert.equal(queueBeforeMutation.completedJobs, 0);
    assert.ok(queueBeforeMutation.inFlightPairs >= 1);
    assert.ok(queueBeforeMutation.pendingItems >= 1);
    assert.equal(queueBeforeMutation.refreshRequests, 0);

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-140, 0, -130, 10),
        {
            diagnostics,
            ownerPolygon: secondOwnerPolygon
        }
    );

    await processTerritoryRepairsUntil(
        territories,
        new Map(),
        diagnostics,
        () => ["first", "second", "third"].every(id => (
            calculatePolygonIntersectionArea(
                territories.get("owner").polygon,
                territories.get(id).polygon
            ) <= 1
        ))
    );

    assert.ok(diagnostics.captureApply.overlapRepairQueueRefreshCount >= 1);
    assert.ok(diagnostics.captureApply.overlapRepairWorkerStaleCount >= 1);
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

test("positive-area overlap predicate distinguishes shared borders from aligned overlap", () => {
    const first = createRectanglePolygon(0, 0, 100, 100);

    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, createRectanglePolygon(100, 0, 200, 100)),
        false
    );
    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, createRectanglePolygon(100, 100, 200, 200)),
        false
    );
    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, createRectanglePolygon(50, 0, 150, 100)),
        true
    );
    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, createRectanglePolygon(25, 25, 75, 75)),
        true
    );
    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, [[
            [50, -20],
            [120, 50],
            [50, 120],
            [-20, 50],
            [50, -20]
        ]]),
        true
    );
    assert.equal(doPolygonsHavePositiveAreaOverlap(first, first), true);
});

test("deterministic capture soak preserves territory geometry invariants", async () => {
    const random = createSeededRandom(0x7e22170);
    const territoryEntries = [
        ["northWest", -180, -180],
        ["northEast", 180, -180],
        ["southWest", -180, 180],
        ["southEast", 180, 180]
    ];
    const territories = new Map();
    const players = new Map();
    const versions = new Map();
    const diagnostics = { phases: {} };

    for (const [id, x, y] of territoryEntries) {
        territories.set(
            id,
            createCutTerritoryState(id, createRectanglePolygon(x - 45, y - 45, x + 45, y + 45))
        );
        players.set(id, createCutPlayerState({ id, x, y }));
        versions.set(id, territories.get(id).version);
    }

    for (let captureIndex = 0; captureIndex < 32; captureIndex++) {
        const [ownerId] = territoryEntries[Math.floor(random() * territoryEntries.length)];
        const ownerTerritory = territories.get(ownerId);
        const centerX = randomBetween(random, -240, 240);
        const centerY = randomBetween(random, -240, 240);
        const halfWidth = randomBetween(random, 18, 62);
        const halfHeight = randomBetween(random, 18, 62);
        const capturedPolygon = createRectanglePolygon(
            centerX - halfWidth,
            centerY - halfHeight,
            centerX + halfWidth,
            centerY + halfHeight
        );
        const ownerPolygon = unionPolygons(ownerTerritory.polygon, capturedPolygon);

        applyCapturedPolygon(territories, ownerId, capturedPolygon, {
            diagnostics,
            ownerPolygon,
            players
        });

        await processTerritoryRepairsUntil(
            territories,
            players,
            diagnostics,
            () => getMaximumTerritoryOverlapArea(territories) <= 1
        );
        assertTerritoryGeometryInvariants(territories, versions);
    }

    assert.ok(diagnostics.captureApply.calls >= 32);
    assert.equal(getMaximumTerritoryOverlapArea(territories) <= 1, true);
});

test("capture subtraction keeps dense operands exact", () => {
    const attackerPolygon = createRectanglePolygon(-100, -100, -90, -90);
    const victimPolygon = createCircleLikePolygon(0, 0, 100, 640);
    const denseCapture = createCircleLikePolygon(100, 0, 30, 320);
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", attackerPolygon)],
        ["victim", createCutTerritoryState("victim", victimPolygon)]
    ]);
    const diagnostics = { phases: {} };
    const expectedVictimPolygon = subtractPolygon(victimPolygon, denseCapture);

    applyCapturedPolygon(territories, "attacker", denseCapture, {
        diagnostics,
        ownerPolygon: attackerPolygon
    });

    assert.equal(diagnostics.captureApply.subtractCount, 1);
    assert.deepEqual(territories.get("victim").polygon, expectedVictimPolygon);
    assert.equal(
        diagnostics.captureApply.slowestSubtract.operationClippingPointCount,
        diagnostics.captureApply.slowestSubtract.clippingPointCount
    );
    assert.equal(
        diagnostics.captureApply.slowestSubtract.operationSubjectPointCount,
        diagnostics.captureApply.slowestSubtract.subjectPointCount
    );
});

test("known-simple territory subtraction matches the validated geometry path", () => {
    const cases = [
        {
            clipping: createCircleLikePolygon(100, 0, 30, 320),
            subject: createCircleLikePolygon(0, 0, 100, 640)
        },
        {
            clipping: createRectanglePolygon(-10, -60, 10, 60),
            subject: createRectanglePolygon(-50, -50, 50, 50)
        },
        {
            clipping: createRectanglePolygon(50, -20, 80, 20),
            subject: createRectanglePolygon(-50, -50, 50, 50)
        }
    ];

    for (const { subject, clipping } of cases) {
        assert.deepEqual(
            subtractKnownSimplePolygonComponents(subject, clipping),
            subtractPolygonComponents(subject, clipping)
        );
    }
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

test("spectator follows the preferred eliminator and falls back to rank leader", () => {
    const leader = new Player("leader", { x: 0, y: 0 });
    const eliminator = new Player("eliminator", { x: 10, y: 10 });
    const players = new Map([
        [leader.id, leader],
        [eliminator.id, eliminator]
    ]);
    const territories = new Map([
        [leader.id, createSquareTerritory(100)],
        [eliminator.id, createSquareTerritory(50)]
    ]);
    const spectator = createSocket("spectator");

    assert.equal(pickHighestRankedPlayerId(players, territories), leader.id);
    assert.equal(
        activateSpectator(spectator, "ROOM", players, territories, eliminator.id),
        eliminator.id
    );

    players.delete(eliminator.id);
    territories.delete(eliminator.id);

    redirectSpectatorsAfterPlayerExit(
        { sockets: { sockets: new Map([[spectator.id, spectator]]) } },
        "ROOM",
        players,
        territories,
        eliminator.id
    );

    assert.equal(spectator.data.spectatorFollowId, leader.id);
});

test("spectator follows an elimination chain before falling back to the rank leader", () => {
    const first = new Player("first", { x: 0, y: 0 });
    const second = new Player("second", { x: 10, y: 10 });
    const third = new Player("third", { x: 20, y: 20 });
    const leader = new Player("leader", { x: 30, y: 30 });
    const players = new Map([
        [first.id, first],
        [second.id, second],
        [third.id, third],
        [leader.id, leader]
    ]);
    const territories = new Map([
        [first.id, createSquareTerritory(40)],
        [second.id, createSquareTerritory(50)],
        [third.id, createSquareTerritory(60)],
        [leader.id, createSquareTerritory(100)]
    ]);
    const spectator = createSocket("spectator");
    const io = { sockets: { sockets: new Map([[spectator.id, spectator]]) } };

    activateSpectator(spectator, "ROOM", players, territories, first.id);

    players.delete(first.id);
    territories.delete(first.id);
    redirectSpectatorsAfterPlayerExit(
        io,
        "ROOM",
        players,
        territories,
        first.id,
        second.id
    );
    assert.equal(spectator.data.spectatorFollowId, second.id);

    players.delete(second.id);
    territories.delete(second.id);
    redirectSpectatorsAfterPlayerExit(
        io,
        "ROOM",
        players,
        territories,
        second.id,
        third.id
    );
    assert.equal(spectator.data.spectatorFollowId, third.id);

    players.delete(third.id);
    territories.delete(third.id);
    redirectSpectatorsAfterPlayerExit(
        io,
        "ROOM",
        players,
        territories,
        third.id
    );
    assert.equal(spectator.data.spectatorFollowId, leader.id);
});

test("eliminated player remains connected as a spectator", () => {
    const attacker = new Player("attacker", { x: 0, y: 0 }, { name: "Ataque" });
    const target = new Player("target", { x: 20, y: 20 }, { name: "Alvo" });
    const targetSocket = createSocket(target.id, { roomCode: "ROOM" });
    const io = {
        sockets: {
            sockets: new Map([[target.id, targetSocket]])
        }
    };
    const players = new Map([
        [attacker.id, attacker],
        [target.id, target]
    ]);
    const territories = new Map([
        [attacker.id, createSquareTerritory(100)],
        [target.id, createSquareTerritory(50)]
    ]);
    let populationChangeCount = 0;

    endPlayerGame(players, territories, target, {
        io,
        onRoomPopulationChanged() {
            populationChangeCount++;
        },
        roomCode: "ROOM"
    }, {
        attacker,
        reason: "eliminated"
    });

    const gameOverEvent = targetSocket.emitted.find(event => event.event === "gameOver");

    assert.equal(players.has(target.id), false);
    assert.equal(targetSocket.data.spectatorRoomCode, "ROOM");
    assert.equal(targetSocket.data.spectatorFollowId, attacker.id);
    assert.equal(gameOverEvent.payload.canSpectate, true);
    assert.equal(gameOverEvent.payload.spectatorFollowId, attacker.id);
    assert.equal(getHumanPlayerCount(players), 1);
    assert.equal(populationChangeCount, 1);
});

test("first spectator snapshot initializes after selecting a follow target", () => {
    const leader = new Player("leader", { x: 0, y: 0 });
    const players = new Map([[leader.id, leader]]);
    const territories = createTerritories();
    const spectator = createSocket("spectator", {
        spectatorFollowId: null,
        spectatorRoomCode: "ROOM"
    });

    initializePlayerTerritory(territories, leader);

    assert.doesNotThrow(() => {
        sendSnapshot(
            { sockets: { sockets: new Map([[spectator.id, spectator]]) } },
            players,
            territories,
            "ROOM",
            null
        );
    });
    assert.equal(spectator.data.spectatorFollowId, leader.id);
    assert.ok(spectator.data.snapshotState);
    assert.equal(
        spectator.emitted.find(event => event.event === "gameState").payload.snapshotEpoch,
        spectator.data.snapshotEpoch
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

test("spectator input is ignored before rate limiting", () => {
    const spectator = createSocket("spectator", {
        roomCode: "ROOM",
        spectatorRoomCode: "ROOM"
    });
    const room = {
        code: "ROOM",
        players: new Map(),
        territories: createTerritories()
    };
    const roomManager = {
        createBackgroundRoom() {
            return { success: false };
        },
        leaveRoom() {
            return null;
        },
        listRooms() {
            return [];
        },
        rooms: new Map([[room.code, room]])
    };
    let connectionHandler = null;
    const io = {
        emit() {
        },
        on(event, handler) {
            if (event === "connection") connectionHandler = handler;
        },
        sockets: {
            sockets: new Map([[spectator.id, spectator]])
        },
        to() {
            return { emit() {} };
        }
    };

    registerSocket(io, roomManager);
    connectionHandler(spectator);

    for (let index = 0; index < 200; index++) {
        spectator.trigger("inputDirection", {
            angle: index / 10,
            source: "pointer"
        });
        spectator.trigger("inputDirectionEnd");
        spectator.trigger("viewport", {
            width: 1280,
            height: 720,
            scale: 1
        });
    }

    assert.equal(spectator.disconnectCalls, 0);
});

test("quick match candidates prioritize populated compatible public rooms", () => {
    const rooms = new Map([
        ["EMPTY", createMatchmakingRoom("EMPTY", { createdAt: 1 })],
        ["BUSY", createMatchmakingRoom("BUSY", { createdAt: 3, humanPlayers: 3 })],
        ["OLDER", createMatchmakingRoom("OLDER", { createdAt: 2, humanPlayers: 3 })],
        ["EASY", createMatchmakingRoom("EASY", { difficulty: "easy", humanPlayers: 8 })],
        ["PRIVATE", createMatchmakingRoom("PRIVATE", { humanPlayers: 8, isPrivate: true })],
        ["HIDDEN", createMatchmakingRoom("HIDDEN", { hiddenFromList: true, humanPlayers: 8 })],
        ["SYSTEM", createMatchmakingRoom("SYSTEM", { humanPlayers: 8, isSystemRoom: true })],
        ["FULL", createMatchmakingRoom("FULL", {
            humanPlayers: config.rooms.maxPlayersPerRoom
        })],
        ["CUSTOM_FULL", createMatchmakingRoom("CUSTOM_FULL", {
            humanPlayers: 3,
            maxPlayers: 3
        })]
    ]);

    assert.deepEqual(
        getPublicMatchCandidates(rooms, "medium").map(room => room.code),
        ["OLDER", "BUSY", "EMPTY"]
    );
});

test("quick match joins an existing compatible room without creating another", () => {
    const socket = createSocket("quick-player");
    const io = createMatchmakingIo(socket);
    const existingRoom = createMatchmakingRoom("EXISTING", { humanPlayers: 1 });
    let createRoomCalls = 0;
    const roomManager = {
        createBackgroundRoom() {
            return { success: false };
        },
        createRoom() {
            createRoomCalls++;
            return { success: false, message: "should not create" };
        },
        getPublicMatchCandidates(difficulty) {
            assert.equal(difficulty, "medium");
            return [existingRoom];
        },
        joinRoom(roomCode, joiningSocket) {
            assert.equal(roomCode, existingRoom.code);
            joiningSocket.data.roomCode = roomCode;
            return {
                room: existingRoom,
                spawn: { x: 0, y: 0 },
                success: true
            };
        },
        leaveRoom() {
            return null;
        },
        listRooms() {
            return [];
        },
        rooms: new Map([[existingRoom.code, existingRoom]])
    };

    registerSocket(io, roomManager);
    io.connect();
    socket.trigger("joinRoom", {
        difficulty: "medium",
        player: {
            color: "#ff2626",
            difficulty: "medium",
            name: "Jogador"
        },
        quickMatch: true
    });

    const result = socket.emitted.find(event => event.event === "joinRoomResult");

    assert.equal(createRoomCalls, 0);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.roomCode, existingRoom.code);
    assert.equal(result.payload.reusedRoom, true);
    assert.equal(existingRoom.players.has(socket.id), true);
});

test("quick match creates a public room when no compatible room is available", () => {
    const socket = createSocket("quick-player");
    const io = createMatchmakingIo(socket);
    const createdRoom = createMatchmakingRoom("CREATED");
    let createRoomCalls = 0;
    const roomManager = {
        createBackgroundRoom() {
            return { success: false };
        },
        createRoom(_io, options) {
            createRoomCalls++;
            assert.equal(options.difficulty, "hard");
            assert.equal(options.isPrivate, false);
            assert.equal(options.password, "");
            assert.deepEqual(options.customOptions, {});
            return {
                room: createdRoom,
                success: true
            };
        },
        destroyRoom() {
            throw new Error("new room should not be destroyed");
        },
        getPublicMatchCandidates() {
            return [];
        },
        joinRoom(roomCode, joiningSocket) {
            assert.equal(roomCode, createdRoom.code);
            joiningSocket.data.roomCode = roomCode;
            return {
                room: createdRoom,
                spawn: { x: 0, y: 0 },
                success: true
            };
        },
        leaveRoom() {
            return null;
        },
        listRooms() {
            return [];
        },
        rooms: new Map([[createdRoom.code, createdRoom]])
    };

    registerSocket(io, roomManager);
    io.connect();
    socket.trigger("joinRoom", {
        customOptions: {
            mapSize: 2
        },
        difficulty: "hard",
        isPrivate: true,
        password: "ignored",
        player: {
            difficulty: "hard",
            name: "Jogador"
        },
        quickMatch: true
    });

    const result = socket.emitted.find(event => event.event === "joinRoomResult");

    assert.equal(createRoomCalls, 1);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.roomCode, createdRoom.code);
    assert.equal(result.payload.reusedRoom, undefined);
    assert.equal(createdRoom.players.has(socket.id), true);
});

test("custom room speed scales rotation strength by travelled distance", () => {
    const slowConfig = createRoomRuntimeConfig({ playerSpeed: 0.5 });
    const normalConfig = createRoomRuntimeConfig({ playerSpeed: 1 });
    const fastConfig = createRoomRuntimeConfig({ playerSpeed: 2 });

    assert.ok(slowConfig.movement.rotationStrength < normalConfig.movement.rotationStrength);
    assert.ok(fastConfig.movement.rotationStrength > normalConfig.movement.rotationStrength);
    assert.equal(normalConfig.movement.rotationStrength, config.movement.rotationStrength);
    assert.ok(Math.abs(
        slowConfig.movement.rotationStrength
        - (1 - Math.pow(1 - config.movement.rotationStrength, 0.5))
    ) < 1e-12);
    assert.ok(Math.abs(
        fastConfig.movement.rotationStrength
        - (1 - Math.pow(1 - config.movement.rotationStrength, 2))
    ) < 1e-12);

    const serialized = serializeRoomSettings(fastConfig);
    assert.equal(serialized.movement.rotationStrength, fastConfig.movement.rotationStrength);
});

test("custom rooms normalize and validate player capacity and bot permission", () => {
    const customOptions = normalizeRoomCustomOptions({
        allowBots: false,
        maxPlayers: 4
    });
    const runtimeConfig = createRoomRuntimeConfig({
        allowBots: false,
        maxPlayers: 4
    });
    const serialized = serializeRoomSettings(runtimeConfig);

    assert.equal(customOptions.maxPlayers, 4);
    assert.equal(customOptions.allowBots, false);
    assert.equal(serialized.customOptions.maxPlayers, 4);
    assert.equal(serialized.customOptions.allowBots, false);
    assert.equal(validateRoomCustomOptions({ allowBots: true, maxPlayers: 16 }), null);
    assert.match(validateRoomCustomOptions({ maxPlayers: 0 }), /1 a 16/);
    assert.match(validateRoomCustomOptions({ maxPlayers: 17 }), /1 a 16/);
    assert.match(validateRoomCustomOptions({ maxPlayers: 2.5 }), /1 a 16/);
    assert.match(validateRoomCustomOptions({ allowBots: "yes" }), /verdadeira ou falsa/);
});

test("background BOTS room restarts when remaining bots are below half of the target", () => {
    const roomCode = String(config.menuBackground.roomCode || "BOTS").trim().toUpperCase();
    const viewer = createSocket("viewer", { spectatorRoomCode: roomCode });
    const io = createMatchmakingIo(viewer);

    roomManager.destroyRoom(roomCode);

    try {
        const createResult = roomManager.createBackgroundRoom(io);

        assert.equal(createResult.success, true);
        assert.equal(getBotPlayerCount(createResult.room.players), config.menuBackground.botCount);

        const firstRoom = createResult.room;
        const targetBotCount = firstRoom.targetBotCount;
        const remainingBotCount = Math.max(0, Math.ceil(targetBotCount / 2) - 1);
        const botIds = [...firstRoom.players.keys()];

        for (const botId of botIds.slice(remainingBotCount)) {
            firstRoom.players.delete(botId);
            firstRoom.territories.delete(botId);
        }

        assert.ok(getBotPlayerCount(firstRoom.players) * 2 < targetBotCount);

        const restartResult = roomManager.createBackgroundRoom(io);

        assert.equal(restartResult.success, true);
        assert.notEqual(restartResult.room, firstRoom);
        assert.equal(getBotPlayerCount(restartResult.room.players), targetBotCount);
        assert.ok(viewer.emitted.some(event => event.event === "menuBackgroundReady"));
    } finally {
        roomManager.destroyRoom(roomCode);
    }
});

test("player movement consumes the room rotation strength", () => {
    const slowPlayer = createTurningPlayer("slow", createRoomRuntimeConfig({ playerSpeed: 0.5 }));
    const fastPlayer = createTurningPlayer("fast", createRoomRuntimeConfig({ playerSpeed: 2 }));
    const tickDuration = 1 / config.loop.tickRate;

    updatePlayer(slowPlayer, tickDuration);
    updatePlayer(fastPlayer, tickDuration);

    assert.ok(fastPlayer.angle > slowPlayer.angle);
    assert.ok(Math.abs(
        slowPlayer.angle
        - Math.PI / 2 * slowPlayer.runtimeConfig.movement.rotationStrength
    ) < 1e-12);
    assert.ok(Math.abs(
        fastPlayer.angle
        - Math.PI / 2 * fastPlayer.runtimeConfig.movement.rotationStrength
    ) < 1e-12);
});

test("boundary slide activates before perfect tangency and snaps to the map edge", () => {
    const mapLimit = config.world.mapRadius - config.world.playerSize / 2;
    const tangentAlignment = config.movement.boundarySlideActivationTangentAlignment;
    const outwardAlignment = Math.sqrt(1 - tangentAlignment * tangentAlignment);
    const player = new Player("slider", {
        x: mapLimit - config.movement.boundaryTouchTolerance / 2,
        y: 0
    });

    player.angle = Math.atan2(tangentAlignment, outwardAlignment);

    updatePlayer(player, 1 / config.loop.tickRate);

    const distanceFromCenter = Math.hypot(player.x, player.y);
    const wallNormalAngle = Math.atan2(player.y, player.x);
    const tangentAngle = wallNormalAngle + Math.PI / 2;

    assert.equal(player.boundarySlideDirection, 1);
    assert.ok(Math.abs(distanceFromCenter - mapLimit) < 1e-6);
    assert.ok(Math.abs(getSmallestAngleDelta(player.angle, tangentAngle)) < 1e-6);
});

test("boundary slide trail edge is resampled with tighter spacing", () => {
    const mapLimit = config.world.mapRadius - config.world.playerSize / 2;
    const halfWidth = config.world.playerSize / 2;
    const player = new Player("slider", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();
    const initialLeftPoint = { x: mapLimit - halfWidth, y: 0 };
    const initialRightPoint = { x: mapLimit + halfWidth, y: 0 };

    initializePlayerTerritory(territories, player);
    player.x = mapLimit;
    player.y = 0;
    player.angle = Math.PI / 2;
    player.boundarySlideDirection = 1;
    player.isLeftTrailActive = true;
    player.isRightTrailActive = true;
    player.lastLeftTrailPoint = initialLeftPoint;
    player.lastRightTrailPoint = initialRightPoint;
    player.trailLeftSegments = [[initialLeftPoint]];
    player.trailRightSegments = [[initialRightPoint]];

    for (let tick = 0; tick < 8; tick++) {
        updatePlayer(player, 1 / config.loop.tickRate);
        updatePlayerTrail(player, territories, players);
    }

    const maxEdgeDistance = Math.max(
        ...getSegmentDistances(player.trailLeftSegments),
        ...getSegmentDistances(player.trailRightSegments)
    );

    assert.ok(maxEdgeDistance <= config.territory.boundarySlideTrailPointSpacing + 1e-6);
});

test("bot expansion plan grows when enemy pressure is low", () => {
    const safeScenario = createBotDecisionScenario("SAFE");
    safeScenario.bot.catchBalance = 3;
    safeScenario.botManager.update(1000);

    const riskyScenario = createBotDecisionScenario("RISK");
    const enemy = new Player("enemy", {
        x: riskyScenario.bot.x + config.world.playerSize * 2,
        y: riskyScenario.bot.y
    });

    riskyScenario.players.set(enemy.id, enemy);
    initializePlayerTerritory(riskyScenario.territories, enemy);
    riskyScenario.bot.catchBalance = 3;
    riskyScenario.botManager.update(1000);

    assert.ok(safeScenario.bot.botAi.expansionPlan.radius > riskyScenario.bot.botAi.expansionPlan.radius * 1.3);
    assert.ok(safeScenario.bot.botAi.expansionPlan.arcRadians > riskyScenario.bot.botAi.expansionPlan.arcRadians);
});

test("bot with stored balance targets a nearby enemy trail from inside its territory", () => {
    const scenario = createBotDecisionScenario("BALANCE_TRAIL");
    const { bot, botManager, players, territories } = scenario;
    const enemy = new Player("enemy", { x: 0, y: 1800 });

    players.set(enemy.id, enemy);
    bot.territoryX = 0;
    bot.territoryY = 0;
    bot.x = 0;
    bot.y = 0;
    bot.angle = 0;
    bot.catchBalance = 1;
    territories.set(bot.id, createCutTerritoryState(
        bot.id,
        createRectanglePolygon(-220, -220, 220, 220)
    ));
    enemy.territoryX = 0;
    enemy.territoryY = 3500;
    territories.set(enemy.id, createCutTerritoryState(
        enemy.id,
        createRectanglePolygon(-220, 3280, 220, 3720)
    ));
    enemy.isLeftTrailActive = true;
    enemy.isRightTrailActive = true;
    enemy.trailLeftSegments = [createVerticalTrailSegment(-35, 450, 650, 8)];
    enemy.trailRightSegments = [createVerticalTrailSegment(35, 450, 650, 8)];

    withDeterministicRandom(0.5, () => {
        botManager.update(1000);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, Math.PI / 2)) < 0.1);
});

test("bot with stored balance skips enemy trail points inside its own territory", () => {
    const scenario = createBotDecisionScenario("BALANCE_TRAIL_OUTSIDE");
    const { bot, botManager, players, territories } = scenario;
    const enemy = new Player("enemy", { x: 0, y: 1800 });

    players.set(enemy.id, enemy);
    bot.territoryX = 0;
    bot.territoryY = 0;
    bot.x = 0;
    bot.y = 0;
    bot.angle = 0;
    bot.catchBalance = 1;
    territories.set(bot.id, createCutTerritoryState(
        bot.id,
        createRectanglePolygon(-220, -220, 220, 220)
    ));
    enemy.territoryX = 0;
    enemy.territoryY = 3500;
    territories.set(enemy.id, createCutTerritoryState(
        enemy.id,
        createRectanglePolygon(-220, 3280, 220, 3720)
    ));
    enemy.isLeftTrailActive = true;
    enemy.isRightTrailActive = true;
    enemy.trailLeftSegments = [[
        { x: 120, y: 0 },
        { x: 0, y: 450 },
        { x: 0, y: 650 }
    ]];
    enemy.trailRightSegments = [[
        { x: 130, y: 0 },
        { x: 35, y: 450 },
        { x: 35, y: 650 }
    ]];

    withDeterministicRandom(0.5, () => {
        botManager.update(1000);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, Math.PI / 2)) < 0.1);
    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, 0)) > 0.6);
});

test("bots avoid competing for a number clearly closer to another bot", () => {
    const numberSystem = createAlwaysCorrectNumberSystem([
        ["first", { id: "first", x: 1000, y: 0 }],
        ["second", { id: "second", x: 0, y: 1000 }]
    ]);
    const players = new Map();
    const territories = createTerritories();
    const botManager = createBotManager({
        botCount: 2,
        botDifficulty: "hard",
        numberSystem,
        players,
        roomCode: "NUMBER_CONTEST",
        territories
    });

    botManager.ensureBots();

    const bots = [...players.values()].filter(player => player.isBot);
    const nearBot = bots[0];
    const secondBot = bots[1];

    nearBot.x = 900;
    nearBot.y = 0;
    nearBot.angle = 0;
    nearBot.catchBalance = 0;
    secondBot.x = 0;
    secondBot.y = 0;
    secondBot.angle = 0;
    secondBot.catchBalance = 0;

    withDeterministicRandom(0.5, () => {
        botManager.update(1000);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(nearBot.directionAngle, 0)) < 0.05);
    assert.ok(Math.abs(getSmallestAngleDelta(secondBot.directionAngle, Math.PI / 2)) < 0.05);
});

test("bot with a pending mark and stored balance returns to confirm by capture", () => {
    const scenario = createBotDecisionScenario("BALANCE_RETURN");
    const { bot, botManager, players, territories } = scenario;
    const enemy = new Player("enemy", { x: 1000, y: 1000 });

    players.set(enemy.id, enemy);
    initializePlayerTerritory(territories, enemy);
    bot.territoryX = 0;
    bot.territoryY = 0;
    bot.x = 0;
    bot.y = 500;
    bot.angle = 0;
    bot.catchBalance = 1;
    bot.isLeftTrailActive = true;
    bot.isRightTrailActive = true;
    bot.trailLeftSegments = [createVerticalTrailSegment(-35, 220, 500, 8)];
    bot.trailRightSegments = [createVerticalTrailSegment(35, 220, 500, 8)];
    territories.set(bot.id, createCutTerritoryState(
        bot.id,
        createRectanglePolygon(-220, -220, 220, 220)
    ));
    bot.queueCatchEliminationTarget(enemy.id);

    withDeterministicRandom(0.5, () => {
        botManager.update(1000);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, -Math.PI / 2)) < 0.1);
});

test("bot returns instead of chasing a pending mark when counterattack is faster", () => {
    const scenario = createBotDecisionScenario("PENDING_RISK");
    const { bot, botManager, players, territories } = scenario;
    const enemy = new Player("enemy", { x: 0, y: 260 });
    const now = 3000;
    const graceMs = config.gameMode.catch.counterattackGraceMs;

    players.set(enemy.id, enemy);
    bot.territoryX = 0;
    bot.territoryY = 0;
    bot.x = 0;
    bot.y = 500;
    bot.angle = 0;
    bot.catchBalance = 0;
    territories.set(bot.id, createCutTerritoryState(
        bot.id,
        createRectanglePolygon(-220, -220, 220, 220)
    ));
    enemy.territoryX = 0;
    enemy.territoryY = 220;
    territories.set(enemy.id, createCutTerritoryState(
        enemy.id,
        createRectanglePolygon(-220, 0, 220, 440)
    ));
    bot.queueCatchEliminationTarget(enemy.id, now - graceMs - 100);

    withDeterministicRandom(0.5, () => {
        botManager.update(now);
    });

    const returnAngle = -Math.PI / 2;
    const numberAngle = Math.atan2(-bot.y, config.world.initialTerritoryRadius * 6 - bot.x);

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, returnAngle)) < 0.1);
    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, numberAngle)) > 0.25);
});

test("marked bot confirms a counterattack when it can reach a correct number first", () => {
    const scenario = createBotDecisionScenario("MARKED_FAST");
    const { bot, botManager, players, territories } = scenario;
    const marker = new Player("marker", { x: -1200, y: 0 });
    const now = 1000;
    const graceMs = config.gameMode.catch.counterattackGraceMs;

    players.set(marker.id, marker);
    initializePlayerTerritory(territories, marker);
    bot.x = config.world.initialTerritoryRadius * 6 - 150;
    bot.y = 0;
    bot.angle = 0;
    marker.queueCatchEliminationTarget(bot.id, now - graceMs - 100);
    bot.queueCatchEliminationTarget(marker.id);

    withDeterministicRandom(0.5, () => {
        botManager.update(now);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, 0)) < 0.05);
});

test("marked bot waits near a correct number until counterattack is armed", () => {
    const scenario = createBotDecisionScenario("MARKED_WAIT");
    const { bot, botManager, players, territories } = scenario;
    const marker = new Player("marker", { x: -1200, y: 0 });
    const now = 1000;
    const graceMs = config.gameMode.catch.counterattackGraceMs;

    players.set(marker.id, marker);
    initializePlayerTerritory(territories, marker);
    bot.x = config.world.initialTerritoryRadius * 6 - 80;
    bot.y = 0;
    bot.angle = 0;
    marker.queueCatchEliminationTarget(bot.id, now);
    bot.queueCatchEliminationTarget(marker.id);

    withDeterministicRandom(0.5, () => {
        botManager.update(now);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, Math.PI)) < 0.05);

    withDeterministicRandom(0.5, () => {
        botManager.update(now + graceMs + config.bots.decisionIntervalMs);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, 0)) < 0.05);
});

test("marked bot returns when the marker can confirm first", () => {
    const scenario = createBotDecisionScenario("MARKED_RETURN");
    const { bot, botManager, players, territories } = scenario;
    const marker = new Player("marker", { x: config.world.initialTerritoryRadius * 6 - 20, y: 0 });
    const now = 1000;

    players.set(marker.id, marker);
    initializePlayerTerritory(territories, marker);
    bot.territoryX = 0;
    bot.territoryY = 0;
    bot.x = 0;
    bot.y = 500;
    bot.angle = 0;
    territories.set(bot.id, createCutTerritoryState(
        bot.id,
        createRectanglePolygon(-200, -100, 200, 100)
    ));
    marker.queueCatchEliminationTarget(bot.id, now);
    bot.queueCatchEliminationTarget(marker.id);

    withDeterministicRandom(0.5, () => {
        botManager.update(now);
    });

    const returnAngle = -Math.PI / 2;
    const numberAngle = Math.atan2(-bot.y, config.world.initialTerritoryRadius * 6 - bot.x);

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, returnAngle)) < 0.05);
    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, numberAngle)) > 0.7);
});

test("bot return target uses the territory edge instead of the fixed base", () => {
    const scenario = createBotDecisionScenario("RETURN");
    const { bot, botManager, territories } = scenario;

    bot.territoryX = 0;
    bot.territoryY = 0;
    bot.x = 900;
    bot.y = 500;
    bot.angle = 0;
    bot.catchBalance = 2;
    bot.isLeftTrailActive = true;
    bot.isRightTrailActive = true;
    bot.botAi.expansionPlan = {
        arcRadians: 1.4,
        direction: 1,
        phase: "return",
        radius: 1000,
        riskSafetyScore: 1,
        startAngle: 0
    };
    territories.set(bot.id, createCutTerritoryState(
        bot.id,
        createRectanglePolygon(-200, -100, 1000, 100)
    ));

    withDeterministicRandom(0.5, () => {
        botManager.update(2000);
    });

    const baseAngle = Math.atan2(bot.territoryY - bot.y, bot.territoryX - bot.x);
    const edgeAngle = -Math.PI / 2;

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, edgeAngle)) < 0.35);
    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, baseAngle)) > 0.7);
});

test("bot bends its route away from a self-trail trap and keeps the escape route briefly", () => {
    const scenario = createBotDecisionScenario("SELF_TRAP");
    const { bot, botManager } = scenario;

    bot.x = 0;
    bot.y = 0;
    bot.angle = 0;
    bot.catchBalance = 0;
    bot.isLeftTrailActive = true;
    bot.isRightTrailActive = true;
    bot.trailLeftSegments = [
        createVerticalTrailSegment(180, -320, 320, 16),
        [{ x: -900, y: -900 }, { x: -880, y: -880 }]
    ];
    bot.trailRightSegments = [
        createVerticalTrailSegment(220, -320, 320, 16),
        [{ x: -900, y: -840 }, { x: -880, y: -820 }]
    ];

    withDeterministicRandom(0.5, () => {
        botManager.update(1000);
    });

    const firstEscapeAngle = bot.directionAngle;

    assert.ok(Math.abs(getSmallestAngleDelta(firstEscapeAngle, 0)) > 0.25);
    assert.ok(Number.isFinite(bot.botAi.selfTrailEscapeAngle));

    withDeterministicRandom(0.5, () => {
        botManager.update(1000 + config.bots.decisionIntervalMs);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, firstEscapeAngle)) < 0.001);
});

test("bot ignores its short recent trail while leaving the territory", () => {
    const scenario = createBotDecisionScenario("LEAVE_BASE");
    const { bot, botManager } = scenario;

    bot.territoryX = 0;
    bot.territoryY = 0;
    bot.x = 140;
    bot.y = 0;
    bot.angle = 0;
    bot.catchBalance = 0;
    bot.isLeftTrailActive = true;
    bot.isRightTrailActive = true;
    bot.trailLeftSegments = [createHorizontalTrailSegment(0, 140, 35, 8)];
    bot.trailRightSegments = [createHorizontalTrailSegment(0, 140, -35, 8)];

    withDeterministicRandom(0.5, () => {
        botManager.update(1000);
    });

    assert.ok(Math.abs(getSmallestAngleDelta(bot.directionAngle, 0)) < 0.05);
    assert.equal(bot.botAi.selfTrailEscapeAngle, null);
});

test("deterministic BOTS room soak keeps simulation state finite", () => {
    const roomCode = "BOTS_SOAK";
    const players = new Map();
    const territories = createTerritories();
    const numberSystem = createAlwaysCorrectNumberSystem([
        ["east", { id: "east", x: 1200, y: 0 }],
        ["south", { id: "south", x: 0, y: 1200 }],
        ["west", { id: "west", x: -1200, y: 0 }],
        ["north", { id: "north", x: 0, y: -1200 }]
    ]);
    const botManager = createBotManager({
        botCount: config.menuBackground.botCount,
        botDifficulty: config.menuBackground.difficulty,
        numberSystem,
        players,
        roomCode,
        runtimeConfig: config,
        territories
    });
    const previousPositions = new Map();
    let totalDistance = 0;
    let totalCaptures = 0;
    let totalSelfCollisions = 0;
    let maximumActiveTrailCount = 0;

    withSeededRandom(0xb075500, () => {
        botManager.ensureBots();

        for (let tick = 0; tick < 900; tick++) {
            const now = 1000 + tick * (1000 / config.loop.tickRate);

            botManager.update(now);
            updatePlayers(players, 1 / config.loop.tickRate, config);

            for (const player of players.values()) {
                const previous = previousPositions.get(player.id);

                if (previous) {
                    totalDistance += Math.hypot(player.x - previous.x, player.y - previous.y);
                }

                previousPositions.set(player.id, { x: player.x, y: player.y });
            }

            const catchCombatFrame = createCatchCombatFrame(now);
            const context = {
                catchCombatFrame,
                now,
                roomCode,
                runtimeConfig: config
            };
            const diagnostics = updateTrails(players, territories, context);

            resolveCatchCombatFrame(players, territories, context);
            totalCaptures += diagnostics.captures;
            totalSelfCollisions += diagnostics.selfCollisions;
            maximumActiveTrailCount = Math.max(
                maximumActiveTrailCount,
                [...players.values()].filter(player => (
                    player.isLeftTrailActive || player.isRightTrailActive
                )).length
            );

            if (tick % 60 === 0) {
                assertFiniteBotRoomState(players, territories);
            }
        }

        botManager.ensureBots();
    });

    assert.equal(getBotPlayerCount(players), config.menuBackground.botCount);
    assert.ok(totalDistance > config.world.mapRadius, "bots travelled through the simulated room");
    assert.ok(maximumActiveTrailCount > 0, "bots generated trails during the soak");
    assert.ok(Number.isInteger(totalCaptures));
    assert.ok(Number.isInteger(totalSelfCollisions));
    assert.ok(botManager.getDiagnostics().cycle > 1);
    assertFiniteBotRoomState(players, territories);
});

function createCutScenario() {
    const capturedPolygon = createRectanglePolygon(30, -10, 50, 110);
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", capturedPolygon)],
        ["victim", createCutTerritoryState("victim", createRectanglePolygon(0, 0, 120, 100))]
    ]);

    return {
        capturedPolygon,
        territories
    };
}

function createCutTerritoryState(id, polygon) {
    return {
        id,
        color: id === "attacker" ? "#f00" : "#00f",
        version: 1,
        baseX: 0,
        baseY: 0,
        captureOperationLog: [],
        polygon,
        area: calculatePolygonArea(polygon),
        bounds: getPolygonBounds(polygon)
    };
}

function createCutPlayerState(overrides = {}) {
    return {
        x: 0,
        y: 0,
        isLeftTrailActive: false,
        isRightTrailActive: false,
        trailLeftSegments: [],
        trailRightSegments: [],
        ...overrides
    };
}

function createRectanglePolygon(minX, minY, maxX, maxY) {
    return [[
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
        [minX, minY]
    ]];
}

function createDenseRectanglePolygon(minX, minY, maxX, maxY, pointsPerSide) {
    const ring = [];
    const sides = [
        [[minX, minY], [maxX, minY]],
        [[maxX, minY], [maxX, maxY]],
        [[maxX, maxY], [minX, maxY]],
        [[minX, maxY], [minX, minY]]
    ];

    for (const [start, end] of sides) {
        for (let index = 0; index < pointsPerSide; index++) {
            const progress = index / pointsPerSide;

            ring.push([
                start[0] + (end[0] - start[0]) * progress,
                start[1] + (end[1] - start[1]) * progress
            ]);
        }
    }

    ring.push(ring[0]);
    return [ring];
}

async function processTerritoryRepairsUntil(
    territories,
    players,
    diagnostics,
    isComplete
) {
    for (let attempt = 0; attempt < 100; attempt++) {
        processTerritoryOverlapRepairQueue(territories, players, {
            diagnostics,
            players
        });

        if (isComplete()) {
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.fail("Territory repair worker did not finish in time.");
}

function createCircleLikePolygon(centerX, centerY, radius, pointCount) {
    const ring = [];

    for (let index = 0; index < pointCount; index++) {
        const angle = index / pointCount * Math.PI * 2;

        ring.push([
            centerX + Math.cos(angle) * radius,
            centerY + Math.sin(angle) * radius
        ]);
    }

    ring.push(ring[0]);
    return [ring];
}

function replaceTerritoryPolygon(territory, polygon) {
    territory.polygon = polygon;
    territory.area = calculatePolygonArea(polygon);
    territory.bounds = getPolygonBounds(polygon);
    territory.version = (territory.version || 0) + 1;
    delete territory.lastCaptureOperation;
}

function createVerticalTrailSegment(x, minY, maxY, pointCount) {
    return Array.from({ length: pointCount }, (_value, index) => {
        const progress = pointCount <= 1 ? 0 : index / (pointCount - 1);

        return {
            x,
            y: minY + (maxY - minY) * progress
        };
    });
}

function createHorizontalTrailSegment(minX, maxX, y, pointCount) {
    return Array.from({ length: pointCount }, (_value, index) => {
        const progress = pointCount <= 1 ? 0 : index / (pointCount - 1);

        return {
            x: minX + (maxX - minX) * progress,
            y
        };
    });
}

function createTrailTestPoints(count, y) {
    return Array.from({ length: count }, (_value, index) => ({
        x: index,
        y
    }));
}

function getSegmentDistances(segments) {
    const distances = [];

    for (const segment of segments || []) {
        for (let index = 1; index < segment.length; index++) {
            distances.push(Math.hypot(
                segment[index].x - segment[index - 1].x,
                segment[index].y - segment[index - 1].y
            ));
        }
    }

    return distances;
}

function getSmallestAngleDelta(fromAngle, toAngle) {
    return Math.atan2(
        Math.sin(fromAngle - toAngle),
        Math.cos(fromAngle - toAngle)
    );
}

function createSeededRandom(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function randomBetween(random, minimum, maximum) {
    return minimum + (maximum - minimum) * random();
}

function getMaximumTerritoryOverlapArea(territories) {
    const entries = [...territories.entries()];
    let maximumOverlapArea = 0;

    for (let firstIndex = 0; firstIndex < entries.length; firstIndex++) {
        for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex++) {
            maximumOverlapArea = Math.max(
                maximumOverlapArea,
                calculatePolygonIntersectionArea(
                    entries[firstIndex][1].polygon,
                    entries[secondIndex][1].polygon
                )
            );
        }
    }

    return maximumOverlapArea;
}

function assertTerritoryGeometryInvariants(territories, previousVersions) {
    for (const [id, territory] of territories) {
        const calculatedArea = calculatePolygonArea(territory.polygon);

        assert.ok(Number.isFinite(calculatedArea), `${id} has a finite area`);
        assert.ok(calculatedArea >= 0, `${id} has a non-negative area`);
        assert.ok(territory.version >= previousVersions.get(id), `${id} version is monotonic`);
        assert.ok(Math.abs(territory.area - calculatedArea) <= 1e-6, `${id} cached area is current`);

        if (territory.bounds) {
            assert.ok(Number.isFinite(territory.bounds.minX), `${id} minX is finite`);
            assert.ok(Number.isFinite(territory.bounds.minY), `${id} minY is finite`);
            assert.ok(Number.isFinite(territory.bounds.maxX), `${id} maxX is finite`);
            assert.ok(Number.isFinite(territory.bounds.maxY), `${id} maxY is finite`);
        } else {
            assert.equal(calculatedArea, 0, `${id} only lacks bounds when empty`);
        }

        previousVersions.set(id, territory.version);
    }
}

function assertFiniteBotRoomState(players, territories) {
    for (const player of players.values()) {
        assert.ok(Number.isFinite(player.x), `${player.id} x is finite`);
        assert.ok(Number.isFinite(player.y), `${player.id} y is finite`);
        assert.ok(Number.isFinite(player.angle), `${player.id} angle is finite`);
        assert.ok(
            Math.hypot(player.x, player.y) <= config.world.mapRadius + 1e-6,
            `${player.id} remains inside the map`
        );

        for (const segments of [player.trailLeftSegments, player.trailRightSegments]) {
            for (const segment of segments || []) {
                for (const point of segment || []) {
                    assert.ok(Number.isFinite(point.x), `${player.id} trail x is finite`);
                    assert.ok(Number.isFinite(point.y), `${player.id} trail y is finite`);
                }
            }
        }
    }

    for (const [id, territory] of territories) {
        assert.ok(players.has(id), `${id} territory has an active owner`);
        assert.ok(Number.isFinite(territory.area), `${id} territory area is finite`);
        assert.ok(territory.area >= 0, `${id} territory area is non-negative`);

        for (const ring of territory.polygon || []) {
            for (const point of ring || []) {
                assert.ok(Number.isFinite(point[0]), `${id} territory x is finite`);
                assert.ok(Number.isFinite(point[1]), `${id} territory y is finite`);
            }
        }
    }
}

function withSeededRandom(seed, callback) {
    const originalRandom = Math.random;

    Math.random = createSeededRandom(seed);

    try {
        return callback();
    } finally {
        Math.random = originalRandom;
    }
}

function withDeterministicRandom(value, callback) {
    const originalRandom = Math.random;

    Math.random = () => value;

    try {
        return callback();
    } finally {
        Math.random = originalRandom;
    }
}

function createBotDecisionScenario(roomCode) {
    const players = new Map();
    const territories = createTerritories();
    const numberSystem = createAlwaysCorrectNumberSystem();
    const botManager = createBotManager({
        botCount: 1,
        botDifficulty: "hard",
        numberSystem,
        players,
        roomCode,
        territories
    });

    botManager.ensureBots();

    const bot = [...players.values()].find(player => player.isBot);

    return {
        bot,
        botManager,
        numberSystem,
        players,
        territories
    };
}

function createAlwaysCorrectNumberSystem(entries = null) {
    const numbers = new Map(entries || [[
        "correct",
        {
            x: config.world.initialTerritoryRadius * 6,
            y: 0
        }
    ]]);

    return {
        getNumbersMap() {
            return numbers;
        },
        getTheme() {
            return {
                check() {
                    return true;
                }
            };
        }
    };
}

function createMatchmakingRoom(code, options = {}) {
    return {
        code,
        createdAt: options.createdAt || 1,
        difficulty: options.difficulty || "medium",
        hiddenFromList: Boolean(options.hiddenFromList),
        isPrivate: Boolean(options.isPrivate),
        isSystemRoom: Boolean(options.isSystemRoom),
        maxPlayers: options.maxPlayers || config.rooms.maxPlayersPerRoom,
        players: createMatchmakingPlayers(options.humanPlayers || 0, options.botPlayers || 0),
        runtimeConfig: config,
        territories: createTerritories()
    };
}

function createTurningPlayer(id, runtimeConfig) {
    const player = new Player(id, { x: 0, y: 0 }, { runtimeConfig });

    player.angle = 0;
    player.setDirectionAngle(Math.PI / 2, "keyboard");
    return player;
}

function createMatchmakingPlayers(humanCount, botCount) {
    const players = new Map();

    for (let index = 0; index < humanCount; index++) {
        players.set(`human-${index}`, { id: `human-${index}` });
    }

    for (let index = 0; index < botCount; index++) {
        players.set(`bot:test:${index}`, {
            id: `bot:test:${index}`,
            isBot: true
        });
    }

    return players;
}

function createMatchmakingIo(socket) {
    let connectionHandler = null;
    const emitted = [];

    return {
        emitted,
        on(event, handler) {
            if (event === "connection") {
                connectionHandler = handler;
            }
        },
        connect() {
            connectionHandler(socket);
        },
        emit(event, payload) {
            emitted.push({ event, payload });
        },
        sockets: {
            sockets: new Map([[socket.id, socket]])
        },
        to() {
            return {
                emit() {}
            };
        }
    };
}
