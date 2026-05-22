const config = require("../config/gameConfig");
const { getServerTime } = require("../utils/time");
const { getPolygonBounds } = require("../utils/geometry");

function createClientSnapshotState() {
    return {
        playerInfo: new Map(),
        territories: new Map(),
        trails: new Map(),
        // Per-socket point dictionary used by territory polygons.
        territoryPoints: new Map(),
        nextTerritoryPointId: 1
    };
}

function cloneClientSnapshotState(clientState = createClientSnapshotState()) {
    return {
        playerInfo: cloneMap(clientState.playerInfo, cloneVersionedState),
        territories: cloneMap(clientState.territories, cloneVersionedState),
        trails: cloneMap(clientState.trails, cloneTrailState),
        territoryPoints: new Map(clientState.territoryPoints || []),
        nextTerritoryPointId: Number.isInteger(clientState.nextTerritoryPointId)
            ? clientState.nextTerritoryPointId
            : 1
    };
}

function createSnapshot(players, territories, viewerId = null, clientState = createClientSnapshotState()) {
    const viewer = viewerId ? players.get(viewerId) : null;
    const now = getServerTime();
    const interestBounds = createInterestBounds(viewer);
    const playerIds = getVisiblePlayerIds(players, viewerId, interestBounds);
    const territoryIds = getVisibleTerritoryIds(territories, viewerId, interestBounds);
    const trailIds = getVisibleTrailIds(players, viewerId, interestBounds);

    pruneClientState(clientState, players, territories);

    const territoryChanges = serializeChangedTerritoryState(territories, territoryIds, viewerId, clientState, now);
    const trailUpdates = serializeTrailUpdates(players, trailIds, clientState, now);

    pruneInactiveTrailStates(clientState, players);

    const snapshot = {
        schema: 2,
        time: now,
        players: serializePlayerPositions(players, playerIds),
        playerInfo: serializeChangedPlayerInfo(players, playerIds, clientState, now),
        territoryIds,
        territoryVersions: serializeTerritoryVersions(territories, territoryIds),
        territories: territoryChanges.territories,
        territoryOps: territoryChanges.operations,
        trailIds,
        trails: trailUpdates
    };

    if (config.network.snapshotDiagnosticsEnabled) {
        snapshot.syncDebug = {
            territories: territoryChanges.debug
        };
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
            version
        ];
        clientState.playerInfo.set(player.id, {
            version,
            sentAt: now
        });
    }

    return serializedInfo;
}

function serializeTerritoryVersions(territories, territoryIds) {
    const serializedVersions = {};

    for (const territoryId of territoryIds) {
        const territory = territories.get(territoryId);

        if (territory) {
            serializedVersions[territoryId] = territory.version || 0;
        }
    }

    return serializedVersions;
}

