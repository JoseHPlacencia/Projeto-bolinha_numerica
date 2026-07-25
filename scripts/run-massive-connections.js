"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { io } = require("socket.io-client");
const {
    createConnectionLoadPlan
} = require("./lib/connectionLoadPlan");
const { MetricSeries } = require("./lib/metricSeries");

const projectRoot = path.resolve(__dirname, "..");
const defaultOutput = path.join(
    projectRoot,
    ".ai",
    "reports",
    "MASSIVE_CONNECTIONS_LATEST.json"
);
const ACKNOWLEDGEMENT = Object.freeze({
    applied: true,
    invalidations: Object.freeze({
        playerInfo: Object.freeze([]),
        territories: Object.freeze([]),
        trails: Object.freeze([])
    })
});
const PLAYER_COLORS = Object.freeze([
    "#ff3333", "#ff8c32", "#ffe033", "#b7ff26",
    "#55ff26", "#25ef88", "#22e6e6", "#2aa7ef",
    "#2868ef", "#4931ef", "#8128ef", "#c32aef",
    "#ef2ac5", "#ef2878"
]);

main().catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});

async function main() {
    const options = parseArguments(process.argv.slice(2));
    assertTargetIsAllowed(options);
    const plan = createConnectionLoadPlan({
        arenaCapacity: options.arenaCapacity,
        mapSize: options.mapSize,
        maxRooms: options.maxRooms,
        ramp: options.ramp
    });
    const diagnostic = createMassiveConnectionDiagnostic(options, plan);
    const report = await diagnostic.run();

    writeReport(options.output, report);
    printSummary(report, options.output);

    if (report.status === "fail") {
        process.exitCode = 2;
    }
}

