const config = require("../config/gameConfig");
const { serializeRoomSettings } = require("./roomSettings");
const { getServerTime } = require("../utils/time");
const { calculatePolygonArea, getPolygonBounds } = require("../utils/geometry");
const {
    cloneClientSnapshotState,
    createClientSnapshotState
} = require("./snapshotClientState");
const {
    createSnapshotPayloadBudget,
    serializeSnapshotPayloadBudget
} = require("./snapshotPayloadBudget");
const {
    packAngle,
    packCoordinate,
    shouldSendVersionedState
} = require("./snapshotSerializationPrimitives");
const {
    removeUnselectedTerritoryStates,
    serializeChangedTerritoryState
} = require("./snapshotTerritorySerializer");
const {
    getTrailBounds,
    hasAnyTrail,
    removeUnselectedTrailStates,
    serializeTrailUpdates
} = require("./snapshotTrailSerializer");

/**
 * Builds schema-2 snapshots against a per-socket confirmed state.
 * The caller clones that state before reliable sends and commits it only after
 * acknowledgement. Protocol invariants are documented in .ai/docs/SNAPSHOT_PROTOCOL.md.
 */

function createSnapshot(players, territories, viewerId = null, clientState = createClientSnapshotState(), numberSystem = null, runtimeConfig = null) {
    const viewer = viewerId ? players.get(viewerId) : null;
    const now = getServerTime();
    ensureVisibilityState(clientState);
    const interestBounds = createInterestBounds(viewer, config.network.interestMargin);
    const exitInterestBounds = createInterestBounds(viewer, getInterestExitMargin());
    const playerIds = getVisiblePlayerIds(players, viewerId, interestBounds);
    const territoryIds = getVisibleTerritoryIds(
        territories,
        viewerId,
        interestBounds,
        exitInterestBounds,
        clientState.territoryVisibility,
        now
    );
    const trailIds = getVisibleTrailIds(
        players,
        viewerId,
        interestBounds,
        exitInterestBounds,
        clientState.trailVisibility,
        now
    );
    const payloadBudget = createSnapshotPayloadBudget();

    prunePlayerInfoState(clientState, players);
    const removedTerritoryIds = removeUnselectedTerritoryStates(
        clientState,
        new Set(territoryIds)
    );

    const territoryChanges = serializeChangedTerritoryState(
        territories,
        prioritizeVisibleIds(territoryIds, viewerId),
        viewerId,
        clientState,
        now,
        payloadBudget
    );
    const trailUpdates = serializeTrailUpdates(
        players,
        prioritizeVisibleIds(trailIds, viewerId),
        viewerId,
        clientState,
        now,
        payloadBudget
    );
    const trailRemovals = removeUnselectedTrailStates(
        players,
        clientState,
        new Set(trailIds)
    );
    const snapshot = {
        schema: 2,
        time: now,
        players: serializePlayerPositions(players, playerIds),
        playerInfo: serializeChangedPlayerInfo(players, playerIds, clientState, now),
        territoryIds: territoryChanges.territoryIds,
        territoryVersions: territoryChanges.territoryVersions,
        territories: territoryChanges.territories,
        territoryOps: territoryChanges.operations,
        removedTerritoryIds,
        trailIds: trailUpdates.trailIds,
        trails: trailUpdates.trails,
        removedTrailIds: Object.keys(trailRemovals),
        trailRemovals,
        mode: config.gameMode.mode,
        roomConfig: serializeRoomSettings(runtimeConfig),
        catchStatus: serializeCatchStatus(players, viewerId, runtimeConfig, now),
        leaderboard: createLeaderboard(players, territories, runtimeConfig),
        numbers: numberSystem ? numberSystem.serialize() : null
    };

    const payloadBudgetDiagnostics = serializeSnapshotPayloadBudget(payloadBudget);
    if (payloadBudgetDiagnostics) {
        snapshot.payloadBudget = payloadBudgetDiagnostics;
    }

    if (viewer && viewer.debugState) {
        snapshot.debug = {
            [viewer.id]: viewer.debugState
        };
    }

    return snapshot;
}

function serializePlayerPositions(players, playerIds) {
    const serializedPlayers = {};

    for (const playerId of playerIds) {
        const player = players.get(playerId);

        if (!player) {
            continue;
        }

        serializedPlayers[player.id] = [
            packCoordinate(player.x),
            packCoordinate(player.y),
            packAngle(player.angle)
        ];
    }

    return serializedPlayers;
}

