const { performance } = require("node:perf_hooks");

const config = require("../config/gameConfig");

const PER_MESSAGE_DEFLATE_EXTENSION = "permessage-deflate";
const states = new WeakMap();

function setGatewayTransportDiagnosticsEnabled(socket, enabled) {
    if (!socket || typeof socket !== "object") return;

    if (!enabled) {
        disableGatewayTransportDiagnostics(socket);
        return;
    }
    if (states.has(socket)) return;

    const state = {
        compressionHook: null,
        connection: socket.conn || null,
        enabled: true,
        interval: createInterval(),
        lastPhysicalBytesWritten: null,
        onTransportReady: null,
        onUpgrade: null,
        transport: null,
        transportBusyStartedAt: null
    };
    states.set(socket, state);

    if (state.connection && typeof state.connection.on === "function") {
        state.onUpgrade = transport => {
            attachTransport(state, transport || state.connection.transport);
        };
        state.connection.on("upgrade", state.onUpgrade);
    }

    attachTransport(state, state.connection && state.connection.transport);
}

function disableGatewayTransportDiagnostics(socket) {
    const state = socket && states.get(socket);
    if (!state) return;

    state.enabled = false;
    detachTransport(state);
    if (
        state.connection
        && state.onUpgrade
        && typeof state.connection.off === "function"
    ) {
        state.connection.off("upgrade", state.onUpgrade);
    }
    states.delete(socket);
}

function recordGatewaySocketEmission(socket, eventName, options, emit) {
    const state = socket && states.get(socket);
    if (
        !state
        || !state.enabled
        || eventName !== "gameState"
        || typeof emit !== "function"
    ) {
        return typeof emit === "function" ? emit() : undefined;
    }

    ensureCurrentTransport(state);
    const startedAt = performance.now();
    const transport = state.transport;
    const volatile = Boolean(options && options.volatile);
    const writableBefore = !transport || transport.writable !== false;

    state.interval.counters.snapshotEmitAttempts++;
    if (options && options.adaptiveCompressionBypass) {
        state.interval.counters.adaptiveCompressionBypassCount++;
        state.interval.bytes.bypassedSnapshotBytes += finiteNonNegative(
            options.snapshotPayloadBytes
        );
    }
    if (volatile && !writableBefore) {
        state.interval.counters.volatileDropCount++;
    }
    sampleTransportQueues(state);

    try {
        return emit();
    } finally {
        state.interval.samples.emitDurationMs.push(performance.now() - startedAt);
        sampleTransportQueues(state);
        if (transport && transport.writable === false) {
            markTransportBusy(state, startedAt);
        }
    }
}

function takeGatewayTransportDiagnostics(socket) {
    const state = socket && states.get(socket);
    if (!state || !state.enabled) return null;

    ensureCurrentTransport(state);
    const physicalBytesWritten = takePhysicalBytesWritten(state);
    const interval = state.interval;
    state.interval = createInterval();

    return {
        bytes: {
            bypassedSnapshotBytes: interval.bytes.bypassedSnapshotBytes,
            compressedSnapshotBytes: interval.bytes.compressedSnapshotBytes,
            physicalBytesWritten,
            uncompressedSnapshotBytes: interval.bytes.uncompressedSnapshotBytes
        },
        compressionLevel: config.socket.perMessageDeflate.zlibDeflateOptions.level,
        counters: { ...interval.counters },
        instrumentation: describeInstrumentation(state),
        samples: copySamples(interval.samples),
        transport: state.transport && state.transport.name || null,
        updatedAt: Date.now()
    };
}

function describeInstrumentation(state) {
    const webSocket = state.transport && state.transport.socket;
    const extensions = webSocket && webSocket._extensions;

    return {
        adaptiveSnapshotCompressionEnabled: Boolean(
            config.socket.adaptiveSnapshotCompressionEnabled
        ),
        compressionHooked: Boolean(state.compressionHook),
        extensionNames: extensions && typeof extensions === "object"
            ? Object.keys(extensions)
            : [],
        hasWebSocket: Boolean(webSocket)
    };
}

