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

// drawQuestMarker()/renderCompletedSlopeSpots()が実際にLeafletマーカーを生成した回数・座標を
// 数えるための最小限のL/レイヤー代替。「候補は1冒険1つ・接近だけでは自動達成しない・
// 踏破済み地点は恒久保存され次回以降も表示される」ことを検証する目的にのみ使う。
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
      endAdventure,
      cellIndex,
      cellKey,
      isNearSlopeQuest,
      handleSlopeQuestProximity,
      markSlopeQuestArrivalEligible,
      completeSlopeQuestManually,
      isSameCompletedSlopeSpot,
      sanitizeCompletedSlopeSpots,
      dedupeCompletedSlopeSpots,
      saveCompletedSlopeSpot,
      isNearCompletedSlopeSpot,
      renderCompletedSlopeSpots,
      updateCompletedSlopeSpotsIfNeeded,
      completedSlopeSpotDedupeDistanceM: COMPLETED_SLOPE_SPOT_DEDUPE_DISTANCE_M,
      completedSlopeSpotRenderRadiusM: COMPLETED_SLOPE_SPOT_RENDER_RADIUS_M,
      setOrigin(o) { origin = o; },
      setLastReliablePosition(p) { lastReliablePosition = p; },
      getLastReliablePosition() { return lastReliablePosition; },
      setQuestLayer(layer) { questLayer = layer; },
      setCompletedSlopeSpotsLayer(layer) { completedSlopeSpotsLayer = layer; },
      getQuestMarker() { return questMarker; },
      setSlopeQuestCompletionInProgress(v) { slopeQuestCompletionInProgress = v; },
      getSlopeQuestCompletionInProgress() { return slopeQuestCompletionInProgress; },
      getCompletedSlopeSpots() { return completedSlopeSpots.map((s) => ({ ...s })); },
      setCompletedSlopeSpots(spots) { completedSlopeSpots = spots; },
      getCompletedSlopeSpotMarkerCount() { return completedSlopeSpotMarkersByCellId.size; },
      getElementById(id) { return document.getElementById(id); },
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
  const completedSpotMarkerCreations = [];
  const questLayerCalls = { clearLayers: 0 };
  const storageWrites = [];
  let vibrationCount = 0;

  function makeStubElement() {
    const attributes = new Map();
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
      hidden: false,
      appendChild: () => {},
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: (name) => attributes.get(name) ?? null,
      removeAttribute: (name) => attributes.delete(name),
      querySelector: () => null,
      addEventListener: () => {},
      focus: () => {},
      getElement: () => null,
    };
    return el;
  }

  // 同じidには常に同じスタブ要素を返す（production側とテスト側の両方が同じオブジェクトを見るように）。
  const elementsById = new Map();
  function getStubElement(id) {
    if (!elementsById.has(id)) elementsById.set(id, makeStubElement());
    return elementsById.get(id);
  }

  function makeFakeMarker(kind) {
    const markerElement = makeStubElement();
    const m = {
      _handlers: {},
      _kind: kind,
      _latlng: null,
      addTo: () => m,
      on(event, handler) {
        m._handlers[event] = handler;
        return m;
      },
      getElement: () => markerElement,
      getLatLng: () => m._latlng,
      __fireClick() {
        if (m._handlers.click) m._handlers.click({ latlng: { lat: 0, lng: 0 } });
      },
    };
    return m;
  }

  const fakeLeaflet = {
    divIcon: (opts) => ({ __divIcon: true, opts }),
    marker: (latlng, opts) => {
      const isCompletedSpot = opts && opts.pane === "completedSlopeSpotsPane";
      const entry = { lat: latlng[0], lng: latlng[1] };
      if (isCompletedSpot) completedSpotMarkerCreations.push(entry);
      else markerCreations.push(entry);
      const marker = makeFakeMarker(isCompletedSpot ? "completed" : "quest");
      marker._latlng = { lat: latlng[0], lng: latlng[1] };
      return marker;
    },
  };

  const questLayerStub = {
    clearLayers: () => {
      questLayerCalls.clearLayers += 1;
    },
  };
  const completedSlopeSpotsLayerStub = {
    addLayer: () => {},
    removeLayer: () => {},
  };

  const context = vm.createContext({
    AbortController,
    Date,
    Math,
    Number,
    Promise,
    URLSearchParams,
    JSON,
    Set,
    Array,
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
      getElementById: (id) => getStubElement(id),
      createElement: () => makeStubElement(),
    },
    fetch: (...args) => fetchImpl(...args),
    localStorage: {
      getItem: () => null,
      setItem: (key, value) => storageWrites.push({ key, value }),
    },
    navigator: {
      vibrate: () => {
        vibrationCount += 1;
      },
    },
    performance,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    window: {
      addEventListener: () => {},
      // 紙吹雪(spawnConfetti)はreduced-motionで即returnするため、
      // document.createElementの詳細な形まで作り込まずに済ませる。
      matchMedia: () => ({ matches: true }),
    },
    L: fakeLeaflet,
  });

  vm.runInContext(`${source}\n${exposeTestHooks}`, context, { filename: appPath });
  const hooks = context.__slopeQuestTestHooks;
  hooks.setQuestLayer(questLayerStub);
  hooks.setCompletedSlopeSpotsLayer(completedSlopeSpotsLayerStub);
  return {
    hooks,
    markerCreations,
    completedSpotMarkerCreations,
    questLayerCalls,
    storageWrites,
    getVibrationCount: () => vibrationCount,
  };
}

