const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const config = require("../config/gameConfig");
const { getPublicMatchCandidates: selectPublicMatchCandidates } = require("./matchmaking");
const { RoomWorkerClient } = require("./roomWorkerClient");

const WORKER_RESTART_DELAY_MS = 1000;

class RoomCoordinator extends EventEmitter {
    constructor(options = {}) {
        super();
        this.isDistributedRoomCoordinator = true;
        this.localRoomManager = options.localRoomManager;
        this.workerCount = normalizeWorkerCount(options.workerCount);
        this.workerFactory = options.workerFactory || (workerId => new RoomWorkerClient({ id: workerId }));
        this.workers = new Map();
        this.workerRoomCodes = new Map();
        this.workerReservations = new Map();
        this.workerMetrics = new Map();
        this.roomDirectory = new Map();
        this.roomOwners = new Map();
        this.connectionWorkers = new Map();
        this.reservedRoomCodes = new Set();
        this.pendingRoomCreations = 0;
        this.started = false;
        this.closing = false;
    }

    async start() {
        if (this.started) return;
        this.closing = false;

        const starts = [];
        for (let workerId = 1; workerId <= this.workerCount; workerId++) {
            starts.push(this.startWorker(workerId));
        }
        await Promise.all(starts);
        this.started = true;
    }

    async close() {
        this.closing = true;
        this.started = false;
        const workers = [...this.workers.values()];
        this.workers.clear();
        await Promise.allSettled(workers.map(worker => worker.close()));
    }

    createBackgroundRoom(io) {
        return this.localRoomManager.createBackgroundRoom(io);
    }

    listRooms() {
        return [...this.roomDirectory.values()]
            .map(entry => {
                const { workerId: _workerId, ...publicRoom } = entry;
                return publicRoom;
            })
            .sort((first, second) => first.createdAt - second.createdAt);
    }

    getPublicMatchCandidates(difficulty) {
        return selectPublicMatchCandidates(this.roomDirectory, difficulty);
    }

    async createAndJoinRoom(socket, options = {}) {
        this.assertStarted();

        if (this.roomDirectory.size + this.pendingRoomCreations >= config.rooms.maxRooms) {
            return { success: false, message: "Maximum number of rooms reached." };
        }

        const roomCode = this.generateRoomCode();
        const worker = this.selectWorker();
        if (!worker) return { success: false, message: "No room worker is available." };

        this.pendingRoomCreations++;
        this.reservedRoomCodes.add(roomCode);
        this.workerReservations.set(worker.id, (this.workerReservations.get(worker.id) || 0) + 1);

        try {
            const result = await worker.request("createAndJoinRoom", {
                password: options.password || "",
                playerOptions: options.playerOptions || {},
                roomOptions: {
                    ...(options.roomOptions || {}),
                    roomCode
                },
                socketData: serializeSocketData(socket),
                socketId: socket.id
            });

            if (result && result.success) {
                this.registerJoinedConnection(socket.id, roomCode, worker.id, result.room);
            }
            return result;
        } finally {
            this.pendingRoomCreations--;
            this.reservedRoomCodes.delete(roomCode);
            this.workerReservations.set(
                worker.id,
                Math.max(0, (this.workerReservations.get(worker.id) || 1) - 1)
            );
        }
    }

    async joinRoom(socket, roomCode, password = "", playerOptions = {}) {
        this.assertStarted();
        const normalizedRoomCode = normalizeRoomCode(roomCode);
        const workerId = this.roomOwners.get(normalizedRoomCode);
        const worker = this.workers.get(workerId);

        if (!normalizedRoomCode || !worker || !worker.ready) {
            return { success: false, message: "Room not found." };
        }

        const result = await worker.request("joinRoom", {
            password,
            playerOptions,
            roomCode: normalizedRoomCode,
            socketData: serializeSocketData(socket),
            socketId: socket.id
        });

        if (result && result.success) {
            this.registerJoinedConnection(socket.id, normalizedRoomCode, worker.id, result.room);
        }
        return result;
    }

