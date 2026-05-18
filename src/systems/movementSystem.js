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
    const respectsBoundaryExitInput = shouldRespectBoundaryExitInput(player, targetAngle);

    if (respectsBoundaryExitInput) {
        clearBoundarySlideDirection(player);
    }

    const lockedBoundarySlideAngle = respectsBoundaryExitInput ? null : getLockedBoundarySlideAngle(player);

    if (lockedBoundarySlideAngle !== null) {
        player.angle = lockedBoundarySlideAngle;
        return;
    }

    const boundarySlideTrigger = respectsBoundaryExitInput
        ? null
        : getBoundarySlideTrigger(player, targetAngle);

    if (boundarySlideTrigger !== null) {
        const baseAngle = getBoundarySlideTriggerBaseAngle(player, targetAngle, deltaTime);

        player.angle = lerpAngle(
            baseAngle,
            boundarySlideTrigger.angle,
            getBoundarySlideTriggerRotationBlend(
                deltaTime,
                boundarySlideTrigger.progress,
                boundarySlideTrigger.alignment
            )
        );
        return;
    }

    if (targetAngle === null) {
        return;
    }

    if (shouldBlockOutsideBoundaryInput(player, targetAngle)) {
        return;
    }

    player.angle = lerpAngle(
        player.angle,
        targetAngle,
        getRotationBlend(deltaTime)
    );
}

