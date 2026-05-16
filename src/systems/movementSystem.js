const config = require("../config/gameConfig");
const {
    addVectors,
    clamp,
    createMovementVector,
    createVectorFromAngle,
    dotProduct,
    lerpAngle,
    scaleVector,
    vectorLength
} = require("../utils/math");

function updatePlayers(players, deltaTime) {
    for (const player of players.values()) {
        updatePlayer(player, deltaTime);
    }
}

function updatePlayer(player, deltaTime) {
    rotatePlayerToLastInput(player, deltaTime);
    movePlayer(player, deltaTime);
}

function rotatePlayerToLastInput(player, deltaTime) {
    const targetAngle = getPlayerTargetAngle(player);

    if (targetAngle === null) {
        return;
    }

    if (shouldBlockOutsideBoundaryInput(player, targetAngle, deltaTime)) {
        return;
    }

    player.angle = lerpAngle(
        player.angle,
        targetAngle,
        getRotationBlend(deltaTime)
    );
}

function getPlayerTargetAngle(player) {
    if (Number.isFinite(player.directionAngle)) {
        return player.directionAngle;
    }

    if (!player.lastAction || !hasInputAngle(player.lastAction)) {
        return null;
    }

    return config.inputActionAngles[player.lastAction];
}

function hasInputAngle(action) {
    return Object.prototype.hasOwnProperty.call(config.inputActionAngles, action);
}

function getRotationBlend(deltaTime) {
    const elapsedTicks = deltaTime * config.loop.tickRate;
    const blend = 1 - Math.pow(1 - config.movement.rotationStrength, elapsedTicks);

    return clamp(blend, 0, 1);
}

function shouldBlockOutsideBoundaryInput(player, targetAngle, deltaTime) {
    const position = getPlayerPosition(player);

    if (!isNearMapBoundary(position, getMovementDistance(deltaTime))) {
        return false;
    }

    const targetDirection = createVectorFromAngle(targetAngle, 1);

    return doesVectorPointOutsideMap(position, targetDirection);
}

function movePlayer(player, deltaTime) {
    const movement = getBoundaryAwareMovement(player, deltaTime);
    const nextState = resolveMapBoundary(player, movement.vector, movement.angle);

    player.x = nextState.x;
    player.y = nextState.y;
    player.angle = nextState.angle;
}

function getPlayerMovementVector(player, deltaTime) {
    return createMovementVector(player.angle, config.movement.speed, deltaTime);
}

function getBoundaryAwareMovement(player, deltaTime) {
    const movementVector = getPlayerMovementVector(player, deltaTime);
    const adjustedVector = blockOutsideBoundaryMovement(player, movementVector);

    if (adjustedVector === movementVector) {
        return {
            vector: movementVector,
            angle: player.angle
        };
    }

    return {
        vector: adjustedVector,
        angle: Math.atan2(adjustedVector.y, adjustedVector.x)
    };
}

function blockOutsideBoundaryMovement(player, movementVector) {
    const position = getPlayerPosition(player);

    if (!isNearMapBoundary(position, vectorLength(movementVector))) {
        return movementVector;
    }

    if (!doesVectorPointOutsideMap(position, movementVector)) {
        return movementVector;
    }

    const wallNormal = getBoundaryNormal(position);

    if (!wallNormal) {
        return movementVector;
    }

    return createBoundarySlideVector(movementVector, wallNormal);
}

function resolveMapBoundary(player, movementVector, movementAngle = player.angle) {
    const position = getPlayerPosition(player);
    const nextPosition = addVectors(position, movementVector);
    const distanceFromCenter = vectorLength(nextPosition);
    const mapLimit = getMapMovementLimit();

    if (distanceFromCenter <= mapLimit) {
        return {
            x: nextPosition.x,
            y: nextPosition.y,
            angle: movementAngle
        };
    }

    return resolveSlidingBoundary(player, movementVector, movementAngle, nextPosition, distanceFromCenter);
}

