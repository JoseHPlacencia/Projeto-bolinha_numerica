const test = require("node:test");
const assert = require("node:assert/strict");
const { createPolygonFromPoints } = require("../src/utils/geometry");
const {
    createLinePrimitivesFromPoints,
    createPathPrimitiveIndex,
    createPathPrimitivesFromPoints,
    doesLineCrossPathPrimitive,
    updatePathPrimitiveIndexFromPoints
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

test("long linear runs are split into bounded immutable primitives", () => {
    const points = Array.from({ length: 130 }, (_, index) => ({
        x: index * 10,
        y: 0
    }));
    const primitives = createLinePrimitivesFromPoints(points, {
        maxLinePointSpan: 16
    });

    assert.equal(primitives.length, 9);
    assert.deepEqual(
        primitives.map(primitive => [primitive.startIndex, primitive.endIndex]),
        [
            [0, 16],
            [16, 32],
            [32, 48],
            [48, 64],
            [64, 80],
            [80, 96],
            [96, 112],
            [112, 128],
            [128, 129]
        ]
    );
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

test("incremental path index stays equivalent while curved points are appended", () => {
    const points = Array.from({ length: 12 }, (_value, index) => {
        const angle = index * 6 * Math.PI / 180;

        return {
            x: Math.cos(angle) * 120,
            y: Math.sin(angle) * 120
        };
    });
    const options = {
        angleThresholdRadians: Math.PI / 180,
        blockSize: 2,
        maxArcRadialDrift: 0.01,
        maxArcSweepRadians: Math.PI / 2,
        mode: "path"
    };
    let state = null;
    let reusedBlock = false;
    let rebuiltLessThanFull = false;

    for (let pointCount = 2; pointCount <= points.length; pointCount++) {
        const previousState = state;

        state = updatePathPrimitiveIndexFromPoints(points, state, {
            ...options,
            pointCount
        });

        const expectedPrimitives = createPathPrimitivesFromPoints(
            points.slice(0, pointCount),
            options
        );
        const expectedIndex = createPathPrimitiveIndex(expectedPrimitives, options);

        assert.deepEqual(state.index, expectedIndex);

        if (previousState) {
            assert.equal(state.updatedIncrementally, true);
        }

        rebuiltLessThanFull ||= state.rebuiltPointCount < pointCount;
        reusedBlock ||= state.reusedBlockCount > 0;
    }

    assert.equal(rebuiltLessThanFull, true);
    assert.equal(reusedBlock, true);
});

test("incremental line index stays equivalent across sharp turns", () => {
    const points = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 40 },
        { x: 60, y: 40 },
        { x: 60, y: 60 },
        { x: 80, y: 60 }
    ];
    const options = {
        angleThresholdRadians: Math.PI / 180,
        blockSize: 2,
        maxDeviation: 0.1,
        mode: "line"
    };
    let state = null;
    let firstReusedBlock = null;

    for (let pointCount = 2; pointCount <= points.length; pointCount++) {
        const previousState = state;

        state = updatePathPrimitiveIndexFromPoints(points, state, {
            ...options,
            pointCount
        });

        const expectedPrimitives = createLinePrimitivesFromPoints(
            points.slice(0, pointCount),
            options
        );
        const expectedIndex = createPathPrimitiveIndex(expectedPrimitives, options);

        assert.deepEqual(state.index, expectedIndex);

        if (previousState && state.reusedBlockCount > 0) {
            assert.equal(state.index.blocks[0], previousState.index.blocks[0]);
            firstReusedBlock = state.index.blocks[0];
        }
    }

    assert.ok(firstReusedBlock);
});

test("incremental line index bounds rebuild work on long straight trails", () => {
    const points = Array.from({ length: 130 }, (_, index) => ({
        x: index * 15,
        y: 0
    }));
    const options = {
        blockSize: 2,
        maxLinePointSpan: 16,
        mode: "line"
    };
    let state = null;

    for (let pointCount = 2; pointCount <= points.length; pointCount++) {
        state = updatePathPrimitiveIndexFromPoints(points, state, {
            ...options,
            pointCount
        });
        const source = points.slice(0, pointCount);
        const expected = createPathPrimitiveIndex(
            createLinePrimitivesFromPoints(source, options),
            options
        );

        assert.deepEqual(state.index, expected);
        assert.ok(state.rebuiltPointCount <= options.maxLinePointSpan + 1);
    }
});

test("incremental path index also seals long straight trail prefixes", () => {
    const points = Array.from({ length: 100 }, (_, index) => ({
        x: index * 15,
        y: 0
    }));
    const options = {
        blockSize: 2,
        maxLinePointSpan: 12,
        mode: "path"
    };
    let state = null;

    for (let pointCount = 2; pointCount <= points.length; pointCount++) {
        state = updatePathPrimitiveIndexFromPoints(points, state, {
            ...options,
            pointCount
        });
        const source = points.slice(0, pointCount);
        const expected = createPathPrimitiveIndex(
            createPathPrimitivesFromPoints(source, options),
            options
        );

        assert.deepEqual(state.index, expected);
        assert.ok(state.rebuiltPointCount <= options.maxLinePointSpan + 1);
    }
});

test("incremental path index falls back after prefix mutation", () => {
    const points = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 40, y: 10 }
    ];
    const options = {
        blockSize: 2,
        mode: "line"
    };
    const previousState = updatePathPrimitiveIndexFromPoints(points, null, {
        ...options,
        pointCount: 2
    });

    points[1].y = 5;

    const nextState = updatePathPrimitiveIndexFromPoints(points, previousState, {
        ...options,
        pointCount: 3
    });
    const expected = createPathPrimitiveIndex(
        createLinePrimitivesFromPoints(points, options),
        options
    );

    assert.equal(nextState.updatedIncrementally, false);
    assert.deepEqual(nextState.index, expected);
});