function serializeChangedPlayerInfo(players, playerIds, clientState, now) {
    const serializedInfo = {};

    for (const playerId of playerIds) {
        const player = players.get(playerId);

        if (!player) {
            continue;
        }

        const version = player.infoVersion || 0;
        const knownInfo = clientState.playerInfo.get(player.id);

        if (!shouldSendVersionedState(knownInfo, version, now, config.network.playerInfoFullSyncIntervalMs)) {
            continue;
        }

        serializedInfo[player.id] = [
            player.color,
            packCoordinate(player.territoryX),
            packCoordinate(player.territoryY),
            version,
            player.name,
            player.eliminations,
            player.lives,
            player.maxLives,
            player.catchBalance
        ];
        clientState.playerInfo.set(player.id, {
            version,
            sentAt: now
        });
    }

    return serializedInfo;
}

function createLeaderboard(players, territories, runtimeConfig = null) {
    const worldConfig = runtimeConfig && runtimeConfig.world ? runtimeConfig.world : config.world;
    const totalArea = Math.PI * worldConfig.mapRadius * worldConfig.mapRadius;

    return [...players.values()]
        .map(player => {
            const territory = territories.get(player.id);
            const area = territory ? Math.max(0, calculatePolygonArea(territory.polygon)) : 0;

            return {
                id: player.id,
                name: player.name,
                areaPercent: totalArea > 0 ? area / totalArea * 100 : 0,
                eliminations: player.eliminations || 0
            };
        })
        .sort((first, second) => {
            if (Math.abs(second.areaPercent - first.areaPercent) > 0.001) {
                return second.areaPercent - first.areaPercent;
            }

            return second.eliminations - first.eliminations;
        })
        .map((entry, index) => ({
            ...entry,
            rank: index + 1
        }));
}

function serializeCatchStatus(players, viewerId, runtimeConfig, now) {
    const viewer = viewerId ? players.get(viewerId) : null;

    if (!viewer) {
        return null;
    }

    const outgoingTargets = [...viewer.pendingCatchEliminationTargets]
        .filter(targetId => players.has(targetId));
    const incomingMarkers = [...players.values()]
        .filter(player => (
            player.id !== viewer.id
            && player.pendingCatchEliminationTargets.has(viewer.id)
        ));
    const graceMs = getCounterattackGraceMs(runtimeConfig);
    const outgoingRemainingMs = getMinimumCounterattackRemainingMs(
        outgoingTargets.map(targetId => getCounterattackRemainingMs(
            viewer,
            targetId,
            now,
            graceMs
        ))
    );
    const incomingRemainingMs = getMinimumCounterattackRemainingMs(
        incomingMarkers.map(marker => getCounterattackRemainingMs(
            marker,
            viewer.id,
            now,
            graceMs
        ))
    );

    return {
        counterTargetCount: outgoingTargets.length,
        counterRiskArmed: outgoingTargets.length > 0 && outgoingRemainingMs === 0,
        counterRiskRemainingMs: outgoingRemainingMs,
        threatCount: incomingMarkers.length,
        threatArmed: incomingMarkers.length > 0 && incomingRemainingMs === 0,
        threatRemainingMs: incomingRemainingMs
    };
}

function getCounterattackRemainingMs(marker, targetId, now, graceMs) {
    const markedAt = marker
        && typeof marker.getCatchEliminationMarkedAt === "function"
        ? marker.getCatchEliminationMarkedAt(targetId)
        : null;

    if (!Number.isFinite(markedAt) || !Number.isFinite(now)) {
        return null;
    }

    return Math.max(0, Math.ceil(graceMs - (now - markedAt)));
}

function getMinimumCounterattackRemainingMs(values) {
    const finiteValues = values.filter(Number.isFinite);

    return finiteValues.length > 0 ? Math.min(...finiteValues) : null;
}

function getCounterattackGraceMs(runtimeConfig) {
    const configuredValue = runtimeConfig
        && runtimeConfig.gameMode
        && runtimeConfig.gameMode.catch
        && runtimeConfig.gameMode.catch.counterattackGraceMs;
    const fallbackValue = config.gameMode
        && config.gameMode.catch
        && config.gameMode.catch.counterattackGraceMs;

    if (Number.isFinite(configuredValue) && configuredValue >= 0) {
        return configuredValue;
    }

    return Number.isFinite(fallbackValue) && fallbackValue >= 0
        ? fallbackValue
        : 1200;
}

function getVisiblePlayerIds(players, viewerId, interestBounds) {
    const playerIds = [];

    for (const player of players.values()) {
        if (
            !config.network.cullPlayerPositionsByViewport
            || player.id === viewerId
            || isPointNearBounds(player, interestBounds, config.world.playerSize)
        ) {
            playerIds.push(player.id);
        }
    }

    return playerIds;
}

function getVisibleTerritoryIds(
    territories,
    viewerId,
    interestBounds,
    exitInterestBounds,
    visibilityState,
    now
) {
    const territoryIds = [];

    for (const [territoryId, territory] of territories.entries()) {
        const bounds = getPolygonBounds(territory.polygon);

        if (shouldRetainVisibleEntity(
            territoryId,
            territoryId === viewerId || boundsOverlap(bounds, interestBounds),
            boundsOverlap(bounds, exitInterestBounds),
            visibilityState,
            now
        )) {
            territoryIds.push(territoryId);
        }
    }

    pruneMapKeys(visibilityState, id => territories.has(id));
    return territoryIds;
}

