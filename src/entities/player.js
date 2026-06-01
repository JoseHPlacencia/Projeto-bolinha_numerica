const { createSpawn } = require("../systems/spawnSystem");

const INPUT_ANGLE_CHANGE_EPSILON = 0.025;

function createRandomColor() {
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue},80%,50%)`;
}

function getRandomAngle() {
    return Math.random() * Math.PI * 2;
}

function getLastSetValue(values) {
    let lastValue = null;

    for (const value of values) {
        lastValue = value;
    }

    return lastValue;
}

class Player {
    constructor(id, spawn) {
        this.id = id;
        this.pressedActions = new Set();
        this.lastAction = null;
        this.directionAngle = null;
        this.directionSource = null;
        this.pendingDirectionAngle = null;
        this.lastMouseDirectionAngle = null;
        this.inputVersion = 0;
<<<<<<< HEAD
        this.boundarySlideInputVersion = 0;
        this.debugState = null;
=======
        this.infoVersion = 0;
        this.boundarySlideInputVersion = 0;
        this.debugState = null;
        this.viewport = null;
>>>>>>> 70aca42 (teste)
        this.reconnect(spawn);
    }

    reconnect(spawn) {
        this.x = spawn.x;
        this.y = spawn.y;
        this.angle = getRandomAngle();
        this.color = createRandomColor();
        this.territoryX = spawn.x;
        this.territoryY = spawn.y;
<<<<<<< HEAD
=======
        this.markInfoChanged();
>>>>>>> 70aca42 (teste)
        this.clearInput();
        this.clearTrailState();
    }

    returnToSpawn() {
        this.x = this.territoryX;
        this.y = this.territoryY;
        this.angle = getRandomAngle();
        this.boundarySlideDirection = null;
        this.clearTrailState();
    }

    setSpawnPoint(point) {
        this.territoryX = point.x;
        this.territoryY = point.y;
<<<<<<< HEAD
=======
        this.markInfoChanged();
    }

    setViewport(viewport) {
        this.viewport = viewport;
>>>>>>> 70aca42 (teste)
    }

    clearInput() {
        this.pressedActions.clear();
        this.lastAction = null;
        this.directionAngle = null;
        this.directionSource = null;
        this.pendingDirectionAngle = null;
        this.lastMouseDirectionAngle = null;
        this.inputVersion = 0;
        this.boundarySlideInputVersion = 0;
        this.debugState = null;
        this.boundarySlideDirection = null;
    }

    clearTrailState() {
        this.trailLeftSegments = [];
        this.trailRightSegments = [];
        this.trailLeftFillPath = [];
        this.trailRightFillPath = [];
        this.isLeftTrailActive = false;
        this.isRightTrailActive = false;
        this.lastLeftTrailPoint = null;
        this.lastRightTrailPoint = null;
    }

    pressAction(action) {
        if (!this.pressedActions.has(action)) {
            this.pressedActions.add(action);
            this.lastAction = action;
            this.markInputChanged();
        }
    }

    releaseAction(action) {
        const previousAction = this.lastAction;
        const wasPressed = this.pressedActions.delete(action);

        if (this.lastAction === action) {
            this.lastAction = getLastSetValue(this.pressedActions);
        }

        if (wasPressed && this.lastAction !== previousAction) {
            this.markInputChanged();
        }
    }

    setDirectionAngle(angle, source = null) {
        if (source === "mouse") {
            this.setPendingMouseDirectionAngle(angle);
            return;
        }

        if (hasDirectionInputChanged(this.directionAngle, this.directionSource, angle, source)) {
            this.markInputChanged();
        }

        this.directionAngle = angle;
        this.directionSource = source;
    }

    setPendingMouseDirectionAngle(angle) {
        if (!hasDirectionInputChanged(this.lastMouseDirectionAngle, "mouse", angle, "mouse")) {
            return;
        }

        this.directionAngle = angle;
        this.directionSource = "mouse";
        this.pendingDirectionAngle = angle;
        this.lastMouseDirectionAngle = angle;
        this.markInputChanged();
    }

    clearDirectionAngle() {
        if (Number.isFinite(this.directionAngle) || this.directionSource !== null) {
            this.markInputChanged();
        }

        this.directionAngle = null;
        this.directionSource = null;
        this.pendingDirectionAngle = null;
    }

    consumePendingDirectionAngle() {
        this.pendingDirectionAngle = null;
    }

    markInputChanged() {
        this.inputVersion++;
    }

<<<<<<< HEAD
=======
    markInfoChanged() {
        this.infoVersion++;
    }

>>>>>>> 70aca42 (teste)
    serialize() {
        const serializedPlayer = {
            id: this.id,
            x: this.x,
            y: this.y,
            angle: this.angle,
            color: this.color,
            territoryX: this.territoryX,
            territoryY: this.territoryY
        };

        if (this.debugState) {
            serializedPlayer.debug = this.debugState;
        }

<<<<<<< HEAD
        if (this.capturas && this.capturas.length > 0) {
            serializedPlayer.capturas = this.capturas.slice();
            this.capturas = []; // flush após serializar
        }

=======
>>>>>>> 70aca42 (teste)
        return serializedPlayer;
    }
}

function createPlayer(players, id, territories = null) {
    const player = new Player(id, createSpawn(players, territories));
    players.set(id, player);
    return player;
}

function hasDirectionInputChanged(currentAngle, currentSource, nextAngle, nextSource) {
    if (currentSource !== nextSource || !Number.isFinite(currentAngle)) {
        return true;
    }

    return Math.abs(getAngleDelta(currentAngle, nextAngle)) >= INPUT_ANGLE_CHANGE_EPSILON;
}

function getAngleDelta(fromAngle, toAngle) {
    return Math.atan2(
        Math.sin(toAngle - fromAngle),
        Math.cos(toAngle - fromAngle)
    );
}

function reconnectPlayerAsNew(players, player, territories = null) {
    player.reconnect(createSpawn(getOtherPlayers(players, player.id), territories));

    return player;
}

function returnPlayerToSpawn(player) {
    player.returnToSpawn();
    return player;
}

function getOtherPlayers(players, excludedPlayerId) {
    const otherPlayers = new Map(players);

    otherPlayers.delete(excludedPlayerId);

    return otherPlayers;
}

module.exports = {
    Player,
    createPlayer,
    reconnectPlayerAsNew,
    returnPlayerToSpawn
};
