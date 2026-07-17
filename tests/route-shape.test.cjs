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
      recordRoutePoint,
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
        adventureState.routePoints = [];
        adventureState.lastRoutePoint = null;
      },
      setStatus(s) { adventureState.status = s; },
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
