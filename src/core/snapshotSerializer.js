const config = require("../config/gameConfig");
const { serializeRoomSettings } = require("./roomSettings");
const { getServerTime } = require("../utils/time");
const { calculatePolygonArea, getPolygonBounds } = require("../utils/geometry");

function createClientSnapshotState() {
    return {
        playerInfo: new Map(),
        territories: new Map(),
        trails: new Map(),
        territoryVisibility: new Map(),
        trailVisibility: new Map(),
        territoryPoints: new Map(),
        nextTerritoryPointId: 1
    };
}

function cloneClientSnapshotState(clientState = createClientSnapshotState()) {
    return {
        playerInfo: cloneMap(clientState.playerInfo, cloneVersionedState),
        territories: cloneMap(clientState.territories, cloneVersionedState),
        trails: cloneMap(clientState.trails, cloneTrailState),
        territoryVisibility: new Map(clientState.territoryVisibility || []),
        trailVisibility: new Map(clientState.trailVisibility || []),
        territoryPoints: new Map(clientState.territoryPoints || []),
        nextTerritoryPointId: Number.isInteger(clientState.nextTerritoryPointId)
            ? clientState.nextTerritoryPointId
            : 1
    };
}

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

function serializeTerritoryVersions(territories, territoryIds, clientState) {
    const serializedVersions = {};

    for (const territoryId of territoryIds) {
        const territory = territories.get(territoryId);
        const knownTerritory = clientState && clientState.territories
            ? clientState.territories.get(territoryId)
            : null;

        if (knownTerritory) {
            serializedVersions[territoryId] = knownTerritory.version || 0;
        } else if (territory) {
            serializedVersions[territoryId] = territory.version || 0;
        }
    }

    return serializedVersions;
}

function serializeChangedTerritoryState(territories, territoryIds, viewerId, clientState, now, payloadBudget = null) {
    const serializedTerritories = {};
    const serializedOperations = {};
    const includedTerritoryIds = [];
    const captureSync = createCaptureTerritorySyncGroups(territories, territoryIds, clientState, now);

    for (const territoryId of territoryIds) {
        const territory = territories.get(territoryId);

        if (!territory) {
            continue;
        }

        const version = territory.version || 0;
        const knownTerritory = clientState.territories.get(territoryId);
        const forceFullTerritory = captureSync.forcedFullTerritoryIds.has(territoryId)
            || captureSync.ownerGroupIds.has(territoryId);
        let includeTerritoryId = Boolean(knownTerritory);

        if (
            !forceFullTerritory
            && !shouldSendVersionedState(knownTerritory, version, now, config.network.territoryFullSyncIntervalMs)
        ) {
            includedTerritoryIds.push(territoryId);
            continue;
        }

        const knownTrail = clientState.trails.get(territoryId);
        const operation = forceFullTerritory
            ? null
            : createCaptureTerritoryOperation(territory, knownTerritory, knownTrail, territoryId, viewerId);

        if (operation) {
            consumeSnapshotPayloadBudget(payloadBudget, "territoryOps", estimateTerritoryOperationPayloadBytes(operation), {
                force: true
            });
            serializedOperations[territoryId] = operation;
            clientState.territories.set(territoryId, {
                version,
                sentAt: now
            });
            includedTerritoryIds.push(territoryId);
            continue;
        }

        if (!consumeSnapshotPayloadBudget(payloadBudget, "territories", estimateTerritoryPayloadBytes(territory), {
            force: territoryId === viewerId || forceFullTerritory
        })) {
            if (includeTerritoryId) {
                includedTerritoryIds.push(territoryId);
            }
            continue;
        }

        serializedTerritories[territoryId] = {
            version,
            color: territory.color,
            base: [
                packCoordinate(territory.baseX),
                packCoordinate(territory.baseY)
            ],
            polygon: packReferencedPolygon(territory.polygon, clientState)
        };
        clientState.territories.set(territoryId, {
            version,
            sentAt: now
        });
        includeTerritoryId = true;

        if (includeTerritoryId) {
            includedTerritoryIds.push(territoryId);
        }
    }

    return {
        territoryIds: includedTerritoryIds,
        territoryVersions: serializeTerritoryVersions(territories, includedTerritoryIds, clientState),
        territories: serializedTerritories,
        operations: serializedOperations
    };
}

