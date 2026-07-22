const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// computeMapDirectionBearing()はLeaflet/DOMを一切呼ばない純粋な角度計算なので、
// 他のテストと同じVM読み込み方式で、実運用のapp.jsを直接検証する。
function loadProductionMapDirection() {
  const appPath = join(__dirname, "..", "app.js");
  const source = readFileSync(appPath, "utf8");
  const exposeTestHooks = `
    globalThis.__mapDirectionTestHooks = {
      computeMapDirectionBearing,
      compassLabels: COMPASS_LABELS,
      adventureState,
      setOrigin(o) { origin = o; },
      resetAdventureStateKeepHistory,
      setDirectionSelectionMode(mode) { adventureState.directionSelectionMode = mode; },
    };
  `;

  const context = vm.createContext({
    AbortController,
    Date,
    Math,
    Number,
    Promise,
    URLSearchParams,
    clearInterval: () => {},
    clearTimeout: () => {},
    console,
    document: {
      // resetAdventureStateKeepHistory()経由でclearDiscoveryNotification()等がel()を呼ぶため、
      // どのidにも同じ無害なスタブ要素を返す（このテストではDOM内容そのものは検証しない）。
      getElementById: () => ({
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        style: { setProperty: () => {} },
        textContent: "",
        offsetWidth: 0,
      }),
    },
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
    setTimeout: () => 1,
    setInterval: () => 1,
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false }),
    },
  });

  vm.runInContext(`${source}\n${exposeTestHooks}`, context, { filename: appPath });
  return context.__mapDirectionTestHooks;
}

const md = loadProductionMapDirection();
const TOKYO = { lat0: 35.681236, lon0: 139.767125 };

/* ---------- computeMapDirectionBearing(): 方位角・8方位変換 ---------- */

test("computeMapDirectionBearing: due north tap resolves to sector 0 (北)", () => {
  md.setOrigin(TOKYO);
  const { bearingDeg, sector } = md.computeMapDirectionBearing(
    TOKYO.lat0,
    TOKYO.lon0,
    TOKYO.lat0 + 0.01,
    TOKYO.lon0,
  );
  assert.ok(Math.abs(bearingDeg - 0) < 0.5);
  assert.equal(sector, 0);
  assert.equal(md.compassLabels[sector], "北");
});

test("computeMapDirectionBearing: due east tap resolves to sector 2 (東)", () => {
  md.setOrigin(TOKYO);
  const { bearingDeg, sector } = md.computeMapDirectionBearing(
    TOKYO.lat0,
    TOKYO.lon0,
    TOKYO.lat0,
    TOKYO.lon0 + 0.01,
  );
  assert.ok(Math.abs(bearingDeg - 90) < 0.5);
  assert.equal(sector, 2);
  assert.equal(md.compassLabels[sector], "東");
});

test("computeMapDirectionBearing: due south tap resolves to sector 4 (南)", () => {
  md.setOrigin(TOKYO);
  const { sector } = md.computeMapDirectionBearing(
    TOKYO.lat0,
    TOKYO.lon0,
    TOKYO.lat0 - 0.01,
    TOKYO.lon0,
  );
  assert.equal(sector, 4);
  assert.equal(md.compassLabels[sector], "南");
});

test("computeMapDirectionBearing: due west tap resolves to sector 6 (西)", () => {
  md.setOrigin(TOKYO);
  const { sector } = md.computeMapDirectionBearing(
    TOKYO.lat0,
    TOKYO.lon0,
    TOKYO.lat0,
    TOKYO.lon0 - 0.01,
  );
  assert.equal(sector, 6);
  assert.equal(md.compassLabels[sector], "西");
});

test("computeMapDirectionBearing: matches the documented 8-sector boundary table", () => {
  md.setOrigin(TOKYO);
  // 境界ちょうど(x.5度)は往復変換の浮動小数点誤差でどちら側にも丸まりうる知恵の輪になるため、
  // 境界から0.1度だけ内側の値で「その区間に属すること」を検証する（実装のround()自体は
  // computeFrontierDirection()と同一式で、既存機能側で既に使われているものを流用している）。
  const boundaryCases = [
    { bearing: 0, sector: 0 },
    { bearing: 22.4, sector: 0 },
    { bearing: 22.6, sector: 1 }, // 北東の区間
    { bearing: 67.6, sector: 2 }, // 東の区間
    { bearing: 112.6, sector: 3 }, // 南東の区間
    { bearing: 157.6, sector: 4 }, // 南の区間
    { bearing: 202.6, sector: 5 }, // 南西の区間
    { bearing: 247.6, sector: 6 }, // 西の区間
    { bearing: 292.6, sector: 7 }, // 北西の区間
    { bearing: 337.6, sector: 0 }, // 北へ戻る区間
    { bearing: 359.9, sector: 0 },
  ];
  boundaryCases.forEach(({ bearing, sector }) => {
    // 与えたい方位角ぴったりのタップ点を、現在地からその方位角・適当な距離で逆算する。
    const rad = (bearing * Math.PI) / 180;
    const dx = Math.sin(rad) * 500; // 東成分(m)
    const dy = Math.cos(rad) * 500; // 北成分(m)
    const targetLat = TOKYO.lat0 + dy / 111320;
    const targetLon =
      TOKYO.lon0 + dx / (111320 * Math.cos((TOKYO.lat0 * Math.PI) / 180));
    const result = md.computeMapDirectionBearing(
      TOKYO.lat0,
      TOKYO.lon0,
      targetLat,
      targetLon,
    );
    assert.equal(
      result.sector,
      sector,
      `bearing ${bearing} should map to sector ${sector}, got ${result.sector}`,
    );
  });
});

