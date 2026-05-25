import {
    boundsOverlap,
    getRingsBounds
} from "./viewportCulling.js";

const territoryRenderCache = new WeakMap();

export function drawTerritoryLayer(context, state, gameConfig, viewportBounds) {
    const territories = Object.values(state.territories || {});
    const borderInset = getTerritoryBorderInset(gameConfig);
    const visibleShapes = getVisibleShapes(
        territories,
        viewportBounds,
        gameConfig.territory.baseBorderWidth + borderInset,
        borderInset
    );

    for (const shape of visibleShapes) {
        drawPolygonFill(context, shape, gameConfig.territory.fillAlpha);
    }

    for (const shape of visibleShapes) {
        drawTerritoryBorder(context, shape, gameConfig);
    }
}

function getVisibleShapes(territories, viewportBounds, margin, borderInset) {
    const shapes = [];

    for (const territory of territories) {
        if (!territory.color) {
            continue;
        }

        const preparedTerritory = prepareTerritoryRenderData(territory, borderInset);

        for (const shape of preparedTerritory.shapes) {
            if (!boundsOverlap(expandBounds(shape.bounds, margin), viewportBounds)) {
                continue;
            }

            shapes.push({
                ...shape,
                color: territory.color
            });
        }
    }

    return shapes;
}

function prepareTerritoryRenderData(territory, borderInset) {
    const cached = territoryRenderCache.get(territory);

    if (cached && cached.borderInset === borderInset) {
        return cached;
    }

    const shapes = [];

    for (const polygon of getTerritoryPolygons(territory)) {
        const rings = getPolygonRings(polygon);
        const bounds = getRingsBounds(rings);

        if (rings.length === 0 || !bounds) {
            continue;
        }

        const borderRings = createInsetRings(rings, borderInset);

        shapes.push({
            bounds,
            borderPath: createPath(borderRings),
            fillPath: createPath(rings),
            pointCount: getRingsPointCount(rings) + getRingsPointCount(borderRings)
        });
    }

    const prepared = {
        borderInset,
        shapes
    };

    territoryRenderCache.set(territory, prepared);

    return prepared;
}

function expandBounds(bounds, margin) {
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;

    if (!bounds) {
        return null;
    }

    return {
        minX: bounds.minX - safeMargin,
        minY: bounds.minY - safeMargin,
        maxX: bounds.maxX + safeMargin,
        maxY: bounds.maxY + safeMargin
    };
}

function drawPolygonFill(context, polygon, fillAlpha) {
    if (!polygon.fillPath || !polygon.color) {
        return;
    }

    context.save();
    context.globalAlpha = fillAlpha;
    context.fillStyle = polygon.color;
    context.fill(polygon.fillPath, "evenodd");
    context.restore();
}

function drawTerritoryBorder(context, polygon, gameConfig) {
    if (!polygon.borderPath || !polygon.color) {
        return;
    }

    context.save();
    context.globalAlpha = 1;
    context.lineWidth = gameConfig.territory.baseBorderWidth;
    context.strokeStyle = polygon.color;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke(polygon.borderPath);
    context.restore();
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

function createPath(rings) {
    if (typeof Path2D !== "function") {
        return null;
    }

    const path = new Path2D();

    for (const ring of rings) {
        traceRing(path, ring);
    }

    return path;
}

function traceRing(path, ring) {
    const points = getValidPoints(ring);

    if (points.length < 3) {
        return;
    }

    path.moveTo(points[0].x, points[0].y);

    for (let index = 1; index < points.length; index++) {
        path.lineTo(points[index].x, points[index].y);
    }

    path.closePath();
}

function getRingsPointCount(rings) {
    return (rings || []).reduce((sum, ring) => sum + ring.length, 0);
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
