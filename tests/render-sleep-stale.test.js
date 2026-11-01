// The renderer must not stay parked (and 4x4) because the native window flag went stale while
// frames were still being presented. Drives 08-desktop-render-power.js in a sandbox.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const sourcePath = process.env.RENDER_POWER_PATH || path.join(__dirname, '..', 'public', 'js',
  'modules', '00-state', '08-desktop-render-power.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const calls = [];
const warnings = [];
const sandbox = {
  console: { warn: (m) => warnings.push(String(m)), log: () => {}, error: () => {}, info: () => {} },
  document: { hidden: false, body: { classList: { toggle: () => {}, contains: () => false } } },
  window: { desktopWindow: { isVisible: () => true }, addEventListener: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  renderer: null,
  innerWidth: 1600,
  innerHeight: 900,
  navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
  devicePixelRatio: 1,
  desktopRuntimeState: { desktop: true, minimized: true, visible: false },
  fx: {},
  applyRendererPowerMode: () => calls.push('power'),
  updateRenderPowerClasses: () => calls.push('classes'),
  scheduleBackgroundCacheTrim: () => {},
  requestBackgroundAppMemoryTrim: () => {},
  normalizePerformanceBackgroundMode: (value, keep) => (keep ? 'keep' : (value || 'eco')),
  normalizePerformanceQuality: (q) => q || 'balanced',
  renderPerfState: {}
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: '08-desktop-render-power.js' });
// The module initialises its own runtime state at load; put the stale flag in place afterwards.
sandbox.desktopRuntimeState.minimized = true;
sandbox.desktopRuntimeState.visible = false;
assert.strictEqual(sandbox.isDeepBackgroundMode(), true, 'the sandbox has to start out believing it is hidden');
// The module brings its own copies of these; spy on them from here.
sandbox.updateRenderPowerClasses = () => calls.push('classes');
sandbox.applyRendererPowerMode = () => calls.push('power');

// The decision itself: a hidden window cannot present frames, so a fresh frame disproves the flag.
assert.strictEqual(sandbox.renderSleepClaimIsStale(true, 16, 10), true, '60 Hz frames under a sleep claim are stale');
assert.strictEqual(sandbox.renderSleepClaimIsStale(true, 600, 10), false, 'a 1 s cadence is a real sleep');
assert.strictEqual(sandbox.renderSleepClaimIsStale(true, 16, 9), false, 'one frame is not a streak');
assert.strictEqual(sandbox.renderSleepClaimIsStale(false, 16, 99), false, 'an awake renderer needs no correction');

// And it must actually wake the renderer, resize it back and say so.
let woke = 0;
for (let i = 0; i < 12; i++) {
  const t = 1000 + i * 16;
  if (sandbox.notePresentedFrame(t, t - 16)) woke++;
}
assert.strictEqual(woke, 1, 'twelve 60 Hz frames in a sleep claim have to wake the renderer exactly once');
assert.deepStrictEqual(Array.from(calls), ['classes', 'power'],
  'the wake has to repaint the power classes and resize the buffer: ' + JSON.stringify(calls));
assert(sandbox.desktopRuntimeState.minimized === false && sandbox.desktopRuntimeState.visible === true,
  'and clear the stale flag itself, or the next frame parks again');
assert(warnings.length === 1 && /woken/.test(warnings[0]), 'the wake has to be a log line, not a silent fix');
assert(sandbox.renderPerfState.staleSleepFixes === 1, 'and be countable');

// A real sleep keeps sleeping: one frame per second must never wake it.
calls.length = 0;
for (let i = 0; i < 20; i++) sandbox.notePresentedFrame(5000 + i * 1000, 5000 + (i - 1) * 1000);
assert.strictEqual(calls.length, 0, 'a genuinely hidden window must stay asleep');
assert(sandbox.desktopRuntimeState.minimized === false, 'and the state is left as the last wake set it');

console.log('render power: stale sleep needs ' + sandbox.RENDER_SLEEP_STREAK + ' frames within '
  + sandbox.RENDER_SLEEP_GAP_MS + ' ms, wakes once, resizes, and never fires on a real sleep');