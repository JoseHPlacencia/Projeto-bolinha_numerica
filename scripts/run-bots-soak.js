"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const config = require("../src/config/gameConfig");
const { createRoomRuntimeConfig } = require("../src/core/roomSettings");
const {
    createTerritories,
    getTerritoryOverlapRepairQueueDiagnostics
} = require("../src/state/territories");
const {
    createBotManager,
    getBotPlayerCount
} = require("../src/systems/botSystem");
const {
    createCatchCombatFrame,
    handleNumberCollected,
    resolveCatchCombatFrame
} = require("../src/systems/catchModeSystem");
const { updatePlayers } = require("../src/systems/movementSystem");
const { createNumberSystem } = require("../src/systems/numberSystem");
const { updateTrails } = require("../src/systems/trailSystem");
const {
    calculatePolygonArea,
    calculatePolygonIntersectionArea,
    doBoundsOverlap,
    getPolygonPointCount
} = require("../src/utils/geometry");
const {
    createTerritoryOverlapDetail,
    keepSlowestSamples,
    roundMetric,
    summarizeDistribution,
    summarizeMemorySamples
} = require("./lib/botsSoakMetrics");

const projectRoot = path.resolve(__dirname, "..");
const defaultOutput = path.join(projectRoot, ".ai", "reports", "BOTS_SOAK_LATEST.json");
const argumentNames = new Set([
    "bots",
    "difficulty",
    "output",
    "overlap-every",
    "pace",
    "sample-every",
    "seed",
    "ticks",
    "top",
    "warmup",
    "yield-every"
]);
const trailCounterNames = [
    "captureAttempts",
    "captures",
    "clearTrailCount",
    "closedTrailReturns",
    "ownerTrailPrimitiveTests",
    "ownerTrailSegmentChecks",
    "selfCollisions",
    "selfTrailPrimitiveTests",
    "selfTrailSegmentChecks",
    "trailOwnerChecks",
    "trailOwnerHits"
];
const captureCounterNames = [
    "calls",
    "changedTerritoryCount",
    "operationSimplifyAttemptCount",
    "operationSimplifyCacheHitCount",
    "operationSimplifyHitCount",
    "operationSubtractFallbackCount",
    "operationSubtractValidationCount",
    "operationSubtractValidationRejectedCount",
    "overlapRepairQueueBudgetHitCount",
    "overlapRepairQueueChangedCount",
    "overlapRepairQueueProcessedCount",
    "overlapRepairQueueQueuedCount",
    "overlapRepairQueueRefreshCount",
    "overlapRepairWorkerBackpressureCount",
    "overlapRepairWorkerChangedCount",
    "overlapRepairWorkerCompletedCount",
    "overlapRepairWorkerDispatchedCount",
    "overlapRepairWorkerFailedCount",
    "overlapRepairWorkerNoChangeCount",
    "overlapRepairWorkerStaleCount",
    "postCaptureOverlapCount",
    "postCaptureOverlapRepairChangedCount",
    "postCaptureOverlapRepairCount",
    "subtractCount"
];
const captureMaximumNames = [
    "maxCapturedArea",
    "maxCapturedPointCount",
    "maxOwnerArea",
    "maxOwnerPointCount",
    "operationSimplifyMaxAreaDrift",
    "operationSimplifyMaxAreaDriftRatio",
    "operationSubtractMaxResidualOverlapArea",
    "overlapRepairQueuePendingCount",
    "overlapRepairWorkerInFlightCount"
];
const botCounterNames = [
    "decisionsProcessed",
    "pendingAfter",
    "pendingBefore"
];
const botTargetingCounterNames = [
    "balanceEnemyEvaluations",
    "coordinatedNumberCacheHitCount",
    "coordinatedNumberCacheMissCount",
    "huntEnemyEvaluations",
    "returnTargetCacheHitCount",
    "returnTargetCacheMissCount",
    "trailBlockChecks",
    "trailIndexCacheHitCount",
    "trailIndexCacheMissCount",
    "trailPointChecks"
];
const botSafetyCounterNames = [
    "budgetHitCount",
    "decisionCount",
    "earlyExitCount",
    "fullEvaluationCount",
    "pathEvaluationCount",
    "pointDistanceCheckCount",
    "segmentCrossCheckCount",
    "unsafeTargetCount"
];

