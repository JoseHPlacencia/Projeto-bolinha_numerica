const DEFAULT_HISTORY_LIMIT = 240;
const DEFAULT_PING_INTERVAL_MS = 1000;
const DEFAULT_SLOW_BUFFER_MS = 150;
const DEFAULT_SLOW_SERVER_INTERVAL_MS = 80;
const DEFAULT_SLOW_LOOP_DRIFT_MS = 40;
const DEFAULT_SLOW_GAME_LOOP_MS = 12;
const DEFAULT_SLOW_SNAPSHOT_BUILD_MS = 16;
const DEFAULT_SLOW_PAYLOAD_MEASURE_MS = 8;
const DEFAULT_LARGE_PAYLOAD_BYTES = 10000;

export function createNetworkDiagnostics(socket, snapshots, networkConfig = {}) {
    const events = [];
    const pings = [];
    let timerId = null;
    let enabled = false;

    registerSocketEvents();

    const api = {
        clear,
        disable,
        enable,
        isRunning,
        ping,
        print,
        report,
        start,
        stop,
        table
    };

    exposeDiagnosticsApi(api);

    if (shouldAutoStart()) {
        start();
    }

    return api;

    function enable() {
        enabled = true;
        return emitWithAck("networkDiagnostics", {
            enabled: true
        }).then(response => {
            recordEvent("diagnostics-enabled", response);
            return response;
        });
    }

    function disable() {
        enabled = false;
        stopTimer();
        return emitWithAck("networkDiagnostics", {
            enabled: false
        }).then(response => {
            recordEvent("diagnostics-disabled", response);
            return response;
        });
    }

    function start(options = {}) {
        const intervalMs = getPositiveNumber(
            options.intervalMs,
            getPositiveNumber(networkConfig.diagnosticsPingIntervalMs, DEFAULT_PING_INTERVAL_MS)
        );

        enabled = true;
        enable();
        stopTimer();
        timerId = setInterval(() => {
            ping().catch(() => null);

            if (options.log) {
                print();
            }
        }, intervalMs);

        ping().catch(() => null);

        return report();
    }

    function stop() {
        stopTimer();
        return report();
    }

    function ping() {
        const clientSentAt = Date.now();
        const perfSentAt = performance.now();

        return emitWithAck("networkDiagnosticsPing", {
            clientSentAt
        }).then(response => {
            const roundTripMs = performance.now() - perfSentAt;
            const serverTime = Number(response && response.serverTime);
            const sample = {
                at: Date.now(),
                clientSentAt,
                diagnosticsEnabled: Boolean(response && response.diagnosticsEnabled),
                roundTripMs,
                serverOffsetEstimateMs: Number.isFinite(serverTime)
                    ? serverTime - (clientSentAt + roundTripMs / 2)
                    : null,
                transport: response && response.transport || getTransportName()
            };

            pings.push(sample);
            trimHistory(pings);
            recordEvent("ping", sample);

            return sample;
        });
    }

    function report() {
        const snapshotDiagnostics = snapshots && typeof snapshots.getNetworkDiagnostics === "function"
            ? snapshots.getNetworkDiagnostics()
            : null;

        return {
            connected: Boolean(socket && socket.connected),
            enabled,
            running: isRunning(),
            transport: getTransportName(),
            ping: createPingSummary(),
            snapshots: snapshotDiagnostics,
            diagnosis: diagnoseNetwork(snapshotDiagnostics, createPingSummary()),
            clientEvents: events.slice(),
            pings: pings.slice()
        };
    }

    function print() {
        const data = report();
        const latestSnapshot = data.snapshots && data.snapshots.current
            ? data.snapshots.current.lastSnapshot
            : null;
        const gameLoop = latestSnapshot && latestSnapshot.server && latestSnapshot.server.gameLoop;
        const gameLoopPhases = gameLoop && gameLoop.phases || {};
        const row = {
            diagnosis: data.diagnosis.reason,
            bufferMs: latestSnapshot && round(latestSnapshot.bufferMs),
            interArrivalMs: latestSnapshot && round(latestSnapshot.snapshotInterArrivalMs),
            jitterMs: latestSnapshot && round(latestSnapshot.jitterMs),
            rttMs: data.ping.last && round(data.ping.last.roundTripMs),
            sendType: latestSnapshot && latestSnapshot.server && latestSnapshot.server.sendType,
            serverIntervalMs: latestSnapshot && latestSnapshot.server && round(latestSnapshot.server.serverSendIntervalMs),
            loopDriftMs: latestSnapshot && latestSnapshot.server && round(latestSnapshot.server.loopDriftMs),
            gameLoopMs: gameLoop && round(gameLoop.tickDurationMs),
            gameLoopDriftMs: gameLoop && round(gameLoop.tickDriftMs),
            slowestPhase: gameLoop && gameLoop.slowestPhase && gameLoop.slowestPhase.name,
            trailsMs: round(gameLoopPhases.trails),
            botsMs: round(gameLoopPhases.bots),
            numbersMs: round(gameLoopPhases.numbers),
            buildMs: latestSnapshot && latestSnapshot.server && round(latestSnapshot.server.snapshotBuildMs),
            payloadMeasureMs: latestSnapshot && latestSnapshot.server && round(latestSnapshot.server.payloadMeasureMs),
            payloadBytes: latestSnapshot && latestSnapshot.server && latestSnapshot.server.basePayloadBytes,
            territoryPayloads: latestSnapshot && latestSnapshot.server && latestSnapshot.server.snapshotBreakdown && latestSnapshot.server.snapshotBreakdown.territoryPayloadCount,
            territoryOps: latestSnapshot && latestSnapshot.server && latestSnapshot.server.snapshotBreakdown && latestSnapshot.server.snapshotBreakdown.territoryOperationCount,
            trailPatchPoints: latestSnapshot && latestSnapshot.server && latestSnapshot.server.snapshotBreakdown && latestSnapshot.server.snapshotBreakdown.trailPatchPointCount,
            transport: data.transport
        };

        console.table([row]);
        return data;
    }

    function table(limit = 20) {
        const snapshotDiagnostics = snapshots && typeof snapshots.getNetworkDiagnostics === "function"
            ? snapshots.getNetworkDiagnostics()
            : { events: [] };
        const rows = (snapshotDiagnostics.events || [])
            .filter(event => event.type === "snapshot")
            .slice(-limit)
            .map(event => ({
                at: new Date(event.at).toLocaleTimeString(),
                bufferMs: round(event.bufferMs),
                interArrivalMs: round(event.snapshotInterArrivalMs),
                jitterMs: round(event.jitterMs),
                estimatedTransitMs: round(event.estimatedTransitMs),
                sendType: event.server && event.server.sendType,
                serverIntervalMs: event.server && round(event.server.serverSendIntervalMs),
                loopDriftMs: event.server && round(event.server.loopDriftMs),
                gameLoopMs: event.server && event.server.gameLoop && round(event.server.gameLoop.tickDurationMs),
                gameLoopDriftMs: event.server && event.server.gameLoop && round(event.server.gameLoop.tickDriftMs),
                slowestPhase: event.server && event.server.gameLoop && event.server.gameLoop.slowestPhase && event.server.gameLoop.slowestPhase.name,
                trailsMs: event.server && event.server.gameLoop && event.server.gameLoop.phases && round(event.server.gameLoop.phases.trails),
                botsMs: event.server && event.server.gameLoop && event.server.gameLoop.phases && round(event.server.gameLoop.phases.bots),
                numbersMs: event.server && event.server.gameLoop && event.server.gameLoop.phases && round(event.server.gameLoop.phases.numbers),
                buildMs: event.server && round(event.server.snapshotBuildMs),
                payloadMeasureMs: event.server && round(event.server.payloadMeasureMs),
                payloadBytes: event.server && event.server.basePayloadBytes,
                territoryPayloads: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.territoryPayloadCount,
                territoryOps: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.territoryOperationCount,
                trailPatchPoints: event.server && event.server.snapshotBreakdown && event.server.snapshotBreakdown.trailPatchPointCount,
                reliableRetryCount: event.server && event.server.reliableRetryCount,
                preserveTrails: event.preserveTrails
            }));

        console.table(rows);
        return rows;
    }

    function clear() {
        events.length = 0;
        pings.length = 0;
    }

    function isRunning() {
        return timerId !== null;
    }

    function registerSocketEvents() {
        if (!socket || typeof socket.on !== "function") {
            return;
        }

        socket.on("connect", () => {
            recordEvent("socket-connect", {
                transport: getTransportName()
            });
        });
        socket.on("disconnect", reason => {
            recordEvent("socket-disconnect", {
                reason,
                transport: getTransportName()
            });
        });
        socket.on("connect_error", error => {
            recordEvent("socket-connect-error", {
                message: error && error.message
            });
        });

        const engine = socket.io && socket.io.engine;

        if (engine && typeof engine.on === "function") {
            engine.on("upgrade", transport => {
                recordEvent("transport-upgrade", {
                    transport: transport && transport.name || getTransportName()
                });
            });
        }
    }

    function emitWithAck(eventName, payload, timeoutMs = 2000) {
        return new Promise(resolve => {
            if (!socket || typeof socket.emit !== "function" || !socket.connected) {
                resolve({
                    error: "socket-not-connected"
                });
                return;
            }

            const emitter = typeof socket.timeout === "function"
                ? socket.timeout(timeoutMs)
                : socket;

            emitter.emit(eventName, payload, (error, response) => {
                if (error) {
                    resolve({
                        error: error.message || String(error)
                    });
                    return;
                }

                resolve(response || {});
            });
        });
    }

    function diagnoseNetwork(snapshotDiagnostics, pingSummary) {
        const current = snapshotDiagnostics && snapshotDiagnostics.current;
        const latest = current && current.lastSnapshot;
        const server = latest && latest.server;
        const slowBufferMs = getPositiveNumber(networkConfig.diagnosticsSlowBufferMs, DEFAULT_SLOW_BUFFER_MS);
        const slowServerIntervalMs = getPositiveNumber(networkConfig.diagnosticsSlowServerIntervalMs, DEFAULT_SLOW_SERVER_INTERVAL_MS);
        const slowLoopDriftMs = getPositiveNumber(networkConfig.diagnosticsSlowLoopDriftMs, DEFAULT_SLOW_LOOP_DRIFT_MS);
        const slowGameLoopMs = getPositiveNumber(networkConfig.diagnosticsSlowGameLoopMs, DEFAULT_SLOW_GAME_LOOP_MS);
        const slowSnapshotBuildMs = getPositiveNumber(networkConfig.diagnosticsSlowSnapshotBuildMs, DEFAULT_SLOW_SNAPSHOT_BUILD_MS);
        const slowPayloadMeasureMs = getPositiveNumber(networkConfig.diagnosticsSlowPayloadMeasureMs, DEFAULT_SLOW_PAYLOAD_MEASURE_MS);
        const largePayloadBytes = getPositiveNumber(networkConfig.diagnosticsLargePayloadBytes, DEFAULT_LARGE_PAYLOAD_BYTES);
        const gameLoop = server && server.gameLoop;

        if (!latest) {
            return {
                reason: "waiting-for-snapshots",
                detail: "No snapshot samples recorded yet."
            };
        }

        if (server && server.sendType === "reliable-retry") {
            return {
                reason: "reliable-snapshot-retry",
                detail: "Reliable snapshot retry is active; ACK or cache recovery may be delaying fresh state."
            };
        }

        if (server && isReliableBacklog(server)) {
            return {
                reason: "reliable-snapshot-pending",
                detail: "A reliable snapshot is pending and volatile snapshots are preserving cached state."
            };
        }

        if (gameLoop && gameLoop.tickDurationMs >= slowGameLoopMs) {
            return {
                reason: "server-game-loop-work",
                detail: createGameLoopDiagnosisDetail(gameLoop)
            };
        }

        if (server && server.loopDriftMs >= slowLoopDriftMs && gameLoop && gameLoop.tickDriftMs >= slowLoopDriftMs) {
            return {
                reason: "server-event-loop-drift",
                detail: createGameLoopDriftDetail(gameLoop)
            };
        }

        if (server && server.loopDriftMs >= slowLoopDriftMs) {
            return {
                reason: "server-loop-drift",
                detail: "Server snapshot loop drift exceeded the expected cadence; event-loop or tick processing is delaying sends."
            };
        }

        if (server && server.snapshotBuildMs >= slowSnapshotBuildMs) {
            return {
                reason: "server-snapshot-build",
                detail: "Server spent too long building the snapshot before sending it."
            };
        }

        if (server && server.payloadMeasureMs >= slowPayloadMeasureMs) {
            return {
                reason: "diagnostic-payload-measurement",
                detail: "Diagnostic JSON payload measurement is itself taking noticeable time."
            };
        }

        if (server && server.basePayloadBytes >= largePayloadBytes) {
            return {
                reason: "large-snapshot-payload",
                detail: "Serialized snapshot payload is large; territory, trail, or full-sync data may be driving buffer growth."
            };
        }

        if (latest.bufferMs >= slowBufferMs && latest.jitterMs >= 25) {
            return {
                reason: "client-jitter",
                detail: "Client received snapshots with high inter-arrival jitter."
            };
        }

        if (server && server.serverSendIntervalMs > slowServerIntervalMs) {
            return {
                reason: "server-send-gap",
                detail: "Server-side snapshot send interval exceeded the expected cadence."
            };
        }

        if (
            latest.snapshotInterArrivalMs > slowServerIntervalMs
            && (!server || !Number.isFinite(server.serverSendIntervalMs) || server.serverSendIntervalMs <= slowServerIntervalMs)
        ) {
            return {
                reason: "network-arrival-gap",
                detail: "Client received snapshots late while server send cadence looked normal."
            };
        }

        if (pingSummary.last && pingSummary.last.roundTripMs >= 160) {
            return {
                reason: "high-rtt",
                detail: "Socket.IO diagnostic ping has high round-trip time."
            };
        }

        if (latest.bufferMs >= slowBufferMs) {
            return {
                reason: "buffer-high-unclassified",
                detail: "Buffer is high, but no single network signal is dominant in the latest sample."
            };
        }

        return {
            reason: "network-stable",
            detail: "Latest network samples are within the configured thresholds."
        };
    }

    function createGameLoopDiagnosisDetail(gameLoop) {
        const slowestPhase = gameLoop && gameLoop.slowestPhase;

        if (!slowestPhase || !slowestPhase.name) {
            return "Server game loop work exceeded the expected per-tick budget.";
        }

        return `Server game loop exceeded budget; slowest phase: ${slowestPhase.name} (${round(slowestPhase.durationMs)}ms).`;
    }

    function createGameLoopDriftDetail(gameLoop) {
        const slowestPhase = gameLoop && gameLoop.slowestPhase;

        if (!slowestPhase || !slowestPhase.name) {
            return "Server game loop tick drift was high; another synchronous task may be blocking the event loop.";
        }

        return `Server game loop tick drift was high; last slowest phase: ${slowestPhase.name} (${round(slowestPhase.durationMs)}ms).`;
    }

    function createPingSummary() {
        return {
            samples: pings.length,
            last: pings[pings.length - 1] || null,
            averageRoundTripMs: averageFiniteValues(pings.map(sample => sample.roundTripMs)),
            maxRoundTripMs: maxFiniteValue(pings.map(sample => sample.roundTripMs))
        };
    }

    function isReliableBacklog(server) {
        return Boolean(server && (server.reliableBacklog || server.sendType === "volatile-pending"));
    }

    function recordEvent(type, detail = {}) {
        events.push({
            at: Date.now(),
            type,
            ...detail
        });
        trimHistory(events);
    }

    function trimHistory(values) {
        const limit = getPositiveInteger(networkConfig.diagnosticsHistoryLimit, DEFAULT_HISTORY_LIMIT);

        while (values.length > limit) {
            values.shift();
        }
    }

    function stopTimer() {
        if (timerId === null) {
            return;
        }

        clearInterval(timerId);
        timerId = null;
    }

    function getTransportName() {
        return socket
            && socket.io
            && socket.io.engine
            && socket.io.engine.transport
            && socket.io.engine.transport.name
            ? socket.io.engine.transport.name
            : null;
    }

    function shouldAutoStart() {
        if (typeof window === "undefined") {
            return false;
        }

        const params = new URLSearchParams(window.location.search);
        const value = params.get("netdiag") || params.get("networkDiagnostics");

        return value === "1" || value === "true" || value === "on";
    }
}

function exposeDiagnosticsApi(api) {
    if (typeof window === "undefined") {
        return;
    }

    window.VennperioNetworkDiagnostics = api;
}

function getPositiveNumber(value, fallback) {
    const number = Number(value);

    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getPositiveInteger(value, fallback) {
    const number = Math.trunc(Number(value));

    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function averageFiniteValues(values) {
    const finiteValues = values.filter(Number.isFinite);

    if (finiteValues.length === 0) {
        return null;
    }

    return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function maxFiniteValue(values) {
    const finiteValues = values.filter(Number.isFinite);

    return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
}

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
}