function createMassiveConnectionDiagnostic(options, plan) {
    const startedAt = Date.now();
    const random = createRandom(options.seed);
    const rooms = [];
    const clients = [];
    const stageReports = [];
    const counters = createCounters();
    const connectionSeries = {
        connectMs: new MetricSeries({ seed: options.seed ^ 0xc011ec7 }),
        joinMs: new MetricSeries({ seed: options.seed ^ 0x501ced })
    };
    let abortReason = null;
    let currentStage = null;
    let fatalError = null;
    let inputTimer = null;
    let pingTimer = null;
    let stopping = false;

    return {
        run
    };

    async function run() {
        process.on("SIGINT", handleInterrupt);
        process.on("SIGTERM", handleInterrupt);
        startActivityTimers();

        try {
            for (const stagePlan of plan.stages) {
                if (abortReason) break;
                const stageReport = await runStage(stagePlan);
                stageReports.push(stageReport);
            }
        } catch (error) {
            fatalError = error;
            abortReason ||= `fatal: ${error.message || String(error)}`;
        } finally {
            currentStage = null;
            stopping = true;
            stopActivityTimers();
            await disconnectAllClients();
            process.off("SIGINT", handleInterrupt);
            process.off("SIGTERM", handleInterrupt);
        }

        return createReport();
    }

    async function runStage(stagePlan) {
        process.stdout.write(
            `[connections] ramping to ${stagePlan.targetPlayers} players `
            + `in ${stagePlan.rooms.length} room(s)\n`
        );
        const rampStartedAt = performance.now();
        await setLoadTarget(stagePlan);
        const rampDurationMs = performance.now() - rampStartedAt;

        if (!abortReason && options.settleMs > 0) {
            await delay(options.settleMs);
        }

        const stage = createStageState(stagePlan, rampDurationMs);
        currentStage = stage;
        recordHealth(stage);
        const deadline = Date.now() + options.stageMs;

        process.stdout.write(
            `[connections] holding ${stagePlan.targetPlayers} active players `
            + `for ${options.stageMs} ms\n`
        );

        while (!abortReason && Date.now() < deadline) {
            await delay(Math.min(options.healthIntervalMs, Math.max(1, deadline - Date.now())));
            recordHealth(stage);
        }

        currentStage = null;
        return finalizeStage(stage);
    }

    async function setLoadTarget(stagePlan) {
        for (const allocation of stagePlan.rooms) {
            if (abortReason) return;

            const room = rooms[allocation.index - 1] || createLoadRoom(allocation.index);
            while (room.clients.length < allocation.targetPlayers && !abortReason) {
                await addClient(room);
                if (
                    options.connectionIntervalMs > 0
                    && room.clients.length < allocation.targetPlayers
                ) {
                    await delay(options.connectionIntervalMs);
                }
            }
        }
    }

    function createLoadRoom(index) {
        const room = {
            clients: [],
            code: null,
            index,
            password: `load-${options.seed.toString(16)}-${index}`
        };
        rooms[index - 1] = room;
        return room;
    }

    async function addClient(room) {
        const state = createClientState(clients.length + 1, room);
        room.clients.push(state);
        clients.push(state);
        counters.connectionAttempts++;

        try {
            const connectStartedAt = performance.now();
            await connectClient(state);
            connectionSeries.connectMs.add(performance.now() - connectStartedAt);
            counters.connected++;
        } catch (error) {
            counters.connectionFailures++;
            state.lastError = error.message || String(error);
            state.socket.disconnect();
            abortReason ||= `client ${state.index} failed to connect: ${state.lastError}`;
            return;
        }

        try {
            const joinStartedAt = performance.now();
            await joinClient(state, room.code === null);
            connectionSeries.joinMs.add(performance.now() - joinStartedAt);
        } catch (error) {
            state.lastError = error.message || String(error);
            state.socket.disconnect();
            abortReason ||= `client ${state.index} failed to join: ${state.lastError}`;
        }
    }

    function createClientState(index, room) {
        const socket = io(options.url, {
            autoConnect: false,
            forceNew: true,
            reconnection: false,
            timeout: options.connectTimeoutMs,
            transports: options.transport === "default"
                ? undefined
                : [options.transport]
        });
        const state = {
            active: false,
            angle: random() * Math.PI * 2 - Math.PI,
            connected: false,
            expectedDisconnect: false,
            gameOvers: 0,
            index,
            joined: false,
            lastDiagnosticSequence: null,
            lastError: null,
            lastPingAt: null,
            lastPingRttMs: null,
            lastSnapshotAt: null,
            lastSnapshotEpoch: null,
            lastSnapshotReceivedAt: null,
            lastSnapshotSequence: null,
            monitor: room.clients.length === 0,
            pendingJoin: null,
            pingInFlight: false,
            rejoinAttempts: 0,
            rejoinTimer: null,
            room,
            serverOffsetMs: null,
            snapshots: 0,
            socket,
            turnRate: (random() * 0.8 - 0.4) || 0.1
        };

        socket.on("joinRoomResult", result => handleJoinResult(state, result));
        socket.on("gameState", (snapshot, acknowledge) => {
            if (typeof acknowledge === "function") acknowledge(ACKNOWLEDGEMENT);
            handleSnapshot(state, snapshot);
        });
        socket.on("gameOver", data => handleGameOver(state, data));
        socket.on("disconnect", reason => handleDisconnect(state, reason));
        socket.on("connect_error", error => {
            state.lastError = error && error.message || "connect-error";
        });

        return state;
    }

    function connectClient(state) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`connection timed out after ${options.connectTimeoutMs} ms`));
            }, options.connectTimeoutMs);
            const onConnect = () => {
                cleanup();
                state.connected = true;
                resolve();
            };
            const onError = error => {
                cleanup();
                reject(error || new Error("connection failed"));
            };
            const cleanup = () => {
                clearTimeout(timeout);
                state.socket.off("connect", onConnect);
                state.socket.off("connect_error", onError);
            };

            state.socket.once("connect", onConnect);
            state.socket.once("connect_error", onError);
            state.socket.connect();
        });
    }

    function joinClient(state, createNewRoom, rejoin = false) {
        if (!state.connected || state.pendingJoin) {
            return Promise.reject(new Error("client is not ready to join"));
        }

        const room = state.room;
        const payload = createNewRoom
            ? createRoomPayload(state, room)
            : createExistingRoomPayload(state, room);

        counters.joinAttempts++;
        if (rejoin) counters.rejoinAttempts++;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                state.pendingJoin = null;
                counters.joinFailures++;
                if (rejoin) counters.rejoinFailures++;
                reject(new Error(`room join timed out after ${options.connectTimeoutMs} ms`));
            }, options.connectTimeoutMs);

            state.pendingJoin = {
                createNewRoom,
                reject,
                rejoin,
                resolve,
                timeout
            };
            state.socket.emit("joinRoom", payload);
        });
    }

    function createRoomPayload(state, room) {
        return {
            createNewRoom: true,
            customOptions: {
                allowBots: false,
                botCount: 0,
                lives: 5,
                mapSize: options.mapSize,
                maxPlayers: options.arenaCapacity,
                numberDensity: 1,
                numberRespawn: 1,
                playerSpeed: 1,
                themeDuration: 1
            },
            difficulty: "medium",
            isPrivate: true,
            password: room.password,
            player: createPlayerOptions(state)
        };
    }

    function createExistingRoomPayload(state, room) {
        return {
            password: room.password,
            player: createPlayerOptions(state),
            roomCode: room.code
        };
    }

    function createPlayerOptions(state) {
        return {
            color: PLAYER_COLORS[(state.index - 1) % PLAYER_COLORS.length],
            difficulty: "medium",
            name: `Carga ${state.index}`
        };
    }

    function handleJoinResult(state, result) {
        const pending = state.pendingJoin;
        if (!pending) return;

        clearTimeout(pending.timeout);
        state.pendingJoin = null;

        if (!result || result.success !== true) {
            counters.joinFailures++;
            if (pending.rejoin) counters.rejoinFailures++;
            pending.reject(new Error(result && result.message || "room join failed"));
            return;
        }

        if (pending.createNewRoom) {
            state.room.code = result.roomCode;
        }
        state.active = true;
        state.joined = true;
        state.lastSnapshotAt = Date.now();
        counters.successfulJoins++;
        if (pending.rejoin) {
            counters.successfulRejoins++;
            state.rejoinAttempts = 0;
        }

        sendViewport(state);
        sendDirection(state);
        if (state.monitor) enableNetworkDiagnostics(state);
        pending.resolve(result);
    }

    function enableNetworkDiagnostics(state) {
        state.socket.emit("networkDiagnostics", { enabled: true }, response => {
            if (
                response
                && Number.isFinite(response.serverTime)
                && state.connected
            ) {
                state.serverOffsetMs = response.serverTime - Date.now();
            }
        });
    }

    function handleSnapshot(state, snapshot) {
        const receivedAt = performance.now();
        const receivedEpochMs = Date.now();
        const sequence = Number(snapshot && snapshot.sequence);
        const epoch = snapshot && snapshot.snapshotEpoch;

        state.snapshots++;
        state.lastSnapshotAt = receivedEpochMs;

        if (currentStage) {
            currentStage.events.snapshots++;
            if (state.lastSnapshotReceivedAt !== null) {
                currentStage.series.snapshotInterArrivalMs.add(
                    receivedAt - state.lastSnapshotReceivedAt
                );
            }
        }

        if (
            typeof epoch === "string"
            && epoch === state.lastSnapshotEpoch
            && Number.isSafeInteger(sequence)
            && Number.isSafeInteger(state.lastSnapshotSequence)
            && sequence > state.lastSnapshotSequence + 1
        ) {
            const missing = sequence - state.lastSnapshotSequence - 1;
            if (currentStage) {
                currentStage.events.sequenceGapEvents++;
                currentStage.events.missingSnapshotSequences += missing;
            }
        }

        state.lastSnapshotReceivedAt = receivedAt;
        state.lastSnapshotEpoch = epoch || null;
        state.lastSnapshotSequence = Number.isSafeInteger(sequence) ? sequence : null;

        if (currentStage && state.monitor) {
            recordSnapshotDiagnostics(state, snapshot && snapshot.networkDiagnostics);
        }
    }

    function recordSnapshotDiagnostics(state, diagnostics) {
        if (!diagnostics || typeof diagnostics !== "object") return;

        currentStage.series.serverSendIntervalMs.add(diagnostics.serverSendIntervalMs);
        currentStage.series.loopDriftMs.add(diagnostics.loopDriftMs);
        currentStage.series.snapshotBuildMs.add(diagnostics.snapshotBuildMs);
        currentStage.series.payloadBytes.add(diagnostics.basePayloadBytes);
        currentStage.series.gameTickMs.add(
            diagnostics.gameLoop && diagnostics.gameLoop.tickDurationMs
        );

        if (
            Number.isFinite(diagnostics.serverSentAt)
            && Number.isFinite(state.serverOffsetMs)
        ) {
            currentStage.series.snapshotLatencyMs.add(
                Date.now() - diagnostics.serverSentAt + state.serverOffsetMs
            );
        }

        if (diagnostics.sendType === "reliable-retry") {
            currentStage.events.reliableRetries++;
        }
        if (diagnostics.reliableAckTimeouts > 0) {
            currentStage.events.reliableAckTimeoutObservations++;
        }

        const diagnosticSequence = Number(diagnostics.sequence);
        if (
            Number.isSafeInteger(diagnosticSequence)
            && Number.isSafeInteger(state.lastDiagnosticSequence)
            && diagnosticSequence > state.lastDiagnosticSequence + 1
        ) {
            currentStage.events.monitorDiagnosticGaps += (
                diagnosticSequence - state.lastDiagnosticSequence - 1
            );
        }
        state.lastDiagnosticSequence = Number.isSafeInteger(diagnosticSequence)
            ? diagnosticSequence
            : null;
    }

    function handleGameOver(state) {
        if (!state.active) return;
        state.active = false;
        state.gameOvers++;
        counters.gameOvers++;
        if (currentStage) currentStage.events.gameOvers++;
        scheduleRejoin(state);
    }

    function scheduleRejoin(state) {
        if (
            stopping
            || abortReason
            || state.rejoinTimer
            || !state.connected
            || options.maxRejoinAttempts === 0
        ) {
            return;
        }

        state.rejoinTimer = setTimeout(async () => {
            state.rejoinTimer = null;
            if (stopping || abortReason || state.active || !state.connected) return;

            state.rejoinAttempts++;
            try {
                await joinClient(state, false, true);
            } catch (error) {
                state.lastError = error.message || String(error);
                if (state.rejoinAttempts < options.maxRejoinAttempts) {
                    scheduleRejoin(state);
                }
            }
        }, options.rejoinDelayMs);
    }

    function handleDisconnect(state, reason) {
        const wasConnected = state.connected;
        state.connected = false;
        state.active = false;
        if (wasConnected && !state.expectedDisconnect && !stopping) {
            counters.unexpectedDisconnects++;
            state.lastError = `disconnected: ${reason}`;
            if (currentStage) currentStage.events.unexpectedDisconnects++;
        }
    }

    function startActivityTimers() {
        inputTimer = setInterval(() => {
            for (const state of clients) {
                if (!state.active || !state.connected) continue;
                state.angle = normalizeAngle(
                    state.angle + state.turnRate * options.inputIntervalMs / 1000
                );
                if (random() < 0.0025) {
                    state.turnRate = random() * 0.8 - 0.4;
                }
                sendDirection(state);
            }
        }, options.inputIntervalMs);

        pingTimer = setInterval(() => {
            for (const state of clients) {
                if (!state.monitor || !state.active || !state.connected || state.pingInFlight) {
                    continue;
                }
                sendDiagnosticPing(state);
            }
        }, options.pingIntervalMs);
    }

    function stopActivityTimers() {
        clearInterval(inputTimer);
        clearInterval(pingTimer);
        inputTimer = null;
        pingTimer = null;
        for (const state of clients) {
            clearTimeout(state.rejoinTimer);
            state.rejoinTimer = null;
        }
    }

    function sendDirection(state) {
        state.socket.emit("inputDirection", {
            angle: state.angle,
            source: "pointer"
        });
    }

    function sendViewport(state) {
        state.socket.emit("viewport", {
            height: 1080,
            scale: 1,
            width: 1920
        });
    }

    function sendDiagnosticPing(state) {
        state.pingInFlight = true;
        const clientSentAt = Date.now();
        const started = performance.now();
        const timeout = setTimeout(() => {
            state.pingInFlight = false;
            if (currentStage) currentStage.events.pingTimeouts++;
        }, Math.max(options.pingIntervalMs * 2, 1000));

        state.socket.emit("networkDiagnosticsPing", { clientSentAt }, response => {
            clearTimeout(timeout);
            state.pingInFlight = false;
            const rtt = performance.now() - started;
            state.lastPingAt = Date.now();
            state.lastPingRttMs = rtt;

            if (response && Number.isFinite(response.serverTime)) {
                const offset = response.serverTime - (clientSentAt + rtt / 2);
                state.serverOffsetMs = state.serverOffsetMs === null
                    ? offset
                    : state.serverOffsetMs * 0.8 + offset * 0.2;
            }

            if (currentStage) currentStage.series.pingRttMs.add(rtt);
        });
    }

    function createStageState(stagePlan, rampDurationMs) {
        return {
            countersAtStart: { ...counters },
            events: {
                gameOvers: 0,
                missingSnapshotSequences: 0,
                monitorDiagnosticGaps: 0,
                pingTimeouts: 0,
                reliableAckTimeoutObservations: 0,
                reliableRetries: 0,
                sequenceGapEvents: 0,
                snapshots: 0,
                unexpectedDisconnects: 0
            },
            health: [],
            healthFailures: new Map(),
            plan: stagePlan,
            rampDurationMs,
            series: createStageSeries(stagePlan.index),
            startedAt: new Date().toISOString()
        };
    }

    function createStageSeries(stageIndex) {
        const seed = options.seed ^ Math.imul(stageIndex, 0x9e3779b1);
        return {
            activePlayers: new MetricSeries({ sampleLimit: 10000, seed: seed ^ 1 }),
            gameTickMs: new MetricSeries({ seed: seed ^ 2 }),
            loopDriftMs: new MetricSeries({ seed: seed ^ 3 }),
            payloadBytes: new MetricSeries({ seed: seed ^ 4 }),
            pingRttMs: new MetricSeries({ seed: seed ^ 5 }),
            serverSendIntervalMs: new MetricSeries({ seed: seed ^ 6 }),
            snapshotBuildMs: new MetricSeries({ seed: seed ^ 7 }),
            snapshotInterArrivalMs: new MetricSeries({ seed: seed ^ 8 }),
            snapshotLatencyMs: new MetricSeries({ seed: seed ^ 9 })
        };
    }

    function recordHealth(stage) {
        const activePlayers = countClients(client => client.active);
        const connectedClients = countClients(client => client.connected);
        const monitors = clients.filter(client => client.monitor && client.active);
        const now = Date.now();
        const starvedMonitors = monitors.filter(client => (
            !Number.isFinite(client.lastSnapshotAt)
            || now - client.lastSnapshotAt > options.abortSnapshotGapMs
        )).length;
        const slowMonitors = monitors.filter(client => (
            Number.isFinite(client.lastPingRttMs)
            && client.lastPingRttMs > options.abortRttMs
        )).length;
        const activeRatio = stage.plan.targetPlayers > 0
            ? activePlayers / stage.plan.targetPlayers
            : 1;
        const connectionFailureRatio = counters.connectionAttempts > 0
            ? (counters.connectionFailures + counters.joinFailures)
                / counters.connectionAttempts
            : 0;

        stage.series.activePlayers.add(activePlayers);
        stage.health.push({
            activePlayers,
            activeRatio: round(activeRatio),
            connectedClients,
            connectionFailureRatio: round(connectionFailureRatio),
            slowMonitors,
            starvedMonitors,
            timestamp: new Date().toISOString()
        });

        checkHealthFailure(stage, "active-player-ratio", activeRatio < options.abortActiveRatio);
        checkHealthFailure(stage, "connection-failure-ratio", (
            connectionFailureRatio > options.abortConnectionErrorRatio
        ));
        checkHealthFailure(stage, "snapshot-starvation", starvedMonitors > 0);
        checkHealthFailure(stage, "round-trip-time", slowMonitors > 0);
    }

    function checkHealthFailure(stage, name, failed) {
        const count = failed ? (stage.healthFailures.get(name) || 0) + 1 : 0;
        stage.healthFailures.set(name, count);

        if (count >= options.abortConsecutiveHealthFailures) {
            abortReason ||= `${name} failed ${count} consecutive health checks`;
        }
    }

    function finalizeStage(stage) {
        const metrics = {};
        for (const [name, series] of Object.entries(stage.series)) {
            metrics[name] = series.summarize();
        }

        const counterDelta = {};
        for (const [name, value] of Object.entries(counters)) {
            counterDelta[name] = value - stage.countersAtStart[name];
        }

        const result = {
            assessment: null,
            counters: counterDelta,
            durationMs: Date.now() - Date.parse(stage.startedAt),
            events: stage.events,
            health: stage.health,
            metrics,
            rampDurationMs: round(stage.rampDurationMs),
            roomCount: stage.plan.rooms.length,
            startedAt: stage.startedAt,
            targetPlayers: stage.plan.targetPlayers
        };
        result.assessment = assessStage(result, options);
        return result;
    }

    function createReport() {
        const statuses = stageReports.map(stage => stage.assessment.status);
        const status = fatalError || abortReason || statuses.includes("fail")
            ? "fail"
            : statuses.includes("warn") ? "warn" : "pass";

        return {
            schema: 1,
            generatedAt: new Date().toISOString(),
            status,
            abortReason,
            error: fatalError ? {
                message: fatalError.message || String(fatalError),
                stack: fatalError.stack || null
            } : null,
            options: createPublicOptions(options),
            plan,
            connections: {
                clientsCreated: clients.length,
                counters,
                metrics: {
                    connectMs: connectionSeries.connectMs.summarize(),
                    joinMs: connectionSeries.joinMs.summarize()
                },
                roomsCreated: rooms.filter(Boolean).length
            },
            stages: stageReports,
            timing: {
                durationMs: Date.now() - startedAt,
                startedAt: new Date(startedAt).toISOString()
            }
        };
    }

    async function disconnectAllClients() {
        for (let offset = 0; offset < clients.length; offset += 100) {
            for (const state of clients.slice(offset, offset + 100)) {
                state.expectedDisconnect = true;
                if (state.pendingJoin) {
                    clearTimeout(state.pendingJoin.timeout);
                    state.pendingJoin.reject(new Error("diagnostic stopped"));
                    state.pendingJoin = null;
                }
                state.socket.disconnect();
            }
            if (offset + 100 < clients.length) await delay(20);
        }
        if (options.recoveryMs > 0) await delay(options.recoveryMs);
    }

    function countClients(predicate) {
        let count = 0;
        for (const client of clients) {
            if (predicate(client)) count++;
        }
        return count;
    }

    function handleInterrupt() {
        abortReason ||= "interrupted";
    }
}