main().catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const originalRandom = Math.random;
    const startedAt = new Date();
    const realStartedAt = performance.now();

    Math.random = createSeededRandom(options.seed);

    try {
        const report = await runSoak(options, startedAt, realStartedAt);

        writeReport(report, options.output);
        printSummary(report, options.output);
    } finally {
        Math.random = originalRandom;
    }
}

async function runSoak(options, startedAt, realStartedAt) {
    const tickIntervalMs = 1000 / config.loop.tickRate;
    const totalTicks = options.warmupTicks + options.ticks;
    const simulationStartedAt = Date.now();
    const scheduleStartedAt = performance.now();
    const series = createSeries();
    const counters = createCounters();
    const monotonicState = createMonotonicState();
    const slowestTicks = [];
    const memorySamples = [];
    let scenario = createScenario(options);
    let measuredRestarts = 0;
    let retainedMemoryStart = null;

    if (options.warmupTicks === 0) {
        collectGarbage();
        retainedMemoryStart = createMemorySample(0);
    }

    for (let globalTick = 1; globalTick <= totalTicks; globalTick++) {
        const simulatedNow = simulationStartedAt + globalTick * tickIntervalMs;
        const tickResult = executeTick(scenario, simulatedNow, tickIntervalMs / 1000);
        const measuredTick = globalTick - options.warmupTicks;
        const isMeasured = measuredTick > 0;

        if (isMeasured) {
            collectTickMetrics(
                tickResult,
                measuredTick,
                scenario,
                series,
                counters,
                slowestTicks,
                options.topOutliers
            );

            if (shouldSample(measuredTick, options.ticks, options.sampleEvery)) {
                memorySamples.push(createMemorySample(measuredTick));
                collectGeometrySample(scenario, measuredTick, series, monotonicState);
            }

            if (shouldSample(measuredTick, options.ticks, options.overlapEvery)) {
                collectOverlapSample(scenario, measuredTick, series, counters);
            }
        }

        if (scenario.restartRequested) {
            if (isMeasured) {
                measuredRestarts++;
            }
            scenario = createScenario(options);
            resetMonotonicState(monotonicState);
        }

        if (options.pace) {
            await waitUntil(scheduleStartedAt + globalTick * tickIntervalMs);
        } else if (globalTick % options.yieldEvery === 0) {
            await yieldToEventLoop();
        }

        if (globalTick === options.warmupTicks) {
            collectGarbage();
            retainedMemoryStart = createMemorySample(0);
        }

        printProgress(globalTick, totalTicks, options);
    }

    await yieldToEventLoop();
    collectGarbage();
    const retainedMemoryEnd = createMemorySample(options.ticks);

    const realDurationMs = performance.now() - realStartedAt;

    return createReport({
        counters,
        memorySamples,
        measuredRestarts,
        monotonicState,
        options,
        realDurationMs,
        retainedMemoryEnd,
        retainedMemoryStart,
        series,
        slowestTicks,
        startedAt
    });
}

function createScenario(options) {
    const runtimeConfig = createRoomRuntimeConfig(null, options.difficulty);

    const players = new Map();
    const territories = createTerritories();
    const numberSystem = createNumberSystem(
        runtimeConfig.world.mapRadius,
        players,
        options.difficulty,
        runtimeConfig.numbers
    );
    const scenario = {
        botManager: null,
        numberSystem,
        players,
        restartRequested: false,
        roomCode: options.roomCode,
        runtimeConfig,
        targetBotCount: options.botCount,
        territories
    };

    scenario.botManager = createBotManager({
        botCount: options.botCount,
        botDifficulty: options.difficulty,
        numberSystem,
        players,
        roomCode: options.roomCode,
        runtimeConfig,
        territories
    });
    scenario.botManager.ensureBots();
    return scenario;
}

