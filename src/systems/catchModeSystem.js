const config = require("../config/gameConfig");
const {
    deletePlayerTerritory,
    isPointOwnedByPlayer
} = require("../state/territories");
const { findSpawnPointInsideTerritory } = require("./territoryRespawnSystem");

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
    if (target.id === attacker.id || isPlayerInsideOwnTerritory(territories, target)) {
        return;
    }

    attacker.addElimination();
    clearPendingTarget(players, target.id);
    handlePlayerLifeLoss(players, territories, target, context, {
        attacker,
        reason: "eliminated"
    });
}

function isPlayerInsideOwnTerritory(territories, player) {
    return isPointOwnedByPlayer(territories, player.id, player.x, player.y);
}

function handlePlayerLifeLoss(players, territories, target, context = {}, options = {}) {
    if (!target) {
        return false;
    }

    if (target.loseLife() > 0) {
        const spawn = findRespawnPointForPlayer(territories, target);

        if (!spawn) {
            endPlayerGame(players, territories, target, context, {
                ...options,
                reason: "noRespawnSpace"
            });
            return true;
        }

        setPlayerRespawnPoint(territories, target, spawn);
        target.respawnAt(spawn, { resetCatchProgress: true });
        return false;
    }

    endPlayerGame(players, territories, target, context, options);
    return true;
}

function findRespawnPointForPlayer(territories, player) {
    const territory = territories.get(player.id);

    return territory
        ? findSpawnPointInsideTerritory(territory.polygon, {
            bounds: territory.bounds,
            preferredPoints: [
                {
                    x: player.territoryX,
                    y: player.territoryY
                },
                {
                    x: territory.baseX,
                    y: territory.baseY
                }
            ]
        })
        : null;
}

function setPlayerRespawnPoint(territories, player, point) {
    const territory = territories.get(player.id);

    player.setSpawnPoint(point);

    if (territory) {
        territory.baseX = point.x;
        territory.baseY = point.y;
        territory.color = player.color;
    }
}

function endPlayerGame(players, territories, target, context = {}, options = {}) {
    const targetSocket = context.io && context.io.sockets.sockets.get(target.id);
    const attacker = options.attacker || null;
    const eliminatedBy = attacker && attacker.id !== target.id
        ? attacker.name
        : null;

    clearPendingTarget(players, target.id);
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

function handlePlayerVictory(players, territories, winner, context = {}) {
    if (!winner) {
        return false;
    }

    endPlayerGame(players, territories, winner, context, {
        reason: "victory"
    });
    return true;
}

function clearPendingTarget(players, targetId) {
    for (const player of players.values()) {
        player.clearCatchEliminationTarget(targetId);
    }
}

module.exports = {
    endPlayerGame,
    handleNumberCollected,
    handlePlayerLifeLoss,
    handlePlayerVictory
};
