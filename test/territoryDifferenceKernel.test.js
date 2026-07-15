const test = require("node:test");
const assert = require("node:assert/strict");

const {
    calculatePolygonArea,
    isPointInPolygon,
    subtractKnownSimplePolygonComponents
} = require("../src/utils/geometry");
const {
    getTerritoryDifferenceKernelDiagnostics,
    initializeTerritoryDifferenceKernel,
    subtractTerritoryPolygonComponents
} = require("../src/utils/territoryDifferenceKernel");
const {
    subtractTerritoryPolygon
} = require("../src/state/territoryOperations");
const {
    applyCapturedPolygon
} = require("../src/state/territories");
const {
    removeDegenerateTerritorySpikes
} = require("../src/state/territoryPolygonCleanup");

test("Clipper2 territory kernel preserves subtraction area and components", async () => {
    assert.equal(await initializeTerritoryDifferenceKernel("clipper2-wasm"), true);

    const subject = createRectangle(0, 0, 100, 100);
    const clipping = createRectangle(40, -10, 60, 110);
    const components = subtractTerritoryPolygonComponents(
        subject,
        clipping,
        subtractKnownSimplePolygonComponents
    );
    const diagnostics = getTerritoryDifferenceKernelDiagnostics();

    assert.equal(diagnostics.status, "ready");
    assert.equal(diagnostics.activeKernel, "clipper2-wasm");
    assert.equal(components.length, 2);
    assert.equal(sumPolygonAreas(components), 8000);
});

test("Clipper2 territory kernel discards sub-epsilon residual components", async () => {
    await initializeTerritoryDifferenceKernel("clipper2-wasm");

    const subject = createRectangle(0, 0, 100, 100);
    const clipping = createRectangle(-10, -10, 99.995, 110);
    const components = subtractTerritoryPolygonComponents(
        subject,
        clipping,
        subtractKnownSimplePolygonComponents
    );

    assert.deepEqual(components, []);
});

test("territory subtraction keeps the component connected to its owner", async () => {
    await initializeTerritoryDifferenceKernel("clipper2-wasm");

    const subjectPolygon = createRectangle(0, 0, 100, 100);
    const result = subtractTerritoryPolygon(
        {
            area: 10000,
            polygon: subjectPolygon
        },
        createRectangle(40, -10, 60, 110),
        { x: 10, y: 50 }
    );

    assert.equal(result.operationSubjectArea, 10000);
    assert.equal(result.operationResultArea, 4000);
    assert.equal(result.removedArea, 6000);
    assert.equal(isPointInPolygon(result.retainedPolygon, 10, 50), true);
    assert.equal(isPointInPolygon(result.retainedPolygon, 90, 50), false);
});

test("territory cleanup removes a deep near-zero-area backtracking spike", () => {
    const polygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50, 180],
        [50.01, 100],
        [0, 100],
        [0, 0]
    ]];
    const originalArea = calculatePolygonArea(polygon);
    const cleaned = removeDegenerateTerritorySpikes(polygon);

    assert.notEqual(cleaned, polygon);
    assert.equal(cleaned[0].some(point => point[1] === 180), false);
    assert.ok(Math.abs(calculatePolygonArea(cleaned) - originalArea) <= 1);
    assert.equal(isPointInPolygon(cleaned, 50, 50), true);
});

test("territory cleanup absorbs small boolean rounding area in a long spike", () => {
    const polygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50, 180],
        [50.05, 100],
        [0, 100],
        [0, 0]
    ]];
    const cleaned = removeDegenerateTerritorySpikes(polygon);

    assert.notEqual(cleaned, polygon);
    assert.equal(cleaned[0].some(point => point[1] === 180), false);
});

test("territory cleanup removes a long branch with sub-unit effective width", () => {
    const polygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50, 460],
        [51, 100],
        [0, 100],
        [0, 0]
    ]];
    const cleaned = removeDegenerateTerritorySpikes(polygon);

    assert.notEqual(cleaned, polygon);
    assert.equal(cleaned[0].some(point => point[1] === 460), false);
});

test("territory cleanup preserves a narrow appendage with meaningful area", () => {
    const polygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50, 180],
        [52, 100],
        [0, 100],
        [0, 0]
    ]];
    const cleaned = removeDegenerateTerritorySpikes(polygon);

    assert.equal(cleaned, polygon);
    assert.equal(cleaned[0].some(point => point[1] === 180), true);
});

test("territory cleanup detects a degenerate spike across the ring boundary", () => {
    const polygon = [[
        [50, 180],
        [50.01, 100],
        [0, 100],
        [0, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50, 180]
    ]];
    const cleaned = removeDegenerateTerritorySpikes(polygon);

    assert.notEqual(cleaned, polygon);
    assert.equal(cleaned[0].some(point => point[1] === 180), false);
});

test("territory cleanup repairs multiple rounding spikes as one simple polygon", () => {
    const polygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [80, 100],
        [80, 180],
        [80.01, 100],
        [60, 100],
        [40, 100],
        [40, 160],
        [40.01, 100],
        [0, 100],
        [0, 0]
    ]];
    const cleaned = removeDegenerateTerritorySpikes(polygon);

    assert.notEqual(cleaned, polygon);
    assert.equal(cleaned[0].some(point => point[1] > 100), false);
});

test("authoritative territory updates clean degenerate capture spikes", () => {
    const previousPolygon = createRectangle(0, 0, 50, 100);
    const capturedPolygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50, 180],
        [50.01, 100],
        [0, 100],
        [0, 0]
    ]];
    const territory = {
        area: calculatePolygonArea(previousPolygon),
        baseX: 25,
        baseY: 50,
        captureOperationLog: [],
        id: "owner",
        polygon: previousPolygon,
        version: 1
    };
    const territories = new Map([[territory.id, territory]]);

    applyCapturedPolygon(territories, territory.id, capturedPolygon, {
        ownerPolygon: capturedPolygon
    });

    assert.equal(territory.version, 2);
    assert.equal(territory.polygon[0].some(point => point[1] === 180), false);
    assert.equal(territory.captureOperationUnsafeVersion, territory.version);
});

test("authoritative updates replace an existing spike despite sub-epsilon area change", () => {
    const cleanPolygon = createRectangle(0, 0, 100, 100);
    const spikedPolygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50, 180],
        [50.01, 100],
        [0, 100],
        [0, 0]
    ]];
    const territory = {
        area: calculatePolygonArea(spikedPolygon),
        baseX: 25,
        baseY: 50,
        captureOperationLog: [],
        id: "owner",
        polygon: spikedPolygon,
        version: 1
    };
    const territories = new Map([[territory.id, territory]]);

    applyCapturedPolygon(territories, territory.id, cleanPolygon, {
        ownerPolygon: cleanPolygon
    });

    assert.equal(territory.version, 2);
    assert.deepEqual(territory.polygon, cleanPolygon);
    assert.equal(territory.captureOperationUnsafeVersion, territory.version);
});

function createRectangle(minX, minY, maxX, maxY) {
    return [[
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
        [minX, minY]
    ]];
}

function sumPolygonAreas(polygons) {
    return polygons.reduce((sum, polygon) => sum + calculatePolygonArea(polygon), 0);
}
