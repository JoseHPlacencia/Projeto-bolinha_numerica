/**
 * Creates a shallow copy of a collection only on its first write.
 *
 * Values stored inside each collection must be treated as immutable. Rollback
 * then consists only of restoring the original collection references.
 */
export function createCopyOnWriteTransaction() {
    const originalsByOwner = new Map();
    let settled = false;

    return {
        commit,
        getWritable,
        rollback
    };

    function getWritable(owner, key, clone) {
        if (settled) {
            throw new Error("Copy-on-write transaction is already settled.");
        }

        let originals = originalsByOwner.get(owner);

        if (!originals) {
            originals = new Map();
            originalsByOwner.set(owner, originals);
        }

        if (!originals.has(key)) {
            const original = owner[key];

            originals.set(key, original);
            owner[key] = clone(original);
        }

        return owner[key];
    }

    function commit() {
        settled = true;
        originalsByOwner.clear();
    }

    function rollback() {
        if (settled) {
            return;
        }

        for (const [owner, originals] of originalsByOwner) {
            for (const [key, original] of originals) {
                owner[key] = original;
            }
        }

        settled = true;
        originalsByOwner.clear();
    }
}
