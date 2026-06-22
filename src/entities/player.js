const config = require("../config/gameConfig");
const { createSpawn } = require("../systems/spawnSystem");

const INPUT_ANGLE_CHANGE_EPSILON = 0.025;
const DEFAULT_PLAYER_NAME = "Jogador";

function createRandomColor() {
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue},80%,50%)`;
}

function normalizePlayerColor(color) {
    const normalizedColor = String(color || "").trim().toLowerCase();

    return /^#[0-9a-f]{6}$/.test(normalizedColor) ? normalizedColor : null;
}

function normalizePlayerName(name, options = {}) {
    const normalizedName = String(name || "").trim().slice(0, 20);

    if (!normalizedName) {
        return DEFAULT_PLAYER_NAME;
    }

    if (!options.isBot && isReservedBotName(normalizedName)) {
        return DEFAULT_PLAYER_NAME;
    }

    return normalizedName;
}

function normalizeSpawnPoint(point) {
    return point
        && Number.isFinite(point.x)
        && Number.isFinite(point.y)
        ? { x: point.x, y: point.y }
        : null;
}

function isReservedBotName(name) {
    const normalizedName = String(name || "").trim().toLowerCase();
    const reservedNames = config.bots && Array.isArray(config.bots.reservedNames)
        ? config.bots.reservedNames
        : [];

    return reservedNames.some(reservedName => (
        String(reservedName || "").trim().toLowerCase() === normalizedName
    ));
}

function normalizeDifficulty(difficulty) {
    const normalizedDifficulty = String(difficulty || "").trim().toLowerCase();
    const livesByDifficulty = config.gameMode.catch.livesByDifficulty;

    return Object.prototype.hasOwnProperty.call(livesByDifficulty, normalizedDifficulty)
        ? normalizedDifficulty
        : config.gameMode.catch.defaultDifficulty;
}

function getLivesForDifficulty(difficulty) {
    const lives = config.gameMode.catch.livesByDifficulty[difficulty];

    return Number.isInteger(lives) && lives > 0 ? lives : 1;
}

function getPlayerMaxLives(difficulty, maxLives) {
    const overrideLives = Math.round(Number(maxLives));

    return Number.isInteger(overrideLives) && overrideLives > 0
        ? overrideLives
        : getLivesForDifficulty(difficulty);
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
    constructor(id, spawn, options = {}) {
        this.id = id;
        this.isBot = Boolean(options.isBot);
        this.color = normalizePlayerColor(options.color) || createRandomColor();
        this.name = normalizePlayerName(options.name, { isBot: this.isBot });
        this.runtimeConfig = options.runtimeConfig || config;
        this.difficulty = normalizeDifficulty(options.difficulty);
        this.maxLives = getPlayerMaxLives(this.difficulty, options.maxLives);
        this.lives = this.maxLives;
        this.eliminations = 0;
        this.catchHits = 0;
        this.catchMisses = 0;
        this.catchBalance = 0;
        this.pendingCatchEliminationTargets = new Set();
        this.pendingCatchEliminationMarkedAt = new Map();
        this.pressedActions = new Set();
        this.lastAction = null;
        this.directionAngle = null;
        this.directionSource = null;
        this.pendingDirectionAngle = null;
        this.lastMouseDirectionAngle = null;
        this.inputVersion = 0;
        this.infoVersion = 0;
        this.trailGeneration = 0;
        this.boundarySlideInputVersion = 0;
        this.debugState = null;
        this.viewport = null;
        this.reconnect(spawn);
    }

    reconnect(spawn) {
        this.x = spawn.x;
        this.y = spawn.y;
        this.angle = getRandomAngle();
        this.color ||= createRandomColor();
        this.territoryX = spawn.x;
        this.territoryY = spawn.y;
        this.markInfoChanged();
        this.clearInput();
        this.clearTrailState();
    }

    returnToSpawn(options = {}) {
        this.respawnAt({
            x: this.territoryX,
            y: this.territoryY
        }, options);
    }

    respawnAt(point, options = {}) {
        const spawn = normalizeSpawnPoint(point);

        if (!spawn) {
            return false;
        }

        this.x = spawn.x;
        this.y = spawn.y;
        this.angle = getRandomAngle();
        this.boundarySlideDirection = null;
        if (options.resetCatchProgress !== false) {
            this.resetCatchProgress();
        }
        this.clearTrailState();
        return true;
    }

    setSpawnPoint(point) {
        this.territoryX = point.x;
        this.territoryY = point.y;
        this.markInfoChanged();
    }

    setViewport(viewport) {
        this.viewport = viewport;
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
        this.trailGeneration++;
        this.trailLeftSegments = [];
        this.trailRightSegments = [];
        this.trailLeftFillPath = [];
        this.trailRightFillPath = [];
        this.isLeftTrailActive = false;
        this.isRightTrailActive = false;
        this.lastLeftTrailPoint = null;
        this.lastRightTrailPoint = null;
    }

    recordCatchNumber(belongsToTheme) {
        if (belongsToTheme) {
            this.catchHits++;
            this.catchBalance++;
        } else {
            this.catchMisses++;
            this.catchBalance--;
        }

        this.markInfoChanged();
    }

    consumeCatchBalance(amount = 1) {
        const safeAmount = Math.max(1, Math.round(Number(amount) || 1));

        if (this.catchBalance < safeAmount) {
            return false;
        }

        this.catchBalance -= safeAmount;
        this.markInfoChanged();
        return true;
    }

    resetCatchProgress() {
        if (
            this.catchHits === 0
            && this.catchMisses === 0
            && this.catchBalance === 0
            && this.pendingCatchEliminationTargets.size === 0
            && this.pendingCatchEliminationMarkedAt.size === 0
        ) {
            return;
        }

        this.catchHits = 0;
        this.catchMisses = 0;
        this.catchBalance = 0;
        this.pendingCatchEliminationTargets.clear();
        this.pendingCatchEliminationMarkedAt.clear();
        this.markInfoChanged();
    }

    queueCatchEliminationTarget(playerId, markedAt = Date.now()) {
        if (!playerId || playerId === this.id || this.pendingCatchEliminationTargets.has(playerId)) {
            return;
        }

        this.pendingCatchEliminationTargets.add(playerId);
        this.pendingCatchEliminationMarkedAt.set(
            playerId,
            Number.isFinite(markedAt) ? markedAt : Date.now()
        );
        this.markInfoChanged();
    }

    clearCatchEliminationTarget(playerId) {
        const targetRemoved = this.pendingCatchEliminationTargets.delete(playerId);
        const timestampRemoved = this.pendingCatchEliminationMarkedAt.delete(playerId);

        if (targetRemoved || timestampRemoved) {
            this.markInfoChanged();
        }
    }

    getCatchEliminationMarkedAt(playerId) {
        const markedAt = this.pendingCatchEliminationMarkedAt.get(playerId);

        return Number.isFinite(markedAt) ? markedAt : null;
    }

    consumeCatchEliminationTargets() {
        const targets = [...this.pendingCatchEliminationTargets];

        if (targets.length > 0) {
            this.pendingCatchEliminationTargets.clear();
            this.pendingCatchEliminationMarkedAt.clear();
            this.markInfoChanged();
        }

        return targets;
    }

    addElimination() {
        this.eliminations++;
        this.markInfoChanged();
    }

    loseLife() {
        this.lives = Math.max(0, this.lives - 1);
        this.markInfoChanged();

        return this.lives;
    }

    resetLives() {
        this.lives = this.maxLives;
        this.markInfoChanged();
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

    markInfoChanged() {
        this.infoVersion++;
    }

    serialize() {
        const serializedPlayer = {
            id: this.id,
            x: this.x,
            y: this.y,
            angle: this.angle,
            color: this.color,
            name: this.name,
            eliminations: this.eliminations,
            lives: this.lives,
            maxLives: this.maxLives,
            catchBalance: this.catchBalance,
            territoryX: this.territoryX,
            territoryY: this.territoryY
        };

        if (this.debugState) {
            serializedPlayer.debug = this.debugState;
        }

        return serializedPlayer;
    }
}

function createPlayer(players, id, territories = null, options = {}) {
    const spawn = normalizeSpawnPoint(options.spawn) || createSpawn(players, territories, options.runtimeConfig);

    if (!spawn) {
        return null;
    }

    const player = new Player(id, spawn, options);
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
    const spawn = createSpawn(getOtherPlayers(players, player.id), territories, player.runtimeConfig);

    if (!spawn) {
        return null;
    }

    player.reconnect(spawn);

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