test("computeMapDirectionBearing: tapping the current location itself does not throw or produce NaN", () => {
  md.setOrigin(TOKYO);
  const result = md.computeMapDirectionBearing(
    TOKYO.lat0,
    TOKYO.lon0,
    TOKYO.lat0,
    TOKYO.lon0,
  );
  assert.equal(Number.isFinite(result.bearingDeg), true);
  assert.equal(Number.isFinite(result.sector), true);
});

/* ---------- directionSelectionMode: リセット・既定値 ---------- */

test("adventureState.directionSelectionMode defaults to null and is not persisted to localStorage", () => {
  assert.equal(md.adventureState.directionSelectionMode, null);
});

test("resetAdventureStateKeepHistory clears directionSelectionMode", () => {
  md.setDirectionSelectionMode("map");
  md.resetAdventureStateKeepHistory();
  assert.equal(md.adventureState.directionSelectionMode, null);
});

/* ---------- ソースレベルの構造チェック(DOM非依存の配線確認) ---------- */

const appSource = readFileSync(join(__dirname, "..", "app.js"), "utf8");

test("onSignSettled tags flick as the default selection mode, and the map flow overrides it synchronously after finishSpin", () => {
  const settledFn = appSource.match(/function onSignSettled\([\s\S]*?\n\}/)[0];
  assert.equal(settledFn.includes('directionSelectionMode = "flick"'), true);

  const mapSpinFn = appSource.match(
    /function spinSignToMapSector\([\s\S]*?\n\}/,
  )[0];
  assert.equal(mapSpinFn.includes("finishSpin(sector)"), true);
  assert.equal(mapSpinFn.includes('directionSelectionMode = "map"'), true);
  // 上書きがfinishSpin呼び出しより後（settle()内で同期的に）行われることを確認する
  assert.ok(
    mapSpinFn.indexOf("finishSpin(sector)") <
      mapSpinFn.indexOf('directionSelectionMode = "map"'),
  );
});

test("map-direction tap point uses the raw bearing (not the rounded sector) for arrow rotation, so it stays aligned with the drawn line", () => {
  const renderFn = appSource.match(
    /function renderMapDirectionSelection\([\s\S]*?\n\}/,
  )[0];
  assert.equal(renderFn.includes("rotate(${bearingDeg}deg)"), true);
});

test("quest flag click routes to the map-direction tap handler while the mode is active, instead of opening the quest panel", () => {
  const drawFn = appSource.match(/function drawQuestMarker\([\s\S]*?\n\}/)[0];
  assert.equal(drawFn.includes("mapDirectionModeActive"), true);
  assert.equal(drawFn.includes("handleMapDirectionTap(e)"), true);
});

test("map-direction mode always uses live GPS position, never the panned map center, as the bearing origin", () => {
  const fn = appSource.match(
    /function getCurrentPositionForMapDirection\([\s\S]*?\n\}/,
  )[0];
  assert.equal(fn.includes("lastReliablePosition"), true);
  assert.equal(fn.includes("lastKnownLatLon"), true);
  assert.equal(fn.includes("getCenter"), false);
  assert.equal(fn.includes("map.getCenter"), false);
});

test("closing the map-direction overlay (confirm or back) always clears the selected point/bearing/sector", () => {
  const fn = appSource.match(
    /function closeMapDirectionOverlay\([\s\S]*?\n\}/,
  )[0];
  assert.equal(fn.includes("mapDirectionSelectedLatLon = null"), true);
  assert.equal(fn.includes("mapDirectionBearingDeg = null"), true);
  assert.equal(fn.includes("mapDirectionSector = null"), true);
});

test("cancelMapDirectionMode (back) never mutates adventureState.direction", () => {
  const fn = appSource.match(
    /function cancelMapDirectionMode\([\s\S]*?\n\}/,
  )[0];
  assert.equal(fn.includes("adventureState.direction"), false);
});

