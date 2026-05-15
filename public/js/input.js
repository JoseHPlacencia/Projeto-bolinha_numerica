const DIRECTION_ANGLE_EPSILON = 0.025;
const DIRECTION_SEND_INTERVAL_MS = 33;
const DIRECTION_SOURCE_PRIORITY = Object.freeze({
    "gamepad-left": 1,
    "gamepad-right": 1,
    pointer: 2
});
const GAMEPAD_DPAD_BUTTONS = Object.freeze({
    12: "move-up",
    13: "move-down",
    14: "move-left",
    15: "move-right"
});
const GAMEPAD_DEAD_ZONE = 0.28;
const KEYBOARD_GROUPS = Object.freeze({
    arrowdown: "arrows",
    arrowleft: "arrows",
    arrowright: "arrows",
    arrowup: "arrows",
    a: "wasd",
    d: "wasd",
    s: "wasd",
    w: "wasd"
});
const POINTER_DEAD_ZONE = 18;
const POINTER_RADIUS_RATIO = 0.36;

export function createInputControls(socket, inputBindings) {
    const inputState = createInputState(socket);
    const keyToAction = new Map(Object.entries(inputBindings));

    installGestureBlockers();
    registerKeyboardInput(keyToAction, inputState);
    registerPointerDirectionInput(inputState);
    registerGamepadDirectionInput(inputState);
}

function registerKeyboardInput(keyToAction, inputState) {
    const activeKeys = new Set();
    let lockedKeyboardGroup = null;

    window.addEventListener("keydown", event => {
        if (!event.repeat) {
            sendInputDown(event);
        }
    });

    window.addEventListener("keyup", sendInputUp);
    window.addEventListener("blur", releaseKeyboardInput);

    function sendInputDown(event) {
        const key = getEventKey(event);
        const action = keyToAction.get(key);
        const keyboardGroup = getKeyboardGroup(key);

        if (!action) {
            return;
        }

        event.preventDefault();

        if (lockedKeyboardGroup && lockedKeyboardGroup !== keyboardGroup) {
            return;
        }

        if (activeKeys.has(key)) {
            return;
        }

        lockedKeyboardGroup = keyboardGroup;
        activeKeys.add(key);
        inputState.pressAction(action);
    }

    function sendInputUp(event) {
        const key = getEventKey(event);
        const action = keyToAction.get(key);

        if (!action) {
            return;
        }

        event.preventDefault();

        if (!activeKeys.delete(key)) {
            return;
        }

        inputState.releaseAction(action);

        if (!hasActiveKeyboardGroupKey(lockedKeyboardGroup)) {
            lockedKeyboardGroup = null;
        }
    }

    function releaseKeyboardInput() {
        activeKeys.clear();
        lockedKeyboardGroup = null;
        inputState.releaseAllActions();
    }

    function hasActiveKeyboardGroupKey(keyboardGroup) {
        for (const key of activeKeys) {
            if (getKeyboardGroup(key) === keyboardGroup) {
                return true;
            }
        }

        return false;
    }
}

function registerPointerDirectionInput(inputState) {
    const controls = document.getElementById("touchControls");
    const stick = document.getElementById("moveStick");
    const knob = document.getElementById("moveStickKnob");

    if (!controls || !stick || !knob) {
        return;
    }

    let activePointerId = null;
    let originX = 0;
    let originY = 0;

    window.addEventListener("pointerdown", startPointerInput);
    window.addEventListener("pointermove", updatePointerInput);
    window.addEventListener("pointerup", releasePointerInput);
    window.addEventListener("pointercancel", releasePointerInput);
    window.addEventListener("blur", resetPointerInput);

    function startPointerInput(event) {
        if (!canUsePointer(event) || activePointerId !== null) {
            return;
        }

        event.preventDefault();
        activePointerId = event.pointerId;
        originX = event.clientX;
        originY = event.clientY;

        controls.style.left = `${originX}px`;
        controls.style.top = `${originY}px`;
        controls.classList.add("is-active");
        updatePointerInput(event);
    }

    function updatePointerInput(event) {
        if (event.pointerId !== activePointerId) {
            return;
        }

        event.preventDefault();

        const deltaX = event.clientX - originX;
        const deltaY = event.clientY - originY;
        const radius = getStickRadius(stick);
        const distance = Math.hypot(deltaX, deltaY);
        const limitedDistance = Math.min(distance, radius);
        const angle = Math.atan2(deltaY, deltaX);
        const knobX = distance > 0 ? Math.cos(angle) * limitedDistance : 0;
        const knobY = distance > 0 ? Math.sin(angle) * limitedDistance : 0;

        knob.style.transform = `translate(${knobX}px, ${knobY}px)`;

        if (distance >= POINTER_DEAD_ZONE) {
            inputState.setDirection("pointer", angle);
        } else {
            inputState.clearDirection("pointer");
        }
    }

    function releasePointerInput(event) {
        if (event.pointerId !== activePointerId) {
            return;
        }

        event.preventDefault();
        resetPointerInput();
    }

    function resetPointerInput() {
        inputState.clearDirection("pointer", { force: true });
        activePointerId = null;
        knob.style.transform = "translate(0, 0)";
        controls.classList.remove("is-active");
    }
}

