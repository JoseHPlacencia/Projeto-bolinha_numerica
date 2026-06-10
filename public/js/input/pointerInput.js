const POINTER_DEAD_ZONE = 18;
const POINTER_RADIUS_RATIO = 0.36;

export function registerPointerDirectionInput(inputState, options = {}) {
    const controls = document.getElementById("touchControls");
    const stick = document.getElementById("moveStick");
    const knob = document.getElementById("moveStickKnob");

    if (!controls || !stick || !knob) {
        return;
    }

    let activePointerId = null;
    let originX = 0;
    let originY = 0;
    let pendingSource = null;
    let pendingDeltaX = 0;
    let pendingDeltaY = 0;
    let pendingUpdateKnob = false;
    let pendingFrame = null;
    let stickRadius = getStickRadius(stick);
    let viewportCenterX = window.innerWidth / 2;
    let viewportCenterY = window.innerHeight / 2;

    window.addEventListener("mousemove", updateMouseInput, { passive: true });
    window.addEventListener("pointerdown", startPointerInput);
    window.addEventListener("pointermove", updatePointerInput);
    window.addEventListener("pointerup", releasePointerInput);
    window.addEventListener("pointercancel", releasePointerInput);
    window.addEventListener("resize", updatePointerMetrics);
    window.addEventListener("blur", resetPointerInputs);

    function updateMouseInput(event) {
        if (!isInputEnabled(options)) {
            inputState.clearDirection("mouse");
            return;
        }

        if (activePointerId !== null) {
            return;
        }

        queueDirectionUpdate(
            "mouse",
            event.clientX - viewportCenterX,
            event.clientY - viewportCenterY
        );
    }

    function startPointerInput(event) {
        if (!isInputEnabled(options)) {
            return;
        }

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

        queuePointerInput(event);
    }

    function updatePointerInput(event) {
        if (!isInputEnabled(options)) {
            resetPointerInput();
            return;
        }

        if (event.pointerId !== activePointerId) {
            return;
        }

        event.preventDefault();

        queuePointerInput(event);
    }

    function releasePointerInput(event) {
        if (!isInputEnabled(options)) {
            resetPointerInput();
            return;
        }

        if (event.pointerId !== activePointerId) {
            return;
        }

        event.preventDefault();
        resetPointerInput();
    }

    function resetPointerInput() {
        inputState.clearDirection("pointer", { force: true });
        clearPendingDirectionUpdate("pointer");
        activePointerId = null;
        knob.style.transform = "translate(0, 0)";
        controls.classList.remove("is-active");
    }

    function resetPointerInputs() {
        resetPointerInput();
        clearPendingDirectionUpdate();
        inputState.clearDirection("mouse", { force: true });
    }

    function queuePointerInput(event) {
        queueDirectionUpdate("pointer", event.clientX - originX, event.clientY - originY, true);
    }

    function queueDirectionUpdate(source, deltaX, deltaY, updateKnob = false) {
        pendingSource = source;
        pendingDeltaX = deltaX;
        pendingDeltaY = deltaY;
        pendingUpdateKnob = updateKnob;

        if (pendingFrame !== null) {
            return;
        }

        pendingFrame = requestNextFrame(processPendingDirectionUpdate);
    }

    function processPendingDirectionUpdate() {
        const source = pendingSource;
        const deltaX = pendingDeltaX;
        const deltaY = pendingDeltaY;
        const updateKnob = pendingUpdateKnob;

        pendingFrame = null;
        pendingSource = null;

        if (!source) {
            return;
        }

        updateDirectionFromDelta(source, deltaX, deltaY, updateKnob);
    }

    function clearPendingDirectionUpdate(source = null) {
        if (!source || pendingSource === source) {
            pendingSource = null;
        }
    }

    function updateDirectionFromDelta(source, deltaX, deltaY, updateKnob = false) {
        const distance = Math.hypot(deltaX, deltaY);
        let angle = Math.atan2(deltaY, deltaX);

        if (updateKnob) {
            const limitedDistance = Math.min(distance, stickRadius);
            const knobX = distance > 0 ? Math.cos(angle) * limitedDistance : 0;
            const knobY = distance > 0 ? Math.sin(angle) * limitedDistance : 0;
            knob.style.transform = `translate(${knobX}px, ${knobY}px)`;
        }

        if (distance >= POINTER_DEAD_ZONE) {
            inputState.setDirection(source, angle, {
                transient: source === "mouse"
            });
        } else {
            inputState.clearDirection(source);
        }
    }

    function updatePointerMetrics() {
        stickRadius = getStickRadius(stick);
        viewportCenterX = window.innerWidth / 2;
        viewportCenterY = window.innerHeight / 2;
    }
}

export function installGestureBlockers(options = {}) {
    document.addEventListener("gesturestart", event => preventDefaultWhenEnabled(event, options), { passive: false });
    document.addEventListener("gesturechange", event => preventDefaultWhenEnabled(event, options), { passive: false });
    document.addEventListener("gestureend", event => preventDefaultWhenEnabled(event, options), { passive: false });
    document.addEventListener("touchmove", event => preventDefaultWhenEnabled(event, options), { passive: false });
}

function canUsePointer(event) {
    return event.pointerType === "touch" || event.pointerType === "pen";
}

function getStickRadius(stick) {
    return stick.getBoundingClientRect().width * POINTER_RADIUS_RATIO;
}

function preventDefaultWhenEnabled(event, options) {
    if (isInputEnabled(options)) {
        event.preventDefault();
    }
}

function isInputEnabled(options) {
    return typeof options.isEnabled !== "function" || options.isEnabled();
}

function requestNextFrame(callback) {
    if (typeof requestAnimationFrame === "function") {
        return requestAnimationFrame(callback);
    }

    return setTimeout(callback, 1000 / 60);
}
