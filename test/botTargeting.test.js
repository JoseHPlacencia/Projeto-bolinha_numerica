const test = require("node:test");
const assert = require("node:assert/strict");
const {
    chooseBotTarget,
    createBotDecisionContext,
    getReturnTarget,
    isReturnTarget
} = require("../src/systems/botTargeting");
const {
    createPointBlockIndex,
    getNearestDistanceSquared
} = require("../src/systems/botTrailGeometry");

test("nearest trail-point index remains equivalent to an exhaustive search", () => {
    const points = Array.from({ length: 97 }, (_, index) => ({
        x: index * 13 - 480,
        y: Math.sin(index * 0.37) * 260 + index * 2
    }));
    const pointIndex = createPointBlockIndex(points, 8);
    const origins = [
        { x: 0, y: 0 },
        { x: -700, y: 190 },
        { x: 830, y: -410 },
        { x: 121.25, y: 87.75 }
    ];

    for (const origin of origins) {
        assert.equal(
            getNearestDistanceSquared(origin, pointIndex),
            getNearestDistanceSquared(origin, points)
        );
    }
});

test("nearest trail-point index evaluates the closest block first without relying on block order", () => {
    const points = [
        { x: 900, y: 900 },
        { x: 920, y: 920 },
        { x: -800, y: -800 },
        { x: -820, y: -820 },
        { x: 2, y: 0 },
        { x: 3, y: 0 }
    ];
    const diagnostics = {};
    const pointIndex = createPointBlockIndex(points, 2);

    assert.equal(getNearestDistanceSquared({ x: 0, y: 0 }, pointIndex, diagnostics), 4);
    assert.equal(diagnostics.pointBlockChecks, 3);
    assert.equal(diagnostics.pointBlockBoundsRejected, 2);
    assert.equal(diagnostics.pointDistanceCheckCount, 2);
});

test("targeting context filters correct numbers and indexes eligible bots once per cycle", () => {
    const correctNumber = { id: "correct", x: 100, y: 0, valid: true };
    const incorrectNumber = { id: "incorrect", x: 200, y: 0, valid: false };
    const firstBot = createTargetingBot("bot:first", 0, 0);
    const secondBot = createTargetingBot("bot:second", 90, 0);
    const human = { id: "human", x: 99, y: 0, catchBalance: 0, lives: 3 };
    const context = createBotDecisionContext(
        createNumberSystem([correctNumber, incorrectNumber]),
        new Map([
            [firstBot.id, firstBot],
            [secondBot.id, secondBot],
            [human.id, human]
        ])
    );

    assert.deepEqual(context.correctNumbers, [correctNumber]);
    assert.deepEqual(context.numberContestIndex.get(correctNumber), {
        closest: { distance: 10, playerId: secondBot.id },
        secondClosest: { distance: 100, playerId: firstBot.id }
    });
    assert.equal(context.numberContestIndex.has(incorrectNumber), false);
});

test("standalone targeting policy avoids a number clearly claimed by a closer bot", () => {
    const claimedNumber = { id: "claimed", x: 100, y: 0, valid: true };
    const availableNumber = { id: "available", x: 0, y: 200, valid: true };
    const decidingBot = createTargetingBot("bot:deciding", 0, 0);
    const closerBot = createTargetingBot("bot:closer", 90, 0);
    const players = new Map([
        [decidingBot.id, decidingBot],
        [closerBot.id, closerBot]
    ]);
    const numberSystem = createNumberSystem([claimedNumber, availableNumber]);

    assert.equal(
        chooseBotTarget(decidingBot, players, null, numberSystem),
        availableNumber
    );
});

test("territory return policy marks its targets for route safety", () => {
    const bot = createTargetingBot("bot:return", 900, 400);

    bot.territoryX = 120;
    bot.territoryY = -80;

    const target = getReturnTarget(bot);

    assert.deepEqual(target, {
        isReturnTarget: true,
        x: 120,
        y: -80
    });
    assert.equal(isReturnTarget(bot, target), true);
});

function createTargetingBot(id, x, y) {
    return {
        catchBalance: 0,
        id,
        isBot: true,
        lives: 3,
        pendingCatchEliminationTargets: new Set(),
        territoryX: x,
        territoryY: y,
        trailLeftSegments: [],
        trailRightSegments: [],
        x,
        y
    };
}

function createNumberSystem(numbers) {
    return {
        getNumbersMap() {
            return new Map(numbers.map(number => [number.id, number]));
        },
        getTheme() {
            return {
                check(number) {
                    return number.valid;
                }
            };
        }
    };
}
