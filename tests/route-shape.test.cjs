const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// recordRoutePoint()やルート形状のジオメトリ関数はLeafletを一切呼ばない純粋なロジックなので、
// 他のテストと同じVM読み込み方式で、実運用のapp.jsを直接検証する。
function loadProductionRouteShape() {
  const appPath = join(__dirname, "..", "app.js");
  const source = readFileSync(appPath, "utf8");
  const exposeTestHooks = `
    globalThis.__routeShapeTestHooks = {
      registerAdventureDistance,
      recordRoutePoint,
      getEligibleRouteStartPosition,
      evaluateGpsPointQuality,
      appendLatestRouteEndPoint,
      getRouteShapeRenderData,
      projectRoutePoints,
      rotateRoutePoints,
      fitRoutePointsToViewBox,
      buildRoutePathData,
      thinRoutePoints,
      routeConfig: ROUTE_RECORDING_CONFIG,
      viewBox: ROUTE_SHAPE_VIEWBOX,
      setOrigin(o) { origin = o; },
      beginActiveAdventure() {
        adventureState.status = "active";
        adventureState.distanceMeters = 0;
        adventureState.lastDistancePoint = null;
        adventureState.routePoints = [];
        adventureState.lastRoutePoint = null;
      },
      setStatus(s) { adventureState.status = s; },
      setLastDistancePoint(point) {
        adventureState.lastDistancePoint = point ? { ...point } : null;
      },
      getDistanceState() {
        return {
          distanceMeters: adventureState.distanceMeters,
          lastDistancePoint: adventureState.lastDistancePoint
            ? { ...adventureState.lastDistancePoint }
            : null,
        };
      },
      setLastReliablePosition(point) {
        lastReliablePosition = point ? { ...point } : null;
      },
      getLastRoutePoint() {
        return adventureState.lastRoutePoint
          ? { ...adventureState.lastRoutePoint }
          : null;
      },
      getRoutePoints() { return adventureState.routePoints.map((p) => ({ ...p })); },
      getRoutePointCount() { return adventureState.routePoints.length; },
    };
  `;

  const context = vm.createContext({
    AbortController,
    Date,
    Math,
    Promise,
    URLSearchParams,
    clearTimeout,
    console,
    document: {},
    fetch: async () => {
      throw new Error("Network access is disabled in this test");
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    navigator: {},
    performance,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout,
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false }),
    },
  });

  vm.runInContext(`${source}\n${exposeTestHooks}`, context, { filename: appPath });
  return context.__routeShapeTestHooks;
}

const route = loadProductionRouteShape();
const TOKYO = { lat0: 35.681236, lon0: 139.767125 };

/* ---------- recordRoutePoint(): 記録条件 ---------- */

test("route thresholds remain 35m accuracy, 10m/15s spacing, 500m jump, and 4.5m/s speed", () => {
  assert.equal(route.routeConfig.maxAccuracyM, 35);
  assert.equal(route.routeConfig.minDistanceM, 10);
  assert.equal(route.routeConfig.maxIntervalMs, 15000);
  assert.equal(route.routeConfig.minIntervalDistanceM, 3);
  assert.equal(route.routeConfig.maxSegmentDistanceM, 500);
  assert.equal(route.routeConfig.maxSpeedMps, 4.5);
  assert.equal(route.routeConfig.endPointMinDistanceM, 3);
  assert.equal(route.routeConfig.startPointMaxAgeMs, 15000);
  assert.equal(route.routeConfig.endPointMaxAgeMs, 15000);
});

test("recordRoutePoint: does nothing while the adventure is not active", () => {
  route.setStatus("idle");
  route.setOrigin(TOKYO);
  const recorded = route.recordRoutePoint(35.6812, 139.7671, 1000, 10);
  assert.equal(recorded, false);
  assert.equal(route.getRoutePointCount(), 0);
});

test("recordRoutePoint: the first valid point is always recorded as the starting point", () => {
  route.beginActiveAdventure();
  const recorded = route.recordRoutePoint(35.6812, 139.7671, 1000, 10);
  assert.equal(recorded, true);
  assert.equal(route.getRoutePointCount(), 1);
  const [first] = route.getRoutePoints();
  assert.equal(first.cumulativeDistanceM, 0);
});

