"use strict";

const { performance } = require("node:perf_hooks");
const { deflateRawSync } = require("node:zlib");
const config = require("../../src/config/gameConfig");
const {
    createClientSnapshotState,
    createSnapshot,
    createSnapshotSharedFrame
} = require("../../src/core/snapshotSerializer");
const { createPlayer } = require("../../src/entities/player");
const { initializePlayerTerritory } = require("../../src/state/territories");

function createSyntheticPlayers(scenario, count, difficulty) {
    for (let index = 0; index < count; index++) {
        const id = `benchmark-human:${index + 1}`;
        const player = createPlayer(scenario.players, id, scenario.territories, {
            difficulty,
            maxLives: 1_000_000,
            name: `Simulado ${index + 1}`,
            runtimeConfig: scenario.runtimeConfig
        });

        if (!player) {
            throw new Error(`Could not create synthetic player ${index + 1} of ${count}.`);
        }

        player.benchmarkInput = {
            direction: index % 2 === 0 ? 1 : -1,
            flankDurationMs: 800 + index % 4 * 100,
            loop: 0,
            mode: "outbound",
            outboundAngle: player.angle,
            outboundDurationMs: 1000 + index % 5 * 120,
            switchAt: null
        };
        player.setDirectionAngle(player.angle, "benchmark");
        initializePlayerTerritory(scenario.territories, player, scenario.runtimeConfig);
        scenario.syntheticPlayerIds.add(id);
    }
}

function updateSyntheticPlayerInputs(scenario, now) {
    for (const playerId of scenario.syntheticPlayerIds) {
        const player = scenario.players.get(playerId);
        const input = player && player.benchmarkInput;

        if (player && input) {
            updateSyntheticPlayerInput(player, input, scenario.runtimeConfig, now);
        }
    }
}

function updateSyntheticPlayerInput(player, input, runtimeConfig, now) {
    if (!Number.isFinite(input.switchAt)) {
        input.switchAt = now + input.outboundDurationMs;
    }
    if (input.mode === "outbound" && now >= input.switchAt) {
        input.mode = "flank";
        input.switchAt = now + input.flankDurationMs;
    }
    if (input.mode === "flank" && now >= input.switchAt) {
        input.mode = "return";
    }
    if (input.mode === "return" && isSyntheticPlayerBackAtBase(player, runtimeConfig)) {
        input.mode = "inside";
    }
    if (input.mode === "inside" && !hasActiveTrail(player)) {
        input.loop++;
        input.mode = "outbound";
        input.outboundAngle = player.angle
            + input.direction * (Math.PI * 0.58 + input.loop % 3 * 0.16);
        input.switchAt = now + input.outboundDurationMs;
    }

    player.setDirectionAngle(getSyntheticTargetAngle(player, input), "benchmark");
}

function getSyntheticTargetAngle(player, input) {
    if (input.mode === "return" || input.mode === "inside") {
        return Math.atan2(player.territoryY - player.y, player.territoryX - player.x);
    }
    if (input.mode === "flank") {
        return input.outboundAngle + input.direction * Math.PI / 2;
    }
    return input.outboundAngle;
}

function isSyntheticPlayerBackAtBase(player, runtimeConfig) {
    const distance = Math.hypot(
        player.x - player.territoryX,
        player.y - player.territoryY
    );

    return distance <= runtimeConfig.world.initialTerritoryRadius * 0.8;
}

function hasActiveTrail(player) {
    return Boolean(player.isLeftTrailActive || player.isRightTrailActive);
}

function shouldBuildSnapshots(scenario) {
    if (!scenario.snapshotsEnabled) {
        return false;
    }

    const ticksPerSnapshot = Math.max(1, Math.round(config.loop.tickRate / config.loop.snapshotRate));
    return scenario.tick % ticksPerSnapshot === 0;
}

function buildScenarioSnapshots(scenario) {
    const buildDurations = [];
    const compressedPayloadBytes = [];
    const compressionDurations = [];
    const payloads = [];
    const payloadBytes = [];
    const serializeDurations = [];
    let totalCompressedPayloadBytes = 0;
    let totalPayloadBytes = 0;

    pruneSnapshotStates(scenario);
    const applicationStartedAt = performance.now();
    const sharedFrame = createSnapshotSharedFrame(
        scenario.players,
        scenario.territories,
        scenario.numberSystem,
        scenario.runtimeConfig
    );

    for (const player of scenario.players.values()) {
        const clientState = getSnapshotState(scenario, player.id);
        const buildStartedAt = performance.now();
        const snapshot = createSnapshot(
            scenario.players,
            scenario.territories,
            player.id,
            clientState,
            scenario.numberSystem,
            scenario.runtimeConfig,
            sharedFrame
        );
        buildDurations.push(performance.now() - buildStartedAt);

        const serializeStartedAt = performance.now();
        const payload = Buffer.from(JSON.stringify(snapshot));
        serializeDurations.push(performance.now() - serializeStartedAt);
        payloadBytes.push(payload.byteLength);
        payloads.push(payload);
        totalPayloadBytes += payload.byteLength;
    }

    const applicationBatchDurationMs = performance.now() - applicationStartedAt;
    const compressionStartedAt = performance.now();

    for (const payload of payloads) {
        const itemStartedAt = performance.now();
        const compressedBytes = compressSnapshotPayload(payload);
        compressionDurations.push(performance.now() - itemStartedAt);
        compressedPayloadBytes.push(compressedBytes);
        totalCompressedPayloadBytes += compressedBytes;
    }

    return {
        applicationBatchDurationMs,
        buildDurations,
        compressedPayloadBytes,
        compressionBatchDurationMs: performance.now() - compressionStartedAt,
        compressionDurations,
        payloadBytes,
        serializeDurations,
        totalCompressedPayloadBytes,
        totalPayloadBytes,
        viewerCount: scenario.players.size
    };
}

function pruneSnapshotStates(scenario) {
    for (const playerId of scenario.snapshotStates.keys()) {
        if (!scenario.players.has(playerId)) {
            scenario.snapshotStates.delete(playerId);
        }
    }
}

function getSnapshotState(scenario, playerId) {
    let clientState = scenario.snapshotStates.get(playerId);

    if (!clientState) {
        clientState = createClientSnapshotState();
        scenario.snapshotStates.set(playerId, clientState);
    }
    return clientState;
}

function compressSnapshotPayload(payload) {
    const threshold = Number(config.socket?.perMessageDeflate?.threshold) || 0;

    if (payload.byteLength < threshold) {
        return payload.byteLength;
    }

    const level = Number(config.socket?.perMessageDeflate?.zlibDeflateOptions?.level);
    return deflateRawSync(payload, {
        level: Number.isInteger(level) ? level : undefined
    }).byteLength;
}

module.exports = {
    buildScenarioSnapshots,
    createSyntheticPlayers,
    shouldBuildSnapshots,
    updateSyntheticPlayerInputs
};
