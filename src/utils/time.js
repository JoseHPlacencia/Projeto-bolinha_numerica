const { performance } = require("node:perf_hooks");

function getServerTime() {
    return Date.now();
}

function getHighResolutionTime() {
    return performance.now();
}

module.exports = {
    getHighResolutionTime,
    getServerTime
};
