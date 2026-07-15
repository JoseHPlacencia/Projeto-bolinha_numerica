const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const { Player } = require("../src/entities/player");
const {
    createTerritories,
    initializePlayerTerritory
} = require("../src/state/territories");
const { updatePlayerTrail } = require("../src/systems/trailSystem");
const {
    clearCatchEliminationMarksForTarget,
    confirmCatchEliminationTargets,
    createCatchCombatFrame,
    handleNumberCollected,
    handlePlayerLifeLoss,
    handleSuccessfulTrailCapture,
    resolveCatchCombatFrame
} = require("../src/systems/catchModeSystem");

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