function executeTick(scenario, now, deltaTime) {
    const phases = {};
    const catchCombatFrame = createCatchCombatFrame(now);
    const context = {
        catchCombatFrame,
        now,
        onRoomPopulationChanged() {
            if (getBotPlayerCount(scenario.players) * 2 < scenario.targetBotCount) {
                scenario.restartRequested = true;
            }
        },
        roomCode: scenario.roomCode,
        runtimeConfig: scenario.runtimeConfig
    };
    let botDiagnostics;
    let trailDiagnostics;
    let numberResult;
    const tickStartedAt = performance.now();

    botDiagnostics = measurePhase(phases, "bots", () => scenario.botManager.update(now));
    measurePhase(phases, "movement", () => {
        updatePlayers(scenario.players, deltaTime, scenario.runtimeConfig);
    });
    trailDiagnostics = measurePhase(phases, "trails", () => (
        updateTrails(scenario.players, scenario.territories, context)
    ));
    numberResult = measurePhase(phases, "numbers", () => scenario.numberSystem.update(now));
    measurePhase(phases, "numberEvents", () => {
        for (const collision of numberResult.collisions || []) {
            handleNumberCollected(scenario.players, scenario.territories, collision, context);
        }
    });
    measurePhase(phases, "catchCombat", () => {
        resolveCatchCombatFrame(scenario.players, scenario.territories, context);
    });

    return {
        botDiagnostics,
        durationMs: performance.now() - tickStartedAt,
        numberResult,
        phases,
        trailDiagnostics
    };
}

function createSeries() {
    return {
        botPhases: new Map(),
        geometry: {
            activeTrails: [],
            territoryPoints: [],
            trailFillPoints: [],
            trailPoints: []
        },
        phases: new Map(),
        tickDurationMs: [],
        trailPhases: new Map()
    };
}

function createCounters() {
    return {
        bot: {},
        botSafety: {},
        botTargeting: {},
        captureApply: {},
        captureApplyMaxima: {},
        numberCollisions: 0,
        overlapChecks: 0,
        overlapIntersectionChecks: 0,
        positiveOverlapSamples: 0,
        positiveOverlapDetails: [],
        repairedOverlapDetails: [],
        maximumOverlapArea: 0,
        maximumOverlapSample: null,
        trails: {}
    };
}

function createMonotonicState() {
    return {
        invalidGeometrySamples: 0,
        territoryVersions: new Map(),
        territoryVersionRegressions: 0,
        trailGenerations: new Map(),
        trailGenerationRegressions: 0
    };
}

function resetMonotonicState(state) {
    state.territoryVersions.clear();
    state.trailGenerations.clear();
}

