const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadProductionAdventure() {
  const appPath = join(__dirname, "..", "app.js");
  const source = readFileSync(appPath, "utf8");
  const scheduled = [];
  let nextTimerId = 1;
  const exposeTestHooks = `
    globalThis.__adventureTestHooks = {
      adventureState,
      adventurePresets: ADVENTURE_PRESETS,
      adventureExtensionMs: ADVENTURE_EXTENSION_MS,
      timeGoalCompletionEffect: TIME_GOAL_COMPLETION_EFFECT,
      discoveryMessageTiming: DISCOVERY_MESSAGE_TIMING,
      milestoneMessageTiming: MILESTONE_MESSAGE_TIMING,
      cellFogConfig: CELL_FOG_CONFIG,
      adventureGoalMessage: ADVENTURE_GOAL_MESSAGE,
      adventureGoalSubMessage: ADVENTURE_GOAL_SUB_MESSAGE,
      adventureExtensionMessage: ADVENTURE_EXTENSION_MESSAGE,
      adventureEndMessages: ADVENTURE_END_MESSAGES,
      debugTimeGoal: DEBUG_TIME_GOAL,
      shouldTriggerAdventureGoal,
      getElapsedAdventureMs,
      getTimeGoalPresentationDelay,
      getDiscoveryMessageTiming,
      getDiscoveryPhaseDurationMs,
      getAdventureProgressText,
      registerAdventureVisitedCell,
      registerAdventureDiscovery,
      registerAdventureDistance,
      triggerAdventureTimeGoal,
      extendAdventureFiveMinutes,
      getAdventureCompletionData,
      getAdventureEndMessage,
      discoveryNotificationState,
      queueDiscoveryNotification,
      resetAdventureStateKeepHistory,
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
    clearTimeout: (timerId) => {
      const timer = scheduled.find((item) => item.id === timerId);
      if (timer) timer.cleared = true;
    },
    console,
    document: {
      activeElement: null,
      getElementById: () => null,
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
    setInterval: () => 1,
    setTimeout: (callback, delayMs) => {
      const id = nextTimerId++;
      scheduled.push({ id, callback, delayMs, cleared: false });
      return id;
    },
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false }),
    },
  });

  vm.runInContext(`${source}\n${exposeTestHooks}`, context, { filename: appPath });
  return { hooks: context.__adventureTestHooks, scheduled };
}

test("course presets use 5, 15, and 30 minute goals without cell targets", () => {
  const { hooks } = loadProductionAdventure();
  assert.equal(hooks.adventurePresets.short.label, "ちょい冒険");
  assert.equal(hooks.adventurePresets.short.targetDurationMs, 5 * 60 * 1000);
  assert.equal(hooks.adventurePresets.normal.label, "いつもの冒険");
  assert.equal(hooks.adventurePresets.normal.targetDurationMs, 15 * 60 * 1000);
  assert.equal(hooks.adventurePresets.long.label, "じっくり冒険");
  assert.equal(hooks.adventurePresets.long.targetDurationMs, 30 * 60 * 1000);
  for (const preset of Object.values(hooks.adventurePresets)) {
    assert.equal(Object.hasOwn(preset, "targetCells"), false);
  }
});

test("time goal check triggers at the duration boundary only once", () => {
  const { hooks } = loadProductionAdventure();
  assert.equal(
    hooks.shouldTriggerAdventureGoal({
      elapsedAdventureMs: 5 * 60 * 1000 - 1,
      targetDurationMs: 5 * 60 * 1000,
      goalReached: false,
    }),
    false,
  );
  assert.equal(
    hooks.shouldTriggerAdventureGoal({
      elapsedAdventureMs: 5 * 60 * 1000,
      targetDurationMs: 5 * 60 * 1000,
      goalReached: false,
    }),
    true,
  );
  assert.equal(
    hooks.shouldTriggerAdventureGoal({
      elapsedAdventureMs: 6 * 60 * 1000,
      targetDurationMs: 5 * 60 * 1000,
      goalReached: true,
    }),
    false,
  );
});

test("elapsed time is derived from timestamps, including a background gap", () => {
  const { hooks } = loadProductionAdventure();
  assert.equal(hooks.getElapsedAdventureMs(1000, 301000), 5 * 60 * 1000);
  assert.equal(hooks.getElapsedAdventureMs(301000, 1000), 0);
});

test("HUD shows elapsed time and unique visited cells without a denominator", () => {
  const { hooks } = loadProductionAdventure();
  const text = hooks.getAdventureProgressText({
    elapsedAdventureMs: 8 * 60 * 1000,
    sessionVisitedCellCount: 4,
  });
  assert.equal(text, "冒険中 8分 ・ 歩いた場所 4");
  assert.equal(text.includes("/"), false);
});

test("start cell is excluded until the session leaves and returns", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    direction: null,
    startCellId: "0_0",
    hasLeftStartCell: false,
    sessionVisitedCellIds: new Set(),
    sessionVisitedCells: [],
  });

  assert.equal(hooks.registerAdventureVisitedCell(0, 0), false);
  assert.equal(hooks.registerAdventureVisitedCell(1, 0), true);
  assert.equal(hooks.registerAdventureVisitedCell(0, 0), true);
  assert.equal(hooks.registerAdventureVisitedCell(1, 0), false);
  assert.equal(hooks.adventureState.sessionVisitedCellIds.size, 2);
});

test("visited cells and newly discovered cells are counted separately", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    direction: null,
    startCellId: "0_0",
    hasLeftStartCell: false,
    sessionVisitedCellIds: new Set(),
    sessionVisitedCells: [],
    sessionDiscoveredCellIds: new Set(),
    sessionDiscoveredCells: [],
  });

  hooks.registerAdventureVisitedCell(1, 0);
  hooks.registerAdventureVisitedCell(2, 0);
  assert.equal(hooks.registerAdventureDiscovery(2, 0), true);
  assert.equal(hooks.registerAdventureDiscovery(2, 0), false);
  assert.equal(hooks.adventureState.sessionVisitedCellIds.size, 2);
  assert.equal(hooks.adventureState.sessionDiscoveredCellIds.size, 1);
});

test("time completion sets flags synchronously and schedules once", () => {
  const { hooks, scheduled } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    preset: "short",
    elapsedAdventureMs: 5 * 60 * 1000,
    targetDurationMs: 5 * 60 * 1000,
    goalReached: false,
    initialGoalReached: false,
    discoveryFeedbackUntil: 0,
    sessionId: 7,
  });

  assert.equal(hooks.triggerAdventureTimeGoal(), true);
  assert.equal(hooks.adventureState.goalReached, true);
  assert.equal(hooks.adventureState.initialGoalReached, true);
  assert.equal(scheduled.length, 1);
  assert.equal(hooks.triggerAdventureTimeGoal(), false);
  assert.equal(scheduled.length, 1);
});

test("discovery timing keeps both messages readable and delays the time goal", () => {
  const { hooks } = loadProductionAdventure();
  const now = Date.now();
  const timing = hooks.getDiscoveryMessageTiming(false);
  const reducedTiming = hooks.getDiscoveryMessageTiming(true);
  const firstMs = hooks.getDiscoveryPhaseDurationMs(
    timing.firstFadeInMs,
    timing.firstHoldMs,
    timing.firstFadeOutMs,
  );
  const secondMs = hooks.getDiscoveryPhaseDurationMs(
    timing.secondFadeInMs,
    timing.secondHoldMs,
    timing.secondFadeOutMs,
  );

  assert.equal(firstMs, 1830);
  assert.equal(secondMs, 1580);
  assert.equal(firstMs + secondMs, 3410);
  assert.equal(reducedTiming.firstHoldMs, 1500);
  assert.equal(reducedTiming.secondHoldMs, 1250);
  assert.ok(reducedTiming.firstFadeInMs < timing.firstFadeInMs);
  assert.ok(
    hooks.getDiscoveryPhaseDurationMs(
      reducedTiming.firstFadeInMs,
      reducedTiming.firstHoldMs,
      reducedTiming.firstFadeOutMs,
    ) +
      hooks.getDiscoveryPhaseDurationMs(
        reducedTiming.secondFadeInMs,
        reducedTiming.secondHoldMs,
        reducedTiming.secondFadeOutMs,
      ) >=
      3000,
  );
  assert.ok(hooks.cellFogConfig.revealDurationMs > 0);

  hooks.adventureState.discoveryFeedbackUntil = now + firstMs + secondMs;
  assert.ok(hooks.getTimeGoalPresentationDelay(now) >= firstMs + secondMs);
});

test("continuous discoveries merge into the latest session count without adding timers", () => {
  const { hooks, scheduled } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    sessionId: 12,
    discoveryFeedbackUntil: 0,
  });

  hooks.queueDiscoveryNotification({
    sessionId: 12,
    sessionDiscoveryCount: 1,
    milestoneThreshold: null,
  });
  assert.equal(hooks.discoveryNotificationState.phase, "waiting");
  assert.equal(hooks.discoveryNotificationState.latestCount, 1);
  assert.equal(scheduled.filter((item) => !item.cleared).length, 1);

  hooks.queueDiscoveryNotification({
    sessionId: 12,
    sessionDiscoveryCount: 2,
    milestoneThreshold: null,
  });
  assert.equal(hooks.discoveryNotificationState.phase, "waiting");
  assert.equal(hooks.discoveryNotificationState.latestCount, 2);
  assert.equal(scheduled.filter((item) => !item.cleared).length, 1);
});

test("normal discovery advances from fog wait to first message and then latest count", () => {
  const { hooks, scheduled } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    sessionId: 13,
    discoveryFeedbackUntil: 0,
  });
  const runNextTimer = () => {
    const timer = scheduled.find((item) => !item.cleared);
    assert.ok(timer, "expected a pending discovery timer");
    timer.cleared = true;
    timer.callback();
    return timer.delayMs;
  };

  hooks.queueDiscoveryNotification({
    sessionId: 13,
    sessionDiscoveryCount: 1,
    milestoneThreshold: null,
  });
  assert.equal(hooks.discoveryNotificationState.phase, "waiting");
  assert.equal(runNextTimer(), 850);
  assert.equal(hooks.discoveryNotificationState.phase, "first");
  assert.equal(runNextTimer(), 1650);
  assert.equal(runNextTimer(), 180);
  assert.equal(hooks.discoveryNotificationState.phase, "second");
  assert.equal(hooks.discoveryNotificationState.latestCount, 1);
  assert.equal(runNextTimer(), 1400);
  assert.equal(runNextTimer(), 180);
  assert.equal(hooks.discoveryNotificationState.phase, "idle");
});

test("five minute extension preserves session results and only moves the time goal", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    targetDurationMs: 5 * 60 * 1000,
    goalReached: true,
    initialGoalReached: true,
    extensionCount: 0,
    sessionVisitedCellIds: new Set(["1_0", "2_0"]),
    sessionDiscoveredCellIds: new Set(["2_0"]),
    distanceMeters: 420,
  });

  hooks.extendAdventureFiveMinutes();
  assert.equal(hooks.adventureState.targetDurationMs, 10 * 60 * 1000);
  assert.equal(hooks.adventureState.extensionCount, 1);
  assert.equal(hooks.adventureState.goalReached, false);
  assert.equal(hooks.adventureState.initialGoalReached, true);
  assert.equal(hooks.adventureState.sessionVisitedCellIds.size, 2);
  assert.equal(hooks.adventureState.sessionDiscoveredCellIds.size, 1);
  assert.equal(hooks.adventureState.distanceMeters, 420);
});

test("distance accepts plausible movement and rejects a GPS jump", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    distanceMeters: 0,
    lastDistancePoint: { lat: 35, lon: 139, timestamp: 1000 },
  });

  assert.equal(hooks.registerAdventureDistance(35.0001, 139, 11000), true);
  const acceptedDistance = hooks.adventureState.distanceMeters;
  assert.ok(acceptedDistance > 3);
  assert.equal(hooks.registerAdventureDistance(36, 140, 12000), false);
  assert.equal(hooks.adventureState.distanceMeters, acceptedDistance);
});

test("completion data contains time, distance, cells, discoveries, and course metadata", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    preset: "normal",
    elapsedAdventureMs: 18 * 60 * 1000,
    distanceMeters: 1200,
    sessionVisitedCellIds: new Set(["1_0", "2_0", "3_0"]),
    sessionDiscoveredCellIds: new Set(["3_0"]),
    startedAt: 1000,
    endedAt: 1081000,
    extensionCount: 1,
    initialGoalReached: true,
    direction: { sector: 0, label: "北", bearingDeg: 0 },
  });

  const data = hooks.getAdventureCompletionData();
  assert.deepEqual(
    JSON.parse(JSON.stringify(data)),
    {
      actualDurationMs: 18 * 60 * 1000,
      distanceMeters: 1200,
      visitedCellCount: 3,
      discoveredCellCount: 1,
      startedAt: 1000,
      endedAt: 1081000,
      selectedPresetMinutes: 15,
      extensionCount: 1,
      initialGoalReached: true,
      direction: { sector: 0, label: "北", bearingDeg: 0 },
    },
  );
});

test("time goal uses one light effect and production debug logging is disabled", () => {
  const { hooks } = loadProductionAdventure();
  assert.deepEqual(
    JSON.parse(JSON.stringify(hooks.timeGoalCompletionEffect)),
    { intensity: "small", durationMs: 1000 },
  );
  assert.equal(hooks.debugTimeGoal, false);
  assert.equal(hooks.adventureGoalMessage, "今日の冒険を達成しました！");
  assert.equal(hooks.adventureGoalSubMessage, "このまま続けても大丈夫。");
  assert.equal(hooks.adventureExtensionMessage, "追加の5分も歩きました。");
});

test("ending early uses neutral, non-failure copy", () => {
  const { hooks } = loadProductionAdventure();
  const copy = Object.values(hooks.adventureEndMessages).join(" ");
  for (const forbidden of [
    "失敗",
    "未達成",
    "達成できませんでした",
    "あと少し",
    "再挑戦",
    "ノルマ不足",
  ]) {
    assert.equal(copy.includes(forbidden), false);
  }
});

test("completion message depends only on whether this session found a new place", () => {
  const { hooks } = loadProductionAdventure();
  assert.equal(hooks.getAdventureEndMessage(0), "今日の寄り道も、正解でした。");
  assert.equal(
    hooks.getAdventureEndMessage(1),
    "またこの街が、少し広くなりました。",
  );
});

test("session reset clears temporary time and cell state", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    goalReached: true,
    initialGoalReached: true,
    extensionCount: 2,
    elapsedAdventureMs: 1234,
    sessionVisitedCellIds: new Set(["1_0"]),
    sessionDiscoveredCellIds: new Set(["1_0"]),
  });
  hooks.resetAdventureStateKeepHistory();
  assert.equal(hooks.adventureState.goalReached, false);
  assert.equal(hooks.adventureState.initialGoalReached, false);
  assert.equal(hooks.adventureState.extensionCount, 0);
  assert.equal(hooks.adventureState.elapsedAdventureMs, 0);
  assert.equal(hooks.adventureState.sessionVisitedCellIds.size, 0);
  assert.equal(hooks.adventureState.sessionDiscoveredCellIds.size, 0);
});

test("completion HTML exposes only time, distance, and new-place results", () => {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  for (const required of [
    'id="adventure-hud-progress"',
    'id="time-goal-panel"',
    'id="btn-time-goal-end"',
    'id="btn-time-goal-extend"',
    'id="completion-elapsed"',
    'id="completion-distance"',
    'id="completion-discovered-cells"',
    'id="discovery-message"',
    "今日の冒険、おつかれさま！",
    "新しい場所",
    "冒険を終える",
    "あと5分だけ続ける",
  ]) {
    assert.equal(html.includes(required), true, `missing ${required}`);
  }
  for (const removed of [
    "completion-session-cells",
    "completion-total-cells",
    "completion-visited-cells",
    "completion-course",
    "completion-extensions",
    "completion-direction",
  ]) {
    assert.equal(html.includes(removed), false, `obsolete ${removed}`);
  }

  const completionStats = html.match(
    /<ul class="completion-stats">([\s\S]*?)<\/ul>/,
  );
  assert.ok(completionStats);
  assert.equal((completionStats[1].match(/<li>/g) || []).length, 3);
});

test("discovery notification cannot intercept map controls", () => {
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
  const block = css.match(/#discovery-message \{([\s\S]*?)\n\}/);
  assert.ok(block);
  assert.equal(block[1].includes("pointer-events: none"), true);
  assert.equal(css.includes("#discovery-message.discovery-primary"), true);
  assert.equal(css.includes("#discovery-message.discovery-secondary"), true);
});

test("service worker cache version includes the updated app shell", () => {
  const sw = readFileSync(join(__dirname, "..", "sw.js"), "utf8");
  assert.equal(sw.includes('const CACHE_NAME = "machi-boken-v22"'), true);
  for (const asset of ["./index.html", "./styles.css", "./app.js"]) {
    assert.equal(sw.includes(`"${asset}"`), true, `missing ${asset}`);
  }
});