    async leaveRoom(socket) {
        const socketId = socket && socket.id;
        const workerId = socketId && this.connectionWorkers.get(socketId);
        const worker = this.workers.get(workerId);
        const roomCode = socket && socket.data && socket.data.roomCode;

        if (!socketId || !worker || !worker.ready) {
            if (socketId) this.connectionWorkers.delete(socketId);
            return { destroyed: false, roomCode: roomCode || null };
        }

        try {
            const result = await worker.request("leaveRoom", { roomCode, socketId });
            if (result && result.destroyed && result.roomCode) {
                this.removeRoom(result.roomCode, workerId);
            }
            return result;
        } finally {
            this.connectionWorkers.delete(socketId);
        }
    }

    sendInput(socket, inputType, value) {
        const worker = this.getConnectionWorker(socket && socket.id);
        return worker ? worker.command("input", {
            inputType,
            socketId: socket.id,
            value
        }) : false;
    }

    sendSnapshotSignal(socket, signal, value = null) {
        const worker = this.getConnectionWorker(socket && socket.id);
        return worker ? worker.command("snapshotSignal", {
            signal,
            socketId: socket.id,
            value
        }) : false;
    }

    updateConnectionData(socket, data) {
        const worker = this.getConnectionWorker(socket && socket.id);
        return worker ? worker.command("connectionData", {
            data,
            socketId: socket.id
        }) : false;
    }

    acknowledge(workerId, acknowledgement) {
        const worker = this.workers.get(workerId);
        return worker ? worker.acknowledge(acknowledgement) : false;
    }

    confirmEventDelivery(workerId, deliveryId) {
        const worker = this.workers.get(workerId);
        return worker ? worker.confirmEventDelivery(deliveryId) : false;
    }

    hasActivePlayer(socket) {
        return Boolean(
            socket
            && socket.data
            && socket.data.playerActive === true
            && this.connectionWorkers.has(socket.id)
        );
    }

    getWorkerDiagnostics() {
        return [...this.workers.values()].map(worker => ({
            id: worker.id,
            metrics: this.workerMetrics.get(worker.id) || null,
            ready: worker.ready,
            roomCount: (this.workerRoomCodes.get(worker.id) || new Set()).size,
            reservationCount: this.workerReservations.get(worker.id) || 0
        }));
    }

    async startWorker(workerId) {
        const worker = this.workerFactory(workerId);
        this.workers.set(workerId, worker);
        this.workerRoomCodes.set(workerId, new Set());
        this.workerReservations.set(workerId, 0);
        this.workerMetrics.set(workerId, null);

        worker.on("directory", rooms => this.updateWorkerDirectory(workerId, rooms));
        worker.on("workerEvent", event => this.emit("workerEvent", { event, workerId }));
        worker.on("metrics", metrics => this.workerMetrics.set(workerId, metrics));
        worker.on("workerError", error => this.emit("workerError", { error, workerId }));
        worker.on("workerExit", details => this.handleWorkerExit(workerId, worker, details));

        return worker.start();
    }

    handleWorkerExit(workerId, exitedWorker, details) {
        if (this.workers.get(workerId) !== exitedWorker) return;

        this.workers.delete(workerId);
        this.workerMetrics.delete(workerId);
        const affectedSocketIds = [];
        for (const [socketId, connectionWorkerId] of this.connectionWorkers) {
            if (connectionWorkerId !== workerId) continue;
            affectedSocketIds.push(socketId);
            this.connectionWorkers.delete(socketId);
        }
        this.clearWorkerDirectory(workerId);
        this.emit("workerUnavailable", { affectedSocketIds, details, workerId });

        if (!this.closing && !details.expected) {
            setTimeout(() => {
                if (!this.closing && !this.workers.has(workerId)) {
                    this.startWorker(workerId).catch(error => {
                        this.emit("workerError", { error, workerId });
                    });
                }
            }, WORKER_RESTART_DELAY_MS);
        }
    }

    updateWorkerDirectory(workerId, rooms) {
        this.clearWorkerDirectory(workerId, false);
        const roomCodes = this.workerRoomCodes.get(workerId) || new Set();

        for (const rawRoom of rooms) {
            if (!rawRoom || !rawRoom.code) continue;
            const roomCode = normalizeRoomCode(rawRoom.code);
            const room = { ...rawRoom, code: roomCode, workerId };
            roomCodes.add(roomCode);
            this.roomDirectory.set(roomCode, room);
            this.roomOwners.set(roomCode, workerId);
        }

        this.workerRoomCodes.set(workerId, roomCodes);
        this.emit("roomsChanged", this.listRooms());
    }