test("recordRoutePoint: rejects points with accuracy worse than maxAccuracyM", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 1000, 10);
  const recorded = route.recordRoutePoint(35.6813, 139.7672, 2000, route.routeConfig.maxAccuracyM + 1);
  assert.equal(recorded, false);
  assert.equal(route.getRoutePointCount(), 1);
});

test("recordRoutePoint: rejects a point whose accuracy is not finite", () => {
  route.beginActiveAdventure();
  assert.equal(
    route.recordRoutePoint(35.6812, 139.7671, 1000, null),
    false,
  );
  assert.equal(
    route.recordRoutePoint(35.6812, 139.7671, 1000, Infinity),
    false,
  );
  assert.equal(route.getRoutePointCount(), 0);
});

test("route start candidate requires finite <=35m accuracy, finite timestamp, and age within 15 seconds", () => {
  const startedAt = 100000;
  const valid = {
    lat: 35.6812,
    lon: 139.7671,
    timestamp: startedAt - route.routeConfig.startPointMaxAgeMs,
    accuracy: route.routeConfig.maxAccuracyM,
    receivedAt: startedAt - route.routeConfig.startPointMaxAgeMs,
  };

  const accepted = route.getEligibleRouteStartPosition(valid, startedAt);
  assert.ok(accepted);
  assert.equal(accepted.accuracy, route.routeConfig.maxAccuracyM);
  assert.equal(accepted.timestamp, valid.timestamp);
  assert.equal(route.routeConfig.startPointMaxAgeMs, 15000);
  route.beginActiveAdventure();
  assert.equal(
    route.recordRoutePoint(
      accepted.lat,
      accepted.lon,
      accepted.timestamp,
      accepted.accuracy,
    ),
    true,
  );
  assert.equal(
    route.getRoutePoints()[0].accuracy,
    route.routeConfig.maxAccuracyM,
  );

  for (const invalid of [
    { ...valid, accuracy: route.routeConfig.maxAccuracyM + 0.1 },
    { ...valid, accuracy: NaN },
    { ...valid, timestamp: NaN },
    { ...valid, receivedAt: NaN },
    {
      ...valid,
      timestamp: startedAt - route.routeConfig.startPointMaxAgeMs - 1,
    },
    {
      ...valid,
      receivedAt: startedAt - route.routeConfig.startPointMaxAgeMs - 1,
    },
    { ...valid, timestamp: startedAt + 1 },
    { ...valid, receivedAt: startedAt + 1 },
  ]) {
    assert.equal(
      route.getEligibleRouteStartPosition(invalid, startedAt),
      null,
    );
  }
});

test("confirmDirection seeds the route through recordRoutePoint without replacing accuracy with null", () => {
  const appSource = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  const confirmDirection = appSource.match(
    /function confirmDirection\(\)[\s\S]*?\n}/,
  );
  assert.ok(confirmDirection);
  assert.equal(
    confirmDirection[0].includes("getEligibleRouteStartPosition"),
    true,
  );
  assert.equal(confirmDirection[0].includes("recordRoutePoint("), true);
  assert.equal(confirmDirection[0].includes("routePoints.push"), false);
  assert.equal(confirmDirection[0].includes("accuracy: null"), false);
});

test("handlePosition retains timestamp, accuracy, and browser receipt time on lastReliablePosition", () => {
  const appSource = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  const handlePosition = appSource.match(
    /function handlePosition\(pos\)[\s\S]*?\n}/,
  );
  assert.ok(handlePosition);
  const assignment = handlePosition[0].match(
    /lastReliablePosition = \{[\s\S]*?\n    };/,
  );
  assert.ok(assignment);
  assert.equal(assignment[0].includes("timestamp: positionTimestamp"), true);
  assert.equal(assignment[0].includes("accuracy:"), true);
  assert.equal(assignment[0].includes("receivedAt: positionReceivedAt"), true);
});