function collectTickMetrics(result, tick, scenario, series, counters, slowestTicks, outlierLimit) {
    series.tickDurationMs.push(result.durationMs);
    appendPhaseValues(series.phases, result.phases);
    appendPhaseValues(series.botPhases, result.botDiagnostics && result.botDiagnostics.phases);
    appendPhaseValues(series.trailPhases, result.trailDiagnostics && result.trailDiagnostics.phases);
    counters.numberCollisions += (result.numberResult.collisions || []).length;
    addSelectedCounters(counters.trails, result.trailDiagnostics, trailCounterNames);
    addSelectedCounters(
        counters.captureApply,
        result.trailDiagnostics && result.trailDiagnostics.captureApply,
        captureCounterNames
    );
    keepSelectedMaxima(
        counters.captureApplyMaxima,
        result.trailDiagnostics && result.trailDiagnostics.captureApply,
        captureMaximumNames
    );
    recordRepairedOverlapDetail(
        counters,
        result.trailDiagnostics && result.trailDiagnostics.captureApply,
        tick
    );
    addSelectedCounters(counters.bot, result.botDiagnostics, botCounterNames);
    addSelectedCounters(
        counters.botTargeting,
        result.botDiagnostics && result.botDiagnostics.targeting,
        botTargetingCounterNames
    );
    addSelectedCounters(
        counters.botSafety,
        result.botDiagnostics && result.botDiagnostics.selfTrailSafety,
        botSafetyCounterNames
    );

    keepSlowestSamples(slowestTicks, {
        activeTrails: countActiveTrails(scenario.players),
        captureCount: result.trailDiagnostics.captures,
        durationMs: roundMetric(result.durationMs),
        players: scenario.players.size,
        slowestPhase: getSlowestPhase(result.phases),
        territoryPoints: countTerritoryPoints(scenario.territories),
        tick,
        trailPoints: countTrailPoints(scenario.players).authoritative
    }, outlierLimit);
}

function collectGeometrySample(scenario, tick, series, state) {
    const trailPoints = countTrailPoints(scenario.players);

    series.geometry.activeTrails.push(countActiveTrails(scenario.players));
    series.geometry.territoryPoints.push(countTerritoryPoints(scenario.territories));
    series.geometry.trailPoints.push(trailPoints.authoritative);
    series.geometry.trailFillPoints.push(trailPoints.fill);

    for (const [id, territory] of scenario.territories) {
        const previousVersion = state.territoryVersions.get(id);

        if (Number.isFinite(previousVersion) && territory.version < previousVersion) {
            state.territoryVersionRegressions++;
        }
        state.territoryVersions.set(id, territory.version);

        const area = calculatePolygonArea(territory.polygon);

        if (!Number.isFinite(area) || area < 0 || !hasFinitePolygon(territory.polygon)) {
            state.invalidGeometrySamples++;
        }
    }

    for (const player of scenario.players.values()) {
        const previousGeneration = state.trailGenerations.get(player.id);

        if (Number.isFinite(previousGeneration) && player.trailGeneration < previousGeneration) {
            state.trailGenerationRegressions++;
        }
        state.trailGenerations.set(player.id, player.trailGeneration);

        if (!Number.isFinite(player.x) || !Number.isFinite(player.y) || !hasFinitePlayerTrails(player)) {
            state.invalidGeometrySamples++;
        }
    }

    state.lastGeometryTick = tick;
}

function collectOverlapSample(scenario, tick, series, counters) {
    const entries = [...scenario.territories.entries()];
    let sampleMaximum = 0;
    let sampleDetail = null;

    for (let firstIndex = 0; firstIndex < entries.length; firstIndex++) {
        for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex++) {
            const firstTerritory = entries[firstIndex][1];
            const secondTerritory = entries[secondIndex][1];

            counters.overlapChecks++;

            if (firstTerritory.bounds
                && secondTerritory.bounds
                && !doBoundsOverlap(firstTerritory.bounds, secondTerritory.bounds)) {
                continue;
            }

            counters.overlapIntersectionChecks++;
            const area = calculatePolygonIntersectionArea(
                firstTerritory.polygon,
                secondTerritory.polygon
            );

            if (area > sampleMaximum) {
                sampleMaximum = area;
                sampleDetail = createTerritoryOverlapDetail({
                    area,
                    calculateArea: calculatePolygonArea,
                    firstEntry: entries[firstIndex],
                    getPointCount: getPolygonPointCount,
                    players: scenario.players,
                    secondEntry: entries[secondIndex],
                    tick
                });
            }
        }
    }

    if (sampleMaximum > counters.maximumOverlapArea) {
        counters.maximumOverlapArea = sampleMaximum;
        counters.maximumOverlapSample = sampleDetail;
    }

    if (sampleMaximum > 1) {
        counters.positiveOverlapSamples++;
        sampleDetail.repair = {
            backpressureCount: counters.captureApply.overlapRepairWorkerBackpressureCount || 0,
            changedCount: counters.captureApply.overlapRepairWorkerChangedCount || 0,
            completedCount: counters.captureApply.overlapRepairWorkerCompletedCount || 0,
            dispatchedCount: counters.captureApply.overlapRepairWorkerDispatchedCount || 0,
            refreshCount: counters.captureApply.overlapRepairQueueRefreshCount || 0,
            staleCount: counters.captureApply.overlapRepairWorkerStaleCount || 0,
            state: getTerritoryOverlapRepairQueueDiagnostics(scenario.territories)
        };
        counters.positiveOverlapDetails.push(sampleDetail);
    }

    if (!series.geometry.overlapArea) {
        series.geometry.overlapArea = [];
    }
    series.geometry.overlapArea.push(sampleMaximum);
}