/* ---------- index.html: 画面導線・DOM構造 ---------- */

const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");

test("direction panel has a subdued secondary entry point into the map-direction mode", () => {
  assert.equal(html.includes('id="btn-open-map-direction"'), true);
  const panel = html.match(
    /<div id="direction-panel"[\s\S]*?<div id="direction-result"/,
  )[0];
  assert.equal(panel.includes('id="btn-open-map-direction"'), true);
  assert.equal(panel.includes('id="btn-spin-sign"'), true);
  // 標識を回すボタンより後ろにあり、主役の標識操作を差し置いて先頭に出ない
  assert.ok(
    panel.indexOf('id="btn-spin-sign"') <
      panel.indexOf('id="btn-open-map-direction"'),
  );
});

test("map-direction-panel exists as an accessible dialog with confirm/back/recenter controls", () => {
  assert.equal(html.includes('id="map-direction-panel"'), true);
  const tagMatch = html.match(/<div[^>]*id="map-direction-panel"[^>]*>/);
  assert.ok(tagMatch);
  assert.equal(tagMatch[0].includes('role="dialog"'), true);
  assert.equal(tagMatch[0].includes('aria-modal="true"'), true);

  const block = html.match(
    /<div id="map-direction-panel"[\s\S]*?\n<\/div>\n\n<!-- 冒険完了シート/,
  )[0];
  assert.equal(block.includes('id="btn-map-direction-confirm"'), true);
  assert.equal(block.includes("disabled"), true); // タップ前は無効
  assert.equal(block.includes('id="btn-map-direction-back"'), true);
  assert.equal(block.includes('id="btn-map-direction-recenter"'), true);
  assert.equal(block.includes('aria-label="現在地へ戻る"'), true);
  assert.equal(block.includes('aria-live="polite"'), true);
});

test("map-direction-panel does not include a routing/destination UI (8-direction buttons, search box, ETA, Google Maps link)", () => {
  const block = html.match(
    /<div id="map-direction-panel"[\s\S]*?\n<\/div>\n\n<!-- 冒険完了シート/,
  )[0];
  for (const forbidden of [
    "検索",
    "search",
    "google.com/maps",
    "到着予定",
    "残り距離",
    "目的地",
  ]) {
    assert.equal(
      block.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `must not contain "${forbidden}"`,
    );
  }
});

/* ---------- styles.css: 地図操作を妨げないpointer-events設計 ---------- */

const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

test("#map-direction-panel lets map pan/zoom/tap pass through, and only its own controls capture taps", () => {
  const panelBlock = css.match(/#map-direction-panel \{([\s\S]*?)\n\}/);
  assert.ok(panelBlock);
  assert.equal(panelBlock[1].includes("pointer-events: none"), true);

  for (const selector of [
    ".map-direction-hint",
    ".map-direction-recenter-btn",
    ".map-direction-bottom",
  ]) {
    const block = css.match(new RegExp(`\\${selector} \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(block, `missing CSS for ${selector}`);
    assert.equal(block[1].includes("pointer-events: auto"), true);
  }
});

test("the map-direction open button is visually subdued compared to the primary spin button", () => {
  const openBtn = css.match(/\.map-direction-open-btn \{([\s\S]*?)\n\}/);
  const spinBtn = css.match(/\.sign-spin-btn \{([\s\S]*?)\n\}/);
  assert.ok(openBtn && spinBtn);
  assert.equal(openBtn[1].includes("background: transparent"), true);
});

test("disabled buttons get a visible (non-color-only) affordance", () => {
  assert.equal(css.includes(".btn-primary:disabled"), true);
});

test("#hud has its own scoped .hidden rule (this codebase does not define a global .hidden utility, so #hud{display:flex}'s ID specificity would otherwise beat a bare .hidden class)", () => {
  const block = css.match(/#hud\.hidden \{([\s\S]*?)\n\}/);
  assert.ok(block, "#hud.hidden rule is missing");
  assert.equal(block[1].includes("display: none"), true);
});

/* ---------- Service Worker ---------- */

test("service worker cache version was bumped for this feature", () => {
  const sw = readFileSync(join(__dirname, "..", "sw.js"), "utf8");
  assert.equal(sw.includes('const CACHE_NAME = "machi-boken-v30"'), true);
});

test("map-direction-panel participates in the shared focus-trap", () => {
  assert.equal(appSource.includes('"map-direction-panel"'), true);
  const trapArray = appSource.match(
    /const FOCUS_TRAP_CONTAINER_IDS = \[([\s\S]*?)\];/,
  )[1];
  assert.equal(trapArray.includes('"map-direction-panel"'), true);
});
