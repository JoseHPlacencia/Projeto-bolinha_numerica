const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const { createRoomRuntimeConfig } = require("../src/core/roomSettings");
const { Player } = require("../src/entities/player");
const {
    createTerritories,
    initializePlayerTerritory
} = require("../src/state/territories");
const { updatePlayer } = require("../src/systems/movementSystem");
const { updatePlayerTrail } = require("../src/systems/trailSystem");
const {
    getSegmentDistances,
    getSmallestAngleDelta,
    createTurningPlayer
} = require("./helpers/gameTestFixtures");

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
