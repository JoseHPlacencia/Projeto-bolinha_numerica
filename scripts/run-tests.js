"use strict";

const { readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const testDirectory = path.join(projectRoot, "test");
const testFiles = readdirSync(testDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.test\.(?:js|mjs)$/.test(entry.name))
    .map(entry => path.join("test", entry.name))
    .sort((first, second) => first.localeCompare(second));

if (testFiles.length === 0) {
    throw new Error("No versioned test files were found in test/.");
}

const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", ...testFiles],
    {
        cwd: projectRoot,
        stdio: "inherit"
    }
);

if (result.error) {
    throw result.error;
}

process.exitCode = result.status === null ? 1 : result.status;