function recordRepairedOverlapDetail(counters, captureApply, tick) {
    if (!captureApply || !captureApply.postCaptureOverlapFirst) {
        return;
    }

    counters.repairedOverlapDetails.push({
        tick,
        ...captureApply.postCaptureOverlapFirst
    });
}

function createReport(context) {
    const { options, series, counters, monotonicState } = context;
    const memory = summarizeMemorySamples(context.memorySamples, options.ticks);

    memory.retainedAfterGc = summarizeRetainedMemory(
        context.retainedMemoryStart,
        context.retainedMemoryEnd
    );

    return {
        schema: 1,
        generatedAt: new Date().toISOString(),
        startedAt: context.startedAt.toISOString(),
        environment: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch
        },
        scenario: {
            roomCode: options.roomCode,
            difficulty: options.difficulty,
            botCount: options.botCount,
            seed: options.seed,
            tickRate: config.loop.tickRate,
            warmupTicks: options.warmupTicks,
            measuredTicks: options.ticks,
            simulatedDurationSec: roundMetric(options.ticks / config.loop.tickRate),
            realDurationMs: roundMetric(context.realDurationMs),
            sampleEveryTicks: options.sampleEvery,
            overlapEveryTicks: options.overlapEvery,
            paced: options.pace
        },
        timing: {
            tickDurationMs: summarizeDistribution(series.tickDurationMs),
            phases: summarizePhaseSeries(series.phases),
            botPhases: summarizePhaseSeries(series.botPhases),
            trailPhases: summarizePhaseSeries(series.trailPhases)
        },
        memory,
        geometry: {
            activeTrails: summarizeDistribution(series.geometry.activeTrails),
            territoryPoints: summarizeDistribution(series.geometry.territoryPoints),
            trailPoints: summarizeDistribution(series.geometry.trailPoints),
            trailFillPoints: summarizeDistribution(series.geometry.trailFillPoints),
            overlapArea: summarizeDistribution(series.geometry.overlapArea || []),
            territoryVersionRegressions: monotonicState.territoryVersionRegressions,
            trailGenerationRegressions: monotonicState.trailGenerationRegressions,
            invalidGeometrySamples: monotonicState.invalidGeometrySamples
        },
        events: {
            restarts: context.measuredRestarts,
            numberCollisions: counters.numberCollisions,
            overlapChecks: counters.overlapChecks,
            overlapIntersectionChecks: counters.overlapIntersectionChecks,
            positiveOverlapSamples: counters.positiveOverlapSamples,
            positiveOverlapDetails: counters.positiveOverlapDetails,
            repairedOverlapDetails: counters.repairedOverlapDetails,
            maximumOverlapArea: roundMetric(counters.maximumOverlapArea),
            maximumOverlapSample: counters.maximumOverlapSample,
            trails: counters.trails,
            captureApply: counters.captureApply,
            captureApplyMaxima: counters.captureApplyMaxima,
            bot: counters.bot,
            botTargeting: counters.botTargeting,
            botSafety: counters.botSafety
        },
        slowestTicks: context.slowestTicks
    };
}