function assessStage(stage, options) {
    const issues = [];
    const active = stage.metrics.activePlayers;
    const snapshots = stage.metrics.snapshotInterArrivalMs;
    const rtt = stage.metrics.pingRttMs;
    const tick = stage.metrics.gameTickMs;

    addIssue(
        issues,
        "active-players",
        active.min !== null && active.min < stage.targetPlayers * options.warnActiveRatio,
        active.min !== null && active.min < stage.targetPlayers * options.abortActiveRatio,
        active.min,
        stage.targetPlayers * options.warnActiveRatio
    );
    addIssue(
        issues,
        "snapshot-inter-arrival-p99",
        snapshots.p99 !== null && snapshots.p99 > options.warnSnapshotIntervalMs,
        snapshots.max !== null && snapshots.max > options.abortSnapshotGapMs,
        snapshots.p99,
        options.warnSnapshotIntervalMs
    );
    addIssue(
        issues,
        "ping-rtt-p99",
        rtt.p99 !== null && rtt.p99 > options.warnRttMs,
        rtt.p99 !== null && rtt.p99 > options.abortRttMs,
        rtt.p99,
        options.warnRttMs
    );
    addIssue(
        issues,
        "game-tick-p99",
        tick.p99 !== null && tick.p99 > options.warnGameTickMs,
        tick.p99 !== null && tick.p99 > options.abortGameTickMs,
        tick.p99,
        options.warnGameTickMs
    );

    if (stage.events.unexpectedDisconnects > 0) {
        issues.push(createIssue(
            "unexpected-disconnects",
            "fail",
            stage.events.unexpectedDisconnects,
            0
        ));
    }
    if (stage.events.reliableRetries > 0 || stage.events.pingTimeouts > 0) {
        issues.push(createIssue(
            "transport-retries-or-timeouts",
            "warn",
            stage.events.reliableRetries + stage.events.pingTimeouts,
            0
        ));
    }

    return {
        issues,
        status: issues.some(issue => issue.severity === "fail")
            ? "fail"
            : issues.length > 0 ? "warn" : "pass"
    };
}

