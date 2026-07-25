const CACHED_GLOBALS_SNAPSHOT_SCHEMA = 3;
const LEGACY_SNAPSHOT_SCHEMA = 2;
const MAX_SNAPSHOT_SCHEMA = CACHED_GLOBALS_SNAPSHOT_SCHEMA;

function applySocketSnapshotProtocol(socket) {
    if (!socket || typeof socket !== "object") {
        return LEGACY_SNAPSHOT_SCHEMA;
    }

    if (!socket.data || typeof socket.data !== "object") {
        socket.data = {};
    }

    const requestedSchema = socket.handshake
        && socket.handshake.auth
        && socket.handshake.auth.snapshotSchema;
    const snapshotSchema = normalizeSnapshotSchema(requestedSchema);

    socket.data.snapshotSchema = snapshotSchema;
    return snapshotSchema;
}

function getSocketSnapshotSchema(socket) {
    return normalizeSnapshotSchema(
        socket && socket.data && socket.data.snapshotSchema
    );
}

function normalizeSnapshotSchema(rawSchema) {
    const schema = Number(rawSchema);

    if (!Number.isSafeInteger(schema) || schema < CACHED_GLOBALS_SNAPSHOT_SCHEMA) {
        return LEGACY_SNAPSHOT_SCHEMA;
    }

    return Math.min(schema, MAX_SNAPSHOT_SCHEMA);
}

function supportsCachedSnapshotGlobals(schema) {
    return normalizeSnapshotSchema(schema) >= CACHED_GLOBALS_SNAPSHOT_SCHEMA;
}

function supportsCompactTrailUpdates(schema) {
    return normalizeSnapshotSchema(schema) >= CACHED_GLOBALS_SNAPSHOT_SCHEMA;
}

function supportsCompactTransientState(schema) {
    return normalizeSnapshotSchema(schema) >= CACHED_GLOBALS_SNAPSHOT_SCHEMA;
}

module.exports = {
    CACHED_GLOBALS_SNAPSHOT_SCHEMA,
    LEGACY_SNAPSHOT_SCHEMA,
    MAX_SNAPSHOT_SCHEMA,
    applySocketSnapshotProtocol,
    getSocketSnapshotSchema,
    normalizeSnapshotSchema,
    supportsCachedSnapshotGlobals,
    supportsCompactTrailUpdates,
    supportsCompactTransientState
};
