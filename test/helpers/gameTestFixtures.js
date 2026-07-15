const assert = require("node:assert/strict");
const config = require("../../src/config/gameConfig");
const { Player } = require("../../src/entities/player");
const {
    createTerritories,
    processTerritoryOverlapRepairQueue
} = require("../../src/state/territories");
const {
    calculatePolygonIntersectionArea,
    calculatePolygonArea,
    getPolygonBounds
} = require("../../src/utils/geometry");
const { createBotManager } = require("../../src/systems/botSystem");

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

module.exports = {
    createSquareTerritory,
    createSocket,
    createCutScenario,
    createCutTerritoryState,
    createCutPlayerState,
    createRectanglePolygon,
    createDenseRectanglePolygon,
    processTerritoryRepairsUntil,
    createCircleLikePolygon,
    replaceTerritoryPolygon,
    createVerticalTrailSegment,
    createHorizontalTrailSegment,
    createTrailTestPoints,
    getSegmentDistances,
    getSmallestAngleDelta,
    createSeededRandom,
    randomBetween,
    getMaximumTerritoryOverlapArea,
    assertTerritoryGeometryInvariants,
    assertFiniteBotRoomState,
    withSeededRandom,
    withDeterministicRandom,
    createBotDecisionScenario,
    createAlwaysCorrectNumberSystem,
    createMatchmakingRoom,
    createTurningPlayer,
    createMatchmakingPlayers,
    createMatchmakingIo
};
