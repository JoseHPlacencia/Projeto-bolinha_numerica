const test = require("node:test");
const assert = require("node:assert/strict");

const {
    calculatePolygonArea,
    createCirclePolygon,
    createPolygonMetrics,
    findClosestPolygonBoundaryContact,
    findSegmentPolygonBoundaryContact,
    getPolygonBounds,
    getPolygonPointCount,
    isPointInPolygon
} = require("../src/utils/geometry");
const {
    getPolygonRingSpatialIndex,
    queryPointInPolygonRing
} = require("../src/utils/polygonSpatialIndex");

const epsilon = 1e-7;

test("combined polygon metrics match the standalone geometry queries", () => {
    const polygons = [
        [],
        createCirclePolygon(15, -25, 130, 96),
        createConcavePolygon()
    ];

    for (const polygon of polygons) {
        const metrics = createPolygonMetrics(polygon);

        assert.strictEqual(metrics.polygon, polygon);
        assert.equal(metrics.area, calculatePolygonArea(polygon));
        assert.deepEqual(metrics.bounds, getPolygonBounds(polygon));
        assert.equal(metrics.pointCount, getPolygonPointCount(polygon));
    }
});

test("scanline index preserves point-in-polygon parity", () => {
    const polygons = [
        createCirclePolygon(0, 0, 250, 96),
        createCirclePolygon(100, -50, 600, 1536),
        createConcavePolygon(),
        [closeRing([
            [0, 0],
            [1e-8, 0],
            [1e-8, 1e-8],
            [0, 1e-8]
        ])]
    ];
    const random = createRandom(0x51deca7e);

    for (const polygon of polygons) {
        for (let index = 0; index < 4000; index++) {
            const x = random() * 1800 - 900;
            const y = random() * 1800 - 900;

            assert.equal(
                isPointInPolygon(polygon, x, y),
                referencePointInRing(polygon[0], x, y),
                `point mismatch at (${x}, ${y})`
            );
        }

        for (const [x, y] of polygon[0]) {
            assert.equal(
                isPointInPolygon(polygon, x, y),
                referencePointInRing(polygon[0], x, y)
            );
        }

        const bounds = getReferenceBounds(polygon[0]);
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;

        assert.equal(
            isPointInPolygon(polygon, centerX, centerY),
            referencePointInRing(polygon[0], centerX, centerY)
        );
    }
});

test("point queries reject outer bounds and reuse the ring index", () => {
    const polygon = createCirclePolygon(10, -20, 100, 96);
    const first = getPolygonRingSpatialIndex(polygon[0]);
    const second = getPolygonRingSpatialIndex(polygon[0]);
    const outside = queryPointInPolygonRing(polygon[0], 1000, 1000);
    const inside = queryPointInPolygonRing(polygon[0], 10, -20);

    assert.strictEqual(first, second);
    assert.equal(first.edgeCount, 96);
    assert.deepEqual(outside, {
        boundsRejected: true,
        candidateCount: 0,
        edgeTests: 0,
        inside: false
    });
    assert.equal(inside.inside, true);
    assert.ok(inside.candidateCount < first.edgeCount);
});

test("boundary BVH preserves the earliest movement contact", () => {
    const random = createRandom(0xc001d00d);

    for (const polygon of createBoundaryTestPolygons()) {
        for (let index = 0; index < 500; index++) {
            const start = {
                x: random() * 1600 - 800,
                y: random() * 1600 - 800
            };
            const end = {
                x: random() * 1600 - 800,
                y: random() * 1600 - 800
            };
            const expected = referenceSegmentBoundaryContact(polygon[0], start, end);
            const actual = findSegmentPolygonBoundaryContact(polygon, start, end);

            assertContactsEqual(actual, expected);
        }
    }
});

test("boundary BVH preserves the closest boundary contact", () => {
    const random = createRandom(0x7f4a7c15);

    for (const polygon of createBoundaryTestPolygons()) {
        for (let index = 0; index < 500; index++) {
            const point = {
                x: random() * 1800 - 900,
                y: random() * 1800 - 900
            };
            const expected = referenceClosestBoundaryContact(polygon[0], point);
            const actual = findClosestPolygonBoundaryContact(polygon, point);

            assert.ok(actual);
            assert.ok(expected);
            assert.equal(actual.segmentIndex, expected.segmentIndex);
            assert.ok(Math.abs(actual.segmentT - expected.segmentT) <= 1e-10);
            assert.ok(Math.abs(actual.distanceSquared - expected.distanceSquared) <= 1e-8);
            assert.ok(Math.abs(actual.point.x - expected.point.x) <= 1e-10);
            assert.ok(Math.abs(actual.point.y - expected.point.y) <= 1e-10);
        }
    }
});

function createBoundaryTestPolygons() {
    return [
        createCirclePolygon(0, 0, 500, 720),
        createConcavePolygon()
    ];
}

function createConcavePolygon() {
    return [closeRing([
        [-400, -300],
        [0, -80],
        [400, -300],
        [180, 0],
        [400, 300],
        [0, 80],
        [-400, 300],
        [-180, 0]
    ])];
}

