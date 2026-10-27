'use strict';

// The PV draw tier is the one place where preset 13 decides to buy frame time with effects, so it
// is tested against the real module source and the real normaliser: a tier that silently sends
// `{}` (or a knob the vendored engine ignores) looks identical to a working one on screen.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const presetSource = read('public/js/modules/02-visual/17-pv-preset.js');
const persistenceSource = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
const defaultsSource = read('public/js/modules/00-state/04-fx-defaults.js');
const { PV_ENGINE_KNOBS } = require('../scripts/pv-draw-bench.js');

// An object built inside the vm has the other realm's Object prototype, which deepStrictEqual
// treats as a different type; flattening it is what makes the comparison about the options.
const plain = (value) => JSON.parse(JSON.stringify(value));

function fragment(source, startMarker, endMarker, name) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${name} could not be located`);
  return source.slice(start, end);
}

function fxDefaultsObject() {
  return vm.runInNewContext(
    `(function () {\n${fragment(defaultsSource, 'var fxDefaults = ', '\n};', 'fxDefaults')}\n};\nreturn fxDefaults;\n})()`,
    Object.create(null),
  );
}

function loadTier(pvDrawQuality) {
  const fxDefaults = fxDefaultsObject();
  const script = [
    // fragment() stops before its end marker, so the normaliser's closing brace is added back.
    `${fragment(persistenceSource, 'function normalizePvDrawQuality(v) {', '\n}\n', 'normalizePvDrawQuality')}\n}\n`,
    // The block starts at the koma cadence because the 自动 windows are counted in komas.
    fragment(presetSource, 'var PV_TARGET_FPS = ', '\nfunction pvPresetIsActive', 'PV tier'),
    '({ pvDrawTier: pvDrawTier, pvDrawMode: pvDrawMode, PV_TIER_BUILDERS: PV_TIER_BUILDERS,',
    ' pvDrawOptions: function (scale) { return pvTierOptions(pvDrawTier(), scale); },',
    // The 自动 state machine: everything it reads is written here, so a test can drive it
    // with synthetic costs instead of waiting for a slow machine.
    ' pvAutoDrawTier: pvAutoDrawTier, pvAutoReset: pvAutoReset, pvAutoGiveUp: pvAutoGiveUp,',
    ' pvAutoNewPlan: pvAutoNewPlan,',
    ' pvAutoObserve: pvAutoObserve, pvAutoBoundary: pvAutoBoundary, pvCutIndexAt: pvCutIndexAt,',
    ' PV_AUTO_WINDOW_DRAWS: PV_AUTO_WINDOW_DRAWS, PV_AUTO_BUDGET_MS: PV_AUTO_BUDGET_MS,',
    ' PV_AUTO_ENTER_OVER: PV_AUTO_ENTER_OVER, PV_AUTO_ENTER_WINDOWS: PV_AUTO_ENTER_WINDOWS,',
    ' state: pvPresetState })',
  ].join('\n');
  const logs = [];
  const sandbox = {
    fxDefaults,
    fx: { pvDrawQuality },
    console: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
    window: { __mineradioPerf: { counts: {}, count(key) { this.counts[key] = (this.counts[key] || 0) + 1; } } },
  };
  const api = vm.runInNewContext(script, sandbox);
  return { api, sandbox, logs };
}

// Drives the state machine the way pvDrawLayerFrame does: one boundary check and one cost sample
// per koma, and records the tier each of those draws would have used. `cutSeconds` is the plan's
// cut length; the default one-second cuts are shorter than a measurement window, so a test about
// *when* a decision lands needs a cut longer than a window to tell "at a boundary" from "any frame".
function runDraws(api, count, costFn, start, cutSeconds) {
  const from = start || 0;
  const len = cutSeconds || 1;
  const cuts = [];
  for (let i = 0; i < Math.ceil((from + count) / 12 / len) + 2; i++) {
    cuts.push({ start: i * len, end: (i + 1) * len });
  }
  api.state.plan = { cuts };
  const drawn = [];
  for (let i = 0; i < count; i++) {
    const t = (from + i) / 12;
    const boundary = api.pvAutoBoundary(t, t * 1000);
    const tier = api.pvDrawTier();
    api.pvAutoObserve(costFn(i));
    drawn.push({ i, t, boundary, tier, pending: api.state.autoPending });
    // The draw site records lastT only once the frame is on the canvas, so a rewind is seen as
    // the gap between two consecutive draws.
    api.state.lastT = t;
  }
  return drawn;
}

const firstTierChange = (drawn, tier) => drawn.findIndex((d) => d.tier === tier);
const changeCount = (drawn, tier) => drawn.reduce((n, d, i) => (d.tier === tier && (!i || drawn[i - 1].tier !== tier) ? n + 1 : n), 0);
const heavy = () => 25;
const light = () => 2;

test('the default setting is 自动 and it draws the untouched 效果档 options', () => {
  const defaultsText = defaultsSource;
  assert.match(defaultsText, /pvDrawQuality: 'auto'/, 'first launch must not degrade the picture');
  const { api } = loadTier('auto');
  assert.strictEqual(api.pvDrawTier(), 'full', 'auto may only downgrade on measured pressure');
  assert.deepStrictEqual(plain(api.pvDrawOptions(1.5)), { scale: 1.5 });
});

test('效果档 and 性能档 send exactly the options the bench measured', () => {
  assert.deepStrictEqual(plain(loadTier('full').api.pvDrawOptions(2)), { scale: 2 });
  assert.deepStrictEqual(plain(loadTier('lean').api.pvDrawOptions(2)), { scale: 2, fast: true, noTrans: true });
  // Every knob a tier sends must be one the vendored engine is known to read.
  const known = new Set(['scale'].concat(PV_ENGINE_KNOBS.map((k) => k.name)));
  for (const tier of Object.keys(loadTier('full').api.PV_TIER_BUILDERS)) {
    for (const key of Object.keys(loadTier('full').api.PV_TIER_BUILDERS[tier](1))) {
      assert.ok(known.has(key), `tier ${tier} sends ${key}, which no bench knob nor the engine documents`);
    }
  }
});

test('an unknown or missing tier setting falls back to the default instead of throwing mid-frame', () => {
  for (const value of [undefined, null, '', 'cheap', 'FAST', 0, {}, 'lean ']) {
    const { api } = loadTier(value);
    assert.strictEqual(api.pvDrawTier(), 'full',
      `${JSON.stringify(value)} must fall back to the full picture, never invent a tier`);
  }
  assert.strictEqual(loadTier('lean ').api.pvDrawTier(), 'full', 'a padded value is not a tier');
  assert.strictEqual(loadTier('lean').api.pvDrawTier(), 'lean');
});

test('the tier is decided per frame, so switching mid-song needs no rebuild', () => {
  const { api, sandbox } = loadTier('full');
  assert.deepStrictEqual(plain(api.pvDrawOptions(1)), { scale: 1 });
  sandbox.fx.pvDrawQuality = 'lean';
  assert.deepStrictEqual(plain(api.pvDrawOptions(1)), { scale: 1, fast: true, noTrans: true });
  assert.strictEqual(api.pvDrawTier(), 'lean');
});

test('the draw call and the status surface both go through the tier', () => {
  assert.match(presetSource, /renderer\.frame\(ctx, plan, t, pvTierOptions\(tier, w \/ planW\)\)/,
    'the koma draw must use the resolved tier, not a literal option object');
  assert.match(presetSource, /pvPresetState\.tier = tier;/, 'the tier actually drawn must be recorded');
  assert.match(presetSource, /tierNow: pvDrawTier\(\)/, 'status must show what the next frame would draw');
  assert.match(presetSource, /tierSetting: typeof normalizePvDrawQuality/, 'status must show what the user picked');
  // The auto machinery has to sit exactly where the frames are timed: decision before the draw,
  // sampling after it, and a fallback on the throw path.
  assert.match(presetSource, /pvAutoBoundary\(t, started\);\n\s*var tier = pvDrawTier\(\);/,
    'the cut cursor and any pending 自动 decision must land before the frame is drawn');
  assert.match(presetSource, /pvAutoObserve\(cost\);/, 'every measured draw cost must reach the sampler');
  assert.match(presetSource, /pvAutoGiveUp\(pvPresetState\.planError\)/, 'a tier that throws must fall back');
  assert.match(presetSource, /pvAutoNewPlan\('plan ' \+ res\.key\)/, 'a new plan is judged from the full picture');
  assert.match(presetSource, /auto: \{\n\s*tier: pvPresetState\.autoTier/, 'status must expose the 自动 decision');
  // The warm pass is offscreen glyph work; it must stay on its own cheap options.
  assert.match(presetSource, /renderer\.frame\(ctx, plan, t, \{ scale: scale, noGhost: true, noPost: true, noHud: true \}\)/);
});

test('自动 never downgrades on a burst: only a sustained window of blown frames counts', () => {
  const { api } = loadTier('auto');
  const W = api.PV_AUTO_WINDOW_DRAWS;
  assert.ok(api.PV_AUTO_BUDGET_MS <= 1000 / 30, 'the budget is one frame at the display rate, not a whole koma window');
  assert.ok(W * (1 / 12) >= 2, 'a window must cover at least two seconds of komas');

  // One window of pure pressure is a cold start or one heavy cut, and the layer recovers by itself.
  let at = 0;
  let drawn = runDraws(api, W, heavy, at);
  at += W;
  assert.strictEqual(api.state.autoTier, 'full', 'one window must not change the picture');
  assert.strictEqual(firstTierChange(drawn, 'lean'), -1);

  // Two windows is still one song's heavy intro.
  drawn = runDraws(api, W + 1, heavy, at);
  at += W + 1;
  assert.strictEqual(api.state.autoTier, 'full', 'two windows must not change the picture');
  assert.strictEqual(api.state.autoBadStreak, 2);

  // and the streak is gone as soon as a window comes back clean, so a stop-start song never flips.
  runDraws(api, W, light, at);
  assert.strictEqual(api.state.autoBadStreak, 0, 'a clean window must clear the streak');
  assert.strictEqual(api.state.autoTier, 'full', 'the pressure never became sustained');

  // Just under the per-window line, forever.
  const edge = loadTier('auto').api;
  const over = edge.PV_AUTO_ENTER_OVER - 1;
  runDraws(edge, 12 * 60, (i) => (i % edge.PV_AUTO_WINDOW_DRAWS < over ? 25 : 2));
  assert.strictEqual(edge.state.autoTier, 'full', `${over}/${edge.PV_AUTO_WINDOW_DRAWS} blown is not the threshold`);
  assert.strictEqual(edge.state.autoWindows, 30, 'the sampling must run on a whole window, not a sliding tail');
});

test('自动 downgrades once the pressure is sustained, and only on a cut boundary', () => {
  const { api, logs } = loadTier('auto');
  // Five-second cuts, so a frame that blows the budget and a cut boundary are different moments.
  const drawn = runDraws(api, 12 * 30, heavy, 0, 5);
  const decided = drawn.findIndex((d) => d.pending === 'lean');
  assert.ok(decided >= api.PV_AUTO_WINDOW_DRAWS * api.PV_AUTO_ENTER_WINDOWS - 1,
    'the decision needs three sustained windows, not the first bad sample');
  const at = firstTierChange(drawn, 'lean');
  const expected = drawn.findIndex((d, i) => i > decided && d.boundary);
  assert.ok(at > decided, 'the picture waits for the next cut instead of switching mid-cut');
  assert.strictEqual(at, expected, 'and it lands on the very first koma of that cut');
  assert.ok(drawn.slice(decided, at).every((d) => d.tier === 'full'),
    'every frame in between must still draw the full picture');
  assert.strictEqual(changeCount(drawn, 'lean'), 1, 'never more than one downgrade per plan');
  assert.strictEqual(api.state.autoChanges, 1);
  assert.match(logs.join('\n'), new RegExp('\\d+/' + api.PV_AUTO_WINDOW_DRAWS + ' draws over 16\\.7ms, held for 3 windows'),
    'the log must say what was measured and over how long');
  assert.match(logs.join('\n'), /\[PvDrawTier\] full -> lean/, 'and which way it went');
  assert.ok(logs.join('\n').includes('cut '), 'and the cut it landed on');
});

test('a downgrade stays for the plan, and the next plan starts on the full picture', () => {
  const { api, logs } = loadTier('auto');
  runDraws(api, 12 * 60, heavy);
  assert.strictEqual(api.pvDrawTier(), 'lean');
  // A long quiet tail cannot pull it back: while 性能档 is drawn, a cheap frame only proves the
  // downgrade works, so restoring would mean paying for the dropped frames all over again.
  const tail = runDraws(api, 12 * 120, light, 12 * 60);
  assert.ok(tail.every((d) => d.tier === 'lean'), 'recovery cannot be guessed from degraded costs');
  assert.strictEqual(api.state.autoChanges, 1);
  const before = logs.length;
  runDraws(api, 12 * 120, light, 12 * 180);
  assert.strictEqual(logs.length, before, 'a sticky tier must not log every frame it keeps');

  api.pvAutoReset('next song');
  assert.strictEqual(api.pvDrawTier(), 'full', 'the recovery point is the next plan');
  const again = runDraws(api, 12 * 20, heavy);
  assert.ok(firstTierChange(again, 'lean') > 0, 'and the next song is judged on its own evidence');
  assert.strictEqual(api.state.autoChanges, 2);
});

test('a rewind is a fresh listening pass, so 自动 re-judges it', () => {
  const { api } = loadTier('auto');
  runDraws(api, 12 * 60, heavy);
  assert.strictEqual(api.pvDrawTier(), 'lean');
  // The draw site only ever reports one koma back; a rewind of seconds is the user restarting.
  assert.strictEqual(api.pvAutoBoundary(4, 4000), true, 'a rewind lands on a new cut');
  assert.strictEqual(api.state.autoTier, 'full', 'scrubbing back must not keep the picture degraded');
  const drawn = runDraws(api, 12 * 60, heavy);
  assert.ok(firstTierChange(drawn, 'lean') > 0, 'and the pressure is measured again from scratch');
});

test('a manual tier switches the auto machinery off, in both directions', () => {
  for (const mode of ['full', 'lean']) {
    const { api } = loadTier(mode);
    const drawn = runDraws(api, 12 * 120, heavy);
    assert.ok(drawn.every((d) => d.tier === mode), `${mode} is what the user asked for, whatever the cost`);
    assert.strictEqual(api.state.autoPending, '', 'auto must not queue a decision against a manual choice');
    assert.strictEqual(api.state.autoTier, 'full', 'a manual tier must not keep an auto decision in reserve');
  }
  // Choosing 效果档 mid-song is the escape hatch from an automatic downgrade.
  const { api, sandbox } = loadTier('auto');
  runDraws(api, 12 * 60, heavy);
  assert.strictEqual(api.pvDrawTier(), 'lean');
  sandbox.fx.pvDrawQuality = 'full';
  assert.strictEqual(api.pvDrawTier(), 'full', 'the user overrules 自动 immediately');
  runDraws(api, 12 * 60, heavy, 12 * 60);
  assert.strictEqual(api.pvDrawTier(), 'full', 'and 自动 does not sneak back while it is off');
  sandbox.fx.pvDrawQuality = 'auto';
  assert.strictEqual(api.pvDrawTier(), 'full', 'coming back to 自动 re-judges from the full picture');
});

test('a tier the engine cannot draw is given up on, not retried every cut', () => {
  const { api, logs } = loadTier('auto');
  runDraws(api, 12 * 60, heavy);
  assert.strictEqual(api.pvDrawTier(), 'lean');
  api.pvAutoGiveUp('draw:boom');
  assert.strictEqual(api.pvDrawTier(), 'full', 'a throw under 性能档 falls back to the full picture');
  const drawn = runDraws(api, 12 * 120, heavy);
  assert.strictEqual(firstTierChange(drawn, 'lean'), -1, 'and 自动 stops trying for this plan');
  assert.match(logs.join('\n'), /auto disabled: draw:boom/);

  // Rewinding is new evidence about the picture, not about whether the engine can draw the lean
  // options, so the block has to outlast it - otherwise one broken cut throws every few seconds.
  api.pvAutoBoundary(0, 0);
  api.pvAutoReset('rewound');
  assert.strictEqual(api.state.autoBlocked, 'draw:boom', 'a rewind must not re-arm a path that just threw');
  runDraws(api, 12 * 120, heavy, 12 * 120);
  assert.strictEqual(api.pvDrawTier(), 'full');
  // A different song is a different plan, and gets its own chance.
  api.pvAutoNewPlan('plan next');
  assert.strictEqual(api.state.autoBlocked, '', 'a new plan clears the block');
  runDraws(api, 12 * 20, heavy, 12 * 240);
  assert.strictEqual(api.pvDrawTier(), 'lean', 'and 自动 works again on the next song');
});

test('自动 reads no size, resolution or refresh-rate signal', () => {
  const machine = fragment(presetSource, 'var PV_AUTO_WINDOW_DRAWS', '\nfunction pvPresetIsActive', 'auto tier');
  for (const forbidden of ['innerWidth', 'innerHeight', 'devicePixelRatio', 'clientWidth', 'clientHeight',
    'canvas.width', 'screen', 'displayHz', 'estimatedDisplayRefreshHz', 'adaptiveLoadPressureLevel', 'dpr']) {
    assert.ok(!machine.includes(forbidden),
      `自动 must not read ${forbidden}: frame cost tracks glyphs and events, not pixels, and a global ` +
      'pressure level would degrade PV for the background scene');
  }
  assert.match(machine, /pvPresetState\.autoTier/, 'the tier answers from the measured decision only');
});

test('pvCutIndexAt finds the cut the playhead is in and none outside it', () => {
  const { api } = loadTier('auto');
  const cuts = [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 5, end: 7 }];
  assert.strictEqual(api.pvCutIndexAt(cuts, 0), 0);
  assert.strictEqual(api.pvCutIndexAt(cuts, 1.9), 0);
  assert.strictEqual(api.pvCutIndexAt(cuts, 2), -1, 'a gap between cuts is not a cut');
  assert.strictEqual(api.pvCutIndexAt(cuts, 3), 1);
  assert.strictEqual(api.pvCutIndexAt(cuts, 6.99), 2);
  assert.strictEqual(api.pvCutIndexAt(cuts, 7), -1, 'past the last cut is past it');
  assert.strictEqual(api.pvCutIndexAt(cuts, -1), -1);
  assert.strictEqual(api.pvCutIndexAt([], 0), -1);
  assert.strictEqual(api.pvCutIndexAt([{ start: 4 }], 4.5), 0, 'a cut with no end is still a cut');
});

test('the switch does not flap: two seconds of pressure per minute cannot oscillate the picture', () => {
  // Five minutes of a machine that alternates ten heavy seconds with ten quiet ones - the pattern
  // that would turn a per-frame threshold into a strobe light.
  const { api } = loadTier('auto');
  const drawn = runDraws(api, 12 * 300, (i) => (Math.floor(i / 120) % 2 === 0 ? 25 : 2));
  assert.strictEqual(changeCount(drawn, 'lean'), api.state.autoChanges, 'the count must be what the state machine recorded');
  assert.ok(api.state.autoChanges <= 2, `at most two switches in five minutes, saw ${api.state.autoChanges}`);
  assert.strictEqual(drawn[drawn.length - 1].tier, 'lean', 'and a machine that is periodically short of time stays downgraded');
  // Two switches is the ceiling for a whole song: the downgrade, and one reset for a reason.
  api.pvAutoReset('next song');
  runDraws(api, 12 * 300, (i) => (Math.floor(i / 120) % 2 === 0 ? 25 : 2), 12 * 300);
  assert.ok(api.state.autoChanges <= 4, 'a second five-minute stretch costs at most two more switches');
});

// The tier block above is tested as a state machine; this loads the whole preset module behind a
// fake engine and a fake clock, so the lines that decide what `renderer.frame` is handed are
// executed rather than pattern-matched. The clock only advances inside the fake renderer, which
// makes every measured cost exact instead of whatever the test machine happened to be doing.
function loadLive({ pvDrawQuality = 'auto', heavyDraws = Infinity, throwAt = -1 } = {}) {
  const layer = { clientWidth: 1200, clientHeight: 800 };
  const canvas = {
    width: 0, height: 0, style: {}, clientWidth: 1200, clientHeight: 800,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
  };
  const sandbox = {
    document: { getElementById: (id) => (id === 'pv-layer' ? layer : id === 'pv-canvas' ? canvas : null), createElement: () => canvas },
    window: { devicePixelRatio: 1 },
    performance: { now: () => sandbox.__clock },
    audio: { currentTime: 0 },
    fx: { preset: 13, pvDrawQuality },
    __clock: 0,
  };
  sandbox.normalizePvDrawQuality = vm.runInNewContext(
    `${fragment(persistenceSource, 'function normalizePvDrawQuality(v) {', '\n}\n', 'normalizePvDrawQuality')}\n}\n;normalizePvDrawQuality`,
    { fxDefaults: fxDefaultsObject() },
  );
  const seen = [];
  const api = vm.runInNewContext(
    `${presetSource}\n;({ pvDrawLayerFrame: pvDrawLayerFrame, pvPresetState: pvPresetState, pvPresetStatus: pvPresetStatus, pvDrawTier: pvDrawTier })`,
    sandbox,
  );
  // 1200x800 over a 1000x800 design crops too much to cover, so the fit is contain at scale 1.
  api.pvPresetState.plan = { W: 1000, H: 800, cuts: [] };
  api.pvPresetState.renderer = {
    frame: (ctx, plan, t, opt) => {
      if (seen.length === throwAt) throw new Error('engine said no');
      seen.push({ t, opt });
      sandbox.__clock += seen.length <= heavyDraws ? 25 : 1;
    },
  };
  return { api, sandbox, seen, canvas };
}

// Five-second cuts, so a blown frame and a cut boundary are different draws.
function driveCuts(live, draws) {
  const cuts = [];
  for (let i = 0; i < Math.ceil(draws / 60) + 1; i++) cuts.push({ start: i * 5, end: (i + 1) * 5 });
  live.api.pvPresetState.plan.cuts = cuts;
  const tiers = [];
  for (let i = 0; i < draws; i++) {
    live.sandbox.audio.currentTime = i / 12;
    live.api.pvDrawLayerFrame(live.canvas, i * 83.3);
    tiers.push(live.seen[i] && live.seen[i].opt);
  }
  return tiers;
}

test('the preset module hands the engine the tier it decided, at the frame boundary and nowhere else', () => {
  const live = loadLive({ heavyDraws: 100000 });
  const opts = driveCuts(live, 140);
  assert.deepStrictEqual(plain(opts[0]), { scale: 1 }, 'the first koma draws the full picture');
  const firstLean = opts.findIndex((o) => o && o.fast === true);
  assert.strictEqual(firstLean, 120, 'three windows of blown frames decide it, and the t=10s cut is the first frame allowed to change');
  assert.ok(opts.slice(0, 120).every((o) => o && !o.fast && !o.noTrans), 'no frame before the boundary may be degraded');
  assert.deepStrictEqual(plain(opts[121]), { scale: 1, fast: true, noTrans: true });
  const status = live.api.pvPresetStatus();
  assert.strictEqual(status.tier, 'lean');
  assert.strictEqual(status.auto.changes, 1);
  assert.match(status.auto.log, /\[PvDrawTier\] full -> lean: \d+\/24 draws over 16\.7ms, held for 3 windows \(cut 2\)/);
  assert.strictEqual(live.api.pvPresetState.cutIndex, 2, 'the cut cursor follows the playhead');
});

test('an engine that refuses the degraded options drops the renderer and stops asking for it', () => {
  const live = loadLive({ heavyDraws: 100000, throwAt: 125 });
  driveCuts(live, 130);
  const status = live.api.pvPresetStatus();
  assert.strictEqual(status.hasRenderer, false, 'the throw path still drops the renderer for the retry window');
  assert.match(status.planError, /^draw:engine said no$/);
  assert.strictEqual(status.auto.blocked, 'draw:engine said no', 'and names the tier that could not be drawn');
  assert.strictEqual(status.tierNow, 'full', 'the next frame must draw the full picture again');
  assert.strictEqual(status.auto.changes, 1, 'a failed downgrade does not count as another switch');
});

test('the tier is wired through persistence, archives, panel and the console', () => {
  const html = read('public/index.html');
  assert.match(html, /id="pv-draw-quality-seg"/);
  for (const mode of ['auto', 'full', 'lean']) {
    assert.ok(html.includes(`data-pv-draw-quality="${mode}"`), `missing the ${mode} button`);
  }
  assert.match(persistenceSource, /pvDrawQuality: normalizePvDrawQuality\(raw\.pvDrawQuality\)/, 'load path');
  assert.match(persistenceSource, /pvDrawQuality: normalizePvDrawQuality\(fx\.pvDrawQuality\)/, 'save path');
  assert.match(persistenceSource, /pvDrawQuality: \['pvDrawQuality'\]/, 'touched-keys map');
  const archive = read('public/js/modules/07-fx/00-preset-archive-data.js');
  assert.match(archive, /'gestureSensitivity',\n\s*'pvDrawQuality'\n\];/, 'MR2 fields must stay append-only');
  assert.match(archive, /pvDrawQuality: normalizePvDrawQuality\(raw\.pvDrawQuality\)/, 'archive apply path');
  const panel = read('public/js/modules/07-fx/05-fx-panel-performance.js');
  assert.match(panel, /function setPvDrawQualityMode\(mode, silent\)/);
  assert.match(panel, /reason: 'pvDrawQuality'/);
  assert.match(panel, /#pv-draw-quality-seg \[data-pv-draw-quality\]/);
  const bindings = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
  assert.match(bindings, /#pv-draw-quality-seg \[data-pv-draw-quality\][\s\S]{0,160}setPvDrawQualityMode/);
  const workspace = read('public/js/modules/07-fx/09-console-workspace.js');
  assert.match(workspace, /fxConsoleItem\('pv-draw-quality-seg'/);
  const packaged = JSON.parse(read('public/default-user-fx-archive.json'));
  assert.strictEqual(packaged.snapshot.pvDrawQuality, 'auto', 'packaged first-launch archive must match the default');
});
