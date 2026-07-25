const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
    disableGatewayTransportDiagnostics,
    recordGatewaySocketEmission,
    setGatewayTransportDiagnosticsEnabled,
    takeGatewayTransportDiagnostics
} = require("../src/core/gatewayTransportDiagnostics");

test("gateway diagnostics measure snapshot emission, zlib and transport pressure", async () => {
    const fixture = createTransportFixture();
    const originalCompress = fixture.extension.compress;
    const originalInternalCompress = fixture.extension._compress;

    setGatewayTransportDiagnosticsEnabled(fixture.socket, true);

    await new Promise((resolve, reject) => {
        recordGatewaySocketEmission(
            fixture.socket,
            "gameState",
            { volatile: true },
            () => {
                fixture.transport.writable = false;
                fixture.connection.writeBuffer.push({ type: "message" });
                fixture.sender._bufferedBytes = 128;
                fixture.extension.compress(
                    '42["gameState",{"sequence":1}]',
                    true,
                    (error, compressed) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        fixture.tcpSocket.bytesWritten += compressed.byteLength + 2;
                        fixture.connection.writeBuffer.length = 0;
                        fixture.sender._bufferedBytes = 0;
                        fixture.transport.writable = true;
                        fixture.transport.emit("ready");
                        resolve();
                    }
                );
            }
        );
    });

    const diagnostics = takeGatewayTransportDiagnostics(fixture.socket);

    assert.equal(diagnostics.transport, "websocket");
    assert.equal(diagnostics.counters.snapshotEmitAttempts, 1);
    assert.equal(diagnostics.counters.compressionCount, 1);
    assert.equal(diagnostics.counters.compressionErrorCount, 0);
    assert.equal(diagnostics.counters.transportBusyPeriods, 1);
    assert.equal(diagnostics.counters.volatileDropCount, 0);
    assert.ok(diagnostics.bytes.uncompressedSnapshotBytes > 0);
    assert.equal(diagnostics.bytes.compressedSnapshotBytes, 3);
    assert.equal(diagnostics.bytes.physicalBytesWritten, 5);
    assert.equal(diagnostics.samples.emitDurationMs.length, 1);
    assert.equal(diagnostics.samples.compressionQueueMs.length, 1);
    assert.equal(diagnostics.samples.compressionExecutionMs.length, 1);
    assert.equal(diagnostics.samples.compressionTotalMs.length, 1);
    assert.equal(diagnostics.samples.transportBusyDurationMs.length, 1);

    fixture.transport.writable = false;
    recordGatewaySocketEmission(
        fixture.socket,
        "gameState",
        { volatile: true },
        () => undefined
    );
    fixture.transport.writable = true;
    const dropped = takeGatewayTransportDiagnostics(fixture.socket);
    assert.equal(dropped.counters.snapshotEmitAttempts, 1);
    assert.equal(dropped.counters.volatileDropCount, 1);

    disableGatewayTransportDiagnostics(fixture.socket);
    assert.equal(fixture.extension.compress, originalCompress);
    assert.equal(fixture.extension._compress, originalInternalCompress);
    assert.equal(takeGatewayTransportDiagnostics(fixture.socket), null);
});

test("gateway diagnostics degrade safely without ws private instrumentation", () => {
    const transport = new EventEmitter();
    transport.name = "polling";
    transport.writable = true;
    const connection = new EventEmitter();
    connection.transport = transport;
    connection.writeBuffer = [];
    const socket = { conn: connection };
    let emitted = false;

    setGatewayTransportDiagnosticsEnabled(socket, true);
    recordGatewaySocketEmission(socket, "gameState", {}, () => {
        emitted = true;
    });

    const diagnostics = takeGatewayTransportDiagnostics(socket);
    assert.equal(emitted, true);
    assert.equal(diagnostics.transport, "polling");
    assert.equal(diagnostics.counters.snapshotEmitAttempts, 1);
    assert.equal(diagnostics.counters.compressionCount, 0);

    disableGatewayTransportDiagnostics(socket);
});

function createTransportFixture() {
    const extension = {
        _compress(_data, _fin, callback) {
            setImmediate(() => callback(null, Buffer.from("zip")));
        },
        compress(data, fin, callback) {
            setImmediate(() => this._compress(data, fin, callback));
        }
    };
    const sender = {
        _bufferedBytes: 0,
        _queue: []
    };
    const tcpSocket = {
        bytesWritten: 100
    };
    const webSocket = {
        _extensions: {
            "permessage-deflate": extension
        },
        _sender: sender,
        _socket: tcpSocket,
        get bufferedAmount() {
            return sender._bufferedBytes;
        }
    };
    const transport = new EventEmitter();
    transport.name = "websocket";
    transport.socket = webSocket;
    transport.writable = true;
    const connection = new EventEmitter();
    connection.transport = transport;
    connection.writeBuffer = [];

    return {
        connection,
        extension,
        sender,
        socket: { conn: connection },
        tcpSocket,
        transport
    };
}
