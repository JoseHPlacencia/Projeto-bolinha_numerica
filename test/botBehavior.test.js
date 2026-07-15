const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const { Player } = require("../src/entities/player");
const {
    createTerritories,
    initializePlayerTerritory
} = require("../src/state/territories");
const {
    createBotManager,
    getBotPlayerCount
} = require("../src/systems/botSystem");
const { updatePlayers } = require("../src/systems/movementSystem");
const { updateTrails } = require("../src/systems/trailSystem");
const {
    createCatchCombatFrame,
    resolveCatchCombatFrame
} = require("../src/systems/catchModeSystem");
const {
    createCutTerritoryState,
    createRectanglePolygon,
    createVerticalTrailSegment,
    createHorizontalTrailSegment,
    getSmallestAngleDelta,
    assertFiniteBotRoomState,
    withSeededRandom,
    withDeterministicRandom,
    createBotDecisionScenario,
    createAlwaysCorrectNumberSystem
} = require("./helpers/gameTestFixtures");

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