function serializeChangedTerritoryState(territories, territoryIds, viewerId, clientState, now) {
    const serializedTerritories = {};
    const serializedOperations = {};
    const syncDebug = config.network.snapshotDiagnosticsEnabled ? {} : null;

    for (const territoryId of territoryIds) {
        const territory = territories.get(territoryId);

        if (!territory) {
            continue;
        }

        const version = territory.version || 0;
        const knownTerritory = clientState.territories.get(territoryId);

        if (!shouldSendVersionedState(knownTerritory, version, now, config.network.territoryFullSyncIntervalMs)) {
            continue;
        }

        const knownTrail = clientState.trails.get(territoryId);
        const operation = createCaptureTerritoryOperation(territory, knownTerritory, knownTrail, territoryId, viewerId);

        if (operation) {
            serializedOperations[territoryId] = operation;
            recordTerritorySyncDebug(
                syncDebug,
                territoryId,
                "operation",
                "capture_operation",
                territory,
                knownTerritory,
                territory.lastCaptureOperation
            );
            clientState.territories.set(territoryId, {
                version,
                sentAt: now
            });
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
        recordTerritorySyncDebug(
            syncDebug,
            territoryId,
            "full",
            getCaptureOperationBlockReason(territory.lastCaptureOperation, territory, knownTerritory, territoryId, viewerId),
            territory,
            knownTerritory,
            territory.lastCaptureOperation
        );
        clientState.territories.set(territoryId, {
            version,
            sentAt: now
        });
    }

    return {
        territories: serializedTerritories,
        operations: serializedOperations,
        debug: syncDebug || undefined
    };
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

function getCaptureOperationBlockReason(operation, territory, knownTerritory, territoryId, viewerId) {
    if (!knownTerritory) {
        return "missing_known_territory";
    }

    if (config.network.captureOperationSyncEnabled === false) {
        return "capture_operation_sync_disabled";
    }

    if (!operation) {
        return "no_capture_operation";
    }

    if (operation.type !== "trailCapture") {
        return "invalid_operation_type";
    }

    if (!canUseKnownTerritoryForCaptureOperation(knownTerritory, operation, territoryId, viewerId)) {
        return "known_territory_version_not_at_operation_base";
    }

    if (territory.version !== operation.version) {
        return "operation_not_current_territory_version";
    }

    if (!Number.isInteger(operation.trailSegmentIndex)) {
        return "invalid_trail_segment_index";
    }

    if (!Number.isInteger(operation.trailSegmentLength) || operation.trailSegmentLength < 2) {
        return "invalid_trail_segment_length";
    }

    if (!operation.startContact) {
        return "missing_start_contact";
    }

    if (!operation.endContact) {
        return "missing_end_contact";
    }

    if (!operation.keepAnchor) {
        return "missing_keep_anchor";
    }

    if (shouldSendCaptureOperationFallbackTrailPoints() && !hasFallbackTrailPoints(operation)) {
        return "missing_fallback_trail_points";
    }

    return "unknown";
}

function recordTerritorySyncDebug(syncDebug, territoryId, mode, reason, territory, knownTerritory, operation) {
    if (!syncDebug) {
        return;
    }

    syncDebug[territoryId] = {
        mode,
        reason,
        knownVersion: knownTerritory && knownTerritory.version,
        serverVersion: territory && territory.version,
        operationBaseVersion: operation && operation.baseVersion,
        operationVersion: operation && operation.version
    };
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

function serializeTrailUpdates(players, trailIds, clientState, now) {
    const serializedTrails = {};

    for (const playerId of trailIds) {
        const player = players.get(playerId);

        if (!player || !hasAnyTrail(player)) {
            clientState.trails.delete(playerId);
            continue;
        }

        const stats = getTrailStats(player);
        const knownTrail = clientState.trails.get(playerId);
        const shouldSendFull = shouldSendFullTrail(player, stats, knownTrail, now);
        const update = shouldSendFull
            ? serializeFullTrail(player)
            : serializeTrailPatch(player, knownTrail);

        if (!shouldSendFull && getTrailUpdatePointCount(update) === 0) {
            clientState.trails.set(playerId, {
                ...stats,
                lastFullSentAt: knownTrail.lastFullSentAt
            });
            continue;
        }

        serializedTrails[playerId] = update;
        clientState.trails.set(playerId, {
            ...stats,
            lastFullSentAt: shouldSendFull ? now : knownTrail.lastFullSentAt
        });
    }

    return serializedTrails;
}

function shouldSendFullTrail(player, stats, knownTrail, now) {
    if (!knownTrail || !canPatchTrail(stats, knownTrail)) {
        return true;
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
    return {
        full: true,
        color: player.color,
        leftSegments: packSegments(player.trailLeftSegments),
        rightSegments: packSegments(player.trailRightSegments),
        leftFillPath: packPoints(player.trailLeftFillPath),
        rightFillPath: packPoints(player.trailRightFillPath)
    };
}

function serializeTrailPatch(player, knownTrail) {
    const update = {
        color: player.color
    };
    const leftPatches = getSegmentPatches(player.trailLeftSegments, knownTrail.leftSegmentLengths);
    const rightPatches = getSegmentPatches(player.trailRightSegments, knownTrail.rightSegmentLengths);
    const leftFillPoints = packPoints(player.trailLeftFillPath.slice(knownTrail.leftFillLength));
    const rightFillPoints = packPoints(player.trailRightFillPath.slice(knownTrail.rightFillLength));

    if (leftPatches.length > 0) {
        update.leftPatches = leftPatches;
    }

    if (rightPatches.length > 0) {
        update.rightPatches = rightPatches;
    }

    if (leftFillPoints.length > 0) {
        update.leftFillPoints = leftFillPoints;
        update.leftFillStart = knownTrail.leftFillLength;
    }

    if (rightFillPoints.length > 0) {
        update.rightFillPoints = rightFillPoints;
        update.rightFillStart = knownTrail.rightFillLength;
    }

    return update;
}

function getSegmentPatches(segments, knownLengths) {
    const patches = [];

    for (let index = 0; index < segments.length; index++) {
        const knownLength = knownLengths[index] || 0;
        const points = packPoints(segments[index].slice(knownLength));

        if (points.length === 0) {
            continue;
        }

        patches.push({
            index,
            start: knownLength,
            points
        });
    }

    return patches;
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

function getVisibleTerritoryIds(territories, viewerId, interestBounds) {
    const territoryIds = [];

    for (const [territoryId, territory] of territories.entries()) {
        const bounds = getPolygonBounds(territory.polygon);

        if (territoryId === viewerId || boundsOverlap(bounds, interestBounds)) {
            territoryIds.push(territoryId);
        }
    }

    return territoryIds;
}

function getVisibleTrailIds(players, viewerId, interestBounds) {
    const trailIds = [];

    for (const player of players.values()) {
        if (!hasAnyTrail(player)) {
            continue;
        }

        if (player.id === viewerId || boundsOverlap(getTrailBounds(player), interestBounds)) {
            trailIds.push(player.id);
        }
    }

    return trailIds;
}

function createInterestBounds(viewer) {
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
    const margin = Math.max(0, config.network.interestMargin);

    return {
        minX: viewer.x - worldWidth / 2 - margin,
        minY: viewer.y - worldHeight / 2 - margin,
        maxX: viewer.x + worldWidth / 2 + margin,
        maxY: viewer.y + worldHeight / 2 + margin
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
        leftSegmentLengths,
        rightSegmentLengths,
        leftFillLength,
        rightFillLength,
        pointCount
    };
}

function canPatchTrail(stats, knownTrail) {
    return canPatchLengths(stats.leftSegmentLengths, knownTrail.leftSegmentLengths)
        && canPatchLengths(stats.rightSegmentLengths, knownTrail.rightSegmentLengths)
        && stats.leftFillLength >= knownTrail.leftFillLength
        && stats.rightFillLength >= knownTrail.rightFillLength;
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

function packSegments(segments) {
    return (segments || [])
        .map(packPoints)
        .filter(segment => segment.length >= 2);
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

function pruneClientState(clientState, players, territories) {
    pruneMapKeys(clientState.playerInfo, id => players.has(id));
    pruneMapKeys(clientState.territories, id => territories.has(id));
    pruneMapKeys(clientState.trails, id => players.has(id));
}

function pruneInactiveTrailStates(clientState, players) {
    pruneMapKeys(clientState.trails, id => {
        const player = players.get(id);

        return player && hasAnyTrail(player);
    });
}

function pruneMapKeys(map, shouldKeep) {
    for (const key of map.keys()) {
        if (!shouldKeep(key)) {
            map.delete(key);
        }
    }
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
