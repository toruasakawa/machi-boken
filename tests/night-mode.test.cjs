const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// isNightTime()やNIGHT_DIRECTION_SUB_TEXTはLeafletを一切呼ばない純粋な値なので、
// 他のテストと同じVM読み込み方式で、実運用のapp.jsを直接検証する。
function loadProductionNightMode() {
  const appPath = join(__dirname, "..", "app.js");
  const source = readFileSync(appPath, "utf8");
  const exposeTestHooks = `
    globalThis.__nightModeTestHooks = {
      isNightTime,
      nightStartHour: NIGHT_START_HOUR,
      nightEndHour: NIGHT_END_HOUR,
      nightDirectionSubText: NIGHT_DIRECTION_SUB_TEXT,
      adventurePresets: ADVENTURE_PRESETS,
      adventurePresetOrder: ADVENTURE_PRESET_ORDER,
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
  return context.__nightModeTestHooks;
}

const nightMode = loadProductionNightMode();

function atHour(hour, minute) {
  const d = new Date(2026, 0, 1, hour, minute || 0);
  return d;
}

test("isNightTime: 18:00 is night (start boundary, inclusive)", () => {
  assert.equal(nightMode.isNightTime(atHour(18, 0)), true);
});

test("isNightTime: 17:59 is day (just before night starts)", () => {
  assert.equal(nightMode.isNightTime(atHour(17, 59)), false);
});

test("isNightTime: 23:59 is night", () => {
  assert.equal(nightMode.isNightTime(atHour(23, 59)), true);
});

test("isNightTime: 00:00 is night", () => {
  assert.equal(nightMode.isNightTime(atHour(0, 0)), true);
});

test("isNightTime: 05:59 is night (end boundary, inclusive)", () => {
  assert.equal(nightMode.isNightTime(atHour(5, 59)), true);
});

test("isNightTime: 06:00 is day (night ends)", () => {
  assert.equal(nightMode.isNightTime(atHour(6, 0)), false);
});

test("isNightTime: midday is day", () => {
  assert.equal(nightMode.isNightTime(atHour(13, 30)), false);
});

test("night hour boundaries match the documented 18:00-05:59 window", () => {
  assert.equal(nightMode.nightStartHour, 18);
  assert.equal(nightMode.nightEndHour, 6);
});

test("every adventure preset has a night-specific direction sub text", () => {
  for (const key of nightMode.adventurePresetOrder) {
    const text = nightMode.nightDirectionSubText[key];
    assert.ok(typeof text === "string" && text.length > 0, `missing night copy for preset "${key}"`);
  }
});

test("night direction copy never recommends unfamiliar/unchosen roads", () => {
  // 夜間は「普段なら選ばない道」「知らない道」を積極的に推奨しない方針（完了条件11）
  const forbiddenPhrases = ["普段なら選ばない", "知らない道"];
  for (const key of nightMode.adventurePresetOrder) {
    const text = nightMode.nightDirectionSubText[key];
    for (const phrase of forbiddenPhrases) {
      assert.ok(!text.includes(phrase), `night copy for "${key}" must not include "${phrase}": ${text}`);
    }
  }
});

test("night direction copy mentions familiar or safe/well-lit roads", () => {
  const safetyPhrases = ["慣れた道", "明るく", "安全"];
  for (const key of nightMode.adventurePresetOrder) {
    const text = nightMode.nightDirectionSubText[key];
    const mentionsSafety = safetyPhrases.some((phrase) => text.includes(phrase));
    assert.ok(mentionsSafety, `night copy for "${key}" should reference a familiar/safe road: ${text}`);
  }
});

test("night uses the same 5, 15, and 30 minute time goals as daytime", () => {
  assert.equal(nightMode.adventurePresets.short.minutes, 5);
  assert.equal(nightMode.adventurePresets.short.targetDurationMs, 5 * 60 * 1000);
  assert.equal(nightMode.adventurePresets.normal.minutes, 15);
  assert.equal(nightMode.adventurePresets.normal.targetDurationMs, 15 * 60 * 1000);
  assert.equal(nightMode.adventurePresets.long.minutes, 30);
  assert.equal(nightMode.adventurePresets.long.targetDurationMs, 30 * 60 * 1000);
});
