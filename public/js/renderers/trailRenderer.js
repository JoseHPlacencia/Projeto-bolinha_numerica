import {
    boundsOverlap,
<<<<<<< HEAD
    clipPolylineToBounds,
    clipRingsToBounds,
=======
>>>>>>> 70aca42 (teste)
    getPointsBounds,
    getRingsBounds
} from "./viewportCulling.js";

<<<<<<< HEAD
=======
const trailRenderCache = new WeakMap();

>>>>>>> 70aca42 (teste)
export function drawTrailLayer(context, state, gameConfig, viewportBounds) {
    const trails = state.trails || {};
    const players = state.players || {};

    for (const trail of Object.values(trails)) {
        drawTrail(context, trail, players[trail.id], gameConfig, viewportBounds);
    }
}

function drawTrail(context, trail, player, gameConfig, viewportBounds) {
    const lineWidth = gameConfig.territory.baseBorderWidth;
<<<<<<< HEAD
    const leftSegments = getTrailSegments(trail.leftSegments, viewportBounds, lineWidth);
    const rightSegments = getTrailSegments(trail.rightSegments, viewportBounds, lineWidth);
    const fillPolygon = getTrailFillPolygon(trail.fillPolygon, viewportBounds);
    const color = trail.color || (player && player.color);

    if (!color || (leftSegments.length === 0 && rightSegments.length === 0 && fillPolygon.rings.length === 0)) {
=======
    const preparedTrail = prepareTrailRenderData(trail);
    const color = trail.color || (player && player.color);

    if (!color || !boundsOverlap(preparedTrail.bounds, viewportBounds)) {
>>>>>>> 70aca42 (teste)
        return;
    }

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

<<<<<<< HEAD
    drawTrailFill(context, fillPolygon, color, gameConfig.territory.fillAlpha);
    drawTrailEdges(context, leftSegments, color, lineWidth);
    drawTrailEdges(context, rightSegments, color, lineWidth);
=======
    drawTrailFill(context, preparedTrail.fill, color, gameConfig.territory.fillAlpha, viewportBounds);
    drawTrailEdges(context, preparedTrail.left, color, lineWidth, viewportBounds);
    drawTrailEdges(context, preparedTrail.right, color, lineWidth, viewportBounds);
>>>>>>> 70aca42 (teste)

    context.restore();
}

<<<<<<< HEAD
function drawTrailFill(context, polygon, color, fillAlpha) {
    if (polygon.rings.length === 0) {
=======
function drawTrailFill(context, polygon, color, fillAlpha, viewportBounds) {
    if (!polygon || polygon.rings.length === 0 || !boundsOverlap(polygon.bounds, viewportBounds)) {
>>>>>>> 70aca42 (teste)
        return;
    }

    context.save();
    context.globalAlpha = fillAlpha;
    context.fillStyle = color;
<<<<<<< HEAD
    context.beginPath();

    for (const ring of polygon.rings) {
        traceRing(context, ring);
    }

    context.fill("evenodd");
    context.restore();
}

function drawTrailEdges(context, segments, color, lineWidth) {
    for (const segment of segments) {
        drawTrailEdge(context, segment, color, lineWidth);
    }
}

function drawTrailEdge(context, points, color, lineWidth) {
    if (points.length < 2) {
=======

    if (polygon.path) {
        context.fill(polygon.path, "evenodd");
    } else {
        context.beginPath();

        for (const ring of polygon.rings) {
            traceRing(context, ring);
        }

        context.fill("evenodd");
    }

    context.restore();
}

function drawTrailEdges(context, edge, color, lineWidth, viewportBounds) {
    if (!edge || edge.segments.length === 0 || !boundsOverlap(expandBounds(edge.bounds, lineWidth), viewportBounds)) {
>>>>>>> 70aca42 (teste)
        return;
    }

    context.save();
    context.globalAlpha = 1;
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
<<<<<<< HEAD
    strokeSmoothPath(context, points);
=======

    if (edge.path) {
        context.stroke(edge.path);
    } else {
        for (const segment of edge.segments) {
            strokeSmoothPath(context, segment);
        }
    }

>>>>>>> 70aca42 (teste)
    context.restore();
}

function strokeSmoothPath(context, points) {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);

    if (points.length === 2) {
        context.lineTo(points[1].x, points[1].y);
        context.stroke();
        return;
    }

    for (let index = 1; index < points.length - 1; index++) {
        const current = points[index];
        const next = points[index + 1];
<<<<<<< HEAD
        const midpoint = {
            x: (current.x + next.x) / 2,
            y: (current.y + next.y) / 2
        };

        context.quadraticCurveTo(current.x, current.y, midpoint.x, midpoint.y);
=======
        const midpointX = (current.x + next.x) / 2;
        const midpointY = (current.y + next.y) / 2;

        context.quadraticCurveTo(current.x, current.y, midpointX, midpointY);
>>>>>>> 70aca42 (teste)
    }

    const lastPoint = points[points.length - 1];
    context.lineTo(lastPoint.x, lastPoint.y);
    context.stroke();
}

function traceRing(context, ring) {
    if (ring.length < 3) {
        return;
    }

    context.moveTo(ring[0].x, ring[0].y);

    for (let index = 1; index < ring.length; index++) {
        context.lineTo(ring[index].x, ring[index].y);
    }

    context.closePath();
}

<<<<<<< HEAD
function getTrailSegments(segments, viewportBounds, margin) {
=======
function prepareTrailRenderData(trail) {
    const cached = trailRenderCache.get(trail);

    if (cached) {
        return cached;
    }

    const left = prepareTrailEdges(trail.leftSegments);
    const right = prepareTrailEdges(trail.rightSegments);
    const fill = prepareTrailFill(trail.fillPolygon);
    const prepared = {
        bounds: mergeBounds(mergeBounds(left.bounds, right.bounds), fill.bounds),
        fill,
        left,
        right
    };

    trailRenderCache.set(trail, prepared);

    return prepared;
}

function prepareTrailEdges(segments) {
    const validSegments = getValidSegments(segments);

    return {
        bounds: getSegmentsBounds(validSegments),
        path: createSmoothSegmentsPath(validSegments),
        segments: validSegments
    };
}

function getValidSegments(segments) {
>>>>>>> 70aca42 (teste)
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments
        .map(getValidPoints)
<<<<<<< HEAD
        .filter(segment => (
            segment.length >= 2
            && boundsOverlap(getPointsBounds(segment, margin), viewportBounds)
        ))
        .flatMap(segment => clipPolylineToBounds(segment, viewportBounds));
=======
        .filter(segment => segment.length >= 2);
}

function prepareTrailFill(polygon) {
    const rings = getValidPolygonRings(polygon);

    return {
        bounds: getRingsBounds(rings),
        path: createFillPath(rings),
        rings
    };
}

function getValidPolygonRings(polygon) {
    return polygon && Array.isArray(polygon.rings)
        ? polygon.rings.map(getValidPoints).filter(ring => ring.length >= 3)
        : [];
>>>>>>> 70aca42 (teste)
}

function getValidPoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points.filter(point => (
        Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
}

<<<<<<< HEAD
function getTrailFillPolygon(polygon, viewportBounds) {
    return getValidPolygon(polygon, viewportBounds);
}

function getValidPolygon(polygon, viewportBounds) {
    const rings = polygon && Array.isArray(polygon.rings)
        ? polygon.rings.map(getValidPoints).filter(ring => ring.length >= 3)
        : [];
    const bounds = getRingsBounds(rings);

    return {
        rings: boundsOverlap(bounds, viewportBounds)
            ? clipRingsToBounds(rings, viewportBounds)
            : []
=======
function getSegmentsBounds(segments) {
    let bounds = null;

    for (const segment of segments || []) {
        bounds = mergeBounds(bounds, getPointsBounds(segment));
    }

    return bounds;
}

function createFillPath(rings) {
    if (typeof Path2D !== "function" || rings.length === 0) {
        return null;
    }

    const path = new Path2D();

    for (const ring of rings) {
        traceRing(path, ring);
    }

    return path;
}

function createSmoothSegmentsPath(segments) {
    if (typeof Path2D !== "function" || segments.length === 0) {
        return null;
    }

    const path = new Path2D();

    for (const segment of segments) {
        traceSmoothPath(path, segment);
    }

    return path;
}

function traceSmoothPath(path, points) {
    if (points.length < 2) {
        return;
    }

    path.moveTo(points[0].x, points[0].y);

    if (points.length === 2) {
        path.lineTo(points[1].x, points[1].y);
        return;
    }

    for (let index = 1; index < points.length - 1; index++) {
        const current = points[index];
        const next = points[index + 1];
        const midpointX = (current.x + next.x) / 2;
        const midpointY = (current.y + next.y) / 2;

        path.quadraticCurveTo(current.x, current.y, midpointX, midpointY);
    }

    const lastPoint = points[points.length - 1];

    path.lineTo(lastPoint.x, lastPoint.y);
}

function expandBounds(bounds, margin) {
    if (!bounds) {
        return null;
    }

    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;

    return {
        minX: bounds.minX - safeMargin,
        minY: bounds.minY - safeMargin,
        maxX: bounds.maxX + safeMargin,
        maxY: bounds.maxY + safeMargin
    };
}

function mergeBounds(first, second) {
    if (!first) {
        return second;
    }

    if (!second) {
        return first;
    }

    return {
        minX: Math.min(first.minX, second.minX),
        minY: Math.min(first.minY, second.minY),
        maxX: Math.max(first.maxX, second.maxX),
        maxY: Math.max(first.maxY, second.maxY)
>>>>>>> 70aca42 (teste)
    };
}