function writeReport(report, outputPath) {
    const absoluteOutput = path.resolve(projectRoot, outputPath || defaultOutput);
    const markdownOutput = absoluteOutput.replace(/\.json$/i, ".md");

    mkdirSync(path.dirname(absoluteOutput), { recursive: true });
    writeFileSync(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(markdownOutput, createMarkdownReport(report), "utf8");
}

function createMarkdownReport(report) {
    const tick = report.timing.tickDurationMs;
    const memory = report.memory;
    const geometry = report.geometry;
    const captureApply = report.events.captureApply;

    return `# Baseline local da sala BOTS

Gerado em: ${report.generatedAt}  
Node: ${report.environment.node}  
Seed: ${report.scenario.seed}  
Bots: ${report.scenario.botCount} (${report.scenario.difficulty})  
Ticks medidos: ${report.scenario.measuredTicks} (${report.scenario.simulatedDurationSec} s simulados)  
Tempo real do diagnóstico: ${report.scenario.realDurationMs} ms

## Loop

- média: ${tick.mean} ms
- p50: ${tick.p50} ms
- p95: ${tick.p95} ms
- p99: ${tick.p99} ms
- máximo: ${tick.max} ms

## Memória

- delta bruto do heap: ${formatBytes(memory.heapUsedDeltaBytes)}
- inclinação do heap: ${formatBytes(memory.heapUsedSlopeBytesPer1000Ticks)} por 1000 ticks
- delta bruto do RSS: ${formatBytes(memory.rssDeltaBytes)}
- inclinação do RSS: ${formatBytes(memory.rssSlopeBytesPer1000Ticks)} por 1000 ticks
- heap p95/máximo: ${formatBytes(memory.heapUsed.p95)} / ${formatBytes(memory.heapUsed.max)}
- heap retido após GC (delta): ${formatBytes(memory.retainedAfterGc.heapUsedDeltaBytes)}
- RSS após GC (delta): ${formatBytes(memory.retainedAfterGc.rssDeltaBytes)}

## Geometria

- pontos de territórios p95/máximo: ${geometry.territoryPoints.p95} / ${geometry.territoryPoints.max}
- pontos autoritativos de rastros p95/máximo: ${geometry.trailPoints.p95} / ${geometry.trailPoints.max}
- sobreposição máxima amostrada: ${report.events.maximumOverlapArea}
- amostras com sobreposição positiva: ${report.events.positiveOverlapSamples}
- regressões de versão de território: ${geometry.territoryVersionRegressions}
- regressões de geração de rastro: ${geometry.trailGenerationRegressions}
- amostras geométricas inválidas: ${geometry.invalidGeometrySamples}

## Eventos

- capturas: ${report.events.trails.captures || 0}
- colisões com o próprio rastro: ${report.events.trails.selfCollisions || 0}
- reparações alteradas: ${report.events.captureApply.overlapRepairQueueChangedCount || 0}
- jobs de reparação enviados/concluídos: ${report.events.captureApply.overlapRepairWorkerDispatchedCount || 0} / ${report.events.captureApply.overlapRepairWorkerCompletedCount || 0}
- fallbacks de subtração: ${report.events.captureApply.operationSubtractFallbackCount || 0}
- reinícios da sala: ${report.events.restarts}

O JSON ao lado contém distribuições por fase, contadores detalhados e os ticks mais lentos.
`;
}

function printSummary(report, outputPath) {
    const tick = report.timing.tickDurationMs;
    const resolvedOutput = path.resolve(projectRoot, outputPath || defaultOutput);

    console.log("");
    console.log(`BOTS soak complete: ${report.scenario.measuredTicks} measured ticks.`);
    console.log(`Tick p95/p99/max: ${tick.p95} / ${tick.p99} / ${tick.max} ms.`);
    console.log(`Heap slope: ${formatBytes(report.memory.heapUsedSlopeBytesPer1000Ticks)} per 1000 ticks.`);
    console.log(`Territory/trail max points: ${report.geometry.territoryPoints.max} / ${report.geometry.trailPoints.max}.`);
    console.log(`Report: ${resolvedOutput}`);
}

function parseArguments(argumentsList) {
    const values = new Map();

    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];

        if (!argument.startsWith("--")) {
            throw new Error(`Unexpected argument: ${argument}`);
        }

        const [inlineName, inlineValue] = argument.slice(2).split("=", 2);

        if (!argumentNames.has(inlineName)) {
            throw new Error(`Unknown option: --${inlineName}`);
        }

        const value = inlineValue === undefined ? argumentsList[++index] : inlineValue;

        if (value === undefined || value.startsWith("--")) {
            throw new Error(`Missing value for --${inlineName}`);
        }
        values.set(inlineName, value);
    }

    const ticks = getPositiveInteger(values.get("ticks"), 18000, "ticks");
    const warmupTicks = getNonNegativeInteger(values.get("warmup"), 1800, "warmup");

    return {
        botCount: getPositiveInteger(values.get("bots"), config.menuBackground.botCount, "bots"),
        difficulty: getDifficulty(values.get("difficulty") || config.menuBackground.difficulty),
        output: values.get("output") || defaultOutput,
        overlapEvery: getPositiveInteger(values.get("overlap-every"), 600, "overlap-every"),
        pace: getBoolean(values.get("pace"), true, "pace"),
        roomCode: String(config.menuBackground.roomCode || "BOTS"),
        sampleEvery: getPositiveInteger(values.get("sample-every"), 60, "sample-every"),
        seed: getSeed(values.get("seed"), 0xb075500),
        ticks,
        topOutliers: getPositiveInteger(values.get("top"), 10, "top"),
        warmupTicks,
        yieldEvery: getPositiveInteger(values.get("yield-every"), 1, "yield-every")
    };
}

