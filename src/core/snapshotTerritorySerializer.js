const config = require("../config/gameConfig");
const {
    consumeSnapshotPayloadBudget,
    estimateTerritoryOperationPayloadBytes,
    estimateTerritoryPayloadBytes
} = require("./snapshotPayloadBudget");
const {
    packCoordinate,
    packPoint,
    packPoints,
    packReferencedPolygon,
    roundToPrecision,
    shouldSendVersionedState
} = require("./snapshotSerializationPrimitives");

/**
 * Incremental territory definitions and capture-operation payloads.
 *
 * This module advances only the territory-related portion of clientState and
 * consumes the caller-owned snapshot payload budget.
 */

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


function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

module.exports = {
    removeUnselectedTerritoryStates,
    serializeChangedTerritoryState
};
