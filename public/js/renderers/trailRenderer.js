export function drawTrailLayer(context, state, gameConfig) {
    const trails = state.trails || {};
    const players = state.players || {};

    for (const trail of Object.values(trails)) {
        drawTrail(context, trail, players[trail.id], gameConfig);
    }
}

function drawTrail(context, trail, player, gameConfig) {
    const points = getTrailPoints(trail);
    const leftPoints = getSidePoints(trail.leftPoints);
    const rightPoints = getSidePoints(trail.rightPoints);

    if (points.length < 2) {
        return;
    }

    const color = trail.color || (player && player.color);

    if (!color) {
        return;
    }

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    if (leftPoints.length >= 2 && rightPoints.length >= 2) {
        drawTrailPolygonFill(context, leftPoints, rightPoints, color, gameConfig.territory.fillAlpha);
        drawTrailEdge(context, leftPoints, color, gameConfig.territory.baseBorderWidth);
        drawTrailEdge(context, rightPoints, color, gameConfig.territory.baseBorderWidth);
    } else {
        const edgePaths = createTrailEdgePaths(points, gameConfig.world.playerSize / 2);

        drawTrailFill(context, points, color, gameConfig);
        drawTrailEdge(context, edgePaths.left, color, gameConfig.territory.baseBorderWidth);
        drawTrailEdge(context, edgePaths.right, color, gameConfig.territory.baseBorderWidth);
    }

    context.restore();
}

function drawTrailPolygonFill(context, leftPoints, rightPoints, color, fillAlpha) {
    const polygonPoints = leftPoints.concat([...rightPoints].reverse());

    context.save();
    context.globalAlpha = fillAlpha;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(polygonPoints[0].x, polygonPoints[0].y);

    for (let index = 1; index < polygonPoints.length; index++) {
        context.lineTo(polygonPoints[index].x, polygonPoints[index].y);
    }

    context.closePath();
    context.fill();
    context.restore();
}

function drawTrailFill(context, points, color, gameConfig) {
    context.save();
    context.globalAlpha = gameConfig.territory.fillAlpha;
    context.strokeStyle = color;
    context.lineWidth = gameConfig.world.playerSize;
    strokeSmoothPath(context, points);
    context.restore();
}

function drawTrailEdge(context, points, color, lineWidth) {
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

function createTrailEdgePaths(points, halfWidth) {
    const left = [];
    const right = [];

    for (let index = 0; index < points.length; index++) {
        const normal = getTrailNormal(points, index);
        const point = points[index];

        left.push({
            x: point.x + normal.x * halfWidth,
            y: point.y + normal.y * halfWidth
        });
        right.push({
            x: point.x - normal.x * halfWidth,
            y: point.y - normal.y * halfWidth
        });
    }

    return { left, right };
}

function getTrailNormal(points, index) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const directionX = next.x - previous.x;
    const directionY = next.y - previous.y;
    const length = Math.hypot(directionX, directionY);

    if (length <= Number.EPSILON) {
        return { x: 0, y: -1 };
    }

    return {
        x: -directionY / length,
        y: directionX / length
    };
}

function getTrailPoints(trail) {
    if (!Array.isArray(trail.points)) {
        return [];
    }

    return trail.points.filter(point => (
        Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
}

function getSidePoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points.filter(point => (
        Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
}