function createCaptureTerritorySyncGroups(territories, territoryIds, clientState, now) {
    const visibleTerritoryIds = new Set(territoryIds);
    const ownerGroupIds = new Set();
    const forcedFullTerritoryIds = new Set();

    for (const territoryId of territoryIds) {
        const territory = territories.get(territoryId);
        const affectedIds = getVisibleCaptureAffectedTerritoryIds(
            territory,
            territories,
            visibleTerritoryIds
        );

        if (affectedIds.length <= 0) {
            continue;
        }

        const ownerVersion = territory.version || 0;
        const knownOwnerTerritory = clientState.territories.get(territoryId);

        if (!shouldSendVersionedState(knownOwnerTerritory, ownerVersion, now, config.network.territoryFullSyncIntervalMs)) {
            continue;
        }

        const staleAffectedIds = affectedIds.filter(affectedId => {
            const affectedTerritory = territories.get(affectedId);
            const affectedVersion = affectedTerritory ? affectedTerritory.version || 0 : 0;
            const knownAffectedTerritory = clientState.territories.get(affectedId);

            return affectedTerritory
                && shouldSendVersionedState(
                    knownAffectedTerritory,
                    affectedVersion,
                    now,
                    config.network.territoryFullSyncIntervalMs
                );
        });

        if (staleAffectedIds.length <= 0) {
            continue;
        }

        ownerGroupIds.add(territoryId);

        for (const affectedId of staleAffectedIds) {
            forcedFullTerritoryIds.add(affectedId);
        }
    }

    return {
        forcedFullTerritoryIds,
        ownerGroupIds
    };
}

function getVisibleCaptureAffectedTerritoryIds(territory, territories, visibleTerritoryIds) {
    if (!territory || !Array.isArray(territory.captureAffectedTerritoryIds)) {
        return [];
    }

    return territory.captureAffectedTerritoryIds
        .filter(territoryId => (
            typeof territoryId === "string"
            && territoryId !== territory.id
            && visibleTerritoryIds.has(territoryId)
            && territories.has(territoryId)
        ));
}

function createCaptureTerritoryOperation(territory, knownTerritory, knownTrail, territoryId, viewerId) {
    const operation = territory.lastCaptureOperation;

    if (!canSendCaptureTerritoryOperation(operation, territory, knownTerritory, territoryId, viewerId)) {
        return null;
    }

    const serializedOperation = {
        type: operation.type,
        baseVersion: operation.baseVersion,
        version: operation.version,
        trailSide: operation.trailSide,
        trailSegmentIndex: operation.trailSegmentIndex,
        trailSegmentLength: operation.trailSegmentLength,
        boundaryPathIndex: operation.boundaryPathIndex,
        startContact: packCaptureContact(operation.startContact),
        endContact: packCaptureContact(operation.endContact),
        keepAnchor: packPoint(operation.keepAnchor)
    };

    if (shouldSendCaptureOperationFallbackTrailPoints()) {
        serializedOperation.trailPoints = packPoints(operation.trailPoints);
    } else {
        const neededTrailPoints = createNeededCaptureTrailPoints(operation, knownTrail);

        if (neededTrailPoints) {
            serializedOperation.trailTailStart = neededTrailPoints.start;
            serializedOperation.trailTailPoints = packPoints(neededTrailPoints.points);
        }
    }

    return serializedOperation;
}

function canSendCaptureTerritoryOperation(operation, territory, knownTerritory, territoryId, viewerId) {
    return config.network.captureOperationSyncEnabled !== false
        && operation
        && operation.type === "trailCapture"
        && knownTerritory
        && canUseKnownTerritoryForCaptureOperation(knownTerritory, operation, territoryId, viewerId)
        && territory.version === operation.version
        && Number.isInteger(operation.trailSegmentIndex)
        && Number.isInteger(operation.trailSegmentLength)
        && operation.trailSegmentLength >= 2
        && Number.isInteger(operation.boundaryPathIndex)
        && operation.startContact
        && operation.endContact
        && operation.keepAnchor
        && (
            !shouldSendCaptureOperationFallbackTrailPoints()
            || hasFallbackTrailPoints(operation)
        );
}

function canUseKnownTerritoryForCaptureOperation(knownTerritory, operation, territoryId, viewerId) {
    if (knownTerritory.version === operation.baseVersion) {
        return true;
    }

    return config.network.optimisticOwnerCaptureOperationSyncEnabled !== false
        && territoryId === viewerId;
}

