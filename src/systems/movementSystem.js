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

function updatePlayers(players, deltaTime, runtimeConfig = null) {
    for (const player of players.values()) {
        if (runtimeConfig) {
            player.runtimeConfig = runtimeConfig;
        }
        updatePlayer(player, deltaTime);
    }
}

function updatePlayer(player, deltaTime) {
    rotatePlayerToLastInput(player, deltaTime);
    movePlayer(player, deltaTime);
}

function rotatePlayerToLastInput(player, deltaTime) {
    const targetInput = getPlayerTargetInput(player);

    try {
        rotatePlayerToTargetInput(player, targetInput, deltaTime);
    } finally {
        if (typeof player.consumePendingDirectionAngle === "function") {
            player.consumePendingDirectionAngle();
        }
    }
}

function rotatePlayerToTargetInput(player, targetInput, deltaTime) {
    const targetAngle = targetInput.angle;
    const boundarySlideInput = evaluateBoundarySlideInput(player, targetInput, deltaTime);

    player.debugState = createMovementDebugState(player, targetInput, boundarySlideInput);

    if (boundarySlideInput.shouldExitSlide) {
        clearBoundarySlideDirection(player);
    } else if (boundarySlideInput.shouldMarkInputHandled) {
        markBoundarySlideInputHandled(player);
    }

    const lockedBoundarySlideAngle = boundarySlideInput.shouldExitSlide
        ? null
        : getLockedBoundarySlideAngle(player);

    if (lockedBoundarySlideAngle !== null) {
        player.angle = lockedBoundarySlideAngle;
        return;
    }

    const boundarySlideTrigger = boundarySlideInput.shouldExitSlide
        ? null
        : getBoundarySlideTrigger(player, targetAngle);

    if (boundarySlideTrigger !== null) {
        if (boundarySlideTrigger.shouldActivateSlide) {
            player.angle = boundarySlideTrigger.angle;
            return;
        }

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
        getRotationBlend(player, deltaTime)
    );
}

function getPlayerTargetAngle(player) {
    return getPlayerTargetInput(player).angle;
}

function getPlayerTargetInput(player) {
    if (Number.isFinite(player.pendingDirectionAngle)) {
        return {
            angle: player.pendingDirectionAngle,
            source: "mouse"
        };
    }

    if (Number.isFinite(player.directionAngle)) {
        return {
            angle: player.directionAngle,
            source: player.directionSource || "direction"
        };
    }

    if (!player.lastAction || !hasInputAngle(player.lastAction)) {
        return {
            angle: null,
            source: null
        };
    }

    return {
        angle: config.inputActionAngles[player.lastAction],
        source: `action:${player.lastAction}`
    };
}

function hasInputAngle(action) {
    return Object.prototype.hasOwnProperty.call(config.inputActionAngles, action);
}

function evaluateBoundarySlideInput(player, targetInput, deltaTime) {
    const position = getPlayerPosition(player);
    const targetAngle = targetInput.angle;
    const relation = getBoundaryInputRelation(position, targetAngle);
    const isTouchingBoundary = isPlayerHitboxTouchingMapBoundary(player, position);
    const isSliding = isBoundarySlideDirection(player.boundarySlideDirection);
    const hasUnhandledInput = hasUnhandledBoundarySlideInput(player);
    const evaluation = {
        boundarySlideDirection: player.boundarySlideDirection,
        inputAccepted: false,
        isTouchingBoundary,
        relation,
        shouldExitSlide: false,
        shouldMarkInputHandled: false,
        slideDecision: "not-sliding"
    };

    if (!isSliding) {
        evaluation.inputAccepted = isNormalInputAccepted(player, targetAngle);
        return evaluation;
    }

    if (!isTouchingBoundary) {
        evaluation.slideDecision = "not-touching-boundary";
        return evaluation;
    }

    if (!hasUnhandledInput) {
        evaluation.slideDecision = "ignored-old-input";
        return evaluation;
    }

    evaluation.shouldMarkInputHandled = true;

    if (!Number.isFinite(targetAngle)) {
        evaluation.slideDecision = "ignored-no-input";
        return evaluation;
    }

    if (relation === "outside") {
        evaluation.slideDecision = "ignored-outside";
        return evaluation;
    }

    if (relation === "tangent") {
        evaluation.slideDecision = "ignored-tangent";
        return evaluation;
    }

    const exitEvaluation = evaluateBoundarySlideExit(player, targetAngle, deltaTime);

    if (!exitEvaluation.exitsBoundary) {
        evaluation.slideDecision = "ignored-weak-inside";
        return evaluation;
    }

    evaluation.inputAccepted = true;
    evaluation.shouldExitSlide = true;
    evaluation.shouldMarkInputHandled = false;
    evaluation.slideDecision = "accepted-exit";

    return evaluation;
}