function addIssue(issues, name, warning, failure, value, threshold) {
    if (!warning && !failure) return;
    issues.push(createIssue(name, failure ? "fail" : "warn", value, threshold));
}

function createIssue(name, severity, value, threshold) {
    return {
        name,
        severity,
        threshold: round(threshold),
        value: round(value)
    };
}

function parseArguments(argumentsList) {
    const values = parseArgumentMap(argumentsList);
    const stageMs = getInteger(values, "stage-ms", 30000, 1000);

    return {
        abortActiveRatio: getNumber(values, "abort-active-ratio", 0.9, 0, 1),
        abortConsecutiveHealthFailures: getInteger(
            values,
            "abort-consecutive-health-failures",
            3,
            1,
            60
        ),
        abortConnectionErrorRatio: getNumber(
            values,
            "abort-connection-error-ratio",
            0.05,
            0,
            1
        ),
        abortGameTickMs: getNumber(values, "abort-game-tick-ms", 33.334, 1),
        abortRttMs: getNumber(values, "abort-rtt-ms", 500, 1),
        abortSnapshotGapMs: getInteger(values, "abort-snapshot-gap-ms", 3000, 100),
        allowRemote: getBoolean(values, "allow-remote", false),
        arenaCapacity: getInteger(values, "arena-capacity", 36, 1, 36),
        connectionIntervalMs: getInteger(values, "connection-interval-ms", 25, 0),
        connectTimeoutMs: getInteger(values, "connect-timeout-ms", 10000, 100),
        healthIntervalMs: getInteger(values, "health-interval-ms", 1000, 100),
        inputIntervalMs: getInteger(values, "input-interval-ms", 250, 34),
        mapSize: getNumber(values, "map-size", 2, 0.5, 2),
        maxRejoinAttempts: getInteger(values, "max-rejoin-attempts", 3, 0, 20),
        maxRooms: getInteger(values, "max-rooms", 50, 1, 50),
        output: path.resolve(projectRoot, values.get("output") || defaultOutput),
        pingIntervalMs: getInteger(values, "ping-interval-ms", 1000, 100),
        ramp: values.get("ramp") || "36,72,144",
        recoveryMs: getInteger(values, "recovery-ms", 2000, 0),
        rejoinDelayMs: getInteger(values, "rejoin-delay-ms", 500, 0),
        seed: getInteger(values, "seed", 0x20260724, 0, 0xffffffff),
        settleMs: getInteger(values, "settle-ms", 3000, 0),
        stageMs,
        transport: getChoice(values, "transport", "websocket", [
            "default",
            "polling",
            "websocket"
        ]),
        url: values.get("url") || "http://127.0.0.1:3000",
        warnActiveRatio: getNumber(values, "warn-active-ratio", 0.98, 0, 1),
        warnGameTickMs: getNumber(values, "warn-game-tick-ms", 16.667, 1),
        warnRttMs: getNumber(values, "warn-rtt-ms", 250, 1),
        warnSnapshotIntervalMs: getNumber(
            values,
            "warn-snapshot-interval-ms",
            150,
            1
        )
    };
}

