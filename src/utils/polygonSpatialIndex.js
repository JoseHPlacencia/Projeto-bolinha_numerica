const geometryEpsilon = 1e-7;
const minimumBucketCount = 8;
const maximumBucketCount = 64;
const boundaryLeafSize = 12;
const ringSpatialIndexCache = new WeakMap();
const emptySpatialIndex = createEmptySpatialIndex();

/**
 * Derived acceleration structure for an immutable polygon ring.
 *
 * Point queries use a one-dimensional scanline index, while arbitrary segment
 * and nearest-boundary queries use an AABB hierarchy over the same edges. The
 * authoritative coordinates remain untouched and a replaced ring naturally
 * receives a new cache entry.
 */
function getPolygonRingSpatialIndex(ring) {
    if (!Array.isArray(ring)) {
        return emptySpatialIndex;
    }

    const cached = ringSpatialIndexCache.get(ring);

    if (cached) {
        return cached;
    }

    const index = createPolygonRingSpatialIndex(ring);

    ringSpatialIndexCache.set(ring, index);
    return index;
}

function createPolygonRingSpatialIndex(ring) {
    const openLength = getOpenRingLength(ring);
    const edges = [];
    let bounds = null;

    for (let segmentIndex = 0; segmentIndex < openLength; segmentIndex++) {
        const start = ring[segmentIndex];
        const end = ring[(segmentIndex + 1) % openLength];

        if (!isFiniteCoordinate(start) || !isFiniteCoordinate(end)) {
            continue;
        }

        const edge = createBoundaryEdge(start, end, segmentIndex);

        edges.push(edge);
        bounds = mergeBounds(bounds, edge.bounds);
    }

    if (edges.length === 0 || !bounds) {
        return emptySpatialIndex;
    }

    const scanline = createScanlineIndex(edges, bounds);

    return {
        bounds,
        boundaryBvh: createBoundaryBvh(edges),
        edgeCount: edges.length,
        scanline
    };
}

function queryPointInPolygonRing(ring, x, y) {
    const index = getPolygonRingSpatialIndex(ring);
    const diagnostics = {
        boundsRejected: false,
        candidateCount: 0,
        edgeTests: 0,
        inside: false
    };

    diagnostics.inside = classifyPointInSpatialIndex(index, x, y, diagnostics);
    return diagnostics;
}

function isPointInPolygonRing(ring, x, y) {
    return classifyPointInSpatialIndex(getPolygonRingSpatialIndex(ring), x, y);
}

function classifyPointInSpatialIndex(index, x, y, diagnostics = null) {
    if (!Number.isFinite(x)
        || !Number.isFinite(y)
        || !index.bounds
        || !doBoundsContainPoint(index.bounds, x, y)) {
        if (diagnostics) {
            diagnostics.boundsRejected = true;
        }

        return false;
    }

    const candidates = getScanlineCandidates(index.scanline, y);
    let inside = false;

    for (const edge of candidates) {
        if ((edge.startY > y) === (edge.endY > y)) {
            continue;
        }

        const intersectionX = edge.startX
            + (y - edge.startY) * edge.deltaXOverDeltaY;

        if (x < intersectionX) {
            inside = !inside;
        }
    }

    if (diagnostics) {
        diagnostics.candidateCount = candidates.length;
        diagnostics.edgeTests = candidates.length;
    }

    return inside;
}

function findSegmentRingBoundaryContact(ring, startPoint, endPoint) {
    if (!isFinitePoint(startPoint) || !isFinitePoint(endPoint)) {
        return null;
    }

    const index = getPolygonRingSpatialIndex(ring);
    const queryBounds = getPointSegmentBounds(startPoint, endPoint);

    if (!index.boundaryBvh || !doBoundsOverlap(index.bounds, queryBounds)) {
        return null;
    }

    let closestContact = null;

    visitSegmentBoundaryBvh(index.boundaryBvh, queryBounds, edge => {
        const intersection = getSegmentIntersection(startPoint, endPoint, edge);

        if (!intersection || !isEarlierContact(intersection, edge.segmentIndex, closestContact)) {
            return;
        }

        closestContact = {
            point: intersection.point,
            pathT: intersection.pathT,
            segmentIndex: edge.segmentIndex,
            segmentT: intersection.segmentT
        };
    });

    return closestContact;
}

