const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's own module runs here, not a copy of its logic: the sandbox only supplies
// the browser pieces it reaches for (a canvas, a viewport, the lyric list). Everything
// that decides when the ring turns and how big a lyric line is drawn comes from the
// shipped file, so this test goes red if that file goes back to the old behaviour.

const modulePath = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

function makeRecordingContext() {
  const calls = [];
  const stack = [];
  let state = { scaleX: 1, scaleY: 1, font: '' };
  return {
    calls,
    save() { stack.push(Object.assign({}, state)); },
    restore() { state = stack.pop() || state; },
    translate(x, y) { calls.push({ op: 'translate', x, y }); },
    rotate(a) { calls.push({ op: 'rotate', a }); },
    scale(x, y) { state.scaleX *= x; state.scaleY *= y; calls.push({ op: 'scale', x, y }); },
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    fillText(text, x, y) { calls.push({ op: 'fillText', text, x, y, scale: state.scaleX, font: state.font }); },
    measureText(text) { return { width: text.length * 12 }; },
    clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
    fill() {}, stroke() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, ellipse() {}, clip() {}, setTransform() {},
    drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; },
    putImageData() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; }
  };
}

const drawContext = makeRecordingContext();
const canvas = { width: 1920, height: 1080, getContext: () => drawContext };

const sandbox = {
  console,
  Math, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
  parseFloat, parseInt, Set, Map, Uint8ClampedArray,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  devicePixelRatio: 1,
  innerWidth: 1920,
  innerHeight: 1080,
  document: {
    getElementById: (id) => (id === 'halo-canvas' ? canvas : null),
    createElement: () => canvas,
    addEventListener() {},
    body: { appendChild() {} }
  },
  fx: { lyricScale: 1 },
  playQueue: [],
  currentIdx: -1,
  lyricsLines: [],
  lyricsTranslationLines: []
};
sandbox.window = {
  addEventListener() {}, removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {} },
  devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
  document: sandbox.document
};
sandbox.self = sandbox.window;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: modulePath });

// The knob store the console writes, so the tests can move a knob and watch the ring.
const tuning = {};
for (const key of Object.keys(sandbox.HALO_TUNING_SCHEMA)) tuning[key] = sandbox.HALO_TUNING_SCHEMA[key].def;
sandbox.haloTuning = tuning;

// The viewport the default knobs describe: 1920x1080, the ring's centre off screen left.
function layoutViewport() {
  const s = sandbox.haloState;
  s.w = 1920;
  s.h = 1080;
  s.cx = s.w * sandbox.haloParam('centerX');
  s.cy = s.h * sandbox.haloParam('centerY');
  s.R = Math.max(24, s.w * sandbox.haloParam('radiusK'));
  s.band = s.R * sandbox.haloParam('bandK');
  s.RO = s.R + s.band;
  s.ringRot = 0;
  s.shakeX = 0;
  s.shakeY = 0;
  s.basePanX = 0;
  s.basePanY = 0;
  sandbox.haloCam.panX = 0;
  sandbox.haloCam.panY = 0;
  sandbox.haloCam.zoom = 1;
}

// ------------------------------------------------------------------ the ring turn
sandbox.lyricsLines = [
  { t: 10, text: 'first line of the song' },
  { t: 14, text: 'second line of the song' },
  { t: 18, text: 'third line of the song' }
];
sandbox.haloBuildLyricRing();
assert.strictEqual(sandbox.haloLyric.items.length, 3, 'the three lyric lines are on the ring');

const rotDur = sandbox.haloParam('rotDur');
const rotLead = sandbox.haloParam('rotLead');

// Walk the clock and catch the turn that aims at the second line.
let turn = null;
let turnStartedAt = null;
for (let t = 0; t <= 20; t += 1 / 120) {
  sandbox.haloLyricUpdate(t);
  if (sandbox.haloLyric.tween && sandbox.haloLyric.tween.item === 1 && !turn) {
    turn = sandbox.haloLyric.tween;
    turnStartedAt = t;
  }
}

