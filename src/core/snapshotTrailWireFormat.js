const {
    roundToPrecision
} = require("./snapshotSerializationPrimitives");
const config = require("../config/gameConfig");

const FULL_TRAIL_UPDATE = 1;
const PATCH_TRAIL_UPDATE = 0;

/**
 * Schema-3 trail updates use positional arrays and delta-encoded point paths.
 *
 * Full:  [1, generation, color, partial, leftSegments, rightSegments, leftFill, rightFill]
 * Patch: [0, generation, partial, leftPatches, rightPatches,
 *         leftFillPoints, leftFillStart, rightFillPoints, rightFillStart]
 *
 * Empty collections use 0. A point path is [x, y, dx, dy, ...], rounded with
 * the same precision as the regular snapshot protocol.
 */
function compactTrailUpdate(update) {
    if (!update || typeof update !== "object") {
        return null;
    }

    const partial = compactPartialMetadata(update);

    if (update.full) {
        return [
            FULL_TRAIL_UPDATE,
            update.generation,
            update.color,
            partial,
            compactPackedSegments(update.leftSegments),
            compactPackedSegments(update.rightSegments),
            compactPackedPoints(update.leftFillPath),
            compactPackedPoints(update.rightFillPath)
        ];
    }

    return [
        PATCH_TRAIL_UPDATE,
        update.generation,
        partial,
        compactPatches(update.leftPatches),
        compactPatches(update.rightPatches),
        compactPackedPoints(update.leftFillPoints),
        integerOrNull(update.leftFillStart),
        compactPackedPoints(update.rightFillPoints),
        integerOrNull(update.rightFillStart)
    ];
}

function expandCompactTrailUpdate(compactUpdate) {
    if (!Array.isArray(compactUpdate)) {
        return compactUpdate && typeof compactUpdate === "object"
            ? compactUpdate
            : null;
    }

    if (compactUpdate[0] === FULL_TRAIL_UPDATE) {
        return expandFullTrailUpdate(compactUpdate);
    }

    if (compactUpdate[0] === PATCH_TRAIL_UPDATE) {
        return expandPatchTrailUpdate(compactUpdate);
    }

    return null;
}

function expandFullTrailUpdate(compactUpdate) {
    const leftSegments = expandCompactSegments(compactUpdate[4]);
    const rightSegments = expandCompactSegments(compactUpdate[5]);
    const leftFillPath = expandCompactPackedPoints(compactUpdate[6]);
    const rightFillPath = expandCompactPackedPoints(compactUpdate[7]);

    if (
        !Number.isSafeInteger(compactUpdate[1])
        || typeof compactUpdate[2] !== "string"
        || !leftSegments
        || !rightSegments
        || !leftFillPath
        || !rightFillPath
    ) {
        return null;
    }

    return {
        full: true,
        generation: compactUpdate[1],
        color: compactUpdate[2],
        ...expandPartialMetadata(compactUpdate[3]),
        leftSegments,
        rightSegments,
        leftFillPath,
        rightFillPath
    };
}

function expandPatchTrailUpdate(compactUpdate) {
    const leftPatches = expandCompactPatches(compactUpdate[3]);
    const rightPatches = expandCompactPatches(compactUpdate[4]);
    const leftFillPoints = expandCompactPackedPoints(compactUpdate[5]);
    const rightFillPoints = expandCompactPackedPoints(compactUpdate[7]);

    if (
        !Number.isSafeInteger(compactUpdate[1])
        || !leftPatches
        || !rightPatches
        || !leftFillPoints
        || !rightFillPoints
    ) {
        return null;
    }

    const update = {
        generation: compactUpdate[1],
        ...expandPartialMetadata(compactUpdate[2])
    };

    if (leftPatches.length > 0) {
        update.leftPatches = leftPatches;
    }

    if (rightPatches.length > 0) {
        update.rightPatches = rightPatches;
    }

    if (leftFillPoints.length > 0) {
        if (!Number.isSafeInteger(compactUpdate[6])) {
            return null;
        }
        update.leftFillPoints = leftFillPoints;
        update.leftFillStart = compactUpdate[6];
    }

    if (rightFillPoints.length > 0) {
        if (!Number.isSafeInteger(compactUpdate[8])) {
            return null;
        }
        update.rightFillPoints = rightFillPoints;
        update.rightFillStart = compactUpdate[8];
    }

    return update;
}

