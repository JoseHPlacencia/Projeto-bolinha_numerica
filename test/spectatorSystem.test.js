const test = require("node:test");
const assert = require("node:assert/strict");
const { Player } = require("../src/entities/player");
const {
    createTerritories,
    initializePlayerTerritory
} = require("../src/state/territories");
const { sendSnapshot } = require("../src/core/snapshotLoop");
const { getHumanPlayerCount } = require("../src/systems/botSystem");
const { endPlayerGame } = require("../src/systems/catchModeSystem");
const {
    activateSpectator,
    pickHighestRankedPlayerId,
    redirectSpectatorsAfterPlayerExit
} = require("../src/systems/spectatorSystem");
const {
    createSquareTerritory,
    createSocket
} = require("./helpers/gameTestFixtures");

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
