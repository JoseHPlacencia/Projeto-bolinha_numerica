export function createViewportBounds(center, viewportWidth, viewportHeight, scale, margin = 0) {
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
    const halfWidth = viewportWidth / safeScale / 2 + safeMargin;
    const halfHeight = viewportHeight / safeScale / 2 + safeMargin;

    return {
        minX: center.x - halfWidth,
        minY: center.y - halfHeight,
        maxX: center.x + halfWidth,
        maxY: center.y + halfHeight
    };
}

export function boundsOverlap(first, second) {
    if (!first || !second) {
        return true;
    }

    return first.minX <= second.maxX
        && first.maxX >= second.minX
        && first.minY <= second.maxY
        && first.maxY >= second.minY;
}

export function getPointsBounds(points, margin = 0) {
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hasPoint = false;

    for (const point of points || []) {
        if (!isValidPoint(point)) {
            continue;
        }

        hasPoint = true;
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }

    if (!hasPoint) {
        return null;
    }

    return {
        minX: minX - safeMargin,
        minY: minY - safeMargin,
        maxX: maxX + safeMargin,
        maxY: maxY + safeMargin
    };
}

export function getRingsBounds(rings, margin = 0) {
    let bounds = null;

    for (const ring of rings || []) {
        bounds = mergeBounds(bounds, getPointsBounds(ring, margin));
    }

    return bounds;
}

export function isPointNearBounds(point, bounds, margin = 0) {
    if (!bounds || !isValidPoint(point)) {
        return true;
    }

    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;

    return point.x >= bounds.minX - safeMargin
        && point.x <= bounds.maxX + safeMargin
        && point.y >= bounds.minY - safeMargin
        && point.y <= bounds.maxY + safeMargin;
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

function isValidPoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}
