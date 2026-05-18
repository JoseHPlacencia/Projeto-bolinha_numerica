export function drawTrailLayer(context, state, gameConfig) {
    const trails = state.trails || {};
    const players = state.players || {};

    for (const trail of Object.values(trails)) {
        drawTrail(context, trail, players[trail.id], gameConfig);
    }
}

function drawTrail(context, trail, player, gameConfig) {
    const leftSegments = getTrailSegments(trail.leftSegments);
    const rightSegments = getTrailSegments(trail.rightSegments);
    const fillPolygon = getTrailFillPolygon(trail.fillPolygon);
    const color = trail.color || (player && player.color);

    if (!color || (leftSegments.length === 0 && rightSegments.length === 0 && fillPolygon.rings.length === 0)) {
        return;
    }

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    drawTrailFill(context, fillPolygon, color, gameConfig.territory.fillAlpha);
    drawTrailEdges(context, leftSegments, color, gameConfig.territory.baseBorderWidth);
    drawTrailEdges(context, rightSegments, color, gameConfig.territory.baseBorderWidth);

    context.restore();
}

function drawTrailFill(context, polygon, color, fillAlpha) {
    if (polygon.rings.length === 0) {
        return;
    }

    context.save();
    context.globalAlpha = fillAlpha;
    context.fillStyle = color;
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
        return;
    }

    context.save();
    context.globalAlpha = 1;
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    strokeSmoothPath(context, points);
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
        const midpoint = {
            x: (current.x + next.x) / 2,
            y: (current.y + next.y) / 2
        };

        context.quadraticCurveTo(current.x, current.y, midpoint.x, midpoint.y);
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

function getTrailSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments
        .map(getValidPoints)
        .filter(segment => segment.length >= 2);
}

function getValidPoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points.filter(point => (
        Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
}

function getTrailFillPolygon(polygon) {
    return getValidPolygon(polygon);
}

function getValidPolygon(polygon) {
    const rings = polygon && Array.isArray(polygon.rings)
        ? polygon.rings.map(getValidPoints).filter(ring => ring.length >= 3)
        : [];

    return { rings };
}
