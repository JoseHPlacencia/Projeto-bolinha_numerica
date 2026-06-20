import {
    boundsOverlap,
    getPointsBounds,
    getRingsBounds
} from "./viewportCulling.js";
import {
    clipPolygonRingsToBounds,
    clipPolylineToBounds
} from "./viewportClipping.js";
import {
    isDarkVisualTheme
} from "../visualTheme.js";
import { isPerformanceMode } from "../renderSettings.js";

const trailRenderCache = new WeakMap();
const trailSegmentRenderCache = new WeakMap();

export function drawTrailLayer(context, state, gameConfig, viewportBounds) {
    const trails = state.trails || {};
    const players = state.players || {};

    for (const trail of Object.values(trails)) {
        drawTrail(context, trail, players[trail.id], gameConfig, viewportBounds);
    }
}

function drawTrail(context, trail, player, gameConfig, viewportBounds) {
    const lineWidth = gameConfig.territory.baseBorderWidth;
    const preparedTrail = prepareTrailRenderData(trail);
    const color = trail.color || (player && player.color);

    if (!color || !boundsOverlap(preparedTrail.bounds, viewportBounds)) {
        return;
    }

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    drawTrailFill(context, preparedTrail.fill, color, gameConfig.territory.fillAlpha, viewportBounds);
    drawTrailEdges(context, preparedTrail.left, color, lineWidth, viewportBounds, gameConfig);
    drawTrailEdges(context, preparedTrail.right, color, lineWidth, viewportBounds, gameConfig);

    context.restore();
}

function drawTrailFill(context, polygon, color, fillAlpha, viewportBounds) {
    if (!polygon || polygon.rings.length === 0 || !boundsOverlap(polygon.bounds, viewportBounds)) {
        return;
    }

    const rings = viewportBounds
        ? clipPolygonRingsToBounds(polygon.rings, viewportBounds)
        : polygon.rings;

    if (rings.length === 0) {
        return;
    }

    context.save();
    context.globalAlpha = fillAlpha;
    context.fillStyle = color;

    if (!viewportBounds && polygon.path) {
        context.fill(polygon.path, "evenodd");
    } else {
        const path = createFillPath(rings);

        if (path) {
            context.fill(path, "evenodd");
            context.restore();
            return;
        }

        context.beginPath();

        for (const ring of rings) {
            traceRing(context, ring);
        }

        context.fill("evenodd");
    }

    context.restore();
}

function drawTrailEdges(context, edge, color, lineWidth, viewportBounds, gameConfig) {
    if (!edge || edge.segments.length === 0 || !boundsOverlap(expandBounds(edge.bounds, lineWidth), viewportBounds)) {
        return;
    }

    const segments = viewportBounds
        ? clipTrailSegmentsToViewport(edge.segments, viewportBounds, lineWidth)
        : edge.segments.map(segment => segment.points);

    if (segments.length === 0) {
        return;
    }

    context.save();
    context.globalAlpha = 1;
    context.strokeStyle = color;
    const darkTheme = isDarkVisualTheme(gameConfig);
    const performanceMode = isPerformanceMode(gameConfig);
    context.lineWidth = darkTheme && performanceMode ? lineWidth * 2.8 : lineWidth;

    if (darkTheme) {
        context.globalAlpha = performanceMode ? 0.24 : 0.46;

        if (!performanceMode) {
            context.lineWidth = lineWidth * 1.25;
            context.shadowColor = color;
            context.shadowBlur = 18;
        }

        strokeTrail(context, edge, segments, viewportBounds);

        if (!performanceMode) {
            context.shadowColor = "transparent";
            context.shadowBlur = 0;
        }

        context.globalAlpha = 1;
        context.lineWidth = lineWidth;
    }

    strokeTrail(context, edge, segments, viewportBounds);
    context.restore();
}

function strokeTrail(context, edge, segments, viewportBounds) {
    if (!viewportBounds && edge.path) {
        context.stroke(edge.path);
        return;
    }

    const path = createSmoothSegmentsPath(segments);

    if (path) {
        context.stroke(path);
        return;
    }

    for (const segment of segments) {
        strokeSmoothPath(context, segment);
    }
}

function clipTrailSegmentsToViewport(segments, viewportBounds, lineWidth) {
    const clipBounds = expandBounds(viewportBounds, lineWidth);
    const clippedSegments = [];

    for (const segment of segments) {
        if (!boundsOverlap(expandBounds(segment.bounds, lineWidth), viewportBounds)) {
            continue;
        }

        clippedSegments.push(...clipPolylineToBounds(segment.points, clipBounds));
    }

    return clippedSegments.filter(segment => segment.length >= 2);
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
        const midpointX = (current.x + next.x) / 2;
        const midpointY = (current.y + next.y) / 2;

        context.quadraticCurveTo(current.x, current.y, midpointX, midpointY);
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
    const validSegments = getPreparedSegments(segments);

    return {
        bounds: getPreparedSegmentsBounds(validSegments),
        path: createSmoothSegmentsPath(validSegments.map(segment => segment.points)),
        segments: validSegments
    };
}

function getPreparedSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments
        .map(prepareTrailSegment)
        .filter(Boolean);
}

function prepareTrailSegment(segment) {
    const cached = trailSegmentRenderCache.get(segment);

    if (cached) {
        return cached;
    }

    const points = getValidPoints(segment);

    if (points.length < 2) {
        return null;
    }

    const prepared = {
        bounds: getPointsBounds(points),
        points
    };

    trailSegmentRenderCache.set(segment, prepared);

    return prepared;
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
}

function getValidPoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points.filter(point => (
        Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
}

function getPreparedSegmentsBounds(segments) {
    let bounds = null;

    for (const segment of segments || []) {
        bounds = mergeBounds(bounds, segment.bounds);
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
    };
}
