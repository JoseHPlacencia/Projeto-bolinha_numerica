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
        this.baseX = spawn.x;
        this.baseY = spawn.y;
        this.isMoving = false;
        this.keys = new Set();
        this.lastKey = null;
    }

    pressKey(key) {
        if (!this.keys.has(key)) {
            this.keys.add(key);
            this.lastKey = key;
        }

        this.isMoving = true;
    }

    releaseKey(key) {
        this.keys.delete(key);

        if (this.lastKey === key) {
            this.lastKey = getLastSetValue(this.keys);
        }
    }

    serialize() {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            angle: this.angle,
            color: this.color,
            baseX: this.baseX,
            baseY: this.baseY
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
