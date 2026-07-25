const SNAPSHOT_STATE_DRAFT = Symbol("snapshotStateDraft");

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

/**
 * Creates an isolated state transaction without eagerly copying its Maps.
 *
 * Snapshot serializers can keep using the regular Map API. Reads fall through
 * to the confirmed state while writes are retained in a small overlay. The
 * confirmed state remains untouched until materializeClientSnapshotStateDraft
 * is called after a reliable ACK or before a volatile state is committed.
 */
function createClientSnapshotStateDraft(clientState = createClientSnapshotState()) {
    const confirmedState = isClientSnapshotStateDraft(clientState)
        ? materializeClientSnapshotStateDraft(clientState)
        : clientState;

    return {
        playerInfo: new SnapshotStateMapDraft(confirmedState.playerInfo),
        territories: new SnapshotStateMapDraft(confirmedState.territories),
        trails: new SnapshotStateMapDraft(confirmedState.trails),
        territoryVisibility: new SnapshotStateMapDraft(confirmedState.territoryVisibility),
        trailVisibility: new SnapshotStateMapDraft(confirmedState.trailVisibility),
        territoryPoints: new SnapshotStateMapDraft(confirmedState.territoryPoints),
        nextTerritoryPointId: Number.isInteger(confirmedState.nextTerritoryPointId)
            ? confirmedState.nextTerritoryPointId
            : 1,
        [SNAPSHOT_STATE_DRAFT]: true
    };
}

function materializeClientSnapshotStateDraft(clientState) {
    if (!isClientSnapshotStateDraft(clientState)) {
        return clientState;
    }

    return {
        playerInfo: materializeMap(clientState.playerInfo),
        territories: materializeMap(clientState.territories),
        trails: materializeMap(clientState.trails),
        territoryVisibility: materializeMap(clientState.territoryVisibility),
        trailVisibility: materializeMap(clientState.trailVisibility),
        territoryPoints: materializeMap(clientState.territoryPoints),
        nextTerritoryPointId: Number.isInteger(clientState.nextTerritoryPointId)
            ? clientState.nextTerritoryPointId
            : 1
    };
}

function isClientSnapshotStateDraft(clientState) {
    return Boolean(clientState && clientState[SNAPSHOT_STATE_DRAFT] === true);
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

class SnapshotStateMapDraft extends Map {
    constructor(baseMap) {
        super();
        this.baseMap = baseMap instanceof Map ? baseMap : new Map(baseMap || []);
        this.changes = new Map();
        this.deletions = new Set();
        this.cleared = false;
    }

    get size() {
        if (this.cleared) {
            return this.changes.size;
        }

        let size = this.baseMap.size - this.deletions.size;

        for (const key of this.changes.keys()) {
            if (!this.baseMap.has(key)) {
                size++;
            }
        }

        return size;
    }

    get(key) {
        if (this.changes.has(key)) {
            return this.changes.get(key);
        }
        if (this.cleared || this.deletions.has(key)) {
            return undefined;
        }
        return this.baseMap.get(key);
    }

    has(key) {
        return this.changes.has(key)
            || (!this.cleared && !this.deletions.has(key) && this.baseMap.has(key));
    }

    set(key, value) {
        this.changes.set(key, value);
        this.deletions.delete(key);
        return this;
    }

    delete(key) {
        const existed = this.has(key);

        this.changes.delete(key);
        if (!this.cleared && this.baseMap.has(key)) {
            this.deletions.add(key);
        }

        return existed;
    }

    clear() {
        this.changes.clear();
        this.deletions.clear();
        this.cleared = true;
    }

    entries() {
        return this[Symbol.iterator]();
    }

    *keys() {
        for (const [key] of this) {
            yield key;
        }
    }

    *values() {
        for (const [, value] of this) {
            yield value;
        }
    }

    forEach(callback, thisArg = undefined) {
        for (const [key, value] of this) {
            callback.call(thisArg, value, key, this);
        }
    }

    *[Symbol.iterator]() {
        if (!this.cleared) {
            for (const [key, value] of this.baseMap) {
                if (this.deletions.has(key)) {
                    continue;
                }
                yield [key, this.changes.has(key) ? this.changes.get(key) : value];
            }
        }

        for (const [key, value] of this.changes) {
            if (this.cleared || !this.baseMap.has(key)) {
                yield [key, value];
            }
        }
    }

    materialize() {
        if (!this.isDirty()) {
            return this.baseMap;
        }

        const materialized = this.cleared
            ? new Map()
            : new Map(this.baseMap);

        for (const key of this.deletions) {
            materialized.delete(key);
        }
        for (const [key, value] of this.changes) {
            materialized.set(key, value);
        }

        return materialized;
    }

    isDirty() {
        return this.cleared || this.changes.size > 0 || this.deletions.size > 0;
    }
}

function materializeMap(map) {
    return map instanceof SnapshotStateMapDraft
        ? map.materialize()
        : map;
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
    createClientSnapshotState,
    createClientSnapshotStateDraft,
    isClientSnapshotStateDraft,
    materializeClientSnapshotStateDraft
};
