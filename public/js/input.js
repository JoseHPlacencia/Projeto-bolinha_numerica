import { registerGamepadDirectionInput } from "./input/gamepadInput.js";
import { createInputOwnership } from "./input/inputOwnership.js";
import { createInputState } from "./input/inputState.js";
import { registerKeyboardInput } from "./input/keyboardInput.js";
import { installGestureBlockers, registerPointerDirectionInput } from "./input/pointerInput.js";

export function createInputControls(socket, inputBindings, inputActionAngles) {
    const inputState = createInputState(socket);
    const inputOwnership = createInputOwnership();
    const keyToAction = new Map(Object.entries(inputBindings));

    installGestureBlockers();
    registerKeyboardInput(keyToAction, inputActionAngles, inputState, inputOwnership);
    registerPointerDirectionInput(inputState);
    registerGamepadDirectionInput(inputActionAngles, inputState, inputOwnership);

    // Expõe desabilitar/habilitar para que gameClient.js possa bloquear
    // o movimento do jogador enquanto a tela de morte estiver ativa.
    return {
        desabilitar: () => inputState.desabilitar(),
        habilitar: () => inputState.habilitar()
    };
}
