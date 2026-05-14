function createRateLimiter({ maxEvents, intervalMs }) {
    let eventCount = 0;
    let windowStartedAt = Date.now();

    return {
        consume
    };

    function consume() {
        const now = Date.now();

        if (now - windowStartedAt >= intervalMs) {
            eventCount = 0;
            windowStartedAt = now;
        }

        eventCount++;
        return eventCount <= maxEvents;
    }
}

module.exports = {
    createRateLimiter
};