function activateAdventure(hooks) {
  hooks.setOrigin(TOKYO);
  hooks.adventureState.status = "active";
  hooks.setLastReliablePosition({ lat: TOKYO.lat0, lon: TOKYO.lon0 });
}

/* ---------- ensureQuest(): 生成条件・ロック（1冒険1候補・固定は変更しない） ---------- */

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
  assert.equal(hooks.adventureState.slopeQuest.arrivalEligible, false);
  assert.equal(hooks.adventureState.slopeQuest.completedThisSession, false);
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

/* ---------- 非同期応答の競合防止（変更しない） ---------- */

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

/* ---------- drawQuestMarker(): 保存済みの座標だけを描画する（変更しない） ---------- */

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

test("drawQuestMarker does nothing when there is no ready/nearby/completed candidate to show", () => {
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

test("drawQuestMarker also draws for the nearby status (candidate stays visible while the completion button is shown)", () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest.status = "nearby";
  hooks.adventureState.slopeQuest.lat = 35.7;
  hooks.adventureState.slopeQuest.lng = 139.8;
  hooks.adventureState.slopeQuest.cellId = "1_1";

  hooks.drawQuestMarker();

  assert.equal(markerCreations.length, 1);
});

test("drawQuestMarker updates an existing flag in place and never clears the quest layer for ready/nearby/completed state changes", () => {
  const { hooks, markerCreations, questLayerCalls } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest.status = "ready";
  hooks.adventureState.slopeQuest.lat = 35.7;
  hooks.adventureState.slopeQuest.lng = 139.8;
  hooks.adventureState.slopeQuest.cellId = "1_1";

  hooks.drawQuestMarker();
  const originalMarker = hooks.getQuestMarker();
  hooks.adventureState.slopeQuest.status = "nearby";
  hooks.drawQuestMarker();

  assert.equal(hooks.getQuestMarker(), originalMarker);
  assert.equal(markerCreations.length, 1);
  assert.equal(questLayerCalls.clearLayers, 0);
  assert.equal(originalMarker.getLatLng().lat, 35.7);
  assert.equal(originalMarker.getLatLng().lng, 139.8);
  assert.equal(originalMarker.getElement().classList.contains("is-nearby"), true);
  assert.equal(
    originalMarker.getElement().getAttribute("aria-label"),
    "勾配スポットの近くです",
  );
});

/* ---------- 接近判定: 「踏破ボタンを表示してよいか」だけを決める。自動達成しない ---------- */

test("isNearSlopeQuest uses the same same-cell rule and is true for ready/nearby, false otherwise", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest.status = "ready";
  hooks.adventureState.slopeQuest.cellId = "5_5";
  assert.equal(hooks.isNearSlopeQuest("5_5"), true);
  assert.equal(hooks.isNearSlopeQuest("9_9"), false);

  hooks.adventureState.slopeQuest.status = "completed";
  assert.equal(hooks.isNearSlopeQuest("5_5"), false); // completedはこの判定の対象外(既に確定済み)
});

