const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// findFirstUnvisitedCellAlongDirection()はLeafletを一切呼ばない純粋関数なので、
// sign-release-direction.test.cjsと同じVM読み込み方式で、実運用のapp.jsを直接検証する。
function loadProductionCellFog() {
  const appPath = join(__dirname, "..", "app.js");
  const source = readFileSync(appPath, "utf8");
  const exposeTestHooks = `
    globalThis.__cellFogTestHooks = {
      findFirstUnvisitedCellAlongDirection,
      cellKey,
      setVisited(keys) {
        visited = {};
        for (const key of keys) visited[key] = { ts: 0, lat: 0, lon: 0 };
      },
      config: CELL_FOG_CONFIG,
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
  return context.__cellFogTestHooks;
}

const cellFog = loadProductionCellFog();

// 8方位すべてで、1ステップ先が正しい向きのセルを指すことを確認する（北=+iy、東=+ixが前提）。
const EXPECTED_STEP_BY_SECTOR = {
  0: { dx: 0, dy: 1 },   // 北
  1: { dx: 1, dy: 1 },   // 北東
  2: { dx: 1, dy: 0 },   // 東
  3: { dx: 1, dy: -1 },  // 南東
  4: { dx: 0, dy: -1 },  // 南
  5: { dx: -1, dy: -1 }, // 南西
  6: { dx: -1, dy: 0 },  // 西
  7: { dx: -1, dy: 1 },  // 北西
};

test("direction vectors: each of the 8 sectors steps toward the correct neighbor cell", () => {
  cellFog.setVisited([]);
  for (const [sector, expected] of Object.entries(EXPECTED_STEP_BY_SECTOR)) {
    const result = cellFog.findFirstUnvisitedCellAlongDirection(0, 0, Number(sector), 4);
    assert.equal(result.ix, expected.dx, `sector ${sector} ix`);
    assert.equal(result.iy, expected.dy, `sector ${sector} iy`);
    assert.equal(result.step, 1);
  }
});

test("skips already-visited cells along the direction and returns the first unvisited one", () => {
  // 北西(sector=7)方向へ2セル分(-1,1)(-2,2)を訪問済みにしておく
  cellFog.setVisited([cellFog.cellKey(-1, 1), cellFog.cellKey(-2, 2)]);
  const result = cellFog.findFirstUnvisitedCellAlongDirection(0, 0, 7, 4);
  // resultはVMの別レルムで生成されたオブジェクトのため、deepEqualではなくフィールドごとに比較する
  // （sign-release-direction.test.cjsと同じ理由: プロトタイプ差でdeepStrictEqualが誤って失敗するため）
  assert.equal(result.ix, -3);
  assert.equal(result.iy, 3);
  assert.equal(result.step, 3);
});

test("returns null when every cell within maxSteps is already visited (no infinite search)", () => {
  cellFog.setVisited([
    cellFog.cellKey(0, 1),
    cellFog.cellKey(0, 2),
    cellFog.cellKey(0, 3),
    cellFog.cellKey(0, 4),
  ]);
  const result = cellFog.findFirstUnvisitedCellAlongDirection(0, 0, 0, 4);
  assert.equal(result, null);
});

test("never returns a cell in a different direction than the confirmed sector (NW stays NW)", () => {
  cellFog.setVisited([cellFog.cellKey(-1, 1)]);
  const result = cellFog.findFirstUnvisitedCellAlongDirection(0, 0, 7, 4); // 北西で確定
  assert.ok(result.ix < 0 && result.iy > 0, "must stay in the north-west quadrant");
  assert.notEqual(result.ix, 1, "must not drift to the east side");
});

test("config: targetMaxSteps and ringCells are finite positive numbers (guards against unbounded search/render)", () => {
  assert.ok(Number.isFinite(cellFog.config.targetMaxSteps) && cellFog.config.targetMaxSteps > 0);
  assert.ok(Number.isFinite(cellFog.config.ringCells) && cellFog.config.ringCells > 0);
  assert.ok(Number.isFinite(cellFog.config.maxRenderedFogCells) && cellFog.config.maxRenderedFogCells > 0);
});
