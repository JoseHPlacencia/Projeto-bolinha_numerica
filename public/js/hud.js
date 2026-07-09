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
    const catchAlert = createCatchAlert();
    let lastUpdatedAt = 0;
    let lastRankUpdatedAt = 0;
    let lastLifeSignature = null;

    document.getElementById("gameLayer")?.appendChild(catchAlert.element);

    if (debugPanel) {
        debugPanel.hidden = debugLevel <= 0;
        updateDebugLevelRows();
    }

    return {
        update
    };

    function update({ frameStats, rendererStats, snapshotStats, currentPlayer, currentPlayerId, catchStatus, leaderboard, playerDebug }) {
        updateLives(currentPlayer);
        catchAlert.update(catchStatus);
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

function createCatchAlert() {
    const element = document.createElement("section");
    const edge = document.createElement("div");
    const statuses = document.createElement("div");
    const threat = createCatchAlertStatus("threat", "!");
    const risk = createCatchAlertStatus("risk", "↩");
    let lastSignature = null;

    element.id = "catchAlert";
    element.className = "catch-alert";
    element.hidden = true;
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");
    edge.className = "catch-alert__edge";
    edge.setAttribute("aria-hidden", "true");
    statuses.className = "catch-alert__statuses";
    statuses.append(threat.element, risk.element);
    element.append(edge, statuses);

    return {
        element,
        update
    };

    function update(status) {
        const normalized = normalizeCatchStatus(status);
        const signature = JSON.stringify(normalized);

        if (signature === lastSignature) {
            return;
        }

        lastSignature = signature;
        const hasThreat = normalized.threatCount > 0;
        const hasRisk = normalized.counterTargetCount > 0;

        element.hidden = !hasThreat && !hasRisk;
        element.classList.toggle("has-threat", hasThreat);
        element.classList.toggle("has-risk", hasRisk);
        element.classList.toggle("is-threat-armed", hasThreat && normalized.threatArmed);
        element.classList.toggle("is-risk-armed", hasRisk && normalized.counterRiskArmed);
        updateCatchAlertStatus(threat, {
            count: normalized.threatCount,
            detail: normalized.threatArmed
                ? "ARMADO · Retorne para contra-atacar"
                : `Contra-ataque em ${formatCounterattackTime(normalized.threatRemainingMs)}`,
            title: "VOCÊ ESTÁ MARCADO"
        });
        updateCatchAlertStatus(risk, {
            count: normalized.counterTargetCount,
            detail: normalized.counterRiskArmed
                ? "ARMADO · Confirme antes do retorno"
                : `Contra-ataque rival em ${formatCounterattackTime(normalized.counterRiskRemainingMs)}`,
            title: "ALVO MARCADO"
        });
    }
}

function createCatchAlertStatus(type, iconText) {
    const element = document.createElement("div");
    const icon = document.createElement("span");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const detail = document.createElement("small");

    element.className = `catch-alert__status catch-alert__status--${type}`;
    element.hidden = true;
    icon.className = "catch-alert__icon";
    icon.textContent = iconText;
    icon.setAttribute("aria-hidden", "true");
    copy.className = "catch-alert__copy";
    copy.append(title, detail);
    element.append(icon, copy);

    return {
        detail,
        element,
        title
    };
}

function updateCatchAlertStatus(status, options) {
    status.element.hidden = options.count <= 0;
    status.title.textContent = options.count > 1
        ? `${options.title} ×${options.count}`
        : options.title;
    status.detail.textContent = options.detail;
}

function normalizeCatchStatus(status) {
    const value = status && typeof status === "object" ? status : {};

    return {
        counterTargetCount: normalizeCount(value.counterTargetCount),
        counterRiskArmed: Boolean(value.counterRiskArmed),
        counterRiskRemainingMs: normalizeRemainingMs(value.counterRiskRemainingMs),
        threatCount: normalizeCount(value.threatCount),
        threatArmed: Boolean(value.threatArmed),
        threatRemainingMs: normalizeRemainingMs(value.threatRemainingMs)
    };
}

function normalizeCount(value) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeRemainingMs(value) {
    return Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : null;
}

function formatCounterattackTime(remainingMs) {
    if (!Number.isFinite(remainingMs)) {
        return "—";
    }

    return `${(remainingMs / 1000).toFixed(1).replace(".", ",")} s`;
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
