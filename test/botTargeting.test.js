const test = require("node:test");
const assert = require("node:assert/strict");
const {
    chooseBotTarget,
    createBotDecisionContext,
    getReturnTarget,
    isReturnTarget
} = require("../src/systems/botTargeting");

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