function findClosestRingBoundaryContact(ring, point) {
    if (!isFinitePoint(point)) {
        return null;
    }

    const index = getPolygonRingSpatialIndex(ring);

    if (!index.boundaryBvh) {
        return null;
    }

    return visitClosestBoundaryBvh(index.boundaryBvh, point, null);
}

function createScanlineIndex(edges, bounds) {
    const pointEdges = edges.filter(edge => (
        edge.endY !== edge.startY
    ));
    const height = bounds.maxY - bounds.minY;

    if (pointEdges.length === 0 || height <= 0) {
        return {
            buckets: [pointEdges],
            bucketHeight: 0,
            maxY: bounds.maxY,
            minY: bounds.minY
        };
    }

    const bucketCount = clampInteger(
        Math.ceil(Math.sqrt(pointEdges.length) * 2),
        minimumBucketCount,
        maximumBucketCount
    );
    const bucketHeight = height / bucketCount;
    const buckets = Array.from({ length: bucketCount }, () => []);

    for (const edge of pointEdges) {
        const firstBucket = getScanlineBucketIndex(
            edge.bounds.minY,
            bounds.minY,
            bucketHeight,
            bucketCount
        );
        const lastBucket = getScanlineBucketIndex(
            edge.bounds.maxY,
            bounds.minY,
            bucketHeight,
            bucketCount
        );

        for (let bucketIndex = firstBucket; bucketIndex <= lastBucket; bucketIndex++) {
            buckets[bucketIndex].push(edge);
        }
    }

    return {
        buckets,
        bucketHeight,
        maxY: bounds.maxY,
        minY: bounds.minY
    };
}

function getScanlineCandidates(scanline, y) {
    if (!scanline || scanline.buckets.length === 0) {
        return [];
    }

    if (scanline.buckets.length === 1 || scanline.bucketHeight <= 0) {
        return scanline.buckets[0];
    }

    const bucketIndex = getScanlineBucketIndex(
        y,
        scanline.minY,
        scanline.bucketHeight,
        scanline.buckets.length
    );

    return scanline.buckets[bucketIndex];
}

function createBoundaryEdge(start, end, segmentIndex) {
    const startX = start[0];
    const startY = start[1];
    const endX = end[0];
    const endY = end[1];
    const deltaY = endY - startY;

    return {
        bounds: {
            minX: Math.min(startX, endX),
            minY: Math.min(startY, endY),
            maxX: Math.max(startX, endX),
            maxY: Math.max(startY, endY)
        },
        centerX: (startX + endX) / 2,
        centerY: (startY + endY) / 2,
        deltaXOverDeltaY: deltaY === 0
            ? 0
            : (endX - startX) / deltaY,
        endX,
        endY,
        segmentIndex,
        startX,
        startY
    };
}

function createBoundaryBvh(edges) {
    if (!Array.isArray(edges) || edges.length === 0) {
        return null;
    }

    const bounds = getEdgesBounds(edges);

    if (edges.length <= boundaryLeafSize) {
        return {
            bounds,
            edges
        };
    }

    const splitOnX = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
    const sorted = [...edges].sort((first, second) => (
        splitOnX
            ? first.centerX - second.centerX || first.segmentIndex - second.segmentIndex
            : first.centerY - second.centerY || first.segmentIndex - second.segmentIndex
    ));
    const middle = Math.floor(sorted.length / 2);

    return {
        bounds,
        left: createBoundaryBvh(sorted.slice(0, middle)),
        right: createBoundaryBvh(sorted.slice(middle))
    };
}

