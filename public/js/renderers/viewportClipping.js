const epsilon = 1e-7;

export function clipPolygonRingsToBounds(rings, bounds) {
    if (!bounds) {
        return rings || [];
    }

    return (rings || [])
        .map(ring => clipPolygonToBounds(ring, bounds))
        .filter(ring => ring.length >= 3);
}

export function clipPolylineToBounds(points, bounds, options = {}) {
    if (!bounds) {
        const validPoints = getValidPoints(points);

        if (validPoints.length < 2) {
            return [];
        }

        return [options.closed ? validPoints.concat(validPoints[0]) : validPoints];
    }

    const validPoints = getValidPoints(points);

    if (validPoints.length < 2) {
        return [];
    }

    const segments = [];
    const segmentCount = options.closed ? validPoints.length : validPoints.length - 1;

    for (let index = 0; index < segmentCount; index++) {
        const start = validPoints[index];
        const end = validPoints[(index + 1) % validPoints.length];
        const clipped = clipLineSegmentToBounds(start, end, bounds);

        if (!clipped) {
            continue;
        }

        appendClippedSegment(segments, clipped);
    }

    return segments;
}

function clipPolygonToBounds(ring, bounds) {
    let output = getOpenRing(ring);

    if (output.length < 3) {
        return [];
    }

    output = clipPolygonAgainstEdge(
        output,
        point => point.x >= bounds.minX,
        (start, end) => intersectAtX(start, end, bounds.minX)
    );
    output = clipPolygonAgainstEdge(
        output,
        point => point.x <= bounds.maxX,
        (start, end) => intersectAtX(start, end, bounds.maxX)
    );
    output = clipPolygonAgainstEdge(
        output,
        point => point.y >= bounds.minY,
        (start, end) => intersectAtY(start, end, bounds.minY)
    );
    output = clipPolygonAgainstEdge(
        output,
        point => point.y <= bounds.maxY,
        (start, end) => intersectAtY(start, end, bounds.maxY)
    );

    return removeConsecutiveDuplicatePoints(output);
}

function clipPolygonAgainstEdge(points, isInside, intersect) {
    if (points.length === 0) {
        return [];
    }

    const output = [];

    for (let index = 0; index < points.length; index++) {
        const current = points[index];
        const previous = points[(index - 1 + points.length) % points.length];
        const currentInside = isInside(current);
        const previousInside = isInside(previous);

        if (currentInside) {
            if (!previousInside) {
                output.push(intersect(previous, current));
            }

            output.push(current);
            continue;
        }

        if (previousInside) {
            output.push(intersect(previous, current));
        }
    }

    return removeConsecutiveDuplicatePoints(output);
}

function clipLineSegmentToBounds(start, end, bounds) {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    let minT = 0;
    let maxT = 1;

    const clips = [
        { p: -deltaX, q: start.x - bounds.minX },
        { p: deltaX, q: bounds.maxX - start.x },
        { p: -deltaY, q: start.y - bounds.minY },
        { p: deltaY, q: bounds.maxY - start.y }
    ];

    for (const { p, q } of clips) {
        if (Math.abs(p) <= epsilon) {
            if (q < 0) {
                return null;
            }

            continue;
        }

        const t = q / p;

        if (p < 0) {
            minT = Math.max(minT, t);
        } else {
            maxT = Math.min(maxT, t);
        }

        if (minT - maxT > epsilon) {
            return null;
        }
    }

    return [
        interpolatePoint(start, deltaX, deltaY, minT),
        interpolatePoint(start, deltaX, deltaY, maxT)
    ];
}

function appendClippedSegment(segments, clipped) {
    const [start, end] = clipped;
    const current = segments[segments.length - 1];

    if (current && arePointsEqual(current[current.length - 1], start)) {
        current.push(end);
        return;
    }

    segments.push([start, end]);
}

function intersectAtX(start, end, x) {
    const deltaX = end.x - start.x;
    const t = Math.abs(deltaX) <= epsilon ? 0 : (x - start.x) / deltaX;

    return {
        x,
        y: start.y + (end.y - start.y) * clamp01(t)
    };
}

function intersectAtY(start, end, y) {
    const deltaY = end.y - start.y;
    const t = Math.abs(deltaY) <= epsilon ? 0 : (y - start.y) / deltaY;

    return {
        x: start.x + (end.x - start.x) * clamp01(t),
        y
    };
}

function interpolatePoint(start, deltaX, deltaY, t) {
    return {
        x: start.x + deltaX * t,
        y: start.y + deltaY * t
    };
}

function getOpenRing(ring) {
    const points = getValidPoints(ring);
    const lastIndex = points.length - 1;

    if (lastIndex > 0 && arePointsEqual(points[0], points[lastIndex])) {
        return points.slice(0, lastIndex);
    }

    return points;
}

function getValidPoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points.filter(point => (
        point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y)
    ));
}

function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= epsilon
        && Math.abs(first.y - second.y) <= epsilon;
}

function clamp01(value) {
    return Math.max(0, Math.min(value, 1));
}
