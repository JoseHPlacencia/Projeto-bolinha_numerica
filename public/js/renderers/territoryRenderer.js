export function drawTerritoryLayer(context, state, gameConfig) {
    const territories = Object.values(state.territories || {});
    const orderedPolygons = getOrderedPolygons(territories);

    for (const polygon of orderedPolygons) {
        drawPolygonFill(context, polygon, gameConfig.territory.fillAlpha);
    }

    for (const territory of territories) {
        drawTerritoryBorder(context, territory, gameConfig);
    }
}

function getOrderedPolygons(territories) {
    return territories.flatMap(territory => (
        getTerritoryPolygons(territory).map((polygon, index) => ({
            ...polygon,
            color: territory.color,
            order: index
        }))
    ));
}

function drawPolygonFill(context, polygon, fillAlpha) {
    const rings = getPolygonRings(polygon);

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

function drawTerritoryBorder(context, territory, gameConfig) {
    const polygons = getTerritoryPolygons(territory);

    if (polygons.length === 0 || !territory.color) {
        return;
    }

    context.save();
    context.globalAlpha = 1;
    context.lineWidth = gameConfig.territory.baseBorderWidth;
    context.strokeStyle = territory.color;
    context.lineJoin = "round";
    context.lineCap = "round";

    for (const polygon of polygons) {
        const rings = getPolygonRings(polygon);

        for (const ring of rings) {
            strokeRing(context, ring);
        }
    }

    context.restore();
}

function createPolygonPath(context, rings) {
    context.beginPath();

    for (const ring of rings) {
        traceRing(context, ring);
    }
}

function strokeRing(context, ring) {
    if (ring.length < 3) {
        return;
    }

    context.beginPath();
    traceRing(context, ring);
    context.stroke();
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
