const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const TOKYO = { lat0: 35.681236, lon0: 139.767125 };

// 標高APIへのリクエスト点数に合わせて、決まった標高配列を返す成功レスポンス。
// 3番目(shortlist内)だけ標高を高くし、常に同じ候補が「最良」として選ばれるようにする
// （候補選定アルゴリズム自体はgenerateQuest()のまま、テストからは触れない）。
function makeSuccessFetch() {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const results = body.locations.map((loc, i) => ({
      elevation: i === 3 ? 80 : 10,
    }));
    return { ok: true, json: async () => ({ results }) };
  };
}

function makeFailingFetch() {
  return async () => {
    throw new Error("network down");
  };
}

// drawQuestMarker()が実際にLeafletマーカーを生成した回数・座標を数えるための最小限のL/questLayer代替。
// フラッグが「1冒険で最大1回だけ固定表示される」ことを検証する目的にのみ使う。
function loadProductionAdventure(fetchImpl) {
  const appPath = join(__dirname, "..", "app.js");
  const source = readFileSync(appPath, "utf8");
  const exposeTestHooks = `
    globalThis.__slopeQuestTestHooks = {
      adventureState,
      ADVENTURE_PRESETS,
      ensureQuest,
      drawQuestMarker,
      triggerSlopeQuestCompletion,
      retireSlopeQuestMarkerForEndOfAdventure,
      buildSlopeQuestArrivalDebugContext,
      selectAdventurePreset,
      resetAdventureStateKeepHistory,
      cellIndex,
      cellKey,
      setOrigin(o) { origin = o; },
      setLastReliablePosition(p) { lastReliablePosition = p; },
      getLastReliablePosition() { return lastReliablePosition; },
      setQuestLayer(layer) { questLayer = layer; },
      getQuestMarker() { return questMarker; },
      setSlopeQuestCompletionInProgress(v) { slopeQuestCompletionInProgress = v; },
      getSlopeQuestCompletionInProgress() { return slopeQuestCompletionInProgress; },
      markAllRingCellsVisited(lat, lon) {
        const { ix: cix, iy: ciy } = cellIndex(lat, lon);
        for (let dx = -QUEST_RING_CELLS; dx <= QUEST_RING_CELLS; dx++) {
          for (let dy = -QUEST_RING_CELLS; dy <= QUEST_RING_CELLS; dy++) {
            if (dx === 0 && dy === 0) continue;
            visited[cellKey(cix + dx, ciy + dy)] = { ts: Date.now(), lat, lon };
          }
        }
      },
    };
  `;

  const markerCreations = [];
  const questLayerCalls = { clearLayers: 0 };

  function makeStubElement() {
    const el = {
      classList: {
        _set: new Set(),
        add(...names) { names.forEach((n) => el.classList._set.add(n)); },
        remove(...names) { names.forEach((n) => el.classList._set.delete(n)); },
        contains(n) { return el.classList._set.has(n); },
        toggle(n, force) {
          if (force === undefined) {
            el.classList._set.has(n) ? el.classList._set.delete(n) : el.classList._set.add(n);
          } else if (force) el.classList._set.add(n);
          else el.classList._set.delete(n);
        },
      },
      style: { setProperty: () => {} },
      textContent: "",
      innerHTML: "",
      offsetWidth: 0,
      disabled: false,
      appendChild: () => {},
      setAttribute: () => {},
      getAttribute: () => null,
      querySelector: () => null,
      addEventListener: () => {},
      focus: () => {},
      getElement: () => null,
    };
    return el;
  }

  const fakeLeaflet = {
    divIcon: (opts) => ({ __divIcon: true, opts }),
    marker: (latlng, opts) => {
      markerCreations.push({ lat: latlng[0], lng: latlng[1] });
      const m = {
        addTo: () => m,
        on: () => m,
        getElement: () => null,
      };
      return m;
    },
  };

  const questLayerStub = {
    clearLayers: () => {
      questLayerCalls.clearLayers += 1;
    },
  };

  const context = vm.createContext({
    AbortController,
    Date,
    Math,
    Number,
    Promise,
    URLSearchParams,
    JSON,
    clearInterval: () => {},
    clearTimeout: () => {},
    setTimeout: () => 1, // 発火はさせない。同期的に検証できる範囲だけをテストする
    setInterval: () => 1,
    console,
    crypto: {
      randomUUID: (() => {
        let n = 0;
        return () => `test-request-${n++}`;
      })(),
    },
    document: {
      getElementById: () => makeStubElement(),
      createElement: () => makeStubElement(),
    },
    fetch: (...args) => fetchImpl(...args),
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    navigator: {},
    performance,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    window: {
      addEventListener: () => {},
      // 紙吹雪(spawnConfetti)はreduced-motionで即return するため、
      // document.createElementの詳細な形まで作り込まずに済ませる。
      matchMedia: () => ({ matches: true }),
    },
    L: fakeLeaflet,
  });

  vm.runInContext(`${source}\n${exposeTestHooks}`, context, { filename: appPath });
  const hooks = context.__slopeQuestTestHooks;
  hooks.setQuestLayer(questLayerStub);
  return { hooks, markerCreations, questLayerCalls };
}

