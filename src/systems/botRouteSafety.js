const config = require("../config/gameConfig");
const { clamp, lerpAngle } = require("../utils/math");
const {
    addBotTargetingDiagnosticValue,
    addSelfTrailSafetyDiagnosticValue,
    createSelfTrailSafetyBudget,
    finishSelfTrailSafetyBudget,
    getBotSelfTrailEscapeMemoryMs,
    getBotSelfTrailLookaheadMaxDistance,
    getBotSelfTrailSafetyBlockSize,
    getBotSelfTrailSafetyCoarseLookaheadRatio,
    getBotSelfTrailSafetyCriticalClearance,
    getBotSelfTrailSafetyMaxCandidates,
    getBotSelfTrailSafetyMaxLocalCandidates,
    getBotSelfTrailSafetyRefineCandidates,
    getBotSelfTrailSafetyTrapMaxCandidates,
    getBotSelfTrailTrapLookaheadMaxDistance,
    getSelfTrailSafetyDiagnostics,
    hasSelfTrailSafetyBudgetRemaining
} = require("./botDiagnostics");
const {
    arePointsEqual,
    createBoundsAroundPoint,
    createPointBlockIndex,
    createSegmentBlockIndex,
    doBoundsOverlap,
    filterPointsByBounds,
    filterSegmentsByBounds,
    getNearestDistanceSquared,
    getSegmentBounds,
    getSelfTrailSegmentsCached,
    getTrailPointsCached,
    segmentsCross
} = require("./botTrailGeometry");
const {
    clampPointToMap,
    getAngleDelta,
    getBotAi,
    getSelfTrailClearanceRecentPointSkip
} = require("./botNavigation");

const geometryEpsilon = 1e-7;

/**
 * Builds the route-safety service used by the bot policy.
 *
 * The return-target resolver is injected because territory return policy belongs
 * to botTargeting. Trail caches stay in the caller-owned decision context, so target
 * selection and route safety share the same per-tick geometry.
 */
