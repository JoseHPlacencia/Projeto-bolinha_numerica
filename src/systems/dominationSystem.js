const config = require("../config/gameConfig");
const {
    applyCapturedPolygon,
    getPlayerTerritoryPolygon
} = require("../state/territories");
const {
    calculatePolygonArea,
    createPolygonFromPoints,
    isPointInPolygon,
    unionPolygons
} = require("../utils/geometry");

const geometryEpsilon = 1e-7;

function captureClosedTrail(player, territories) {
    const capturedPolygon = createExternalTrailCapturePolygon(player, territories);

    if (!capturedPolygon) {
        return null;
    }

    applyCapturedPolygon(territories, player.id, capturedPolygon);

    return capturedPolygon;
}

function createExternalTrailCapturePolygon(player, territories) {
    const currentTerritory = getPlayerTerritoryPolygon(territories, player.id);
    const currentArea = calculatePolygonArea(currentTerritory);
    const candidates = createTrailCaptureCandidates(player, currentTerritory);
    let bestCandidate = null;

    for (const candidate of candidates) {
        const union = unionPolygons(currentTerritory, candidate.polygon);
        const candidateArea = calculatePolygonArea(candidate.polygon);
        const addedArea = calculatePolygonArea(union) - currentArea;
        const overlapArea = Math.max(0, candidateArea - addedArea);

        if (addedArea < config.territory.minCaptureArea) {
            continue;
        }

        const rankedCandidate = {
            ...candidate,
            addedArea,
            overlapArea,
            hasLowOverlap: hasLowTerritoryOverlap(candidateArea, overlapArea)
        };

        if (!bestCandidate || isBetterCaptureCandidate(rankedCandidate, bestCandidate)) {
            bestCandidate = rankedCandidate;
        }
    }

    if (!bestCandidate) {
        return null;
    }

    return bestCandidate.polygon;
}

function hasLowTerritoryOverlap(candidateArea, overlapArea) {
    if (candidateArea <= Number.EPSILON) {
        return false;
    }

    return overlapArea <= Math.max(1, candidateArea * 0.02);
}

function isBetterCaptureCandidate(candidate, bestCandidate) {
    if (candidate.hasLowOverlap !== bestCandidate.hasLowOverlap) {
        return candidate.hasLowOverlap;
    }

    if (Math.abs(candidate.addedArea - bestCandidate.addedArea) > geometryEpsilon) {
        return candidate.addedArea > bestCandidate.addedArea;
    }

    return candidate.overlapArea < bestCandidate.overlapArea;
}

function createTrailCaptureCandidates(player, territoryPolygon) {
    const boundaryContacts = findTrailBoundaryContacts(territoryPolygon, player.trailPoints);

    if (!boundaryContacts) {
        return [];
    }

    const boundaryPaths = createBoundaryPaths(
        territoryPolygon[0],
        boundaryContacts.entry,
        boundaryContacts.exit
    );
    const candidates = [];

    for (const sidePoints of [player.trailLeftPoints, player.trailRightPoints]) {
        for (const boundaryPath of boundaryPaths) {
            const points = createTrailBoundaryCapturePoints(sidePoints, boundaryContacts, boundaryPath);
            const candidate = createTrailCandidateFromPoints(points);

            if (candidate) {
                candidates.push(candidate);
            }
        }
    }

    return candidates;
}

function createTrailBoundaryCapturePoints(sidePoints, boundaryContacts, boundaryPath) {
    const finiteSidePoints = getFinitePoints(sidePoints);

    if (finiteSidePoints.length < 2 || boundaryPath.length < 2) {
        return [];
    }

    const firstOutsideIndex = Math.min(
        finiteSidePoints.length - 1,
        boundaryContacts.exit.centerSegmentIndex + 1
    );
    const lastOutsideIndex = Math.min(
        finiteSidePoints.length - 1,
        boundaryContacts.entry.centerSegmentIndex
    );

    if (lastOutsideIndex < firstOutsideIndex) {
        return [];
    }

    const externalTrailSide = finiteSidePoints.slice(firstOutsideIndex, lastOutsideIndex + 1);
    const points = [
        boundaryContacts.exit.point,
        ...externalTrailSide,
        boundaryContacts.entry.point,
        ...boundaryPath.slice(1)
    ];

    return removeConsecutiveDuplicatePoints(points);
}

function createTrailCandidateFromPoints(points) {
    if (points.length < config.territory.minCaptureTrailPoints) {
        return null;
    }

    const polygon = createPolygonFromPoints(points);

    if (calculatePolygonArea(polygon) <= 0) {
        return null;
    }

    return { polygon };
}

function findTrailBoundaryContacts(territoryPolygon, trailPoints) {
    if (!territoryPolygon[0]) {
        return null;
    }

    const centerPoints = getFinitePoints(trailPoints);

    if (centerPoints.length < 2) {
        return null;
    }

    const exit = findBoundaryCrossing(territoryPolygon, centerPoints, "exit");
    const entry = findBoundaryCrossing(territoryPolygon, centerPoints, "entry");

    if (!exit || !entry || entry.centerSegmentIndex <= exit.centerSegmentIndex) {
        return null;
    }

    return { exit, entry };
}

