const test = require("node:test");
const assert = require("node:assert/strict");
const { Player } = require("../src/entities/player");
const {
    applyCapturedPolygon,
    createTerritories,
    getTerritoryOverlapRepairQueueDiagnostics,
    initializePlayerTerritory,
    isPointOwnedByPlayer,
    processTerritoryOverlapRepairQueue
} = require("../src/state/territories");
const {
    calculatePolygonIntersectionArea,
    calculatePolygonArea,
    doPolygonsHavePositiveAreaOverlap,
    subtractKnownSimplePolygonComponents,
    subtractPolygon,
    subtractPolygonComponents,
    unionPolygons
} = require("../src/utils/geometry");
const { captureClosedTrail } = require("../src/systems/dominationSystem");
const {
    createCutScenario,
    createCutTerritoryState,
    createCutPlayerState,
    createRectanglePolygon,
    createDenseRectanglePolygon,
    processTerritoryRepairsUntil,
    createCircleLikePolygon,
    replaceTerritoryPolygon,
    createSeededRandom,
    randomBetween,
    getMaximumTerritoryOverlapArea,
    assertTerritoryGeometryInvariants
} = require("./helpers/gameTestFixtures");

test("territory cut keeps the component containing its owner", () => {
    const { territories, capturedPolygon } = createCutScenario();
    const players = new Map([[
        "victim",
        createCutPlayerState({
            x: 15,
            y: 50
        })
    ]]);

    applyCapturedPolygon(territories, "attacker", capturedPolygon, {
        ownerPolygon: capturedPolygon,
        players
    });

    assert.equal(isPointOwnedByPlayer(territories, "victim", 15, 50), true);
    assert.equal(isPointOwnedByPlayer(territories, "victim", 80, 50), false);
    assert.equal(calculatePolygonArea(territories.get("victim").polygon), 3000);
});

test("territory cut follows the owner's trail connection while the owner is outside", () => {
    const { territories, capturedPolygon } = createCutScenario();
    const players = new Map([[
        "victim",
        createCutPlayerState({
            x: 130,
            y: 50,
            isLeftTrailActive: true,
            isRightTrailActive: true,
            trailLeftSegments: [[
                { x: 0, y: 45 },
                { x: -30, y: 45 },
                { x: -30, y: 140 },
                { x: 130, y: 140 },
                { x: 130, y: 50 }
            ]],
            trailRightSegments: [[
                { x: 0, y: 55 },
                { x: -40, y: 55 },
                { x: -40, y: 150 },
                { x: 130, y: 150 },
                { x: 130, y: 50 }
            ]]
        })
    ]]);

    applyCapturedPolygon(territories, "attacker", capturedPolygon, {
        ownerPolygon: capturedPolygon,
        players
    });

    assert.equal(isPointOwnedByPlayer(territories, "victim", 15, 50), true);
    assert.equal(isPointOwnedByPlayer(territories, "victim", 80, 50), false);
    assert.equal(calculatePolygonArea(territories.get("victim").polygon), 3000);
});

test("capture apply repairs post-capture owner territory overlaps", () => {
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", createRectanglePolygon(0, 0, 10, 10))],
        ["neighbor", createCutTerritoryState("neighbor", createRectanglePolygon(8, 8, 20, 20))]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(territories, "attacker", createRectanglePolygon(-5, 0, 0, 10), {
        captureOverlapAudit: true,
        diagnostics
    });

    assert.equal(diagnostics.captureApply.postCaptureOverlapCount, 1);
    assert.equal(diagnostics.captureApply.postCaptureOverlapRepairCount, 1);
    assert.equal(diagnostics.captureApply.postCaptureOverlapRepairChangedCount, 1);
    assert.equal(diagnostics.captureApply.postCaptureOverlapFirst.firstId, "attacker");
    assert.equal(diagnostics.captureApply.postCaptureOverlapFirst.secondId, "neighbor");
    assert.ok(diagnostics.captureApply.postCaptureOverlapFirst.overlapArea > 0);
    assert.equal(
        calculatePolygonIntersectionArea(
            territories.get("attacker").polygon,
            territories.get("neighbor").polygon
        ),
        0
    );
    assert.equal(isPointOwnedByPlayer(territories, "neighbor", 9, 9), false);
});

test("capture apply repairs overlaps involving changed non-owner territories", () => {
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", createRectanglePolygon(0, 0, 10, 10))],
        ["victim", createCutTerritoryState("victim", createRectanglePolygon(12, 0, 30, 10))],
        ["third", createCutTerritoryState("third", createRectanglePolygon(25, 0, 40, 10))]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(territories, "attacker", createRectanglePolygon(10, 0, 15, 10), {
        diagnostics,
        ownerPolygon: createRectanglePolygon(0, 0, 15, 10)
    });

    assert.equal(
        calculatePolygonIntersectionArea(
            territories.get("victim").polygon,
            territories.get("third").polygon
        ),
        0
    );
    assert.equal(isPointOwnedByPlayer(territories, "third", 27, 5), false);
    assert.equal(diagnostics.captureApply.postCaptureOverlapRepairChangedCount >= 1, true);
});