function parseArgumentMap(argumentsList) {
    const supported = new Set([
        "abort-active-ratio",
        "abort-consecutive-health-failures",
        "abort-connection-error-ratio",
        "abort-game-tick-ms",
        "abort-rtt-ms",
        "abort-snapshot-gap-ms",
        "allow-remote",
        "arena-capacity",
        "connection-interval-ms",
        "connect-timeout-ms",
        "health-interval-ms",
        "input-interval-ms",
        "map-size",
        "max-rejoin-attempts",
        "max-rooms",
        "output",
        "ping-interval-ms",
        "ramp",
        "recovery-ms",
        "rejoin-delay-ms",
        "seed",
        "settle-ms",
        "stage-ms",
        "transport",
        "url",
        "warn-active-ratio",
        "warn-game-tick-ms",
        "warn-rtt-ms",
        "warn-snapshot-interval-ms"
    ]);
    const values = new Map();

    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (!argument.startsWith("--")) {
            throw new Error(`Unknown argument: ${argument}`);
        }
        const separator = argument.indexOf("=");
        const name = separator >= 0 ? argument.slice(2, separator) : argument.slice(2);
        if (!supported.has(name)) {
            throw new Error(`Unknown massive connection option: --${name}`);
        }
        const value = separator >= 0 ? argument.slice(separator + 1) : argumentsList[++index];
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`Missing value for --${name}.`);
        }
        values.set(name, value);
    }
    return values;
}

