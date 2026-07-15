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
    assert.equal(customOptions.allowBots, false);
    assert.equal(serialized.customOptions.maxPlayers, 4);
    assert.equal(serialized.customOptions.allowBots, false);
    assert.equal(validateRoomCustomOptions({ allowBots: true, maxPlayers: 16 }), null);
    assert.match(validateRoomCustomOptions({ maxPlayers: 0 }), /1 a 16/);
    assert.match(validateRoomCustomOptions({ maxPlayers: 17 }), /1 a 16/);
    assert.match(validateRoomCustomOptions({ maxPlayers: 2.5 }), /1 a 16/);
    assert.match(validateRoomCustomOptions({ allowBots: "yes" }), /verdadeira ou falsa/);
});