test("GPS proximity sets arrivalEligible+status=nearby, keeps the same flag, shows the panel, and does not save/complete/vibrate", () => {
  const {
    hooks,
    markerCreations,
    questLayerCalls,
    storageWrites,
    getVibrationCount,
  } = loadProductionAdventure(makeSuccessFetch());
  hooks.setOrigin(TOKYO);
  hooks.adventureState.status = "active";
  hooks.adventureState.slopeQuest.status = "ready";
  hooks.adventureState.slopeQuest.lat = TOKYO.lat0;
  hooks.adventureState.slopeQuest.lng = TOKYO.lon0;
  const questCellId = hooks.cellKey(
    ...Object.values(hooks.cellIndex(TOKYO.lat0, TOKYO.lon0)),
  );
  hooks.adventureState.slopeQuest.cellId = questCellId;
  hooks.drawQuestMarker(); // 旗を用意しておく(is-nearbyクラス付与の対象にするため)
  const originalMarker = hooks.getQuestMarker();

  const entered = hooks.handleSlopeQuestProximity(
    questCellId,
    TOKYO.lat0,
    TOKYO.lon0,
  );

  assert.equal(entered, true);
  assert.equal(hooks.adventureState.slopeQuest.arrivalEligible, true);
  assert.equal(hooks.adventureState.slopeQuest.status, "nearby");
  assert.equal(hooks.adventureState.slopeQuest.completedThisSession, false);
  assert.equal(hooks.getCompletedSlopeSpots().length, 0); // 保存されていない
  assert.equal(storageWrites.length, 0);
  assert.equal(getVibrationCount(), 0);
  assert.equal(hooks.getElementById("slope-quest-action-panel").hidden, false);
  assert.equal(markerCreations.length, 1); // 再描画されていない(同じ旗のまま)
  assert.equal(hooks.getQuestMarker(), originalMarker);
  assert.equal(questLayerCalls.clearLayers, 0);
  assert.equal(originalMarker.getLatLng().lat, TOKYO.lat0);
  assert.equal(originalMarker.getLatLng().lng, TOKYO.lon0);
  assert.equal(originalMarker.getElement().classList.contains("is-nearby"), true);
  assert.equal(originalMarker.getElement().classList.contains("is-completed"), false);

  // 一度trueになったら、再度呼んでも状態は変わらない(冪等)
  const enteredAgain = hooks.handleSlopeQuestProximity(
    questCellId,
    TOKYO.lat0 + 1,
    TOKYO.lon0 + 1,
  );
  assert.equal(enteredAgain, false);
  assert.equal(hooks.adventureState.slopeQuest.status, "nearby");
});

test("a delayed elevation response is discarded after the quest has already moved to nearby, without clearing or moving the flag", async () => {
  let resolveFetch;
  const fetchImpl = (url, options) => {
    const body = JSON.parse(options.body);
    return new Promise((resolve) => {
      resolveFetch = () =>
        resolve({
          ok: true,
          json: async () => ({
            results: body.locations.map((loc, i) => ({ elevation: i * 10 })),
          }),
        });
    });
  };
  const { hooks, markerCreations, questLayerCalls } = loadProductionAdventure(fetchImpl);
  activateAdventure(hooks);

  const pending = hooks.ensureQuest();
  hooks.adventureState.slopeQuest.status = "nearby";
  hooks.adventureState.slopeQuest.lat = 35.7;
  hooks.adventureState.slopeQuest.lng = 139.8;
  hooks.adventureState.slopeQuest.cellId = "locked-cell";
  hooks.adventureState.slopeQuest.arrivalEligible = true;
  hooks.drawQuestMarker();
  const lockedMarker = hooks.getQuestMarker();

  resolveFetch();
  await pending;

  assert.equal(hooks.adventureState.slopeQuest.status, "nearby");
  assert.equal(hooks.adventureState.slopeQuest.cellId, "locked-cell");
  assert.equal(hooks.getQuestMarker(), lockedMarker);
  assert.equal(markerCreations.length, 1);
  assert.equal(questLayerCalls.clearLayers, 0);
});