function registerGamepadDirectionInput(inputState) {
    const activeGamepadActions = new Set();
    let lockedGamepadSource = null;

    requestAnimationFrame(updateGamepadInput);

    function updateGamepadInput() {
        const gamepadInput = getGamepadInput();
        const nextSource = getLockedGamepadSource(gamepadInput);

        if (nextSource !== lockedGamepadSource) {
            releaseLockedGamepadSource();
            lockedGamepadSource = nextSource;
        }

        updateLockedGamepadInput(gamepadInput);

        requestAnimationFrame(updateGamepadInput);
    }

    function getLockedGamepadSource(gamepadInput) {
        if (lockedGamepadSource && isGamepadSourceActive(lockedGamepadSource, gamepadInput)) {
            return lockedGamepadSource;
        }

        if (gamepadInput.leftStick) {
            return "gamepad-left";
        }

        if (gamepadInput.rightStick) {
            return "gamepad-right";
        }

        if (gamepadInput.actions.size > 0) {
            return "gamepad-dpad";
        }

        return null;
    }

    function isGamepadSourceActive(source, gamepadInput) {
        if (source === "gamepad-left") {
            return Boolean(gamepadInput.leftStick);
        }

        if (source === "gamepad-right") {
            return Boolean(gamepadInput.rightStick);
        }

        return source === "gamepad-dpad" && gamepadInput.actions.size > 0;
    }

    function updateLockedGamepadInput(gamepadInput) {
        if (lockedGamepadSource === "gamepad-left") {
            updateGamepadDirection("gamepad-left", gamepadInput.leftStick);
            return;
        }

        if (lockedGamepadSource === "gamepad-right") {
            updateGamepadDirection("gamepad-right", gamepadInput.rightStick);
            return;
        }

        if (lockedGamepadSource === "gamepad-dpad") {
            updateGamepadActions(gamepadInput.actions);
        }
    }

    function releaseLockedGamepadSource() {
        if (lockedGamepadSource === "gamepad-left") {
            inputState.clearDirection("gamepad-left");
        } else if (lockedGamepadSource === "gamepad-right") {
            inputState.clearDirection("gamepad-right");
        } else if (lockedGamepadSource === "gamepad-dpad") {
            releaseGamepadActions();
        }
    }

    function updateGamepadDirection(source, direction) {
        if (direction) {
            inputState.setDirection(source, direction.angle);
        } else {
            inputState.clearDirection(source);
        }
    }

    function releaseGamepadActions() {
        for (const action of activeGamepadActions) {
            inputState.releaseAction(action);
        }

        activeGamepadActions.clear();
    }

    function updateGamepadActions(nextActions) {
        for (const action of nextActions) {
            if (!activeGamepadActions.has(action)) {
                activeGamepadActions.add(action);
                inputState.pressAction(action);
            }
        }

        for (const action of activeGamepadActions) {
            if (!nextActions.has(action)) {
                activeGamepadActions.delete(action);
                inputState.releaseAction(action);
            }
        }
    }
}

