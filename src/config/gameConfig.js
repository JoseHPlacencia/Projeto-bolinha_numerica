const socketTransports = Object.freeze(["websocket"]);

const inputAngles = Object.freeze({
    arrowright: 0,
    d: 0,

    arrowdown: Math.PI / 2,
    s: Math.PI / 2,

    arrowleft: Math.PI,
    a: Math.PI,

    arrowup: -Math.PI / 2,
    w: -Math.PI / 2
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
    baseRadius: 200
});

const movement = Object.freeze({
    speed: 600,
    rotationStrength: 0.1,
    slideAngleThreshold: 0.1
});

const spawn = Object.freeze({
    minBaseDistance: world.baseRadius * 3,
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
    screen,
    network,
    inputKeys: Object.freeze(Object.keys(inputAngles))
});

module.exports = Object.freeze({
    server,
    socket,
    loop,
    world,
    movement,
    spawn,
    inputAngles,
    security,
    client
});