test("recordRoutePoint: rejects NaN coordinates", () => {
  route.beginActiveAdventure();
  const recorded = route.recordRoutePoint(NaN, 139.7671, 1000, 10);
  assert.equal(recorded, false);
  assert.equal(route.getRoutePointCount(), 0);
});

test("recordRoutePoint: a tiny move within minDistanceM and minIntervalMs is not saved", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  // 緯度を約0.00003度(約3.3m)だけ動かす。10m未満・15秒未満なので保存されないはず。
  const recorded = route.recordRoutePoint(35.68123, 139.7671, 3000, 10);
  assert.equal(recorded, false);
  assert.equal(route.getRoutePointCount(), 1);
});

test("recordRoutePoint: a move of 10m or more is saved immediately", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  // 緯度を約0.0001度(約11m)動かす。
  const recorded = route.recordRoutePoint(35.6813, 139.7671, 3000, 10);
  assert.equal(recorded, true);
  assert.equal(route.getRoutePointCount(), 2);
});

test("recordRoutePoint: a small move is saved once maxIntervalMs has passed and it clears minIntervalDistanceM", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  // 約4m移動、かつ15秒以上経過 → 記録間隔のフォールバックで保存されるはず
  const recorded = route.recordRoutePoint(35.68124, 139.7671, 16000, 10);
  assert.equal(recorded, true);
  assert.equal(route.getRoutePointCount(), 2);
});

test("recordRoutePoint: even after maxIntervalMs, pure GPS noise below minIntervalDistanceM is not saved", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  // 15秒以上経過しているが、ほぼ動いていない(1m未満)
  const recorded = route.recordRoutePoint(35.68120001, 139.7671, 20000, 10);
  assert.equal(recorded, false);
  assert.equal(route.getRoutePointCount(), 1);
});

test("recordRoutePoint: rejects a large GPS jump beyond maxSegmentDistanceM", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  // 緯度を約1度(約111km)ジャンプさせる
  const recorded = route.recordRoutePoint(36.6812, 139.7671, 3000, 10);
  assert.equal(recorded, false);
  assert.equal(route.getRoutePointCount(), 1, "the jump itself must not be added to the visible route");
});

test("recordRoutePoint: a jump does not move the reference point, so a point near the jump target is still rejected", () => {
  // registerAdventureDistance()と違い、ジャンプ先を新しい基準点にはしない。
  // ここで基準点が進んでしまうと、ジャンプ先付近の点が「正常な小さな移動」として
  // 採用され、ルート形状全体の縮尺がジャンプ先まで含めて引き伸ばされてしまう。
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  route.recordRoutePoint(36.6812, 139.7671, 3000, 10); // 棄却されるジャンプ
  // ジャンプ先のすぐ近く(約11m)でも、基準点は据え置かれているため依然ジャンプ扱いで棄却される
  const recorded = route.recordRoutePoint(36.6813, 139.7671, 6000, 10);
  assert.equal(recorded, false);
  assert.equal(route.getRoutePointCount(), 1);
});

test("recordRoutePoint: after a jump, GPS self-correcting back near the original point resumes recording normally", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  route.recordRoutePoint(36.6812, 139.7671, 3000, 10); // 棄却されるジャンプ（一時的なノイズを想定）
  // GPSが元の位置付近(約11m)へ自己修正 → 基準点は最初の点のままなので正常に採用される
  const recorded = route.recordRoutePoint(35.6813, 139.7671, 9000, 10);
  assert.equal(recorded, true);
  assert.equal(route.getRoutePointCount(), 2);
});

test("recordRoutePoint: rejects movement faster than maxSpeedMps", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  // 約111m移動を1秒で ≒ 111m/s、maxSpeedMps(4.5)を大きく超える
  const recorded = route.recordRoutePoint(35.6822, 139.7671, 1000, 10);
  assert.equal(recorded, false);
  assert.equal(route.getRoutePointCount(), 1);
});

test("recordRoutePoint: rejects identical and reversed timestamps without moving the route baseline", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 2000, 10);

  assert.equal(
    route.recordRoutePoint(35.6813, 139.7671, 2000, 10),
    false,
  );
  assert.equal(
    route.recordRoutePoint(35.6813, 139.7671, 1000, 10),
    false,
  );
  assert.equal(route.getRoutePointCount(), 1);
  assert.equal(route.getLastRoutePoint().timestamp, 2000);
});