function createInputState(socket) {
    const activeActionCounts = new Map();
    const activeDirections = new Map();
    let activeDirectionSource = null;
    let lastDirectionSentAt = 0;
    let lastSentDirection = null;

    return {
        clearDirection,
        pressAction,
        releaseAction,
        releaseAllActions,
        setDirection
    };

    function pressAction(action) {
        const activeCount = activeActionCounts.get(action) || 0;
        activeActionCounts.set(action, activeCount + 1);

        if (activeCount === 0) {
            socket.emit("inputDown", action);
        }
    }

    function releaseAction(action) {
        if (!activeActionCounts.has(action)) {
            return;
        }

        const nextCount = activeActionCounts.get(action) - 1;

        if (nextCount > 0) {
            activeActionCounts.set(action, nextCount);
            return;
        }

        activeActionCounts.delete(action);
        socket.emit("inputUp", action);
    }

    function releaseAllActions() {
        for (const action of activeActionCounts.keys()) {
            socket.emit("inputUp", action);
        }

        activeActionCounts.clear();
    }

    function setDirection(source, angle) {
        if (!Number.isFinite(angle)) {
            return;
        }

        const normalizedAngle = normalizeAngle(angle);
        activeDirections.set(source, normalizedAngle);

        if (!canSourceTakePriority(source)) {
            return;
        }

        activeDirectionSource = source;
        sendDirection(normalizedAngle);
    }

    function clearDirection(source, options = {}) {
        if (!activeDirections.has(source) && !options.force) {
            return;
        }

        activeDirections.delete(source);

        if (activeDirectionSource !== source && activeDirectionSource !== null) {
            return;
        }

        const nextDirection = getHighestPriorityDirectionInput();

        if (nextDirection) {
            activeDirectionSource = nextDirection.source;
            sendDirection(nextDirection.angle, true);
            return;
        }

        activeDirectionSource = null;
        lastSentDirection = null;
        socket.emit("inputDirectionEnd");
    }

    function sendDirection(angle, force = false) {
        const now = performance.now();
        const changedEnough = lastSentDirection === null
            || Math.abs(getAngleDelta(lastSentDirection, angle)) >= DIRECTION_ANGLE_EPSILON;
        const canSend = now - lastDirectionSentAt >= DIRECTION_SEND_INTERVAL_MS;

        if (!force && (!changedEnough || !canSend)) {
            return;
        }

        lastDirectionSentAt = now;
        lastSentDirection = angle;
        socket.emit("inputDirection", angle);
    }

    function canSourceTakePriority(source) {
        return activeDirectionSource === null
            || getSourcePriority(source) >= getSourcePriority(activeDirectionSource);
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
}

function getSourcePriority(source) {
    return DIRECTION_SOURCE_PRIORITY[source] || 0;
}

function getGamepadInput() {
    const input = {
        actions: new Set(),
        leftStick: null,
        rightStick: null
    };

    if (!navigator.getGamepads) {
        return input;
    }

    for (const gamepad of navigator.getGamepads()) {
        if (!gamepad || !gamepad.connected) {
            continue;
        }

        input.leftStick = input.leftStick || getGamepadStickDirection(gamepad, 0, 1);
        input.rightStick = input.rightStick || getGamepadStickDirection(gamepad, 2, 3);
        addGamepadActions(input.actions, gamepad);
    }

    return input;
}

function getGamepadStickDirection(gamepad, xAxisIndex, yAxisIndex) {
    if (gamepad.axes.length <= yAxisIndex) {
        return null;
    }

    const x = applyDeadZone(gamepad.axes[xAxisIndex] || 0, GAMEPAD_DEAD_ZONE);
    const y = applyDeadZone(gamepad.axes[yAxisIndex] || 0, GAMEPAD_DEAD_ZONE);
    const magnitude = Math.hypot(x, y);

    if (magnitude < GAMEPAD_DEAD_ZONE) {
        return null;
    }

    return {
        angle: Math.atan2(y, x),
        magnitude
    };
}

function addGamepadActions(actions, gamepad) {
    for (const [buttonIndex, action] of Object.entries(GAMEPAD_DPAD_BUTTONS)) {
        if (isGamepadButtonPressed(gamepad.buttons[Number(buttonIndex)])) {
            actions.add(action);
        }
    }
}

function isGamepadButtonPressed(button) {
    return Boolean(button && button.pressed);
}

function applyDeadZone(value, deadZone) {
    return Math.abs(value) >= deadZone ? value : 0;
}

function canUsePointer(event) {
    if (event.pointerType === "mouse") {
        return event.button === 0;
    }

    return event.pointerType === "touch" || event.pointerType === "pen";
}

function getStickRadius(stick) {
    return stick.getBoundingClientRect().width * POINTER_RADIUS_RATIO;
}

function installGestureBlockers() {
    document.addEventListener("gesturestart", preventDefault, { passive: false });
    document.addEventListener("gesturechange", preventDefault, { passive: false });
    document.addEventListener("gestureend", preventDefault, { passive: false });
    document.addEventListener("touchmove", preventDefault, { passive: false });
}

function normalizeAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function getAngleDelta(currentAngle, targetAngle) {
    return normalizeAngle(targetAngle - currentAngle);
}

function preventDefault(event) {
    event.preventDefault();
}

function getKeyboardGroup(key) {
    return KEYBOARD_GROUPS[key] || null;
}

function getEventKey(event) {
    return event.key.toLowerCase();
}
