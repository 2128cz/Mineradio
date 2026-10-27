'use strict';

// The PV planner's hidden window is a whole renderer process holding the engine, so releasing it
// when the app is idle is worth real memory — and worth a real test, because the two ways to get
// it wrong are both silent: release too early and an in-flight plan fails its caller, release too
// late and a listening session pays for a window it is not using.
//
// The fake BrowserWindow keeps the REAL pv-planner.js in the loop, so dispose()/isOpen()/stats()
// semantics here are the ones the app runs on.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPvPlanner } = require('../pv-planner');
const { createPvPlannerPool } = require('../pv-planner-pool');

// One controllable hidden window per spawn. `blockOn` lets a test wedge a plan inside
// executeJavaScript, which is the only state where releasing the window would hurt a caller.
function harness(options) {
  const opts = options || {};
  const state = { windows: [], busy: 0, idleReleaseCalls: 0 };
  const logs = [];
  let blockOn = null;
  const planResult = JSON.stringify({ json: '{"cuts":[]}', cuts: 2, duration: 12, W: 1920, H: 1080, lang: 'ja', engineMs: 7, appVersion: '0.10.1' });

  class FakeBrowserWindow {
    constructor(webOptions) {
      this.options = webOptions || {};
      this.webPreferences = (webOptions && webOptions.webPreferences) || {};
      this.destroyed = false;
      this.scripts = [];
      this.webContents = {
        loadURL: async () => {},
        executeJavaScript: async (script) => {
          if (!script) return true;
          this.scripts.push(script);
          if (script.indexOf('window.__pvPlan(') === 0) {
            state.busy += 1;
            try {
              if (blockOn) await blockOn;
              return planResult;
            } finally {
              state.busy -= 1;
            }
          }
          return true;
        },
      };
      this.isDestroyed = () => this.destroyed;
      this.destroy = () => { this.destroyed = true; };
      state.windows.push(this);
    }
  }

  const pool = createPvPlannerPool({
    appRoot: opts.appRoot || 'F:/app',
    isBusy: () => state.busy,
    idleReleaseMs: opts.idleReleaseMs,
    log: (line) => logs.push(String(line)),
    createPlanner: (createOptions) => createPvPlanner(Object.assign({}, createOptions, {
      BrowserWindow: FakeBrowserWindow,
      skipEnginePinCheck: true,
      timeoutMs: opts.timeoutMs || 200,
    })),
  });

  state.plan = () => pool.get().plan({ lyrics: '[00:00.00]a\n[00:01.00]b' });
  state.blockPlans = (promise) => { blockOn = promise; };
  state.lastWindow = () => state.windows[state.windows.length - 1];
  state.liveWindows = () => state.windows.filter((win) => !win.destroyed).length;
  return { pool, logs, state };
}

test('the hidden window is spawned on the first plan, never at pool construction', async () => {
  const { pool, state } = harness();
  assert.equal(pool.isOpen(), false);
  assert.deepEqual(state.windows, []);
  const out = await state.plan();
  assert.equal(out.cuts, 2);
  assert.equal(state.windows.length, 1);
  assert.equal(pool.isOpen(), true);
  // The window stays hidden and keeps background throttling off, or a minimized app would throttle
  // the engine's own timers mid-plan.
  assert.equal(state.lastWindow().options.show, false);
  assert.equal(state.lastWindow().webPreferences.backgroundThrottling, false);
});

test('an idle release destroys the window and the next plan rebuilds it', async () => {
  const { pool, state } = harness();
  await state.plan();
  const result = pool.idleRelease('minimize');
  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.reason, 'minimize');
  assert.equal(result.windowWasOpen, true);
  assert.equal(state.liveWindows(), 0);
  assert.equal(pool.isOpen(), false);

  await state.plan();
  assert.equal(state.windows.length, 2, 'a rebuilt window is expected, not a resurrected one');
  const stats = pool.stats();
  assert.equal(stats.open, true);
  assert.equal(stats.windowsCreated, 2);
  assert.equal(stats.plans, 2);
});

test('a release requested while a plan is in flight is refused, and the plan still answers', async () => {
  const { pool, state } = harness();
  let releaseBlock;
  state.blockPlans(new Promise((resolve) => { releaseBlock = resolve; }));
  const inflight = state.plan();
  // Wait until the plan is genuinely inside executeJavaScript.
  while (state.busy === 0) await new Promise((resolve) => setTimeout(resolve, 0));

  const refused = pool.idleRelease('hide');
  assert.equal(refused.ok, true);
  assert.equal(refused.released, false);
  assert.equal(refused.reason, 'plan-in-flight');
  assert.equal(refused.busy, 1);
  assert.equal(pool.isOpen(), true, 'a busy window must stay up');
  assert.equal(state.liveWindows(), 1);

  releaseBlock();
  const out = await inflight;
  assert.equal(out.cuts, 2, 'the refused caller must not lose its plan');
  assert.equal(pool.idleRelease('hide').released, true);
  assert.equal(pool.stats().refusedWhileBusy, 1);
});

