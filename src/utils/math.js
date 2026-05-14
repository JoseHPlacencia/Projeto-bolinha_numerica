function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
}

function distanceBetween(x1, y1, x2, y2) {
    return Math.hypot(x1 - x2, y1 - y2);
}

function normalizeAngleDelta(currentAngle, targetAngle) {
    let delta = targetAngle - currentAngle;

    while (delta < -Math.PI) {
        delta += Math.PI * 2;
    }

    while (delta > Math.PI) {
        delta -= Math.PI * 2;
    }

    return delta;
}

function lerpAngle(currentAngle, targetAngle, amount) {
    return currentAngle + normalizeAngleDelta(currentAngle, targetAngle) * amount;
}

function createVectorFromAngle(angle, magnitude) {
    return {
        x: Math.cos(angle) * magnitude,
        y: Math.sin(angle) * magnitude
    };
}

function createMovementVector(angle, speed, deltaTime) {
    return createVectorFromAngle(angle, speed * deltaTime);
}

function addVectors(firstVector, secondVector) {
    return {
        x: firstVector.x + secondVector.x,
        y: firstVector.y + secondVector.y
    };
}

function dotProduct(firstVector, secondVector) {
    return firstVector.x * secondVector.x + firstVector.y * secondVector.y;
}

function scaleVector(vector, scale) {
    return {
        x: vector.x * scale,
        y: vector.y * scale
    };
}

function vectorLength(vector) {
    return Math.hypot(vector.x, vector.y);
}

module.exports = {
    addVectors,
    clamp,
    createMovementVector,
    createVectorFromAngle,
    distanceBetween,
    dotProduct,
    lerpAngle,
    scaleVector,
    vectorLength
};
