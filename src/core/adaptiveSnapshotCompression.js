const states = new WeakMap();

function prepareSocketEmission(socket, options = {}) {
    const eventName = options.eventName;
    const volatile = Boolean(options.volatile);

    if (!volatile) {
        return {
            compressionBypassed: false,
            emitter: socket
        };
    }

    if (
        !options.adaptiveCompressionEnabled
        || eventName !== "gameState"
        || !socket
    ) {
        return {
            compressionBypassed: false,
            emitter: getVolatileEmitter(socket)
        };
    }

    const state = getState(socket);
    if (!isTransportWritable(socket)) {
        state.recoveryPending = true;
        return {
            compressionBypassed: false,
            emitter: getVolatileEmitter(socket)
        };
    }

    if (!state.recoveryPending || typeof socket.compress !== "function") {
        return {
            compressionBypassed: false,
            emitter: getVolatileEmitter(socket)
        };
    }

    state.recoveryPending = false;
    return {
        compressionBypassed: true,
        emitter: getVolatileEmitter(socket.compress(false))
    };
}

function resetAdaptiveSnapshotCompression(socket) {
    if (socket && typeof socket === "object") states.delete(socket);
}

function getState(socket) {
    let state = states.get(socket);
    if (!state) {
        state = { recoveryPending: false };
        states.set(socket, state);
    }
    return state;
}

function isTransportWritable(socket) {
    const transport = socket
        && socket.conn
        && socket.conn.transport;

    return !transport || transport.writable !== false;
}

function getVolatileEmitter(socket) {
    return socket && socket.volatile || socket;
}

module.exports = {
    prepareSocketEmission,
    resetAdaptiveSnapshotCompression
};
