"use strict";

const { readdirSync, statSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sourceGroups = Object.freeze({
    client: ["public"],
    server: ["server.js", "src", "scripts"],
    shared: ["src/utils/math.js", "public/js/sharedMath.js"]
});

const requestedGroup = process.argv[2] || "all";
const sourcePaths = getSourcePaths(requestedGroup);
const files = collectJavaScriptFiles(sourcePaths);

for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
        cwd: projectRoot,
        stdio: "inherit"
    });

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

console.log(`Syntax check passed (${files.length} files, group: ${requestedGroup}).`);

function getSourcePaths(group) {
    if (group === "all") {
        return [...new Set(Object.values(sourceGroups).flat())];
    }

    if (!Object.prototype.hasOwnProperty.call(sourceGroups, group)) {
        const validGroups = ["all", ...Object.keys(sourceGroups)].join(", ");
        throw new Error(`Unknown syntax-check group "${group}". Use one of: ${validGroups}.`);
    }

    return sourceGroups[group];
}

function collectJavaScriptFiles(sourcePathsToScan) {
    const filesFound = new Set();

    for (const sourcePath of sourcePathsToScan) {
        collectPath(path.join(projectRoot, sourcePath), filesFound);
    }

    return [...filesFound].sort((first, second) => first.localeCompare(second));
}

function collectPath(absolutePath, filesFound) {
    const stats = statSync(absolutePath);

    if (stats.isFile()) {
        if (isJavaScriptFile(absolutePath)) {
            filesFound.add(absolutePath);
        }
        return;
    }

    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
        const entryPath = path.join(absolutePath, entry.name);

        if (entry.isDirectory()) {
            collectPath(entryPath, filesFound);
        } else if (entry.isFile() && isJavaScriptFile(entryPath)) {
            filesFound.add(entryPath);
        }
    }
}

function isJavaScriptFile(filePath) {
    return filePath.endsWith(".js") || filePath.endsWith(".mjs");
}