function shouldSendCaptureOperationFallbackTrailPoints() {
    return config.network.captureOperationFallbackTrailPointsEnabled !== false;
}

function createNeededCaptureTrailPoints(operation, knownTrail) {
    if (config.network.captureOperationNeededTrailPointsEnabled === false) {
        return null;
    }

    if (!operation || !Array.isArray(operation.trailPoints) || operation.trailPoints.length < 2) {
        return null;
    }

    const knownLength = getKnownCaptureTrailSegmentLength(knownTrail, operation);
    const requiredClientLength = Math.min(
        operation.trailPoints.length,
        Math.max(2, operation.trailSegmentLength - 1)
    );
    const tailStart = clamp(knownLength, 0, requiredClientLength);

    if (tailStart >= requiredClientLength) {
        return null;
    }

    return {
        start: tailStart,
        points: operation.trailPoints.slice(tailStart, requiredClientLength)
    };
}

function getKnownCaptureTrailSegmentLength(knownTrail, operation) {
    if (!knownTrail || !operation) {
        return 0;
    }

    const lengths = operation.trailSide === "right"
        ? knownTrail.rightSegmentLengths
        : knownTrail.leftSegmentLengths;
    const length = Array.isArray(lengths) ? lengths[operation.trailSegmentIndex] : 0;

    return Number.isInteger(length) && length > 0 ? length : 0;
}

function hasFallbackTrailPoints(operation) {
    return operation
        && Array.isArray(operation.trailPoints)
        && operation.trailPoints.length >= 2;
}

function packCaptureContact(contact) {
    return [
        packCoordinate(contact.point.x),
        packCoordinate(contact.point.y),
        contact.segmentIndex,
        roundToPrecision(contact.segmentT, config.network.anglePrecision)
    ];
}

function serializeTrailUpdates(players, trailIds, viewerId, clientState, now, payloadBudget = null) {
    const serializedTrails = {};
    const includedTrailIds = [];

    for (const playerId of trailIds) {
        const player = players.get(playerId);

        if (!player || !hasAnyTrail(player)) {
            clientState.trails.delete(playerId);
            continue;
        }

        const stats = getTrailStats(player);
        const knownTrail = clientState.trails.get(playerId);
        const includeKnownTrail = Boolean(knownTrail);
        const shouldSendFull = shouldSendFullTrail(player, stats, knownTrail, now);
        const serialized = shouldSendFull
            ? serializeFullTrail(player)
            : serializeTrailPatch(player, knownTrail);
        const update = serialized.update;

        if (!shouldSendFull && getTrailUpdatePointCount(update) === 0) {
            clientState.trails.set(playerId, {
                ...serialized.state,
                lastFullSentAt: knownTrail.lastFullSentAt
            });
            includedTrailIds.push(playerId);
            continue;
        }

        if (!consumeSnapshotPayloadBudget(payloadBudget, "trails", estimateTrailPayloadBytes(update), {
            force: playerId === viewerId
        })) {
            if (includeKnownTrail) {
                includedTrailIds.push(playerId);
            }
            continue;
        }

        serializedTrails[playerId] = update;
        clientState.trails.set(playerId, {
            ...serialized.state,
            lastFullSentAt: shouldSendFull ? now : knownTrail.lastFullSentAt
        });
        includedTrailIds.push(playerId);
    }

    return {
        trailIds: includedTrailIds,
        trails: serializedTrails
    };
}

function shouldSendFullTrail(player, stats, knownTrail, now) {
    if (!knownTrail || !canPatchTrail(stats, knownTrail)) {
        return true;
    }

    if (stats.pointCount > getTrailUpdateMaxPoints()) {
        return false;
    }

    if (
        shouldSendForcedFullSync()
        && now - knownTrail.lastFullSentAt >= config.network.trailFullSyncIntervalMs
    ) {
        return true;
    }

    const patchPointCount = getTrailPatchPointCount(player, knownTrail);

    return shouldSendForcedFullSync()
        && stats.pointCount > 0
        && patchPointCount / stats.pointCount >= config.network.trailPatchFullRatio;
}

