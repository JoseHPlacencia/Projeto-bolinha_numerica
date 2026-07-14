const path = require("node:path");
const clipper2WasmFactory = require("clipper2-wasm");

// Intersections need more precision than stored input points. Rounding a long
// shared edge back to three decimals can leave more than one square unit of
// residual overlap, even when both operands originally use three decimals.
const clipperDecimalPrecision = 6;
const minimumTerritoryComponentArea = 1;
const supportedKernel = "clipper2-wasm";

let clipper2 = null;
let initializationPromise = null;
const diagnostics = {
    configuredKernel: null,
    activeKernel: "polygon-clipping",
    status: "not_initialized",
    operationCount: 0,
    fallbackCount: 0,
    operationErrorCount: 0,
    initializationError: null,
    lastOperationError: null
};

/**
 * Loads the WebAssembly boolean kernel before rooms begin updating.
 *
 * Geometry calls stay synchronous after this one-time initialization. If the
 * module is unavailable, callers keep using the supplied polygon-clipping
 * fallback instead of preventing the server from starting.
 */
function initializeTerritoryDifferenceKernel(configuredKernel = supportedKernel) {
    if (initializationPromise) {
        return initializationPromise;
    }

    diagnostics.configuredKernel = configuredKernel;

    if (configuredKernel !== supportedKernel) {
        diagnostics.status = "fallback";
        initializationPromise = Promise.resolve(false);
        return initializationPromise;
    }

    diagnostics.status = "initializing";
    initializationPromise = initializeClipper2()
        .then(module => {
            clipper2 = module;
            diagnostics.activeKernel = supportedKernel;
            diagnostics.status = "ready";
            return true;
        })
        .catch(error => {
            diagnostics.initializationError = serializeError(error);
            diagnostics.status = "fallback";
            return false;
        });

    return initializationPromise;
}

function subtractTerritoryPolygonComponents(subject, clipping, fallback) {
    if (!clipper2) {
        return runFallback(subject, clipping, fallback);
    }

    try {
        const result = subtractWithClipper2(subject, clipping);

        diagnostics.operationCount++;
        return result;
    } catch (error) {
        diagnostics.operationErrorCount++;
        diagnostics.lastOperationError = serializeError(error);
        return runFallback(subject, clipping, fallback);
    }
}

function getTerritoryDifferenceKernelDiagnostics() {
    return {
        ...diagnostics,
        initializationError: diagnostics.initializationError
            ? { ...diagnostics.initializationError }
            : null,
        lastOperationError: diagnostics.lastOperationError
            ? { ...diagnostics.lastOperationError }
            : null
    };
}

async function initializeClipper2() {
    const modulePath = require.resolve("clipper2-wasm");
    const wasmPath = path.join(path.dirname(modulePath), "clipper2z.wasm");

    return clipper2WasmFactory({
        locateFile: filename => filename.endsWith(".wasm") ? wasmPath : filename
    });
}

function subtractWithClipper2(subject, clipping) {
    if (!hasPolygon(subject)) {
        return [];
    }

    if (!hasPolygon(clipping)) {
        return [subject];
    }

    const subjectPaths = createPaths(subject);
    const clippingPaths = createPaths(clipping);
    let resultPaths = null;

    try {
        resultPaths = clipper2.DifferenceD(
            subjectPaths,
            clippingPaths,
            clipper2.FillRule.NonZero,
            clipperDecimalPrecision
        );

        return unpackPositiveComponents(resultPaths);
    } finally {
        if (resultPaths) {
            resultPaths.delete();
        }
        subjectPaths.delete();
        clippingPaths.delete();
    }
}

function createPaths(polygon) {
    const paths = new clipper2.PathsD();

    try {
        for (const ring of polygon) {
            const openRing = getOpenRing(ring);

            if (openRing.length < 3) {
                continue;
            }

            const coordinates = new Float64Array(openRing.length * 3);

            for (let index = 0; index < openRing.length; index++) {
                coordinates[index * 3] = openRing[index][0];
                coordinates[index * 3 + 1] = openRing[index][1];
            }

            const pathValue = new clipper2.PathD();

            try {
                pathValue.assign(coordinates);
                paths.push_back(pathValue);
            } finally {
                pathValue.delete();
            }
        }
    } catch (error) {
        paths.delete();
        throw error;
    }

    return paths;
}

function unpackPositiveComponents(paths) {
    const components = [];

    for (let pathIndex = 0; pathIndex < paths.size(); pathIndex++) {
        const pathValue = paths.get(pathIndex);

        try {
            if (pathValue.size() < 3 || !clipper2.IsPositiveD(pathValue)) {
                continue;
            }

            const coordinates = pathValue.view();
            const ring = [];

            for (let index = 0; index < coordinates.length; index += 3) {
                ring.push([coordinates[index], coordinates[index + 1]]);
            }

            closeRing(ring);

            if (calculateRingArea(ring) > minimumTerritoryComponentArea) {
                components.push([ring]);
            }
        } finally {
            pathValue.delete();
        }
    }

    return components;
}

function runFallback(subject, clipping, fallback) {
    diagnostics.fallbackCount++;

    if (typeof fallback !== "function") {
        throw new TypeError("Territory subtraction requires a fallback kernel.");
    }

    return fallback(subject, clipping);
}

function getOpenRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    return ring.length > 1 && areCoordinatesEqual(ring[0], ring[ring.length - 1])
        ? ring.slice(0, -1)
        : ring;
}

function closeRing(ring) {
    if (ring.length > 0 && !areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        ring.push([ring[0][0], ring[0][1]]);
    }
}

function calculateRingArea(ring) {
    let doubleArea = 0;

    for (let index = 0; index < ring.length - 1; index++) {
        const current = ring[index];
        const next = ring[index + 1];

        doubleArea += current[0] * next[1] - next[0] * current[1];
    }

    return Math.abs(doubleArea / 2);
}

function hasPolygon(polygon) {
    return Array.isArray(polygon) && polygon.length > 0;
}

function areCoordinatesEqual(first, second) {
    return Array.isArray(first)
        && Array.isArray(second)
        && first[0] === second[0]
        && first[1] === second[1];
}

function serializeError(error) {
    return {
        message: error && error.message || String(error),
        stack: error && error.stack || null
    };
}

module.exports = {
    getTerritoryDifferenceKernelDiagnostics,
    initializeTerritoryDifferenceKernel,
    subtractTerritoryPolygonComponents
};
