const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const {
    createRoomRuntimeConfig,
    normalizeRoomCustomOptions,
    serializeRoomSettings,
    validateRoomCustomOptions
} = require("../src/core/roomSettings");

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
    assert.equal(customOptions.requestedMaxPlayers, 4);
    assert.equal(customOptions.allowBots, false);
    assert.equal(customOptions.botCount, 0);
    assert.equal(serialized.customOptions.maxPlayers, 4);
    assert.equal(serialized.customOptions.allowBots, false);
    assert.equal(serialized.customOptions.botCount, 0);
    assert.equal(normalizeRoomCustomOptions({ maxPlayers: 16 }).botCount, 2);
    assert.equal(normalizeRoomCustomOptions({ botCount: 4, maxPlayers: 4 }).botCount, 4);
    assert.equal(normalizeRoomCustomOptions({ botCount: 36, mapSize: 2, maxPlayers: 36 }).botCount, 36);
    assert.equal(validateRoomCustomOptions({ allowBots: true, botCount: 2, maxPlayers: 16 }), null);
    assert.equal(validateRoomCustomOptions({ botCount: 36, mapSize: 2, maxPlayers: 36 }), null);
    assert.match(validateRoomCustomOptions({ maxPlayers: 0 }), /1 a 36/);
    assert.equal(validateRoomCustomOptions({ maxPlayers: 17 }), null);
    assert.match(validateRoomCustomOptions({ maxPlayers: 37 }), /1 a 36/);
    assert.match(validateRoomCustomOptions({ maxPlayers: 2.5 }), /1 a 36/);
    assert.match(validateRoomCustomOptions({ allowBots: "yes" }), /verdadeira ou falsa/);
    assert.match(validateRoomCustomOptions({ botCount: -1, maxPlayers: 4 }), /0 a 4/);
    assert.match(validateRoomCustomOptions({ botCount: 5, maxPlayers: 4 }), /0 a 4/);
    assert.match(validateRoomCustomOptions({ botCount: 1.5, maxPlayers: 4 }), /0 a 4/);
    assert.match(validateRoomCustomOptions({ botCount: 26, mapSize: 1.5, maxPlayers: 36 }), /0 a 25/);
});

test("number quantity scales with map area and keeps density as a separate multiplier", () => {
    const smallMap = createRoomRuntimeConfig({ mapSize: 0.5, numberDensity: 1 });
    const normalMap = createRoomRuntimeConfig({ mapSize: 1, numberDensity: 1 });
    const largeMap = createRoomRuntimeConfig({ mapSize: 2, numberDensity: 1 });
    const sparseLargeMap = createRoomRuntimeConfig({ mapSize: 2, numberDensity: 0.5 });

    assert.equal(config.numbers.maxNumbers, 32);
    assert.equal(config.numbers.respawnDelaySec, 3);
    assert.equal(smallMap.numbers.maxNumbers, 8);
    assert.equal(normalMap.numbers.maxNumbers, config.numbers.maxNumbers);
    assert.equal(normalMap.numbers.respawnDelaySec, 3);
    assert.equal(largeMap.numbers.maxNumbers, config.numbers.maxNumbers * 4);
    assert.equal(sparseLargeMap.numbers.maxNumbers, config.numbers.maxNumbers * 2);
    assert.equal(
        serializeRoomSettings(largeMap).numbers.maxNumbers,
        config.numbers.maxNumbers * 4
    );
});

test("number spawn area stays at a fixed proportion of every map radius", () => {
    const legacyNarrowSetting = createRoomRuntimeConfig({ mapSize: 0.5, numberSpread: 0.5 });
    const legacyWideSetting = createRoomRuntimeConfig({ mapSize: 2, numberSpread: 2 });

    assert.equal(config.numbers.spawnRadiusRatio, 0.9);
    assert.equal(legacyNarrowSetting.numbers.spawnRadiusRatio, 0.9);
    assert.equal(legacyWideSetting.numbers.spawnRadiusRatio, 0.9);
    assert.equal(Object.hasOwn(legacyNarrowSetting.customOptions, "numberSpread"), false);
});

test("effective player capacity follows map area and preserves the requested ceiling", () => {
    const smallDefault = createRoomRuntimeConfig({ mapSize: 0.5, maxPlayers: 36 });
    const mediumDefault = createRoomRuntimeConfig({ mapSize: 0.75, maxPlayers: 36 });
    const normalDefault = createRoomRuntimeConfig({ mapSize: 1, maxPlayers: 36 });
    const largeDefault = createRoomRuntimeConfig({ mapSize: 1.5, maxPlayers: 36 });
    const largestDefault = createRoomRuntimeConfig({ mapSize: 2, maxPlayers: 36 });
    const largeReduced = createRoomRuntimeConfig({ mapSize: 2, maxPlayers: 8 });

    assert.equal(smallDefault.customOptions.requestedMaxPlayers, 36);
    assert.equal(smallDefault.customOptions.maxPlayers, 4);
    assert.equal(mediumDefault.customOptions.maxPlayers, 9);
    assert.equal(normalDefault.customOptions.maxPlayers, 16);
    assert.equal(largeDefault.customOptions.maxPlayers, 25);
    assert.equal(largestDefault.customOptions.maxPlayers, 36);
    assert.equal(largeReduced.customOptions.requestedMaxPlayers, 8);
    assert.equal(largeReduced.customOptions.maxPlayers, 8);
    assert.match(
        validateRoomCustomOptions({ botCount: 5, mapSize: 0.5, maxPlayers: 16 }),
        /0 a 4/
    );
});