function getPositiveInteger(value, fallback, name) {
    if (value === undefined) {
        return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--${name} must be a positive integer.`);
    }
    return parsed;
}

function getNonNegativeInteger(value, fallback, name) {
    if (value === undefined) {
        return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--${name} must be a non-negative integer.`);
    }
    return parsed;
}

function getSeed(value, fallback) {
    if (value === undefined) {
        return fallback >>> 0;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
        throw new Error("--seed must be an unsigned 32-bit integer.");
    }
    return parsed >>> 0;
}

function getBoolean(value, fallback, name) {
    if (value === undefined) {
        return fallback;
    }

    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    throw new Error(`--${name} must be true or false.`);
}

function getDifficulty(value) {
    const normalized = String(value || "").trim().toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(config.gameMode.catch.livesByDifficulty, normalized)) {
        throw new Error("--difficulty must be easy, medium or hard.");
    }
    return normalized;
}

function createSeededRandom(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function measurePhase(phases, name, callback) {
    const startedAt = performance.now();

    try {
        return callback();
    } finally {
        phases[name] = performance.now() - startedAt;
    }
}

function appendPhaseValues(target, phases) {
    for (const [name, duration] of Object.entries(phases || {})) {
        if (!Number.isFinite(duration)) {
            continue;
        }

        if (!target.has(name)) {
            target.set(name, []);
        }
        target.get(name).push(duration);
    }
}

function summarizePhaseSeries(series) {
    const summary = {};

    for (const [name, values] of series) {
        summary[name] = summarizeDistribution(values);
    }
    return summary;
}

function addSelectedCounters(target, source, names) {
    for (const name of names) {
        const value = source && source[name];

        if (Number.isFinite(value)) {
            target[name] = (target[name] || 0) + value;
        }
    }
}

function keepSelectedMaxima(target, source, names) {
    for (const name of names) {
        const value = source && source[name];

        if (Number.isFinite(value)) {
            target[name] = Math.max(target[name] || 0, value);
        }
    }
}

function getSlowestPhase(phases) {
    let slowest = null;

    for (const [name, durationMs] of Object.entries(phases || {})) {
        if (!slowest || durationMs > slowest.durationMs) {
            slowest = { name, durationMs: roundMetric(durationMs) };
        }
    }
    return slowest;
}

function countTerritoryPoints(territories) {
    let count = 0;

    for (const territory of territories.values()) {
        count += getPolygonPointCount(territory.polygon);
    }
    return count;
}

function countTrailPoints(players) {
    let authoritative = 0;
    let fill = 0;

    for (const player of players.values()) {
        authoritative += countSegments(player.trailLeftSegments);
        authoritative += countSegments(player.trailRightSegments);
        fill += (player.trailLeftFillPath || []).length;
        fill += (player.trailRightFillPath || []).length;
    }

    return { authoritative, fill };
}

function countSegments(segments) {
    return (segments || []).reduce((sum, segment) => (
        sum + (Array.isArray(segment) ? segment.length : 0)
    ), 0);
}

function countActiveTrails(players) {
    let count = 0;

    for (const player of players.values()) {
        if (player.isLeftTrailActive || player.isRightTrailActive) {
            count++;
        }
    }
    return count;
}

function hasFinitePolygon(polygon) {
    return (polygon || []).every(ring => (
        Array.isArray(ring)
        && ring.every(point => (
            Array.isArray(point)
            && Number.isFinite(point[0])
            && Number.isFinite(point[1])
        ))
    ));
}

function hasFinitePlayerTrails(player) {
    return [player.trailLeftSegments, player.trailRightSegments].every(segments => (
        (segments || []).every(segment => (
            (segment || []).every(point => (
                Number.isFinite(point.x) && Number.isFinite(point.y)
            ))
        ))
    ));
}

function createMemorySample(tick) {
    const memory = process.memoryUsage();

    return {
        tick,
        heapUsed: memory.heapUsed,
        rss: memory.rss,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers
    };
}

function summarizeRetainedMemory(start, end) {
    if (!start || !end) {
        return {
            gcAvailable: typeof global.gc === "function",
            heapUsedDeltaBytes: null,
            rssDeltaBytes: null,
            start: null,
            end: null
        };
    }

    return {
        gcAvailable: typeof global.gc === "function",
        heapUsedDeltaBytes: end.heapUsed - start.heapUsed,
        rssDeltaBytes: end.rss - start.rss,
        start,
        end
    };
}

function collectGarbage() {
    if (typeof global.gc === "function") {
        global.gc();
    }
}

function shouldSample(tick, totalTicks, interval) {
    return tick === 1 || tick === totalTicks || tick % interval === 0;
}

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

async function waitUntil(targetTime) {
    const remainingMs = targetTime - performance.now();

    if (remainingMs > 1) {
        await new Promise(resolve => setTimeout(resolve, remainingMs));
        return;
    }

    await yieldToEventLoop();
}

function printProgress(tick, totalTicks, options) {
    if (options.quiet || tick !== totalTicks && tick % Math.max(1, Math.floor(totalTicks / 10)) !== 0) {
        return;
    }

    const percentage = Math.floor(tick / totalTicks * 100);
    process.stderr.write(`BOTS soak: ${percentage}% (${tick}/${totalTicks})\n`);
}

function formatBytes(value) {
    if (!Number.isFinite(value)) {
        return "n/a";
    }

    const sign = value < 0 ? "-" : "";
    const absolute = Math.abs(value);

    if (absolute >= 1024 * 1024) {
        return `${sign}${roundMetric(absolute / (1024 * 1024))} MiB`;
    }
    if (absolute >= 1024) {
        return `${sign}${roundMetric(absolute / 1024)} KiB`;
    }
    return `${sign}${roundMetric(absolute)} B`;
}