function visitSegmentBoundaryBvh(node, queryBounds, visitEdge) {
    if (!node || !doBoundsOverlap(node.bounds, queryBounds)) {
        return;
    }

    if (node.edges) {
        for (const edge of node.edges) {
            if (doBoundsOverlap(edge.bounds, queryBounds)) {
                visitEdge(edge);
            }
        }
        return;
    }

    visitSegmentBoundaryBvh(node.left, queryBounds, visitEdge);
    visitSegmentBoundaryBvh(node.right, queryBounds, visitEdge);
}

function visitClosestBoundaryBvh(node, point, closestContact) {
    if (!node || getPointBoundsDistanceSquared(point, node.bounds) > getContactDistance(closestContact)) {
        return closestContact;
    }

    if (node.edges) {
        for (const edge of node.edges) {
            if (getPointBoundsDistanceSquared(point, edge.bounds) > getContactDistance(closestContact)) {
                continue;
            }

            const projection = projectPointOnBoundaryEdge(point, edge);

            if (isCloserProjection(projection, edge.segmentIndex, closestContact)) {
                closestContact = {
                    point: projection.point,
                    segmentIndex: edge.segmentIndex,
                    segmentT: projection.segmentT,
                    distanceSquared: projection.distanceSquared
                };
            }
        }
        return closestContact;
    }

    const leftDistance = node.left
        ? getPointBoundsDistanceSquared(point, node.left.bounds)
        : Infinity;
    const rightDistance = node.right
        ? getPointBoundsDistanceSquared(point, node.right.bounds)
        : Infinity;
    const first = leftDistance <= rightDistance ? node.left : node.right;
    const second = first === node.left ? node.right : node.left;

    closestContact = visitClosestBoundaryBvh(first, point, closestContact);
    return visitClosestBoundaryBvh(second, point, closestContact);
}

function getSegmentIntersection(firstStart, firstEnd, edge) {
    const firstDirectionX = firstEnd.x - firstStart.x;
    const firstDirectionY = firstEnd.y - firstStart.y;
    const secondDirectionX = edge.endX - edge.startX;
    const secondDirectionY = edge.endY - edge.startY;
    const denominator = cross(
        firstDirectionX,
        firstDirectionY,
        secondDirectionX,
        secondDirectionY
    );

    if (Math.abs(denominator) <= geometryEpsilon) {
        return null;
    }

    const startDeltaX = edge.startX - firstStart.x;
    const startDeltaY = edge.startY - firstStart.y;
    const pathT = cross(startDeltaX, startDeltaY, secondDirectionX, secondDirectionY)
        / denominator;
    const segmentT = cross(startDeltaX, startDeltaY, firstDirectionX, firstDirectionY)
        / denominator;

    if (!isUnitRange(pathT) || !isUnitRange(segmentT)) {
        return null;
    }

    return {
        point: {
            x: firstStart.x + firstDirectionX * pathT,
            y: firstStart.y + firstDirectionY * pathT
        },
        pathT,
        segmentT
    };
}

function projectPointOnBoundaryEdge(point, edge) {
    const directionX = edge.endX - edge.startX;
    const directionY = edge.endY - edge.startY;
    const lengthSquared = directionX * directionX + directionY * directionY;
    const pointDeltaX = point.x - edge.startX;
    const pointDeltaY = point.y - edge.startY;
    const segmentT = lengthSquared <= geometryEpsilon
        ? 0
        : clampUnitRange((pointDeltaX * directionX + pointDeltaY * directionY) / lengthSquared);
    const projectedX = edge.startX + directionX * segmentT;
    const projectedY = edge.startY + directionY * segmentT;
    const distanceX = point.x - projectedX;
    const distanceY = point.y - projectedY;

    return {
        point: {
            x: projectedX,
            y: projectedY
        },
        segmentT,
        distanceSquared: distanceX * distanceX + distanceY * distanceY
    };
}

function isEarlierContact(intersection, segmentIndex, closestContact) {
    return !closestContact
        || intersection.pathT < closestContact.pathT
        || (intersection.pathT === closestContact.pathT
            && segmentIndex < closestContact.segmentIndex);
}