function referencePointInRing(ring, x, y) {
    let inside = false;

    for (
        let currentIndex = 0, previousIndex = ring.length - 1;
        currentIndex < ring.length;
        previousIndex = currentIndex++
    ) {
        const current = ring[currentIndex];
        const previous = ring[previousIndex];

        if ((current[1] > y) === (previous[1] > y)) {
            continue;
        }

        const intersectionX = (
            (previous[0] - current[0]) * (y - current[1])
        ) / (previous[1] - current[1]) + current[0];

        if (x < intersectionX) {
            inside = !inside;
        }
    }

    return inside;
}

function referenceSegmentBoundaryContact(ring, start, end) {
    const openLength = getOpenRingLength(ring);
    let closest = null;

    for (let segmentIndex = 0; segmentIndex < openLength; segmentIndex++) {
        const boundaryStart = toPoint(ring[segmentIndex]);
        const boundaryEnd = toPoint(ring[(segmentIndex + 1) % openLength]);
        const intersection = getSegmentIntersection(start, end, boundaryStart, boundaryEnd);

        if (intersection && (!closest || intersection.pathT < closest.pathT)) {
            closest = {
                ...intersection,
                segmentIndex
            };
        }
    }

    return closest;
}

function referenceClosestBoundaryContact(ring, point) {
    const openLength = getOpenRingLength(ring);
    let closest = null;

    for (let segmentIndex = 0; segmentIndex < openLength; segmentIndex++) {
        const projection = projectPointOnSegment(
            point,
            toPoint(ring[segmentIndex]),
            toPoint(ring[(segmentIndex + 1) % openLength])
        );

        if (!closest || projection.distanceSquared < closest.distanceSquared) {
            closest = {
                ...projection,
                segmentIndex
            };
        }
    }

    return closest;
}

function getSegmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
    const firstDirection = subtract(firstEnd, firstStart);
    const secondDirection = subtract(secondEnd, secondStart);
    const denominator = cross(firstDirection, secondDirection);

    if (Math.abs(denominator) <= epsilon) {
        return null;
    }

    const startDelta = subtract(secondStart, firstStart);
    const pathT = cross(startDelta, secondDirection) / denominator;
    const segmentT = cross(startDelta, firstDirection) / denominator;

    if (!isUnitRange(pathT) || !isUnitRange(segmentT)) {
        return null;
    }

    return {
        point: {
            x: firstStart.x + firstDirection.x * pathT,
            y: firstStart.y + firstDirection.y * pathT
        },
        pathT,
        segmentT
    };
}

function projectPointOnSegment(point, start, end) {
    const direction = subtract(end, start);
    const lengthSquared = direction.x * direction.x + direction.y * direction.y;
    const delta = subtract(point, start);
    const segmentT = lengthSquared <= epsilon
        ? 0
        : Math.max(0, Math.min(1, dot(delta, direction) / lengthSquared));
    const projectedPoint = {
        x: start.x + direction.x * segmentT,
        y: start.y + direction.y * segmentT
    };
    const distanceX = point.x - projectedPoint.x;
    const distanceY = point.y - projectedPoint.y;

    return {
        point: projectedPoint,
        segmentT,
        distanceSquared: distanceX * distanceX + distanceY * distanceY
    };
}

function assertContactsEqual(actual, expected) {
    if (!expected) {
        assert.equal(actual, null);
        return;
    }

    assert.ok(actual);
    assert.equal(actual.segmentIndex, expected.segmentIndex);
    assert.ok(Math.abs(actual.pathT - expected.pathT) <= 1e-10);
    assert.ok(Math.abs(actual.segmentT - expected.segmentT) <= 1e-10);
    assert.ok(Math.abs(actual.point.x - expected.point.x) <= 1e-10);
    assert.ok(Math.abs(actual.point.y - expected.point.y) <= 1e-10);
}

function closeRing(points) {
    return points.concat([[points[0][0], points[0][1]]]);
}

function getReferenceBounds(ring) {
    return ring.reduce((bounds, point) => ({
        minX: Math.min(bounds.minX, point[0]),
        minY: Math.min(bounds.minY, point[1]),
        maxX: Math.max(bounds.maxX, point[0]),
        maxY: Math.max(bounds.maxY, point[1])
    }), {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    });
}

function getOpenRingLength(ring) {
    const first = ring[0];
    const last = ring[ring.length - 1];

    return first[0] === last[0] && first[1] === last[1]
        ? ring.length - 1
        : ring.length;
}

function toPoint(coordinates) {
    return {
        x: coordinates[0],
        y: coordinates[1]
    };
}

function subtract(first, second) {
    return {
        x: first.x - second.x,
        y: first.y - second.y
    };
}

function cross(first, second) {
    return first.x * second.y - first.y * second.x;
}

function dot(first, second) {
    return first.x * second.x + first.y * second.y;
}

function isUnitRange(value) {
    return value >= -epsilon && value <= 1 + epsilon;
}

function createRandom(seed) {
    let state = seed >>> 0;

    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}
