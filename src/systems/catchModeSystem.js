const {
    deletePlayerTerritory,
    isPointOwnedByPlayer
} = require("../state/territories");
const { findSpawnPointInsideTerritory } = require("./territoryRespawnSystem");
const {
    activateSpectator,
    redirectSpectatorsAfterPlayerExit
} = require("./spectatorSystem");

function createCatchCombatFrame(now = Date.now()) {
    return {
        damagedPlayerIds: new Set(),
        intents: [],
        now: Number.isFinite(now) ? now : Date.now()
    };
}

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
            if (context.catchCombatFrame) {
                context.catchCombatFrame.intents.push({
                    attackerId: attacker.id,
                    targetId: target.id,
                    type: "elimination"
                });
            } else {
                eliminatePlayer(players, territories, attacker, target, context);
            }
        }
    }
}

function eliminatePlayer(players, territories, attacker, target, context) {
    if (target.id === attacker.id || isPlayerInsideOwnTerritory(territories, target)) {
        return;
    }

    attacker.addElimination();
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

    if (
        options.reason !== "captured"
        && isPlayerInsideOwnTerritory(territories, target)
    ) {
        clearPendingTarget(players, target.id);
        return false;
    }

    const combatFrame = context.catchCombatFrame;

    if (combatFrame && combatFrame.damagedPlayerIds.has(target.id)) {
        return false;
    }

    combatFrame?.damagedPlayerIds.add(target.id);
    clearPendingTarget(players, target.id);

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

function handleSuccessfulTrailCapture(players, territories, trailOwner, context = {}) {
    if (!trailOwner) {
        return;
    }

    const now = getCatchCombatTime(context);
    const graceMs = getCounterattackGraceMs(context, trailOwner);

    for (const marker of players.values()) {
        if (marker.id === trailOwner.id
            || !marker.pendingCatchEliminationTargets.has(trailOwner.id)) {
            continue;
        }

        const markedAt = marker.getCatchEliminationMarkedAt(trailOwner.id);
        const isArmed = Number.isFinite(markedAt) && now - markedAt >= graceMs;

        if (context.catchCombatFrame) {
            context.catchCombatFrame.intents.push({
                attackerId: trailOwner.id,
                markerId: marker.id,
                targetId: marker.id,
                trailOwnerId: trailOwner.id,
                type: isArmed ? "counterattack" : "counterCancel"
            });
            continue;
        }

        marker.clearCatchEliminationTarget(trailOwner.id);

        if (isArmed) {
            applyCatchLifeLossIntent(players, territories, {
                attackerId: trailOwner.id,
                targetId: marker.id,
                type: "counterattack"
            }, context);
        }
    }
}

function resolveCatchCombatFrame(players, territories, context = {}) {
    const combatFrame = context.catchCombatFrame;

    if (!combatFrame || combatFrame.intents.length === 0) {
        return;
    }

    const intents = combatFrame.intents.splice(0);
    const cancelledIntents = findSimultaneousCounterPairs(intents);

    for (const intent of intents) {
        if (intent.type === "counterattack" || intent.type === "counterCancel") {
            players.get(intent.markerId)?.clearCatchEliminationTarget(intent.trailOwnerId);
        }
    }

    for (let index = 0; index < intents.length; index++) {
        if (cancelledIntents.has(index)) {
            continue;
        }

        const intent = intents[index];

        if (intent.type === "counterCancel") {
            continue;
        }

        applyCatchLifeLossIntent(players, territories, intent, context);
    }
}

function findSimultaneousCounterPairs(intents) {
    const cancelled = new Set();

    for (let firstIndex = 0; firstIndex < intents.length; firstIndex++) {
        const first = intents[firstIndex];

        if (first.type !== "elimination") {
            continue;
        }

        for (let secondIndex = 0; secondIndex < intents.length; secondIndex++) {
            const second = intents[secondIndex];

            if ((second.type === "counterattack" || second.type === "counterCancel")
                && first.attackerId === second.targetId
                && first.targetId === second.attackerId) {
                cancelled.add(firstIndex);
                cancelled.add(secondIndex);
            }
        }
    }

    return cancelled;
}

function applyCatchLifeLossIntent(players, territories, intent, context) {
    const attacker = players.get(intent.attackerId);
    const target = players.get(intent.targetId);

    if (!attacker || !target || attacker.id === target.id) {
        return false;
    }

    if (
        (intent.type === "elimination" || intent.type === "counterattack")
        && isPlayerInsideOwnTerritory(territories, target)
    ) {
        clearPendingTarget(players, target.id);
        return false;
    }

    if (context.catchCombatFrame?.damagedPlayerIds.has(target.id)) {
        return false;
    }

    attacker.addElimination();
    handlePlayerLifeLoss(players, territories, target, context, {
        attacker,
        reason: intent.type === "counterattack" ? "counterattack" : "eliminated"
    });
    return true;
}

function getCatchCombatTime(context) {
    return Number.isFinite(context.catchCombatFrame && context.catchCombatFrame.now)
        ? context.catchCombatFrame.now
        : Number.isFinite(context.now)
            ? context.now
            : Date.now();
}

function getCounterattackGraceMs(context, player) {
    const runtimeConfig = context.runtimeConfig || player.runtimeConfig;
    const configuredValue = runtimeConfig
        && runtimeConfig.gameMode
        && runtimeConfig.gameMode.catch
        && runtimeConfig.gameMode.catch.counterattackGraceMs;

    return Number.isFinite(configuredValue) && configuredValue >= 0
        ? configuredValue
        : 1200;
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
    const eliminatorId = attacker && attacker.id !== target.id
        ? attacker.id
        : null;
    const eliminatedBy = eliminatorId
        ? attacker.name
        : null;
    const reason = options.reason || (eliminatedBy ? "eliminated" : "defeated");
    const roomCode = context.roomCode
        || (targetSocket && targetSocket.data && targetSocket.data.roomCode)
        || null;

    clearPendingTarget(players, target.id);
    target.resetCatchProgress();
    players.delete(target.id);
    deletePlayerTerritory(territories, target.id);

    if (typeof context.onRoomPopulationChanged === "function") {
        context.onRoomPopulationChanged();
    }

    redirectSpectatorsAfterPlayerExit(
        context.io,
        roomCode,
        players,
        territories,
        target.id,
        eliminatorId,
        context.runtimeConfig
    );

    if (!targetSocket) {
        return;
    }

    const spectatorFollowId = reason === "victory"
        ? null
        : activateSpectator(
            targetSocket,
            roomCode,
            players,
            territories,
            eliminatorId,
            context.runtimeConfig
        );

    targetSocket.emit("gameOver", {
        canSpectate: Boolean(spectatorFollowId),
        eliminatedBy,
        eliminatedById: eliminatorId,
        eliminations: target.eliminations,
        maxLives: target.maxLives,
        reason,
        spectatorFollowId
    });
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

function clearCatchEliminationMarksForTarget(players, targetId) {
    clearPendingTarget(players, targetId);
}

function clearCatchEliminationMarksByMarker(marker) {
    if (marker && typeof marker.clearCatchEliminationTargets === "function") {
        marker.clearCatchEliminationTargets();
    }
}

module.exports = {
    clearCatchEliminationMarksByMarker,
    clearCatchEliminationMarksForTarget,
    createCatchCombatFrame,
    endPlayerGame,
    handleNumberCollected,
    handlePlayerLifeLoss,
    handlePlayerVictory,
    handleSuccessfulTrailCapture,
    resolveCatchCombatFrame
};