test("distance recording rejects identical and reversed timestamps without moving its baseline", () => {
  route.beginActiveAdventure();
  route.setLastDistancePoint({
    lat: 35.6812,
    lon: 139.7671,
    timestamp: 2000,
  });

  assert.equal(
    route.registerAdventureDistance(35.6813, 139.7671, 2000, 10),
    false,
  );
  assert.equal(
    route.registerAdventureDistance(35.6813, 139.7671, 1000, 10),
    false,
  );
  const state = route.getDistanceState();
  assert.equal(state.distanceMeters, 0);
  assert.equal(state.lastDistancePoint.timestamp, 2000);
});

test("route and distance quality evaluation use the same non-monotonic timestamp rejection", () => {
  const previous = {
    lat: 35.6812,
    lon: 139.7671,
    timestamp: 2000,
    accuracy: 10,
  };
  for (const timestamp of [2000, 1000]) {
    const evaluation = route.evaluateGpsPointQuality(
      {
        lat: 35.6813,
        lon: 139.7671,
        timestamp,
        accuracy: 10,
      },
      previous,
      {
        maxAccuracyM: route.routeConfig.maxAccuracyM,
        minDistanceM: 0,
        maxSegmentDistanceM: route.routeConfig.maxSegmentDistanceM,
        maxSpeedMps: route.routeConfig.maxSpeedMps,
      },
    );
    assert.equal(evaluation.accepted, false);
    assert.equal(evaluation.rejectionReason, "non-monotonic-timestamp");
  }
});

test("end point: a fresh valid 3m+ point is appended even when the normal 10m spacing would skip it", () => {
  const now = 100000;
  route.beginActiveAdventure();
  assert.equal(route.recordRoutePoint(35.6812, 139.7671, now - 3000, 10), true);
  route.setLastReliablePosition({
    lat: 35.68125,
    lon: 139.7671,
    timestamp: now - 1000,
    accuracy: 10,
    receivedAt: now - 500,
  });

  assert.equal(route.appendLatestRouteEndPoint(now), true);
  assert.equal(route.getRoutePointCount(), 2);
  assert.equal(route.getLastRoutePoint().timestamp, now - 1000);
});

test("end point: accuracy worse than 35m is rejected", () => {
  const now = 100000;
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, now - 3000, 10);
  route.setLastReliablePosition({
    lat: 35.68125,
    lon: 139.7671,
    timestamp: now - 1000,
    accuracy: route.routeConfig.maxAccuracyM + 1,
    receivedAt: now - 500,
  });

  assert.equal(route.appendLatestRouteEndPoint(now), false);
  assert.equal(route.getRoutePointCount(), 1);
});

test("end point: stale, identical, and reversed timestamps are rejected", () => {
  const now = 100000;
  const candidates = [
    {
      timestamp: now - route.routeConfig.endPointMaxAgeMs - 1,
      receivedAt: now - route.routeConfig.endPointMaxAgeMs - 1,
    },
    { timestamp: now - 3000, receivedAt: now - 500 },
    { timestamp: now - 4000, receivedAt: now - 500 },
  ];

  for (const candidate of candidates) {
    route.beginActiveAdventure();
    route.recordRoutePoint(35.6812, 139.7671, now - 3000, 10);
    route.setLastReliablePosition({
      lat: 35.68125,
      lon: 139.7671,
      accuracy: 10,
      ...candidate,
    });
    assert.equal(route.appendLatestRouteEndPoint(now), false);
    assert.equal(route.getRoutePointCount(), 1);
  }
});

test("end point: movement below 3m and excessive speed are rejected", () => {
  const now = 100000;
  const candidates = [
    {
      lat: 35.68121,
      timestamp: now - 1000,
      receivedAt: now - 500,
    },
    {
      lat: 35.6822,
      timestamp: now - 2900,
      receivedAt: now - 500,
    },
  ];

  for (const candidate of candidates) {
    route.beginActiveAdventure();
    route.recordRoutePoint(35.6812, 139.7671, now - 3000, 10);
    route.setLastReliablePosition({
      lon: 139.7671,
      accuracy: 10,
      ...candidate,
    });
    assert.equal(route.appendLatestRouteEndPoint(now), false);
    assert.equal(route.getRoutePointCount(), 1);
  }
});