test('counters stay cumulative over releases, so the pipeline is not blinded by reclaim', async () => {
  const { pool, state } = harness();
  await state.plan();
  pool.idleRelease('minimize');
  await state.plan();
  await state.plan();
  pool.idleRelease('minimize');
  const stats = pool.stats();
  assert.equal(stats.open, false);
  assert.equal(stats.windowsCreated, 2);
  assert.equal(stats.plans, 3);
  assert.equal(stats.failures, 0);
  assert.equal(stats.releases, 2);
  assert.equal(stats.lastReleaseReason, 'minimize');
  assert.ok(Number.isFinite(stats.lastReleaseAt) && stats.lastReleaseAt > 0);
  assert.equal(stats.lastEngineMs, 7);
});

test('every release says what it did and why, in the log', async () => {
  const { pool, state, logs } = harness();
  await state.plan();
  pool.idleRelease('tray-hide');
  assert.ok(logs.some((line) => /\[PvPlanner\].*tray-hide/.test(line)));
});

test('an idle release with no window open is a no-op that does not claim a release', async () => {
  const { pool, state, logs } = harness();
  const first = pool.idleRelease('minimize');
  assert.equal(first.released, false);
  assert.equal(first.reason, 'not-open');
  assert.equal(pool.stats().releases, 0);
  assert.equal(logs.length, 0, 'a no-op must not be logged as an action');
  await state.plan();
  assert.equal(state.windows.length, 1);
});

test('a named planner failure survives an idle release instead of being retried per request', async () => {
  const logs = [];
  let createCalls = 0;
  const pool = createPvPlannerPool({
    isBusy: () => 0,
    log: (line) => logs.push(String(line)),
    createPlanner: () => {
      createCalls += 1;
      throw Object.assign(new Error('PV_ENGINE_PIN_MISMATCH'), { code: 'PV_ENGINE_PIN_MISMATCH' });
    },
  });
  assert.throws(() => pool.get(), /PV_ENGINE_PIN_MISMATCH/);
  assert.throws(() => pool.get(), /PV_ENGINE_PIN_MISMATCH/);
  assert.equal(createCalls, 1, 'a pin mismatch must be remembered, not re-read on every request');
  const released = pool.idleRelease('minimize');
  assert.equal(released.released, false);
  assert.throws(() => pool.get(), /PV_ENGINE_PIN_MISMATCH/);
  assert.equal(createCalls, 1, 'a background trim must not hand a broken pin a fresh attempt');
});

test('the explicit release route stays unconditional, which is why it is not the idle path', async () => {
  const { pool, state } = harness();
  let releaseBlock;
  state.blockPlans(new Promise((resolve) => { releaseBlock = resolve; }));
  const inflight = state.plan();
  while (state.busy === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  const forced = pool.release('manual');
  assert.equal(forced.released, true, 'the debug route is the operator override');
  assert.equal(state.liveWindows(), 0);
  // The caller it wedges is the point: this is what the idle path refuses to do.
  await assert.rejects(() => inflight, /PV_PLAN_TIMEOUT/);
  releaseBlock();
});

test('a backgrounded app gives the window back once planning goes quiet', async () => {
  const { pool, state } = harness({ idleReleaseMs: 25 });
  await state.plan();
  pool.setBackground(true);
  assert.equal(pool.stats().reclaimArmed, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const stats = pool.stats();
  assert.equal(stats.open, false);
  assert.equal(stats.releases, 1);
  assert.equal(stats.lastReleaseReason, 'background-quiet');
});

test('a prefetch that rebuilds the window while backgrounded is reclaimed again', async () => {
  const { pool, state } = harness({ idleReleaseMs: 25 });
  await state.plan();
  pool.setBackground(true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(pool.stats().releases, 1);
  // The queue asks for the next song a second later; the quiet period has to start over.
  await state.plan();
  assert.equal(pool.isOpen(), true);
  assert.equal(pool.stats().reclaimArmed, true, 'taking the window again re-arms the reclaim');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const stats = pool.stats();
  assert.equal(stats.open, false);
  assert.equal(stats.releases, 2);
});

test('coming back to the foreground cancels an armed reclaim', async () => {
  const { pool, state } = harness({ idleReleaseMs: 25 });
  await state.plan();
  pool.setBackground(true);
  pool.setBackground(false);
  assert.equal(pool.stats().reclaimArmed, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(pool.isOpen(), true, 'a player in the foreground keeps its planner');
  assert.equal(pool.stats().releases, 0);
});

test('a release refused by a plan in flight waits another quiet period instead of retrying at once', async () => {
  const { pool, state } = harness({ idleReleaseMs: 25 });
  await state.plan();
  pool.setBackground(true);
  let releaseBlock;
  state.blockPlans(new Promise((resolve) => { releaseBlock = resolve; }));
  const inflight = state.plan();
  while (state.busy === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(pool.isOpen(), true, 'the fired reclaim must have been refused, not forced');
  releaseBlock();
  await inflight;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const stats = pool.stats();
  assert.equal(stats.open, false, 'once the queue goes quiet it is given back');
  assert.equal(stats.refusedWhileBusy >= 1, true, 'the refusal is counted, and each one restarts the quiet period');
});