function shouldRespectBoundaryExitInput(player, targetAngle) {
    if (!Number.isFinite(targetAngle)) {
        return false;
    }

    const position = getPlayerPosition(player);
    const targetDirection = createVectorFromAngle(targetAngle, 1);

    return doesVectorPointInsideMap(position, targetDirection, getBoundarySlideExitAlignment());
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

function getBoundarySlideTriggerBaseAngle(player, targetAngle, deltaTime) {
    if (targetAngle === null || shouldBlockOutsideBoundaryInput(player, targetAngle)) {
        return player.angle;
    }

    return lerpAngle(
        player.angle,
        targetAngle,
        getRotationBlend(deltaTime)
    );
}

function shouldBlockOutsideBoundaryInput(player, targetAngle) {
    const position = getPlayerPosition(player);

    if (!isPlayerHitboxTouchingMapBoundary(position)) {
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

    return {
        vector: movementVector,
        angle: player.angle
    };
}

function resolveMapBoundary(player, movementVector, movementAngle = player.angle) {
    const position = getPlayerPosition(player);
    const nextPosition = addVectors(position, movementVector);
    const distanceFromCenter = vectorLength(nextPosition);
    const mapLimit = getMapMovementLimit();

    if (distanceFromCenter <= mapLimit) {
        clearBoundarySlideDirectionIfAwayFromBoundary(player, nextPosition);

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

    if (wallPush > 0) {
        const position = getPlayerPosition(player);
        const hitTime = getMapBoundaryHitTime(position, movementVector);
        const hitPosition = addVectors(position, scaleVector(movementVector, hitTime));
        const hitNormal = getBoundaryNormal(hitPosition) || wallNormal;
        const remainingVector = scaleVector(movementVector, 1 - hitTime);
        const slideDirection = getLockedBoundarySlideDirection(player, hitNormal, movementVector);
        const slidingVector = createBoundarySlideVector(remainingVector, hitNormal, slideDirection);
        const slideState = clampPositionToMap(addVectors(hitPosition, slidingVector), movementAngle);

        return {
            x: slideState.x,
            y: slideState.y,
            angle: getStrictBoundaryTangentAngle(slideState, hitNormal, slideDirection)
        };
    }

    return clampPositionToMap(nextPosition, movementAngle);
}

function getStrictBoundaryTangentAngle(position, fallbackNormal, slideDirection) {
    const wallNormal = getBoundaryNormal(position) || fallbackNormal;
    const tangent = createBoundaryTangent(wallNormal, slideDirection);

    return Math.atan2(tangent.y, tangent.x);
}

function getBoundarySlideTrigger(player, targetAngle) {
    const position = getPlayerPosition(player);

    const wallNormal = getBoundaryNormal(position);

    if (!wallNormal) {
        return null;
    }

    const currentDirection = createVectorFromAngle(player.angle, 1);
    const hasTargetAngle = Number.isFinite(targetAngle);
    const targetDirection = hasTargetAngle ? createVectorFromAngle(targetAngle, 1) : currentDirection;

    if (!doesVectorPointOutsideMap(position, currentDirection)) {
        return null;
    }

    const outwardAlignment = getOutwardBoundaryAlignment(wallNormal, currentDirection);

    if (outwardAlignment < getBoundarySlideTriggerMinOutwardAlignment()) {
        return null;
    }

    const triggerRadius = getBoundarySlideTriggerRadius(outwardAlignment);

    if (!isBoundarySlideTriggerCollidingWithMap(position, triggerRadius)) {
        return null;
    }

    const slideDirection = getBoundarySlideSmoothingDirection(
        player,
        wallNormal,
        targetDirection,
        currentDirection
    );
    const tangent = createBoundaryTangent(wallNormal, slideDirection);

    return {
        angle: Math.atan2(tangent.y, tangent.x),
        alignment: outwardAlignment,
        progress: getBoundarySlideTriggerProgress(position, triggerRadius)
    };
}

function getLockedBoundarySlideDirection(player, wallNormal, ...directionVectors) {
    if (isBoundarySlideDirection(player.boundarySlideDirection)) {
        return player.boundarySlideDirection;
    }

    const slideDirection = getPreferredBoundarySlideDirection(wallNormal, directionVectors)
        || getRandomSlideDirection();
    player.boundarySlideDirection = slideDirection;

    return slideDirection;
}

function getBoundarySlideSmoothingDirection(player, wallNormal, ...directionVectors) {
    if (isBoundarySlideDirection(player.boundarySlideDirection)) {
        return player.boundarySlideDirection;
    }

    const preferredDirection = getPreferredBoundarySlideDirection(wallNormal, directionVectors);
    const slideDirection = preferredDirection
        || getRandomSlideDirection();

    player.boundarySlideDirection = slideDirection;

    return slideDirection;
}

function getLockedBoundarySlideAngle(player) {
    if (!isBoundarySlideDirection(player.boundarySlideDirection)) {
        return null;
    }

    const position = getPlayerPosition(player);

    if (!isPlayerHitboxTouchingMapBoundary(position)) {
        return null;
    }

    const wallNormal = getBoundaryNormal(position);

    if (!wallNormal) {
        return null;
    }

    const tangent = createBoundaryTangent(wallNormal, player.boundarySlideDirection);

    return Math.atan2(tangent.y, tangent.x);
}

function getPreferredBoundarySlideDirection(wallNormal, directionVectors) {
    for (const directionVector of directionVectors) {
        const slideDirection = getBoundarySlideDirection(wallNormal, directionVector);

        if (slideDirection !== 0) {
            return slideDirection;
        }
    }

    return 0;
}

function clearBoundarySlideDirection(player) {
    player.boundarySlideDirection = null;
}

function clearBoundarySlideDirectionIfAwayFromBoundary(player, position) {
    const releaseDistance = config.world.playerSize / 2;

    if (!isNearMapBoundary(position, releaseDistance)) {
        clearBoundarySlideDirection(player);
    }
}

function getMapBoundaryHitTime(position, movementVector) {
    const mapLimit = getMapMovementLimit();
    const movementLengthSquared = dotProduct(movementVector, movementVector);

    if (movementLengthSquared <= Number.EPSILON) {
        return 1;
    }

    const b = 2 * dotProduct(position, movementVector);
    const c = dotProduct(position, position) - mapLimit * mapLimit;
    const discriminant = b * b - 4 * movementLengthSquared * c;

    if (discriminant <= 0) {
        return 1;
    }

    return clamp((-b + Math.sqrt(discriminant)) / (2 * movementLengthSquared), 0, 1);
}

function getBoundarySlideTriggerRotationBlend(deltaTime, triggerProgress, outwardAlignment) {
    const sharpness = getBoundarySlideTriggerRotationSharpness();
    const alignmentInfluence = getBoundarySlideTriggerAlignmentInfluence(outwardAlignment);
    const curveProgress = getBoundarySlideTriggerLogCurve(triggerProgress);
    const blend = 1 - Math.exp(-sharpness * alignmentInfluence * curveProgress * deltaTime);

    return clamp(blend, 0, 1);
}

function getBoundarySlideTriggerRotationSharpness() {
    const sharpness = Number(config.movement.boundarySlideTriggerRotationSharpness);

    return Number.isFinite(sharpness) ? Math.max(0, sharpness) : 0;
}

function getBoundarySlideTriggerAlignmentInfluence(outwardAlignment) {
    const alignment = clamp(outwardAlignment, 0, 1);

    return Math.pow(alignment, getBoundarySlideTriggerAlignmentPower());
}

function getBoundarySlideTriggerAlignmentPower() {
    const power = Number(config.movement.boundarySlideTriggerAlignmentPower);

    return Number.isFinite(power) ? Math.max(0, power) : 0;
}

function getBoundarySlideTriggerMinOutwardAlignment() {
    const alignment = Number(config.movement.boundarySlideTriggerMinOutwardAlignment);

    return Number.isFinite(alignment) ? clamp(alignment, 0, 1) : 0;
}

function isBoundarySlideTriggerCollidingWithMap(position, triggerRadius) {
    if (triggerRadius <= Number.EPSILON) {
        return false;
    }

    return vectorLength(position) + triggerRadius >= config.world.mapRadius;
}

function getBoundarySlideTriggerProgress(position, triggerRadius) {
    const triggerStartDistance = config.world.mapRadius - triggerRadius;
    const hitboxContactDistance = getMapMovementLimit();
    const triggerDistance = hitboxContactDistance - triggerStartDistance;

    if (triggerDistance <= Number.EPSILON) {
        return 1;
    }

    return clamp((vectorLength(position) - triggerStartDistance) / triggerDistance, 0, 1);
}

function getBoundarySlideTriggerLogCurve(progress) {
    const curveSharpness = getBoundarySlideTriggerRotationCurveSharpness();

    if (curveSharpness <= Number.EPSILON) {
        return clamp(progress, 0, 1);
    }

    const remainingProgress = 1 - clamp(progress, 0, 1);

    return 1 - Math.log1p(curveSharpness * remainingProgress) / Math.log1p(curveSharpness);
}

function getBoundarySlideTriggerRotationCurveSharpness() {
    const curveSharpness = Number(config.movement.boundarySlideTriggerRotationCurveSharpness);

    return Number.isFinite(curveSharpness) ? Math.max(0, curveSharpness) : 0;
}

function getBoundarySlideTriggerRadius(outwardAlignment) {
    const playerSizeRatio = getBoundarySlideTriggerPerpendicularPlayerSizeRatio();

    return config.world.playerSize * playerSizeRatio * outwardAlignment;
}

function getBoundarySlideTriggerPerpendicularPlayerSizeRatio() {
    const ratio = Number(config.movement.boundarySlideTriggerPerpendicularPlayerSizeRatio);

    return Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
}

function getOutwardBoundaryAlignment(wallNormal, direction) {
    return clamp(dotProduct(direction, wallNormal), 0, 1);
}

function createBoundarySlideVector(movementVector, wallNormal, fallbackSlideDirection = null) {
    const wallPush = dotProduct(movementVector, wallNormal);
    const slidingVector = {
        x: movementVector.x - wallPush * wallNormal.x,
        y: movementVector.y - wallPush * wallNormal.y
    };

    if (isBoundarySlideDirection(fallbackSlideDirection)) {
        return createDirectedBoundarySlide(movementVector, slidingVector, wallNormal, fallbackSlideDirection);
    }

    if (vectorLength(slidingVector) > config.movement.slideAngleThreshold) {
        return slidingVector;
    }

    return createFallbackBoundarySlide(movementVector, wallNormal, fallbackSlideDirection);
}

function createDirectedBoundarySlide(movementVector, slidingVector, wallNormal, slideDirection) {
    const tangent = createBoundaryTangent(wallNormal, slideDirection);
    const projectedLength = Math.abs(dotProduct(slidingVector, tangent));
    const slideLength = projectedLength > config.movement.slideAngleThreshold
        ? projectedLength
        : vectorLength(movementVector);

    return scaleVector(tangent, slideLength);
}

function createFallbackBoundarySlide(movementVector, wallNormal, fallbackSlideDirection = null) {
    const slideDirection = getFallbackSlideDirection(movementVector, wallNormal, fallbackSlideDirection);
    const tangent = createBoundaryTangent(wallNormal, slideDirection);

    return scaleVector(tangent, vectorLength(movementVector));
}

function getFallbackSlideDirection(movementVector, wallNormal, fallbackSlideDirection = null) {
    if (isBoundarySlideDirection(fallbackSlideDirection)) {
        return fallbackSlideDirection;
    }

    const movementDirection = getBoundarySlideDirection(wallNormal, movementVector);

    if (movementDirection !== 0) {
        return movementDirection;
    }

    return getRandomSlideDirection();
}

function getRandomSlideDirection() {
    return Math.random() < 0.5 ? -1 : 1;
}

function isBoundarySlideDirection(value) {
    return value === -1 || value === 1;
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

function doesVectorPointInsideMap(position, vector, minAlignment = Number.EPSILON) {
    const wallNormal = getBoundaryNormal(position);

    if (!wallNormal) {
        return false;
    }

    return dotProduct(vector, wallNormal) < -minAlignment;
}

function getBoundarySlideExitAlignment() {
    const alignment = Number(config.movement.boundarySlideExitAlignment);

    return Number.isFinite(alignment) ? clamp(alignment, 0, 1) : 0.9;
}

function isPlayerHitboxTouchingMapBoundary(position) {
    return vectorLength(position) >= getMapMovementLimit() - Number.EPSILON;
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