function compactPartialMetadata(update) {
    if (!update.partial) {
        return 0;
    }

    return [
        finiteOrNull(update.remainingPointCount),
        finiteOrNull(update.pointBudget)
    ];
}

function expandPartialMetadata(metadata) {
    if (!Array.isArray(metadata)) {
        return {};
    }

    return {
        partial: true,
        remainingPointCount: finiteOrNull(metadata[0]),
        pointBudget: finiteOrNull(metadata[1])
    };
}

function compactPackedSegments(segments) {
    if (!Array.isArray(segments) || segments.length === 0) {
        return 0;
    }

    return segments.map(compactPackedPoints);
}

function expandCompactSegments(compactSegments) {
    if (compactSegments === 0 || compactSegments === null || compactSegments === undefined) {
        return [];
    }

    if (!Array.isArray(compactSegments)) {
        return null;
    }

    const segments = [];

    for (const compactPoints of compactSegments) {
        const points = expandCompactPackedPoints(compactPoints);

        if (!points) {
            return null;
        }

        segments.push(points);
    }

    return segments;
}

function compactPatches(patches) {
    if (!Array.isArray(patches) || patches.length === 0) {
        return 0;
    }

    return patches.map(patch => [
        patch.index,
        patch.start,
        compactPackedPoints(patch.points)
    ]);
}

function expandCompactPatches(compactPatches) {
    if (compactPatches === 0 || compactPatches === null || compactPatches === undefined) {
        return [];
    }

    if (!Array.isArray(compactPatches)) {
        return null;
    }

    const patches = [];

    for (const patch of compactPatches) {
        if (
            !Array.isArray(patch)
            || !Number.isSafeInteger(patch[0])
            || !Number.isSafeInteger(patch[1])
        ) {
            return null;
        }

        const points = expandCompactPackedPoints(patch[2]);

        if (!points) {
            return null;
        }

        patches.push({
            index: patch[0],
            start: patch[1],
            points
        });
    }

    return patches;
}

function compactPackedPoints(points) {
    if (!Array.isArray(points) || points.length === 0) {
        return 0;
    }

    const compact = [];
    let previousX = 0;
    let previousY = 0;

    for (let index = 0; index < points.length; index++) {
        const point = points[index];

        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
            return 0;
        }

        const x = point[0];
        const y = point[1];

        if (index === 0) {
            compact.push(x, y);
        } else {
            compact.push(
                roundCoordinate(x - previousX),
                roundCoordinate(y - previousY)
            );
        }

        previousX = x;
        previousY = y;
    }

    return compact;
}

function expandCompactPackedPoints(compactPoints) {
    if (compactPoints === 0 || compactPoints === null || compactPoints === undefined) {
        return [];
    }

    if (!Array.isArray(compactPoints) || compactPoints.length % 2 !== 0) {
        return null;
    }

    const points = [];
    let x = 0;
    let y = 0;

    for (let index = 0; index < compactPoints.length; index += 2) {
        const first = compactPoints[index];
        const second = compactPoints[index + 1];

        if (!Number.isFinite(first) || !Number.isFinite(second)) {
            return null;
        }

        if (index === 0) {
            x = first;
            y = second;
        } else {
            x = roundCoordinate(x + first);
            y = roundCoordinate(y + second);
        }

        points.push([x, y]);
    }

    return points;
}

function roundCoordinate(value) {
    return roundToPrecision(value, config.network.coordinatePrecision);
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function integerOrNull(value) {
    return Number.isSafeInteger(value) ? value : null;
}

module.exports = {
    compactTrailUpdate,
    expandCompactTrailUpdate
};
