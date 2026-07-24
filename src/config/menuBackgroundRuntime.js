const DEFAULT_MENU_BACKGROUND_SNAPSHOT_RATE = 10;
const MAX_MENU_BACKGROUND_SNAPSHOT_RATE = 20;
const MIN_MENU_BACKGROUND_SNAPSHOT_RATE = 1;
const MENU_BACKGROUND_SNAPSHOT_RATE_ENV = "VENNPERIO_MENU_BACKGROUND_SNAPSHOT_RATE";

function resolveMenuBackgroundSnapshotRate(
    rawValue = process.env[MENU_BACKGROUND_SNAPSHOT_RATE_ENV]
) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
        return DEFAULT_MENU_BACKGROUND_SNAPSHOT_RATE;
    }

    const normalizedValue = String(rawValue).trim();
    const snapshotRate = Number(normalizedValue);

    if (
        !/^\d+$/.test(normalizedValue)
        || !Number.isInteger(snapshotRate)
        || snapshotRate < MIN_MENU_BACKGROUND_SNAPSHOT_RATE
        || snapshotRate > MAX_MENU_BACKGROUND_SNAPSHOT_RATE
    ) {
        throw new RangeError(
            `${MENU_BACKGROUND_SNAPSHOT_RATE_ENV} must be an integer from `
            + `${MIN_MENU_BACKGROUND_SNAPSHOT_RATE} to ${MAX_MENU_BACKGROUND_SNAPSHOT_RATE}.`
        );
    }

    return snapshotRate;
}

module.exports = {
    DEFAULT_MENU_BACKGROUND_SNAPSHOT_RATE,
    MAX_MENU_BACKGROUND_SNAPSHOT_RATE,
    MENU_BACKGROUND_SNAPSHOT_RATE_ENV,
    MIN_MENU_BACKGROUND_SNAPSHOT_RATE,
    resolveMenuBackgroundSnapshotRate
};
