function createClientSnapshotState() {
    return {
        playerInfo: new Map(),
        territories: new Map(),
        trails: new Map(),
        territoryVisibility: new Map(),
        trailVisibility: new Map(),
        territoryPoints: new Map(),
        nextTerritoryPointId: 1
    };
}

function cloneClientSnapshotState(clientState = createClientSnapshotState()) {
    return {
        playerInfo: cloneMap(clientState.playerInfo, cloneVersionedState),
        territories: cloneMap(clientState.territories, cloneVersionedState),
        trails: cloneMap(clientState.trails, cloneTrailState),
        territoryVisibility: new Map(clientState.territoryVisibility || []),
        trailVisibility: new Map(clientState.trailVisibility || []),
        territoryPoints: new Map(clientState.territoryPoints || []),
        nextTerritoryPointId: Number.isInteger(clientState.nextTerritoryPointId)
            ? clientState.nextTerritoryPointId
            : 1
    };
}

function cloneMap(map, cloneValue) {
    const clonedMap = new Map();

    for (const [key, value] of map || []) {
        clonedMap.set(key, cloneValue(value));
    }

    return clonedMap;
}

function cloneVersionedState(state) {
    return state ? { ...state } : state;
}

function cloneTrailState(state) {
    if (!state) {
        return state;
    }

    return {
        ...state,
        leftSegmentLengths: [...(state.leftSegmentLengths || [])],
        rightSegmentLengths: [...(state.rightSegmentLengths || [])]
    };
}

module.exports = {
    cloneClientSnapshotState,
    createClientSnapshotState
};
