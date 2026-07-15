const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/gameConfig");
const { Player } = require("../src/entities/player");
const {
    createTerritories,
    initializePlayerTerritory
} = require("../src/state/territories");
const { updatePlayerTrail } = require("../src/systems/trailSystem");

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
