import { getDirectionalActionsAngle } from "./directionalInput.js";

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

export function registerKeyboardInput(keyToAction, inputActionAngles, inputState, inputOwnership, options = {}) {
    const activeKeys = new Set();
    let lockedKeyboardGroup = null;
    let hasPendingDirectionUpdate = false;

    window.addEventListener("keydown", event => {
        if (!event.repeat) {
            sendInputDown(event);
        }
    });

    window.addEventListener("keyup", sendInputUp);
    window.addEventListener("blur", releaseKeyboardInput);

    function sendInputDown(event) {
        if (!isInputEnabled(options) || isEditableTarget(event.target)) {
            return;
        }

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

        if (!inputOwnership.claim("keyboard")) {
            return;
        }

        lockedKeyboardGroup = keyboardGroup;
        activeKeys.add(key);
        scheduleKeyboardDirectionUpdate();
    }

    function sendInputUp(event) {
        if (!isInputEnabled(options)) {
            releaseKeyboardInput();
            return;
        }

        if (isEditableTarget(event.target)) {
            return;
        }

        const key = getEventKey(event);
        const action = keyToAction.get(key);

        if (!action) {
            return;
        }

        event.preventDefault();

        if (!activeKeys.delete(key)) {
            return;
        }

        scheduleKeyboardDirectionUpdate();

        if (!hasActiveKeyboardGroupKey(lockedKeyboardGroup)) {
            lockedKeyboardGroup = null;
        }
    }

    function releaseKeyboardInput() {
        activeKeys.clear();
        lockedKeyboardGroup = null;
        inputState.clearDirection("keyboard");
        inputOwnership.release("keyboard");
    }

    function scheduleKeyboardDirectionUpdate() {
        if (hasPendingDirectionUpdate) {
            return;
        }

        hasPendingDirectionUpdate = true;

        requestAnimationFrame(() => {
            hasPendingDirectionUpdate = false;
            updateKeyboardDirection();
        });
    }

    function updateKeyboardDirection() {
        const activeActions = getActiveDirectionalActions();

        if (activeActions.length === 0) {
            inputState.clearDirection("keyboard");
            inputOwnership.release("keyboard");
            return;
        }

        const angle = getDirectionalActionsAngle(activeActions, inputActionAngles);

        if (angle === null) {
            return;
        }

        inputState.setDirection("keyboard", angle, { force: true });
    }

    function getActiveDirectionalActions() {
        const actions = [];

        for (const activeKey of activeKeys) {
            const activeAction = keyToAction.get(activeKey);

            if (activeAction && !actions.includes(activeAction)) {
                actions.push(activeAction);
            }
        }

        return actions;
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

function getKeyboardGroup(key) {
    return KEYBOARD_GROUPS[key] || null;
}

function getEventKey(event) {
    return event.key.toLowerCase();
}

function isEditableTarget(target) {
    if (!target || typeof target.closest !== "function") {
        return false;
    }

    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isInputEnabled(options) {
    return typeof options.isEnabled !== "function" || options.isEnabled();
}
