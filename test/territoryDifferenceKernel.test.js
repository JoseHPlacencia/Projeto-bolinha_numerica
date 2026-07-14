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
