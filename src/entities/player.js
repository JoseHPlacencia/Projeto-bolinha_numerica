const { createSpawn } = require("../systems/spawnSystem");

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
        this.reconnect(spawn);
    }

    reconnect(spawn) {
        this.x = spawn.x;
        this.y = spawn.y;
        this.angle = getRandomAngle();
        this.color = createRandomColor();
        this.territoryX = spawn.x;
        this.territoryY = spawn.y;
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

    clearInput() {
        this.pressedActions.clear();
        this.lastAction = null;
        this.directionAngle = null;
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
        }
    }

    releaseAction(action) {
        this.pressedActions.delete(action);

        if (this.lastAction === action) {
            this.lastAction = getLastSetValue(this.pressedActions);
        }
    }

    setDirectionAngle(angle) {
        this.directionAngle = angle;
    }

    clearDirectionAngle() {
        this.directionAngle = null;
    }

    serialize() {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            angle: this.angle,
            color: this.color,
            territoryX: this.territoryX,
            territoryY: this.territoryY
        };
    }
}

function createPlayer(players, id) {
    const player = new Player(id, createSpawn(players));
    players.set(id, player);
    return player;
}

function reconnectPlayerAsNew(players, player) {
    player.reconnect(createSpawn(getOtherPlayers(players, player.id)));
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