/* ---------- 踏破ボタン: ユーザーが押したときだけ達成が確定する ---------- */

test("completeSlopeQuestManually does nothing unless active + arrivalEligible + not already completed", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());

  // 冒険中でない
  hooks.adventureState.status = "idle";
  hooks.adventureState.slopeQuest.arrivalEligible = true;
  hooks.completeSlopeQuestManually();
  assert.equal(hooks.adventureState.slopeQuest.completedThisSession, false);

  // 接近判定が成立していない(ボタンはそもそも表示されていないはずだが、直接呼ばれても無視する)
  hooks.adventureState.status = "active";
  hooks.adventureState.slopeQuest.arrivalEligible = false;
  hooks.completeSlopeQuestManually();
  assert.equal(hooks.adventureState.slopeQuest.completedThisSession, false);
});

test("completeSlopeQuestManually confirms completion exactly once, disables the button, hides the panel, and saves the spot", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  hooks.setOrigin(TOKYO);
  hooks.adventureState.status = "active";
  hooks.adventureState.slopeQuest.status = "nearby";
  hooks.adventureState.slopeQuest.arrivalEligible = true;
  hooks.adventureState.slopeQuest.lat = TOKYO.lat0;
  hooks.adventureState.slopeQuest.lng = TOKYO.lon0;
  hooks.adventureState.slopeQuest.cellId = "3_3";
  hooks.adventureState.slopeQuest.score = 4.2;

  hooks.completeSlopeQuestManually();

  assert.equal(hooks.adventureState.slopeQuest.completedThisSession, true);
  assert.equal(hooks.adventureState.slopeQuest.status, "completed");
  assert.equal(hooks.getElementById("complete-slope-quest-button").disabled, true);
  assert.equal(hooks.getElementById("slope-quest-action-panel").hidden, true);
  const saved = hooks.getCompletedSlopeSpots();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].cellId, "3_3");
  assert.equal(saved[0].lat, TOKYO.lat0);
  assert.equal(saved[0].lng, TOKYO.lon0);
  assert.ok(Number.isFinite(saved[0].completedAt));

  // 多重タップ: 2回目は何も変わらない(重複保存もされない)
  hooks.completeSlopeQuestManually();
  assert.equal(hooks.getCompletedSlopeSpots().length, 1);
});

/* ---------- 到達演出(triggerSlopeQuestCompletion): 押下後の演出のみを担当する ---------- */