function attachTransport(state, transport) {
    if (!transport || state.transport === transport) return;

    detachTransport(state);
    state.transport = transport;
    state.lastPhysicalBytesWritten = readPhysicalBytesWritten(transport);
    state.onTransportReady = () => {
        finishTransportBusyPeriod(state);
        sampleTransportQueues(state);
    };

    if (typeof transport.on === "function") {
        transport.on("ready", state.onTransportReady);
    }
    installCompressionHook(state, transport);
}

function detachTransport(state) {
    finishTransportBusyPeriod(state);
    restoreCompressionHook(state);

    if (
        state.transport
        && state.onTransportReady
        && typeof state.transport.off === "function"
    ) {
        state.transport.off("ready", state.onTransportReady);
    }

    state.transport = null;
    state.onTransportReady = null;
    state.lastPhysicalBytesWritten = null;
}

function ensureCurrentTransport(state) {
    const currentTransport = state.connection && state.connection.transport;
    if (currentTransport && currentTransport !== state.transport) {
        attachTransport(state, currentTransport);
    }
}

function installCompressionHook(state, transport) {
    const webSocket = transport && transport.socket;
    const extension = webSocket
        && webSocket._extensions
        && webSocket._extensions[PER_MESSAGE_DEFLATE_EXTENSION];

    if (
        !extension
        || typeof extension.compress !== "function"
        || typeof extension._compress !== "function"
    ) {
        return;
    }

    const originalCompress = extension.compress;
    const originalInternalCompress = extension._compress;
    const pendingOperations = [];

    function instrumentedInternalCompress(data, fin, callback) {
        const operation = pendingOperations.shift() || null;
        if (operation) {
            operation.executionStartedAt = performance.now();
        }

        return originalInternalCompress.call(this, data, fin, (error, result) => {
            if (operation) {
                operation.executionDurationMs = (
                    performance.now() - operation.executionStartedAt
                );
            }
            callback(error, result);
        });
    }

    function instrumentedCompress(data, fin, callback) {
        const operation = {
            executionDurationMs: null,
            executionStartedAt: null,
            inputBytes: getByteLength(data),
            queuedAt: performance.now(),
            snapshot: isSnapshotFrame(data)
        };
        state.interval.counters.compressionCallCount++;
        if (!operation.snapshot) {
            state.interval.counters.unclassifiedCompressionCount++;
        }
        pendingOperations.push(operation);

        if (operation.snapshot) {
            markTransportBusy(state, operation.queuedAt);
        }

        try {
            return originalCompress.call(this, data, fin, (error, result) => {
                recordCompressionOperation(state, operation, error, result);
                callback(error, result);
            });
        } catch (error) {
            const pendingIndex = pendingOperations.indexOf(operation);
            if (pendingIndex >= 0) pendingOperations.splice(pendingIndex, 1);
            throw error;
        }
    }

    extension._compress = instrumentedInternalCompress;
    extension.compress = instrumentedCompress;
    state.compressionHook = {
        extension,
        instrumentedCompress,
        instrumentedInternalCompress,
        originalCompress,
        originalInternalCompress
    };
}

function restoreCompressionHook(state) {
    const hook = state.compressionHook;
    if (!hook) return;

    if (hook.extension.compress === hook.instrumentedCompress) {
        hook.extension.compress = hook.originalCompress;
    }
    if (hook.extension._compress === hook.instrumentedInternalCompress) {
        hook.extension._compress = hook.originalInternalCompress;
    }
    state.compressionHook = null;
}

function recordCompressionOperation(state, operation, error, result) {
    if (!state.enabled || !operation.snapshot) return;

    const finishedAt = performance.now();
    const totalDurationMs = finishedAt - operation.queuedAt;
    const executionDurationMs = Number.isFinite(operation.executionDurationMs)
        ? operation.executionDurationMs
        : totalDurationMs;
    const queueDurationMs = Number.isFinite(operation.executionStartedAt)
        ? Math.max(0, operation.executionStartedAt - operation.queuedAt)
        : 0;

    state.interval.counters.compressionCount++;
    if (error) state.interval.counters.compressionErrorCount++;
    state.interval.bytes.uncompressedSnapshotBytes += operation.inputBytes;
    state.interval.bytes.compressedSnapshotBytes += getByteLength(result);
    state.interval.samples.compressionExecutionMs.push(executionDurationMs);
    state.interval.samples.compressionQueueMs.push(queueDurationMs);
    state.interval.samples.compressionTotalMs.push(totalDurationMs);
}

