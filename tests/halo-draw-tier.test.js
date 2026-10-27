'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

// The ring's own module runs here, not a copy of its logic: the sandbox only supplies the
// browser pieces it reaches for. The shipped draw function is what decides which parts of the
// frame are painted, and the spies below only count the calls it makes - so a tier that
// quietly stopped painting the haze, or started painting the lyrics at half the size, turns
// this red.
//
// The tier's cheaper picture is the same picture at fewer pixels, so the canvas is the thing
// under test: 效果档 draws it at every pixel, 性能档 at three quarters of them, and the size
// of the drawing has to follow the size of the canvas.
//
// The probe is the 自动 tier's evidence, and it measures the frame the app draws on the canvas
// that is on screen - so the sandbox's canvas has to behave like a GPU canvas: the drawing is
// recorded and paid for at the readback, not when it is called.

const modulePath = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

const PARTS = ['haloDrawWeb', 'haloDrawComets', 'haloDrawEmits', 'haloDrawHaze', 'haloDrawStrands',
  'haloDrawFlyers', 'haloDrawFlares', 'haloDrawRing', 'haloDrawLyricText'];

const BUDGET_MS = 1000 / 30;

// The sandbox's clock. The drawing and the readback can be made to cost time, so the probe
// has something to measure.
//
// The drawing is not paid when it is recorded - that is the whole point of the probe: on a
// GPU canvas the calls are recorded and rasterised later. The readback is what waits for
// the rasterisation, so a readback costs the transfer plus whatever was drawn since the
// last one. That is what makes the probe's difference real.
function makeClock() {
  return { t: 0, drawMs: 0, readbackMs: 0, pending: 0, ops: 0, readbackFails: false };
}

function makeRecordingContext(clock) {
  const calls = [];
  const stack = [];
  let state = { scaleX: 1, scaleY: 1, font: '' };
  const draw = () => { clock.pending += clock.drawMs; clock.ops += 1; };
  const ctx = {
    calls,
    save() { stack.push(Object.assign({}, state)); },
    restore() { state = stack.pop() || state; },
    translate() { draw(); }, rotate() { draw(); },
    scale(x, y) { state.scaleX *= x; state.scaleY *= y; },
    font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
    lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', lineCap: 'butt',
    filter: 'none', shadowBlur: 0, shadowColor: '',
    fillText(text, x, y) { draw(); calls.push({ op: 'fillText', text }); },
    measureText(text) { return { width: text.length * 12 }; },
    clearRect() { draw(); }, fillRect() { draw(); },
    strokeRect() {}, beginPath() {}, closePath() {},
    fill() { draw(); }, stroke() { draw(); },
    moveTo() {}, lineTo() {}, arc() {}, rect() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, ellipse() {}, clip() {}, setTransform() {},
    drawImage() { draw(); },
    getImageData() {
      if (clock.readbackFails) throw new Error('the readback is not allowed');
      const wait = clock.readbackMs + clock.pending;
      clock.pending = 0;
      clock.t += wait;
      return { data: new Uint8ClampedArray(4) };
    },
    putImageData() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
  };
  return ctx;
}

class FakePath2D {
  constructor() { this.ops = 0; }
  moveTo() { this.ops++; }
  lineTo() { this.ops++; }
  arc() { this.ops++; }
  closePath() {}
}