test("capture overlap audit ignores territories that only touch at the edge", () => {
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", createRectanglePolygon(0, 0, 10, 10))],
        ["neighbor", createCutTerritoryState("neighbor", createRectanglePolygon(10, 0, 20, 10))]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(territories, "attacker", createRectanglePolygon(-5, 0, 0, 10), {
        captureOverlapAudit: true,
        diagnostics
    });

    assert.equal(diagnostics.captureApply.postCaptureOverlapCount, 0);
});

test("overlap repair queue uses one subtraction for dense territories", async () => {
    const initialOwnerPolygon = createDenseRectanglePolygon(0, 0, 100, 100, 160);
    const expandedOwnerPolygon = createDenseRectanglePolygon(-10, 0, 100, 100, 160);
    const victimPolygon = createDenseRectanglePolygon(80, 0, 180, 100, 160);
    const territories = new Map([
        ["owner", createCutTerritoryState("owner", initialOwnerPolygon)],
        ["victim", createCutTerritoryState("victim", victimPolygon)]
    ]);
    const players = new Map([[
        "victim",
        createCutPlayerState({
            x: 150,
            y: 50
        })
    ]]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-10, 0, 0, 100),
        {
            diagnostics,
            ownerPolygon: expandedOwnerPolygon,
            players
        }
    );

    assert.ok(calculatePolygonIntersectionArea(
        territories.get("owner").polygon,
        territories.get("victim").polygon
    ) > 1);

    await processTerritoryRepairsUntil(
        territories,
        players,
        diagnostics,
        () => calculatePolygonIntersectionArea(
            territories.get("owner").polygon,
            territories.get("victim").polygon
        ) <= 1
    );

    assert.ok(calculatePolygonIntersectionArea(
        territories.get("owner").polygon,
        territories.get("victim").polygon
    ) <= 1);
    assert.equal(diagnostics.phases.overlapRepairQueuePairIntersection, undefined);
    assert.ok(diagnostics.captureApply.overlapRepairWorkerDispatchedCount >= 1);
    assert.ok(diagnostics.captureApply.overlapRepairWorkerCompletedCount >= 1);
    assert.ok(diagnostics.captureApply.overlapRepairWorkerChangedCount >= 1);
});

test("dense territories touching at the edge are not changed by overlap repair", () => {
    const initialOwnerPolygon = createDenseRectanglePolygon(0, 0, 100, 100, 160);
    const expandedOwnerPolygon = createDenseRectanglePolygon(-10, 0, 100, 100, 160);
    const neighborPolygon = createDenseRectanglePolygon(100, 0, 200, 100, 160);
    const territories = new Map([
        ["owner", createCutTerritoryState("owner", initialOwnerPolygon)],
        ["neighbor", createCutTerritoryState("neighbor", neighborPolygon)]
    ]);
    const diagnostics = { phases: {} };
    const neighborVersion = territories.get("neighbor").version;

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-10, 0, 0, 100),
        {
            diagnostics,
            ownerPolygon: expandedOwnerPolygon
        }
    );
    processTerritoryOverlapRepairQueue(territories, new Map(), {
        diagnostics
    });

    assert.equal(
        calculatePolygonIntersectionArea(
            territories.get("owner").polygon,
            territories.get("neighbor").polygon
        ),
        0
    );
    assert.equal(territories.get("neighbor").version, neighborVersion);
    assert.equal(diagnostics.captureApply.postCaptureOverlapCount, 0);
    assert.equal(diagnostics.phases.overlapRepairQueuePairIntersection, undefined);
    assert.equal(diagnostics.phases.overlapRepairQueuePairAreaConfirmation, undefined);
    assert.equal(diagnostics.phases.overlapRepairQueuePairSubtract, undefined);
    assert.equal(diagnostics.phases.overlapRepairQueuePairSubtractAmbiguousIntersection, undefined);
});