function serializeFullTrail(player) {
    const maxPoints = getTrailUpdateMaxPoints();
    const componentBudgets = allocateTrailComponentBudgets([
        countSegmentPoints(player.trailLeftSegments),
        countSegmentPoints(player.trailRightSegments),
        getPointArrayLength(player.trailLeftFillPath),
        getPointArrayLength(player.trailRightFillPath)
    ], maxPoints);
    const leftSegments = packLimitedSegments(player.trailLeftSegments, componentBudgets[0]);
    const rightSegments = packLimitedSegments(player.trailRightSegments, componentBudgets[1]);
    const leftFillPath = packLimitedPoints(player.trailLeftFillPath, 0, componentBudgets[2]);
    const rightFillPath = packLimitedPoints(player.trailRightFillPath, 0, componentBudgets[3]);
    const sentStats = {
        leftSegmentLengths: getPackedSegmentLengths(leftSegments),
        rightSegmentLengths: getPackedSegmentLengths(rightSegments),
        leftFillLength: leftFillPath.length,
        rightFillLength: rightFillPath.length
    };
    const sentPointCount = getTrailStatsPointCount(sentStats);
    const totalPointCount = getTrailStats(player).pointCount;
    const update = {
        full: true,
        generation: getTrailGeneration(player),
        color: player.color,
        leftSegments,
        rightSegments,
        leftFillPath,
        rightFillPath
    };

    markPartialTrailUpdate(update, sentPointCount, totalPointCount, maxPoints);

    return {
        state: {
            ...sentStats,
            generation: getTrailGeneration(player),
            pointCount: sentPointCount
        },
        update
    };
}

function serializeTrailPatch(player, knownTrail) {
    const maxPoints = getTrailUpdateMaxPoints();
    const componentBudgets = allocateTrailComponentBudgets([
        getSegmentPatchPointCount(player.trailLeftSegments, knownTrail.leftSegmentLengths),
        getSegmentPatchPointCount(player.trailRightSegments, knownTrail.rightSegmentLengths),
        Math.max(0, player.trailLeftFillPath.length - knownTrail.leftFillLength),
        Math.max(0, player.trailRightFillPath.length - knownTrail.rightFillLength)
    ], maxPoints);
    const update = {
        generation: getTrailGeneration(player),
        color: player.color
    };
    const leftPatchResult = getLimitedSegmentPatches(player.trailLeftSegments, knownTrail.leftSegmentLengths, componentBudgets[0]);
    const rightPatchResult = getLimitedSegmentPatches(player.trailRightSegments, knownTrail.rightSegmentLengths, componentBudgets[1]);
    const leftFillPoints = packLimitedPoints(player.trailLeftFillPath, knownTrail.leftFillLength, componentBudgets[2]);
    const rightFillPoints = packLimitedPoints(player.trailRightFillPath, knownTrail.rightFillLength, componentBudgets[3]);
    const sentStats = {
        leftSegmentLengths: leftPatchResult.lengths,
        rightSegmentLengths: rightPatchResult.lengths,
        leftFillLength: knownTrail.leftFillLength + leftFillPoints.length,
        rightFillLength: knownTrail.rightFillLength + rightFillPoints.length
    };
    const sentPointCount = getTrailStatsPointCount(sentStats);
    const totalPointCount = getTrailStats(player).pointCount;

    if (leftPatchResult.patches.length > 0) {
        update.leftPatches = leftPatchResult.patches;
    }

    if (rightPatchResult.patches.length > 0) {
        update.rightPatches = rightPatchResult.patches;
    }

    if (leftFillPoints.length > 0) {
        update.leftFillPoints = leftFillPoints;
        update.leftFillStart = knownTrail.leftFillLength;
    }

    if (rightFillPoints.length > 0) {
        update.rightFillPoints = rightFillPoints;
        update.rightFillStart = knownTrail.rightFillLength;
    }

    markPartialTrailUpdate(update, getTrailUpdatePointCount(update), totalPointCount - getTrailStatsPointCount(knownTrail), maxPoints);

    return {
        state: {
            ...sentStats,
            generation: getTrailGeneration(player),
            pointCount: sentPointCount
        },
        update
    };
}

function getLimitedSegmentPatches(segments, knownLengths, maxPoints) {
    const patches = [];
    const nextLengths = knownLengths.slice();
    let remainingPoints = maxPoints;

    for (let index = 0; index < segments.length; index++) {
        const knownLength = knownLengths[index] || 0;
        const availablePointCount = Math.max(0, segments[index].length - knownLength);
        const takePointCount = Math.min(availablePointCount, remainingPoints);

        if (takePointCount <= 0) {
            if (index < knownLengths.length) {
                nextLengths[index] = knownLength;
            }
            continue;
        }

        const points = packPoints(segments[index].slice(knownLength, knownLength + takePointCount));

        patches.push({
            index,
            start: knownLength,
            points
        });
        nextLengths[index] = knownLength + takePointCount;
        remainingPoints -= takePointCount;

        if (remainingPoints <= 0) {
            break;
        }
    }

    return {
        lengths: trimTrailingZeroLengths(nextLengths),
        patches
    };
}