function loadHalo({ pvDrawQuality = 'auto', readbackMs = 0 } = {}) {
  const clock = makeClock();
  clock.readbackMs = readbackMs;
  const drawContext = makeRecordingContext(clock);
  const canvas = {
    width: 1920, height: 1080, style: {}, parentNode: null,
    getContext: () => drawContext,
  };
  const layer = {
    clientWidth: 1920, clientHeight: 1080, className: '',
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(child) { child.parentNode = this; },
    removeChild(child) { child.parentNode = null; },
  };
  let canvasesMade = 0;
  const sandbox = {
    console,
    Math, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
    parseFloat, parseInt, Set, Map, Uint8ClampedArray, Path2D: FakePath2D,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: () => clock.t },
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
    document: {
      getElementById: (id) => (id === 'halo-canvas' ? canvas : (id === 'halo-layer' ? layer : null)),
      createElement: (tag) => {
        if (tag === 'canvas') canvasesMade += 1;
        return { width: 0, height: 0, style: {}, parentNode: null, getContext: () => drawContext };
      },
      addEventListener() {},
      body: { appendChild() {} },
    },
    fx: { preset: 14, lyricScale: 1, pvDrawQuality },
    playQueue: [{ id: 'x' }],
    currentIdx: 0,
    lyricsLines: [{ t: 0, text: 'hello' }],
    lyricsTranslationLines: [],
    currentBeatMap: { beats: [] },
    sonicAudioMonitorState: { frame: null },
    lyricTimingSongKey: () => 'x',
    getActiveLyricTimingOffsetSeconds: () => 0,
    normalizePvDrawQuality: (v) => (v === 'full' || v === 'lean' ? v : 'auto'),
  };
  sandbox.window = {
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
    document: sandbox.document,
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: modulePath });

  // Spies: the shipped functions are wrapped, not replaced, so the frame still draws itself
  // and the test only learns which parts it asked for.
  const calls = {};
  for (const name of PARTS) {
    const original = sandbox[name];
    calls[name] = 0;
    sandbox[name] = function () { calls[name] += 1; return original.apply(this, arguments); };
  }
  // The knobs are the user's; a tier must not write them.
  const tuning = {};
  for (const key of Object.keys(sandbox.HALO_TUNING_SCHEMA)) tuning[key] = sandbox.HALO_TUNING_SCHEMA[key].def;
  sandbox.haloTuning = tuning;
  sandbox.haloResize();
  sandbox.haloBuildLyricRing();
  return { sandbox, calls, canvas, drawContext, tuning, clock, layer, canvasesMade: () => canvasesMade };
}

// The app's own path: the frame goes through the gate, the tier and the canvas.
function drawFrame(h, now) {
  const before = {};
  for (const name of PARTS) before[name] = h.calls[name];
  h.sandbox.haloRenderFrame(h.canvas, now === undefined ? 1000 : now, 1 / 30);
  const drawn = {};
  for (const name of PARTS) drawn[name] = h.calls[name] - before[name];
  return drawn;
}

// The sandbox's drawing costs a fixed amount per call, so the frame's cost is that times the
// number of calls. The count is measured from a frame that was really drawn, so the test does
// not have to know how many calls the picture is made of.
function setFrameCost(h, ms) {
  h.clock.drawMs = 0;
  const before = h.clock.ops;
  drawFrame(h, 1000);
  const ops = h.clock.ops - before;
  h.clock.drawMs = ms / ops;
  return ops;
}

// One window is 60 of the ring's frames. The first frame only starts the clock, so a window
// is 61 calls; the gap between the frames is what the tier watches.
function feedWindows(s, windows, gapMs) {
  let t = s.haloPresetState.autoLastAt || 1000;
  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < 61; i++) {
      t += gapMs;
      s.haloAutoObserve(t);
    }
  }
  return t;
}

// The probe measures the frames the app draws, so the test has to draw them.
function runProbe(h, frames, from) {
  const s = h.sandbox;
  let t = from === undefined ? (s.haloPresetState.autoLastAt || 1000) : from;
  for (let i = 0; i < (frames === undefined ? 7 : frames); i++) {
    t += 33;
    drawFrame(h, t);
  }
  return t;
}

test('效果档 paints the whole frame', () => {
  const h = loadHalo({ pvDrawQuality: 'full' });
  const drawn = drawFrame(h);
  for (const name of PARTS) {
    assert.ok(drawn[name] > 0, name + ' must be drawn in 效果档');
  }
});

test('效果档 draws the canvas at every pixel', () => {
  const h = loadHalo({ pvDrawQuality: 'full' });
  drawFrame(h);
  assert.strictEqual(h.canvas.width, 1920);
  assert.strictEqual(h.canvas.height, 1080);
  assert.strictEqual(h.sandbox.haloTierScale, 1);
});