test("triggerSlopeQuestCompletion plays the completion effect exactly once and never draws a new marker (flag is not removed)", () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.setOrigin(TOKYO);
  hooks.adventureState.slopeQuest.status = "completed";
  hooks.adventureState.slopeQuest.lat = 35.7;
  hooks.adventureState.slopeQuest.lng = 139.8;
  hooks.adventureState.slopeQuest.cellId = "1_1";
  hooks.adventureState.slopeQuest.score = 4.2;
  hooks.adventureState.slopeQuest.completedThisSession = true;

  hooks.triggerSlopeQuestCompletion({
    savedSpotId: "slope-1_1",
    savedSpotCellId: "1_1",
    persistedSuccessfully: true,
  });
  assert.equal(hooks.getSlopeQuestCompletionInProgress(), true); // 演出中(setTimeoutは発火させていない)
  assert.equal(markerCreations.length, 0); // 演出はマーカーを再生成しない(既存のDOM操作のみ)

  // 多重呼び出し対策: 演出中の2回目は無視される
  hooks.triggerSlopeQuestCompletion({ savedSpotId: "x", savedSpotCellId: "x", persistedSuccessfully: true });
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

/* ---------- 冒険終了: 未踏破なら消す、踏破済みなら残す ---------- */

test("retireSlopeQuestMarkerForEndOfAdventure clears the map layer, unless the arrival animation is still playing", () => {
  const { hooks, questLayerCalls } = loadProductionAdventure(makeSuccessFetch());

  hooks.setSlopeQuestCompletionInProgress(false);
  hooks.retireSlopeQuestMarkerForEndOfAdventure();
  assert.equal(questLayerCalls.clearLayers, 1);

  hooks.setSlopeQuestCompletionInProgress(true);
  hooks.retireSlopeQuestMarkerForEndOfAdventure();
  assert.equal(questLayerCalls.clearLayers, 1); // 演出中は消さない(既存の到達演出を優先する)
});

test("endAdventure keeps the flag on the map when this session's quest was completed, but retires it when it was not", () => {
  const successCase = loadProductionAdventure(makeSuccessFetch());
  activateAdventure(successCase.hooks);
  successCase.hooks.adventureState.startedAt = Date.now() - 1000;
  successCase.hooks.adventureState.slopeQuest.status = "completed";
  successCase.hooks.adventureState.slopeQuest.completedThisSession = true;
  successCase.hooks.endAdventure();
  assert.equal(successCase.questLayerCalls.clearLayers, 0); // 踏破済みなら消さない

  const notCompletedCase = loadProductionAdventure(makeSuccessFetch());
  activateAdventure(notCompletedCase.hooks);
  notCompletedCase.hooks.adventureState.startedAt = Date.now() - 1000;
  notCompletedCase.hooks.adventureState.slopeQuest.status = "nearby";
  notCompletedCase.hooks.adventureState.slopeQuest.completedThisSession = false;
  notCompletedCase.hooks.endAdventure();
  assert.equal(notCompletedCase.questLayerCalls.clearLayers, 1); // 未踏破なら消す
});

/* ---------- リセット: 新しい冒険開始時だけ ---------- */

test("selectAdventurePreset resets slopeQuest (including arrivalEligible/completedThisSession) to idle for a new adventure", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest = {
    status: "completed",
    lat: 1,
    lng: 2,
    cellId: "0_0",
    score: 3,
    requestId: "abc",
    arrivalEligible: true,
    completedThisSession: true,
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
  assert.equal(q.arrivalEligible, false);
  assert.equal(q.completedThisSession, false);
});

test("selectAdventurePreset never touches the permanently-saved completedSlopeSpots", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  hooks.setCompletedSlopeSpots([
    { id: "slope-1_1", lat: 1, lng: 2, cellId: "1_1", completedAt: 100 },
  ]);

  hooks.selectAdventurePreset("short");

  assert.equal(hooks.getCompletedSlopeSpots().length, 1);
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
    arrivalEligible: true,
    completedThisSession: true,
  };

  hooks.resetAdventureStateKeepHistory();

  assert.equal(hooks.adventureState.slopeQuest.status, "completed");
  assert.equal(hooks.adventureState.slopeQuest.completedThisSession, true);
});

/* ---------- 踏破済み地点の恒久保存: 重複防止 ---------- */

test("isSameCompletedSlopeSpot matches on identical cellId, or within the dedupe distance", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  const a = { lat: TOKYO.lat0, lng: TOKYO.lon0, cellId: "1_1" };
  const sameCellDifferentCoords = { lat: TOKYO.lat0 + 0.5, lng: TOKYO.lon0 + 0.5, cellId: "1_1" };
  assert.equal(hooks.isSameCompletedSlopeSpot(a, sameCellDifferentCoords), true);

  const closeButDifferentCell = { lat: TOKYO.lat0 + 0.0005, lng: TOKYO.lon0, cellId: "1_2" };
  assert.equal(hooks.isSameCompletedSlopeSpot(a, closeButDifferentCell), true); // 距離が近い

  const farAway = { lat: TOKYO.lat0 + 0.05, lng: TOKYO.lon0 + 0.05, cellId: "9_9" };
  assert.equal(hooks.isSameCompletedSlopeSpot(a, farAway), false);
});

