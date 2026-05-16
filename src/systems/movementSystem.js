const config = require("../config/gameConfig");
const {
    addVectors,
    clamp,
    createMovementVector,
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

function movePlayer(player, deltaTime) {
    const movementVector = getPlayerMovementVector(player, deltaTime);
    const nextState = resolveMapBoundary(player, movementVector);

    player.x = nextState.x;
    player.y = nextState.y;
    player.angle = nextState.angle;
}

function getPlayerMovementVector(player, deltaTime) {
    return createMovementVector(player.angle, config.movement.speed, deltaTime);
}

function resolveMapBoundary(player, movementVector) {
    const position = getPlayerPosition(player);
    const nextPosition = addVectors(position, movementVector);
    const distanceFromCenter = vectorLength(nextPosition);
    const mapLimit = getMapMovementLimit();

    if (distanceFromCenter <= mapLimit) {
        return {
            x: nextPosition.x,
            y: nextPosition.y,
            angle: player.angle
        };
    }

    return resolveSlidingBoundary(player, movementVector, nextPosition, distanceFromCenter);
}

function resolveSlidingBoundary(player, movementVector, nextPosition, distanceFromCenter) {
    const wallNormal = scaleVector(nextPosition, 1 / distanceFromCenter);
    const wallPush = dotProduct(movementVector, wallNormal);
    let slidingVector = movementVector;
    let angle = player.angle;

    // Remove only the part of the movement that pushes the player through the wall.
    if (wallPush > 0) {
        slidingVector = {
            x: movementVector.x - wallPush * wallNormal.x,
            y: movementVector.y - wallPush * wallNormal.y
        };

        if (vectorLength(slidingVector) > config.movement.slideAngleThreshold) {
            angle = Math.atan2(slidingVector.y, slidingVector.x);
        }
    }

    return clampPositionToMap(addVectors(getPlayerPosition(player), slidingVector), angle);
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