test('性能档 keeps the whole picture', () => {
  const h = loadHalo({ pvDrawQuality: 'lean' });
  const drawn = drawFrame(h);
  for (const name of PARTS) {
    assert.ok(drawn[name] > 0, name + ' is the picture and must survive 性能档');
  }
});

test('性能档 draws the same picture at fewer pixels', () => {
  const h = loadHalo({ pvDrawQuality: 'lean' });
  drawFrame(h);
  assert.strictEqual(h.sandbox.haloTierScale, 0.75);
  assert.strictEqual(h.canvas.width, 1440);
  assert.strictEqual(h.canvas.height, 810);
  // The canvas is stretched back to the layer by the CSS, so the picture keeps its place on
  // screen: only the resolution it is rasterised at changed.
  assert.strictEqual(h.canvas.style.width, '100%');
  assert.strictEqual(h.canvas.style.height, '100%');
});

test('性能档 does not touch the knobs the user set', () => {
  const h = loadHalo({ pvDrawQuality: 'lean' });
  const before = JSON.stringify(h.tuning);
  drawFrame(h);
  assert.strictEqual(JSON.stringify(h.tuning), before, 'the tier must not write the tuning knobs');
});

test('自动 starts at the full picture', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const drawn = drawFrame(h);
  assert.ok(drawn.haloDrawHaze > 0, '自动 must not degrade before there is evidence');
  assert.strictEqual(h.sandbox.haloTier(), 'full');
  assert.strictEqual(h.canvas.width, 1920);
});

test('自动 asks the probe before it degrades', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 48);
  feedWindows(s, 2, 100);
  assert.strictEqual(s.haloPresetState.probePending, false, 'the probe is only asked after the pressure holds');
  feedWindows(s, 1, 100);
  assert.strictEqual(s.haloPresetState.probePending, true, 'the probe is what decides, so it is asked');
  assert.strictEqual(s.haloPresetState.autoTier, 'full', 'nothing is changed before the probe answers');
  runProbe(h);
  assert.strictEqual(s.haloPresetState.probeVerdict, 'over');
  assert.strictEqual(s.haloPresetState.autoPending, 'lean');
  assert.strictEqual(s.haloPresetState.autoTier, 'full', 'the change waits for the boundary');
});

test('自动 keeps the picture when the probe says the ring is not the cause', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 12);
  feedWindows(s, 3, 100);
  runProbe(h);
  assert.strictEqual(s.haloPresetState.probeVerdict, 'within');
  assert.strictEqual(s.haloPresetState.autoPending, '', 'a ring that fits its budget is not degraded');
  assert.strictEqual(s.haloPresetState.autoTier, 'full');
});

test('a probe that fails keeps the full picture', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  feedWindows(s, 3, 100);
  h.clock.readbackFails = true;
  runProbe(h);
  assert.strictEqual(s.haloPresetState.probeVerdict, 'failed');
  assert.strictEqual(s.haloPresetState.autoPending, '', 'a failed measurement is not evidence');
  assert.strictEqual(s.haloPresetState.autoTier, 'full');
});

test('the probe measures the cost the picture really costs', () => {
  // The sandbox's readback costs 4ms; the probe must report the drawing and not the readback.
  const h = loadHalo({ pvDrawQuality: 'auto', readbackMs: 4 });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 48);
  feedWindows(s, 3, 100);
  runProbe(h);
  const cost = s.haloPresetState.probeCost;
  assert.ok(cost > h.clock.readbackMs, 'the probe must measure the drawing, got ' + cost);
  assert.ok(cost < BUDGET_MS * 2, 'the probe must measure one frame, got ' + cost);
  assert.ok(cost > 30, 'the probe must report the frame it was given, got ' + cost);
  assert.strictEqual(s.haloPresetState.probeError, '');
});

test('the probe measures the canvas that is on screen', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 48);
  feedWindows(s, 3, 100);
  const before = h.canvasesMade();
  runProbe(h);
  assert.strictEqual(h.canvasesMade(), before, 'the probe must not draw into a throwaway canvas');
});

