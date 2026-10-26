const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's own module runs here, not a copy of its logic: the sandbox only supplies
// the browser pieces it reaches for (a canvas, a viewport, the lyric list). Everything
// that decides when the ring turns, what the screen shows of it and how big a lyric
// line is drawn comes from the shipped file, so this test goes red if that file goes
// back to the old behaviour.

// The module under test is the shipped one, unless a mutation run points the test at a
// copy (the driver in tmp/ does that to prove the test can go red).
const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

function makeRecordingContext() {
  const calls = [];
  const stack = [];
  let state = { scaleX: 1, scaleY: 1, font: '' };
  const ctx = {
    calls,
    save() { stack.push(Object.assign({}, state)); },
    restore() { state = stack.pop() || state; },
    translate(x, y) { calls.push({ op: 'translate', x, y }); },
    rotate(a) { calls.push({ op: 'rotate', a }); },
    scale(x, y) { state.scaleX *= x; state.scaleY *= y; calls.push({ op: 'scale', x, y }); },
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
  // The font the row was drawn with is part of what the test reads back.
  Object.defineProperty(ctx, 'font', {
    get() { return state.font; },
    set(value) { state.font = value; }
  });
  return ctx;
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

// The viewport the shipped knobs describe: 1920x1080 and the ring's centre off screen
// left, so only the ring's right side shows. The layout comes from the module itself,
// otherwise the test would be measuring a framing the app never draws.
const VIEW_W = 1920;
const VIEW_H = 1080;
sandbox.haloLayoutStage(VIEW_W, VIEW_H);
sandbox.haloState.ringRot = 0;
sandbox.haloState.shakeX = 0;
sandbox.haloState.shakeY = 0;
sandbox.haloCam.panX = 0;
sandbox.haloCam.panY = 0;
sandbox.haloCam.zoom = 1;

// Where the ring's centre sits on the screen, in pixels.
function centreOnScreen() {
  const s = sandbox.haloState;
  return {
    x: s.w / 2 - sandbox.haloCam.zoom * sandbox.haloPanTotalX() + s.shakeX,
    y: s.h / 2 - sandbox.haloCam.zoom * sandbox.haloPanTotalY() + s.shakeY
  };
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

// ------------------------------------------- the visible radius starts at the centre
// The screen reaches a given direction out to the distance from the ring's centre to
// the viewport edge. Measured from the world origin instead (the transform's own
// offset) the answer is a different point on the screen, and everything culled against
// it - the decorations, the streaks, the lyric lines - keeps the wrong rays.
{
  const centre = centreOnScreen();
  const right = sandbox.haloVisibleRadius(0);
  const expectedRight = (VIEW_W - centre.x) / sandbox.haloSceneZoom(1);
  assert(
    Math.abs(right - expectedRight) < 1e-6,
    `the visible radius must be measured from the ring's centre (${expectedRight}), not ${right}`
  );
  const up = sandbox.haloVisibleRadius(-Math.PI / 2);
  const expectedUp = centre.y / sandbox.haloSceneZoom(1);
  assert(
    Math.abs(up - expectedUp) < 1e-6,
    `the visible radius upwards must be measured from the ring's centre (${expectedUp}), not ${up}`
  );
  assert(
    sandbox.haloVisibleRadius(Math.PI) === 0,
    'a ray pointing away from the screen has no room at all'
  );
}

// --------------------------------------------------------------- the lyric fit
sandbox.lyricsLines = [];
for (let i = 0; i < 48; i++) {
  sandbox.lyricsLines.push({ t: i * 4, text: `line ${i} of the song, a fairly long line of words` });
}
sandbox.haloBuildLyricRing();
// A row has to be the sung one, or the "the sung row is the only one that may be
// squeezed" rule never runs and a regression in it would pass unnoticed.
sandbox.haloLyric.current = 3;

const items = sandbox.haloLyric.items;
assert(
  items.every((item) => item.scale === undefined),
  'the fit must not be baked into the item when the ring is built'
);
assert(
  items.every((item) => isFinite(item.textWidth) && item.textWidth > 0),
  'the item keeps the width the text was measured at'
);

const textR = sandbox.haloState.RO + sandbox.haloParam('textGap');

// The screen point a line's first glyph sits on, and whether the screen shows it.
function anchorOnScreen(angle) {
  const s = sandbox.haloState;
  const z = sandbox.haloSceneZoom(1);
  const centre = centreOnScreen();
  const x = centre.x + z * textR * Math.cos(angle);
  const y = centre.y + z * textR * Math.sin(angle);
  return {
    x,
    y,
    inside: x > 0 && x < s.w && y > 0 && y < s.h
  };
}

function drawAndReadRows(ringRot) {
  sandbox.haloState.ringRot = ringRot;
  drawContext.calls.length = 0;
  sandbox.haloDrawLyricText(drawContext);
  const rows = new Map();
  for (const call of drawContext.calls) {
    if (call.op === 'fillText' && !rows.has(call.text)) rows.set(call.text, call.scale);
  }
  return rows;
}

// The size the row was drawn with, in pixels, out of the font string.
function fontPxOf(call) {
  const match = /(\d+(?:\.\d+)?)px/.exec(call.font || '');
  return match ? Number(match[1]) : NaN;
}

const rowsBefore = drawAndReadRows(0);
const drawnTexts = Array.from(rowsBefore.keys());
assert(drawnTexts.length > 1, 'the lines that are really on screen must be drawn, not just one');

// Every row is drawn with the same font size: the list must not have rows of different
// sizes depending on where they sit in the fan.
{
  const rowTexts = new Set(items.map((item) => item.text));
  const sizes = drawContext.calls
    .filter((call) => call.op === 'fillText' && rowTexts.has(call.text))
    .map(fontPxOf);
  assert(sizes.length > 0, 'some rows must be drawn');
  const smallest = Math.min.apply(null, sizes);
  const largest = Math.max.apply(null, sizes);
  assert(
    Math.abs(largest - smallest) < 1e-9,
    `every drawn row must use the same font size (smallest ${smallest}, largest ${largest})`
  );
}

// What is drawn and what the screen shows must be the same set: a line whose first
// glyph is on screen belongs on the ring, and a line whose glyphs are off screen does
// not. The old cull measured from the world origin, so it drew the rows that had
// rotated off the bottom and dropped the rows that were on screen.
{
  const onScreen = items.filter((item) => anchorOnScreen(item.angle + sandbox.haloState.ringRot).inside);
  const onScreenTexts = onScreen.map((item) => item.text);
  for (const text of onScreenTexts) {
    assert(rowsBefore.has(text), `the line "${text}" is on screen and must be drawn`);
  }
  assert.strictEqual(
    drawnTexts.length,
    onScreenTexts.length,
    `exactly the lines on screen are drawn (${drawnTexts.length} drawn, ${onScreenTexts.length} on screen)`
  );
}

// Every row keeps the size the app's lyric knob asks for: a list whose rows grow and
// shrink as the ring turns is what the user complained about.
{
  const scales = Array.from(rowsBefore.values());
  const smallest = Math.min.apply(null, scales);
  const largest = Math.max.apply(null, scales);
  assert(
    Math.abs(largest - 1) < 1e-9 && Math.abs(smallest - 1) < 1e-9,
    `no drawn row may be scaled (smallest ${smallest}, largest ${largest})`
  );
}

// The same row keeps its size while the ring turns under it: the rows that enter and
// leave the visible arc may change, the rows that stay must not change size.
const rowsAfter = drawAndReadRows(0.9);
assert(
  rowsAfter.size !== rowsBefore.size,
  'turning the ring must bring other rows into view'
);
for (const [text, scale] of rowsBefore) {
  if (!rowsAfter.has(text)) continue;
  assert(
    Math.abs(rowsAfter.get(text) - scale) < 1e-9,
    `the row "${text}" must not change size when the ring turns`
  );
}

// A line longer than its ray cannot be shown whole. The sung line is squeezed to the
// floor so it stays readable, the others keep their size and run off the screen edge
// the way a list scrolls off its container.
{
  const longText = 'L'.repeat(300);
  sandbox.lyricsLines = [
    { t: 0, text: 'a short line' },
    { t: 4, text: longText }
  ];
  sandbox.haloBuildLyricRing();
  sandbox.haloLyric.current = 1;
  sandbox.haloState.ringRot = 0;
  drawContext.calls.length = 0;
  sandbox.haloDrawLyricText(drawContext);
  const longRow = drawContext.calls.find((call) => call.op === 'fillText' && call.text === longText);
  assert(longRow, 'the sung line must be drawn even when it does not fit its ray');
  assert(
    Math.abs(longRow.scale - 0.5) < 1e-9,
    `the sung line must be squeezed to the 0.5 floor, not ${longRow.scale}`
  );

  sandbox.haloLyric.current = 0;
  drawContext.calls.length = 0;
  sandbox.haloDrawLyricText(drawContext);
  const longRowOff = drawContext.calls.find((call) => call.op === 'fillText' && call.text === longText);
  assert(longRowOff, 'a row that does not fit its ray is still drawn');
  assert(
    Math.abs(longRowOff.scale - 1) < 1e-9,
    `a row that does not fit its ray keeps its size, not ${longRowOff.scale}`
  );
}

// ------------------------------------------------------ the decoration band
// The outer beams hang off the rim, so the ones that show are the ones the screen
// reaches. The band must sit on the side the lyrics are read on, not on a quadrant of
// the world origin.
{
  sandbox.haloBuildStrands();
  const layer = sandbox.haloStrandLayers[2];
  let sum = 0;
  let count = 0;
  for (const wedge of layer.wedges) {
    if (!sandbox.haloWedgeVisible(wedge, layer)) continue;
    const mid = (wedge.i0 + wedge.n / 2) * layer.step + layer.off;
    sum += sandbox.haloNormAngle(mid);
    count += 1;
  }
  assert(count > 0, 'some beams must be visible');
  const mean = sum / count;
  assert(
    Math.abs(mean) < 0.35,
    `the visible beams must sit on the side the lyrics are read on, but their mean angle is ${mean} rad`
  );
}

console.log('[OK] The ring turn lasts the 转环时长 knob, the cull follows the screen and the lyric rows keep one size.');