function activateAdventure(hooks) {
  hooks.setOrigin(TOKYO);
  hooks.adventureState.status = "active";
  hooks.setLastReliablePosition({ lat: TOKYO.lat0, lon: TOKYO.lon0 });
}

/* ---------- ensureQuest(): 生成条件・ロック ---------- */

test("ensureQuest does nothing while the adventure is not active", async () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.setOrigin(TOKYO);
  hooks.setLastReliablePosition({ lat: TOKYO.lat0, lon: TOKYO.lon0 });
  hooks.adventureState.status = "idle";

  await hooks.ensureQuest();

  assert.equal(hooks.adventureState.slopeQuest.status, "idle");
  assert.equal(markerCreations.length, 0);
});

test("ensureQuest does nothing without a reliable position", async () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.setOrigin(TOKYO);
  hooks.adventureState.status = "active";
  hooks.setLastReliablePosition(null);

  await hooks.ensureQuest();

  assert.equal(hooks.adventureState.slopeQuest.status, "idle");
  assert.equal(markerCreations.length, 0);
});

test("ensureQuest generates exactly one candidate and locks the flag (status -> ready, marker drawn once)", async () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  activateAdventure(hooks);

  await hooks.ensureQuest();

  assert.equal(hooks.adventureState.slopeQuest.status, "ready");
  assert.equal(typeof hooks.adventureState.slopeQuest.lat, "number");
  assert.equal(typeof hooks.adventureState.slopeQuest.lng, "number");
  assert.ok(hooks.adventureState.slopeQuest.cellId);
  assert.equal(markerCreations.length, 1);
});

test("ensureQuest ignores repeated calls once a candidate is already ready (GPS ticks do not move or redraw the flag)", async () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  activateAdventure(hooks);
  await hooks.ensureQuest();
  const lockedLat = hooks.adventureState.slopeQuest.lat;
  const lockedLng = hooks.adventureState.slopeQuest.lng;

  // 現在地が別セルへ移った想定でensureQuestを何度も呼ぶ(GPS更新のたびに呼ばれる実際の呼び出しを模す)
  hooks.setLastReliablePosition({ lat: TOKYO.lat0 + 0.01, lon: TOKYO.lon0 + 0.01 });
  await hooks.ensureQuest();
  await hooks.ensureQuest();
  await hooks.ensureQuest();

  assert.equal(hooks.adventureState.slopeQuest.lat, lockedLat);
  assert.equal(hooks.adventureState.slopeQuest.lng, lockedLng);
  assert.equal(markerCreations.length, 1); // 再描画されていない
});

test("ensureQuest does not retry when no candidate is available for this session (unavailable)", async () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  activateAdventure(hooks);
  hooks.markAllRingCellsVisited(TOKYO.lat0, TOKYO.lon0); // 周辺セルを全て探索済みにし、候補ゼロにする

  await hooks.ensureQuest();
  assert.equal(hooks.adventureState.slopeQuest.status, "unavailable");
  assert.equal(markerCreations.length, 0);

  await hooks.ensureQuest();
  await hooks.ensureQuest();
  assert.equal(hooks.adventureState.slopeQuest.status, "unavailable");
  assert.equal(markerCreations.length, 0);
});

test("elevation API failure still adopts the existing nearest-distance fallback candidate as ready (unchanged algorithm, just locked)", async () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeFailingFetch());
  activateAdventure(hooks);

  await hooks.ensureQuest();

  assert.equal(hooks.adventureState.slopeQuest.status, "ready");
  assert.equal(hooks.adventureState.slopeQuest.score, null); // フォールバック時はgradientPct不明のまま
  assert.equal(markerCreations.length, 1);
});

/* ---------- 非同期応答の競合防止 ---------- */