test('the change lands on a line boundary', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 48);
  s.haloLyric.current = 0;
  s.haloAutoBoundary(10, 1000);
  feedWindows(s, 3, 100);
  runProbe(h);
  assert.strictEqual(s.haloPresetState.autoPending, 'lean');
  assert.strictEqual(s.haloPresetState.autoTier, 'full', 'the decision waits for the boundary');

  // Still the same line: the tier may not land in the middle of it.
  s.haloAutoBoundary(11, 1100);
  assert.strictEqual(s.haloPresetState.autoTier, 'full', 'the change must wait for a line boundary');

  s.haloLyric.current = 1;
  s.haloAutoBoundary(12, 1200);
  assert.strictEqual(s.haloPresetState.autoTier, 'lean', 'the change lands on the line boundary');
  assert.strictEqual(s.haloPresetState.autoPending, '');
  assert.ok(/\[HaloDrawTier\]/.test(s.haloPresetState.autoLog), 'the reason must be logged');
});

test('the change lands on the canvas too', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 48);
  s.haloLyric.current = 0;
  s.haloAutoBoundary(10, 1000);
  feedWindows(s, 3, 100);
  runProbe(h);
  s.haloLyric.current = 1;
  s.haloAutoBoundary(12, 1200);
  assert.strictEqual(s.haloPresetState.autoTier, 'lean');
  drawFrame(h, 2000);
  assert.strictEqual(h.canvas.width, 1440, 'the picture is drawn at the cheaper resolution');
  assert.strictEqual(s.haloTierScale, 0.75);
});

test('a light window clears the streak', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  feedWindows(s, 1, 100);
  assert.strictEqual(s.haloPresetState.autoBadStreak, 1);
  feedWindows(s, 1, 10);
  assert.strictEqual(s.haloPresetState.autoBadStreak, 0, 'one quiet window ends the streak');
});

test('choosing a tier by hand drops the automatic decision', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 48);
  feedWindows(s, 3, 100);
  runProbe(h);
  assert.strictEqual(s.haloPresetState.autoPending, 'lean');
  s.fx.pvDrawQuality = 'full';
  assert.strictEqual(s.haloTier(), 'full');
  assert.strictEqual(s.haloPresetState.autoPending, '', 'a manual choice drops the queued decision');
  assert.strictEqual(s.haloPresetState.autoTier, 'full');
});

test('a rewind starts the judgement over', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 48);
  s.haloLyric.current = 0;
  s.haloAutoBoundary(10, 1000);
  feedWindows(s, 3, 100);
  runProbe(h);
  s.haloPresetState.lastT = 30;
  s.haloAutoBoundary(10, 2000);
  assert.strictEqual(s.haloPresetState.autoTier, 'full', 'a rewind is new evidence');
  assert.strictEqual(s.haloPresetState.autoPending, '');
});

test('a new song starts the judgement over', () => {
  const h = loadHalo({ pvDrawQuality: 'auto' });
  const s = h.sandbox;
  s.haloAutoReset();
  setFrameCost(h, 48);
  feedWindows(s, 3, 100);
  runProbe(h);
  s.haloPresetState.autoPending = 'lean';
  s.lyricsLines = [{ t: 0, text: 'another song' }];
  s.haloBuildLyricRing();
  assert.strictEqual(s.haloPresetState.autoTier, 'full', 'a new lyric list is new evidence');
  assert.strictEqual(s.haloPresetState.autoPending, '');
});

test('the status tells the console which tier is in force', () => {
  const h = loadHalo({ pvDrawQuality: 'lean' });
  drawFrame(h);
  const status = h.sandbox.haloPresetStatus();
  assert.strictEqual(status.tierSetting, 'lean');
  assert.strictEqual(status.tierNow, 'lean');
  assert.strictEqual(status.scale, 0.75);
  assert.strictEqual(status.auto.windowFrames, 60);
  assert.strictEqual(status.auto.budgetMs, 33.3);
});