function isNormalInputAccepted(player, targetAngle) {
    return Number.isFinite(targetAngle)
        && !shouldBlockOutsideBoundaryInput(player, targetAngle);
}

function evaluateBoundarySlideExit(player, targetAngle, deltaTime) {
    const position = getPlayerPosition(player);
    const wallNormal = getBoundaryNormal(position);
    const targetDirection = createVectorFromAngle(targetAngle, 1);
    const inwardAlignment = wallNormal
        ? clamp(-dotProduct(targetDirection, wallNormal), 0, 1)
        : 0;

    if (!wallNormal || inwardAlignment < getBoundarySlideExitAlignment()) {
        return {
            exitsBoundary: false
        };
    }

    const lockedBoundarySlideAngle = getLockedBoundarySlideAngle(player);
    const baseAngle = lockedBoundarySlideAngle === null ? player.angle : lockedBoundarySlideAngle;
    const candidateAngle = lerpAngle(baseAngle, targetAngle, getRotationBlend(player, deltaTime));
    const candidateMovement = createMovementVector(candidateAngle, getMovementSpeed(player), deltaTime);
    const candidatePosition = addVectors(position, candidateMovement);
    const candidateExitDepth = getMapMovementLimit(player) - vectorLength(candidatePosition);

    return {
        exitsBoundary: candidateExitDepth >= getBoundarySlideExitDistance()
    };
}

function getBoundaryInputRelation(position, targetAngle) {
    if (!Number.isFinite(targetAngle)) {
        return "none";
    }

    const wallNormal = getBoundaryNormal(position);

    if (!wallNormal) {
        return "none";
    }

    const targetDirection = createVectorFromAngle(targetAngle, 1);
    const alignment = dotProduct(targetDirection, wallNormal);
    const tangentAlignment = getBoundaryInputTangentAlignment();

    if (alignment > tangentAlignment) {
        return "outside";
    }

    if (alignment < -tangentAlignment) {
        return "inside";
    }

    return "tangent";
}

function createMovementDebugState(player, targetInput, boundarySlideInput) {
    const inputAngleDelta = Number.isFinite(targetInput.angle)
        ? getAngleDelta(player.angle, targetInput.angle)
        : null;

    return {
        boundaryInputRelation: boundarySlideInput.relation,
        boundarySlideDecision: boundarySlideInput.slideDecision,
        boundarySlideDirection: boundarySlideInput.boundarySlideDirection,
        directionAngleDeg: toDegrees(targetInput.angle),
        directionAngleRad: nullableNumber(targetInput.angle),
        directionSource: targetInput.source,
        inputAccepted: boundarySlideInput.inputAccepted,
        inputAngleDeltaDeg: toDegrees(inputAngleDelta),
        inputAngleDeltaRad: nullableNumber(inputAngleDelta),
        isTouchingBoundary: boundarySlideInput.isTouchingBoundary,
        playerAngleDeg: toDegrees(player.angle),
        playerAngleRad: nullableNumber(player.angle)
    };
}

function getRotationBlend(player, deltaTime) {
    const elapsedTicks = deltaTime * config.loop.tickRate;
    const rotationStrength = getRotationStrength(player);
    const blend = 1 - Math.pow(1 - rotationStrength, elapsedTicks);

    return clamp(blend, 0, 1);
}

function getBoundarySlideTriggerBaseAngle(player, targetAngle, deltaTime) {
    if (targetAngle === null || shouldBlockOutsideBoundaryInput(player, targetAngle)) {
        return player.angle;
    }

    return lerpAngle(
        player.angle,
        targetAngle,
        getRotationBlend(player, deltaTime)
    );
}