test("saveCompletedSlopeSpot does not create a duplicate entry for the same spot", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  const quest = { lat: TOKYO.lat0, lng: TOKYO.lon0, cellId: "4_4", score: 3 };

  hooks.saveCompletedSlopeSpot(quest);
  hooks.saveCompletedSlopeSpot(quest);
  hooks.saveCompletedSlopeSpot({ ...quest, lat: quest.lat + 0.0001 }); // ほぼ同じ地点

  assert.equal(hooks.getCompletedSlopeSpots().length, 1);
});

test("sanitizeCompletedSlopeSpots drops malformed entries without throwing (corrupt localStorage does not stop the app)", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  const raw = [
    { lat: 35.1, lng: 139.1, cellId: "1_1", completedAt: 100 }, // valid
    { lat: "not-a-number", lng: 139.1, cellId: "2_2" }, // invalid lat
    { lat: 35.1, lng: 139.1 }, // no cellId/id
    null,
    "garbage",
    42,
    { lat: 35.2, lng: 139.2, id: "x", completedAt: "not-a-number" }, // invalid completedAt
  ];
  const cleaned = hooks.sanitizeCompletedSlopeSpots(raw);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].cellId, "1_1");
});

test("sanitizeCompletedSlopeSpots returns an empty array for non-array input (e.g. corrupt JSON parse fallback)", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  // VM越しの配列はプロトタイプが異なるためdeepStrictEqualではなくlengthで比較する。
  assert.equal(hooks.sanitizeCompletedSlopeSpots(null).length, 0);
  assert.equal(hooks.sanitizeCompletedSlopeSpots(undefined).length, 0);
  assert.equal(hooks.sanitizeCompletedSlopeSpots({}).length, 0);
});

test("dedupeCompletedSlopeSpots collapses duplicates found in stored data (e.g. from manual edits or past bugs)", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  const spots = [
    { id: "a", lat: 35.1, lng: 139.1, cellId: "1_1", completedAt: 100 },
    { id: "b", lat: 35.1, lng: 139.1, cellId: "1_1", completedAt: 200 },
    { id: "c", lat: 36.1, lng: 140.1, cellId: "9_9", completedAt: 300 },
  ];
  const result = hooks.dedupeCompletedSlopeSpots(spots);
  assert.equal(result.length, 2);
});

/* ---------- 新しい候補選定からの踏破済み地点の除外（後段フィルター。順位計算は変更しない） ---------- */

test("generateQuest (via ensureQuest) excludes cells that match a completed spot's cellId or distance, without touching the ranking formula", async () => {
  const { hooks, markerCreations } = loadProductionAdventure(makeSuccessFetch());
  activateAdventure(hooks);
  const { ix, iy } = hooks.cellIndex(TOKYO.lat0, TOKYO.lon0);
  // 標高が最も高くなる(=最良候補になる)セルをあらかじめ踏破済みとして登録しておく。
  // generateQuest()自体のランキング式(gradientPct計算・ソート)は一切変更していないため、
  // 「除外していなければ選ばれていたはずの最良候補」がちゃんと除外されることを確認する。
  const bestCandidateCellId = hooks.cellKey(ix, iy + 4); // dx=0,dy=4は候補ループの3番目に相当(既存のmakeSuccessFetchのi===3と対応)
  hooks.setCompletedSlopeSpots([
    { id: `slope-${bestCandidateCellId}`, lat: 0, lng: 0, cellId: bestCandidateCellId, completedAt: 1 },
  ]);

  await hooks.ensureQuest();

  assert.equal(hooks.adventureState.slopeQuest.status, "ready");
  assert.notEqual(hooks.adventureState.slopeQuest.cellId, bestCandidateCellId);
  assert.equal(markerCreations.length, 1);
});

test("isNearCompletedSlopeSpot reflects the same same-cellId-or-distance rule used for saving", () => {
  const { hooks } = loadProductionAdventure(makeSuccessFetch());
  hooks.setCompletedSlopeSpots([
    { id: "slope-1_1", lat: TOKYO.lat0, lng: TOKYO.lon0, cellId: "1_1", completedAt: 1 },
  ]);
  assert.equal(hooks.isNearCompletedSlopeSpot(TOKYO.lat0, TOKYO.lon0, "1_1"), true);
  assert.equal(hooks.isNearCompletedSlopeSpot(35.9, 140.9, "9_9"), false);
});