    clearWorkerDirectory(workerId, emitChange = true) {
        const roomCodes = this.workerRoomCodes.get(workerId) || new Set();
        for (const roomCode of roomCodes) {
            this.roomDirectory.delete(roomCode);
            if (this.roomOwners.get(roomCode) === workerId) {
                this.roomOwners.delete(roomCode);
            }
        }
        this.workerRoomCodes.set(workerId, new Set());
        if (emitChange && roomCodes.size > 0) {
            this.emit("roomsChanged", this.listRooms());
        }
    }

    registerJoinedConnection(socketId, roomCode, workerId, room) {
        this.connectionWorkers.set(socketId, workerId);
        this.roomOwners.set(roomCode, workerId);

        if (room) {
            this.roomDirectory.set(roomCode, { ...room, code: roomCode, workerId });
            const roomCodes = this.workerRoomCodes.get(workerId) || new Set();
            roomCodes.add(roomCode);
            this.workerRoomCodes.set(workerId, roomCodes);
        }
    }

    removeRoom(roomCode, workerId) {
        const normalizedRoomCode = normalizeRoomCode(roomCode);
        this.roomDirectory.delete(normalizedRoomCode);
        if (this.roomOwners.get(normalizedRoomCode) === workerId) {
            this.roomOwners.delete(normalizedRoomCode);
        }
        const roomCodes = this.workerRoomCodes.get(workerId);
        if (roomCodes) roomCodes.delete(normalizedRoomCode);
        this.emit("roomsChanged", this.listRooms());
    }

    selectWorker() {
        let selectedWorker = null;
        let selectedLoad = Number.POSITIVE_INFINITY;

        for (const worker of this.workers.values()) {
            if (!worker.ready) continue;
            const load = this.calculateWorkerLoad(worker.id);
            if (load < selectedLoad) {
                selectedLoad = load;
                selectedWorker = worker;
            }
        }
        return selectedWorker;
    }

    calculateWorkerLoad(workerId) {
        const roomCodes = this.workerRoomCodes.get(workerId) || new Set();
        let playerCount = 0;
        let botCount = 0;

        for (const roomCode of roomCodes) {
            const room = this.roomDirectory.get(roomCode);
            playerCount += finiteNonNegative(room && room.playerCount);
            botCount += finiteNonNegative(room && room.botCount);
        }

        const reservations = this.workerReservations.get(workerId) || 0;
        const metrics = this.workerMetrics.get(workerId);
        const measuredTickDurationMs = finiteNonNegative(metrics && metrics.tickDurationMs);
        return (roomCodes.size + reservations) * 4
            + playerCount
            + botCount * 0.5
            + measuredTickDurationMs;
    }

    getConnectionWorker(socketId) {
        return this.workers.get(this.connectionWorkers.get(socketId)) || null;
    }

    generateRoomCode() {
        const availableChars = config.rooms.roomCodeCharset;
        const length = config.rooms.roomCodeLength;

        for (let attempt = 0; attempt < config.rooms.roomCodeMaxGenerationAttempts; attempt++) {
            let code = "";
            for (let index = 0; index < length; index++) {
                code += availableChars[crypto.randomInt(availableChars.length)];
            }
            const backgroundRoomCode = normalizeRoomCode(config.menuBackground.roomCode || "BOTS");
            if (
                code !== backgroundRoomCode
                && !this.roomDirectory.has(code)
                && !this.reservedRoomCodes.has(code)
            ) return code;
        }

        throw new Error("Unable to generate unique room code.");
    }

    assertStarted() {
        if (!this.started) throw new Error("Room coordinator has not started.");
    }
}

function normalizeWorkerCount(rawWorkerCount) {
    const workerCount = Number(rawWorkerCount);
    if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 3) {
        throw new RangeError("Room worker count must be an integer from 1 to 3.");
    }
    return workerCount;
}

function normalizeRoomCode(roomCode) {
    return String(roomCode || "").trim().toUpperCase();
}

function serializeSocketData(socket) {
    const data = socket && socket.data || {};
    return {
        captureOverlapAuditEnabled: Boolean(data.captureOverlapAuditEnabled),
        networkDiagnosticsEnabled: Boolean(data.networkDiagnosticsEnabled)
    };
}

function finiteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function createRoomCoordinator(options) {
    return new RoomCoordinator(options);
}

module.exports = {
    RoomCoordinator,
    createRoomCoordinator
};