function shouldBlockOutsideBoundaryInput(player, targetAngle) {
    const position = getPlayerPosition(player);

    if (!isPlayerHitboxTouchingMapBoundary(player, position)) {
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
    return createMovementVector(player.angle, getMovementSpeed(player), deltaTime);
}

function getBoundaryAwareMovement(player, deltaTime) {
    const movementVector = getPlayerMovementVector(player, deltaTime);

    return {
        vector: movementVector,
        angle: player.angle
    };
}

function resolveMapBoundary(player, movementVector, movementAngle = player.angle) {
    const position = getBoundarySlideSurfacePosition(player, getPlayerPosition(player));
    const nextPosition = addVectors(position, movementVector);
    const distanceFromCenter = vectorLength(nextPosition);
    const mapLimit = getMapMovementLimit(player);

    if (distanceFromCenter <= mapLimit) {
        clearBoundarySlideDirectionIfAwayFromBoundary(player, nextPosition);

        return {
            x: nextPosition.x,
            y: nextPosition.y,
            angle: movementAngle
        };
    }

    return resolveSlidingBoundary(player, position, movementVector, movementAngle, nextPosition, distanceFromCenter);
}

function resolveSlidingBoundary(player, position, movementVector, movementAngle, nextPosition, distanceFromCenter) {
    const wallNormal = scaleVector(nextPosition, 1 / distanceFromCenter);
    const wallPush = dotProduct(movementVector, wallNormal);

    if (wallPush > 0) {
        const hitTime = getMapBoundaryHitTime(player, position, movementVector);
        const hitPosition = addVectors(position, scaleVector(movementVector, hitTime));
        const hitNormal = getBoundaryNormal(hitPosition) || wallNormal;
        const remainingVector = scaleVector(movementVector, 1 - hitTime);
        const slideDirection = getLockedBoundarySlideDirection(player, hitNormal, movementVector);
        const slidingVector = createBoundarySlideVector(remainingVector, hitNormal, slideDirection);
        const slideState = clampPositionToMap(player, addVectors(hitPosition, slidingVector), movementAngle);

        return {
            x: slideState.x,
            y: slideState.y,
            angle: getStrictBoundaryTangentAngle(slideState, hitNormal, slideDirection)
        };
    }

    return clampPositionToMap(player, nextPosition, movementAngle);
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

    const triggerRadius = getBoundarySlideTriggerRadius(player, outwardAlignment);

    if (!isBoundarySlideTriggerCollidingWithMap(player, position, triggerRadius)) {
        return null;
    }

    const slideDirection = getBoundarySlideSmoothingDirection(
        player,
        wallNormal,
        targetDirection,
        currentDirection
    );
    const tangent = createBoundaryTangent(wallNormal, slideDirection);
    const tangentAlignment = getBoundarySlideTangentAlignment(currentDirection, tangent);

    return {
        angle: Math.atan2(tangent.y, tangent.x),
        alignment: outwardAlignment,
        progress: getBoundarySlideTriggerProgress(player, position, triggerRadius),
        shouldActivateSlide: shouldActivateBoundarySlide(player, position, tangentAlignment),
        tangentAlignment
    };
}

function getLockedBoundarySlideDirection(player, wallNormal, ...directionVectors) {
    if (isBoundarySlideDirection(player.boundarySlideDirection)) {
        return player.boundarySlideDirection;
    }

    const slideDirection = getPreferredBoundarySlideDirection(wallNormal, directionVectors)
        || getRandomSlideDirection();
    setBoundarySlideDirection(player, slideDirection);

    return slideDirection;
}

function getBoundarySlideSmoothingDirection(player, wallNormal, ...directionVectors) {
    if (isBoundarySlideDirection(player.boundarySlideDirection)) {
        return player.boundarySlideDirection;
    }

    const preferredDirection = getPreferredBoundarySlideDirection(wallNormal, directionVectors);
    const slideDirection = preferredDirection
        || getRandomSlideDirection();

    setBoundarySlideDirection(player, slideDirection);

    return slideDirection;
}

function getLockedBoundarySlideAngle(player) {
    if (!isBoundarySlideDirection(player.boundarySlideDirection)) {
        return null;
    }

    const position = getPlayerPosition(player);

    if (!isPlayerHitboxTouchingMapBoundary(player, position)) {
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
    player.boundarySlideInputVersion = player.inputVersion;
}

function setBoundarySlideDirection(player, slideDirection) {
    player.boundarySlideDirection = slideDirection;
    player.boundarySlideInputVersion = player.inputVersion;
}

function hasUnhandledBoundarySlideInput(player) {
    return isBoundarySlideDirection(player.boundarySlideDirection)
        && player.inputVersion !== player.boundarySlideInputVersion;
}

function markBoundarySlideInputHandled(player) {
    player.boundarySlideInputVersion = player.inputVersion;
}

function clearBoundarySlideDirectionIfAwayFromBoundary(player, position) {
    const releaseDistance = getRuntimeConfig(player).world.playerSize / 2;

    if (!isNearMapBoundary(player, position, releaseDistance)) {
        clearBoundarySlideDirection(player);
    }
}

function getMapBoundaryHitTime(player, position, movementVector) {
    const mapLimit = getMapMovementLimit(player);
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

function isBoundarySlideTriggerCollidingWithMap(player, position, triggerRadius) {
    if (triggerRadius <= Number.EPSILON) {
        return false;
    }

    return vectorLength(position) + triggerRadius >= getRuntimeConfig(player).world.mapRadius;
}

function getBoundarySlideTriggerProgress(player, position, triggerRadius) {
    const triggerStartDistance = getRuntimeConfig(player).world.mapRadius - triggerRadius;
    const hitboxContactDistance = getMapMovementLimit(player);
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

function getBoundarySlideTriggerRadius(player, outwardAlignment) {
    const playerSizeRatio = getBoundarySlideTriggerPerpendicularPlayerSizeRatio();

    return getRuntimeConfig(player).world.playerSize * playerSizeRatio * outwardAlignment;
}

function getBoundarySlideTriggerPerpendicularPlayerSizeRatio() {
    const ratio = Number(config.movement.boundarySlideTriggerPerpendicularPlayerSizeRatio);

    return Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
}

function getOutwardBoundaryAlignment(wallNormal, direction) {
    return clamp(dotProduct(direction, wallNormal), 0, 1);
}

function getBoundarySlideTangentAlignment(direction, tangent) {
    return clamp(Math.abs(dotProduct(direction, tangent)), 0, 1);
}

function shouldActivateBoundarySlide(player, position, tangentAlignment) {
    return isPlayerHitboxTouchingMapBoundary(player, position)
        && tangentAlignment >= getBoundarySlideActivationTangentAlignment();
}

function getBoundarySlideActivationTangentAlignment() {
    const alignment = Number(config.movement.boundarySlideActivationTangentAlignment);

    return Number.isFinite(alignment) ? clamp(alignment, 0, 1) : 0.85;
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

function getBoundarySlideExitAlignment() {
    const alignment = Number(config.movement.boundarySlideExitAlignment);

    return Number.isFinite(alignment) ? clamp(alignment, 0, 1) : 0.9;
}

function getBoundarySlideExitDistance() {
    const distance = Number(config.movement.boundarySlideExitDistance);

    return Number.isFinite(distance) ? Math.max(0, distance) : 1;
}

function getBoundaryInputTangentAlignment() {
    const alignment = Number(config.movement.slideAngleThreshold);

    return Number.isFinite(alignment) ? clamp(Math.abs(alignment), 0, 1) : 0.1;
}

function getBoundaryTouchTolerance() {
    const tolerance = Number(config.movement.boundaryTouchTolerance);

    return Number.isFinite(tolerance) ? Math.max(0, tolerance) : 4;
}

function isPlayerHitboxTouchingMapBoundary(playerOrPosition, maybePosition = null) {
    const player = maybePosition ? playerOrPosition : null;
    const position = maybePosition || playerOrPosition;

    return isNearMapBoundary(player, position, getBoundaryTouchTolerance());
}

function isNearMapBoundary(player, position, distanceFromBoundary) {
    const distanceFromCenter = vectorLength(position);
    const mapLimit = getMapMovementLimit(player);

    return distanceFromCenter >= mapLimit - distanceFromBoundary - Number.EPSILON;
}

function getBoundarySlideSurfacePosition(player, position) {
    if (
        !isBoundarySlideDirection(player.boundarySlideDirection)
        || !isPlayerHitboxTouchingMapBoundary(player, position)
    ) {
        return position;
    }

    const wallNormal = getBoundaryNormal(position);

    return wallNormal
        ? scaleVector(wallNormal, getMapMovementLimit(player))
        : position;
}

function getBoundaryNormal(position) {
    const distanceFromCenter = vectorLength(position);

    if (distanceFromCenter <= Number.EPSILON) {
        return null;
    }

    return scaleVector(position, 1 / distanceFromCenter);
}

function clampPositionToMap(player, position, angle) {
    const mapLimit = getMapMovementLimit(player);
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

function getMapMovementLimit(player = null) {
    const runtimeConfig = getRuntimeConfig(player);

    return runtimeConfig.world.mapRadius - runtimeConfig.world.playerSize / 2;
}

function getMovementSpeed(player) {
    return getRuntimeConfig(player).movement.speed;
}

function getRotationStrength(player) {
    const rotationStrength = Number(getRuntimeConfig(player).movement.rotationStrength);

    return Number.isFinite(rotationStrength)
        ? clamp(rotationStrength, 0, 1)
        : config.movement.rotationStrength;
}

function getRuntimeConfig(player = null) {
    return player && player.runtimeConfig && player.runtimeConfig.world
        ? player.runtimeConfig
        : config;
}

function getPlayerPosition(player) {
    return {
        x: player.x,
        y: player.y
    };
}

function getAngleDelta(fromAngle, toAngle) {
    return Math.atan2(
        Math.sin(toAngle - fromAngle),
        Math.cos(toAngle - fromAngle)
    );
}

function nullableNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function toDegrees(angle) {
    return Number.isFinite(angle) ? angle * 180 / Math.PI : null;
}

module.exports = {
    getPlayerMovementVector,
    getPlayerTargetAngle,
    updatePlayer,
    updatePlayers
};
