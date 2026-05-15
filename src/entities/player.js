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
        this.x = spawn.x;
        this.y = spawn.y;
        this.angle = getRandomAngle();
        this.color = createRandomColor();
        this.territoryX = spawn.x;
        this.territoryY = spawn.y;
        this.isMoving = false;
        this.pressedActions = new Set();
        this.lastAction = null;
        this.directionAngle = null;
    }

    pressAction(action) {
        if (!this.pressedActions.has(action)) {
            this.pressedActions.add(action);
            this.lastAction = action;
        }

        this.isMoving = true;
    }

    releaseAction(action) {
        this.pressedActions.delete(action);

        if (this.lastAction === action) {
            this.lastAction = getLastSetValue(this.pressedActions);
        }
    }

    setDirectionAngle(angle) {
        this.directionAngle = angle;
        this.isMoving = true;
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

module.exports = {
    Player,
    createPlayer
};