function findBoundaryCrossing(territoryPolygon, points, crossingType) {
    if (crossingType === "entry") {
        for (let index = points.length - 2; index >= 0; index--) {
            if (!isPointInPolygon(territoryPolygon, points[index].x, points[index].y)
                && isPointInPolygon(territoryPolygon, points[index + 1].x, points[index + 1].y)) {
                return findSegmentBoundaryContact(territoryPolygon[0], points[index], points[index + 1], index);
            }
        }

        return null;
    }

    for (let index = 0; index < points.length - 1; index++) {
        if (isPointInPolygon(territoryPolygon, points[index].x, points[index].y)
            && !isPointInPolygon(territoryPolygon, points[index + 1].x, points[index + 1].y)) {
            return findSegmentBoundaryContact(territoryPolygon[0], points[index], points[index + 1], index);
        }
    }

    return null;
}

function findSegmentBoundaryContact(ring, start, end, centerSegmentIndex) {
    const openRing = getOpenRing(ring);
    const intersections = [];

    for (let segmentIndex = 0; segmentIndex < openRing.length; segmentIndex++) {
        const boundaryStart = coordinatesToPoint(openRing[segmentIndex]);
        const boundaryEnd = coordinatesToPoint(openRing[(segmentIndex + 1) % openRing.length]);
        const intersection = getSegmentIntersection(start, end, boundaryStart, boundaryEnd);

        if (!intersection) {
            continue;
        }

        intersections.push({
            point: intersection.point,
            pathT: intersection.firstSegmentT,
            segmentT: intersection.secondSegmentT,
            segmentIndex,
            centerSegmentIndex
        });
    }

    intersections.sort((first, second) => first.pathT - second.pathT);

    return intersections[0] || null;
}

function createBoundaryPaths(ring, startContact, endContact) {
    const openRing = getOpenRing(ring);

    if (openRing.length < 3) {
        return [];
    }

    const forwardPath = createForwardBoundaryPath(openRing, startContact, endContact);
    const reversePath = createForwardBoundaryPath(openRing, endContact, startContact).reverse();

    return [
        removeConsecutiveDuplicatePoints(forwardPath),
        removeConsecutiveDuplicatePoints(reversePath)
    ].filter(path => path.length >= 2);
}

function createForwardBoundaryPath(openRing, startContact, endContact) {
    if (startContact.segmentIndex === endContact.segmentIndex
        && endContact.segmentT >= startContact.segmentT) {
        return [startContact.point, endContact.point];
    }

    const path = [startContact.point];
    let vertexIndex = (startContact.segmentIndex + 1) % openRing.length;
    let guard = 0;

    while (guard <= openRing.length) {
        path.push(coordinatesToPoint(openRing[vertexIndex]));

        if (vertexIndex === endContact.segmentIndex) {
            break;
        }

        vertexIndex = (vertexIndex + 1) % openRing.length;
        guard++;
    }

    path.push(endContact.point);

    return path;
}

function getSegmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
    const firstDirection = subtractPoints(firstEnd, firstStart);
    const secondDirection = subtractPoints(secondEnd, secondStart);
    const denominator = crossProduct(firstDirection, secondDirection);

    if (Math.abs(denominator) <= geometryEpsilon) {
        return null;
    }

    const startDelta = subtractPoints(secondStart, firstStart);
    const firstSegmentT = crossProduct(startDelta, secondDirection) / denominator;
    const secondSegmentT = crossProduct(startDelta, firstDirection) / denominator;

    if (!isUnitRange(firstSegmentT) || !isUnitRange(secondSegmentT)) {
        return null;
    }

    return {
        point: {
            x: firstStart.x + firstDirection.x * firstSegmentT,
            y: firstStart.y + firstDirection.y * firstSegmentT
        },
        firstSegmentT,
        secondSegmentT
    };
}

function getOpenRing(ring) {
    if (!Array.isArray(ring)) {
        return [];
    }

    if (ring.length > 1 && areCoordinatesEqual(ring[0], ring[ring.length - 1])) {
        return ring.slice(0, -1);
    }

    return ring.slice();
}

function getFinitePoints(points) {
    if (!Array.isArray(points)) {
        return [];
    }

    return points
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(point => ({
            x: point.x,
            y: point.y
        }));
}

function removeConsecutiveDuplicatePoints(points) {
    return points.filter((point, index) => (
        index === 0 || !arePointsEqual(point, points[index - 1])
    ));
}

function coordinatesToPoint(coordinates) {
    return {
        x: coordinates[0],
        y: coordinates[1]
    };
}

function subtractPoints(first, second) {
    return {
        x: first.x - second.x,
        y: first.y - second.y
    };
}

function crossProduct(first, second) {
    return first.x * second.y - first.y * second.x;
}

function isUnitRange(value) {
    return value >= -geometryEpsilon && value <= 1 + geometryEpsilon;
}

function arePointsEqual(first, second) {
    return Math.abs(first.x - second.x) <= geometryEpsilon
        && Math.abs(first.y - second.y) <= geometryEpsilon;
}

function areCoordinatesEqual(first, second) {
    return first[0] === second[0] && first[1] === second[1];
}

module.exports = {
    captureClosedTrail,
    createExternalTrailCapturePolygon
};
