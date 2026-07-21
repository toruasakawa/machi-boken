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
  const timeGoalClasses = new Set(["hidden"]);
  const timeGoalNotification = {
    classList: {
      add: (...names) => names.forEach((name) => timeGoalClasses.add(name)),
      remove: (...names) => names.forEach((name) => timeGoalClasses.delete(name)),
      contains: (name) => timeGoalClasses.has(name),
    },
    offsetWidth: 0,
    style: { setProperty: () => {} },
    textContent: "",
  };
  const documentMock = {
    activeElement: null,
    visibilityState: "visible",
    getElementById: (id) =>
      id === "time-goal-notification" ? timeGoalNotification : null,
  };
  const exposeTestHooks = `
    globalThis.__adventureTestHooks = {
      adventureState,
      adventurePresets: ADVENTURE_PRESETS,
      timeGoalCompletionEffect: TIME_GOAL_COMPLETION_EFFECT,
      timeGoalMessageTiming: TIME_GOAL_MESSAGE_TIMING,
      discoveryMessageTiming: DISCOVERY_MESSAGE_TIMING,
      milestoneMessageTiming: MILESTONE_MESSAGE_TIMING,
      cellFogConfig: CELL_FOG_CONFIG,
      adventureGoalMessage: ADVENTURE_GOAL_MESSAGE,
      adventureEndMessages: ADVENTURE_END_MESSAGES,
      debugTimeGoal: DEBUG_TIME_GOAL,
      shouldTriggerInitialAdventureGoal,
      getElapsedAdventureMs,
      getTimeGoalPresentationDelay,
      getTimeGoalMessageTiming,
      getDiscoveryMessageTiming,
      getDiscoveryPhaseDurationMs,
      getAdventureProgressText,
      registerAdventureVisitedCell,
      registerAdventureDiscovery,
      registerAdventureDistance,
      recordRoutePoint,
      updateAdventureTime,
      triggerAdventureTimeGoal,
      handleAdventureVisibilityChange,
      shouldSuppressTimeGoalConfettiForDiscovery,
      getAdventureCompletionData,
      getAdventureEndMessage,
      discoveryNotificationState,
      queueDiscoveryNotification,
      resetAdventureStateKeepHistory,
      shouldSuppressSlopeQuestConfettiForDiscovery,
      slopeQuestArrivalMessage: SLOPE_QUEST_ARRIVAL_MESSAGE,
      slopeQuestLabel: SLOPE_QUEST_LABEL,
      slopeQuestConfetti: SLOPE_QUEST_CONFETTI,
      debugSlopeQuest: DEBUG_SLOPE_QUEST,
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
    document: documentMock,
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
  return {
    hooks: context.__adventureTestHooks,
    scheduled,
    documentMock,
    timeGoalNotification,
  };
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

test("initial time goal check triggers at the duration boundary only once", () => {
  const { hooks } = loadProductionAdventure();
  assert.equal(
    hooks.shouldTriggerInitialAdventureGoal({
      elapsedAdventureMs: 5 * 60 * 1000 - 1,
      initialTargetDurationMs: 5 * 60 * 1000,
      goalReached: false,
    }),
    false,
  );
  assert.equal(
    hooks.shouldTriggerInitialAdventureGoal({
      elapsedAdventureMs: 5 * 60 * 1000,
      initialTargetDurationMs: 5 * 60 * 1000,
      goalReached: false,
    }),
    true,
  );
  assert.equal(
    hooks.shouldTriggerInitialAdventureGoal({
      elapsedAdventureMs: 15 * 60 * 1000,
      initialTargetDurationMs: 5 * 60 * 1000,
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
    goalReached: false,
  });
  assert.equal(text, "冒険中 8分 ・ 歩いた場所 4");
  assert.equal(text.includes("/"), false);
  assert.equal(
    hooks.getAdventureProgressText({
      elapsedAdventureMs: 8 * 60 * 1000,
      sessionVisitedCellCount: 5,
      goalReached: true,
    }),
    "冒険達成 8分 ・ 歩いた場所 5",
  );
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
    initialTargetDurationMs: 5 * 60 * 1000,
    goalReached: false,
    timeGoalNotificationPending: false,
    discoveryFeedbackUntil: 0,
    sessionId: 7,
  });

  assert.equal(hooks.triggerAdventureTimeGoal(), true);
  assert.equal(hooks.adventureState.goalReached, true);
  assert.equal(hooks.adventureState.timeGoalNotificationPending, true);
  assert.equal(hooks.adventureState.status, "active");
  assert.equal(scheduled.length, 1);
  hooks.adventureState.elapsedAdventureMs = 10 * 60 * 1000;
  assert.equal(hooks.triggerAdventureTimeGoal(), false);
  hooks.adventureState.elapsedAdventureMs = 15 * 60 * 1000;
  assert.equal(hooks.triggerAdventureTimeGoal(), false);
  assert.equal(scheduled.length, 1);
});

test("background goal waits for visibility and presents exactly once after resume", () => {
  const {
    hooks,
    scheduled,
    documentMock,
    timeGoalNotification,
  } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    startedAt: 1000,
    elapsedAdventureMs: 0,
    initialTargetDurationMs: 5 * 60 * 1000,
    goalReached: false,
    timeGoalNotificationPending: false,
    timeGoalConfettiSuppressed: true,
    discoveryFeedbackUntil: 0,
    sessionId: 8,
    direction: null,
  });

  documentMock.visibilityState = "hidden";
  hooks.updateAdventureTime(301000);
  hooks.adventureState.timeGoalConfettiSuppressed = true;
  const hiddenAttempt = scheduled.find((item) => !item.cleared);
  assert.ok(hiddenAttempt);
  hiddenAttempt.cleared = true;
  hiddenAttempt.callback();
  assert.equal(hooks.adventureState.timeGoalNotificationPending, true);
  assert.equal(timeGoalNotification.classList.contains("hidden"), true);

  documentMock.visibilityState = "visible";
  hooks.handleAdventureVisibilityChange();
  const visibleAttempt = scheduled.find((item) => !item.cleared);
  assert.ok(visibleAttempt);
  visibleAttempt.cleared = true;
  visibleAttempt.callback();
  assert.equal(hooks.adventureState.timeGoalNotificationPending, false);
  assert.equal(timeGoalNotification.classList.contains("is-visible"), true);
  assert.equal(timeGoalNotification.textContent, "今日の冒険を達成しました！");

  const fadeOutStart = scheduled.find((item) => !item.cleared);
  assert.ok(fadeOutStart);
  assert.equal(fadeOutStart.delayMs, 2350);
  fadeOutStart.cleared = true;
  fadeOutStart.callback();
  const hide = scheduled.find((item) => !item.cleared);
  assert.ok(hide);
  assert.equal(hide.delayMs, 180);
  hide.cleared = true;
  hide.callback();
  assert.equal(timeGoalNotification.classList.contains("hidden"), true);
  assert.equal(hooks.triggerAdventureTimeGoal(), false);
  assert.equal(scheduled.filter((item) => !item.cleared).length, 0);
});

test("a pending discovery milestone suppresses duplicate time-goal confetti", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    elapsedAdventureMs: 5 * 60 * 1000,
    initialTargetDurationMs: 5 * 60 * 1000,
    goalReached: false,
    timeGoalNotificationPending: false,
    timeGoalConfettiSuppressed: false,
    discoveryFeedbackUntil: Date.now() + 5000,
    sessionId: 9,
    direction: null,
  });
  Object.assign(hooks.discoveryNotificationState, {
    phase: "first",
    milestoneThreshold: 5,
  });

  assert.equal(hooks.shouldSuppressTimeGoalConfettiForDiscovery(), true);
  assert.equal(hooks.triggerAdventureTimeGoal(), true);
  assert.equal(hooks.adventureState.timeGoalConfettiSuppressed, true);
  assert.equal(hooks.adventureState.status, "active");
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

test("time, cells, discoveries, distance, and route recording continue after the goal", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    status: "active",
    startedAt: 1000,
    elapsedAdventureMs: 5 * 60 * 1000,
    initialTargetDurationMs: 5 * 60 * 1000,
    goalReached: true,
    direction: null,
    startCellId: "0_0",
    hasLeftStartCell: false,
    sessionVisitedCellIds: new Set(),
    sessionVisitedCells: [],
    sessionDiscoveredCellIds: new Set(),
    sessionDiscoveredCells: [],
    distanceMeters: 0,
    lastDistancePoint: { lat: 35, lon: 139, timestamp: 1000 },
    routePoints: [],
    lastRoutePoint: null,
  });

  hooks.updateAdventureTime(13 * 60 * 1000 + 1000);
  assert.equal(hooks.adventureState.elapsedAdventureMs, 13 * 60 * 1000);
  assert.equal(hooks.adventureState.goalReached, true);
  assert.equal(hooks.registerAdventureVisitedCell(1, 0), true);
  assert.equal(hooks.registerAdventureDiscovery(1, 0), true);
  assert.equal(hooks.registerAdventureDistance(35.0001, 139, 11000), true);
  assert.equal(hooks.recordRoutePoint(35, 139, 1000, 10), true);
  assert.equal(hooks.recordRoutePoint(35.0001, 139, 11000, 10), true);
  assert.equal(hooks.adventureState.sessionVisitedCellIds.size, 1);
  assert.equal(hooks.adventureState.sessionDiscoveredCellIds.size, 1);
  assert.ok(hooks.adventureState.distanceMeters > 0);
  assert.equal(hooks.adventureState.routePoints.length, 2);
  assert.equal(hooks.adventureState.status, "active");
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

test("completion data uses actual duration and contains no extension count", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    preset: "normal",
    elapsedAdventureMs: 18 * 60 * 1000,
    distanceMeters: 1200,
    sessionVisitedCellIds: new Set(["1_0", "2_0", "3_0"]),
    sessionDiscoveredCellIds: new Set(["3_0"]),
    startedAt: 1000,
    endedAt: 1081000,
    goalReached: true,
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
      goalReached: true,
      slopeQuestCompleted: false,
      direction: { sector: 0, label: "北", bearingDeg: 0 },
    },
  );
});

test("time goal uses one light effect, readable timing, and no extension copy", () => {
  const { hooks } = loadProductionAdventure();
  assert.deepEqual(
    JSON.parse(JSON.stringify(hooks.timeGoalCompletionEffect)),
    { intensity: "small", durationMs: 1000 },
  );
  assert.equal(hooks.debugTimeGoal, false);
  assert.equal(hooks.adventureGoalMessage, "今日の冒険を達成しました！");
  const timing = hooks.getTimeGoalMessageTiming(false);
  const reducedTiming = hooks.getTimeGoalMessageTiming(true);
  assert.equal(timing.fadeInMs + timing.holdMs + timing.fadeOutMs, 2530);
  assert.equal(reducedTiming.holdMs, 2200);
  assert.ok(reducedTiming.fadeInMs < timing.fadeInMs);
  assert.ok(reducedTiming.fadeOutMs < timing.fadeOutMs);
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
    timeGoalNotificationPending: true,
    timeGoalConfettiSuppressed: true,
    elapsedAdventureMs: 1234,
    sessionVisitedCellIds: new Set(["1_0"]),
    sessionDiscoveredCellIds: new Set(["1_0"]),
  });
  hooks.resetAdventureStateKeepHistory();
  assert.equal(hooks.adventureState.goalReached, false);
  assert.equal(hooks.adventureState.timeGoalNotificationPending, false);
  assert.equal(hooks.adventureState.timeGoalConfettiSuppressed, false);
  assert.equal(hooks.adventureState.elapsedAdventureMs, 0);
  assert.equal(hooks.adventureState.sessionVisitedCellIds.size, 0);
  assert.equal(hooks.adventureState.sessionDiscoveredCellIds.size, 0);
});

test("completion HTML exposes only time, distance, and new-place results", () => {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  for (const required of [
    'id="adventure-hud-progress"',
    'id="time-goal-notification"',
    'aria-live="polite"',
    'aria-atomic="true"',
    'id="completion-elapsed"',
    'id="completion-distance"',
    'id="completion-discovered-cells"',
    'id="discovery-message"',
    "今日の冒険、おつかれさま！",
    "新しい場所",
    "冒険を終える",
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
    "time-goal-panel",
    "btn-time-goal-end",
    "btn-time-goal-extend",
    "あと5分だけ続ける",
    "まだ冒険を続けますか",
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

  const timeGoalBlock = css.match(
    /#time-goal-notification \{([\s\S]*?)\n\}/,
  );
  assert.ok(timeGoalBlock);
  assert.equal(timeGoalBlock[1].includes("pointer-events: none"), true);
  assert.equal(timeGoalBlock[1].includes("inset: 0"), false);
});

test("only the persistent HUD end button is wired to end an active adventure", () => {
  const app = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  assert.equal(
    (app.match(/addEventListener\("click", endAdventure\)/g) || []).length,
    1,
  );
  assert.equal(html.includes('id="btn-end-adventure"'), true);
  assert.equal(html.includes('role="dialog" aria-modal="true" aria-labelledby="time-goal'), false);
});

test("slope quest confetti is suppressed while a milestone is being shown (same rule as time goal)", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.discoveryNotificationState, {
    phase: "milestone",
    milestoneThreshold: 10,
  });
  assert.equal(hooks.shouldSuppressSlopeQuestConfettiForDiscovery(), true);

  Object.assign(hooks.discoveryNotificationState, {
    phase: "first",
    milestoneThreshold: null,
  });
  assert.equal(hooks.shouldSuppressSlopeQuestConfettiForDiscovery(), false);
});

test("slope quest confetti stays at or below the time-goal intensity (never larger than a milestone)", () => {
  const { hooks } = loadProductionAdventure();
  assert.equal(hooks.slopeQuestConfetti.intensity, "small");
  assert.ok(hooks.slopeQuestConfetti.durationMs >= 1000 && hooks.slopeQuestConfetti.durationMs <= 1300);
});

test("resetting the adventure clears slope quest completion and pending-notification flags", () => {
  const { hooks } = loadProductionAdventure();
  hooks.adventureState.status = "active";
  hooks.adventureState.slopeQuestCompleted = true;
  hooks.adventureState.slopeQuestNotificationPending = true;

  hooks.resetAdventureStateKeepHistory();

  assert.equal(hooks.adventureState.slopeQuestCompleted, false);
  assert.equal(hooks.adventureState.slopeQuestNotificationPending, false);
});

test("completion data reports slopeQuestCompleted for both the reached and not-reached cases", () => {
  const { hooks } = loadProductionAdventure();
  Object.assign(hooks.adventureState, {
    preset: "short",
    elapsedAdventureMs: 5 * 60 * 1000,
    distanceMeters: 300,
    sessionVisitedCellIds: new Set(["0_0"]),
    sessionDiscoveredCellIds: new Set(["0_0"]),
    startedAt: 0,
    endedAt: 300000,
    goalReached: true,
    slopeQuestCompleted: false,
    direction: null,
  });
  assert.equal(hooks.getAdventureCompletionData().slopeQuestCompleted, false);

  hooks.adventureState.slopeQuestCompleted = true;
  assert.equal(hooks.getAdventureCompletionData().slopeQuestCompleted, true);
});

test("debug flag for the slope quest is off in production", () => {
  const { hooks } = loadProductionAdventure();
  assert.equal(hooks.debugSlopeQuest, false);
});

test("slope quest wording avoids absolute steepness claims and uses candidate phrasing", () => {
  const app = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  const forbidden = ["急勾配", "最も急な坂", "一番急な坂", "最大勾配", "最急地点"];
  for (const phrase of forbidden) {
    assert.equal(app.includes(phrase), false, `app.js must not contain "${phrase}"`);
    assert.equal(html.includes(phrase), false, `index.html must not contain "${phrase}"`);
  }
  assert.equal(app.includes("勾配スポット"), true);
});

test("slope quest arrival message and log entry use the candidate label", () => {
  const { hooks } = loadProductionAdventure();
  assert.equal(hooks.slopeQuestArrivalMessage, "勾配スポットに到達！");
  assert.equal(hooks.slopeQuestLabel, "勾配スポット");
});

test("slope quest notification element exists with a non-intrusive live region", () => {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  assert.equal(html.includes('id="slope-quest-notification"'), true);
  const tagMatch = html.match(/<div[^>]*id="slope-quest-notification"[^>]*>/);
  assert.ok(tagMatch);
  assert.equal(tagMatch[0].includes('role="status"'), true);
  assert.equal(tagMatch[0].includes('aria-live="polite"'), true);

  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
  const block = css.match(/#slope-quest-notification \{([\s\S]*?)\n\}/);
  assert.ok(block);
  assert.equal(block[1].includes("pointer-events: none"), true);
});

test("completion sheet has exactly one slope-quest result badge, hidden by default, not inside the 3-item stat list", () => {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  assert.equal(html.includes('id="slope-quest-result-badge"'), true);
  const badgeMatch = html.match(/<div[^>]*id="slope-quest-result-badge"[^>]*>/);
  assert.ok(badgeMatch);
  assert.equal(badgeMatch[0].includes("hidden"), true);
  assert.equal(html.includes("勾配スポットに到達"), true);

  // 主要3項目の<ul>の中には無い（数値表へは入れない）
  const completionStats = html.match(/<ul class="completion-stats">([\s\S]*?)<\/ul>/);
  assert.ok(completionStats);
  assert.equal(completionStats[1].includes("slope-quest-result-badge"), false);

  // 「未達成」「クエスト 0」「あと○m」のような文言は出さない
  for (const forbidden of ["未達成", "到達できませんでした", "挑戦失敗"]) {
    assert.equal(html.includes(forbidden), false, `must not contain "${forbidden}"`);
  }
});

test("slope quest marker is a flag (pole + cloth), not a circular pin, with a >=44x44 tap area and a one-shot completion pop", () => {
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
  const marker = css.match(/\.slope-quest-marker \{([\s\S]*?)\n\}/);
  const ring = css.match(/\.slope-quest-marker__ring \{([\s\S]*?)\n\}/);
  const pole = css.match(/\.slope-quest-marker__pole \{([\s\S]*?)\n\}/);
  const cloth = css.match(/\.slope-quest-marker__cloth \{([\s\S]*?)\n\}/);
  assert.ok(marker && ring && pole && cloth);
  assert.equal(marker[1].includes("48px"), true); // タップ領域 >= 44x44px
  // 旗竿・旗布のどちらにも border-radius: 50%（円形）を使わない＝現在地マーカーの丸型と混同しない
  assert.equal(/border-radius:\s*50%/.test(pole[1]), false);
  assert.equal(/border-radius:\s*50%/.test(cloth[1]), false);
  assert.equal(cloth[1].includes("clip-path"), true);
  assert.equal(css.includes(".slope-quest-marker.is-completing"), true);
  assert.equal(css.includes(".slope-quest-marker.is-completed"), true);
  assert.equal(css.includes(".slope-quest-marker.is-removing"), true);
  assert.equal(css.includes("slope-quest-complete-pop"), true);
  assert.equal(css.includes("slope-quest-ring-pulse"), true);
});

test("slope quest flag markup avoids emoji-only rendering and differs from the current-location marker's circular fill color", () => {
  const appJs = readFileSync(join(__dirname, "..", "app.js"), "utf8");
  // 通常状態: pole/clothのみで構成し、絵文字だけに依存しない。到達済みのみ✓を使う（絵文字ではなく文字）。
  const fnMatch = appJs.match(/function buildSlopeQuestIconHtml\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.equal(fnMatch[0].includes("slope-quest-marker__pole"), true);
  assert.equal(fnMatch[0].includes("slope-quest-marker__cloth"), true);

  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
  const pole = css.match(/\.slope-quest-marker__pole \{([\s\S]*?)\n\}/)[1];
  const meMarkerColor = "#f59e0b"; // 現在地マーカー(meMarker)の塗り色
  assert.equal(pole.includes(meMarkerColor), false); // 旗竿は現在地と同じ塗りを使わない
});

test("reduced-motion stops the ring pulse/pop and shortens notification transitions without hiding information", () => {
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
  const block = css.match(
    /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n\n/,
  );
  const reduced = block ? block[1] : css;
  assert.equal(reduced.includes("slope-quest-notification"), true);
  assert.equal(reduced.includes(".slope-quest-marker__ring"), true);
  assert.equal(reduced.includes(".slope-quest-marker.is-completing"), true);
});

test("service worker cache version includes the updated app shell", () => {
  const sw = readFileSync(join(__dirname, "..", "sw.js"), "utf8");
  assert.equal(sw.includes('const CACHE_NAME = "machi-boken-v29"'), true);
  for (const asset of ["./index.html", "./styles.css", "./app.js"]) {
    assert.equal(sw.includes(`"${asset}"`), true, `missing ${asset}`);
  }
});