test("stale territory repair worker results are discarded by version", async () => {
    const initialOwnerPolygon = createDenseRectanglePolygon(0, 0, 100, 100, 160);
    const expandedOwnerPolygon = createDenseRectanglePolygon(-10, 0, 100, 100, 160);
    const victimPolygon = createDenseRectanglePolygon(80, 0, 180, 100, 160);
    const replacementPolygon = createRectanglePolygon(300, 0, 400, 100);
    const territories = new Map([
        ["owner", createCutTerritoryState("owner", initialOwnerPolygon)],
        ["victim", createCutTerritoryState("victim", victimPolygon)]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-10, 0, 0, 100),
        {
            diagnostics,
            ownerPolygon: expandedOwnerPolygon
        }
    );
    processTerritoryOverlapRepairQueue(territories, new Map(), {
        diagnostics
    });

    assert.ok(diagnostics.captureApply.overlapRepairWorkerDispatchedCount >= 1);
    replaceTerritoryPolygon(territories.get("victim"), replacementPolygon);
    const replacementVersion = territories.get("victim").version;

    await processTerritoryRepairsUntil(
        territories,
        new Map(),
        diagnostics,
        () => diagnostics.captureApply.overlapRepairWorkerStaleCount >= 1
    );

    assert.equal(territories.get("victim").version, replacementVersion);
    assert.equal(isPointOwnedByPlayer(territories, "victim", 350, 50), true);
    assert.equal(isPointOwnedByPlayer(territories, "victim", 90, 50), false);
    assert.equal(diagnostics.captureApply.overlapRepairWorkerChangedCount, 0);
});

test("pending dense overlap repair restarts after another owner mutation", async () => {
    const initialOwnerPolygon = createDenseRectanglePolygon(-100, 0, -50, 100, 160);
    const firstOwnerPolygon = createDenseRectanglePolygon(0, 0, 100, 100, 160);
    const secondOwnerPolygon = createDenseRectanglePolygon(0, 0, 120, 100, 160);
    const territories = new Map([
        ["owner", createCutTerritoryState("owner", initialOwnerPolygon)],
        ["first", createCutTerritoryState(
            "first",
            createDenseRectanglePolygon(80, 0, 180, 30, 160)
        )],
        ["second", createCutTerritoryState(
            "second",
            createDenseRectanglePolygon(80, 35, 180, 65, 160)
        )],
        ["third", createCutTerritoryState(
            "third",
            createDenseRectanglePolygon(80, 70, 180, 100, 160)
        )]
    ]);
    const diagnostics = { phases: {} };

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-120, 0, -110, 10),
        {
            diagnostics,
            ownerPolygon: firstOwnerPolygon
        }
    );
    processTerritoryOverlapRepairQueue(territories, new Map(), {
        diagnostics
    });

    assert.ok(diagnostics.captureApply.overlapRepairWorkerDispatchedCount >= 1);
    assert.ok(
        diagnostics.captureApply.overlapRepairWorkerBackpressureCount >= 1
            || diagnostics.captureApply.overlapRepairQueueBudgetHitCount >= 1,
        "remaining repair should be deferred by worker capacity or the tick budget"
    );
    const queueBeforeMutation = getTerritoryOverlapRepairQueueDiagnostics(territories);

    assert.equal(queueBeforeMutation.completedJobs, 0);
    assert.ok(queueBeforeMutation.inFlightPairs >= 1);
    assert.ok(queueBeforeMutation.pendingItems >= 1);
    assert.equal(queueBeforeMutation.refreshRequests, 0);

    applyCapturedPolygon(
        territories,
        "owner",
        createRectanglePolygon(-140, 0, -130, 10),
        {
            diagnostics,
            ownerPolygon: secondOwnerPolygon
        }
    );

    await processTerritoryRepairsUntil(
        territories,
        new Map(),
        diagnostics,
        () => ["first", "second", "third"].every(id => (
            calculatePolygonIntersectionArea(
                territories.get("owner").polygon,
                territories.get(id).polygon
            ) <= 1
        ))
    );

    assert.ok(diagnostics.captureApply.overlapRepairQueueRefreshCount >= 1);
    assert.ok(diagnostics.captureApply.overlapRepairWorkerStaleCount >= 1);
});

test("positive-area overlap predicate distinguishes shared borders from aligned overlap", () => {
    const first = createRectanglePolygon(0, 0, 100, 100);

    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, createRectanglePolygon(100, 0, 200, 100)),
        false
    );
    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, createRectanglePolygon(100, 100, 200, 200)),
        false
    );
    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, createRectanglePolygon(50, 0, 150, 100)),
        true
    );
    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, createRectanglePolygon(25, 25, 75, 75)),
        true
    );
    assert.equal(
        doPolygonsHavePositiveAreaOverlap(first, [[
            [50, -20],
            [120, 50],
            [50, 120],
            [-20, 50],
            [50, -20]
        ]]),
        true
    );
    assert.equal(doPolygonsHavePositiveAreaOverlap(first, first), true);
});

