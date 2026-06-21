export function createHud({ debugLevel }) {
    const debugPanel = document.getElementById("debugPanel");
    const lifePanel = document.getElementById("lifePanel");
    const lifePips = document.getElementById("lifePips");
    const lifeCount = document.getElementById("lifeCount");
    const rankRows = document.getElementById("rankRows");
    const debugFps = document.getElementById("debugFps");
    const debugRenderFps = document.getElementById("debugRenderFps");
    const debugBuffer = document.getElementById("debugBuffer");
    const debugCanvas = document.getElementById("debugCanvas");
    const debugFrame = document.getElementById("debugFrame");
    const debugSnapshots = document.getElementById("debugSnapshots");
    const debugPixelRatio = document.getElementById("debugPixelRatio");
    const debugDirectionSource = document.getElementById("debugDirectionSource");
    const debugDirectionAngleRad = document.getElementById("debugDirectionAngleRad");
    const debugDirectionAngleDeg = document.getElementById("debugDirectionAngleDeg");
    const debugPlayerAngleRad = document.getElementById("debugPlayerAngleRad");
    const debugPlayerAngleDeg = document.getElementById("debugPlayerAngleDeg");
    const debugInputAngleDeltaRad = document.getElementById("debugInputAngleDeltaRad");
    const debugInputAngleDeltaDeg = document.getElementById("debugInputAngleDeltaDeg");
    const debugBoundaryRelation = document.getElementById("debugBoundaryRelation");
    const debugBoundarySlideDirection = document.getElementById("debugBoundarySlideDirection");
    const debugTouchingBoundary = document.getElementById("debugTouchingBoundary");
    const debugInputAccepted = document.getElementById("debugInputAccepted");
    const debugBoundaryDecision = document.getElementById("debugBoundaryDecision");
    let lastUpdatedAt = 0;
    let lastRankUpdatedAt = 0;
    let lastLifeSignature = null;

    if (debugPanel) {
        debugPanel.hidden = debugLevel <= 0;
        updateDebugLevelRows();
    }

    return {
        update
    };

    function update({ frameStats, rendererStats, snapshotStats, currentPlayer, currentPlayerId, leaderboard, playerDebug }) {
        updateLives(currentPlayer);
        updateLeaderboard(leaderboard, currentPlayerId);

        if (debugLevel <= 0) {
            return;
        }

        const now = performance.now();

        if (now - lastUpdatedAt < 200) {
            return;
        }

        lastUpdatedAt = now;
        setText(debugFps, frameStats.fps);
        setText(debugRenderFps, getRenderFps(frameStats, rendererStats));
        setText(debugFrame, `${frameStats.frameMs.toFixed(1)}ms`);
        setText(debugBuffer, `${Math.round(snapshotStats.bufferMs)}ms`);
        setText(debugSnapshots, snapshotStats.snapshotCount);
        setText(debugPixelRatio, rendererStats.pixelRatio.toFixed(2));
        setText(debugCanvas, `${rendererStats.canvasWidth}x${rendererStats.canvasHeight}`);
        updateMovementDebug(playerDebug);
    }

    function updateLives(player) {
        if (!lifePanel || !lifePips || !lifeCount) {
            return;
        }

        const lives = Number(player && player.lives);
        const maxLives = Number(player && player.maxLives);

        if (!Number.isFinite(lives) || !Number.isFinite(maxLives) || maxLives <= 0) {
            lifePanel.hidden = true;
            lastLifeSignature = null;
            return;
        }

        const safeLives = Math.max(0, Math.min(maxLives, Math.round(lives)));
        const safeMaxLives = Math.max(1, Math.round(maxLives));
        const signature = `${safeLives}/${safeMaxLives}`;

        lifePanel.hidden = false;

        if (signature === lastLifeSignature) {
            return;
        }

        lastLifeSignature = signature;
        lifeCount.textContent = signature;
        lifePips.replaceChildren(...createLifePips(safeLives, safeMaxLives));
    }

    function createLifePips(lives, maxLives) {
        const pips = [];

        for (let index = 0; index < maxLives; index++) {
            const pip = document.createElement("span");
            pip.className = "life-panel__pip";
            pip.classList.toggle("is-filled", index < lives);
            pips.push(pip);
        }

        return pips;
    }

    function updateLeaderboard(leaderboard, currentPlayerId) {
        if (!rankRows) {
            return;
        }

        const now = performance.now();

        if (now - lastRankUpdatedAt < 250) {
            return;
        }

        lastRankUpdatedAt = now;
        rankRows.replaceChildren(...createRankRows(leaderboard, currentPlayerId));
    }

    function createRankRows(leaderboard, currentPlayerId) {
        const entries = selectRankEntries(leaderboard, currentPlayerId);

        if (entries.length === 0) {
            const row = document.createElement("div");
            row.className = "rank-panel__empty";
            row.textContent = "Aguardando jogadores";
            return [row];
        }

        return entries.map(entry => {
            const row = document.createElement("div");
            row.className = "rank-panel__row";
            row.classList.toggle("is-current", entry.id === currentPlayerId);
            row.append(
                createRankCell(entry.name || "Jogador"),
                createRankCell(formatPercent(entry.areaPercent)),
                createRankCell(Number.isFinite(entry.eliminations) ? entry.eliminations : 0),
                createRankCell(entry.rank || "-")
            );
            return row;
        });
    }

    function selectRankEntries(leaderboard, currentPlayerId) {
        const entries = Array.isArray(leaderboard) ? leaderboard : [];
        const visibleEntries = entries.slice(0, 5);
        const currentPlayer = entries.find(entry => entry.id === currentPlayerId);

        if (
            currentPlayer
            && !visibleEntries.some(entry => entry.id === currentPlayer.id)
        ) {
            visibleEntries.push(currentPlayer);
        }

        return visibleEntries;
    }

    function createRankCell(value) {
        const cell = document.createElement("span");
        cell.textContent = String(value);
        return cell;
    }

    function getRenderFps(frameStats, rendererStats) {
        if (rendererStats && rendererStats.mode === "worker") {
            return Number.isFinite(rendererStats.workerFps) ? rendererStats.workerFps : 0;
        }

        return frameStats.fps;
    }

    function updateDebugLevelRows() {
        const debugLevelRows = debugPanel.querySelectorAll("[data-debug-level]");

        for (const row of debugLevelRows) {
            row.hidden = Number(row.dataset.debugLevel) !== debugLevel;
        }
    }

    function updateMovementDebug(debug) {
        if (debugLevel < 2) {
            return;
        }

        setText(debugDirectionSource, formatText(debug && debug.directionSource));
        setText(debugDirectionAngleRad, formatNumber(debug && debug.directionAngleRad));
        setText(debugDirectionAngleDeg, formatNumber(debug && debug.directionAngleDeg, 1));
        setText(debugPlayerAngleRad, formatNumber(debug && debug.playerAngleRad));
        setText(debugPlayerAngleDeg, formatNumber(debug && debug.playerAngleDeg, 1));
        setText(debugInputAngleDeltaRad, formatNumber(debug && debug.inputAngleDeltaRad));
        setText(debugInputAngleDeltaDeg, formatNumber(debug && debug.inputAngleDeltaDeg, 1));
        setText(debugBoundaryRelation, formatText(debug && debug.boundaryInputRelation));
        setText(debugBoundarySlideDirection, formatText(debug && debug.boundarySlideDirection));
        setText(debugTouchingBoundary, formatBoolean(debug && debug.isTouchingBoundary));
        setText(debugInputAccepted, formatBoolean(debug && debug.inputAccepted));
        setText(debugBoundaryDecision, formatText(debug && debug.boundarySlideDecision));
    }
}

function formatPercent(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : "0.0%";
}

function setText(element, value) {
    if (element) {
        element.textContent = String(value);
    }
}

function formatText(value) {
    return value === null || value === undefined || value === "" ? "-" : value;
}

function formatNumber(value, fractionDigits = 3) {
    return Number.isFinite(value) ? value.toFixed(fractionDigits) : "-";
}

function formatBoolean(value) {
    if (value === true) {
        return "yes";
    }

    if (value === false) {
        return "no";
    }

    return "-";
}
