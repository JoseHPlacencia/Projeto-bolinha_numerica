const POINTER_DEAD_ZONE = 18;
const POINTER_RADIUS_RATIO = 0.36;

export function registerPointerDirectionInput(inputState) {
    const controls = document.getElementById("touchControls");
    const stick = document.getElementById("moveStick");
    const knob = document.getElementById("moveStickKnob");

    if (!controls || !stick || !knob) {
        return;
    }

    let activePointerId = null;
    let originX = 0;
    let originY = 0;

    window.addEventListener("mousemove", updateMouseInput);
    window.addEventListener("pointerdown", startPointerInput);
    window.addEventListener("pointermove", updatePointerInput);
    window.addEventListener("pointerup", releasePointerInput);
    window.addEventListener("pointercancel", releasePointerInput);
    window.addEventListener("blur", resetPointerInputs);

    function updateMouseInput(event) {
        if (activePointerId !== null) {
            return;
        }

        updateDirectionFromDelta(
            "mouse",
            event.clientX - window.innerWidth / 2,
            event.clientY - window.innerHeight / 2
        );
    }

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

        updateDirectionFromDelta("pointer", event.clientX - originX, event.clientY - originY, true);
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

    function resetPointerInputs() {
        resetPointerInput();
        inputState.clearDirection("mouse", { force: true });
    }

    function updateDirectionFromDelta(source, deltaX, deltaY, updateKnob = false) {
        const radius = getStickRadius(stick);
        const distance = Math.hypot(deltaX, deltaY);
        const limitedDistance = Math.min(distance, radius);
        const angle = Math.atan2(deltaY, deltaX);

        if (updateKnob) {
            const knobX = distance > 0 ? Math.cos(angle) * limitedDistance : 0;
            const knobY = distance > 0 ? Math.sin(angle) * limitedDistance : 0;
            knob.style.transform = `translate(${knobX}px, ${knobY}px)`;
        }

        if (distance >= POINTER_DEAD_ZONE) {
            inputState.setDirection(source, angle);
        } else {
            inputState.clearDirection(source);
        }
    }
}

export function installGestureBlockers() {
    document.addEventListener("gesturestart", preventDefault, { passive: false });
    document.addEventListener("gesturechange", preventDefault, { passive: false });
    document.addEventListener("gestureend", preventDefault, { passive: false });
    document.addEventListener("touchmove", preventDefault, { passive: false });
}

function canUsePointer(event) {
    return event.pointerType === "touch" || event.pointerType === "pen";
}

function getStickRadius(stick) {
    return stick.getBoundingClientRect().width * POINTER_RADIUS_RATIO;
}

function preventDefault(event) {
    event.preventDefault();
}
