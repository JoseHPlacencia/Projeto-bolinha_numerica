(async () => {
    try {
        const gameConfig = await loadGameConfig();
        startClient(gameConfig);
    } catch (error) {
        console.error("Failed to start client:", error);
    }
})();

async function loadGameConfig() {
    const response = await fetch("/game-config");

    if (!response.ok) {
        throw new Error(`Config request failed with status ${response.status}`);
    }

    return response.json();
}

function startClient(gameConfig) {
    const socket = io({
        transports: gameConfig.socket.transports
    });

    const canvas = document.getElementById("gameCanvas");
    const context = canvas.getContext("2d");
    const validInputKeys = new Set(gameConfig.inputKeys);
    const snapshots = [];

    const networkState = {
        bufferMs: gameConfig.network.initialBufferMs,
        serverOffset: 0,
        lastSnapshotReceivedAt: performance.now(),
        deltas: []
    };

    let canvasScale = 1;
    let myId = null;

    function resizeCanvas() {
        let width = window.innerWidth;
        let height = window.innerHeight;
        const aspectRatio = width / height;

        if (aspectRatio < gameConfig.screen.minAspectRatio) {
            height = width / gameConfig.screen.minAspectRatio;
        } else if (aspectRatio > gameConfig.screen.maxAspectRatio) {
            width = height * gameConfig.screen.maxAspectRatio;
        }

        canvas.width = width;
        canvas.height = height;

        canvasScale = Math.min(
            width / gameConfig.screen.virtualWidth,
            height / gameConfig.screen.virtualHeight
        );
    }

    function getEventKey(event) {
        return event.key.toLowerCase();
    }

    function sendInput(event, eventName) {
        const key = getEventKey(event);

        if (!validInputKeys.has(key)) {
            return;
        }

        event.preventDefault();
        socket.emit(eventName, key);
    }

    function calculateAverage(values) {
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    function calculateStandardDeviation(values, average) {
        const variance = values
            .map(value => (value - average) ** 2)
            .reduce((sum, value) => sum + value, 0) / values.length;

        return Math.sqrt(variance);
    }

    function updateAdaptiveBuffer(now) {
        const delta = now - networkState.lastSnapshotReceivedAt;
        networkState.lastSnapshotReceivedAt = now;
        networkState.deltas.push(delta);

        if (networkState.deltas.length > gameConfig.network.maxJitterSamples) {
            networkState.deltas.shift();
        }

        const average = calculateAverage(networkState.deltas);
        const jitter = calculateStandardDeviation(networkState.deltas, average);
        const nextBuffer = average + jitter * gameConfig.network.jitterMultiplier;

        networkState.bufferMs = clamp(
            nextBuffer,
            gameConfig.network.minBufferMs,
            gameConfig.network.maxBufferMs
        );
    }

    function syncServerClock(serverTime) {
        const nextOffset = Date.now() - serverTime;
        networkState.serverOffset = networkState.serverOffset * 0.9 + nextOffset * 0.1;
    }

    function saveSnapshot(snapshot) {
        snapshots.push({
            time: snapshot.time,
            players: structuredClone(snapshot.players)
        });

        while (snapshots.length > gameConfig.network.maxSnapshots) {
            snapshots.shift();
        }
    }

    function processSnapshot(snapshot) {
        updateAdaptiveBuffer(performance.now());
        syncServerClock(snapshot.time);
        saveSnapshot(snapshot);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(value, max));
    }

    function lerp(a, b, amount) {
        return a + (b - a) * amount;
    }

    function lerpAngle(a, b, amount) {
        let delta = b - a;

        while (delta < -Math.PI) {
            delta += Math.PI * 2;
        }

        while (delta > Math.PI) {
            delta -= Math.PI * 2;
        }

        return a + delta * amount;
    }

    function findSnapshotPair(renderTime) {
        let previous = snapshots[0];
        let next = snapshots[1];

        if (renderTime <= previous.time) {
            return { previous, next };
        }

        for (let index = 0; index < snapshots.length - 1; index++) {
            previous = snapshots[index];
            next = snapshots[index + 1];

            if (previous.time <= renderTime && next.time >= renderTime) {
                return { previous, next };
            }
        }

        return { previous, next };
    }

    function interpolatePlayers(previous, next, amount) {
        const renderedPlayers = {};
        const ids = new Set([
            ...Object.keys(previous.players),
            ...Object.keys(next.players)
        ]);

        for (const id of ids) {
            const previousPlayer = previous.players[id];
            const nextPlayer = next.players[id];

            if (!previousPlayer && nextPlayer) {
                renderedPlayers[id] = nextPlayer;
                continue;
            }

            if (previousPlayer && !nextPlayer) {
                continue;
            }

            renderedPlayers[id] = {
                ...nextPlayer,
                x: lerp(previousPlayer.x, nextPlayer.x, amount),
                y: lerp(previousPlayer.y, nextPlayer.y, amount),
                angle: lerpAngle(previousPlayer.angle, nextPlayer.angle, amount)
            };
        }

        return renderedPlayers;
    }

    function getRenderState() {
        if (snapshots.length === 0) {
            return null;
        }

        if (snapshots.length === 1) {
            return snapshots[0].players;
        }

        const serverNow = Date.now() - networkState.serverOffset;
        const renderTime = serverNow - networkState.bufferMs;
        const { previous, next } = findSnapshotPair(renderTime);
        const interval = next.time - previous.time || 1;
        const amount = clamp((renderTime - previous.time) / interval, 0, 1);

        return interpolatePlayers(previous, next, amount);
    }

    function drawBase(player) {
        context.globalAlpha = 0.66;
        context.fillStyle = player.color;

        context.beginPath();
        context.arc(player.baseX, player.baseY, gameConfig.world.baseRadius, 0, Math.PI * 2);
        context.fill();

        context.globalAlpha = 1;
        context.lineWidth = 6;
        context.strokeStyle = player.color;

        context.beginPath();
        context.arc(player.baseX, player.baseY, gameConfig.world.baseRadius, 0, Math.PI * 2);
        context.stroke();
    }

    function drawPlayer(player) {
        context.save();

        context.translate(player.x, player.y);
        context.rotate(player.angle);

        context.fillStyle = "rgba(0,0,0,.12)";
        context.fillRect(-30, -30, 70, 70);

        context.fillStyle = player.color;
        context.fillRect(-35, -35, 70, 70);

        context.lineWidth = 4;
        context.strokeStyle = "#000";
        context.strokeRect(-35, -35, 70, 70);

        context.fillStyle = "#fff";
        context.fillRect(18, -23, 12, 12);
        context.fillRect(18, 11, 12, 12);

        context.fillStyle = "#000";
        context.fillRect(24, -20, 6, 6);
        context.fillRect(24, 14, 6, 6);

        context.restore();
    }

    function drawMap() {
        context.beginPath();
        context.arc(0, 0, gameConfig.world.mapRadius, 0, Math.PI * 2);
        context.fillStyle = "#fff";
        context.fill();

        context.lineWidth = 15;
        context.strokeStyle = "#222";
        context.stroke();
    }

    function drawWorld(state, currentPlayer) {
        const players = Object.values(state);

        context.save();
        context.translate(canvas.width / 2, canvas.height / 2);
        context.scale(canvasScale, canvasScale);
        context.translate(-currentPlayer.x, -currentPlayer.y);

        drawMap();

        for (const player of players) {
            drawBase(player);
        }

        for (const player of players) {
            if (player.id !== myId) {
                drawPlayer(player);
            }
        }

        drawPlayer(currentPlayer);
        context.restore();
    }

    function render() {
        requestAnimationFrame(render);

        const state = getRenderState();

        if (!state) {
            return;
        }

        const currentPlayer = state[myId];

        if (!currentPlayer) {
            return;
        }

        context.clearRect(0, 0, canvas.width, canvas.height);
        drawWorld(state, currentPlayer);
    }

    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("keydown", event => {
        if (!event.repeat) {
            sendInput(event, "inputDown");
        }
    });
    window.addEventListener("keyup", event => sendInput(event, "inputUp"));

    socket.on("connect", () => {
        myId = socket.id;
    });

    socket.on("gameState", processSnapshot);

    resizeCanvas();
    render();
}
