import { getAngleDelta, normalizeAngle } from "./directionalInput.js";

const DIRECTION_ANGLE_EPSILON = 0.025;
const DIRECTION_SEND_INTERVAL_MS = 33;
const DIRECTION_SOURCE_PRIORITY = Object.freeze({
    mouse: 0,
    "gamepad-left": 3,
    "gamepad-right": 3,
    pointer: 2,
    "gamepad-dpad": 3,
    keyboard: 3
});

export function createInputState(socket) {
    const activeDirections = new Map();
    const lastTransientDirections = new Map();
    let activeDirectionSource = null;
    let lastDirectionSentAt = 0;
    let lastSentDirection = null;

    return {
        clearDirection,
        setDirection
    };

    function setDirection(source, angle, options = {}) {
        if (!Number.isFinite(angle)) {
            return;
        }

        const normalizedAngle = normalizeAngle(angle);

        if (options.transient) {
            setTransientDirection(source, normalizedAngle, options);
            return;
        }

        activeDirections.set(source, normalizedAngle);
        clearSupersededMouseDirection(source);

        if (!canSourceTakePriority(source)) {
            return;
        }

        const sourceChanged = activeDirectionSource !== source;
        activeDirectionSource = source;
        sendDirection(normalizedAngle, source, sourceChanged || options.force);
    }

    function setTransientDirection(source, angle, options = {}) {
        clearTransientDirectionState(source);

        if (!canSourceTakePriority(source) || !hasTransientDirectionChanged(source, angle)) {
            return;
        }

        if (!sendDirection(angle, source, options.force)) {
            return;
        }

        lastTransientDirections.set(source, angle);
    }

    function clearTransientDirectionState(source) {
        activeDirections.delete(source);

        if (activeDirectionSource === source) {
            activeDirectionSource = null;
        }
    }

    function clearDirection(source, options = {}) {
        if (!activeDirections.has(source) && !options.force) {
            if (options.silent) {
                lastTransientDirections.delete(source);
            }
            return;
        }

        activeDirections.delete(source);
        lastTransientDirections.delete(source);

        if (options.silent) {
            if (activeDirectionSource === source) {
                activeDirectionSource = null;
                lastSentDirection = null;
            }
            return;
        }

        if (activeDirectionSource !== source && activeDirectionSource !== null) {
            return;
        }

        const nextDirection = getHighestPriorityDirectionInput();

        if (nextDirection) {
            activeDirectionSource = nextDirection.source;
            sendDirection(nextDirection.angle, nextDirection.source, true);
            return;
        }

        activeDirectionSource = null;
        lastSentDirection = null;
        socket.emit("inputDirectionEnd");
    }

    function sendDirection(angle, source, force = false) {
        const now = performance.now();
        const changedEnough = lastSentDirection === null
            || Math.abs(getAngleDelta(lastSentDirection, angle)) >= DIRECTION_ANGLE_EPSILON;
        const canSend = now - lastDirectionSentAt >= DIRECTION_SEND_INTERVAL_MS;

        if (!force && (!changedEnough || !canSend)) {
            return false;
        }

        lastDirectionSentAt = now;
        lastSentDirection = angle;
        socket.emit("inputDirection", { angle, source });

        return true;
    }

    function canSourceTakePriority(source) {
        return activeDirectionSource === null
            || getSourcePriority(source) >= getSourcePriority(activeDirectionSource);
    }

    function clearSupersededMouseDirection(source) {
        if (
            source !== "mouse"
            && activeDirectionSource === "mouse"
            && getSourcePriority(source) > getSourcePriority("mouse")
        ) {
            activeDirections.delete("mouse");
        }
    }

    function getHighestPriorityDirectionInput() {
        let highestPriorityDirection = null;

        for (const [source, angle] of activeDirections.entries()) {
            if (
                !highestPriorityDirection
                || getSourcePriority(source) > getSourcePriority(highestPriorityDirection.source)
            ) {
                highestPriorityDirection = { source, angle };
            }
        }

        return highestPriorityDirection;
    }

    function hasTransientDirectionChanged(source, angle) {
        const lastDirection = lastTransientDirections.get(source);

        return lastDirection === undefined
            || Math.abs(getAngleDelta(lastDirection, angle)) >= DIRECTION_ANGLE_EPSILON;
    }
}

function getSourcePriority(source) {
    return DIRECTION_SOURCE_PRIORITY[source] || 0;
}
