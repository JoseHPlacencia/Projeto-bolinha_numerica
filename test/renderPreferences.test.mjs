import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const renderSettings = await importSource("../public/js/renderSettings.js");
const visualTheme = await importSource("../public/js/visualTheme.js");

test("FPS settings accept 90 FPS and preserve the 60 FPS fallback", () => {
    assert.equal(renderSettings.normalizeFpsLimit(90), 90);
    assert.equal(renderSettings.normalizeFpsLimit("90"), 90);
    assert.equal(renderSettings.normalizeFpsLimit(75), 60);
});

test("automatic FPS selection chooses the nearest supported limit", () => {
    assert.equal(renderSettings.getClosestSupportedFpsLimit(30), 30);
    assert.equal(renderSettings.getClosestSupportedFpsLimit(59.94), 60);
    assert.equal(renderSettings.getClosestSupportedFpsLimit(75), 60);
    assert.equal(renderSettings.getClosestSupportedFpsLimit(76), 90);
    assert.equal(renderSettings.getClosestSupportedFpsLimit(100), 90);
    assert.equal(renderSettings.getClosestSupportedFpsLimit(120), 120);
    assert.equal(renderSettings.getClosestSupportedFpsLimit(144), 120);
    assert.equal(renderSettings.getClosestSupportedFpsLimit(null), 60);
});

test("refresh-rate sampling recognizes a 90 Hz display", async () => {
    let timestamp = 0;
    let nextFrameId = 0;
    const cancelledFrames = new Set();

    const fpsLimit = await renderSettings.detectPreferredFpsLimit({
        cancelAnimationFrame(frameId) {
            cancelledFrames.add(frameId);
        },
        documentVisible: true,
        requestAnimationFrame(callback) {
            const frameId = ++nextFrameId;
            queueMicrotask(() => {
                if (cancelledFrames.has(frameId)) return;
                timestamp += 1000 / 90;
                callback(timestamp);
            });
            return frameId;
        },
        sampleDurationMs: 120
    });

    assert.equal(fpsLimit, 90);
});

test("refresh-rate detection falls back to 60 FPS when sampling is unavailable", async () => {
    assert.equal(await renderSettings.detectPreferredFpsLimit({
        documentVisible: true,
        requestAnimationFrame: null
    }), 60);
    assert.equal(await renderSettings.detectPreferredFpsLimit({
        documentVisible: false,
        requestAnimationFrame() {}
    }), 60);
});

test("90 FPS limiting keeps a 90 FPS average on a 120 Hz timeline", () => {
    const gameConfig = {
        renderingSettings: {
            fpsLimit: 90
        }
    };
    const limiter = renderSettings.createRenderFrameLimiter(() => gameConfig);
    let renderedFrames = 0;

    for (let frame = 0; frame <= 120; frame++) {
        if (limiter.shouldRender(frame * 1000 / 120)) {
            renderedFrames++;
        }
    }

    assert.ok(renderedFrames >= 90 && renderedFrames <= 91, String(renderedFrames));
});

test("an unknown visual theme falls back to dark", () => {
    assert.equal(visualTheme.normalizeVisualTheme("light"), "light");
    assert.equal(visualTheme.normalizeVisualTheme("dark"), "dark");
    assert.equal(visualTheme.normalizeVisualTheme(undefined), "dark");
});

async function importSource(relativePath) {
    const sourceUrl = new URL(relativePath, import.meta.url);
    const source = await readFile(sourceUrl, "utf8");
    const encodedSource = Buffer.from(source).toString("base64");

    return import(`data:text/javascript;base64,${encodedSource}`);
}