test("end point: a segment over 500m is rejected even when its calculated speed is within the limit", () => {
  const now = 300000;
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, now - 201000, 10);
  route.setLastReliablePosition({
    lat: 35.6867,
    lon: 139.7671,
    timestamp: now - 1000,
    accuracy: 10,
    receivedAt: now - 500,
  });

  assert.equal(route.appendLatestRouteEndPoint(now), false);
  assert.equal(route.getRoutePointCount(), 1);
});

test("end point: no held reliable position is handled without adding a point", () => {
  route.beginActiveAdventure();
  route.setLastReliablePosition(null);
  assert.equal(route.appendLatestRouteEndPoint(100000), false);
  assert.equal(route.getRoutePointCount(), 0);
});

test("endAdventure appends the evaluated endpoint before completion data is created", () => {
  const appSource = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  const endAdventure = appSource.match(
    /function endAdventure\(\)[\s\S]*?\n}/,
  );
  assert.ok(endAdventure);
  const appendIndex = endAdventure[0].indexOf("appendLatestRouteEndPoint");
  const completionIndex = endAdventure[0].indexOf(
    "adventureState.completionData = getAdventureCompletionData()",
  );
  assert.ok(appendIndex >= 0);
  assert.ok(completionIndex > appendIndex);
});

test("route accuracy debug log contains the required fields and no coordinates", () => {
  const appSource = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  const logger = appSource.match(
    /function logRouteAccuracyReview\(event, details\)[\s\S]*?\n}/,
  );
  assert.ok(logger);
  for (const field of [
    "event",
    "accuracyM",
    "timestamp",
    "receivedAt",
    "ageMs",
    "acceptedForDistance",
    "acceptedForRoute",
    "rejectionReason",
    "segmentDistanceM",
    "elapsedSeconds",
    "calculatedSpeedMps",
    "routePointCount",
    "isStartPoint",
    "isEndPoint",
    "lastRouteTimestamp",
  ]) {
    assert.equal(logger[0].includes(field), true, `missing debug field: ${field}`);
  }
  assert.equal(logger[0].includes("latitude"), false);
  assert.equal(logger[0].includes("longitude"), false);
});

test("recordRoutePoint: cumulativeDistanceM accumulates only across accepted steps", () => {
  route.beginActiveAdventure();
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  route.recordRoutePoint(35.6813, 139.7671, 3000, 10); // ~11m、保存される
  const points = route.getRoutePoints();
  assert.equal(points.length, 2);
  assert.ok(points[1].cumulativeDistanceM > 0);
});

test("thinRoutePoints: keeps the first point and halves the rest", () => {
  route.beginActiveAdventure();
  // 1ステップ約16.7m / 20秒 ≒ 0.83m/s（maxSpeedMps未満）で、各点が正常に採用されるようにする。
  for (let i = 0; i < 5; i++) {
    route.recordRoutePoint(35.6812 + i * 0.00015, 139.7671, i * 20000, 10);
  }
  const before = route.getRoutePointCount();
  assert.ok(before >= 4, `expected most of the 5 steps to be accepted, got ${before}`);
  route.thinRoutePoints();
  const after = route.getRoutePointCount();
  assert.ok(after < before);
  assert.ok(after >= 1);
});

/* ---------- 座標変換・フィット・パス生成 ---------- */

test("projectRoutePoints: a point directly north of another differs only in y", () => {
  route.setOrigin(TOKYO);
  const points = [
    { lat: 35.6812, lon: 139.7671 },
    { lat: 35.6822, lon: 139.7671 }, // 北へ移動(緯度が増える)
  ];
  const projected = route.projectRoutePoints(points);
  assert.ok(Math.abs(projected[0].x - projected[1].x) < 0.01, "longitude unchanged -> x should match");
  assert.ok(projected[1].y < projected[0].y, "moving north must decrease y (north is up on screen)");
});