function allocateTrailComponentBudgets(componentPointCounts, maxPoints) {
    const counts = componentPointCounts.map(count => Math.max(0, count || 0));
    const totalPointCount = sumValues(counts);

    if (!Number.isFinite(maxPoints) || totalPointCount <= maxPoints) {
        return counts;
    }

    const budget = Math.max(1, Math.floor(maxPoints));
    const budgets = counts.map(() => 0);
    const activeIndexes = counts
        .map((count, index) => ({ count, index }))
        .filter(item => item.count > 0);

    if (activeIndexes.length === 0) {
        return budgets;
    }

    let remainingBudget = budget;

    for (const item of activeIndexes) {
        budgets[item.index] = 1;
        remainingBudget--;

        if (remainingBudget <= 0) {
            return budgets;
        }
    }

    const remainingCounts = counts.map((count, index) => Math.max(0, count - budgets[index]));
    const remainingTotal = sumValues(remainingCounts);
    const shares = remainingCounts.map((count, index) => {
        const exact = remainingTotal > 0 ? count / remainingTotal * remainingBudget : 0;
        const whole = Math.floor(exact);

        budgets[index] += whole;

        return {
            fraction: exact - whole,
            index
        };
    });

    remainingBudget = budget - sumValues(budgets);
    shares.sort((first, second) => second.fraction - first.fraction);

    for (const share of shares) {
        if (remainingBudget <= 0) {
            break;
        }

        if (counts[share.index] <= budgets[share.index]) {
            continue;
        }

        budgets[share.index]++;
        remainingBudget--;
    }

    return budgets.map((value, index) => Math.min(value, counts[index]));
}

function packLimitedSegments(segments, maxPoints) {
    const packedSegments = [];
    let remainingPoints = maxPoints;

    for (const segment of segments || []) {
        if (remainingPoints <= 0) {
            break;
        }

        const packedSegment = packLimitedPoints(segment, 0, remainingPoints);

        if (packedSegment.length === 0) {
            continue;
        }

        packedSegments.push(packedSegment);
        remainingPoints -= packedSegment.length;
    }

    return packedSegments;
}

function packLimitedPoints(points, startIndex, maxPoints) {
    if (!Array.isArray(points) || maxPoints <= 0) {
        return [];
    }

    const endIndex = Math.min(points.length, startIndex + maxPoints);

    return packPoints(points.slice(startIndex, endIndex));
}

function getPackedSegmentLengths(segments) {
    return Array.isArray(segments) ? segments.map(segment => segment.length) : [];
}

function countSegmentPoints(segments) {
    return sumValues(getSegmentLengths(segments));
}

function getTrailStatsPointCount(stats) {
    return sumValues(stats.leftSegmentLengths || [])
        + sumValues(stats.rightSegmentLengths || [])
        + Math.max(0, stats.leftFillLength || 0)
        + Math.max(0, stats.rightFillLength || 0);
}

function markPartialTrailUpdate(update, sentPointCount, totalPointCount, pointBudget) {
    if (!Number.isFinite(totalPointCount) || sentPointCount >= totalPointCount) {
        return;
    }

    update.partial = true;
    update.remainingPointCount = totalPointCount - sentPointCount;
    update.pointBudget = Number.isFinite(pointBudget) ? pointBudget : null;
}

function getTrailUpdateMaxPoints() {
    const value = config.network.trailUpdateMaxPoints;

    return Number.isFinite(value) && value > 0 ? Math.floor(value) : Infinity;
}

function createSnapshotPayloadBudget() {
    const budgetBytes = getSnapshotPayloadBudgetBytes();

    if (!Number.isFinite(budgetBytes)) {
        return {
            enabled: false
        };
    }

    return {
        enabled: true,
        budgetBytes,
        usedBytes: 0,
        deferredBytes: 0,
        sent: {
            territories: 0,
            territoryOps: 0,
            trails: 0
        },
        deferred: {
            territories: 0,
            territoryOps: 0,
            trails: 0
        }
    };
}

