const config = require("../config/gameConfig");

function applyPlayerInput(players, playerId, inputType, payload) {
    const player = players && players.get(playerId);
    if (!player) return false;

    switch (inputType) {
        case "down":
            return applyInputDown(player, payload);
        case "up":
            return applyInputUp(player, payload);
        case "direction":
            return applyInputDirection(player, payload);
        case "directionEnd":
            player.clearDirectionAngle();
            return true;
        case "viewport":
            return applyViewport(player, payload);
        default:
            return false;
    }
}

function applyInputDown(player, rawAction) {
    const action = normalizeInputAction(rawAction);
    if (!isInputActionValid(action)) return false;
    player.pressAction(action);
    return true;
}

function applyInputUp(player, rawAction) {
    const action = normalizeInputAction(rawAction);
    if (!isInputActionValid(action)) return false;
    player.releaseAction(action);
    return true;
}

function applyInputDirection(player, rawInput) {
    const input = normalizeInputDirection(rawInput);
    if (!input) return false;
    player.setDirectionAngle(input.angle, input.source);
    return true;
}

function applyViewport(player, rawViewport) {
    const viewport = normalizeViewport(rawViewport);
    if (!viewport) return false;
    player.setViewport(viewport);
    return true;
}

function normalizeInputAction(action) {
    return String(action || "").toLowerCase();
}

function isInputActionValid(action) {
    return Object.prototype.hasOwnProperty.call(config.inputActionAngles, action);
}

function normalizeInputDirection(rawInput) {
    const rawAngle = isInputDirectionPayload(rawInput) ? rawInput.angle : rawInput;
    const angle = normalizeInputAngle(rawAngle);
    if (angle === null) return null;
    return {
        angle,
        source: isInputDirectionPayload(rawInput)
            ? normalizeInputSource(rawInput.source)
            : null
    };
}

function isInputDirectionPayload(rawInput) {
    return rawInput !== null && typeof rawInput === "object";
}

function normalizeInputAngle(rawAngle) {
    const angle = Number(rawAngle);
    if (!Number.isFinite(angle)) return null;
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function normalizeInputSource(rawSource) {
    const source = String(rawSource || "").toLowerCase();
    return isInputSourceValid(source) ? source : null;
}

function isInputSourceValid(source) {
    return source === "mouse"
        || source === "pointer"
        || source === "keyboard"
        || source === "gamepad-left"
        || source === "gamepad-right"
        || source === "gamepad-dpad";
}

function normalizeViewport(rawViewport) {
    if (!rawViewport || typeof rawViewport !== "object") return null;
    const width = clampNumber(Number(rawViewport.width), 1, config.screen.virtualWidth * 2);
    const height = clampNumber(Number(rawViewport.height), 1, config.screen.virtualHeight * 2);
    const scale = clampNumber(Number(rawViewport.scale), 0.05, 4);
    if (width === null || height === null || scale === null) return null;
    return { width, height, scale };
}

function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) return null;
    return Math.min(Math.max(value, min), max);
}

module.exports = {
    applyPlayerInput,
    normalizeInputDirection,
    normalizeViewport
};