test("incremental path index falls back when appended points are invalid", () => {
    const points = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: Number.NaN, y: 10 },
        { x: 40, y: 20 }
    ];
    const options = {
        mode: "path"
    };
    const previousState = updatePathPrimitiveIndexFromPoints(points, null, {
        ...options,
        pointCount: 2
    });
    const nextState = updatePathPrimitiveIndexFromPoints(points, previousState, {
        ...options,
        pointCount: 4
    });
    const expected = createPathPrimitiveIndex(
        createPathPrimitivesFromPoints(points, options),
        options
    );

    assert.equal(nextState.updatedIncrementally, false);
    assert.equal(nextState.allPointsValid, false);
    assert.deepEqual(nextState.index, expected);
});

test("incremental indexes match full builds across deterministic mixed trajectories", () => {
    const points = [{ x: 0, y: 0 }];
    let angle = 0;

    for (let index = 1; index < 90; index++) {
        angle += Math.sin(index * 0.73) * 0.09 + (index % 11 === 0 ? Math.PI / 3 : 0);
        points.push({
            x: points[index - 1].x + Math.cos(angle) * 15,
            y: points[index - 1].y + Math.sin(angle) * 15
        });
    }

    for (const mode of ["path", "line"]) {
        const options = {
            angleThresholdRadians: Math.PI / 180,
            blockSize: 4,
            maxArcRadialDrift: 2,
            maxArcSweepRadians: Math.PI * 0.75,
            maxDeviation: 1.5,
            mode
        };
        let state = null;

        for (let pointCount = 2; pointCount <= points.length; pointCount++) {
            state = updatePathPrimitiveIndexFromPoints(points, state, {
                ...options,
                pointCount
            });

            const source = points.slice(0, pointCount);
            const expectedPrimitives = mode === "line"
                ? createLinePrimitivesFromPoints(source, options)
                : createPathPrimitivesFromPoints(source, options);
            const expectedIndex = createPathPrimitiveIndex(expectedPrimitives, options);

            assert.deepEqual(state.index, expectedIndex);
        }
    }
});
