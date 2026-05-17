const socketTransports = Object.freeze(["websocket"]);

const inputActionAngles = Object.freeze({
    "move-right": 0,
    "move-down": Math.PI / 2,
    "move-left": Math.PI,
    "move-up": -Math.PI / 2
});

const inputBindings = Object.freeze({
    arrowright: "move-right",
    d: "move-right",

    arrowdown: "move-down",
    s: "move-down",

    arrowleft: "move-left",
    a: "move-left",

    arrowup: "move-up",
    w: "move-up"
});

const server = Object.freeze({
    port: Number(process.env.PORT) || 3000
});

const socket = Object.freeze({
    transports: socketTransports,
    perMessageDeflate: false
});

const loop = Object.freeze({
    tickRate: 60,
    snapshotRate: 30,
    maxDeltaTime: 0.1
});

const world = Object.freeze({
    mapRadius: 1500,
    playerSize: 70,
    initialTerritoryRadius: 200
});

const territory = Object.freeze({
    baseBorderWidth: 6,
    circleSegments: 96,
    fillAlpha: 0.36,
    minCaptureArea: 800,
    minCaptureTrailPoints: 4,
    trailPointSpacing: 18
});

const movement = Object.freeze({
    speed: 600,
    rotationStrength: 0.1,
    slideAngleThreshold: 0.1
});

const spawn = Object.freeze({
    minTerritoryDistance: world.initialTerritoryRadius * 3,
    maxAttempts: 500
});

const screen = Object.freeze({
    virtualWidth: 1920,
    virtualHeight: 1080,
    minAspectRatio: 4 / 3,
    maxAspectRatio: 21 / 9
});

const network = Object.freeze({
    initialBufferMs: 140,
    minBufferMs: 100,
    maxBufferMs: 260,
    jitterMultiplier: 2,
    maxJitterSamples: 30,
    maxSnapshots: 60
});

const security = Object.freeze({
    inputRateLimit: Object.freeze({
        maxEvents: 60,
        intervalMs: 1000,
        maxViolations: 10
    })
});

// Only values needed by the browser are exposed through /game-config.
const client = Object.freeze({
    socket: Object.freeze({
        transports: socketTransports
    }),
    world,
    territory,
    screen,
    network,
    inputActionAngles,
    inputBindings
});

module.exports = Object.freeze({
    server,
    socket,
    loop,
    world,
    territory,
    movement,
    spawn,
    inputActionAngles,
    inputBindings,
    security,
    client
});
