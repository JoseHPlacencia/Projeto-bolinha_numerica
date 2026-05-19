const socketTransports = Object.freeze(["polling", "websocket"]);

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
    perMessageDeflate: Object.freeze({
        threshold: 256,
        zlibDeflateOptions: Object.freeze({
            level: 6
        })
    })
});

const loop = Object.freeze({
    tickRate: 60,
    snapshotRate: 20,
    maxDeltaTime: 0.1
});

const world = Object.freeze({
    mapRadius: 3000,
    playerSize: 70,
    initialTerritoryRadius: 200
});

const territory = Object.freeze({
    baseBorderInset: 3,
    baseBorderWidth: 4,
    circleSegments: 96,
    fillAlpha: 0.36,
    minCaptureArea: 800,
    minCaptureTrailPoints: 4,
    trailPointSpacing: 14
});

const movement = Object.freeze({
    boundarySlideTriggerAlignmentPower: 0.1,
    boundarySlideExitAlignment: 0.2,
    boundarySlideExitDistance: 1,
    boundaryTouchTolerance: 4,
    boundarySlideTriggerMinOutwardAlignment: 0.25,
    boundarySlideTriggerPerpendicularPlayerSizeRatio: 2.5,
    boundarySlideTriggerRotationCurveSharpness: 10,
    boundarySlideTriggerRotationSharpness: 30,
    speed: 600,
    rotationStrength: 0.1,
    slideAngleThreshold: 0.1
});

const player = Object.freeze({
    blinkDurationMs: 250,
    blinkMaxIntervalMs: 5000,
    blinkMinIntervalMs: 2500
});

const minimap = Object.freeze({
    mapBorderWidth: 3,
    minSize: 96,
    playerIconBorderWidth: 1,
    playerIconSize: 6,
    size: 300,
    territoryBorderWidth: 2,
    trailBorderWidth: 2,
    viewportSizeRatio: 0.5
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
    initialBufferMs: 180,
    minBufferMs: 100,
    maxBufferMs: 360,
    jitterMultiplier: 2,
    maxJitterSamples: 30,
    maxSnapshots: 18,
    viewportReportIntervalMs: 250,
    interestMargin: 800,
    maxViewportWorldWidth: 3200,
    maxViewportWorldHeight: 2200,
    coordinatePrecision: 10,
    anglePrecision: 1000,
    forcedFullSyncsEnabled: false,
    reliableSnapshotAckTimeoutMs: 1200,
    reliableSnapshotRetryMs: 1500,
    playerInfoFullSyncIntervalMs: 5000,
    territoryFullSyncIntervalMs: 10000,
    trailFullSyncIntervalMs: 4000,
    trailPatchFullRatio: 0.85,
    resyncRequestIntervalMs: 1000
});

const security = Object.freeze({
    inputRateLimit: Object.freeze({
        maxEvents: 60,
        intervalMs: 1000,
        maxViolations: 10
    }),
    viewportRateLimit: Object.freeze({
        maxEvents: 12,
        intervalMs: 1000,
        maxViolations: 5
    })
});

// Only values needed by the browser are exposed through /game-config.
const client = Object.freeze({
    socket: Object.freeze({
        transports: socketTransports
    }),
    world,
    territory,
    player,
    minimap,
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
    player,
    minimap,
    network,
    spawn,
    screen,
    inputActionAngles,
    inputBindings,
    security,
    client
});
