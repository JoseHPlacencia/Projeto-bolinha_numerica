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
    mapRadius: 5000,
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
    overlapRepairImmediateMaxPointCount: 128,
    overlapRepairQueueBudgetMs: 4,
    overlapRepairQueueCheckedPairCacheSize: 512,
    overlapRepairQueueMaxItems: 128,
    overlapRepairQueueMaxPairsPerTick: 10,
    overlapRepairWorkerEnabled: true,
    overlapRepairWorkerMaxInFlight: 2,
    pathSegmentAngleThresholdDegrees: 1,
    pathSegmentArcMaxSweepDegrees: 135,
    pathSegmentArcMaxRadialDrift: 2,
    selfTrailLineSimplifyTolerance: 1.5,
    trailSpatialBlockPrimitiveCount: 48,
    boundarySlideTrailPointSpacing: 5,
    trailPointSpacing: 15,
    victoryAreaRatio: 0.9995
});

const movement = Object.freeze({
    boundarySlideTriggerAlignmentPower: 0.1,
    boundarySlideExitAlignment: 0.2,
    boundarySlideExitDistance: 1,
    boundaryTouchTolerance: 4,
    boundarySlideActivationTangentAlignment: 0.85,
    boundarySlideTriggerMinOutwardAlignment: 0.25,
    boundarySlideTriggerPerpendicularPlayerSizeRatio: 2.5,
    boundarySlideTriggerRotationCurveSharpness: 10,
    boundarySlideTriggerRotationSharpness: 30,
    speed: 600,
    rotationStrength: 0.1,
    slideAngleThreshold: 0.1
});

const numbers = Object.freeze({
    radius: 40,
    minDistanceBetween: 180,
    minDistanceFromPlayer: 220,
    maxNumbers: 25,
    respawnDelaySec: 4,
    maxSpawnAttempts: 80,
    spawnRadiusRatio: 0.88
});

const player = Object.freeze({
    blinkDurationMs: 250,
    blinkMaxIntervalMs: 5000,
    blinkMinIntervalMs: 2500,
    doubleBlinkChance: 0.1,
    doubleBlinkGapMs: 90
});

const gameMode = Object.freeze({
    mode: "catch",
    catch: Object.freeze({
        counterattackGraceMs: 1200,
        defaultDifficulty: "medium",
        livesByDifficulty: Object.freeze({
            easy: 3,
            medium: 2,
            hard: 1
        })
    })
});

const botReservedNames = Object.freeze([
    "Atlas",
    "Euclides",
    "Noether",
    "Cantor"
]);

const bots = Object.freeze({
    enabled: true,
    count: 2,
    decisionIntervalMs: 180,
    maxDecisionsPerTick: 2,
    selfTrailLookaheadMaxDistance: world.playerSize * 12,
    selfTrailTrapLookaheadMaxDistance: world.playerSize * 22,
    selfTrailEscapeMemoryMs: 650,
    selfTrailSafetyBudgetMs: 4,
    selfTrailSafetyBlockSize: 48,
    selfTrailSafetyCoarseLookaheadRatio: 0.6,
    selfTrailSafetyCriticalClearanceRatio: 0.72,
    selfTrailSafetyMaxCandidates: 24,
    selfTrailSafetyTrapMaxCandidates: 48,
    selfTrailSafetyRefineCandidates: 6,
    selfTrailSafetyTrapRefineCandidates: 8,
    selfTrailSafetyMaxLocalCandidates: 8,
    difficulty: "easy",
    mistakeChance: 0.08,
    angleNoiseRadians: 0.04,
    dangerRadius: 1100,
    expansionGreedSafeMarginSec: 5,
    expansionMaxArcBonus: 0.42,
    expansionMaxRadiusBonus: 0.62,
    expansionPressureRadius: 2400,
    expansionPressureSampleCount: 24,
    expansionRiskReturnMarginSec: 0.95,
    markedCounterattackMarginSec: 0.25,
    numberContestAdvantageDistance: world.playerSize * 2,
    numberContestAdvantageRatio: 0.75,
    balanceCaptureBaseRadius: 1150,
    balanceCaptureMaxEnemyCandidates: 8,
    balanceCaptureReturnMarginSec: 0.45,
    balanceCaptureTrailRadius: 1500,
    huntMaxEnemyCandidates: 8,
    huntRadius: 1400,
    huntAggressiveMarginReduction: 0.35,
    trailTargetBlockSize: 32,
    safetyMarginSec: 0.65,
    expandMarginSec: 1.6,
    huntMarginSec: 0.75,
    captureLoopRadius: 1200,
    selfTrailAvoidDistance: world.playerSize * 1.35,
    reservedNames: botReservedNames,
    names: botReservedNames,
    colors: Object.freeze([
        "#26ffff",
        "#ff26e5",
        "#a8ff78",
        "#ffd166"
    ])
});

