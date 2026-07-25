const assert = require("node:assert/strict");
const test = require("node:test");
const { RoomWorkerClient } = require("../src/core/roomWorkerClient");
const { workerMessageTypes } = require("../src/core/roomWorkerProtocol");

test("room worker client forwards event batches without expanding them", () => {
    const client = new RoomWorkerClient({ id: 1 });
    const events = [
        { event: "first", socketId: "a" },
        { event: "second", socketId: "b" }
    ];
    let received = null;

    client.on("workerEventBatch", batch => {
        received = batch;
    });
    client.handleMessage({
        events,
        type: workerMessageTypes.EVENT_BATCH
    });

    assert.strictEqual(received, events);
});

test("room worker client keeps individual event compatibility", () => {
    const client = new RoomWorkerClient({ id: 1 });
    const event = { event: "legacy", socketId: "a" };
    let received = null;

    client.on("workerEvent", value => {
        received = value;
    });
    client.handleMessage({
        event,
        type: workerMessageTypes.EVENT
    });

    assert.strictEqual(received, event);
});

test("room worker client confirms unique delivery ids in one message", () => {
    const messages = [];
    const client = new RoomWorkerClient({ id: 1 });

    client.ready = true;
    client.worker = {
        postMessage(message) {
            messages.push(message);
        }
    };

    assert.equal(client.confirmEventDeliveries(["one", "two", "one", null]), true);
    assert.deepEqual(messages, [{
        deliveryIds: ["one", "two"],
        type: workerMessageTypes.EVENTS_DELIVERED
    }]);
    assert.equal(client.confirmEventDeliveries([]), false);
    assert.equal(messages.length, 1);
});

test("room worker client groups reliable acknowledgements in a short window", async () => {
    const messages = [];
    const client = new RoomWorkerClient({
        acknowledgementBatchDelayMs: 1,
        id: 1
    });

    client.ready = true;
    client.worker = {
        postMessage(message) {
            messages.push(message);
        }
    };

    assert.equal(client.acknowledge({ acknowledgementId: "one" }), true);
    assert.equal(client.acknowledge({ acknowledgementId: "two" }), true);

    await new Promise(resolve => setTimeout(resolve, 10));

    assert.deepEqual(messages, [{
        acknowledgements: [
            { acknowledgementId: "one" },
            { acknowledgementId: "two" }
        ],
        type: workerMessageTypes.ACKNOWLEDGEMENT_BATCH
    }]);
});
