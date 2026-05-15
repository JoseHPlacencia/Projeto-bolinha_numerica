export function createHud({ debugEnabled }) {
    const debugPanel = document.getElementById("debugPanel");
    const debugFps = document.getElementById("debugFps");
    const debugBuffer = document.getElementById("debugBuffer");
    const debugCanvas = document.getElementById("debugCanvas");
    const debugFrame = document.getElementById("debugFrame");
    const debugSnapshots = document.getElementById("debugSnapshots");
    const debugPixelRatio = document.getElementById("debugPixelRatio");
    let lastUpdatedAt = 0;

    if (debugPanel) {
        debugPanel.hidden = !debugEnabled;
    }

    return {
        update
    };

    function update({ frameStats, rendererStats, snapshotStats }) {
        if (!debugEnabled) {
            return;
        }

        const now = performance.now();

        if (now - lastUpdatedAt < 200) {
            return;
        }

        lastUpdatedAt = now;
        setText(debugFps, frameStats.fps);
        setText(debugFrame, `${frameStats.frameMs.toFixed(1)}ms`);
        setText(debugBuffer, `${Math.round(snapshotStats.bufferMs)}ms`);
        setText(debugSnapshots, snapshotStats.snapshotCount);
        setText(debugPixelRatio, rendererStats.pixelRatio.toFixed(2));
        setText(debugCanvas, `${rendererStats.canvasWidth}x${rendererStats.canvasHeight}`);
    }
}

function setText(element, value) {
    if (element) {
        element.textContent = String(value);
    }
}