const minimap = Object.freeze({
    frameRate: 0,
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
    adaptiveBufferPercentile: 0.9,
    adaptiveBufferTrimRatio: 0.1,
    adaptiveBufferMinSamplesForTrim: 10,
    maxJitterSamples: 30,
    maxSnapshots: 18,
    viewportReportIntervalMs: 250,
    trailPredictionEnabled: true,
    trailPredictionMaxBufferMs: 140,
    trailPredictionMinPointDistance: territory.trailPointSpacing,
    trailPredictionMaxPointDistance: world.playerSize * 1.25,
    trailPredictionPlayerHalfWidth: world.playerSize / 2,
    diagnosticsHistoryLimit: 240,
    diagnosticsPingIntervalMs: 1000,
    diagnosticsPayloadOutlierBytes: 50000,
    diagnosticsPayloadOutlierTopLimit: 5,
    diagnosticsSlowBufferMs: 150,
    snapshotPayloadBudgetBytes: 42000,
    interestMargin: 800,
    interestExitMargin: 1200,
    interestRetentionMs: 500,
    maxViewportWorldWidth: 3200,
    maxViewportWorldHeight: 2200,
    cullPlayerPositionsByViewport: false,
    captureOperationSyncEnabled: true,
    captureOperationFallbackTrailPointsEnabled: false,
    captureOperationNeededTrailPointsEnabled: true,
    captureOperationMaxTrailPoints: 2048,
    optimisticOwnerCaptureOperationSyncEnabled: false,
    captureOverlapAuditEnabled: false,
    captureOperationResyncEnabled: true,
    reliableTrailUpdatesEnabled: true,
    coordinatePrecision: 10,
    anglePrecision: 1000,
    forcedFullSyncsEnabled: true,
    volatileSnapshotsWhileReliablePendingEnabled: true,
    reliableSnapshotAckTimeoutMs: 3000,
    reliableSnapshotRetryMs: 4000,
    playerInfoFullSyncIntervalMs: 5000,
    territoryFullSyncIntervalMs: 10000,
    trailFullSyncIntervalMs: 4000,
    trailUpdateMaxPoints: 512,
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

const clientTerritory = Object.freeze({
    baseBorderInset: territory.baseBorderInset,
    baseBorderWidth: territory.baseBorderWidth,
    fillAlpha: territory.fillAlpha
});

const client = Object.freeze({
    socket: Object.freeze({
        transports: socketTransports
    }),
    world,
    territory: clientTerritory,
    numbers,
    player,
    gameMode,
    minimap,
    screen,
    network,
    inputActionAngles,
    inputBindings
});


const rooms = Object.freeze({
    maxRooms: 50,
    maxPlayersPerRoom: 16,
    roomCodeCharset: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    roomCodeLength: 6,
    roomCodeMaxGenerationAttempts: 100,
    privateRoomPasswordMinLength: 4,
    privateRoomPasswordMaxLength: 64
});

const roomOptionMultipliers = Object.freeze([0.5, 0.75, 1, 1.5, 2]);

const roomCustomOptions = Object.freeze({
    multipliers: roomOptionMultipliers,
    players: Object.freeze({
        default: rooms.maxPlayersPerRoom,
        min: 1,
        max: rooms.maxPlayersPerRoom
    }),
    allowBotsDefault: true,
    lives: Object.freeze({
        min: 1,
        max: 5
    }),
    groups: Object.freeze([
        Object.freeze({
            id: "world",
            label: "Mundo",
            options: Object.freeze([
                Object.freeze({ id: "mapSize", label: "Tamanho do mapa", type: "multiplier" })
            ])
        }),
        Object.freeze({
            id: "movement",
            label: "Movimento",
            options: Object.freeze([
                Object.freeze({ id: "playerSpeed", label: "Velocidade do jogador", type: "multiplier" })
            ])
        }),
        Object.freeze({
            id: "numbers",
            label: "Numeros",
            options: Object.freeze([
                Object.freeze({ id: "numberRespawn", label: "Tempo de reaparecimento", type: "multiplier" }),
                Object.freeze({ id: "numberDensity", label: "Quantidade de numeros", type: "multiplier" }),
                Object.freeze({ id: "numberSpread", label: "Distribuicao no mapa", type: "multiplier" }),
                Object.freeze({ id: "themeDuration", label: "Duracao do tema", type: "multiplier" })
            ])
        }),
        Object.freeze({
            id: "match",
            label: "Partida",
            options: Object.freeze([
                Object.freeze({ id: "lives", label: "Vidas", type: "lives" })
            ])
        })
    ])
});

const menuBackground = Object.freeze({
    enabled: true,
    roomCode: "BOTS",
    difficulty: "hard",
    botCount: 8
});

module.exports = Object.freeze({
    server,
    socket,
    loop,
    world,
    territory,
    movement,
    numbers,
    player,
    gameMode,
    bots,
    minimap,
    network,
    spawn,
    screen,
    inputActionAngles,
    inputBindings,
    security,
    client,
    rooms,
    roomCustomOptions,
    menuBackground
});
