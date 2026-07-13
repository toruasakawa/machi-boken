const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadProductionSignPhysics() {
  const appPath = join(__dirname, "..", "app.js");
  const source = readFileSync(appPath, "utf8");
  const exposeTestHooks = `
    globalThis.__signReleaseTestHooks = {
      minDirectionalVelocity: MIN_DIRECTIONAL_VELOCITY,
      simulateRelease(angleSamples) {
        const pointerId = 1;
        activeSignPointerId = pointerId;
        currentSignRotation = 0;
        lastSignDragDirection = 0;
        signDragState = {
          center: { x: 0, y: 0 },
          lastAngle: 0,
          cumulativeDelta: 0,
          directionRefDelta: 0,
          startRotation: 0,
          downTime: 0,
          browserEventCount: 0,
          coalescedSampleCount: 0,
          history: [{ angle: 0, timestamp: 0 }],
        };

        for (const sample of angleSamples) {
          const radians = sample.angleDeg * Math.PI / 180;
          recordSignPointerSample({
            pointerId,
            clientX: Math.cos(radians) * 100,
            clientY: Math.sin(radians) * 100,
            timeStamp: sample.timestamp,
          });
        }

        const release = calculateReleaseAngularVelocity(signDragState.history);
        const result = {
          history: signDragState.history.map((item) => ({ ...item })),
          cumulativeDelta: signDragState.cumulativeDelta,
          lastSignDragDirection,
          releaseVelocity: release.velocity,
          resolvedSpinDirection: resolveSpinDirection(release.velocity),
          releaseDebug: { ...release.debug },
        };

        activeSignPointerId = null;
        signDragState = null;
        return result;
      },
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
  return context.__signReleaseTestHooks;
}

const signPhysics = loadProductionSignPhysics();
const counterclockwiseSamples = [
  { timestamp: 20, angleDeg: -0.5 },
  { timestamp: 40, angleDeg: -1.0 },
  { timestamp: 60, angleDeg: -1.5 },
  { timestamp: 80, angleDeg: -2.0 },
];

test("control: monotonic counterclockwise samples keep a counterclockwise release", () => {
  const result = signPhysics.simulateRelease(counterclockwiseSamples);

  assert.ok(result.cumulativeDelta < 0);
  assert.equal(result.lastSignDragDirection, -1);
  assert.ok(result.releaseVelocity < 0);
  assert.equal(result.resolvedSpinDirection, -1);
});

test("hypothesis: a same-timestamp clockwise tail sample reverses the resolved direction", (t) => {
  const result = signPhysics.simulateRelease([
    ...counterclockwiseSamples,
    { timestamp: 80, angleDeg: -1.9 },
  ]);
  const finalSegment = {
    deltaAngle:
      result.history[result.history.length - 1].angle -
      result.history[result.history.length - 2].angle,
    deltaTime:
      result.history[result.history.length - 1].timestamp -
      result.history[result.history.length - 2].timestamp,
  };

  t.diagnostic(
    JSON.stringify({
      cumulativeDelta: result.cumulativeDelta,
      lastSignDragDirection: result.lastSignDragDirection,
      finalSegment,
      releaseVelocity: result.releaseVelocity,
      minDirectionalVelocity: signPhysics.minDirectionalVelocity,
      resolvedSpinDirection: result.resolvedSpinDirection,
      releaseDebug: result.releaseDebug,
    })
  );

  assert.ok(result.cumulativeDelta < 0, "the gesture must remain counterclockwise overall");
  assert.equal(result.lastSignDragDirection, -1, "the recorded drag direction must remain counterclockwise");
  assert.ok(finalSegment.deltaAngle > 0, "the final sample must contain a small clockwise return");
  assert.ok(finalSegment.deltaTime <= 0.011, "the production timestamp correction must create a tiny interval");
  assert.ok(
    result.releaseVelocity >= signPhysics.minDirectionalVelocity,
    "the calculated positive release velocity must outrank the drag-direction fallback"
  );
  assert.equal(result.resolvedSpinDirection, 1);
});

test("control: the same clockwise tail over a normal interval does not reverse the direction", () => {
  const result = signPhysics.simulateRelease([
    ...counterclockwiseSamples,
    { timestamp: 84, angleDeg: -1.9 },
  ]);

  assert.ok(result.cumulativeDelta < 0);
  assert.equal(result.lastSignDragDirection, -1);
  assert.equal(result.resolvedSpinDirection, -1);
});