function resolveSlidingBoundary(player, movementVector, movementAngle, nextPosition, distanceFromCenter) {
    const wallNormal = scaleVector(nextPosition, 1 / distanceFromCenter);
    const wallPush = dotProduct(movementVector, wallNormal);
    let slidingVector = movementVector;
    let angle = movementAngle;

    // Remove only the part of the movement that pushes the player through the wall.
    if (wallPush > 0) {
        slidingVector = createBoundarySlideVector(movementVector, wallNormal);
        angle = Math.atan2(slidingVector.y, slidingVector.x);
    }

    return clampPositionToMap(addVectors(getPlayerPosition(player), slidingVector), angle);
}

function createBoundarySlideVector(movementVector, wallNormal) {
    const wallPush = dotProduct(movementVector, wallNormal);
    const slidingVector = {
        x: movementVector.x - wallPush * wallNormal.x,
        y: movementVector.y - wallPush * wallNormal.y
    };

    if (vectorLength(slidingVector) > config.movement.slideAngleThreshold) {
        return slidingVector;
    }

    return createFallbackBoundarySlide(movementVector, wallNormal);
}

function createFallbackBoundarySlide(movementVector, wallNormal) {
    const slideDirection = getFallbackSlideDirection(movementVector, wallNormal);
    const tangent = createBoundaryTangent(wallNormal, slideDirection);

    return scaleVector(tangent, vectorLength(movementVector));
}

function getFallbackSlideDirection(movementVector, wallNormal) {
    const movementDirection = getBoundarySlideDirection(wallNormal, movementVector);

    if (movementDirection !== 0) {
        return movementDirection;
    }

    return getRandomSlideDirection();
}

function getRandomSlideDirection() {
    return Math.random() < 0.5 ? -1 : 1;
}

function getBoundarySlideDirection(wallNormal, movementVector) {
    const tangent = createBoundaryTangent(wallNormal, 1);
    const alignment = dotProduct(movementVector, tangent);

    if (Math.abs(alignment) <= config.movement.slideAngleThreshold) {
        return 0;
    }

    return alignment > 0 ? 1 : -1;
}

function createBoundaryTangent(wallNormal, direction) {
    return {
        x: -wallNormal.y * direction,
        y: wallNormal.x * direction
    };
}

function doesVectorPointOutsideMap(position, vector) {
    const wallNormal = getBoundaryNormal(position);

    if (!wallNormal) {
        return false;
    }

    return dotProduct(vector, wallNormal) > Number.EPSILON;
}

function isNearMapBoundary(position, distanceFromBoundary) {
    const distanceFromCenter = vectorLength(position);
    const mapLimit = getMapMovementLimit();

    return distanceFromCenter >= mapLimit - distanceFromBoundary - Number.EPSILON;
}

function getBoundaryNormal(position) {
    const distanceFromCenter = vectorLength(position);

    if (distanceFromCenter <= Number.EPSILON) {
        return null;
    }

    return scaleVector(position, 1 / distanceFromCenter);
}

function getMovementDistance(deltaTime) {
    return config.movement.speed * deltaTime;
}

function clampPositionToMap(position, angle) {
    const mapLimit = getMapMovementLimit();
    const distanceFromCenter = vectorLength(position) || 1;

    if (distanceFromCenter <= mapLimit) {
        return {
            x: position.x,
            y: position.y,
            angle
        };
    }

    const scale = mapLimit / distanceFromCenter;

    return {
        x: position.x * scale,
        y: position.y * scale,
        angle
    };
}

function getMapMovementLimit() {
    return config.world.mapRadius - config.world.playerSize / 2;
}

function getPlayerPosition(player) {
    return {
        x: player.x,
        y: player.y
    };
}

module.exports = {
    getPlayerMovementVector,
    getPlayerTargetAngle,
    updatePlayer,
    updatePlayers
};
