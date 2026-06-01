(function registerMathUtilities(root, createMathUtilities) {
    const mathUtilities = createMathUtilities();
    const isCommonJs = typeof module === "object" && module.exports;

    if (isCommonJs) {
        module.exports = mathUtilities;
        return;
    }

    if (root) {
        root.GameMath = mathUtilities;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
    function clamp(value, min, max) {
        return Math.max(min, Math.min(value, max));
    }

    function distanceBetween(x1, y1, x2, y2) {
        return Math.hypot(x1 - x2, y1 - y2);
    }

    // PERFORMANCE: Versão sem sqrt para comparações de distância.
    // Usar quando apenas se quer saber se dist(A,B) <= r — evita Math.sqrt(),
    // que é uma operação de ponto flutuante cara (~20 ciclos vs ~2 de multiplicação).
    // Uso: distanceSqBetween(x1,y1,x2,y2) <= r*r
    function distanceSqBetween(x1, y1, x2, y2) {
        const dx = x1 - x2;
        const dy = y1 - y2;
        return dx * dx + dy * dy;
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

    function lerp(start, end, amount) {
        return start + (end - start) * amount;
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

    return {
        addVectors,
        clamp,
        createMovementVector,
        createVectorFromAngle,
        distanceBetween,
        distanceSqBetween,
        dotProduct,
        lerp,
        lerpAngle,
        scaleVector,
        vectorLength
    };
});
