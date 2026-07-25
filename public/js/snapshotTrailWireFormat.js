export function expandCompactTrailUpdate(compactUpdate, coordinatePrecision = 10) {
    if (!Array.isArray(compactUpdate)) {
        return compactUpdate && typeof compactUpdate === "object"
            ? compactUpdate
            : null;
    }

    if (compactUpdate[0] === 1) {
        return expandCompactFullTrailUpdate(compactUpdate, coordinatePrecision);
    }

    if (compactUpdate[0] === 0) {
        return expandCompactPatchTrailUpdate(compactUpdate, coordinatePrecision);
    }

    return null;
}

function expandCompactFullTrailUpdate(compactUpdate, coordinatePrecision) {
    const leftSegments = expandCompactTrailSegments(compactUpdate[4], coordinatePrecision);
    const rightSegments = expandCompactTrailSegments(compactUpdate[5], coordinatePrecision);
    const leftFillPath = expandCompactTrailPoints(compactUpdate[6], coordinatePrecision);
    const rightFillPath = expandCompactTrailPoints(compactUpdate[7], coordinatePrecision);

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
        ...expandCompactTrailPartialMetadata(compactUpdate[3]),
        leftSegments,
        rightSegments,
        leftFillPath,
        rightFillPath
    };
}

function expandCompactPatchTrailUpdate(compactUpdate, coordinatePrecision) {
    const leftPatches = expandCompactTrailPatches(compactUpdate[3], coordinatePrecision);
    const rightPatches = expandCompactTrailPatches(compactUpdate[4], coordinatePrecision);
    const leftFillPoints = expandCompactTrailPoints(compactUpdate[5], coordinatePrecision);
    const rightFillPoints = expandCompactTrailPoints(compactUpdate[7], coordinatePrecision);

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
        ...expandCompactTrailPartialMetadata(compactUpdate[2])
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

function expandCompactTrailPartialMetadata(metadata) {
    if (!Array.isArray(metadata)) {
        return {};
    }

    return {
        partial: true,
        remainingPointCount: Number.isFinite(metadata[0]) ? metadata[0] : null,
        pointBudget: Number.isFinite(metadata[1]) ? metadata[1] : null
    };
}

function expandCompactTrailSegments(compactSegments, coordinatePrecision) {
    if (isEmptyCompactTrailCollection(compactSegments)) {
        return [];
    }

    if (!Array.isArray(compactSegments)) {
        return null;
    }

    const segments = [];

    for (const compactPoints of compactSegments) {
        const points = expandCompactTrailPoints(compactPoints, coordinatePrecision);

        if (!points) {
            return null;
        }

        segments.push(points);
    }

    return segments;
}

function expandCompactTrailPatches(compactPatches, coordinatePrecision) {
    if (isEmptyCompactTrailCollection(compactPatches)) {
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

        const points = expandCompactTrailPoints(patch[2], coordinatePrecision);

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

function expandCompactTrailPoints(compactPoints, coordinatePrecision) {
    if (isEmptyCompactTrailCollection(compactPoints)) {
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
            x = roundCompactTrailCoordinate(x + first, coordinatePrecision);
            y = roundCompactTrailCoordinate(y + second, coordinatePrecision);
        }

        points.push([x, y]);
    }

    return points;
}

function isEmptyCompactTrailCollection(value) {
    return value === 0 || value === null || value === undefined;
}

function roundCompactTrailCoordinate(value, coordinatePrecision) {
    const precision = Number.isFinite(coordinatePrecision) && coordinatePrecision > 0
        ? coordinatePrecision
        : 10;

    return Math.round(value * precision) / precision;
}
