const config = require("../config/gameConfig");
const { deletePlayerTerritory } = require("../state/territories");
const { returnPlayerToSpawn } = require("../entities/player");

function handleNumberCollected(players, territories, collection, context = {}) {
    const player = players.get(collection.playerId);

    if (!player) {
        return;
    }

    player.recordCatchNumber(collection.belongsToTheme);

    if (collection.belongsToTheme) {
        eliminatePendingTargets(players, territories, player, context);
    }
}

function eliminatePendingTargets(players, territories, attacker, context) {
    for (const targetId of attacker.consumeCatchEliminationTargets()) {
        const target = players.get(targetId);

        if (target) {
            eliminatePlayer(players, territories, attacker, target, context);
        }
    }
}

function eliminatePlayer(players, territories, attacker, target, context) {
    if (target.id === attacker.id) {
        return;
    }

    attacker.addElimination();
    clearPendingTarget(players, target.id);
    handlePlayerLifeLoss(players, territories, target, context, {
        attacker,
        reason: "eliminated"
    });
}

function handlePlayerLifeLoss(players, territories, target, context = {}, options = {}) {
    if (!target) {
        return false;
    }

    if (target.loseLife() > 0) {
        returnPlayerToSpawn(target);
        return false;
    }

    endPlayerGame(players, territories, target, context, options);
    return true;
}

function endPlayerGame(players, territories, target, context = {}, options = {}) {
    const targetSocket = context.io && context.io.sockets.sockets.get(target.id);
    const attacker = options.attacker || null;
    const eliminatedBy = attacker && attacker.id !== target.id
        ? attacker.name
        : null;

    target.resetCatchProgress();
    players.delete(target.id);
    deletePlayerTerritory(territories, target.id);

    if (!targetSocket) {
        return;
    }

    targetSocket.emit("gameOver", {
        eliminatedBy,
        eliminations: target.eliminations,
        maxLives: target.maxLives,
        reason: options.reason || (eliminatedBy ? "eliminated" : "defeated")
    });

    setTimeout(() => {
        if (targetSocket.connected) {
            targetSocket.disconnect(true);
        }
    }, config.gameMode.catch.gameOverDisconnectDelayMs);
}

function clearPendingTarget(players, targetId) {
    for (const player of players.values()) {
        player.clearCatchEliminationTarget(targetId);
    }
}

module.exports = {
    handleNumberCollected,
    handlePlayerLifeLoss
};