function getVisibleTrailIds(
    players,
    viewerId,
    interestBounds,
    exitInterestBounds,
    visibilityState,
    now
) {
    const trailIds = [];

    for (const player of players.values()) {
        if (!hasAnyTrail(player)) {
            visibilityState.delete(player.id);
            continue;
        }

        const bounds = getTrailBounds(player);

        if (shouldRetainVisibleEntity(
            player.id,
            player.id === viewerId || boundsOverlap(bounds, interestBounds),
            boundsOverlap(bounds, exitInterestBounds),
            visibilityState,
            now
        )) {
            trailIds.push(player.id);
        }
    }

    pruneMapKeys(visibilityState, id => players.has(id));
    return trailIds;
}

function shouldRetainVisibleEntity(id, isInsideEntryBounds, isInsideExitBounds, visibilityState, now) {
    if (isInsideEntryBounds) {
        visibilityState.set(id, now);
        return true;
    }

    const lastVisibleAt = visibilityState.get(id);

    if (Number.isFinite(lastVisibleAt) && isInsideExitBounds) {
        visibilityState.set(id, now);
        return true;
    }

    if (
        Number.isFinite(lastVisibleAt)
        && now - lastVisibleAt <= getInterestRetentionMs()
    ) {
        return true;
    }

    visibilityState.delete(id);
    return false;
}

function prioritizeVisibleIds(ids, priorityId) {
    if (!priorityId || !Array.isArray(ids) || ids.length < 2) {
        return ids;
    }

    const priorityIndex = ids.indexOf(priorityId);

    if (priorityIndex <= 0) {
        return ids;
    }

    return [
        ids[priorityIndex],
        ...ids.slice(0, priorityIndex),
        ...ids.slice(priorityIndex + 1)
    ];
}

function createInterestBounds(viewer, margin = config.network.interestMargin) {
    if (!viewer) {
        return null;
    }

    const viewport = viewer.viewport || {};
    const scale = Number.isFinite(viewport.scale) && viewport.scale > 0 ? viewport.scale : 1;
    const worldWidth = clamp(
        (Number.isFinite(viewport.width) ? viewport.width : config.screen.virtualWidth) / scale,
        1,
        config.network.maxViewportWorldWidth
    );
    const worldHeight = clamp(
        (Number.isFinite(viewport.height) ? viewport.height : config.screen.virtualHeight) / scale,
        1,
        config.network.maxViewportWorldHeight
    );
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;

    return {
        minX: viewer.x - worldWidth / 2 - safeMargin,
        minY: viewer.y - worldHeight / 2 - safeMargin,
        maxX: viewer.x + worldWidth / 2 + safeMargin,
        maxY: viewer.y + worldHeight / 2 + safeMargin
    };
}

function ensureVisibilityState(clientState) {
    if (!(clientState.territoryVisibility instanceof Map)) {
        clientState.territoryVisibility = new Map();
    }

    if (!(clientState.trailVisibility instanceof Map)) {
        clientState.trailVisibility = new Map();
    }
}

function prunePlayerInfoState(clientState, players) {
    pruneMapKeys(clientState.playerInfo, id => players.has(id));
}

function pruneMapKeys(map, shouldKeep) {
    for (const key of map.keys()) {
        if (!shouldKeep(key)) {
            map.delete(key);
        }
    }
}

function getInterestExitMargin() {
    const configured = config.network.interestExitMargin;
    const entryMargin = Number.isFinite(config.network.interestMargin)
        ? Math.max(0, config.network.interestMargin)
        : 0;

    return Number.isFinite(configured)
        ? Math.max(entryMargin, configured)
        : entryMargin;
}

function getInterestRetentionMs() {
    return Number.isFinite(config.network.interestRetentionMs)
        ? Math.max(0, config.network.interestRetentionMs)
        : 0;
}

function boundsOverlap(first, second) {
    if (!first || !second) {
        return true;
    }

    return first.minX <= second.maxX
        && first.maxX >= second.minX
        && first.minY <= second.maxY
        && first.maxY >= second.minY;
}

function isPointNearBounds(point, bounds, margin = 0) {
    if (!bounds || !point) {
        return true;
    }

    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;

    return point.x >= bounds.minX - safeMargin
        && point.x <= bounds.maxX + safeMargin
        && point.y >= bounds.minY - safeMargin
        && point.y <= bounds.maxY + safeMargin;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

module.exports = {
    cloneClientSnapshotState,
    createClientSnapshotState,
    createSnapshot
};
