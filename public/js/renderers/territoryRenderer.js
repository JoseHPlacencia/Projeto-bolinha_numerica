import {
    boundsOverlap,
    clipClosedRingStrokeToBounds,
    clipRingsToBounds,
    getRingsBounds
} from "./viewportCulling.js";

export function drawTerritoryLayer(context, state, gameConfig, viewportBounds) {
    const territories = Object.values(state.territories || {});
    const borderInset = getTerritoryBorderInset(gameConfig);
    const visiblePolygons = getVisiblePolygons(
        territories,
        viewportBounds,
        gameConfig.territory.baseBorderWidth + borderInset,
        borderInset
    );

    for (const polygon of visiblePolygons) {
        drawPolygonFill(context, polygon, gameConfig.territory.fillAlpha);
    }

    for (const polygon of visiblePolygons) {
        drawTerritoryBorder(context, polygon, gameConfig);
    }
}

function getVisiblePolygons(territories, viewportBounds, margin, borderInset) {
    const polygons = [];

    for (const territory of territories) {
        if (!territory.color) {
            continue;
        }

        for (const polygon of getTerritoryPolygons(territory)) {
            const rings = getPolygonRings(polygon);
            const bounds = getRingsBounds(rings, margin);

            if (rings.length === 0 || !boundsOverlap(bounds, viewportBounds)) {
                continue;
            }

            const fillRings = clipRingsToBounds(rings, viewportBounds);
            const borderRings = createInsetRings(rings, borderInset);
            const borderSegments = borderRings.flatMap(ring => clipClosedRingStrokeToBounds(ring, viewportBounds));

            if (fillRings.length === 0 && borderSegments.length === 0) {
                continue;
            }

            polygons.push({
                borderSegments,
                fillRings,
                color: territory.color
            });
        }
    }

    return polygons;
}

function drawPolygonFill(context, polygon, fillAlpha) {
    const rings = polygon.fillRings;

    if (rings.length === 0 || !polygon.color) {
        return;
    }

    context.save();
    context.globalAlpha = fillAlpha;
    context.fillStyle = polygon.color;
    createPolygonPath(context, rings);
    context.fill("evenodd");
    context.restore();
}

function drawTerritoryBorder(context, polygon, gameConfig) {
    if (polygon.borderSegments.length === 0 || !polygon.color) {
        return;
    }

    context.save();
    context.globalAlpha = 1;
    context.lineWidth = gameConfig.territory.baseBorderWidth;
    context.strokeStyle = polygon.color;
    context.lineJoin = "round";
    context.lineCap = "round";

    for (const segment of polygon.borderSegments) {
        strokeSegment(context, segment);
    }

    context.restore();
}

function strokeSegment(context, points) {
    if (points.length < 2) {
        return;
    }

    context.beginPath();
    context.moveTo(points[0].x, points[0].y);

    for (let index = 1; index < points.length; index++) {
        context.lineTo(points[index].x, points[index].y);
    }

    context.stroke();
}

function createInsetRings(rings, inset) {
    if (!Number.isFinite(inset) || inset <= 0) {
        return rings;
    }

    return rings
        .map((ring, index) => createInsetRing(ring, index === 0 ? inset : -inset))
        .filter(ring => ring.length >= 3);
}

function createInsetRing(ring, inset) {
    const points = getOpenRing(ring);
    const center = getRingCentroid(points);

    if (!center) {
        return ring;
    }

    return points.map(point => movePointTowardCenter(point, center, inset));
}

function movePointTowardCenter(point, center, inset) {
    const deltaX = point.x - center.x;
    const deltaY = point.y - center.y;
    const distance = Math.hypot(deltaX, deltaY);

    if (distance <= Number.EPSILON) {
        return { ...point };
    }

    const nextDistance = Math.max(0, distance - inset);
    const scale = nextDistance / distance;

    return {
        x: center.x + deltaX * scale,
        y: center.y + deltaY * scale
    };
}

function getRingCentroid(points) {
    if (!Array.isArray(points) || points.length < 3) {
        return null;
    }

    let twiceArea = 0;
    let x = 0;
    let y = 0;

    for (let index = 0; index < points.length; index++) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        const cross = current.x * next.y - next.x * current.y;

        twiceArea += cross;
        x += (current.x + next.x) * cross;
        y += (current.y + next.y) * cross;
    }

    if (Math.abs(twiceArea) <= Number.EPSILON) {
        return getPointsCenter(points);
    }

    return {
        x: x / (3 * twiceArea),
        y: y / (3 * twiceArea)
    };
}

function getPointsCenter(points) {
    let x = 0;
    let y = 0;

    for (const point of points) {
        x += point.x;
        y += point.y;
    }

    return {
        x: x / points.length,
        y: y / points.length
    };
}

function createPolygonPath(context, rings) {
    context.beginPath();

    for (const ring of rings) {
        traceRing(context, ring);
    }
}

function traceRing(context, ring) {
    const points = getValidPoints(ring);

    if (points.length < 3) {
        return;
    }

    context.moveTo(points[0].x, points[0].y);

    for (let index = 1; index < points.length; index++) {
        context.lineTo(points[index].x, points[index].y);
    }

    context.closePath();
}

function getOpenRing(ring) {
    const points = getValidPoints(ring);
    const lastIndex = points.length - 1;

    if (lastIndex > 0 && arePointsEqual(points[0], points[lastIndex])) {
        return points.slice(0, lastIndex);
    }

    return points;
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= Number.EPSILON
        && Math.abs(first.y - second.y) <= Number.EPSILON;
}

function getTerritoryBorderInset(gameConfig) {
    const inset = Number(gameConfig.territory.baseBorderInset);

    return Number.isFinite(inset) ? Math.max(0, inset) : 0;
}

function getTerritoryPolygons(territory) {
    if (territory.polygon && Array.isArray(territory.polygon.rings)) {
        return [territory.polygon];
    }

    if (!Array.isArray(territory.polygons)) {
        return [];
    }

    return territory.polygons;
}

function getPolygonRings(polygon) {
    if (!Array.isArray(polygon.rings)) {
        return [];
    }

    return polygon.rings
        .map(getValidPoints)
        .filter(ring => ring.length >= 3);
}

function getValidPoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points.filter(point => (
        Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
}
