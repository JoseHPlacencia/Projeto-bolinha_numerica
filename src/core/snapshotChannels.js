const {
    supportsSeparatedReliableState
} = require("./snapshotProtocol");

const RELIABLE_GAME_STATE_EVENT = "gameReliableState";

const TRANSIENT_RELIABLE_FIELDS = Object.freeze([
    "leaderboard",
    "mode",
    "playerInfo",
    "removedTerritoryIds",
    "removedTrailIds",
    "roomConfig",
    "territories",
    "territoryOps",
    "territoryVersions",
    "trailRemovals",
    "trails"
]);

function createTransientStateSnapshot(snapshot) {
    if (!supportsSeparatedReliableState(snapshot && snapshot.schema)) {
        return snapshot;
    }

    const transientSnapshot = { ...snapshot };

    for (const field of TRANSIENT_RELIABLE_FIELDS) {
        delete transientSnapshot[field];
    }

    delete transientSnapshot.payloadBudget;
    return transientSnapshot;
}

module.exports = {
    RELIABLE_GAME_STATE_EVENT,
    createTransientStateSnapshot
};