test("a stale requestId (superseded before the response arrives) is discarded and does not overwrite the locked state", async () => {
  let resolveFetch;
  const fetchImpl = () =>
    new Promise((resolve) => {
      resolveFetch = () =>
        resolve({
          ok: true,
          json: async () => ({ results: [{ elevation: 10 }, { elevation: 80 }] }),
        });
    });
  const { hooks, markerCreations } = loadProductionAdventure(fetchImpl);
  activateAdventure(hooks);

  const pending = hooks.ensureQuest();
  assert.equal(hooks.adventureState.slopeQuest.status, "pending");
  // 応答が返る前に、requestIdが別のものへ差し替わった状態を模す(理論上の防御チェックを直接検証する)
  hooks.adventureState.slopeQuest.requestId = "someone-elses-request";
  resolveFetch();
  await pending;

  assert.equal(hooks.adventureState.slopeQuest.status, "pending");
  assert.equal(hooks.adventureState.slopeQuest.requestId, "someone-elses-request");
  assert.equal(markerCreations.length, 0);
});

test("a response that arrives after a new adventure has started (sessionId changed) is ignored", async () => {
  let resolveFetch;
  const fetchImpl = () =>
    new Promise((resolve) => {
      resolveFetch = () =>
        resolve({
          ok: true,
          json: async () => ({ results: [{ elevation: 10 }, { elevation: 80 }] }),
        });
    });
  const { hooks, markerCreations } = loadProductionAdventure(fetchImpl);
  activateAdventure(hooks);

  const pending = hooks.ensureQuest();
  hooks.adventureState.sessionId += 1; // 新しい冒険が始まった想定
  resolveFetch();
  await pending;

  assert.equal(markerCreations.length, 0);
});

test("a response that arrives after the adventure already ended (status no longer active) is ignored", async () => {
  let resolveFetch;
  const fetchImpl = () =>
    new Promise((resolve) => {
      resolveFetch = () =>
        resolve({
          ok: true,
          json: async () => ({ results: [{ elevation: 10 }, { elevation: 80 }] }),
        });
    });
  const { hooks, markerCreations } = loadProductionAdventure(fetchImpl);
  activateAdventure(hooks);

  const pending = hooks.ensureQuest();
  hooks.adventureState.status = "completed"; // 冒険終了(遅延応答)
  resolveFetch();
  await pending;

  assert.equal(markerCreations.length, 0);
});

/* ---------- drawQuestMarker(): 保存済みの座標だけを描画する ---------- */

test("drawQuestMarker only ever reads from adventureState.slopeQuest, never from a passed-in candidate", () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest.status = "ready";
  hooks.adventureState.slopeQuest.lat = 35.7;
  hooks.adventureState.slopeQuest.lng = 139.8;
  hooks.adventureState.slopeQuest.cellId = "1_1";

  hooks.drawQuestMarker();

  assert.equal(markerCreations.length, 1);
  assert.equal(markerCreations[0].lat, 35.7);
  assert.equal(markerCreations[0].lng, 139.8);
});

test("drawQuestMarker does nothing when there is no ready/completed candidate to show", () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest.status = "idle";
  hooks.drawQuestMarker();
  assert.equal(markerCreations.length, 0);

  hooks.adventureState.slopeQuest.status = "pending";
  hooks.drawQuestMarker();
  assert.equal(markerCreations.length, 0);

  hooks.adventureState.slopeQuest.status = "unavailable";
  hooks.drawQuestMarker();
  assert.equal(markerCreations.length, 0);
});

/* ---------- 到達・冒険終了 ---------- */

test("triggerSlopeQuestCompletion marks the quest completed exactly once and does not draw a new marker", () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.setOrigin(TOKYO);
  hooks.adventureState.slopeQuest.status = "ready";
  hooks.adventureState.slopeQuest.lat = 35.7;
  hooks.adventureState.slopeQuest.lng = 139.8;
  hooks.adventureState.slopeQuest.cellId = "1_1";
  hooks.adventureState.slopeQuest.score = 4.2;

  hooks.triggerSlopeQuestCompletion(35.7, 139.8);
  assert.equal(hooks.adventureState.slopeQuest.status, "completed");
  assert.equal(hooks.adventureState.slopeQuestCompleted, true);
  assert.equal(markerCreations.length, 0); // 到達演出はマーカーを再生成しない(既存のDOM操作のみ)

  // 二重到達: 何も変わらない
  hooks.triggerSlopeQuestCompletion(35.7, 139.8);
  assert.equal(hooks.adventureState.slopeQuest.status, "completed");
});

test("after completion, ensureQuest never starts a new search for the rest of the adventure", async () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  activateAdventure(hooks);
  hooks.adventureState.slopeQuest.status = "completed";
  hooks.adventureState.slopeQuest.lat = 35.7;
  hooks.adventureState.slopeQuest.lng = 139.8;
  hooks.adventureState.slopeQuest.cellId = "1_1";

  await hooks.ensureQuest();

  assert.equal(hooks.adventureState.slopeQuest.status, "completed");
  assert.equal(markerCreations.length, 0);
});