test("projectRoutePoints: a point directly east of another differs only in x", () => {
  route.setOrigin(TOKYO);
  const points = [
    { lat: 35.6812, lon: 139.7671 },
    { lat: 35.6812, lon: 139.7681 }, // 東へ移動(経度が増える)
  ];
  const projected = route.projectRoutePoints(points);
  assert.ok(Math.abs(projected[0].y - projected[1].y) < 0.01, "latitude unchanged -> y should match");
  assert.ok(projected[1].x > projected[0].x, "moving east must increase x");
});

test("rotateRoutePoints: 90/180/270/360 degree steps rotate a point consistently", () => {
  // node:assert/strictのequal()はSameValue(-0 !== 0)で比較するため、回転計算の中間結果に
  // 出うる-0を+0へ正規化してから比較する（座標としては-0と0は等価なため区別は不要）。
  const nz = (n) => (n === 0 ? 0 : n);
  const p = [{ x: 1, y: 0 }];
  const r90 = route.rotateRoutePoints(p, 1, false)[0];
  const r180 = route.rotateRoutePoints(p, 2, false)[0];
  const r270 = route.rotateRoutePoints(p, 3, false)[0];
  const r360 = route.rotateRoutePoints(p, 4, false)[0];
  assert.equal(nz(r90.x), 0);
  assert.equal(nz(r90.y), 1);
  assert.equal(nz(r180.x), -1);
  assert.equal(nz(r180.y), 0);
  assert.equal(nz(r270.x), 0);
  assert.equal(nz(r270.y), -1);
  assert.equal(nz(r360.x), 1);
  assert.equal(nz(r360.y), 0);
});

test("rotateRoutePoints: flipX mirrors the x axis", () => {
  const flipped = route.rotateRoutePoints([{ x: 2, y: 3 }], 0, true)[0];
  assert.deepEqual([flipped.x, flipped.y], [-2, 3]);
});

test("fitRoutePointsToViewBox: fits a straight horizontal line without NaN and centers it vertically", () => {
  const points = [
    { x: 0, y: 5 },
    { x: 100, y: 5 },
  ];
  const fitted = route.fitRoutePointsToViewBox(points, route.viewBox);
  fitted.points.forEach((p) => {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  });
  assert.ok(Math.abs(fitted.points[0].y - fitted.points[1].y) < 0.001);
});

test("fitRoutePointsToViewBox: a near-identical (near-zero span) route does not produce NaN/Infinity", () => {
  const points = [
    { x: 10, y: 10 },
    { x: 10.00001, y: 10.00001 },
  ];
  const fitted = route.fitRoutePointsToViewBox(points, route.viewBox);
  assert.ok(Number.isFinite(fitted.scale));
  fitted.points.forEach((p) => {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  });
});

test("fitRoutePointsToViewBox: a purely vertical line is centered horizontally and does not divide by zero", () => {
  const points = [
    { x: 5, y: 0 },
    { x: 5, y: 50 },
  ];
  const fitted = route.fitRoutePointsToViewBox(points, route.viewBox);
  assert.ok(Number.isFinite(fitted.scale));
  assert.ok(Math.abs(fitted.points[0].x - fitted.points[1].x) < 0.001);
  const expectedCenterX = route.viewBox.width / 2;
  assert.ok(Math.abs(fitted.points[0].x - expectedCenterX) < 1);
});

test("buildRoutePathData: fewer than 2 points produces an empty path", () => {
  assert.equal(route.buildRoutePathData([]), "");
  assert.equal(route.buildRoutePathData([{ x: 1, y: 1 }]), "");
});

test("buildRoutePathData: 2+ points produce a Move+Line SVG path string", () => {
  const d = route.buildRoutePathData([
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ]);
  assert.ok(d.startsWith("M1.0 2.0"));
  assert.ok(d.includes("L3.0 4.0"));
});

/* ---------- getRouteShapeRenderData(): 表示可否の判定 ---------- */

test("getRouteShapeRenderData: 0 points -> not visible", () => {
  route.beginActiveAdventure();
  const data = route.getRouteShapeRenderData();
  assert.equal(data.visible, false);
  assert.equal(data.validPointCount, 0);
});

