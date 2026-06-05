import "/shared/math.js";

const math = globalThis.GameMath;
const requiredUtilities = ["clamp", "lerp", "lerpAngle"];

if (!math) {
    throw new Error("GameMath must be loaded before client modules.");
}

for (const utility of requiredUtilities) {
    if (typeof math[utility] !== "function") {
        throw new Error(`GameMath.${utility} must be a function.`);
    }
}

export const { clamp, lerp, lerpAngle } = math;
