import { registerGamepadDirectionInput } from "./input/gamepadInput.js";
import { createInputOwnership } from "./input/inputOwnership.js";
import { createInputState } from "./input/inputState.js";
import { registerKeyboardInput } from "./input/keyboardInput.js";
import { installGestureBlockers, registerPointerDirectionInput } from "./input/pointerInput.js";

export function createInputControls(socket, inputBindings, inputActionAngles, options = {}) {
    const inputOptions = {
        isEnabled: typeof options.isEnabled === "function"
            ? options.isEnabled
            : () => true
    };
    const inputSocket = createInputSocket(socket, inputOptions.isEnabled);
    const inputState = createInputState(inputSocket);
    const inputOwnership = createInputOwnership();
    const keyToAction = new Map(Object.entries(inputBindings));

    installGestureBlockers(inputOptions);
    registerKeyboardInput(keyToAction, inputActionAngles, inputState, inputOwnership, inputOptions);
    registerPointerDirectionInput(inputState, inputOptions);
    registerGamepadDirectionInput(inputActionAngles, inputState, inputOwnership, inputOptions);
}

function createInputSocket(socket, isEnabled) {
    return {
        emit(eventName, ...args) {
            if (typeof isEnabled === "function" && !isEnabled()) {
                return;
            }

            socket.emit(eventName, ...args);
        }
    };
}