test("getRouteShapeRenderData: 1 point -> not visible (cannot draw a line)", () => {
  route.beginActiveAdventure();
  route.setOrigin(TOKYO);
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  const data = route.getRouteShapeRenderData();
  assert.equal(data.visible, false);
  assert.equal(data.validPointCount, 1);
});

test("getRouteShapeRenderData: 2+ points -> visible with a non-empty path", () => {
  route.beginActiveAdventure();
  route.setOrigin(TOKYO);
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  route.recordRoutePoint(35.6813, 139.7671, 3000, 10);
  const data = route.getRouteShapeRenderData();
  assert.equal(data.visible, true);
  assert.ok(data.pathData.length > 0);
  assert.ok(data.bounds !== null);
});

test("getRouteShapeRenderData: share-card orientation is applied without losing the route", () => {
  route.beginActiveAdventure();
  route.setOrigin(TOKYO);
  route.recordRoutePoint(35.6812, 139.7671, 0, 10);
  route.recordRoutePoint(35.6813, 139.7671, 3000, 10);
  const data = route.getRouteShapeRenderData({ rotationSteps: 1, flipX: true });
  assert.equal(data.visible, true);
  assert.equal(data.rotationSteps, 1);
  assert.equal(data.flipX, true);
  assert.ok(data.pathData.startsWith("M"));
  assert.equal(data.pathData.includes("L"), true);
});

test("achievement card uses a GPS route SVG and has no cell-shape fallback", () => {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  const app = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

  for (const required of [
    'id="achievement-route-summary"',
    'id="achievement-route-shape"',
    'id="achievement-route-path"',
  ]) {
    assert.equal(html.includes(required), true, `missing ${required}`);
  }
  for (const removed of ["achievement-shape-grid", "shape-cell"]) {
    assert.equal(html.includes(removed), false, `obsolete HTML ${removed}`);
    assert.equal(css.includes(removed), false, `obsolete CSS ${removed}`);
  }
  for (const removed of ["renderShapeGrid", "computeSessionShapeCells"]) {
    assert.equal(app.includes(removed), false, `obsolete JavaScript ${removed}`);
  }
  assert.equal(
    app.includes('sectionId: "achievement-route-summary"'),
    true,
  );
  assert.equal(app.includes("animate: false"), true);
});

test("achievement card includes a compact slope-quest badge driven by the completion snapshot", () => {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  const app = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

  const cardStart = html.indexOf('<div id="achievement-card"');
  const cardEnd = html.indexOf("<!-- クエスト詳細パネル -->", cardStart);
  assert.notEqual(cardStart, -1);
  assert.notEqual(cardEnd, -1);
  const card = html.slice(cardStart, cardEnd);
  assert.equal(card.includes('id="achievement-slope-quest-badge"'), true);
  assert.equal(card.includes("result-achievement-badge"), true);
  assert.equal(card.includes("achievement-result-badge"), true);
  assert.equal(card.includes("坂道スポットを踏破"), true);
  const badgeTag = card.match(
    /<div[^>]*id="achievement-slope-quest-badge"[^>]*>/,
  );
  assert.ok(badgeTag);
  assert.equal(badgeTag[0].includes("hidden"), true);

  const showCard = app.match(/function showAchievementCard\(\)[\s\S]*?\n}/);
  assert.ok(showCard);
  assert.equal(showCard[0].includes("adventureState.completionData"), true);
  assert.equal(showCard[0].includes("getAdventureCompletionData()"), true);
  assert.equal(
    showCard[0].includes('"achievement-slope-quest-badge"'),
    true,
  );
  assert.equal(showCard[0].includes("completedSlopeSpots"), false);

  const badgeCss = css.match(/\.achievement-result-badge \{([\s\S]*?)\n}/);
  assert.ok(badgeCss);
  assert.equal(badgeCss[1].includes("max-width: 100%"), true);
  assert.equal(badgeCss[1].includes("white-space: nowrap"), true);
  assert.equal(badgeCss[1].includes("font-size: 11px"), true);
});
