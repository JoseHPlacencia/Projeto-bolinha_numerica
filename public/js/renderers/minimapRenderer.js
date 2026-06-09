export function createMinimapRenderer(canvas, gameConfig) {
    const context = canvas.getContext("2d");
    const settings = getMinimapSettings(gameConfig);
    let territoryPathCache = new WeakMap();
    let trailPathCache = new WeakMap();
    let displaySize = settings.size;
    let pixelRatio = 1;

    return {
        clear,
        render,
        resizeCanvas
    };

    function resizeCanvas() {
        displaySize = getResponsiveCanvasSize();
        pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.round(displaySize * pixelRatio);
        canvas.height = Math.round(displaySize * pixelRatio);
        canvas.style.width = `${displaySize}px`;
        canvas.style.height = `${displaySize}px`;
        territoryPathCache = new WeakMap();
        trailPathCache = new WeakMap();
    }

    function render(state, currentPlayerId) {
        clear();
        applyCanvasTransform();
        drawMapBackground();

        const player = state && currentPlayerId ? state.players[currentPlayerId] : null;

        if (!player) {
            drawMapBorder();
            return;
        }

        const territory = state.territories && state.territories[currentPlayerId];
        const trail = state.trails && state.trails[currentPlayerId];

        context.save();
        clipToMapBoundary();

        if (territory) {
            drawTerritory(territory);
        }

        if (trail) {
            drawTrail(trail, player);
        }

        drawPlayerIcon(player, territory ? territory.color : player.color);
        context.restore();
        drawMapBorder();
    }

    function clear() {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
    }

    function applyCanvasTransform() {
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }

    function drawMapBackground() {
        const circle = getMapCircle();

        context.save();
        context.beginPath();
        context.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2);
        context.fillStyle = "rgba(8, 12, 18, 0.72)";
        context.fill();
        context.restore();
    }

    function drawMapBorder() {
        const circle = getMapBorderCircle();

        context.save();
        context.beginPath();
        context.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2);
        context.strokeStyle = "rgba(255, 255, 255, 0.24)";
        context.lineWidth = settings.mapBorderWidth;
        context.stroke();
        context.restore();
    }

    function clipToMapBoundary() {
        const circle = getMapCircle();

        context.beginPath();
        context.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2);
        context.clip();
    }

    function drawTerritory(territory) {
        const path = getTerritoryPath(territory);

        if (!path || !territory.color) {
            return;
        }

        context.save();
        context.fillStyle = territory.color;
        context.globalAlpha = gameConfig.territory.fillAlpha;
        context.fill(path, "evenodd");
        context.restore();

        context.save();
        context.strokeStyle = territory.color;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = settings.territoryBorderWidth;
        context.stroke(path);
        context.restore();
    }

    function getTerritoryPath(territory) {
        const cached = territoryPathCache.get(territory);

        if (cached && cached.displaySize === displaySize) {
            return cached.path;
        }

        const path = createMinimapPolygonPath(getPolygonRings(territory));

        territoryPathCache.set(territory, {
            displaySize,
            path
        });

        return path;
    }

    function createMinimapPolygonPath(rings) {
        if (typeof Path2D !== "function") {
            return null;
        }

        const path = new Path2D();

        for (const ring of rings) {
            traceRingPath(path, ring);
        }

        return path;
    }

    function drawTrail(trail, player) {
        const preparedTrail = getTrailPath(trail);
        const color = trail.color || (player && player.color);

        if (!color) {
            return;
        }

        drawTrailFill(preparedTrail.fill, color);
        drawTrailEdges(preparedTrail.left, color);
        drawTrailEdges(preparedTrail.right, color);
    }

    function getTrailPath(trail) {
        const cached = trailPathCache.get(trail);

        if (cached && cached.displaySize === displaySize) {
            return cached;
        }

        const prepared = {
            displaySize,
            fill: prepareTrailFill(trail.fillPolygon),
            left: prepareTrailEdges(trail.leftSegments),
            right: prepareTrailEdges(trail.rightSegments)
        };

        trailPathCache.set(trail, prepared);

        return prepared;
    }

    function prepareTrailFill(fillPolygon) {
        const rings = getPolygonRings(fillPolygon);

        return {
            path: createMinimapPolygonPath(rings),
            rings
        };
    }

    function prepareTrailEdges(segments) {
        const validSegments = getTrailSegments(segments);

        return {
            path: createMinimapTrailPath(validSegments),
            segments: validSegments
        };
    }

    function drawTrailFill(fill, color) {
        if (!fill || fill.rings.length === 0) {
            return;
        }

        context.save();
        context.fillStyle = color;
        context.globalAlpha = gameConfig.territory.fillAlpha;

        if (fill.path) {
            context.fill(fill.path, "evenodd");
        } else {
            context.beginPath();

            for (const ring of fill.rings) {
                traceRing(ring);
            }

            context.fill("evenodd");
        }

        context.restore();
    }

    function drawTrailEdges(edge, color) {
        if (!edge || edge.segments.length === 0) {
            return;
        }

        context.save();
        context.strokeStyle = color;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = settings.trailBorderWidth;

        if (edge.path) {
            context.stroke(edge.path);
        } else {
            for (const segment of edge.segments) {
                strokeTrailSegment(segment);
            }
        }

        context.restore();
    }

    function drawPlayerIcon(player, color) {
        const position = clampIconPosition(worldToMinimap(player), player);
        const size = settings.playerIconSize;
        const playerSize = getPlayerWorldSize();
        const scale = size / playerSize;

        context.save();
        context.translate(position.x, position.y);
        context.rotate(Number.isFinite(player.angle) ? player.angle : 0);
        context.scale(scale, scale);

        context.fillStyle = "rgba(0,0,0,.18)";
        context.fillRect(-30, -30, playerSize, playerSize);

        context.fillStyle = color || player.color || "#f5f7fb";
        context.fillRect(-35, -35, playerSize, playerSize);

        context.lineWidth = settings.playerIconBorderWidth / scale;
        context.strokeStyle = "#000";
        context.strokeRect(-35, -35, playerSize, playerSize);
        context.restore();
    }

    function traceRing(ring) {
        const points = ring.map(worldToMinimap).filter(isValidPoint);

        if (points.length < 3) {
            return;
        }

        context.moveTo(points[0].x, points[0].y);

        for (let index = 1; index < points.length; index++) {
            context.lineTo(points[index].x, points[index].y);
        }

        context.closePath();
    }

    function traceRingPath(path, ring) {
        const points = ring.map(worldToMinimap).filter(isValidPoint);

        if (points.length < 3) {
            return;
        }

        path.moveTo(points[0].x, points[0].y);

        for (let index = 1; index < points.length; index++) {
            path.lineTo(points[index].x, points[index].y);
        }

        path.closePath();
    }

    function strokeTrailSegment(segment) {
        if (!Array.isArray(segment) || segment.length < 2) {
            return;
        }

        strokeSmoothPath(segment);
    }

    function strokeSmoothPath(points) {
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

    function worldToMinimap(point) {
        const mapRadius = Math.max(1, gameConfig.world.mapRadius);
        const circle = getMapCircle();
        const scale = circle.radius / mapRadius;

        return {
            x: circle.x + point.x * scale,
            y: circle.y + point.y * scale
        };
    }

    function getTrailSegments(segments) {
        if (!Array.isArray(segments)) {
            return [];
        }

        return segments
            .map(segment => segment.map(worldToMinimap).filter(isValidPoint))
            .filter(segment => segment.length >= 2);
    }

    function createMinimapTrailPath(segments) {
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

    function clampIconPosition(point, player) {
        const circle = getMapCircle();
        const dx = point.x - circle.x;
        const dy = point.y - circle.y;
        const distance = Math.hypot(dx, dy);
        const iconRadialExtent = getPlayerIconRadialExtent(dx, dy, player);
        const maxDistance = Math.max(0, circle.radius - iconRadialExtent);

        if (distance <= maxDistance || distance <= Number.EPSILON) {
            return point;
        }

        const scale = maxDistance / distance;

        return {
            x: circle.x + dx * scale,
            y: circle.y + dy * scale
        };
    }

    function getPlayerIconRadialExtent(dx, dy, player) {
        const distance = Math.hypot(dx, dy);
        const halfSize = settings.playerIconSize / 2;

        if (distance <= Number.EPSILON) {
            return halfSize + settings.playerIconBorderWidth / 2;
        }

        const angle = Number.isFinite(player.angle) ? player.angle : 0;
        const radialX = dx / distance;
        const radialY = dy / distance;
        const localXAxis = {
            x: Math.cos(angle),
            y: Math.sin(angle)
        };
        const localYAxis = {
            x: -Math.sin(angle),
            y: Math.cos(angle)
        };
        const xProjection = Math.abs(radialX * localXAxis.x + radialY * localXAxis.y);
        const yProjection = Math.abs(radialX * localYAxis.x + radialY * localYAxis.y);

        return halfSize * (xProjection + yProjection) + settings.playerIconBorderWidth / 2;
    }

    function getPlayerWorldSize() {
        return Math.max(1, getFiniteNumber(gameConfig.world.playerSize, 70));
    }

    function getResponsiveCanvasSize() {
        const viewportWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 0;
        const viewportHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
        const viewportSize = Math.min(
            viewportWidth || settings.size,
            viewportHeight || settings.size
        );
        const maxSize = Math.max(1, settings.size);
        const minSize = Math.min(getFiniteNumber(settings.minSize, 96), maxSize);
        const responsiveSize = viewportSize * settings.viewportSizeRatio;

        return Math.round(clamp(responsiveSize, minSize, maxSize));
    }

    function getMapCircle() {
        const center = displaySize / 2;

        return {
            x: center,
            y: center,
            radius: Math.max(0, center - settings.mapBorderWidth)
        };
    }

    function getMapBorderCircle() {
        const circle = getMapCircle();

        return {
            x: circle.x,
            y: circle.y,
            radius: circle.radius + settings.mapBorderWidth / 2
        };
    }
}

function getMinimapSettings(gameConfig) {
    const minimap = gameConfig.minimap || {};
    const playerIconRadius = getFiniteNumber(minimap.playerIconRadius, 6);

    return {
        mapBorderWidth: getFiniteNumber(minimap.mapBorderWidth, 3),
        minSize: getFiniteNumber(minimap.minSize, 96),
        playerIconBorderWidth: getFiniteNumber(minimap.playerIconBorderWidth, 2),
        playerIconSize: getFiniteNumber(minimap.playerIconSize, playerIconRadius * 2),
        size: getFiniteNumber(minimap.size, 156),
        territoryBorderWidth: getFiniteNumber(minimap.territoryBorderWidth, 2),
        trailBorderWidth: getFiniteNumber(minimap.trailBorderWidth, 2),
        viewportSizeRatio: getFiniteNumber(minimap.viewportSizeRatio, 0.28)
    };
}

function getPolygonRings(polygonLike) {
    if (!polygonLike) {
        return [];
    }

    if (polygonLike.polygon && Array.isArray(polygonLike.polygon.rings)) {
        return polygonLike.polygon.rings;
    }

    if (Array.isArray(polygonLike.polygon)) {
        return [polygonLike.polygon];
    }

    if (Array.isArray(polygonLike.rings)) {
        return polygonLike.rings;
    }

    if (Array.isArray(polygonLike)) {
        return [polygonLike];
    }

    return [];
}

function getFiniteNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function isValidPoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}
