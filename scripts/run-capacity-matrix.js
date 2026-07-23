"use strict";

const { spawnSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
    assessCapacityReport,
    createCapacityScenarios
} = require("./lib/capacityMatrix");

const projectRoot = path.resolve(__dirname, "..");
const soakScript = path.join(__dirname, "run-bots-soak.js");
const defaultOutput = path.join(projectRoot, ".ai", "reports", "CAPACITY_MATRIX_LATEST.json");

main();

function main() {
    const options = parseArguments(process.argv.slice(2));
    const scenarioDirectory = path.join(path.dirname(options.output), "capacity-matrix-scenarios");
    const results = [];

    mkdirSync(scenarioDirectory, { recursive: true });

    for (const scenario of createCapacityScenarios()) {
        const output = path.join(scenarioDirectory, `${scenario.id}.json`);

        process.stdout.write(
            `\n[capacity] ${scenario.id}: ${scenario.playerCount} players, `
            + `${scenario.botCount} bots, ${scenario.numberCount} numbers\n`
        );
        runScenario(options, scenario, output);

        const report = JSON.parse(readFileSync(output, "utf8"));
        results.push({
            assessment: assessCapacityReport(report),
            output: path.relative(projectRoot, output),
            report,
            scenario
        });
    }

    const matrix = createMatrixReport(options, results);
    writeMatrixReport(options.output, matrix);
    printMatrixSummary(matrix, options.output);
}

function runScenario(options, scenario, output) {
    const argumentsList = [
        "--expose-gc",
        soakScript,
        "--bots", String(scenario.botCount),
        "--difficulty", "hard",
        "--map-size", String(scenario.mapSize),
        "--output", output,
        "--overlap-every", String(options.overlapEvery),
        "--pace", String(options.pace),
        "--players", String(scenario.playerCount),
        "--sample-every", String(options.sampleEvery),
        "--seed", String(options.seed),
        "--snapshots", "true",
        "--ticks", String(options.ticks),
        "--warmup", String(options.warmup)
    ];
    const result = spawnSync(process.execPath, argumentsList, {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });

    if (result.stdout) {
        process.stdout.write(result.stdout);
    }
    if (result.stderr) {
        process.stderr.write(result.stderr);
    }
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`Capacity scenario ${scenario.id} exited with code ${result.status}.`);
    }
}

function createMatrixReport(options, results) {
    const statuses = results.map(result => result.assessment.status);

    return {
        schema: 1,
        generatedAt: new Date().toISOString(),
        options: {
            overlapEvery: options.overlapEvery,
            pace: options.pace,
            sampleEvery: options.sampleEvery,
            seed: options.seed,
            ticks: options.ticks,
            warmup: options.warmup
        },
        status: statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "pass",
        scenarios: results.map(({ assessment, output, report, scenario }) => ({
            assessment,
            botCount: scenario.botCount,
            id: scenario.id,
            mapSize: scenario.mapSize,
            memory: report.memory,
            mode: scenario.mode,
            numberCount: scenario.numberCount,
            output,
            playerCount: scenario.playerCount,
            snapshots: report.snapshots,
            timing: report.timing
        }))
    };
}

function writeMatrixReport(output, report) {
    const markdownOutput = output.replace(/\.json$/i, ".md");

    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(markdownOutput, createMarkdownReport(report), "utf8");
}

function createMarkdownReport(report) {
    const rows = report.scenarios.map(scenario => {
        const tick = scenario.timing.tickDurationMs;
        const snapshotBatch = scenario.timing.phases.snapshots || {};

        return `| ${scenario.mapSize}x | ${scenario.mode} | ${scenario.playerCount} | ${scenario.botCount} | ${scenario.numberCount} | ${tick.p95} | ${tick.p99} | ${snapshotBatch.p99 ?? "-"} | ${formatBytes(scenario.snapshots.payloadBytesPerSec)}/s | ${formatBytes(scenario.snapshots.compressedPayloadBytesPerSec)}/s | ${scenario.assessment.status} |`;
    }).join("\n");

    return `# Matriz local de capacidade

Gerado em: ${report.generatedAt}  
Status: **${report.status}**  
Ticks medidos por cenário: ${report.options.ticks}  
Aquecimento por cenário: ${report.options.warmup} ticks  
Ritmada: ${report.options.pace ? "sim" : "não"}

| Mapa | Cenário | Jogadores | Bots | Números | Tick p95 ms | Tick p99 ms | Snapshot/lote p99 ms | Payload bruto | Payload comprimido | Estado |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows}

O cenário **mixed** mantém dois bots junto da lotação máxima como limite superior conservador. Em salas normais, os bots são removidos conforme humanos ocupam as vagas reservadas. O cenário **bot-heavy** respeita essa reserva e usa a maior quantidade de bots simultâneos permitida.
`;
}

function printMatrixSummary(report, output) {
    process.stdout.write(`\nCapacity matrix complete: ${report.status}.\n`);

    for (const scenario of report.scenarios) {
        const snapshotBatch = scenario.timing.phases.snapshots || {};
        process.stdout.write(
            `${scenario.id}: tick p99 ${scenario.timing.tickDurationMs.p99} ms, `
            + `snapshot batch p99 ${snapshotBatch.p99 ?? "n/a"} ms, `
            + `${scenario.assessment.status}.\n`
        );
    }
    process.stdout.write(`Report: ${output}\n`);
}

function parseArguments(argumentsList) {
    const values = new Map();
    const supported = new Set([
        "output",
        "overlap-every",
        "pace",
        "sample-every",
        "seed",
        "ticks",
        "warmup"
    ]);

    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        const [name, inlineValue] = argument.startsWith("--")
            ? argument.slice(2).split("=", 2)
            : [];

        if (!name || !supported.has(name)) {
            throw new Error(`Unknown capacity matrix option: ${argument}`);
        }

        const value = inlineValue === undefined ? argumentsList[++index] : inlineValue;
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`Missing value for --${name}.`);
        }
        values.set(name, value);
    }

    return {
        output: path.resolve(projectRoot, values.get("output") || defaultOutput),
        overlapEvery: getInteger(values.get("overlap-every"), 600, 1, "overlap-every"),
        pace: getBoolean(values.get("pace"), true, "pace"),
        sampleEvery: getInteger(values.get("sample-every"), 60, 1, "sample-every"),
        seed: getInteger(values.get("seed"), 0xb075500, 0, "seed", 0xffffffff),
        ticks: getInteger(values.get("ticks"), 3600, 1, "ticks"),
        warmup: getInteger(values.get("warmup"), 600, 0, "warmup")
    };
}

function getInteger(value, fallback, minimum, name, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = value === undefined ? fallback : Number(value);

    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return parsed;
}

function getBoolean(value, fallback, name) {
    if (value === undefined) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`--${name} must be true or false.`);
}

function formatBytes(value) {
    if (!Number.isFinite(value)) return "n/a";
    if (Math.abs(value) >= 1024 * 1024) return `${round(value / (1024 * 1024))} MiB`;
    if (Math.abs(value) >= 1024) return `${round(value / 1024)} KiB`;
    return `${round(value)} B`;
}

function round(value) {
    return Math.round(value * 1000) / 1000;
}
