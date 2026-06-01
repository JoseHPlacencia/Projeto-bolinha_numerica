export function createHud({ debugLevel }) {
    const debugPanel = document.getElementById("debugPanel");
    const debugFps = document.getElementById("debugFps");
<<<<<<< HEAD
=======
    const debugRenderFps = document.getElementById("debugRenderFps");
>>>>>>> 70aca42 (teste)
    const debugBuffer = document.getElementById("debugBuffer");
    const debugCanvas = document.getElementById("debugCanvas");
    const debugFrame = document.getElementById("debugFrame");
    const debugSnapshots = document.getElementById("debugSnapshots");
    const debugPixelRatio = document.getElementById("debugPixelRatio");
    const debugDirectionSource = document.getElementById("debugDirectionSource");
    const debugDirectionAngleRad = document.getElementById("debugDirectionAngleRad");
    const debugDirectionAngleDeg = document.getElementById("debugDirectionAngleDeg");
    const debugPlayerAngleRad = document.getElementById("debugPlayerAngleRad");
    const debugPlayerAngleDeg = document.getElementById("debugPlayerAngleDeg");
    const debugInputAngleDeltaRad = document.getElementById("debugInputAngleDeltaRad");
    const debugInputAngleDeltaDeg = document.getElementById("debugInputAngleDeltaDeg");
    const debugBoundaryRelation = document.getElementById("debugBoundaryRelation");
    const debugBoundarySlideDirection = document.getElementById("debugBoundarySlideDirection");
    const debugTouchingBoundary = document.getElementById("debugTouchingBoundary");
    const debugInputAccepted = document.getElementById("debugInputAccepted");
    const debugBoundaryDecision = document.getElementById("debugBoundaryDecision");
    let lastUpdatedAt = 0;

    if (debugPanel) {
        debugPanel.hidden = debugLevel <= 0;
        updateDebugLevelRows();
    }

    return {
        update
    };

    function update({ frameStats, rendererStats, snapshotStats, playerDebug }) {
        if (debugLevel <= 0) {
            return;
        }

        const now = performance.now();

        if (now - lastUpdatedAt < 200) {
            return;
        }

        lastUpdatedAt = now;
        setText(debugFps, frameStats.fps);
<<<<<<< HEAD
=======
        setText(debugRenderFps, getRenderFps(frameStats, rendererStats));
>>>>>>> 70aca42 (teste)
        setText(debugFrame, `${frameStats.frameMs.toFixed(1)}ms`);
        setText(debugBuffer, `${Math.round(snapshotStats.bufferMs)}ms`);
        setText(debugSnapshots, snapshotStats.snapshotCount);
        setText(debugPixelRatio, rendererStats.pixelRatio.toFixed(2));
        setText(debugCanvas, `${rendererStats.canvasWidth}x${rendererStats.canvasHeight}`);
        updateMovementDebug(playerDebug);
    }

<<<<<<< HEAD
=======
    function getRenderFps(frameStats, rendererStats) {
        if (rendererStats && rendererStats.mode === "worker") {
            return Number.isFinite(rendererStats.workerFps) ? rendererStats.workerFps : 0;
        }

        return frameStats.fps;
    }

>>>>>>> 70aca42 (teste)
    function updateDebugLevelRows() {
        const debugLevelRows = debugPanel.querySelectorAll("[data-debug-level]");

        for (const row of debugLevelRows) {
            row.hidden = Number(row.dataset.debugLevel) !== debugLevel;
        }
    }

    function updateMovementDebug(debug) {
        if (debugLevel < 2) {
            return;
        }

        setText(debugDirectionSource, formatText(debug && debug.directionSource));
        setText(debugDirectionAngleRad, formatNumber(debug && debug.directionAngleRad));
        setText(debugDirectionAngleDeg, formatNumber(debug && debug.directionAngleDeg, 1));
        setText(debugPlayerAngleRad, formatNumber(debug && debug.playerAngleRad));
        setText(debugPlayerAngleDeg, formatNumber(debug && debug.playerAngleDeg, 1));
        setText(debugInputAngleDeltaRad, formatNumber(debug && debug.inputAngleDeltaRad));
        setText(debugInputAngleDeltaDeg, formatNumber(debug && debug.inputAngleDeltaDeg, 1));
        setText(debugBoundaryRelation, formatText(debug && debug.boundaryInputRelation));
        setText(debugBoundarySlideDirection, formatText(debug && debug.boundarySlideDirection));
        setText(debugTouchingBoundary, formatBoolean(debug && debug.isTouchingBoundary));
        setText(debugInputAccepted, formatBoolean(debug && debug.inputAccepted));
        setText(debugBoundaryDecision, formatText(debug && debug.boundarySlideDecision));
    }
}

function setText(element, value) {
    if (element) {
        element.textContent = String(value);
    }
}

function formatText(value) {
    return value === null || value === undefined || value === "" ? "-" : value;
}

function formatNumber(value, fractionDigits = 3) {
    return Number.isFinite(value) ? value.toFixed(fractionDigits) : "-";
}

function formatBoolean(value) {
    if (value === true) {
        return "yes";
    }

    if (value === false) {
        return "no";
    }

    return "-";
}
