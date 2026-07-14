import { finiteOrNull } from "./snapshotDiagnostics.js";
import {
    arePointsEqual,
    calculateRingArea,
    createBoundaryPaths,
    createClippedTrailPoints,
    createTrailFillPolygon,
    findClosestPolygonBoundaryContact,
    getDistanceSquared,
    getPointPathDistanceSquared,
    hasSelfIntersections,
    isPointInsideOrOnRing,
    normalizePolygonRing,
    projectPointOnSegment,
    removeConsecutiveDuplicatePoints,
    selectBoundaryPathByAnchor,
    unpackPoint,
    unpackPoints,
    unpackPolygon,
    unpackSegments
} from "./snapshotGeometry.js";

const geometryEpsilon = 1e-7;
const indexedBoundaryMaxDistanceSquared = 4;
const captureAreaRegressionTolerance = 1;
const captureAreaRegressionRatioTolerance = 0.001;

/**
 * Owns the schema-2 geometry caches and applies each geometry payload as one
 * transaction. Failed territory definitions, trail patches or capture replays
 * restore every cache and pending-operation collection to its prior state.
 */
export function createSnapshotGeometryApplication(networkConfig = {}, callbacks = {}) {
    const entityCache = createEmptyGeometryCache();
    const pendingTerritoryOperations = new Map();
    const suppressedCaptureOperationResyncIds = new Set();
    const failedTerritoryOperationKeys = new Map();

    return {
        applySnapshotGeometry,
        reset
    };

    function reset() {
        Object.assign(entityCache, createEmptyGeometryCache());
        pendingTerritoryOperations.clear();
        suppressedCaptureOperationResyncIds.clear();
        failedTerritoryOperationKeys.clear();
    }

    function applySnapshotGeometry(rawSnapshot, applyResult, previousGeometry = {}) {
        const checkpoint = createCheckpoint();
        const removedTerritoryIds = normalizeEntityIds(rawSnapshot.removedTerritoryIds);
        const trailRemovals = normalizeTrailRemovals(
            rawSnapshot.trailRemovals,
            rawSnapshot.removedTrailIds
        );

        updateTerritoryCache(rawSnapshot.territories, applyResult, rawSnapshot.sequence);
        updateTrailCache(rawSnapshot.trails, applyResult, rawSnapshot.sequence);

        const activeTrailIds = new Set(rawSnapshot.trailIds || []);
        const failedTerritoryOperationIds = updateTerritoryOperations(
            rawSnapshot.territoryOps,
            activeTrailIds,
            applyResult
        );
        const ignoredTerritoryResyncIds = createIgnoredTerritoryResyncIds(
            failedTerritoryOperationIds
        );

        if (applyResult.applied) {
            applyTerritoryRemovals(removedTerritoryIds);
            applyTrailRemovals(trailRemovals, rawSnapshot.sequence);
        }

        const selectedTerritories = selectCachedEntities(
            entityCache.territories,
            rawSnapshot.territoryIds
        );
        const selectedTrails = selectCachedEntities(
            entityCache.trails,
            rawSnapshot.trailIds
        );
        const availableTrails = selectAvailableTrailEntities(rawSnapshot.trailIds);
        const territories = mergeSnapshotEntities(
            previousGeometry.territories,
            selectedTerritories,
            removedTerritoryIds,
            hasExplicitRemovalProtocol(rawSnapshot)
        );
        const trails = rawSnapshot.preserveTrails
            ? previousGeometry.trails || {}
            : mergeSnapshotEntities(
                previousGeometry.trails,
                selectedTrails,
                Object.keys(trailRemovals),
                hasExplicitRemovalProtocol(rawSnapshot)
            );

        requestRecoveryForMissingCachedEntities(
            rawSnapshot.territoryIds,
            selectedTerritories,
            "territories",
            applyResult,
            ignoredTerritoryResyncIds
        );
        requestRecoveryForStaleCachedVersions(
            rawSnapshot.territoryVersions,
            selectedTerritories,
            applyResult,
            ignoredTerritoryResyncIds
        );

        if (!rawSnapshot.preserveTrails) {
            requestRecoveryForMissingCachedEntities(
                rawSnapshot.trailIds,
                availableTrails,
                "trails",
                applyResult
            );
        }

        if (!applyResult.applied) {
            restoreCheckpoint(checkpoint);
        }

        return {
            territories,
            trails,
            trailIds: Object.keys(trails)
        };
    }

    function createCheckpoint() {
        return {
            entityCache: {
                territories: { ...entityCache.territories },
                territoryPoints: { ...entityCache.territoryPoints },
                trails: { ...entityCache.trails },
                trailAssemblies: { ...entityCache.trailAssemblies },
                trailTombstones: { ...entityCache.trailTombstones }
            },
            failedTerritoryOperationKeys: new Map(failedTerritoryOperationKeys),
            pendingTerritoryOperations: new Map(pendingTerritoryOperations),
            suppressedCaptureOperationResyncIds: new Set(suppressedCaptureOperationResyncIds)
        };
    }

    function restoreCheckpoint(checkpoint) {
        entityCache.territories = checkpoint.entityCache.territories;
        entityCache.territoryPoints = checkpoint.entityCache.territoryPoints;
        entityCache.trails = checkpoint.entityCache.trails;
        entityCache.trailAssemblies = checkpoint.entityCache.trailAssemblies;
        entityCache.trailTombstones = checkpoint.entityCache.trailTombstones;
        replaceMapEntries(pendingTerritoryOperations, checkpoint.pendingTerritoryOperations);
        replaceMapEntries(failedTerritoryOperationKeys, checkpoint.failedTerritoryOperationKeys);
        replaceSetEntries(
            suppressedCaptureOperationResyncIds,
            checkpoint.suppressedCaptureOperationResyncIds
        );
    }

    function updateTerritoryCache(territories, applyResult, snapshotSequence) {
        for (const [id, territory] of Object.entries(territories || {})) {
            const cachedTerritory = entityCache.territories[id];

            if (
                cachedTerritory
                && Number.isFinite(territory.version)
                && Number.isFinite(cachedTerritory.version)
                && territory.version < cachedTerritory.version
            ) {
                continue;
            }

            const base = territory.base || [0, 0];
            const polygon = unpackTerritoryPolygon(territory.polygon);

            if (!polygon) {
                markCacheInvalid(applyResult, "territories", id);
                continue;
            }

            entityCache.territories[id] = {
                id,
                color: territory.color,
                version: territory.version,
                snapshotSequence,
                baseX: base[0],
                baseY: base[1],
                polygon
            };
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }
    }

    function updateTerritoryOperations(operations, activeTrailIds, applyResult) {
        const failedIds = new Set();

        for (const [id, operation] of Object.entries(operations || {})) {
            const duplicateFailure = getFailedTerritoryOperation(id, operation);

            if (duplicateFailure) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure);
                continue;
            }

            if (shouldDeferTerritoryOperation(id, operation, activeTrailIds)) {
                pendingTerritoryOperations.set(id, operation);
                continue;
            }

            const operationResult = applyCaptureTerritoryOperation(id, operation);

            if (!operationResult.applied) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                markFailedTerritoryOperation(id, operation, operationResult);
                handleCaptureOperationFailure(id, operationResult, operation);
                continue;
            }

            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }

        applyPendingTerritoryOperations(activeTrailIds, applyResult, failedIds);

        return failedIds;
    }

    function shouldDeferTerritoryOperation(id, operation, activeTrailIds) {
        return operation
            && operation.type === "trailCapture"
            && activeTrailIds.has(id)
            && !hasFallbackTrailPoints(operation);
    }

    function applyPendingTerritoryOperations(activeTrailIds, applyResult, failedIds) {
        for (const [id, operation] of pendingTerritoryOperations.entries()) {
            if (activeTrailIds.has(id)) {
                continue;
            }

            const duplicateFailure = getFailedTerritoryOperation(id, operation);

            if (duplicateFailure) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure);
                continue;
            }

            const operationResult = applyCaptureTerritoryOperation(id, operation);

            if (!operationResult.applied) {
                failedIds.add(id);
                pendingTerritoryOperations.delete(id);
                markCacheInvalid(applyResult, "territories", id);
                markFailedTerritoryOperation(id, operation, operationResult);
                handleCaptureOperationFailure(id, operationResult, operation);
                continue;
            }

            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }
    }

    function applyCaptureTerritoryOperation(id, operation) {
        if (!operation || operation.type !== "trailCapture") {
            return createCaptureOperationFailure("invalid_operation", {
                operationType: operation && operation.type
            });
        }

        const territory = entityCache.territories[id];

        if (!territory) {
            return createCaptureOperationFailure("missing_cached_territory", {
                expectedBaseVersion: operation.baseVersion,
                operationVersion: operation.version
            });
        }

        if (
            Number.isFinite(operation.version)
            && Number.isFinite(territory.version)
            && territory.version >= operation.version
        ) {
            return {
                applied: true,
                skipped: true
            };
        }

        if (territory.version !== operation.baseVersion) {
            return createCaptureOperationFailure("territory_version_mismatch", {
                localTerritoryVersion: territory.version,
                expectedBaseVersion: operation.baseVersion,
                operationVersion: operation.version
            });
        }

        const trailSegmentState = getCaptureTrailSegmentState(id, operation);
        const trailSegment = trailSegmentState.points;
        const startContact = unpackCaptureContact(operation.startContact);
        const endContact = unpackCaptureContact(operation.endContact);
        const keepAnchor = unpackPoint(operation.keepAnchor);

        if (!trailSegment) {
            return createCaptureOperationFailure(
                "missing_or_incomplete_trail_segment",
                trailSegmentState.debug
            );
        }

        if (!startContact || !endContact || !keepAnchor) {
            return createCaptureOperationFailure("invalid_capture_geometry_reference", {
                hasStartContact: Boolean(startContact),
                hasEndContact: Boolean(endContact),
                hasKeepAnchor: Boolean(keepAnchor)
            });
        }

        const ring = territory.polygon && territory.polygon.rings && territory.polygon.rings[0];

        if (!Array.isArray(ring) || ring.length < 3) {
            return createCaptureOperationFailure("invalid_cached_territory_ring", {
                localTerritoryVersion: territory.version,
                ringLength: Array.isArray(ring) ? ring.length : 0
            });
        }

        const localStartContact = getLocalBoundaryContact(ring, startContact);
        const localEndContact = getLocalBoundaryContact(ring, endContact);

        if (!localStartContact || !localEndContact) {
            return createCaptureOperationFailure("boundary_contact_not_found", {
                ringLength: ring.length,
                hasLocalStartContact: Boolean(localStartContact),
                hasLocalEndContact: Boolean(localEndContact)
            });
        }

        const boundaryPathState = getCaptureBoundaryPath(
            ring,
            localEndContact,
            localStartContact,
            operation,
            keepAnchor
        );
        const boundaryPath = boundaryPathState.path;

        if (!boundaryPath) {
            return createCaptureOperationFailure("boundary_path_not_found", {
                boundaryPathCount: boundaryPathState.pathCount,
                ringLength: ring.length
            });
        }

        const trailPoints = createClippedTrailPoints(
            trailSegment,
            operation.trailSegmentLength,
            localStartContact.point,
            localEndContact.point
        );
        const nextRing = normalizePolygonRing(trailPoints.concat(boundaryPath));

        if (nextRing.length < 4) {
            return createCaptureOperationFailure("resulting_ring_too_short", {
                trailPointCount: trailPoints.length,
                boundaryPathPointCount: boundaryPath.length,
                nextRingLength: nextRing.length
            });
        }

        const validationResult = validateCaptureOperationResult(territory, ring, nextRing);

        if (!validationResult.valid) {
            return createCaptureOperationFailure(validationResult.reason, {
                ...validationResult.details,
                trailPointCount: trailPoints.length,
                boundaryPathPointCount: boundaryPath.length,
                boundaryPathSource: boundaryPathState.source
            });
        }

        entityCache.territories[id] = {
            ...territory,
            version: operation.version,
            polygon: {
                rings: [nextRing]
            }
        };

        return {
            applied: true
        };
    }

    function validateCaptureOperationResult(territory, previousRing, nextRing) {
        const previousArea = Math.abs(calculateRingArea(previousRing));
        const nextArea = Math.abs(calculateRingArea(nextRing));

        if (!Number.isFinite(nextArea) || nextArea <= geometryEpsilon) {
            return {
                valid: false,
                reason: "capture_result_invalid_area",
                details: { nextArea }
            };
        }

        if (hasSelfIntersections(nextRing)) {
            return {
                valid: false,
                reason: "capture_result_self_intersection",
                details: {
                    nextArea,
                    previousArea,
                    pointCount: nextRing.length
                }
            };
        }

        if (Number.isFinite(previousArea) && previousArea > geometryEpsilon) {
            const tolerance = Math.max(
                captureAreaRegressionTolerance,
                previousArea * captureAreaRegressionRatioTolerance
            );

            if (nextArea + tolerance < previousArea) {
                return {
                    valid: false,
                    reason: "capture_result_area_regressed",
                    details: {
                        nextArea,
                        previousArea,
                        tolerance
                    }
                };
            }
        }

        const basePoint = getTerritoryBasePoint(territory);

        if (basePoint && !isPointInsideOrOnRing(basePoint, nextRing)) {
            return {
                valid: false,
                reason: "capture_result_lost_base",
                details: {
                    baseX: basePoint.x,
                    baseY: basePoint.y,
                    nextArea,
                    previousArea
                }
            };
        }

        return {
            valid: true
        };
    }

    function getTerritoryBasePoint(territory) {
        if (!territory
            || !Number.isFinite(territory.baseX)
            || !Number.isFinite(territory.baseY)) {
            return null;
        }

        return {
            x: territory.baseX,
            y: territory.baseY
        };
    }

    function getLocalBoundaryContact(ring, contact) {
        const indexedContact = createIndexedBoundaryContact(ring, contact);

        if (indexedContact) {
            return indexedContact;
        }

        return findClosestPolygonBoundaryContact(ring, contact.point);
    }

    function createIndexedBoundaryContact(ring, contact) {
        if (!contact
            || !Array.isArray(ring)
            || !Number.isInteger(contact.segmentIndex)
            || !Number.isFinite(contact.segmentT)) {
            return null;
        }

        const openRingLength = getOpenRingLength(ring);

        if (contact.segmentIndex < 0 || contact.segmentIndex >= openRingLength) {
            return null;
        }

        const segmentStart = getOpenRingPoint(ring, contact.segmentIndex);
        const segmentEnd = getOpenRingPoint(ring, (contact.segmentIndex + 1) % openRingLength);
        const projection = projectPointOnSegment(contact.point, segmentStart, segmentEnd);

        if (projection.distanceSquared > indexedBoundaryMaxDistanceSquared) {
            return null;
        }

        return {
            point: projection.point,
            segmentIndex: contact.segmentIndex,
            segmentT: projection.segmentT
        };
    }

    function getOpenRingLength(ring) {
        if (!Array.isArray(ring)) {
            return 0;
        }

        if (ring.length > 1 && arePointsEqual(ring[0], ring[ring.length - 1])) {
            return ring.length - 1;
        }

        return ring.length;
    }

    function getOpenRingPoint(ring, index) {
        return ring[index];
    }

    function getCaptureBoundaryPath(ring, startContact, endContact, operation, keepAnchor) {
        if (Number.isInteger(operation.boundaryPathIndex)) {
            const indexedPath = createBoundaryPathByIndex(
                ring,
                startContact,
                endContact,
                operation.boundaryPathIndex
            );

            if (indexedPath && isBoundaryPathConsistentWithAnchor(indexedPath, keepAnchor)) {
                return {
                    path: indexedPath,
                    pathCount: 1,
                    source: "index"
                };
            }
        }

        const boundaryPaths = createBoundaryPaths(ring, startContact, endContact);

        return {
            path: selectBoundaryPathByAnchor(boundaryPaths, keepAnchor),
            pathCount: boundaryPaths.length,
            source: "anchor"
        };
    }

    function createBoundaryPathByIndex(ring, startContact, endContact, pathIndex) {
        const openRingLength = getOpenRingLength(ring);

        if (!startContact || !endContact || openRingLength < 3) {
            return null;
        }

        if (pathIndex === 0) {
            return removeConsecutiveDuplicatePoints(
                createForwardBoundaryPathFromRing(
                    ring,
                    openRingLength,
                    startContact,
                    endContact
                )
            );
        }

        if (pathIndex === 1) {
            return removeConsecutiveDuplicatePoints(
                createForwardBoundaryPathFromRing(
                    ring,
                    openRingLength,
                    endContact,
                    startContact
                ).reverse()
            );
        }

        return null;
    }

    function createForwardBoundaryPathFromRing(
        ring,
        openRingLength,
        startContact,
        endContact
    ) {
        if (startContact.segmentIndex === endContact.segmentIndex
            && endContact.segmentT >= startContact.segmentT) {
            return [startContact.point, endContact.point];
        }

        const path = [startContact.point];
        let vertexIndex = (startContact.segmentIndex + 1) % openRingLength;
        let guard = 0;

        while (guard <= openRingLength) {
            path.push(getOpenRingPoint(ring, vertexIndex));

            if (vertexIndex === endContact.segmentIndex) {
                break;
            }

            vertexIndex = (vertexIndex + 1) % openRingLength;
            guard++;
        }

        path.push(endContact.point);

        return path;
    }

    function isBoundaryPathConsistentWithAnchor(path, anchor) {
        if (!Array.isArray(path) || path.length < 2 || !anchor) {
            return false;
        }

        if (path.length > 2) {
            return getDistanceSquared(path[1], anchor) <= indexedBoundaryMaxDistanceSquared;
        }

        return getPointPathDistanceSquared(anchor, path) <= indexedBoundaryMaxDistanceSquared;
    }

    function getCaptureTrailSegmentState(id, operation) {
        const trail = entityCache.trails[id];
        const fallbackPoints = unpackPoints(operation.trailPoints);
        const trailTailPoints = unpackPoints(operation.trailTailPoints);
        const trailTailStart = Number.isInteger(operation.trailTailStart)
            ? operation.trailTailStart
            : null;
        const segments = trail && operation.trailSide === "right"
            ? trail.rightSegments
            : trail && trail.leftSegments;
        const segment = segments && segments[operation.trailSegmentIndex];
        const mergedSegment = createMergedTrailSegment(
            segment,
            trailTailStart,
            trailTailPoints
        );
        const debug = {
            hasCachedTrail: Boolean(trail),
            trailSide: operation.trailSide,
            cachedSideSegmentCount: Array.isArray(segments) ? segments.length : 0,
            trailSegmentIndex: operation.trailSegmentIndex,
            cachedSegmentLength: Array.isArray(segment) ? segment.length : 0,
            requiredSegmentLength: operation.trailSegmentLength,
            fallbackTrailPointCount: fallbackPoints.length,
            trailTailStart,
            trailTailPointCount: trailTailPoints.length,
            mergedSegmentLength: Array.isArray(mergedSegment) ? mergedSegment.length : 0
        };

        if (canUseCachedTrailSegment(segment, operation)) {
            return {
                points: segment,
                debug: {
                    ...debug,
                    trailPointSource: "cache"
                }
            };
        }

        if (canUseCachedTrailSegment(mergedSegment, operation)) {
            return {
                points: mergedSegment,
                debug: {
                    ...debug,
                    trailPointSource: "cache_tail"
                }
            };
        }

        if (fallbackPoints.length >= 2) {
            return {
                points: fallbackPoints,
                debug: {
                    ...debug,
                    trailPointSource: "fallback"
                }
            };
        }

        return {
            points: null,
            debug: {
                ...debug,
                trailPointSource: "none"
            }
        };
    }

    function createMergedTrailSegment(segment, trailTailStart, trailTailPoints) {
        if (!Array.isArray(trailTailPoints)
            || trailTailPoints.length === 0
            || !Number.isInteger(trailTailStart)
            || trailTailStart < 0) {
            return null;
        }

        const cachedPrefix = Array.isArray(segment) ? segment.slice(0, trailTailStart) : [];

        if (cachedPrefix.length !== trailTailStart) {
            return null;
        }

        return cachedPrefix.concat(trailTailPoints);
    }

    function createCaptureOperationFailure(reason, details = {}) {
        return {
            applied: false,
            reason,
            details
        };
    }

    function markFailedTerritoryOperation(id, operation, operationResult) {
        const key = createTerritoryOperationKey(id, operation);

        if (!key) {
            return;
        }

        failedTerritoryOperationKeys.set(key, {
            reason: operationResult && operationResult.reason || null,
            details: operationResult && operationResult.details || null
        });
    }

    function getFailedTerritoryOperation(id, operation) {
        const key = createTerritoryOperationKey(id, operation);

        return key ? failedTerritoryOperationKeys.get(key) : null;
    }

    function clearFailedTerritoryOperationKeys(id) {
        const prefix = `${id}:`;

        for (const key of failedTerritoryOperationKeys.keys()) {
            if (key.startsWith(prefix)) {
                failedTerritoryOperationKeys.delete(key);
            }
        }
    }

    function createTerritoryOperationKey(id, operation) {
        if (!id || !operation) {
            return null;
        }

        return [
            id,
            operation.type || "unknown",
            Number.isFinite(operation.baseVersion) ? operation.baseVersion : "base?",
            Number.isFinite(operation.version) ? operation.version : "version?",
            operation.trailSide || "side?",
            Number.isInteger(operation.trailSegmentIndex)
                ? operation.trailSegmentIndex
                : "segment?",
            Number.isInteger(operation.trailSegmentLength)
                ? operation.trailSegmentLength
                : "length?",
            Number.isInteger(operation.boundaryPathIndex)
                ? operation.boundaryPathIndex
                : "path?"
        ].join(":");
    }

    function createCaptureOperationDiagnosticsDetails(id, operationResult, operation) {
        const details = operationResult && operationResult.details || {};

        return {
            territoryId: id,
            operationType: operation && operation.type || null,
            baseVersion: finiteOrNull(operation && operation.baseVersion),
            operationVersion: finiteOrNull(operation && operation.version),
            trailSide: operation && operation.trailSide || null,
            trailSegmentIndex: Number.isInteger(operation && operation.trailSegmentIndex)
                ? operation.trailSegmentIndex
                : null,
            trailSegmentLength: Number.isInteger(operation && operation.trailSegmentLength)
                ? operation.trailSegmentLength
                : null,
            boundaryPathIndex: Number.isInteger(operation && operation.boundaryPathIndex)
                ? operation.boundaryPathIndex
                : null,
            hasFallbackTrailPoints: hasFallbackTrailPoints(operation),
            fallbackTrailPointCount: countPackedPoints(operation && operation.trailPoints),
            trailTailStart: Number.isInteger(operation && operation.trailTailStart)
                ? operation.trailTailStart
                : null,
            trailTailPointCount: countPackedPoints(operation && operation.trailTailPoints),
            resultDetails: details
        };
    }

    function countPackedPoints(points) {
        return Array.isArray(points) ? points.length : 0;
    }

    function hasFallbackTrailPoints(operation) {
        return unpackPoints(operation && operation.trailPoints).length >= 2;
    }

    function canUseCachedTrailSegment(segment, operation) {
        return Array.isArray(segment)
            && segment.length >= Math.max(2, operation.trailSegmentLength - 1);
    }

    function unpackCaptureContact(contact) {
        if (!Array.isArray(contact) || contact.length < 2) {
            return null;
        }

        const point = unpackPoint(contact);

        if (!point) {
            return null;
        }

        return {
            point,
            segmentIndex: Number.isInteger(contact[2]) ? contact[2] : null,
            segmentT: Number.isFinite(contact[3]) ? contact[3] : null
        };
    }

    function unpackTerritoryPolygon(polygon) {
        if (!isReferencedPolygon(polygon)) {
            return unpackPolygon(polygon);
        }

        updateTerritoryPointCache(polygon.points);

        let hasMissingPoint = false;
        const rings = (polygon.rings || [])
            .map(ring => (ring || []).map(pointId => {
                const point = entityCache.territoryPoints[pointId];

                if (!point) {
                    hasMissingPoint = true;
                    return null;
                }

                return point;
            }).filter(Boolean))
            .filter(ring => ring.length >= 3);

        return hasMissingPoint ? null : { rings };
    }

    function isReferencedPolygon(polygon) {
        return polygon
            && !Array.isArray(polygon)
            && Array.isArray(polygon.rings);
    }

    function updateTerritoryPointCache(points) {
        for (const point of points || []) {
            if (!Array.isArray(point) || point.length < 3) {
                continue;
            }

            const pointId = point[0];
            const x = point[1];
            const y = point[2];

            if (!Number.isInteger(pointId) || !Number.isFinite(x) || !Number.isFinite(y)) {
                continue;
            }

            entityCache.territoryPoints[pointId] = { x, y };
        }
    }

    function updateTrailCache(trails, applyResult, snapshotSequence) {
        for (const [id, update] of Object.entries(trails || {})) {
            const cachedTrail = entityCache.trails[id];
            const assembly = entityCache.trailAssemblies[id];
            const newestTrail = getNewestTrailState(cachedTrail, assembly);
            const tombstone = entityCache.trailTombstones[id];

            if (
                isTrailUpdateStale(update, snapshotSequence, newestTrail)
                || isTrailUpdateBlockedByTombstone(update, snapshotSequence, tombstone)
            ) {
                continue;
            }

            delete entityCache.trailTombstones[id];

            if (update.full) {
                const fullTrail = createFullTrail(id, update, snapshotSequence);
                const shouldStage = Boolean(update.partial);

                if (shouldStage) {
                    if (cachedTrail && !cachedTrail.isPartial) {
                        entityCache.trailAssemblies[id] = fullTrail;
                    } else {
                        entityCache.trails[id] = fullTrail;
                        delete entityCache.trailAssemblies[id];
                    }
                    continue;
                }

                entityCache.trails[id] = fullTrail;
                delete entityCache.trailAssemblies[id];
                continue;
            }

            const trail = assembly || cachedTrail;
            const patchedTrail = trail && createPatchedTrail(trail, update, snapshotSequence);

            if (!patchedTrail) {
                delete entityCache.trailAssemblies[id];
                markCacheInvalid(applyResult, "trails", id);
                continue;
            }

            if (assembly && update.partial) {
                entityCache.trailAssemblies[id] = patchedTrail;
                continue;
            }

            entityCache.trails[id] = patchedTrail;
            delete entityCache.trailAssemblies[id];
        }
    }

    function isTrailUpdateBlockedByTombstone(update, snapshotSequence, tombstone) {
        if (!tombstone) {
            return false;
        }

        const updateGeneration = Number.isSafeInteger(update && update.generation)
            ? update.generation
            : null;
        const tombstoneGeneration = Number.isSafeInteger(tombstone.generation)
            ? tombstone.generation
            : null;

        if (
            updateGeneration !== null
            && tombstoneGeneration !== null
            && updateGeneration !== tombstoneGeneration
        ) {
            return updateGeneration < tombstoneGeneration;
        }

        return Number.isSafeInteger(snapshotSequence)
            && Number.isSafeInteger(tombstone.snapshotSequence)
            && snapshotSequence <= tombstone.snapshotSequence;
    }

    function getNewestTrailState(cachedTrail, assembly) {
        if (!cachedTrail) {
            return assembly || null;
        }

        if (!assembly) {
            return cachedTrail;
        }

        if ((assembly.generation || 0) !== (cachedTrail.generation || 0)) {
            return (assembly.generation || 0) > (cachedTrail.generation || 0)
                ? assembly
                : cachedTrail;
        }

        return (assembly.snapshotSequence || 0) > (cachedTrail.snapshotSequence || 0)
            ? assembly
            : cachedTrail;
    }

    function isTrailUpdateStale(update, snapshotSequence, trail) {
        if (!trail) {
            return false;
        }

        const updateGeneration = Number.isSafeInteger(update.generation)
            ? update.generation
            : null;
        const trailGeneration = Number.isSafeInteger(trail.generation)
            ? trail.generation
            : null;

        if (
            updateGeneration !== null
            && trailGeneration !== null
            && updateGeneration !== trailGeneration
        ) {
            return updateGeneration < trailGeneration;
        }

        return Number.isSafeInteger(snapshotSequence)
            && Number.isSafeInteger(trail.snapshotSequence)
            && snapshotSequence <= trail.snapshotSequence;
    }

    function selectCachedEntities(cache, ids) {
        const selected = {};

        for (const id of ids || []) {
            if (cache[id]) {
                selected[id] = cache[id];
            }
        }

        return selected;
    }

    function selectAvailableTrailEntities(ids) {
        const selected = {};

        for (const id of ids || []) {
            const trail = getNewestTrailState(
                entityCache.trails[id],
                entityCache.trailAssemblies[id]
            );

            if (trail) {
                selected[id] = trail;
            }
        }

        return selected;
    }

    function mergeSnapshotEntities(
        previousEntities,
        selectedEntities,
        removedIds,
        useExplicitRemovals
    ) {
        if (!useExplicitRemovals) {
            return selectedEntities;
        }

        const merged = {
            ...(previousEntities || {}),
            ...(selectedEntities || {})
        };

        for (const id of removedIds || []) {
            delete merged[id];
        }

        return merged;
    }

    function hasExplicitRemovalProtocol(snapshot) {
        return Array.isArray(snapshot && snapshot.removedTerritoryIds)
            || Array.isArray(snapshot && snapshot.removedTrailIds)
            || Boolean(
                snapshot
                && snapshot.trailRemovals
                && typeof snapshot.trailRemovals === "object"
            );
    }

    function normalizeEntityIds(ids) {
        return Array.isArray(ids)
            ? [...new Set(ids.filter(id => typeof id === "string" && id))]
            : [];
    }

    function normalizeTrailRemovals(removals, removedIds) {
        const normalized = {};

        for (const [id, generation] of Object.entries(removals || {})) {
            if (typeof id !== "string" || !id) {
                continue;
            }

            normalized[id] = Number.isSafeInteger(generation) ? generation : null;
        }

        for (const id of normalizeEntityIds(removedIds)) {
            if (!Object.prototype.hasOwnProperty.call(normalized, id)) {
                normalized[id] = null;
            }
        }

        return normalized;
    }

    function applyTerritoryRemovals(removedIds) {
        for (const id of removedIds || []) {
            delete entityCache.territories[id];
            pendingTerritoryOperations.delete(id);
            suppressedCaptureOperationResyncIds.delete(id);
            clearFailedTerritoryOperationKeys(id);
        }
    }

    function applyTrailRemovals(removals, snapshotSequence) {
        for (const [id, generation] of Object.entries(removals || {})) {
            delete entityCache.trails[id];
            delete entityCache.trailAssemblies[id];
            entityCache.trailTombstones[id] = {
                generation,
                snapshotSequence
            };
        }
    }

    function requestRecoveryForMissingCachedEntities(
        ids,
        selectedEntities,
        type,
        applyResult,
        ignoredIds = new Set()
    ) {
        for (const id of ids || []) {
            if (ignoredIds.has(id)) {
                continue;
            }

            if (!selectedEntities[id]) {
                markCacheInvalid(applyResult, type, id);
            }
        }
    }

    function requestRecoveryForStaleCachedVersions(
        versions,
        selectedEntities,
        applyResult,
        ignoredIds = new Set()
    ) {
        for (const [id, version] of Object.entries(versions || {})) {
            if (ignoredIds.has(id)) {
                continue;
            }

            const entity = selectedEntities[id];

            if (!entity || entity.version !== version) {
                markCacheInvalid(applyResult, "territories", id);
            }
        }
    }

    function createFullTrail(id, update, snapshotSequence) {
        const trail = {
            id,
            color: update.color,
            generation: update.generation,
            snapshotSequence,
            isPartial: Boolean(update.partial),
            leftSegments: unpackSegments(update.leftSegments),
            rightSegments: unpackSegments(update.rightSegments),
            leftFillPath: unpackPoints(update.leftFillPath),
            rightFillPath: unpackPoints(update.rightFillPath),
            fillPolygon: null
        };

        trail.fillPolygon = createTrailFillPolygon(
            trail.leftFillPath,
            trail.rightFillPath
        );

        return trail;
    }

    function createPatchedTrail(trail, update, snapshotSequence) {
        const leftSegments = applySegmentPatches(trail.leftSegments, update.leftPatches);
        const rightSegments = applySegmentPatches(trail.rightSegments, update.rightPatches);
        const leftFillPath = appendPathPoints(
            trail.leftFillPath,
            update.leftFillPoints,
            update.leftFillStart
        );
        const rightFillPath = appendPathPoints(
            trail.rightFillPath,
            update.rightFillPoints,
            update.rightFillStart
        );

        if (!leftSegments || !rightSegments || !leftFillPath || !rightFillPath) {
            return null;
        }

        const fillChanged = leftFillPath !== trail.leftFillPath
            || rightFillPath !== trail.rightFillPath;
        const color = update.color || trail.color;

        if (
            leftSegments === trail.leftSegments
            && rightSegments === trail.rightSegments
            && !fillChanged
            && color === trail.color
        ) {
            return {
                ...trail,
                generation: Number.isSafeInteger(update.generation)
                    ? update.generation
                    : trail.generation,
                snapshotSequence,
                isPartial: Boolean(update.partial)
            };
        }

        return {
            id: trail.id,
            color,
            generation: Number.isSafeInteger(update.generation)
                ? update.generation
                : trail.generation,
            snapshotSequence,
            isPartial: Boolean(update.partial),
            leftSegments,
            rightSegments,
            leftFillPath,
            rightFillPath,
            fillPolygon: fillChanged
                ? createTrailFillPolygon(leftFillPath, rightFillPath)
                : trail.fillPolygon
        };
    }

    function applySegmentPatches(segments, patches) {
        if (!Array.isArray(patches) || patches.length === 0) {
            return segments || [];
        }

        const sourceSegments = segments || [];
        const nextSegments = sourceSegments.slice();

        for (const patch of patches || []) {
            if (!Number.isInteger(patch.index)
                || patch.index < 0
                || patch.index > nextSegments.length) {
                return null;
            }

            if (patch.index === nextSegments.length) {
                nextSegments.push(unpackPoints(patch.points));
                continue;
            }

            const sourceSegment = sourceSegments[patch.index] || [];

            if (sourceSegment.length !== patch.start) {
                return null;
            }

            nextSegments[patch.index] = sourceSegment.concat(unpackPoints(patch.points));
        }

        return nextSegments;
    }

    function appendPathPoints(points, packedPoints, startIndex) {
        if (!Array.isArray(packedPoints) || packedPoints.length === 0) {
            return points || [];
        }

        const sourcePoints = points || [];

        if (sourcePoints.length !== startIndex) {
            return null;
        }

        return sourcePoints.concat(unpackPoints(packedPoints));
    }

    function createIgnoredTerritoryResyncIds(failedTerritoryOperationIds) {
        return new Set([
            ...suppressedCaptureOperationResyncIds,
            ...pendingTerritoryOperations.keys(),
            ...failedTerritoryOperationIds
        ]);
    }

    function handleDuplicateCaptureOperationFailure(id, operation, duplicateFailure) {
        if (typeof callbacks.recordResyncSuppressed !== "function") {
            return;
        }

        callbacks.recordResyncSuppressed("duplicate_capture_operation_failure", {
            reason: duplicateFailure && duplicateFailure.reason || null,
            details: createCaptureOperationDiagnosticsDetails(
                id,
                duplicateFailure,
                operation
            ),
            invalidations: {
                territories: 1,
                playerInfo: 0,
                trails: 0
            }
        }, performance.now(), networkConfig.resyncRequestIntervalMs || 1000);
    }

    function handleCaptureOperationFailure(id, operationResult, operation) {
        const details = createCaptureOperationDiagnosticsDetails(
            id,
            operationResult,
            operation
        );
        const invalidations = {
            territories: 1,
            playerInfo: 0,
            trails: 0
        };

        if (networkConfig.captureOperationResyncEnabled === false) {
            suppressedCaptureOperationResyncIds.add(id);

            if (typeof callbacks.recordResyncSuppressed === "function") {
                callbacks.recordResyncSuppressed("capture_operation_resync_disabled", {
                    reason: operationResult && operationResult.reason || null,
                    details,
                    invalidations
                }, performance.now(), networkConfig.resyncRequestIntervalMs || 1000);
            }
            return;
        }

        if (typeof callbacks.requestResync === "function") {
            callbacks.requestResync({
                reason: operationResult && operationResult.reason || null,
                details,
                invalidations
            });
        }
    }

    function markCacheInvalid(applyResult, type, id) {
        if (!applyResult || !applyResult.invalidations || !id) {
            return;
        }

        const ids = applyResult.invalidations[type];

        if (!ids || ids.includes(id)) {
            applyResult.applied = false;
            return;
        }

        ids.push(id);
        applyResult.applied = false;
    }
}

export function createSnapshotApplyResult() {
    return {
        applied: true,
        invalidations: {
            playerInfo: [],
            territories: [],
            trails: []
        }
    };
}

function createEmptyGeometryCache() {
    return {
        territories: {},
        territoryPoints: {},
        trails: {},
        trailAssemblies: {},
        trailTombstones: {}
    };
}

function replaceMapEntries(target, source) {
    target.clear();

    for (const [key, value] of source || []) {
        target.set(key, value);
    }
}

function replaceSetEntries(target, source) {
    target.clear();

    for (const value of source || []) {
        target.add(value);
    }
}
