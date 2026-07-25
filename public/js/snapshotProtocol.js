export const SNAPSHOT_SCHEMA = 4;
export const RELIABLE_GAME_STATE_EVENT = "gameReliableState";

export function createSnapshotSocketAuth() {
    return {
        snapshotSchema: SNAPSHOT_SCHEMA
    };
}