function assertTargetIsAllowed(options) {
    let target;
    try {
        target = new URL(options.url);
    } catch {
        throw new Error(`Invalid diagnostic URL: ${options.url}`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error("Diagnostic URL must use http or https.");
    }

    const hostname = target.hostname.toLowerCase();
    const local = hostname === "localhost"
        || hostname === "127.0.0.1"
        || hostname === "::1";

    if (!local && !options.allowRemote) {
        throw new Error(
            `Remote load target ${target.origin} is blocked. `
            + "Pass --allow-remote true only during an authorized load window."
        );
    }
}

function createPublicOptions(options) {
    return {
        abortActiveRatio: options.abortActiveRatio,
        abortConnectionErrorRatio: options.abortConnectionErrorRatio,
        abortRttMs: options.abortRttMs,
        abortSnapshotGapMs: options.abortSnapshotGapMs,
        arenaCapacity: options.arenaCapacity,
        connectionIntervalMs: options.connectionIntervalMs,
        inputIntervalMs: options.inputIntervalMs,
        mapSize: options.mapSize,
        maxRooms: options.maxRooms,
        pingIntervalMs: options.pingIntervalMs,
        ramp: options.ramp,
        settleMs: options.settleMs,
        stageMs: options.stageMs,
        transport: options.transport,
        url: options.url
    };
}

function createCounters() {
    return {
        connected: 0,
        connectionAttempts: 0,
        connectionFailures: 0,
        gameOvers: 0,
        joinAttempts: 0,
        joinFailures: 0,
        rejoinAttempts: 0,
        rejoinFailures: 0,
        successfulJoins: 0,
        successfulRejoins: 0,
        unexpectedDisconnects: 0
    };
}

function writeReport(output, report) {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(
        output.replace(/\.json$/i, ".md"),
        createMarkdownReport(report),
        "utf8"
    );
}

function createMarkdownReport(report) {
    const rows = report.stages.map(stage => (
        `| ${stage.targetPlayers} | ${stage.roomCount} | ${stage.metrics.activePlayers.min ?? "-"} `
        + `| ${stage.metrics.pingRttMs.p99 ?? "-"} | `
        + `${stage.metrics.snapshotInterArrivalMs.p99 ?? "-"} | `
        + `${stage.metrics.gameTickMs.p99 ?? "-"} | ${stage.assessment.status} |`
    )).join("\n");

    return `# Diagnóstico de conexões massivas

Gerado em: ${report.generatedAt}  
Estado: **${report.status}**  
Destino: ${report.options.url}  
Limite por arena: ${report.plan.arenaCapacity}  
Limite planejado: ${report.plan.maximumPlayers} jogadores em ${report.plan.maxRooms} arenas  
Interrupção automática: ${report.abortReason || "não"}

| Jogadores | Arenas | Ativos mín. | RTT p99 ms | Snapshot p99 ms | Tick p99 ms | Estado |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows || "| - | - | - | - | - | - | sem estágios concluídos |"}

O gerador cria jogadores reais do protocolo, confirma snapshots confiáveis, envia
viewport e mudanças graduais de direção, e distribui a carga sem ultrapassar o
limite de cada arena.
`;
}

function printSummary(report, output) {
    process.stdout.write(`\nMassive connection diagnostic: ${report.status}.\n`);
    for (const stage of report.stages) {
        process.stdout.write(
            `${stage.targetPlayers} players / ${stage.roomCount} rooms: `
            + `RTT p99 ${stage.metrics.pingRttMs.p99 ?? "n/a"} ms, `
            + `snapshot p99 ${stage.metrics.snapshotInterArrivalMs.p99 ?? "n/a"} ms, `
            + `tick p99 ${stage.metrics.gameTickMs.p99 ?? "n/a"} ms, `
            + `${stage.assessment.status}.\n`
        );
    }
    if (report.abortReason) {
        process.stdout.write(`Abort reason: ${report.abortReason}\n`);
    }
    process.stdout.write(`Report: ${output}\n`);
}

function getInteger(values, name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    const raw = values.get(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`--${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return value;
}

function getNumber(values, name, fallback, minimum, maximum = Number.POSITIVE_INFINITY) {
    const raw = values.get(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new RangeError(`--${name} must be a number from ${minimum} to ${maximum}.`);
    }
    return value;
}

function getBoolean(values, name, fallback) {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new TypeError(`--${name} must be true or false.`);
}

function getChoice(values, name, fallback, choices) {
    const value = values.get(name) || fallback;
    if (!choices.includes(value)) {
        throw new RangeError(`--${name} must be one of: ${choices.join(", ")}.`);
    }
    return value;
}

function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function normalizeAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function delay(durationMs) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, durationMs)));
}

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}