function isCloserProjection(projection, segmentIndex, closestContact) {
    return !closestContact
        || projection.distanceSquared < closestContact.distanceSquared
        || (projection.distanceSquared === closestContact.distanceSquared
            && segmentIndex < closestContact.segmentIndex);
}

function getContactDistance(contact) {
    return contact && Number.isFinite(contact.distanceSquared)
        ? contact.distanceSquared + geometryEpsilon
        : Infinity;
}

function getPointBoundsDistanceSquared(point, bounds) {
    const deltaX = point.x < bounds.minX
        ? bounds.minX - point.x
        : point.x > bounds.maxX ? point.x - bounds.maxX : 0;
    const deltaY = point.y < bounds.minY
        ? bounds.minY - point.y
        : point.y > bounds.maxY ? point.y - bounds.maxY : 0;

    return deltaX * deltaX + deltaY * deltaY;
}

function getEdgesBounds(edges) {
    return edges.reduce((bounds, edge) => mergeBounds(bounds, edge.bounds), null);
}

function getPointSegmentBounds(first, second) {
    return {
        minX: Math.min(first.x, second.x),
        minY: Math.min(first.y, second.y),
        maxX: Math.max(first.x, second.x),
        maxY: Math.max(first.y, second.y)
    };
}

function mergeBounds(first, second) {
    if (!first) {
        return { ...second };
    }

    return {
        minX: Math.min(first.minX, second.minX),
        minY: Math.min(first.minY, second.minY),
        maxX: Math.max(first.maxX, second.maxX),
        maxY: Math.max(first.maxY, second.maxY)
    };
}

function doBoundsContainPoint(bounds, x, y) {
    return x >= bounds.minX
        && x <= bounds.maxX
        && y >= bounds.minY
        && y <= bounds.maxY;
}

function doBoundsOverlap(first, second) {
    return first.minX <= second.maxX + geometryEpsilon
        && first.maxX + geometryEpsilon >= second.minX
        && first.minY <= second.maxY + geometryEpsilon
        && first.maxY + geometryEpsilon >= second.minY;
}

function getScanlineBucketIndex(value, minValue, bucketSize, bucketCount) {
    return clampInteger(
        Math.floor((value - minValue) / bucketSize),
        0,
        bucketCount - 1
    );
}

function getOpenRingLength(ring) {
    if (!Array.isArray(ring) || ring.length === 0) {
        return 0;
    }

    const first = ring[0];
    const last = ring[ring.length - 1];

    return areCoordinatesEqual(first, last) ? ring.length - 1 : ring.length;
}

function createEmptySpatialIndex() {
    return {
        bounds: null,
        boundaryBvh: null,
        edgeCount: 0,
        scanline: {
            buckets: [[]],
            bucketHeight: 0,
            maxY: 0,
            minY: 0
        }
    };
}

function isFiniteCoordinate(coordinate) {
    return Array.isArray(coordinate)
        && Number.isFinite(coordinate[0])
        && Number.isFinite(coordinate[1]);
}

function isFinitePoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}

function areCoordinatesEqual(first, second) {
    return isFiniteCoordinate(first)
        && isFiniteCoordinate(second)
        && first[0] === second[0]
        && first[1] === second[1];
}

function cross(firstX, firstY, secondX, secondY) {
    return firstX * secondY - firstY * secondX;
}

function isUnitRange(value) {
    return value >= -geometryEpsilon && value <= 1 + geometryEpsilon;
}

function clampUnitRange(value) {
    return Math.max(0, Math.min(1, value));
}

function clampInteger(value, min, max) {
    return Math.min(max, Math.max(min, Math.floor(value)));
}

module.exports = {
    findClosestRingBoundaryContact,
    findSegmentRingBoundaryContact,
    getPolygonRingSpatialIndex,
    isPointInPolygonRing,
    queryPointInPolygonRing
};
