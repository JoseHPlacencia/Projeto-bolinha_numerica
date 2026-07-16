import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererUrl = new URL("../public/js/renderers/numberRenderer.js", import.meta.url);
const rendererSource = await readFile(rendererUrl, "utf8");
const testableSource = rendererSource
    .replace(/^import .*;\r?\n/gm, "")
    .replace("function getNumberColors", "export function getNumberColors")
    .replace("function getNumberFontSize", "export function getNumberFontSize")
    .replace("function isNearPlayer", "export function isNearPlayer");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`;
const { getNumberColors, getNumberFontSize, isNearPlayer } = await import(moduleUrl);

test("number colors derive varied stable hues from their spawn seed", () => {
    assert.deepEqual(
        getNumberColors(42, 1, true),
        {
            accent: "hsl(42 92% 68%)",
            fill: "hsl(42 72% 18%)",
            text: "hsl(42 55% 88%)"
        }
    );
    assert.notDeepEqual(getNumberColors(42, 1, true), getNumberColors(43, 1, true));
    assert.deepEqual(
        getNumberColors(42, 1, false),
        {
            accent: "hsl(42 78% 32%)",
            fill: "hsl(42 76% 88%)",
            text: "hsl(42 65% 24%)"
        }
    );
});

test("number typography remains readable across short and long values", () => {
    assert.equal(getNumberFontSize("7"), 30);
    assert.equal(getNumberFontSize("-8"), 30);
    assert.equal(getNumberFontSize("√99"), 26);
    assert.equal(getNumberFontSize("-1/2"), 23);
    assert.equal(getNumberFontSize("12345"), 20);
    assert.equal(getNumberFontSize("123456"), 20);
});

test("number proximity halo uses a bounded distance around the followed player", () => {
    const player = { x: 100, y: 200 };

    assert.equal(isNearPlayer(100, 650, player), true);
    assert.equal(isNearPlayer(100, 651, player), false);
    assert.equal(isNearPlayer(100, 200, null), false);
});