function serializeSnapshotPayloadBudget(payloadBudget) {
    if (!payloadBudget || !payloadBudget.enabled) {
        return null;
    }

    return {
        budgetBytes: payloadBudget.budgetBytes,
        usedBytes: payloadBudget.usedBytes,
        remainingBytes: Math.max(0, payloadBudget.budgetBytes - payloadBudget.usedBytes),
        deferredBytes: payloadBudget.deferredBytes,
        sent: { ...payloadBudget.sent },
        deferred: { ...payloadBudget.deferred }
    };
}

function consumeSnapshotPayloadBudget(payloadBudget, section, estimatedBytes, options = {}) {
    if (!payloadBudget || !payloadBudget.enabled) {
        return true;
    }

    const bytes = Math.max(0, Math.ceil(Number(estimatedBytes) || 0));
    const force = options.force === true;
    const hasRoom = payloadBudget.usedBytes <= 0 || payloadBudget.usedBytes + bytes <= payloadBudget.budgetBytes;

    if (!force && !hasRoom) {
        incrementPayloadBudgetCount(payloadBudget.deferred, section);
        payloadBudget.deferredBytes += bytes;
        return false;
    }

    incrementPayloadBudgetCount(payloadBudget.sent, section);
    payloadBudget.usedBytes += bytes;
    return true;
}

function incrementPayloadBudgetCount(target, section) {
    if (!target || !Object.prototype.hasOwnProperty.call(target, section)) {
        return;
    }

    target[section]++;
}

function getSnapshotPayloadBudgetBytes() {
    const value = config.network.snapshotPayloadBudgetBytes;

    return Number.isFinite(value) && value > 0 ? Math.floor(value) : Infinity;
}

function estimateTerritoryPayloadBytes(territory) {
    const pointCount = countPolygonPoints(territory && territory.polygon);
    const ringCount = countPolygonRings(territory && territory.polygon);

    return 180 + pointCount * 32 + ringCount * 24;
}

function estimateTerritoryOperationPayloadBytes(operation) {
    const trailPointCount = getPackedPointCount(operation && operation.trailPoints)
        + getPackedPointCount(operation && operation.trailTailPoints);

    return 220 + trailPointCount * 22;
}

function estimateTrailPayloadBytes(update) {
    const pointCount = getTrailPayloadPointCount(update);
    const segmentCount = countArrayItems(update && update.leftSegments)
        + countArrayItems(update && update.rightSegments)
        + countArrayItems(update && update.leftPatches)
        + countArrayItems(update && update.rightPatches);

    return 220 + pointCount * 22 + segmentCount * 18;
}

function getTrailPayloadPointCount(update) {
    if (!update) {
        return 0;
    }

    if (update.full) {
        return countPackedSegmentsPoints(update.leftSegments)
            + countPackedSegmentsPoints(update.rightSegments)
            + getPackedPointCount(update.leftFillPath)
            + getPackedPointCount(update.rightFillPath);
    }

    return getTrailUpdatePointCount(update);
}

function countPackedSegmentsPoints(segments) {
    return (segments || []).reduce((sum, segment) => sum + getPackedPointCount(segment), 0);
}

function countArrayItems(value) {
    return Array.isArray(value) ? value.length : 0;
}

function countPolygonPoints(polygon) {
    return (polygon || []).reduce((sum, ring) => sum + countArrayItems(ring), 0);
}

function countPolygonRings(polygon) {
    return Array.isArray(polygon) ? polygon.length : 0;
}