test("deterministic capture soak preserves territory geometry invariants", async () => {
    const random = createSeededRandom(0x7e22170);
    const territoryEntries = [
        ["northWest", -180, -180],
        ["northEast", 180, -180],
        ["southWest", -180, 180],
        ["southEast", 180, 180]
    ];
    const territories = new Map();
    const players = new Map();
    const versions = new Map();
    const diagnostics = { phases: {} };

    for (const [id, x, y] of territoryEntries) {
        territories.set(
            id,
            createCutTerritoryState(id, createRectanglePolygon(x - 45, y - 45, x + 45, y + 45))
        );
        players.set(id, createCutPlayerState({ id, x, y }));
        versions.set(id, territories.get(id).version);
    }

    for (let captureIndex = 0; captureIndex < 32; captureIndex++) {
        const [ownerId] = territoryEntries[Math.floor(random() * territoryEntries.length)];
        const ownerTerritory = territories.get(ownerId);
        const centerX = randomBetween(random, -240, 240);
        const centerY = randomBetween(random, -240, 240);
        const halfWidth = randomBetween(random, 18, 62);
        const halfHeight = randomBetween(random, 18, 62);
        const capturedPolygon = createRectanglePolygon(
            centerX - halfWidth,
            centerY - halfHeight,
            centerX + halfWidth,
            centerY + halfHeight
        );
        const ownerPolygon = unionPolygons(ownerTerritory.polygon, capturedPolygon);

        applyCapturedPolygon(territories, ownerId, capturedPolygon, {
            diagnostics,
            ownerPolygon,
            players
        });

        await processTerritoryRepairsUntil(
            territories,
            players,
            diagnostics,
            () => getMaximumTerritoryOverlapArea(territories) <= 1
        );
        assertTerritoryGeometryInvariants(territories, versions);
    }

    assert.ok(diagnostics.captureApply.calls >= 32);
    assert.equal(getMaximumTerritoryOverlapArea(territories) <= 1, true);
});

test("capture subtraction keeps dense operands exact", () => {
    const attackerPolygon = createRectanglePolygon(-100, -100, -90, -90);
    const victimPolygon = createCircleLikePolygon(0, 0, 100, 640);
    const denseCapture = createCircleLikePolygon(100, 0, 30, 320);
    const territories = new Map([
        ["attacker", createCutTerritoryState("attacker", attackerPolygon)],
        ["victim", createCutTerritoryState("victim", victimPolygon)]
    ]);
    const diagnostics = { phases: {} };
    const expectedVictimPolygon = subtractPolygon(victimPolygon, denseCapture);

    applyCapturedPolygon(territories, "attacker", denseCapture, {
        diagnostics,
        ownerPolygon: attackerPolygon
    });

    assert.equal(diagnostics.captureApply.subtractCount, 1);
    assert.deepEqual(territories.get("victim").polygon, expectedVictimPolygon);
    assert.equal(
        diagnostics.captureApply.slowestSubtract.operationClippingPointCount,
        diagnostics.captureApply.slowestSubtract.clippingPointCount
    );
    assert.equal(
        diagnostics.captureApply.slowestSubtract.operationSubjectPointCount,
        diagnostics.captureApply.slowestSubtract.subjectPointCount
    );
});

test("known-simple territory subtraction matches the validated geometry path", () => {
    const cases = [
        {
            clipping: createCircleLikePolygon(100, 0, 30, 320),
            subject: createCircleLikePolygon(0, 0, 100, 640)
        },
        {
            clipping: createRectanglePolygon(-10, -60, 10, 60),
            subject: createRectanglePolygon(-50, -50, 50, 50)
        },
        {
            clipping: createRectanglePolygon(50, -20, 80, 20),
            subject: createRectanglePolygon(-50, -50, 50, 50)
        }
    ];

    for (const { subject, clipping } of cases) {
        assert.deepEqual(
            subtractKnownSimplePolygonComponents(subject, clipping),
            subtractPolygonComponents(subject, clipping)
        );
    }
});

test("self-intersecting capture does not enter authoritative territory state", () => {
    const player = new Player("self-crossing-capture", { x: 0, y: 0 });
    const players = new Map([[player.id, player]]);
    const territories = createTerritories();

    initializePlayerTerritory(territories, player);
    const territory = territories.get(player.id);
    const initialPolygon = territory.polygon.map(ring => ring.map(point => point.slice()));
    const initialVersion = territory.version;
    player.trailLeftSegments = [[
        { x: -200, y: 0 },
        { x: -400, y: -200 },
        { x: 400, y: 200 },
        { x: -400, y: 200 },
        { x: 400, y: -200 },
        { x: 200, y: 0 }
    ]];

    assert.equal(captureClosedTrail(player, territories, players), null);
    assert.deepEqual(territory.polygon, initialPolygon);
    assert.equal(territory.version, initialVersion);
    assert.equal(territory.lastCaptureOperation, undefined);
});
