"use strict";

const config = require("../../src/config/gameConfig");
const { calculateActiveBotTarget } = require("../../src/core/roomCapacity");
const { createRoomRuntimeConfig } = require("../../src/core/roomSettings");

const DEFAULT_MAP_SIZES = Object.freeze([1, 1.5, 2]);
const GAME_TICK_BUDGET_MS = 1000 / config.loop.tickRate;
const SNAPSHOT_BATCH_BUDGET_MS = 1000 / config.loop.snapshotRate;

function createCapacityScenarios(mapSizes = DEFAULT_MAP_SIZES) {
    const scenarios = [];

    for (const mapSize of mapSizes) {
        const maximum = createRoomRuntimeConfig({
            mapSize,
            maxPlayers: config.rooms.maxPlayersPerRoom
        });
        const capacity = maximum.customOptions.maxPlayers;
        const numberCount = maximum.numbers.maxNumbers;
        const mixedBotCount = Math.min(2, capacity);
        const maximumActiveBots = calculateActiveBotTarget(capacity, 0, capacity);

        scenarios.push({
            botCount: mixedBotCount,
            capacity,
            id: createScenarioId(mapSize, "mixed"),
            mapSize,
            mode: "mixed",
            numberCount,
            playerCount: capacity
        });
        scenarios.push({
            botCount: maximumActiveBots,
            capacity,
            id: createScenarioId(mapSize, "bot-heavy"),
            mapSize,
            mode: "bot-heavy",
            numberCount,
            playerCount: maximumActiveBots
        });
    }

    return scenarios;
}

function assessCapacityReport(report, thresholds = {}) {
    const tickBudgetMs = finitePositive(thresholds.tickBudgetMs, GAME_TICK_BUDGET_MS);
    const snapshotBudgetMs = finitePositive(
        thresholds.snapshotBudgetMs,
        SNAPSHOT_BATCH_BUDGET_MS
    );
    const tickP99 = report?.timing?.tickDurationMs?.p99;
    const snapshotBatchP99 = report?.timing?.phases?.snapshots?.p99;
    const geometry = report?.geometry || {};
    const issues = [];

    addBudgetIssue(issues, "tick-p99", tickP99, tickBudgetMs);
    addBudgetIssue(issues, "snapshot-batch-p99", snapshotBatchP99, snapshotBudgetMs);

    if ((geometry.invalidGeometrySamples || 0) > 0) {
        issues.push(createIssue("invalid-geometry", geometry.invalidGeometrySamples, 0, "fail"));
    }
    if ((geometry.territoryVersionRegressions || 0) > 0) {
        issues.push(createIssue(
            "territory-version-regression",
            geometry.territoryVersionRegressions,
            0,
            "fail"
        ));
    }
    if ((geometry.trailGenerationRegressions || 0) > 0) {
        issues.push(createIssue(
            "trail-generation-regression",
            geometry.trailGenerationRegressions,
            0,
            "fail"
        ));
    }

    return {
        status: issues.some(issue => issue.severity === "fail")
            ? "fail"
            : issues.length > 0 ? "warn" : "pass",
        issues,
        thresholds: {
            snapshotBatchP99Ms: snapshotBudgetMs,
            tickP99Ms: tickBudgetMs
        }
    };
}

function addBudgetIssue(issues, name, value, budget) {
    if (!Number.isFinite(value)) {
        issues.push(createIssue(name, value, budget, "fail"));
        return;
    }

    if (value > budget) {
        issues.push(createIssue(name, value, budget, "warn"));
    }
}

function createIssue(name, value, budget, severity) {
    return { budget, name, severity, value: Number.isFinite(value) ? value : null };
}

function createScenarioId(mapSize, mode) {
    return `map-${String(mapSize).replace(".", "_")}-${mode}`;
}

function finitePositive(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

module.exports = {
    GAME_TICK_BUDGET_MS,
    SNAPSHOT_BATCH_BUDGET_MS,
    assessCapacityReport,
    createCapacityScenarios
};