function trimTrailingZeroLengths(lengths) {
    const nextLengths = lengths.slice();

    while (nextLengths.length > 0 && nextLengths[nextLengths.length - 1] <= 0) {
        nextLengths.pop();
    }

    return nextLengths;
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

function getTrailStats(player) {
    const leftSegmentLengths = getSegmentLengths(player.trailLeftSegments);
    const rightSegmentLengths = getSegmentLengths(player.trailRightSegments);
    const leftFillLength = getPointArrayLength(player.trailLeftFillPath);
    const rightFillLength = getPointArrayLength(player.trailRightFillPath);
    const pointCount = sumValues(leftSegmentLengths)
        + sumValues(rightSegmentLengths)
        + leftFillLength
        + rightFillLength;

    return {
        generation: getTrailGeneration(player),
        leftSegmentLengths,
        rightSegmentLengths,
        leftFillLength,
        rightFillLength,
        pointCount
    };
}

function canPatchTrail(stats, knownTrail) {
    return stats.generation === knownTrail.generation
        && canPatchLengths(stats.leftSegmentLengths, knownTrail.leftSegmentLengths)
        && canPatchLengths(stats.rightSegmentLengths, knownTrail.rightSegmentLengths)
        && stats.leftFillLength >= knownTrail.leftFillLength
        && stats.rightFillLength >= knownTrail.rightFillLength;
}

function getTrailGeneration(player) {
    return Number.isSafeInteger(player && player.trailGeneration)
        ? player.trailGeneration
        : 0;
}

function canPatchLengths(currentLengths, knownLengths) {
    if (currentLengths.length < knownLengths.length) {
        return false;
    }

    for (let index = 0; index < knownLengths.length; index++) {
        if (currentLengths[index] < knownLengths[index]) {
            return false;
        }
    }

    return true;
}

function getTrailPatchPointCount(player, knownTrail) {
    return getSegmentPatchPointCount(player.trailLeftSegments, knownTrail.leftSegmentLengths)
        + getSegmentPatchPointCount(player.trailRightSegments, knownTrail.rightSegmentLengths)
        + Math.max(0, player.trailLeftFillPath.length - knownTrail.leftFillLength)
        + Math.max(0, player.trailRightFillPath.length - knownTrail.rightFillLength);
}

function getSegmentPatchPointCount(segments, knownLengths) {
    let pointCount = 0;

    for (let index = 0; index < segments.length; index++) {
        pointCount += Math.max(0, segments[index].length - (knownLengths[index] || 0));
    }

    return pointCount;
}

function getTrailUpdatePointCount(update) {
    return getPatchPointCount(update.leftPatches)
        + getPatchPointCount(update.rightPatches)
        + getPackedPointCount(update.leftFillPoints)
        + getPackedPointCount(update.rightFillPoints);
}

function getPatchPointCount(patches) {
    return (patches || []).reduce((sum, patch) => sum + getPackedPointCount(patch.points), 0);
}

function getPackedPointCount(points) {
    return Array.isArray(points) ? points.length : 0;
}

function getSegmentLengths(segments) {
    return Array.isArray(segments) ? segments.map(getPointArrayLength) : [];
}

function getPointArrayLength(points) {
    return Array.isArray(points) ? points.length : 0;
}

function sumValues(values) {
    return values.reduce((sum, value) => sum + value, 0);
}

function hasAnyTrail(player) {
    return hasVisibleSegment(player.trailLeftSegments)
        || hasVisibleSegment(player.trailRightSegments);
}

function hasVisibleSegment(segments) {
    return Array.isArray(segments) && segments.some(segment => segment.length >= 2);
}

function getTrailBounds(player) {
    let bounds = null;

    bounds = mergeBounds(bounds, getSegmentsBounds(player.trailLeftSegments));
    bounds = mergeBounds(bounds, getSegmentsBounds(player.trailRightSegments));
    bounds = mergeBounds(bounds, getPointsBounds(player.trailLeftFillPath));
    bounds = mergeBounds(bounds, getPointsBounds(player.trailRightFillPath));

    return expandBounds(bounds, config.territory.baseBorderWidth);
}

function getSegmentsBounds(segments) {
    let bounds = null;

    for (const segment of segments || []) {
        bounds = mergeBounds(bounds, getPointsBounds(segment));
    }

    return bounds;
}

function getPointsBounds(points) {
    let bounds = null;

    for (const point of points || []) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            continue;
        }

        const pointBounds = {
            minX: point.x,
            minY: point.y,
            maxX: point.x,
            maxY: point.y
        };

        bounds = mergeBounds(bounds, pointBounds);
    }

    return bounds;
}

function packReferencedPolygon(polygon, clientState) {
    ensureTerritoryPointCache(clientState);

    if (!Array.isArray(polygon)) {
        return {
            rings: [],
            points: []
        };
    }

    const pointDefinitions = [];
    const rings = polygon
        .map(ring => packPointReferenceRing(ring, clientState, pointDefinitions))
        .filter(ring => ring.length >= 3);

    return {
        rings,
        points: pointDefinitions
    };
}

function packPointReferenceRing(ring, clientState, pointDefinitions) {
    return (ring || [])
        .map(point => getTerritoryPointReference(point, clientState, pointDefinitions))
        .filter(Number.isInteger);
}