/* ---------- 過去に踏破済みの旗: 今回のクエスト旗とは別レイヤーで、現在地周辺だけ描画する ---------- */

test("renderCompletedSlopeSpots only draws spots within the render radius, on the dedicated layer/pane", () => {
  const { hooks, completedSpotMarkerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.setCompletedSlopeSpots([
    { id: "near", lat: TOKYO.lat0 + 0.001, lng: TOKYO.lon0 + 0.001, cellId: "1_1", completedAt: 1 },
    { id: "far", lat: TOKYO.lat0 + 5, lng: TOKYO.lon0 + 5, cellId: "999_999", completedAt: 2 },
  ]);

  hooks.renderCompletedSlopeSpots(TOKYO.lat0, TOKYO.lon0);

  assert.equal(completedSpotMarkerCreations.length, 1);
  assert.equal(hooks.getCompletedSlopeSpotMarkerCount(), 1);
});

test("renderCompletedSlopeSpots excludes this session's own candidate (questLayer already shows it, avoiding a duplicate flag)", () => {
  const { hooks, completedSpotMarkerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.adventureState.slopeQuest.status = "ready";
  hooks.adventureState.slopeQuest.cellId = "own-cell";
  hooks.setCompletedSlopeSpots([
    { id: "own", lat: TOKYO.lat0, lng: TOKYO.lon0, cellId: "own-cell", completedAt: 1 },
    { id: "other", lat: TOKYO.lat0 + 0.001, lng: TOKYO.lon0 + 0.001, cellId: "other-cell", completedAt: 2 },
  ]);

  hooks.renderCompletedSlopeSpots(TOKYO.lat0, TOKYO.lon0);

  assert.equal(completedSpotMarkerCreations.length, 1);
  assert.equal(completedSpotMarkerCreations[0].lat, TOKYO.lat0 + 0.001);
});

test("updateCompletedSlopeSpotsIfNeeded only recomputes when the center cell actually changes (debounced like fog)", () => {
  const { hooks, completedSpotMarkerCreations } = loadProductionAdventure(makeSuccessFetch());
  hooks.setOrigin(TOKYO);
  hooks.setCompletedSlopeSpots([
    { id: "near", lat: TOKYO.lat0, lng: TOKYO.lon0, cellId: "1_1", completedAt: 1 },
  ]);

  hooks.updateCompletedSlopeSpotsIfNeeded(TOKYO.lat0, TOKYO.lon0);
  assert.equal(completedSpotMarkerCreations.length, 1);

  // 同じセル内での移動: 再計算されない(マーカーが再生成されない)
  hooks.updateCompletedSlopeSpotsIfNeeded(TOKYO.lat0 + 0.00001, TOKYO.lon0);
  assert.equal(completedSpotMarkerCreations.length, 1);
});

/* ---------- buildSlopeQuestArrivalDebugContext（変更しない） ---------- */

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

test("handlePosition delegates to the proximity-only transition and never invokes completion directly", () => {
  const fn = appSource.match(/function handlePosition\(pos\)[\s\S]*?\n}\n/)[0];
  assert.equal(fn.includes("handleSlopeQuestProximity(key, lat, lon)"), true);
  assert.equal(fn.includes("triggerSlopeQuestCompletion"), false);
  assert.equal(fn.includes("completeSlopeQuestManually"), false);
});

test("completeSlopeQuestManually is the only call site of triggerSlopeQuestCompletion (completion is button-driven only)", () => {
  const callSites = appSource.match(/triggerSlopeQuestCompletion\(/g) || [];
  // 定義自体(function宣言)を含めて2箇所だけ: 関数定義 + completeSlopeQuestManually内の呼び出し
  assert.equal(callSites.length, 2);
  const fn = appSource.match(/function completeSlopeQuestManually\(\)[\s\S]*?\n}\n/)[0];
  assert.equal(fn.includes("triggerSlopeQuestCompletion(saveResult)"), true);
});

test("the removed auto-completion behaviors are gone: no arrival-triggered confetti/vibration/message, no auto-remove-after-hold timer", () => {
  assert.equal(appSource.includes("SLOPE_QUEST_ARRIVAL_MESSAGE"), false);
  assert.equal(appSource.includes("holdCompletedMs"), false);
  assert.equal(appSource.includes("removeFadeMs"), false);
  assert.equal(appSource.includes("function removeSlopeQuestMarker"), false);
});

test("nearby CSS is visual emphasis only and never hides the flag", () => {
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
  const nearbyBlocks = css.match(/\.slope-quest-marker\.is-nearby[^}]*}/g) || [];
  assert.ok(nearbyBlocks.length > 0);
  const nearbyCss = nearbyBlocks.join("\n");
  assert.equal(/display\s*:\s*none/.test(nearbyCss), false);
  assert.equal(/visibility\s*:\s*hidden/.test(nearbyCss), false);
  assert.equal(/opacity\s*:\s*0(?:\.0+)?\s*[;}]/.test(nearbyCss), false);
  assert.equal(/scale\(0\)/.test(nearbyCss), false);
});

