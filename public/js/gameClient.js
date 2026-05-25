import { createFrameMonitor, getDebugLevel } from "./debug.js";
import { createHud } from "./hud.js";
import { createInputControls } from "./input.js";
import { createMinimapRenderer } from "./renderers/minimapRenderer.js";
import { createSnapshotInterpolator } from "./snapshotInterpolator.js";
import { createCanvasRenderer } from "./renderer.js";

export function startClient(gameConfig) {
    const socket = io({
        transports: gameConfig.socket.transports
    });
    const canvas = document.getElementById("gameCanvas");
    const minimapCanvas = document.getElementById("minimapCanvas");
    const renderer = createCanvasRenderer(canvas, gameConfig);
    const minimap = createMinimapRenderer(minimapCanvas, gameConfig);
    const snapshots = createSnapshotInterpolator(gameConfig.network, {
        onResyncNeeded: () => socket.emit("snapshotResync")
    });
    const debugLevel = getDebugLevel();
    const hud = createHud({ debugLevel });
    const frameMonitor = createFrameMonitor();
    let myId = null;
    let lastViewportSentAt = 0;

    createInputControls(socket, gameConfig.inputBindings, gameConfig.inputActionAngles);
    window.addEventListener("resize", resizeCanvases);

    socket.on("connect", () => {
        myId = socket.id;
        sendViewportState(true);
    });

    socket.on("gameState", (snapshot, acknowledge) => {
        const receivedAt = Date.now();
        const receivedPerfAt = performance.now();
        const debugBefore = snapshots.getDebugState();
        const applyResult = snapshots.processSnapshot(snapshot);
        const processedPerfAt = performance.now();
        const debugAfter = snapshots.getDebugState();
        const receiveTiming = {
            receivedAt,
            receivedPerfAt,
            processedPerfAt,
            processMs: processedPerfAt - receivedPerfAt,
            debugBefore,
            debugAfter
        };

        recordSnapshotDiagnostics(snapshot, applyResult, receiveTiming);

        if (typeof acknowledge === "function") {
            acknowledge(createSnapshotAcknowledgement(applyResult));
            return;
        }

        if (applyResult && !applyResult.applied) {
            socket.emit("snapshotCacheInvalid", applyResult.invalidations);
        }
    });

    resizeCanvases();
    render();

    function render() {
        requestAnimationFrame(render);
        frameMonitor.recordFrame(performance.now());

        const state = snapshots.getRenderState();
        const currentPlayer = state && myId ? state.players[myId] : null;

        hud.update({
            frameStats: {
                frameMs: frameMonitor.getFrameMs(),
                fps: frameMonitor.getFps()
            },
            rendererStats: renderer.getDebugState(),
            snapshotStats: snapshots.getDebugState(),
            playerDebug: currentPlayer && currentPlayer.debug
        });

        if (!state || !myId) {
            minimap.clear();
            return;
        }

        renderer.renderWorld(state, myId);
        minimap.render(state, myId);
    }

    function resizeCanvases() {
        renderer.resizeCanvas();
        minimap.resizeCanvas();
        sendViewportState(true);
    }

    function sendViewportState(force = false) {
        const now = performance.now();
        const interval = gameConfig.network.viewportReportIntervalMs;

        if (!force && now - lastViewportSentAt < interval) {
            return;
        }

        lastViewportSentAt = now;
        socket.emit("viewport", renderer.getViewportState());
    }

    function createSnapshotAcknowledgement(applyResult) {
        return {
            applied: !applyResult || applyResult.applied !== false,
            invalidations: applyResult && applyResult.invalidations
                ? applyResult.invalidations
                : {
                    playerInfo: [],
                    territories: [],
                    trails: []
                }
        };
    }

    function recordSnapshotDiagnostics(snapshot, applyResult, receiveTiming) {
        if (typeof window === "undefined") {
            return;
        }

        const timing = createSnapshotTimingDiagnostics(snapshot, applyResult, receiveTiming);
        const diagnostics = {
            at: new Date().toISOString(),
            time: snapshot && snapshot.time,
            applied: !applyResult || applyResult.applied !== false,
            fullTerritoryIds: Object.keys((snapshot && snapshot.territories) || {}),
            territoryOperationIds: Object.keys((snapshot && snapshot.territoryOps) || {}),
            territoryOperations: summarizeTerritoryOperations(snapshot && snapshot.territoryOps),
            trailUpdateIds: Object.keys((snapshot && snapshot.trails) || {}),
            invalidations: applyResult && applyResult.invalidations,
            territoryOperationApplications: applyResult && applyResult.territoryOperationApplications || [],
            territoryOperationFailures: applyResult && applyResult.territoryOperationFailures || [],
            timing,
            syncDebug: snapshot && snapshot.syncDebug
        };
        const log = Array.isArray(window.__snapshotDiagnosticsLog)
            ? window.__snapshotDiagnosticsLog
            : [];

        log.push(diagnostics);

        while (log.length > 200) {
            log.shift();
        }

        window.__lastSnapshotDiagnostics = diagnostics;
        window.__snapshotDiagnosticsLog = log;
        recordTerritoryCaptureTimingDiagnostics(snapshot, applyResult, timing);
        installCaptureTimingPrinter();

        if (window.snapshotApplyDebug && diagnostics.territoryOperationFailures.length > 0) {
            console.warn("[snapshot] falha ao aplicar operação de território", diagnostics);
        }
    }

    function createSnapshotTimingDiagnostics(snapshot, applyResult, receiveTiming) {
        const before = receiveTiming && receiveTiming.debugBefore || {};
        const after = receiveTiming && receiveTiming.debugAfter || {};
        const clientTiming = applyResult && applyResult.clientTiming || {};
        const serverTiming = snapshot && snapshot.timing || null;
        const serverOffsetMs = Number.isFinite(after.serverOffsetMs)
            ? after.serverOffsetMs
            : clientTiming.serverOffsetMs;

        return {
            clientReceivedAt: receiveTiming && receiveTiming.receivedAt,
            clientProcessMs: roundTimingMs(receiveTiming && receiveTiming.processMs),
            clientExpandMs: roundTimingMs(clientTiming.expandMs),
            interpolatorProcessMs: roundTimingMs(clientTiming.processMs),
            bufferBeforeMs: roundTimingMs(before.bufferMs),
            bufferAfterMs: roundTimingMs(after.bufferMs),
            bufferDeltaMs: roundTimingMs(after.bufferMs - before.bufferMs),
            snapshotInterArrivalMs: roundTimingMs(after.snapshotInterArrivalMs),
            averageSnapshotDeltaMs: roundTimingMs(after.averageSnapshotDeltaMs),
            jitterMs: roundTimingMs(after.jitterMs),
            snapshotCountBefore: before.snapshotCount,
            snapshotCountAfter: after.snapshotCount,
            serverOffsetMs: roundTimingMs(serverOffsetMs),
            estimatedNetworkMs: estimateNetworkMs(serverTiming, receiveTiming, serverOffsetMs),
            server: serverTiming
        };
    }

    function recordTerritoryCaptureTimingDiagnostics(snapshot, applyResult, timing) {
        const entries = createTerritoryCaptureTimingEntries(snapshot, applyResult, timing);

        if (entries.length === 0) {
            return;
        }

        const log = Array.isArray(window.__territoryCaptureTimingLog)
            ? window.__territoryCaptureTimingLog
            : [];

        for (const entry of entries) {
            log.push(entry);
        }

        while (log.length > 200) {
            log.shift();
        }

        window.__lastTerritoryCaptureTiming = log[log.length - 1];
        window.__territoryCaptureTimingLog = log;
    }

    function createTerritoryCaptureTimingEntries(snapshot, applyResult, timing) {
        const entries = [];
        const operations = snapshot && snapshot.territoryOps || {};
        const applications = applyResult && applyResult.territoryOperationApplications || [];
        const failures = applyResult && applyResult.territoryOperationFailures || [];
        const consumedOperationIds = new Set();

        for (const application of applications) {
            consumedOperationIds.add(application.id);
            entries.push(createOperationTimingEntry("applied", application, timing));
        }

        for (const failure of failures) {
            consumedOperationIds.add(failure.id);
            entries.push(createOperationTimingEntry("failed", failure, timing));
        }

        for (const [id, operation] of Object.entries(operations)) {
            if (consumedOperationIds.has(id)) {
                continue;
            }

            entries.push(createOperationTimingEntry("received", {
                id,
                operation: {
                    ...summarizeTerritoryOperation(operation),
                    trace: operation.trace || null
                },
                details: {}
            }, timing));
        }

        for (const id of Object.keys((snapshot && snapshot.territories) || {})) {
            entries.push(createFullTerritoryTimingEntry(id, snapshot, timing));
        }

        return entries;
    }

    function createOperationTimingEntry(result, application, timing) {
        const operation = application.operation || {};
        const trace = operation.trace || null;
        const details = application.details || {};
        const server = timing && timing.server || {};

        return {
            at: new Date().toISOString(),
            mode: "operation",
            result,
            territoryId: application.id,
            captureId: trace && trace.id,
            version: operation.version,
            delivery: server && server.delivery,
            reliableAttempt: server && server.reliableAttempt,
            packetBytes: server && server.payloadBytes,
            serverCaptureTotalMs: trace && trace.totalMs,
            serverCaptureCalculationMs: trace && trace.calculationMs,
            serverCaptureApplyMs: trace && trace.serverApplyMs,
            serverSnapshotSerializeMs: server && server.serverSerializeMs,
            serverReadyToEmitMs: server && server.serverReadyToEmitMs,
            estimatedNetworkMs: timing && timing.estimatedNetworkMs,
            clientProcessMs: timing && timing.clientProcessMs,
            clientExpandMs: timing && timing.clientExpandMs,
            clientOperationApplyMs: details.applyMs,
            bufferBeforeMs: timing && timing.bufferBeforeMs,
            bufferAfterMs: timing && timing.bufferAfterMs,
            bufferDeltaMs: timing && timing.bufferDeltaMs,
            snapshotInterArrivalMs: timing && timing.snapshotInterArrivalMs,
            jitterMs: timing && timing.jitterMs,
            ringLength: details.ringLength,
            boundaryPathPointCount: details.boundaryPathPointCount,
            nextRingLength: details.nextRingLength,
            boundaryPathSource: details.boundaryPathSource,
            failureReason: application.reason || null,
            trace
        };
    }

    function createFullTerritoryTimingEntry(id, snapshot, timing) {
        const territory = snapshot && snapshot.territories && snapshot.territories[id];
        const server = timing && timing.server || {};

        return {
            at: new Date().toISOString(),
            mode: "full",
            result: "received",
            territoryId: id,
            version: territory && territory.version,
            delivery: server && server.delivery,
            reliableAttempt: server && server.reliableAttempt,
            packetBytes: server && server.payloadBytes,
            serverSnapshotSerializeMs: server && server.serverSerializeMs,
            serverReadyToEmitMs: server && server.serverReadyToEmitMs,
            estimatedNetworkMs: timing && timing.estimatedNetworkMs,
            clientProcessMs: timing && timing.clientProcessMs,
            clientExpandMs: timing && timing.clientExpandMs,
            bufferBeforeMs: timing && timing.bufferBeforeMs,
            bufferAfterMs: timing && timing.bufferAfterMs,
            bufferDeltaMs: timing && timing.bufferDeltaMs,
            snapshotInterArrivalMs: timing && timing.snapshotInterArrivalMs,
            jitterMs: timing && timing.jitterMs,
            fullPointCount: countPackedTerritoryPoints(territory && territory.polygon)
        };
    }

    function summarizeTerritoryOperation(operation) {
        return {
            type: operation.type,
            baseVersion: operation.baseVersion,
            version: operation.version,
            trailSide: operation.trailSide,
            trailSegmentIndex: operation.trailSegmentIndex,
            trailSegmentLength: operation.trailSegmentLength,
            boundaryPathIndex: operation.boundaryPathIndex,
            trailTailStart: Number.isInteger(operation.trailTailStart) ? operation.trailTailStart : null,
            trailTailPointCount: Array.isArray(operation.trailTailPoints) ? operation.trailTailPoints.length : 0,
            fallbackTrailPointCount: Array.isArray(operation.trailPoints) ? operation.trailPoints.length : 0
        };
    }

    function installCaptureTimingPrinter() {
        window.__printCaptureTiming = function printCaptureTiming(limit = 20) {
            const rows = getCaptureTimingEntriesForCalculationTable(limit)
                .map(createCaptureCalculationSummaryRow);

            console.table(rows);

            return rows;
        };

        window.__printCaptureCalcTiming = function printCaptureCalcTiming(captureIdOrLimit = 1) {
            const entries = getCaptureTimingEntriesForCalculationTable(captureIdOrLimit);
            const rows = entries
                .flatMap(createCaptureCalculationRows)
                .sort((first, second) => second.totalMs - first.totalMs);

            console.table(rows);

            return rows;
        };

        window.__printCaptureCalcExclusive = function printCaptureCalcExclusive(captureIdOrLimit = 1) {
            const entries = getCaptureTimingEntriesForCalculationTable(captureIdOrLimit);
            const rows = entries
                .flatMap(createCaptureCalculationExclusiveRows)
                .sort((first, second) => second.selfMs - first.selfMs);

            console.table(rows);

            return rows;
        };

        window.__printCaptureCalcTree = function printCaptureCalcTree(captureIdOrLimit = 1) {
            const entries = getCaptureTimingEntriesForCalculationTable(captureIdOrLimit);
            const rows = entries.flatMap(createCaptureCalculationTreeRows);

            console.table(rows);

            return rows;
        };

        window.__printCaptureCalcMax = function printCaptureCalcMax(captureIdOrLimit = 1) {
            const entries = getCaptureTimingEntriesForCalculationTable(captureIdOrLimit);
            const rows = entries
                .flatMap(createCaptureCalculationMaxRows)
                .sort((first, second) => second.maxMs - first.maxMs);

            console.table(rows);

            return rows;
        };
    }

    function getCaptureTimingEntriesForCalculationTable(captureIdOrLimit) {
        const operationEntries = (window.__territoryCaptureTimingLog || [])
            .filter(entry => entry && entry.mode === "operation" && entry.trace);

        if (typeof captureIdOrLimit === "string" && captureIdOrLimit.length > 0) {
            return operationEntries.filter(entry => entry.captureId === captureIdOrLimit);
        }

        const limit = Number.isFinite(captureIdOrLimit)
            ? Math.max(1, Math.trunc(captureIdOrLimit))
            : 1;

        return operationEntries.slice(-limit);
    }

    function createCaptureCalculationRows(entry) {
        const breakdown = entry.trace && entry.trace.calculationBreakdown || {};

        return Object.entries(breakdown).map(([name, step]) => ({
            captureId: entry.captureId,
            step: name,
            totalMs: step.totalMs
        }));
    }

    function createCaptureCalculationSummaryRow(entry) {
        const breakdown = entry.trace && entry.trace.calculationBreakdown || {};
        const row = {
            captureId: entry.captureId,
            totalMs: entry.serverCaptureCalculationMs
        };

        for (const [name, step] of Object.entries(breakdown || {})) {
            row[`${name}Ms`] = step.totalMs;
        }

        return row;
    }

    function createCaptureCalculationExclusiveRows(entry) {
        return getCaptureCalculationStepNames(entry)
            .map(stepName => createCaptureCalculationExclusiveRow(entry, stepName))
            .filter(Boolean);
    }

    function createCaptureCalculationExclusiveRow(entry, stepName) {
        const totalMs = getCaptureCalculationStepTotalMs(entry, stepName);

        if (!Number.isFinite(totalMs)) {
            return null;
        }

        const childMs = getCaptureCalculationStepChildren(stepName)
            .reduce((sum, childName) => sum + (getCaptureCalculationStepTotalMs(entry, childName) || 0), 0);

        return {
            captureId: entry.captureId,
            step: stepName,
            totalMs: roundTimingMs(totalMs),
            childMs: roundTimingMs(childMs),
            selfMs: roundTimingMs(totalMs - childMs)
        };
    }

    function createCaptureCalculationTreeRows(entry) {
        const rows = [];
        const visited = new Set();

        appendCaptureCalculationTreeRow(entry, rows, visited, "capture.total", 0);

        for (const stepName of getCaptureCalculationStepNames(entry)) {
            if (!visited.has(stepName)) {
                appendCaptureCalculationTreeRow(entry, rows, visited, stepName, 1);
            }
        }

        return rows;
    }

    function appendCaptureCalculationTreeRow(entry, rows, visited, stepName, depth) {
        if (visited.has(stepName)) {
            return;
        }

        const totalMs = getCaptureCalculationStepTotalMs(entry, stepName);

        if (!Number.isFinite(totalMs)) {
            return;
        }

        visited.add(stepName);

        const childMs = getCaptureCalculationStepChildren(stepName)
            .reduce((sum, childName) => sum + (getCaptureCalculationStepTotalMs(entry, childName) || 0), 0);

        rows.push({
            captureId: entry.captureId,
            step: `${"  ".repeat(depth)}${stepName}`,
            totalMs: roundTimingMs(totalMs),
            selfMs: roundTimingMs(totalMs - childMs)
        });

        for (const childName of getCaptureCalculationStepChildren(stepName)) {
            appendCaptureCalculationTreeRow(entry, rows, visited, childName, depth + 1);
        }
    }

    function createCaptureCalculationMaxRows(entry) {
        const breakdown = entry.trace && entry.trace.calculationBreakdown || {};

        return Object.entries(breakdown).map(([name, step]) => ({
            captureId: entry.captureId,
            step: name,
            totalMs: step.totalMs,
            count: step.count,
            avgMs: step.avgMs,
            maxMs: step.maxMs,
            maxDetails: JSON.stringify(step.maxDetails || {})
        }));
    }

    function getCaptureCalculationStepNames(entry) {
        const breakdown = entry.trace && entry.trace.calculationBreakdown || {};

        return [
            "capture.total",
            ...Object.keys(breakdown)
        ];
    }

    function getCaptureCalculationStepTotalMs(entry, stepName) {
        if (stepName === "capture.total") {
            return entry.serverCaptureCalculationMs;
        }

        const breakdown = entry.trace && entry.trace.calculationBreakdown || {};
        const step = breakdown[stepName];

        return step && Number.isFinite(step.totalMs) ? step.totalMs : null;
    }

    function getCaptureCalculationStepChildren(stepName) {
        const hierarchy = {
            "capture.total": [
                "hasAnySideTrailSegment",
                "getPlayerTerritoryPolygon",
                "createTrailCaptureCandidates.total",
                "selectBestCaptureCandidate.total"
            ],
            "createTrailCaptureCandidates.total": [
                "candidates.getTrailSegments",
                "candidates.segment.total"
            ],
            "candidates.segment.total": [
                "segment.getFinitePoints",
                "segment.findStartBoundaryContact",
                "segment.findEndBoundaryContact",
                "segment.createBorderSnappedSidePoints",
                "segment.createBoundaryPaths",
                "candidate.createTrailBoundaryPoints",
                "candidate.createPolygonAndArea",
                "candidate.createCaptureOperation"
            ],
            "segment.createBoundaryPaths": [
                "boundary.getOpenRing",
                "boundary.createForwardPath",
                "boundary.createReversePath",
                "boundary.dedupePaths"
            ],
            "candidate.createPolygonAndArea": [
                "candidate.createKnownSimplePolygonFromPoints",
                "candidate.createPolygonFromPoints",
                "candidate.calculatePolygonArea"
            ],
            "candidate.createCaptureOperation": [
                "operation.createPreviewPolygon"
            ],
            "selectBestCaptureCandidate.total": [
                "select.calculateCurrentArea",
                "select.rankCandidate.total"
            ],
            "select.rankCandidate.total": [
                "rank.useCandidateArea",
                "rank.calculateAddedArea",
                "rank.unionKnownSimplePolygons",
                "rank.unionPolygons",
                "rank.calculateCandidateArea",
                "rank.calculateUnionArea"
            ]
        };

        return hierarchy[stepName] || [];
    }

    function estimateNetworkMs(serverTiming, receiveTiming, serverOffsetMs) {
        if (!serverTiming
            || !Number.isFinite(serverTiming.serverEmitAt)
            || !receiveTiming
            || !Number.isFinite(receiveTiming.receivedAt)
            || !Number.isFinite(serverOffsetMs)) {
            return null;
        }

        return roundTimingMs(receiveTiming.receivedAt - (serverTiming.serverEmitAt + serverOffsetMs));
    }

    function countPackedTerritoryPoints(polygon) {
        if (!polygon) {
            return 0;
        }

        if (Array.isArray(polygon)) {
            return polygon.reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0);
        }

        if (Array.isArray(polygon.rings)) {
            return polygon.rings.reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0);
        }

        return 0;
    }

    function roundTimingMs(value) {
        return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
    }

    function summarizeTerritoryOperations(operations) {
        const summaries = {};

        for (const [id, operation] of Object.entries(operations || {})) {
            summaries[id] = {
                baseVersion: operation.baseVersion,
                version: operation.version,
                trailSide: operation.trailSide,
                trailSegmentIndex: operation.trailSegmentIndex,
                trailSegmentLength: operation.trailSegmentLength,
                boundaryPathIndex: operation.boundaryPathIndex,
                trace: operation.trace || null,
                trailTailStart: Number.isInteger(operation.trailTailStart) ? operation.trailTailStart : null,
                trailTailPointCount: Array.isArray(operation.trailTailPoints) ? operation.trailTailPoints.length : 0,
                fallbackTrailPointCount: Array.isArray(operation.trailPoints) ? operation.trailPoints.length : 0
            };
        }

        return summaries;
    }
}
