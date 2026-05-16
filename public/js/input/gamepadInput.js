import { getDirectionalActionsAngle } from "./directionalInput.js";

const GAMEPAD_DPAD_BUTTONS = Object.freeze({
    12: "move-up",
    13: "move-down",
    14: "move-left",
    15: "move-right"
});
const GAMEPAD_DEAD_ZONE = 0.28;

export function registerGamepadDirectionInput(inputActionAngles, inputState, inputOwnership) {
    const pressedGamepadActions = new Set();
    let lockedGamepadSource = null;

    requestAnimationFrame(updateGamepadInput);

    function updateGamepadInput() {
        const gamepadInput = getGamepadInput();
        const nextSource = getLockedGamepadSource(gamepadInput);

        if (!nextSource) {
            releaseLockedGamepadSource();
            lockedGamepadSource = null;
            inputOwnership.release("gamepad");
            requestAnimationFrame(updateGamepadInput);
            return;
        }

        if (!inputOwnership.claim("gamepad")) {
            releaseLockedGamepadSource();
            lockedGamepadSource = null;
            requestAnimationFrame(updateGamepadInput);
            return;
        }

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
        pressedGamepadActions.clear();
        inputState.clearDirection("gamepad-dpad");
    }

    function updateGamepadActions(nextActions) {
        replacePressedGamepadActions(nextActions);

        const angle = getDirectionalActionsAngle(
            Array.from(pressedGamepadActions),
            inputActionAngles
        );

        if (angle === null) {
            return;
        }

        inputState.setDirection("gamepad-dpad", angle, { force: true });
    }

    function replacePressedGamepadActions(nextActions) {
        pressedGamepadActions.clear();

        for (const action of nextActions) {
            pressedGamepadActions.add(action);
        }
    }
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