assert(turn, 'a turn towards the second line must happen');
assert(
  Math.abs(turn.dur - rotDur) < 1e-9,
  `the turn must last the 转环时长 knob (${rotDur}), not ${turn.dur}`
);
assert(turn.dur > 0.3, 'the turn must not collapse onto the old 0.08 s floor');
assert(
  Math.abs(turnStartedAt - (14 - rotLead)) < 0.02,
  `the turn must start ${rotLead} s before the line, not after it (started at ${turnStartedAt})`
);

// The line must land on the read mark when the turn is done.
sandbox.haloLyricUpdate(20);
const screenAngle = sandbox.haloLyric.rot + sandbox.haloLyric.items[sandbox.haloLyric.current].angle;
assert(
  Math.abs(screenAngle - sandbox.haloReadAngle()) < 1e-6,
  'the sung line must sit on the read mark when the turn finishes'
);

// A bigger knob has to mean a slower turn.
sandbox.haloTuning.rotDur = 1.5;
sandbox.haloTuning.rotLead = 0.4;
sandbox.haloBuildLyricRing();
let longTurn = null;
for (let t = 0; t <= 20; t += 1 / 120) {
  sandbox.haloLyricUpdate(t);
  if (sandbox.haloLyric.tween && sandbox.haloLyric.tween.item === 1 && !longTurn) {
    longTurn = sandbox.haloLyric.tween;
  }
}
assert(longTurn, 'the longer turn must happen as well');
assert(Math.abs(longTurn.dur - 1.5) < 1e-9, `a 1.5 s knob must give a 1.5 s turn, not ${longTurn.dur}`);
sandbox.haloTuning.rotDur = rotDur;
sandbox.haloTuning.rotLead = rotLead;

// --------------------------------------------------------------- the lyric fit
sandbox.lyricsLines = [];
for (let i = 0; i < 48; i++) {
  sandbox.lyricsLines.push({ t: i * 4, text: `line ${i} of the song, a fairly long line of words` });
}
sandbox.haloBuildLyricRing();
layoutViewport();

const items = sandbox.haloLyric.items;
assert(
  items.every((item) => item.scale === undefined),
  'the fit must not be baked into the item when the ring is built'
);
assert(
  items.every((item) => isFinite(item.textWidth) && item.textWidth > 0),
  'the item keeps the width the text was measured at'
);

function drawAndReadScales(ringRot) {
  sandbox.haloState.ringRot = ringRot;
  drawContext.calls.length = 0;
  sandbox.haloDrawLyricText(drawContext);
  const scales = new Map();
  for (const call of drawContext.calls) {
    if (call.op === 'fillText' && !scales.has(call.text)) scales.set(call.text, call.scale);
  }
  return scales;
}

const scalesBefore = drawAndReadScales(0);
const drawn = Array.from(scalesBefore.values());
assert(drawn.length > 0, 'some lines must be drawn');
assert(
  drawn.every((scale) => scale >= 0.5 - 1e-9),
  `no drawn line may shrink below the 0.5 floor (smallest was ${Math.min.apply(null, drawn)})`
);
assert(
  drawn.every((scale) => scale <= 1 + 1e-9),
  'no line may be scaled up past its size'
);

// The same line must be able to change its scale as the ring turns: a scale frozen at
// build time is what made the lyrics shrink for the rest of the song.
const scalesAfter = drawAndReadScales(0.9);
let moved = 0;
for (const [text, scale] of scalesBefore) {
  if (!scalesAfter.has(text)) continue;
  if (Math.abs(scalesAfter.get(text) - scale) > 1e-6) moved += 1;
}
assert(moved > 0, 'the fit must be taken when the line is drawn, not frozen when it was built');

console.log('[OK] The ring turn lasts the 转环时长 knob and the lyric fit is taken at draw time.');
