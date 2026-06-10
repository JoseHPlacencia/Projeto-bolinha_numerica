import { registerGamepadDirectionInput } from "./input/gamepadInput.js";
import { createInputOwnership } from "./input/inputOwnership.js";
import { createInputState } from "./input/inputState.js";
import { registerKeyboardInput } from "./input/keyboardInput.js";
import { installGestureBlockers, registerPointerDirectionInput } from "./input/pointerInput.js";

export function createInputControls(socket, inputBindings, inputActionAngles, options = {}) {
    const inputState = createInputState(socket);
    const inputOwnership = createInputOwnership();
    const keyToAction = new Map(Object.entries(inputBindings));
    const inputOptions = {
        isEnabled: typeof options.isEnabled === "function"
            ? options.isEnabled
            : () => true
    };

    installGestureBlockers(inputOptions);
    registerKeyboardInput(keyToAction, inputActionAngles, inputState, inputOwnership, inputOptions);
    registerPointerDirectionInput(inputState, inputOptions);
    registerGamepadDirectionInput(inputActionAngles, inputState, inputOwnership, inputOptions);
}