function getTerritoryPointReference(point, clientState, pointDefinitions) {
    const packedPoint = packCoordinatePair(point);

    if (!packedPoint) {
        return null;
    }

    const key = getTerritoryPointKey(packedPoint);
    let pointId = clientState.territoryPoints.get(key);

    if (!pointId) {
        pointId = clientState.nextTerritoryPointId++;
        clientState.territoryPoints.set(key, pointId);
        pointDefinitions.push([
            pointId,
            packedPoint[0],
            packedPoint[1]
        ]);
    }

    return pointId;
}

function getTerritoryPointKey(point) {
    return `${point[0]},${point[1]}`;
}

function ensureTerritoryPointCache(clientState) {
    if (!(clientState.territoryPoints instanceof Map)) {
        clientState.territoryPoints = new Map();
    }

    if (!Number.isInteger(clientState.nextTerritoryPointId) || clientState.nextTerritoryPointId < 1) {
        clientState.nextTerritoryPointId = 1;
    }

}

function packPoints(points) {
    return (points || [])
        .map(packPoint)
        .filter(Boolean);
}

function packPoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return null;
    }

    return [
        packCoordinate(point.x),
        packCoordinate(point.y)
    ];
}

function packCoordinatePair(point) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        return null;
    }

    return [
        packCoordinate(point[0]),
        packCoordinate(point[1])
    ];
}

function packCoordinate(value) {
    return roundToPrecision(value, config.network.coordinatePrecision);
}

function packAngle(value) {
    return roundToPrecision(value, config.network.anglePrecision);
}

function roundToPrecision(value, precision) {
    const safePrecision = Number.isFinite(precision) && precision > 0 ? precision : 1;

    return Math.round(value * safePrecision) / safePrecision;
}

function shouldSendVersionedState(knownState, version, now, fullSyncIntervalMs) {
    return !knownState
        || knownState.version !== version
        || (
            shouldSendForcedFullSync()
            && now - knownState.sentAt >= fullSyncIntervalMs
        );
}

function shouldSendForcedFullSync() {
    return config.network.forcedFullSyncsEnabled !== false;
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

function removeUnselectedTerritoryStates(clientState, selectedIds) {
    const removedIds = [];

    for (const id of clientState.territories.keys()) {
        if (selectedIds.has(id)) {
            continue;
        }

        clientState.territories.delete(id);
        clientState.territoryVisibility.delete(id);
        removedIds.push(id);
    }

    return removedIds;
}

function removeUnselectedTrailStates(players, clientState, selectedIds) {
    const removals = {};

    for (const [id, knownTrail] of clientState.trails.entries()) {
        if (selectedIds.has(id)) {
            continue;
        }

        const player = players.get(id);
        const currentGeneration = player
            ? getTrailGeneration(player)
            : Number.isSafeInteger(knownTrail && knownTrail.generation)
                ? knownTrail.generation + 1
                : 0;

        removals[id] = currentGeneration;
        clientState.trails.delete(id);
        clientState.trailVisibility.delete(id);
    }

    return removals;
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

function expandBounds(bounds, margin) {
    if (!bounds) {
        return null;
    }

    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;

    return {
        minX: bounds.minX - safeMargin,
        minY: bounds.minY - safeMargin,
        maxX: bounds.maxX + safeMargin,
        maxY: bounds.maxY + safeMargin
    };
}

function mergeBounds(first, second) {
    if (!first) {
        return second;
    }

    if (!second) {
        return first;
    }

    return {
        minX: Math.min(first.minX, second.minX),
        minY: Math.min(first.minY, second.minY),
        maxX: Math.max(first.maxX, second.maxX),
        maxY: Math.max(first.maxY, second.maxY)
    };
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

module.exports = {
    cloneClientSnapshotState,
    createClientSnapshotState,
    createSnapshot
};

function cloneMap(map, cloneValue) {
    const clonedMap = new Map();

    for (const [key, value] of map || []) {
        clonedMap.set(key, cloneValue(value));
    }

    return clonedMap;
}

function cloneVersionedState(state) {
    return state ? { ...state } : state;
}

function cloneTrailState(state) {
    if (!state) {
        return state;
    }

    return {
        ...state,
        leftSegmentLengths: [...(state.leftSegmentLengths || [])],
        rightSegmentLengths: [...(state.rightSegmentLengths || [])]
    };
}
