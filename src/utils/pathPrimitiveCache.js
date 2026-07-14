/**
 * Bounded cache policy for point-derived path primitive indexes.
 *
 * The full path needs one slot. Active self-collision checks need two limited
 * prefixes because same-side and cross-side movement ignore different amounts
 * of the recent trail. Keeping exactly two slots avoids both prefix thrashing
 * and the unbounded per-point cache used by older implementations.
 */

function getPathPrimitiveCacheEntry(cache, cacheKey, sourcePointCount, lastPoint) {
    if (!cache) {
        return null;
    }

    if (cacheKey === "all") {
        return isPathPrimitiveCacheEntryCurrent(cache.all, sourcePointCount, lastPoint)
            ? cache.all
            : null;
    }

    if (isPathPrimitiveCacheEntryCurrent(cache.limitedPrimary, sourcePointCount, lastPoint)) {
        return cache.limitedPrimary;
    }

    return isPathPrimitiveCacheEntryCurrent(cache.limitedSecondary, sourcePointCount, lastPoint)
        ? cache.limitedSecondary
        : null;
}

function getPathPrimitiveUpdateBase(cache, cacheKey, sourcePointCount) {
    if (!cache) {
        return null;
    }

    if (cacheKey === "all") {
        return cache.all || null;
    }

    const primary = getEarlierEntry(cache.limitedPrimary, sourcePointCount);
    const secondary = getEarlierEntry(cache.limitedSecondary, sourcePointCount);

    if (!primary) {
        return secondary;
    }

    if (!secondary) {
        return primary;
    }

    return primary.sourcePointCount >= secondary.sourcePointCount
        ? primary
        : secondary;
}

function storePathPrimitiveCacheEntry(cache, cacheKey, entry) {
    if (cacheKey === "all") {
        cache.all = entry;
        return;
    }

    if (cache.limitedPrimary && cache.limitedPrimary.sourcePointCount === entry.sourcePointCount) {
        cache.limitedPrimary = entry;
        return;
    }

    if (cache.limitedSecondary && cache.limitedSecondary.sourcePointCount === entry.sourcePointCount) {
        cache.limitedSecondary = entry;
        return;
    }

    cache.limitedSecondary = cache.limitedPrimary || null;
    cache.limitedPrimary = entry;
}

function isPathPrimitiveCacheEntryCurrent(entry, sourcePointCount, lastPoint) {
    return entry
        && lastPoint
        && entry.sourcePointCount === sourcePointCount
        && entry.lastX === lastPoint.x
        && entry.lastY === lastPoint.y;
}

function getEarlierEntry(entry, sourcePointCount) {
    return entry && entry.sourcePointCount < sourcePointCount
        ? entry
        : null;
}

module.exports = {
    getPathPrimitiveCacheEntry,
    getPathPrimitiveUpdateBase,
    storePathPrimitiveCacheEntry
};