function markTransportBusy(state, startedAt) {
    if (!Number.isFinite(state.transportBusyStartedAt)) {
        state.transportBusyStartedAt = startedAt;
    }
}

function finishTransportBusyPeriod(state) {
    if (!Number.isFinite(state.transportBusyStartedAt)) return;

    const durationMs = Math.max(0, performance.now() - state.transportBusyStartedAt);
    state.transportBusyStartedAt = null;
    state.interval.counters.transportBusyPeriods++;
    state.interval.samples.transportBusyDurationMs.push(durationMs);
}

function sampleTransportQueues(state) {
    const transport = state.transport;
    const webSocket = transport && transport.socket;
    const sender = webSocket && webSocket._sender;
    const connection = state.connection;

    addFiniteSample(
        state.interval.samples.engineWriteBufferLength,
        connection && Array.isArray(connection.writeBuffer)
            ? connection.writeBuffer.length
            : null
    );
    addFiniteSample(
        state.interval.samples.senderBufferedBytes,
        sender && sender._bufferedBytes
    );
    addFiniteSample(
        state.interval.samples.senderQueueLength,
        sender && Array.isArray(sender._queue) ? sender._queue.length : null
    );
    addFiniteSample(
        state.interval.samples.webSocketBufferedBytes,
        webSocket && webSocket.bufferedAmount
    );
}

function takePhysicalBytesWritten(state) {
    const current = readPhysicalBytesWritten(state.transport);
    const previous = state.lastPhysicalBytesWritten;
    state.lastPhysicalBytesWritten = current;

    if (!Number.isFinite(current) || !Number.isFinite(previous) || current < previous) {
        return 0;
    }
    return current - previous;
}

function readPhysicalBytesWritten(transport) {
    const socket = transport && transport.socket;
    const tcpSocket = socket && socket._socket;
    const bytesWritten = tcpSocket && Number(tcpSocket.bytesWritten);
    return Number.isFinite(bytesWritten) ? bytesWritten : null;
}

function isSnapshotFrame(data) {
    const prefix = getFramePrefix(data);
    return prefix.includes('["gameState",');
}

function getFramePrefix(data) {
    if (typeof data === "string") return data.slice(0, 64);
    if (Buffer.isBuffer(data)) return data.subarray(0, 64).toString("utf8");
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 64))
            .toString("utf8");
    }
    return "";
}

function getByteLength(value) {
    if (typeof value === "string") return Buffer.byteLength(value);
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    return 0;
}

function createInterval() {
    return {
        bytes: {
            bypassedSnapshotBytes: 0,
            compressedSnapshotBytes: 0,
            uncompressedSnapshotBytes: 0
        },
        counters: {
            adaptiveCompressionBypassCount: 0,
            compressionCallCount: 0,
            compressionCount: 0,
            compressionErrorCount: 0,
            snapshotEmitAttempts: 0,
            transportBusyPeriods: 0,
            unclassifiedCompressionCount: 0,
            volatileDropCount: 0
        },
        samples: {
            compressionExecutionMs: [],
            compressionQueueMs: [],
            compressionTotalMs: [],
            emitDurationMs: [],
            engineWriteBufferLength: [],
            senderBufferedBytes: [],
            senderQueueLength: [],
            transportBusyDurationMs: [],
            webSocketBufferedBytes: []
        }
    };
}

function copySamples(samples) {
    return Object.fromEntries(
        Object.entries(samples).map(([name, values]) => [name, [...values]])
    );
}

function addFiniteSample(target, value) {
    if (Number.isFinite(Number(value))) target.push(Number(value));
}

function finiteNonNegative(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0;
}

module.exports = {
    disableGatewayTransportDiagnostics,
    recordGatewaySocketEmission,
    setGatewayTransportDiagnosticsEnabled,
    takeGatewayTransportDiagnostics
};