test("normal quest rendering never clears the flag layer; clearing remains limited to adventure end and new-adventure reset", () => {
  const clearCalls = appSource.match(/questLayer\.clearLayers\(\)/g) || [];
  assert.equal(clearCalls.length, 2);
  const drawFn = appSource.match(/function drawQuestMarker\(\)[\s\S]*?\n}\n/)[0];
  assert.equal(drawFn.includes("questLayer.clearLayers()"), false);
});

test("state review diagnostics are gated by DEBUG_SLOPE_QUEST and expose the requested transition fields", () => {
  const fn = appSource.match(/function logSlopeQuestStateReview\([\s\S]*?\n}\n/)[0];
  assert.equal(fn.includes("if (!DEBUG_SLOPE_QUEST) return"), true);
  for (const field of [
    "completionButtonPressed",
    "markArrivalEligibleCalled",
    "completeSlopeQuestManuallyCalled",
    "triggerSlopeQuestCompletionCalled",
    "saveCompletedSlopeSpotCalled",
    "questLayerCleared",
    "questMarkerExists",
    "resultBadgeVisible",
    "completedSlopeSpotCount",
  ]) {
    assert.equal(fn.includes(field), true, `missing debug field: ${field}`);
  }
});

test("the old am_quest localStorage key is no longer defined as an active STORAGE_KEYS entry, and the free-floating quest variable is gone", () => {
  assert.equal(appSource.includes('quest: "am_quest"'), false);
  assert.equal(/(^|[^.\w])quest\s*=\s*store\.get/.test(appSource), false);
  assert.equal(appSource.includes("STORAGE_KEYS.quest"), false);
});

test("am_completed_slope_spots is registered as an active STORAGE_KEYS entry", () => {
  assert.equal(appSource.includes('completedSlopeSpots: "am_completed_slope_spots"'), true);
});

test("endAdventure hides the action panel and conditionally retires the slope-quest marker", () => {
  const fn = appSource.match(/function endAdventure\(\)[\s\S]*?\n}\n/)[0];
  assert.equal(fn.includes("hideSlopeQuestActionPanel()"), true);
  assert.equal(fn.includes("retireSlopeQuestMarkerForEndOfAdventure()"), true);
  assert.equal(fn.includes("completedThisSession"), true);
});

test("service worker cache version was bumped for this fix", () => {
  const sw = readFileSync(join(__dirname, "..", "sw.js"), "utf8");
  assert.equal(sw.includes('const CACHE_NAME = "machi-boken-v31"'), true);
  assert.equal(appSource.includes('addEventListener("controllerchange"'), true);
  const reloadFn = appSource.match(
    /function reloadForServiceWorkerUpdateIfSafe\(\)[\s\S]*?\n}\n/,
  )[0];
  assert.equal(reloadFn.includes('adventureState.status !== "idle"'), true);
  const statusFn = appSource.match(/function setAdventureStatus\([\s\S]*?\n}\n/)[0];
  assert.equal(statusFn.includes("reloadForServiceWorkerUpdateIfSafe()"), true);
});
