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
  let state = { scaleX: 1, scaleY: 1, font: '', lastRotate: 0 };
  const ctx = {
    calls,
    save() { stack.push(Object.assign({}, state)); },
    restore() { state = stack.pop() || state; },
    translate(x, y) { calls.push({ op: 'translate', x, y }); },
    rotate(a) { state.lastRotate = a; calls.push({ op: 'rotate', a }); },
    scale(x, y) { state.scaleX *= x; state.scaleY *= y; calls.push({ op: 'scale', x, y }); },
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    fillText(text, x, y) { calls.push({ op: 'fillText', text, x, y, scale: state.scaleX, font: state.font, rotate: state.lastRotate }); },
    measureText(text) { return { width: text.length * 12 }; },
    clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
    fill() {}, stroke() {}, moveTo() {}, lineTo() {}, rect() {},
    arc(x, y, r, a0, a1, ccw) { calls.push({ op: 'arc', x, y, r, a0, a1, ccw: !!ccw }); },
    clip() { calls.push({ op: 'clip' }); }, setTransform() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, ellipse() {},
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
// The screen shows the stretch of a ray between where it enters the viewport and where it
// leaves it, both measured from the ring's centre. Measured from the world origin instead
// (the transform's own offset) the answer is a different point on the screen, and
// everything culled against it - the beams, the streaks, the lyric lines - keeps the wrong
// rays. And one end is not enough: the centre is off screen here, so the first stretch of
// every ray is dead zone that must not count as visible.
{
  const z = sandbox.haloSceneZoom(1);
  const centre = centreOnScreen();
  // Walk the ray and ask, point by point, whether the screen shows it. This is the test's
  // own answer: it does not borrow the module's arithmetic, so the two can disagree.
  function numericRun(angle) {
    let first = null;
    let last = null;
    for (let t = 0; t <= 6000; t += 0.25) {
      const x = centre.x + z * t * Math.cos(angle);
      const y = centre.y + z * t * Math.sin(angle);
      if (x >= 0 && x <= VIEW_W && y >= 0 && y <= VIEW_H) {
        if (first === null) first = t;
        last = t;
      }
    }
    return { enter: first === null ? Infinity : first, exit: last === null ? -Infinity : last };
  }
  for (const angle of [0, -Math.PI / 4, -Math.PI / 2, Math.PI / 3, Math.PI, 2.4]) {
    const want = numericRun(angle);
    const got = sandbox.haloVisibleSpan(angle);
    if (want.exit === -Infinity) {
      assert(got.exit < got.enter,
        `the ray at ${angle.toFixed(2)} never reaches the screen, but the module says [${got.enter}, ${got.exit}]`);
      continue;
    }
    assert(Math.abs(got.enter - want.enter) <= 0.5,
      `the ray at ${angle.toFixed(2)} enters the screen at ${want.enter}, the module says ${got.enter}`);
    assert(Math.abs(got.exit - want.exit) <= 0.5,
      `the ray at ${angle.toFixed(2)} leaves the screen at ${want.exit}, the module says ${got.exit}`);
  }
  // A stretch in the dead zone between the off screen centre and the screen edge is not on
  // the screen, however far the ray reaches past it.
  const right = sandbox.haloVisibleSpan(0);
  assert(isFinite(right.enter) && right.enter > 0, 'the default framing keeps the centre off screen');
  assert.strictEqual(sandbox.haloRayVisible(0, right.enter - 60, right.enter - 10), false,
    'a stretch before the screen edge is not visible');
  assert.strictEqual(sandbox.haloRayVisible(0, right.enter + 10, right.exit - 10), true,
    'a stretch inside the screen is visible');
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
// Virtualization, first half: building the ring measures nothing. A song has hundreds of
// lines and the dial shows a handful of them.
assert(
  items.every((item) => item.textWidth === 0),
  'the line widths must not be measured when the ring is built: only the rows that are drawn get measured'
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

// Draw the dial as the module would after a turn has settled - the sung line on the read
// mark - and return the rows that were drawn with the scale they got. `extra` shifts the
// whole dial by an angle, the way a turn in progress would.
let lastDrawAngles = new Map();
let lastMaskArcs = [];
function drawAndReadRows(extra) {
  sandbox.haloState.ringRot = sandbox.haloReadAngle() - items[sandbox.haloLyric.current].angle + (extra || 0);
  drawContext.calls.length = 0;
  sandbox.haloDrawLyricText(drawContext);
  const rows = new Map();
  lastDrawAngles = new Map();
  // The clip path of the mask: the two arcs the module traces around the read mark.
  lastMaskArcs = drawContext.calls.filter((call) => call.op === 'arc');
  for (const call of drawContext.calls) {
    if (call.op !== 'fillText' || rows.has(call.text)) continue;
    rows.set(call.text, call.scale);
    lastDrawAngles.set(call.text, call.rotate);
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

// What is drawn and what the screen shows must be the same set: a line inside the window
// whose first glyph is on screen belongs on the ring, and a line whose glyphs are off
// screen does not. The old cull measured from the world origin, so it drew the rows that
// had rotated off the bottom and dropped the rows that were on screen.
{
  const win = sandbox.haloLyricWindow();
  const expected = [];
  for (let i = win.from; i <= win.to; i++) {
    if (anchorOnScreen(items[i].angle + sandbox.haloState.ringRot).inside) expected.push(items[i].text);
  }
  for (const text of expected) {
    assert(rowsBefore.has(text), `the line "${text}" is in the window and on screen and must be drawn`);
  }
  assert.strictEqual(
    drawnTexts.length,
    expected.length,
    `exactly the lines on screen are drawn (${drawnTexts.length} drawn, ${expected.length} expected)`
  );
}

// Virtualization, second half: the dial holds no more lines than the knob says, and they
// are the lines around the one being sung. A long song used to spread every line over the
// circle, so several lines you were not singing read at once.
{
  const win = sandbox.haloLyricWindow();
  assert(drawnTexts.length <= win.rows,
    `at most ${win.rows} rows may read at once, got ${drawnTexts.length}`);
  const indexByText = new Map(items.map((item, i) => [item.text, i]));
  for (const text of drawnTexts) {
    const distance = Math.abs(indexByText.get(text) - sandbox.haloLyric.current);
    assert(distance <= win.rows,
      `the drawn line "${text}" is ${distance} lines away from the sung one, outside the window`);
  }
  assert(
    items.slice(win.from, win.to + 1).every((item) => item.textWidth > 0),
    'the rows inside the window are measured once they are drawn'
  );
  assert(
    items.filter((item, i) => i < win.from || i > win.to).every((item) => item.textWidth === 0),
    'a row outside the window is never measured'
  );
}

// The mask: the dial is clipped to the window's arc, so a line that leaves the window is
// cut there instead of reappearing on the other side of the ring.
{
  const clips = drawContext.calls.filter((call) => call.op === 'clip');
  assert.strictEqual(clips.length, 1, `the lyric dial must be drawn under exactly one mask, got ${clips.length}`);
  const win = sandbox.haloLyricWindow();
  const arcHalf = sandbox.haloLyricArcHalf(win);
  // The mask's own bounds: a sector around the read mark, wide enough for the window and
  // no wider. Two arcs (the inner edge at the rim, the outer one past the screen) and both
  // span the same angle.
  assert(lastMaskArcs.length >= 2, 'the mask must be traced as a sector, between two radii');
  for (const arc of lastMaskArcs) {
    const from = Math.min(arc.a0, arc.a1);
    const to = Math.max(arc.a0, arc.a1);
    assert(Math.abs((from + to) / 2 - sandbox.haloReadAngle()) < 1e-6,
      `the mask must be centred on the read mark, got ${(from + to) / 2}`);
    assert(Math.abs((to - from) - 2 * arcHalf) < 1e-6,
      `the mask must span the window's arc (${2 * arcHalf}), got (${arc.a0}, ${arc.a1})`);
  }
  // The sector reaches past the screen, so a line is cut by the window and not by the mask.
  const outer = Math.max.apply(null, lastMaskArcs.map((arc) => arc.r));
  assert(outer > sandbox.haloState.RMAX,
    `the mask must reach past the visible ring (outer radius ${outer}, RMAX ${sandbox.haloState.RMAX})`);
  for (const text of drawnTexts) {
    const off = Math.abs(sandbox.haloNormAngle(lastDrawAngles.get(text) - sandbox.haloReadAngle()));
    assert(off <= arcHalf + 1e-9,
      `the drawn line "${text}" sits ${off.toFixed(3)}rad from the read mark, outside the masked arc (${arcHalf.toFixed(3)})`);
  }
  // The whole song would spread over this much of the circle if every line were laid out.
  const spread = Math.abs(items[items.length - 1].angle - items[0].angle);
  assert(spread > arcHalf * 4,
    `the fixture must be long enough to wrap past the arc: song spread ${spread.toFixed(2)}rad, arc ${arcHalf.toFixed(2)}rad`);
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

// The dial turns under the list: the same lines read, each one carried to where the ring
// has been turned to, and none of them resized on the way.
const beforeAngles = new Map(lastDrawAngles);
const dialTurn = sandbox.haloLyricStep() * 2;
const rowsAfter = drawAndReadRows(dialTurn);
assert.strictEqual(rowsAfter.size, rowsBefore.size, 'the window keeps its lines while the dial turns');
assert(rowsAfter.size > 0, 'the dial must still show lines');
for (const text of rowsBefore.keys()) {
  assert(rowsAfter.has(text), `the line "${text}" must still read while the dial turns`);
  const moved = sandbox.haloNormAngle(lastDrawAngles.get(text) - beforeAngles.get(text));
  assert(Math.abs(moved - dialTurn) < 1e-6,
    `the line "${text}" must be carried by the turn (${dialTurn.toFixed(4)}rad), moved ${moved.toFixed(4)}rad`);
}
for (const [text, scale] of rowsBefore) {
  if (!rowsAfter.has(text)) continue;
  assert(
    Math.abs(rowsAfter.get(text) - scale) < 1e-9,
    `the row "${text}" must not change size when the ring turns`
  );
}

// A wedge is a block of lines over its own angle, and the block is dropped or kept as one
// piece: judging it on its middle ray alone throws away whole blocks whose first or last
// line is still on the screen. Build the boundary case on purpose - a block whose middle
// and last rays miss the screen while its first ray does not - and ask the module.
{
  const centre = centreOnScreen();
  const z = sandbox.haloSceneZoom(1);
  const r = sandbox.haloState.RO + 3;
  // The angle at which the beam base crosses the top edge of the screen: larger angles
  // (toward 0) sit below it, so they are on screen.
  const topEdge = Math.asin(-centre.y / (z * r));
  assert(isFinite(topEdge), 'the fixture needs a rim that crosses the top edge of the screen');
  const wedgeStep = 0.1;
  const baseOnScreen = (a) => {
    const x = centre.x + z * r * Math.cos(a);
    const y = centre.y + z * r * Math.sin(a);
    return x > 0 && x < VIEW_W && y > 0 && y < VIEW_H;
  };
  const wedge = { i0: 0, n: 3 };
  const layer = { step: wedgeStep, rotK: 0, off: topEdge - 0.18 };
  const first = (wedge.i0 + 0.5) * wedgeStep + layer.off;
  const mid = (wedge.i0 + wedge.n / 2) * wedgeStep + layer.off;
  const last = (wedge.i0 + wedge.n - 0.5) * wedgeStep + layer.off;
  // The block runs from off screen toward the read side: its first and middle rays miss
  // the screen and only its last one lands, and that is enough to keep the whole block.
  assert(!baseOnScreen(first) && !baseOnScreen(mid), 'the fixture must put the first and the middle ray off screen');
  assert(baseOnScreen(last), 'the fixture must keep the last ray on screen');
  assert.strictEqual(sandbox.haloWedgeVisible(wedge, layer), true,
    'a block must stay while any of its own rays is on screen, not only while its middle one is');

  // The other way round: a block wholly past the edge must not be kept.
  const away = { step: wedgeStep, rotK: 0, off: topEdge - 0.9 };
  assert(!baseOnScreen((wedge.i0 + 0.5) * wedgeStep + away.off), 'the whole block must be off screen');
  assert.strictEqual(sandbox.haloWedgeVisible(wedge, away), false,
    'a block with nothing on screen must not be drawn');
}

// The dead zone between an off screen centre and the screen edge shows nothing: a line
// that starts there must not be drawn, or it reads with its first words already gone.
{
  sandbox.haloCam.panX = 900;
  const centre = centreOnScreen();
  assert(centre.x < -(sandbox.haloState.RO + sandbox.haloParam('textGap')),
    `the fixture must push the ring far enough out that no line starts on screen (centre x ${centre.x})`);
  const deadRows = drawAndReadRows(0);
  assert.strictEqual(deadRows.size, 0,
    `no line may read while its start is in the dead zone, got ${deadRows.size}`);
  sandbox.haloCam.panX = 0;
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
