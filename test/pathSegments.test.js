const test = require("node:test");
const assert = require("node:assert/strict");
const { createPolygonFromPoints } = require("../src/utils/geometry");
const {
    createLinePrimitivesFromPoints,
    createPathPrimitiveIndex,
    createPathPrimitivesFromPoints,
    doesLineCrossPathPrimitive
} = require("../src/utils/pathSegments");

test("polygon normalization rejects non-adjacent self intersections", () => {
    const polygon = createPolygonFromPoints([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 10, y: 0 }
    ]);

    assert.deepEqual(polygon, []);
});

test("straight points are represented as one line primitive", () => {
    const primitives = createPathPrimitivesFromPoints([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 0 }
    ]);

    assert.equal(primitives.length, 1);
    assert.equal(primitives[0].type, "line");
    assert.equal(primitives[0].startIndex, 0);
    assert.equal(primitives[0].endIndex, 3);
});

test("smooth curved points can be represented by an arc primitive", () => {
    const radius = 120;
    const points = [0, 6, 12].map(degrees => {
        const angle = degrees * Math.PI / 180;

        return {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius
        };
    });
    const primitives = createPathPrimitivesFromPoints(points, {
        angleThresholdRadians: Math.PI / 180,
        maxArcSweepRadians: Math.PI / 2,
        maxArcRadialDrift: 0.01
    });

    assert.equal(primitives.length, 1);
    assert.equal(primitives[0].type, "arc");
});

test("line movement crossing an arc primitive is detected", () => {
    const radius = 120;
    const points = [0, 6, 12].map(degrees => {
        const angle = degrees * Math.PI / 180;

        return {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius
        };
    });
    const primitives = createPathPrimitivesFromPoints(points, {
        angleThresholdRadians: Math.PI / 180,
        maxArcSweepRadians: Math.PI / 2,
        maxArcRadialDrift: 0.01
    });
    const arc = primitives[0];

    assert.equal(doesLineCrossPathPrimitive(
        { x: 110, y: 12 },
        { x: 130, y: 12 },
        arc
    ), true);
});

test("sharp corners fall back to line primitives", () => {
    const primitives = createPathPrimitivesFromPoints([
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 50 }
    ], {
        angleThresholdRadians: Math.PI / 180,
        maxArcSweepRadians: Math.PI / 2
    });

    assert.equal(primitives.length, 2);
    assert.deepEqual(primitives.map(primitive => primitive.type), ["line", "line"]);
});

test("line-only simplification compacts straight runs", () => {
    const primitives = createLinePrimitivesFromPoints([
        { x: 0, y: 0 },
        { x: 10, y: 0.1 },
        { x: 20, y: 0.2 },
        { x: 30, y: 0.25 }
    ], {
        angleThresholdRadians: Math.PI / 180,
        maxDeviation: 1.5
    });

    assert.equal(primitives.length, 1);
    assert.equal(primitives[0].type, "line");
    assert.equal(primitives[0].startIndex, 0);
    assert.equal(primitives[0].endIndex, 3);
});

test("line-only simplification preserves visible bends", () => {
    const primitives = createLinePrimitivesFromPoints([
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 30 },
        { x: 60, y: 30 }
    ], {
        angleThresholdRadians: Math.PI / 180,
        maxDeviation: 1.5
    });

    assert.deepEqual(primitives.map(primitive => primitive.type), ["line", "line", "line"]);
    assert.equal(primitives.length, 3);
});

test("path primitive index groups primitives into bounded blocks", () => {
    const primitives = createPathPrimitivesFromPoints([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 10 },
        { x: 30, y: 10 },
        { x: 40, y: 20 }
    ], {
        angleThresholdRadians: Math.PI / 180,
        maxArcSweepRadians: Math.PI / 12
    });
    const index = createPathPrimitiveIndex(primitives, {
        blockSize: 2
    });

    assert.equal(index.primitives.length, primitives.length);
    assert.equal(index.blocks.length, Math.ceil(primitives.length / 2));
    assert.deepEqual(index.bounds, {
        minX: 0,
        minY: 0,
        maxX: 40,
        maxY: 20
    });
});

test("path primitive index ignores invalid primitives safely", () => {
    const index = createPathPrimitiveIndex([
        null,
        { type: "line" },
        {
            bounds: {
                minX: 1,
                minY: 2,
                maxX: 3,
                maxY: 4
            },
            type: "line"
        }
    ], {
        blockSize: 2
    });

    assert.equal(index.primitives.length, 1);
    assert.equal(index.blocks.length, 1);
    assert.deepEqual(index.bounds, {
        minX: 1,
        minY: 2,
        maxX: 3,
        maxY: 4
    });
});