test("retireSlopeQuestMarkerForEndOfAdventure clears the map layer, unless the arrival animation is still playing", () => {
  const { hooks, questLayerCalls } = loadProductionAdventure(makeSuccessFetch());

  hooks.setSlopeQuestCompletionInProgress(false);
  hooks.retireSlopeQuestMarkerForEndOfAdventure();
  assert.equal(questLayerCalls.clearLayers, 1);

  hooks.setSlopeQuestCompletionInProgress(true);
  hooks.retireSlopeQuestMarkerForEndOfAdventure();
  assert.equal(questLayerCalls.clearLayers, 1); // 演出中は消さない(既存の到達演出を優先する)
});

/* ---------- リセット: 新しい冒険開始時だけ ---------- */

test("selectAdventurePreset resets slopeQuest to idle for a new adventure", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest = {
    status: "ready",
    lat: 1,
    lng: 2,
    cellId: "0_0",
    score: 3,
    requestId: "abc",
  };

  hooks.selectAdventurePreset("short");

  // VM越しのオブジェクトはプロトタイプが異なるため、deepStrictEqualではなくフィールド単位で比較する。
  const q = hooks.adventureState.slopeQuest;
  assert.equal(q.status, "idle");
  assert.equal(q.lat, null);
  assert.equal(q.lng, null);
  assert.equal(q.cellId, null);
  assert.equal(q.score, null);
  assert.equal(q.requestId, null);
});

test("resetAdventureStateKeepHistory (end-of-adventure return to idle) does NOT reset slopeQuest itself, only selectAdventurePreset (new adventure) does", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest = {
    status: "completed",
    lat: 1,
    lng: 2,
    cellId: "0_0",
    score: 3,
    requestId: "abc",
  };

  hooks.resetAdventureStateKeepHistory();

  assert.equal(hooks.adventureState.slopeQuest.status, "completed");
});

/* ---------- buildSlopeQuestArrivalDebugContext ---------- */

test("buildSlopeQuestArrivalDebugContext compares the current cell against adventureState.slopeQuest.cellId", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  hooks.setOrigin(TOKYO);
  hooks.adventureState.slopeQuest.cellId = hooks.cellKey(
    ...Object.values(hooks.cellIndex(TOKYO.lat0, TOKYO.lon0)),
  );
  hooks.adventureState.slopeQuest.lat = TOKYO.lat0;
  hooks.adventureState.slopeQuest.lng = TOKYO.lon0;

  const ctx = hooks.buildSlopeQuestArrivalDebugContext(TOKYO.lat0, TOKYO.lon0);
  assert.equal(ctx.arrivalRule, "same-cell");
  assert.equal(ctx.isSameCell, true);
  assert.equal(ctx.approximateCellSizeM, 200);
});

/* ---------- ソースレベルの構造チェック ---------- */

const appSource = readFileSync(join(__dirname, "..", "app.js"), "utf8");

test("ensureQuest's stale-response guard reports every reason string from the spec", () => {
  const fn = appSource.match(/async function ensureQuest\(\)[\s\S]*?\n}\n/)[0];
  for (const reason of [
    "already-pending",
    "already-ready",
    "already-completed",
    "unavailable-for-this-session",
    "no-reliable-position",
    "previous-session",
    "adventure-inactive",
    "stale-request",
  ]) {
    assert.equal(fn.includes(reason), true, `missing reason: ${reason}`);
  }
});

test("the arrival check in handlePosition uses adventureState.slopeQuest (status===ready + same cellId), not the old free-floating quest variable", () => {
  assert.equal(
    appSource.includes('adventureState.slopeQuest.status === "ready" &&'),
    true,
  );
  assert.equal(appSource.includes("adventureState.slopeQuest.cellId === key"), true);
});

test("the old am_quest localStorage key is no longer defined as an active STORAGE_KEYS entry, and the free-floating quest variable is gone", () => {
  assert.equal(appSource.includes('quest: "am_quest"'), false);
  assert.equal(/(^|[^.\w])quest\s*=\s*store\.get/.test(appSource), false);
  assert.equal(appSource.includes("STORAGE_KEYS.quest"), false);
});

test("endAdventure retires the slope-quest marker", () => {
  const fn = appSource.match(/function endAdventure\(\)[\s\S]*?\n}\n/)[0];
  assert.equal(fn.includes("retireSlopeQuestMarkerForEndOfAdventure()"), true);
});

test("service worker cache version was bumped for this fix", () => {
  const sw = readFileSync(join(__dirname, "..", "sw.js"), "utf8");
  assert.equal(sw.includes('const CACHE_NAME = "machi-boken-v29"'), true);
});
