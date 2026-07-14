const {
    calculatePolygonArea,
    subtractKnownSimplePolygonComponents,
    unionPolygons
} = require("../utils/geometry");
const { selectRetainedTerritoryPolygon } = require("./territoryRetention");
const { measureCaptureApplyOperation } = require("./territoryDiagnostics");

const territoryChangeAreaEpsilon = 1;

/**
 * Exact boolean territory operations.
 *
 * The previous operational simplification usually paid for a simplified
 * subtraction, an intersection validation and an exact fallback. Keeping both
 * operands exact proved faster on capture replays and avoids approximation in
 * the authoritative result.
 */

function getOwnerCapturedPolygon(currentPolygon, capturedPolygon, operationPolygon, operationArea = null) {
    const resolvedOperationArea = Number.isFinite(operationArea)
        ? operationArea
        : calculatePolygonArea(operationPolygon);

    return resolvedOperationArea > 0
        ? operationPolygon
        : unionPolygons(currentPolygon, capturedPolygon);
}

function subtractTerritoryPolygon(
    subjectTerritory,
    clippingPolygon,
    subjectPlayer,
    options = {}
) {
    const phasePrefix = options.phasePrefix || "territoryOperation";
    const subjectPolygon = subjectTerritory && subjectTerritory.polygon || [];
    const subjectArea = getTerritoryArea(subjectTerritory);
    const operationSubtract = measureCaptureApplyOperation(
        options.diagnostics,
        `${phasePrefix}Subtract`,
        () => subtractKnownSimplePolygonComponents(subjectPolygon, clippingPolygon)
    );
    let retainedPolygon = selectRetainedTerritoryPolygon(
        operationSubtract.value,
        subjectPlayer
    );
    let resultArea = calculatePolygonArea(retainedPolygon);
    let removedArea = Math.max(0, subjectArea - resultArea);
    const noEffectiveChange = resultArea > subjectArea + territoryChangeAreaEpsilon
        || removedArea <= territoryChangeAreaEpsilon;

    if (noEffectiveChange) {
        retainedPolygon = subjectPolygon;
        resultArea = subjectArea;
        removedArea = 0;
    }

    return {
        operationResultArea: resultArea,
        operationSubjectArea: subjectArea,
        removedArea,
        retainedPolygon
    };
}

function getTerritoryArea(territory) {
    return Number.isFinite(territory && territory.area)
        ? territory.area
        : calculatePolygonArea(territory && territory.polygon);
}

module.exports = {
    getOwnerCapturedPolygon,
    subtractTerritoryPolygon
};