function createBotRouteSafety({ getReturnTarget }) {
    if (typeof getReturnTarget !== "function") {
        throw new TypeError("bot route safety requires a return-target resolver");
    }

    function normalizeAngle(angle) {
        return Math.atan2(Math.sin(angle), Math.cos(angle));
    }

    function chooseSelfTrailSafeAngle(bot, targetAngle, options = {}, context = null) {
        const diagnostics = getSelfTrailSafetyDiagnostics(context);
        const safetyCache = createSelfTrailSafetyCache();

        addSelfTrailSafetyDiagnosticValue(diagnostics, "decisionCount", 1);

        const trailPoints = getTrailPointsCached(context, bot, { skipRecent: getSelfTrailClearanceRecentPointSkip() });
        const trailSegments = getSelfTrailSegmentsCached(context, bot, { skipRecent: getSelfTrailCollisionRecentPointSkip() });

        if ((trailPoints.length === 0 && trailSegments.length === 0) || !Number.isFinite(targetAngle)) {
            clearSelfTrailEscapeMemory(bot);
            addSelfTrailSafetyDiagnosticValue(diagnostics, "bypassCount", 1);
            return {
                angle: targetAngle,
                avoidingSelfTrail: false
            };
        }

        const trailGeometry = createSelfTrailSafetyGeometry(bot, trailPoints, trailSegments, options, diagnostics);
        const nearestSelfTrailDistanceSquared = getNearestDistanceSquared(bot, trailGeometry.pointIndex, diagnostics);
        const bypassDistance = getSelfTrailLookaheadDistance(options) + config.bots.selfTrailAvoidDistance;

        if (
            trailGeometry.points.length === 0
            && trailGeometry.segments.length === 0
        ) {
            clearSelfTrailEscapeMemory(bot);
            addSelfTrailSafetyDiagnosticValue(diagnostics, "bypassCount", 1);
            return {
                angle: targetAngle,
                avoidingSelfTrail: false
            };
        }

        if (
            nearestSelfTrailDistanceSquared > bypassDistance * bypassDistance
            && trailGeometry.segments.length === 0
        ) {
            clearSelfTrailEscapeMemory(bot);
            addSelfTrailSafetyDiagnosticValue(diagnostics, "bypassCount", 1);
            return {
                angle: targetAngle,
                avoidingSelfTrail: false
            };
        }

        const budget = createSelfTrailSafetyBudget(diagnostics);
        const targetSafety = getCachedSelfTrailPathSafety(
            bot,
            targetAngle,
            trailGeometry,
            options,
            budget,
            diagnostics,
            safetyCache
        );

        if (!isSelfTrailPathUnsafe(targetSafety)) {
            clearSelfTrailEscapeMemory(bot);
            finishSelfTrailSafetyBudget(budget);
            return {
                angle: targetAngle,
                avoidingSelfTrail: false
            };
        }

        addSelfTrailSafetyDiagnosticValue(diagnostics, "unsafeTargetCount", 1);

        const riskOptions = createSelfTrailRiskOptions(options, targetSafety, nearestSelfTrailDistanceSquared);
        const activeTrailGeometry = riskOptions.trapMode
            ? createSelfTrailSafetyGeometry(bot, trailPoints, trailSegments, riskOptions, diagnostics)
            : trailGeometry;
        const activeTargetSafety = riskOptions.trapMode
            ? getCachedSelfTrailPathSafety(
                bot,
                targetAngle,
                activeTrailGeometry,
                riskOptions,
                budget,
                diagnostics,
                safetyCache
            )
            : targetSafety;
        const rememberedCandidate = chooseRememberedSelfTrailEscapeCandidate(
            bot,
            targetAngle,
            activeTrailGeometry,
            riskOptions,
            context,
            budget,
            diagnostics,
            safetyCache
        );

        if (rememberedCandidate) {
            finishSelfTrailSafetyBudget(budget);
            return {
                angle: rememberedCandidate.angle,
                avoidingSelfTrail: true,
                suppressNoise: true
            };
        }

        const candidates = limitSelfTrailAvoidanceCandidates(
            createSelfTrailAvoidanceCandidates(bot, targetAngle, riskOptions, activeTrailGeometry),
            riskOptions
        );
        addSelfTrailSafetyDiagnosticValue(diagnostics, "candidateCount", candidates.length);

        const candidateEvaluationOptions = createCoarseSelfTrailSafetyOptions(riskOptions);
        const coarseCandidateEvaluations = evaluateCoarseSelfTrailCandidates(
            bot,
            targetAngle,
            activeTrailGeometry,
            candidates,
            candidateEvaluationOptions,
            budget,
            diagnostics,
            safetyCache
        );
        const refinementCandidates = selectSelfTrailRefinementCandidates(coarseCandidateEvaluations, riskOptions);

        addSelfTrailSafetyDiagnosticValue(diagnostics, "selectedRefineCandidateCount", refinementCandidates.length);

        let bestAnyCandidate = {
            angle: targetAngle,
            safety: activeTargetSafety,
            score: scoreSelfTrailCandidate(targetAngle, targetAngle, activeTargetSafety, riskOptions)
        };
        const canKeepTargetCandidate = !isSelfTrailPathUnsafe(targetSafety)
            && !isSelfTrailPathUnsafe(activeTargetSafety);
        let bestSafeCandidate = canKeepTargetCandidate
            ? bestAnyCandidate
            : null;
        let bestNonCrossingCandidate = canKeepTargetCandidate
            && !activeTargetSafety.crossesTrail
            && !activeTargetSafety.budgetHit
            ? bestAnyCandidate
            : null;

        for (const coarseCandidate of refinementCandidates) {
            if (!hasSelfTrailSafetyBudgetRemaining(budget)) {
                break;
            }

            if (Math.abs(getAngleDelta(coarseCandidate.angle, targetAngle)) <= 0.001) {
                continue;
            }

            addSelfTrailSafetyDiagnosticValue(diagnostics, "evaluatedCandidateCount", 1);
            addSelfTrailSafetyDiagnosticValue(diagnostics, "fullEvaluationCount", 1);

            const safety = getCachedSelfTrailPathSafety(
                bot,
                coarseCandidate.angle,
                activeTrailGeometry,
                riskOptions,
                budget,
                diagnostics,
                safetyCache
            );
            const score = scoreSelfTrailCandidate(coarseCandidate.angle, targetAngle, safety, riskOptions);

            if (score > bestAnyCandidate.score) {
                bestAnyCandidate = {
                    angle: coarseCandidate.angle,
                    safety,
                    score
                };
            }

            if (!isSelfTrailPathUnsafe(safety) && (!bestSafeCandidate || score > bestSafeCandidate.score)) {
                bestSafeCandidate = {
                    angle: coarseCandidate.angle,
                    safety,
                    score
                };
            }

            if (!safety.crossesTrail && !safety.budgetHit && (!bestNonCrossingCandidate || score > bestNonCrossingCandidate.score)) {
                bestNonCrossingCandidate = {
                    angle: coarseCandidate.angle,
                    safety,
                    score
                };
            }
        }

        const bestCandidate = bestSafeCandidate
            || (hasSelfTrailSafetyBudgetRemaining(budget)
                ? chooseLocalSelfTrailEscapeCandidate(
                    bot,
                    targetAngle,
                    activeTrailGeometry,
                    candidates,
                    riskOptions,
                    budget,
                    diagnostics,
                    safetyCache
                )
                : null)
            || bestNonCrossingCandidate
            || chooseCoarseSelfTrailFallbackCandidate(coarseCandidateEvaluations, targetAngle)
            || bestAnyCandidate;

        rememberSelfTrailEscapeCandidate(bot, bestCandidate, activeTargetSafety, riskOptions, context);
        finishSelfTrailSafetyBudget(budget);

        return {
            angle: bestCandidate.angle,
            avoidingSelfTrail: true,
            suppressNoise: shouldSuppressSelfTrailEscapeNoise(activeTargetSafety, bestCandidate)
        };
    }

    function createSelfTrailRiskOptions(options = {}, targetSafety = {}, nearestSelfTrailDistanceSquared = Infinity) {
        const nearestDistance = Math.sqrt(nearestSelfTrailDistanceSquared);
        const trapMode = Boolean(
            targetSafety.crossesTrail
            || targetSafety.budgetHit
            || targetSafety.clearance < config.bots.selfTrailAvoidDistance * 1.25
            || nearestDistance < config.bots.selfTrailAvoidDistance * 1.4
        );

        if (!trapMode) {
            return options;
        }

        return {
            ...options,
            includeReturnRoute: true,
            selfTrailLookaheadDistance: getBotSelfTrailTrapLookaheadMaxDistance(),
            trapMode: true
        };
    }

    function chooseRememberedSelfTrailEscapeCandidate(
        bot,
        targetAngle,
        trailGeometry,
        options = {},
        context = null,
        budget = null,
        diagnostics = null,
        safetyCache = null
    ) {
        const ai = getBotAi(bot);
        const nowMs = getSelfTrailDecisionNowMs(context);

        if (!Number.isFinite(ai.selfTrailEscapeAngle)
            || !Number.isFinite(ai.selfTrailEscapeUntilMs)
            || ai.selfTrailEscapeUntilMs <= nowMs) {
            return null;
        }

        const safety = getCachedSelfTrailPathSafety(
            bot,
            ai.selfTrailEscapeAngle,
            trailGeometry,
            options,
            budget,
            diagnostics,
            safetyCache
        );

        if (isSelfTrailPathUnsafe(safety)) {
            clearSelfTrailEscapeMemory(bot);
            return null;
        }

        return {
            angle: ai.selfTrailEscapeAngle,
            safety,
            score: scoreSelfTrailCandidate(ai.selfTrailEscapeAngle, targetAngle, safety, options)
        };
    }

    function createSelfTrailSafetyCache() {
        return new Map();
    }

    function getCachedSelfTrailPathSafety(
        bot,
        targetAngle,
        trailGeometry,
        options = {},
        budget = null,
        diagnostics = null,
        safetyCache = null
    ) {
        const cacheKey = safetyCache && createSelfTrailSafetyCacheKey(targetAngle, trailGeometry, options);

        if (cacheKey && safetyCache.has(cacheKey)) {
            addSelfTrailSafetyDiagnosticValue(diagnostics, "safetyCacheHitCount", 1);
            return safetyCache.get(cacheKey);
        }

        if (cacheKey) {
            addSelfTrailSafetyDiagnosticValue(diagnostics, "safetyCacheMissCount", 1);
        }

        const safety = getSelfTrailPathSafety(bot, targetAngle, trailGeometry, options, budget, diagnostics);

        if (cacheKey) {
            safetyCache.set(cacheKey, safety);
        }

        return safety;
    }

    function createSelfTrailSafetyCacheKey(targetAngle, trailGeometry, options = {}) {
        return [
            Math.round(normalizeAngle(targetAngle) * 1000),
            options.selfTrailSafetyMode || "full",
            options.centerOnly ? "center" : "wide",
            options.stopOnUnsafe ? "stop" : "scan",
            Math.round(getSelfTrailLookaheadDistance(options)),
            Math.round((trailGeometry && trailGeometry.lookaheadDistance || 0) * 10),
            options.trapMode ? 1 : 0
        ].join(":");
    }

    function createCoarseSelfTrailSafetyOptions(options = {}) {
        const lookaheadDistance = getSelfTrailLookaheadDistance(options);

        return {
            ...options,
            centerOnly: true,
            selfTrailLookaheadDistance: Math.max(
                config.world.playerSize * 3,
                lookaheadDistance * getBotSelfTrailSafetyCoarseLookaheadRatio()
            ),
            selfTrailSafetyMode: "coarse",
            stopOnUnsafe: true
        };
    }

    function evaluateCoarseSelfTrailCandidates(
        bot,
        targetAngle,
        trailGeometry,
        candidates,
        options = {},
        budget = null,
        diagnostics = null,
        safetyCache = null
    ) {
        const evaluations = [];

        for (const angle of candidates || []) {
            if (!hasSelfTrailSafetyBudgetRemaining(budget)) {
                break;
            }

            if (Math.abs(getAngleDelta(angle, targetAngle)) <= 0.001) {
                continue;
            }

            addSelfTrailSafetyDiagnosticValue(diagnostics, "coarseEvaluationCount", 1);

            const safety = getCachedSelfTrailPathSafety(
                bot,
                angle,
                trailGeometry,
                options,
                budget,
                diagnostics,
                safetyCache
            );

            evaluations.push({
                angle,
                safety,
                score: scoreSelfTrailCandidate(angle, targetAngle, safety, options)
            });
        }

        return evaluations;
    }

    function selectSelfTrailRefinementCandidates(evaluations, options = {}) {
        const maxCount = getBotSelfTrailSafetyRefineCandidates(Boolean(options.trapMode));
        const sorted = [...(evaluations || [])].sort((first, second) => second.score - first.score);
        const selected = [];
        const seen = new Set();

        for (const evaluation of sorted) {
            if (selected.length >= maxCount) {
                break;
            }

            if (!evaluation || !Number.isFinite(evaluation.angle)) {
                continue;
            }

            const key = Math.round(evaluation.angle * 1000);

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            selected.push(evaluation);
        }

        return selected;
    }

    function chooseCoarseSelfTrailFallbackCandidate(evaluations, targetAngle) {
        const candidates = (evaluations || [])
            .filter(evaluation => (
                evaluation
                && Number.isFinite(evaluation.angle)
                && Math.abs(getAngleDelta(evaluation.angle, targetAngle)) > 0.001
            ))
            .sort((first, second) => second.score - first.score);

        return candidates[0] || null;
    }

    function rememberSelfTrailEscapeCandidate(bot, candidate, targetSafety = {}, options = {}, context = null) {
        if (!candidate || !Number.isFinite(candidate.angle)) {
            clearSelfTrailEscapeMemory(bot);
            return;
        }

        if (!options.trapMode && !isSelfTrailCriticalSafety(targetSafety)) {
            clearSelfTrailEscapeMemory(bot);
            return;
        }

        const ai = getBotAi(bot);
        const nowMs = getSelfTrailDecisionNowMs(context);

        ai.selfTrailEscapeAngle = candidate.angle;
        ai.selfTrailEscapeUntilMs = nowMs + getBotSelfTrailEscapeMemoryMs();
    }

    function clearSelfTrailEscapeMemory(bot) {
        if (!bot || !bot.botAi) {
            return;
        }

        bot.botAi.selfTrailEscapeAngle = null;
        bot.botAi.selfTrailEscapeUntilMs = 0;
    }

    function getSelfTrailDecisionNowMs(context = null) {
        return Number.isFinite(context && context.nowMs) ? context.nowMs : Date.now();
    }

    function shouldSuppressSelfTrailEscapeNoise(targetSafety = {}, candidate = null) {
        return isSelfTrailCriticalSafety(targetSafety)
            || !candidate
            || !candidate.safety
            || isSelfTrailPathUnsafe(candidate.safety, 0.8);
    }

    function isSelfTrailCriticalSafety(safety = {}) {
        return Boolean(
            safety.budgetHit
            || safety.crossesTrail
            || safety.clearance < config.bots.selfTrailAvoidDistance * 0.85
        );
    }

    function scoreSelfTrailCandidate(angle, targetAngle, safety, options = {}) {
        const targetPenaltyScale = options.allowReverse ? 0.35 : 0.85;
        const targetPenalty = Math.abs(getAngleDelta(angle, targetAngle))
            * config.bots.selfTrailAvoidDistance
            * targetPenaltyScale;
        const crossPenalty = safety.crossesTrail ? config.world.mapRadius * 10 : 0;
        const budgetPenalty = safety.budgetHit ? config.bots.selfTrailAvoidDistance * 2 : 0;
        const clearanceScore = Number.isFinite(safety.clearance)
            ? safety.clearance * 4
            : config.bots.selfTrailAvoidDistance * 4;

        return clearanceScore - targetPenalty - crossPenalty - budgetPenalty;
    }

    function createSelfTrailAvoidanceCandidates(bot, targetAngle, options = {}, trailGeometry = null) {
        const returnTarget = getReturnTarget(bot, options.territories);
        const returnAngle = Math.atan2(returnTarget.y - bot.y, returnTarget.x - bot.x);
        const baseAngles = options.allowReverse || options.includeReturnRoute
            ? [targetAngle, bot.angle, returnAngle].filter(Number.isFinite)
            : [targetAngle, bot.angle].filter(Number.isFinite);
        const offsets = options.allowReverse
            ? [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.45, -1.45, 1.9, -1.9, 2.45, -2.45, Math.PI]
            : [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.3, -1.3, 1.75, -1.75, 2.35, -2.35, Math.PI];
        const candidates = [];
        const seen = new Set();

        for (const baseAngle of baseAngles) {
            for (const offset of offsets) {
                addSelfTrailCandidate(candidates, seen, baseAngle + offset);
            }
        }

        const fullCircleSteps = options.allowReverse ? 32 : 24;

        for (let index = 0; index < fullCircleSteps; index++) {
            addSelfTrailCandidate(candidates, seen, targetAngle + (Math.PI * 2 * index) / fullCircleSteps);
        }

        if (options.trapMode) {
            addSelfTrailTrapEscapeCandidates(candidates, seen, bot, targetAngle, trailGeometry);

        }

        return candidates;
    }

    function addSelfTrailTrapEscapeCandidates(candidates, seen, bot, targetAngle, trailGeometry = null) {
        const feature = getNearestSelfTrailFeature(bot, trailGeometry);

        addSelfTrailCandidate(candidates, seen, bot.angle + Math.PI);
        addSelfTrailCandidate(candidates, seen, bot.angle + Math.PI / 2);
        addSelfTrailCandidate(candidates, seen, bot.angle - Math.PI / 2);

        if (!feature) {
            return;
        }

        if (Number.isFinite(feature.awayAngle)) {
            addSelfTrailCandidate(candidates, seen, feature.awayAngle);
            addSelfTrailCandidate(candidates, seen, feature.awayAngle + 0.45);
            addSelfTrailCandidate(candidates, seen, feature.awayAngle - 0.45);
            addSelfTrailCandidate(candidates, seen, feature.awayAngle + Math.PI / 2);
            addSelfTrailCandidate(candidates, seen, feature.awayAngle - Math.PI / 2);
        }

        if (Number.isFinite(feature.segmentAngle)) {
            addSelfTrailCandidate(candidates, seen, feature.segmentAngle);
            addSelfTrailCandidate(candidates, seen, feature.segmentAngle + Math.PI);
            addSelfTrailCandidate(candidates, seen, feature.segmentAngle + 0.55);
            addSelfTrailCandidate(candidates, seen, feature.segmentAngle - 0.55);
            addSelfTrailCandidate(candidates, seen, feature.segmentAngle + Math.PI + 0.55);
            addSelfTrailCandidate(candidates, seen, feature.segmentAngle + Math.PI - 0.55);
        }

        addSelfTrailCandidate(candidates, seen, targetAngle + Math.PI);
    }

    function getNearestSelfTrailFeature(bot, trailGeometry = null) {
        if (!bot || !trailGeometry) {
            return null;
        }

        let bestFeature = null;

        for (const point of trailGeometry.points || []) {
            const distanceSquared = getDistanceSquared(bot, point);

            if (!bestFeature || distanceSquared < bestFeature.distanceSquared) {
                bestFeature = createSelfTrailFeature(bot, point, distanceSquared, null);
            }
        }

        for (const segment of trailGeometry.segments || []) {
            const closestPoint = getClosestPointOnSegment(bot, segment.start, segment.end);
            const distanceSquared = getDistanceSquared(bot, closestPoint);
            const segmentAngle = Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x);

            if (!bestFeature || distanceSquared < bestFeature.distanceSquared) {
                bestFeature = createSelfTrailFeature(bot, closestPoint, distanceSquared, segmentAngle);
            }
        }

        return bestFeature;
    }

    function createSelfTrailFeature(bot, point, distanceSquared, segmentAngle) {
        return {
            awayAngle: Math.atan2(bot.y - point.y, bot.x - point.x),
            distanceSquared,
            point,
            segmentAngle
        };
    }

    function getClosestPointOnSegment(point, start, end) {
        const segmentX = end.x - start.x;
        const segmentY = end.y - start.y;
        const lengthSquared = segmentX * segmentX + segmentY * segmentY;

        if (lengthSquared <= geometryEpsilon) {
            return start;
        }

        const t = clamp(
            ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared,
            0,
            1
        );

        return {
            x: start.x + segmentX * t,
            y: start.y + segmentY * t
        };
    }

    function getDistanceSquared(first, second) {
        const deltaX = first.x - second.x;
        const deltaY = first.y - second.y;

        return deltaX * deltaX + deltaY * deltaY;
    }

    function limitSelfTrailAvoidanceCandidates(candidates, options = {}) {
        const maxCandidates = options.trapMode
            ? getBotSelfTrailSafetyTrapMaxCandidates()
            : getBotSelfTrailSafetyMaxCandidates();

        if (!Array.isArray(candidates) || candidates.length <= maxCandidates) {
            return candidates || [];
        }

        return candidates.slice(0, maxCandidates);
    }

    function chooseLocalSelfTrailEscapeCandidate(
        bot,
        targetAngle,
        trailGeometry,
        candidates,
        options = {},
        budget = null,
        diagnostics = null,
        safetyCache = null
    ) {
        const localOptions = {
            ...options,
            targetDistance: Math.max(config.world.playerSize * 4, config.bots.selfTrailAvoidDistance)
        };
        const localCandidates = (candidates || []).slice(0, getBotSelfTrailSafetyMaxLocalCandidates());
        let bestCandidate = null;

        addSelfTrailSafetyDiagnosticValue(diagnostics, "localCandidateCount", localCandidates.length);

        for (const angle of localCandidates) {
            if (!hasSelfTrailSafetyBudgetRemaining(budget)) {
                break;
            }

            addSelfTrailSafetyDiagnosticValue(diagnostics, "evaluatedLocalCandidateCount", 1);
            addSelfTrailSafetyDiagnosticValue(diagnostics, "fullEvaluationCount", 1);

            const safety = getCachedSelfTrailPathSafety(
                bot,
                angle,
                trailGeometry,
                localOptions,
                budget,
                diagnostics,
                safetyCache
            );

            if (isSelfTrailPathUnsafe(safety)) {
                continue;
            }

            const score = scoreSelfTrailCandidate(angle, targetAngle, safety, options);

            if (!bestCandidate || score > bestCandidate.score) {
                bestCandidate = {
                    angle,
                    safety,
                    score
                };
            }
        }

        return bestCandidate;
    }

    function addSelfTrailCandidate(candidates, seen, rawAngle) {
        const angle = normalizeAngle(rawAngle);
        const key = Math.round(angle * 1000);

        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        candidates.push(angle);
    }

    function isSelfTrailPathUnsafe(safety, thresholdScale = 1) {
        return safety.budgetHit
            || safety.crossesTrail
            || safety.clearance < config.bots.selfTrailAvoidDistance * thresholdScale;
    }


    function createSelfTrailSafetyGeometry(bot, trailPoints, trailSegments, options = {}, diagnostics = null) {
        const lookaheadDistance = getSelfTrailLookaheadDistance(options);
        const bounds = createBoundsAroundPoint(
            bot,
            lookaheadDistance + config.bots.selfTrailAvoidDistance + config.world.playerSize
        );
        const points = filterPointsByBounds(trailPoints, bounds);
        const segments = filterSegmentsByBounds(trailSegments, bounds);
        const pointIndex = createPointBlockIndex(points, getBotSelfTrailSafetyBlockSize());
        const segmentIndex = createSegmentBlockIndex(segments, getBotSelfTrailSafetyBlockSize());

        addSelfTrailSafetyDiagnosticValue(diagnostics, "trailPointCount", trailPoints.length);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "trailSegmentCount", trailSegments.length);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "filteredTrailPointCount", points.length);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "filteredTrailSegmentCount", segments.length);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "pointBlockCount", pointIndex.blocks.length);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentBlockCount", segmentIndex.blocks.length);

        return {
            bounds,
            lookaheadDistance,
            pointIndex,
            points,
            segmentIndex,
            segments
        };
    }

    function getSelfTrailPathSafety(bot, targetAngle, trailGeometry, options = {}, budget = null, diagnostics = null) {
        const trailPoints = trailGeometry && trailGeometry.pointIndex
            ? trailGeometry.pointIndex
            : trailGeometry && Array.isArray(trailGeometry.points)
                ? trailGeometry.points
                : [];
        const trailSegments = trailGeometry && trailGeometry.segmentIndex
            ? trailGeometry.segmentIndex
            : trailGeometry && Array.isArray(trailGeometry.segments)
                ? trailGeometry.segments
                : [];
        let position = {
            x: bot.x,
            y: bot.y
        };
        let angle = bot.angle;
        let nearestDistanceSquared = Infinity;
        let budgetHit = false;
        let crossesTrail = false;
        const lookaheadDistance = Number.isFinite(trailGeometry && trailGeometry.lookaheadDistance)
            ? Math.min(trailGeometry.lookaheadDistance, getSelfTrailLookaheadDistance(options))
            : getSelfTrailLookaheadDistance(options);
        const sampleCount = getSelfTrailLookaheadSampleCount(lookaheadDistance);
        const stepDistance = lookaheadDistance / sampleCount;
        const stepDeltaTime = stepDistance / getBotMovementSpeed(bot);
        const criticalClearance = getSelfTrailPathEarlyExitClearance(options);
        const criticalClearanceSquared = criticalClearance * criticalClearance;
        let previousSamples = createSelfTrailPathSamplePoints(position, angle, options);

        addSelfTrailSafetyDiagnosticValue(diagnostics, "pathEvaluationCount", 1);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "sampleCount", sampleCount);

        for (let index = 0; index < sampleCount; index++) {
            if (!hasSelfTrailSafetyBudgetRemaining(budget)) {
                budgetHit = true;
                break;
            }

            angle = lerpAngle(angle, targetAngle, getSelfTrailSimulationRotationBlend(bot, stepDeltaTime));
            position = clampPointToMap({
                x: position.x + Math.cos(angle) * stepDistance,
                y: position.y + Math.sin(angle) * stepDistance
            });

            const currentSamples = createSelfTrailPathSamplePoints(position, angle, options);

            if (!crossesTrail && doesSamplePathCrossSelfTrail(previousSamples, currentSamples, trailSegments, diagnostics)) {
                crossesTrail = true;
            }

            if (crossesTrail) {
                addSelfTrailSafetyDiagnosticValue(diagnostics, "earlyExitCount", 1);
                break;
            }

            for (const samplePoint of currentSamples) {
                nearestDistanceSquared = Math.min(
                    nearestDistanceSquared,
                    getNearestDistanceSquared(samplePoint, trailPoints, diagnostics)
                );
            }

            if (shouldStopSelfTrailPathEvaluation(crossesTrail, nearestDistanceSquared, criticalClearanceSquared, options)) {
                addSelfTrailSafetyDiagnosticValue(diagnostics, "earlyExitCount", 1);
                break;
            }

            previousSamples = currentSamples;
        }

        return {
            budgetHit,
            clearance: Math.sqrt(nearestDistanceSquared),
            crossesTrail
        };
    }

    function createSelfTrailPathSamplePoints(position, angle, options = {}) {
        return options.centerOnly
            ? [position]
            : createSelfTrailAvoidanceSamplePoints(position, angle);
    }

    function getSelfTrailPathEarlyExitClearance(options = {}) {
        if (Number.isFinite(options.earlyExitClearance) && options.earlyExitClearance > 0) {
            return options.earlyExitClearance;
        }

        if (options.stopOnUnsafe) {
            return config.bots.selfTrailAvoidDistance;
        }

        return getBotSelfTrailSafetyCriticalClearance();
    }

    function shouldStopSelfTrailPathEvaluation(crossesTrail, nearestDistanceSquared, criticalClearanceSquared, options = {}) {
        return crossesTrail
            || Boolean(options.stopOnUnsafe && nearestDistanceSquared <= criticalClearanceSquared)
            || (!options.selfTrailSafetyMode && nearestDistanceSquared <= criticalClearanceSquared);
    }

    function doesSamplePathCrossSelfTrail(previousSamples, currentSamples, trailSegmentsOrIndex, diagnostics = null) {
        const segmentIndex = getSegmentIndex(trailSegmentsOrIndex);
        const trailSegments = segmentIndex
            ? segmentIndex.segments
            : trailSegmentsOrIndex;

        if ((!segmentIndex || segmentIndex.blocks.length === 0)
            && (!Array.isArray(trailSegments) || trailSegments.length === 0)) {
            return false;
        }

        for (let index = 0; index < previousSamples.length; index++) {
            if (doesSegmentCrossSelfTrail(previousSamples[index], currentSamples[index], segmentIndex || trailSegments, diagnostics)) {
                return true;
            }
        }

        return false;
    }

    function doesSegmentCrossSelfTrail(startPoint, endPoint, trailSegmentsOrIndex, diagnostics = null) {
        if (arePointsEqual(startPoint, endPoint)) {
            return false;
        }

        const segmentIndex = getSegmentIndex(trailSegmentsOrIndex);

        if (segmentIndex) {
            return doesSegmentCrossSelfTrailIndex(startPoint, endPoint, segmentIndex, diagnostics);
        }

        const trailSegments = trailSegmentsOrIndex || [];
        let checkedSegmentCount = 0;

        for (const trailSegment of trailSegments) {
            checkedSegmentCount++;
            if (segmentsCross(startPoint, endPoint, trailSegment.start, trailSegment.end)) {
                addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentCrossCheckCount", checkedSegmentCount);
                return true;
            }
        }

        addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentCrossCheckCount", checkedSegmentCount);
        return false;
    }

    function doesSegmentCrossSelfTrailIndex(startPoint, endPoint, segmentIndex, diagnostics = null) {
        if (!segmentIndex || !Array.isArray(segmentIndex.blocks) || segmentIndex.blocks.length === 0) {
            return false;
        }

        const movementBounds = getSegmentBounds(startPoint, endPoint);

        if (!doBoundsOverlap(movementBounds, segmentIndex.bounds)) {
            addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentBoundsRejected", 1);
            return false;
        }

        let blockChecks = 0;
        let blockBoundsRejected = 0;
        let checkedSegmentCount = 0;

        for (const block of segmentIndex.blocks) {
            blockChecks++;

            if (!doBoundsOverlap(movementBounds, block.bounds)) {
                blockBoundsRejected++;
                continue;
            }

            for (const trailSegment of block.segments) {
                checkedSegmentCount++;

                if (segmentsCross(startPoint, endPoint, trailSegment.start, trailSegment.end)) {
                    addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentBlockChecks", blockChecks);
                    addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentBlockBoundsRejected", blockBoundsRejected);
                    addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentCrossCheckCount", checkedSegmentCount);
                    return true;
                }
            }
        }

        addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentBlockChecks", blockChecks);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentBlockBoundsRejected", blockBoundsRejected);
        addSelfTrailSafetyDiagnosticValue(diagnostics, "segmentCrossCheckCount", checkedSegmentCount);
        return false;
    }

    function getSegmentIndex(value) {
        return value
            && Array.isArray(value.segments)
            && Array.isArray(value.blocks)
            ? value
            : null;
    }

    function createSelfTrailAvoidanceSamplePoints(position, angle) {
        const halfWidth = config.world.playerSize / 2;
        const normal = {
            x: -Math.sin(angle),
            y: Math.cos(angle)
        };

        return [
            position,
            {
                x: position.x + normal.x * halfWidth,
                y: position.y + normal.y * halfWidth
            },
            {
                x: position.x - normal.x * halfWidth,
                y: position.y - normal.y * halfWidth
            }
        ];
    }

    function getSelfTrailSimulationRotationBlend(bot, deltaTime) {
        const elapsedTicks = deltaTime * config.loop.tickRate;
        const movement = getBotMovementConfig(bot);

        return clamp(1 - Math.pow(1 - movement.rotationStrength, elapsedTicks), 0, 1);
    }

    function getBotMovementSpeed(bot) {
        const speed = Number(getBotMovementConfig(bot).speed);

        return Number.isFinite(speed) && speed > 0 ? speed : config.movement.speed;
    }

    function getBotMovementConfig(bot) {
        const movement = bot && bot.runtimeConfig && bot.runtimeConfig.movement;
        const rotationStrength = Number(movement && movement.rotationStrength);

        return {
            rotationStrength: Number.isFinite(rotationStrength)
                ? clamp(rotationStrength, 0, 1)
                : config.movement.rotationStrength,
            speed: movement && movement.speed
        };
    }

    function getSelfTrailLookaheadDistance(options = {}) {
        if (Number.isFinite(options.selfTrailLookaheadDistance) && options.selfTrailLookaheadDistance > 0) {
            return Math.min(options.selfTrailLookaheadDistance, getBotSelfTrailTrapLookaheadMaxDistance());
        }

        const decisionDistance = config.movement.speed * (config.bots.decisionIntervalMs / 1000) * 2.5;
        const targetDistance = Number.isFinite(options.targetDistance)
            ? Math.min(options.targetDistance, config.world.mapRadius)
            : 0;
        const uncappedDistance = Math.max(config.world.playerSize * 3.5, decisionDistance, targetDistance);

        return Math.min(uncappedDistance, getBotSelfTrailLookaheadMaxDistance());
    }

    function getSelfTrailLookaheadSampleCount(lookaheadDistance) {
        const distance = Number.isFinite(lookaheadDistance)
            ? lookaheadDistance
            : getSelfTrailLookaheadDistance();

        return Math.max(6, Math.ceil(distance / config.world.playerSize));
    }

    function getSelfTrailCollisionRecentPointSkip() {
        return Math.max(4, Math.ceil((config.world.playerSize * 1.2) / config.territory.trailPointSpacing));
    }

    return {
        chooseSelfTrailSafeAngle
    };
}

module.exports = {
    createBotRouteSafety
};
