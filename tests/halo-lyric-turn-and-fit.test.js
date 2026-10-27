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

// The beams and panels are scattered with Math.random, so the fixture brings its own
// generator: a run that fails must be reproducible, and a claim must not depend on which
// random layout the machine happened to build.
const seededMath = Object.create(Math);
let seed = 20261027;
seededMath.random = function () {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const sandbox = {
  console,
  Math: seededMath, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
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
  // The shipped default is the whole circle and this song is shorter than one turn, so the
  // window is the song itself: the claim below then reads as "what the screen shows is what
  // is drawn", with no window left to hide a dropped line behind.
  assert.strictEqual(win.from, 0, 'a song shorter than the circle must not be cut at its start');
  assert.strictEqual(win.to, items.length - 1, 'a song shorter than the circle must not be cut at its end');
  const expected = [];
  for (let i = win.from; i <= win.to; i++) {
    if (anchorOnScreen(items[i].angle + sandbox.haloState.ringRot).inside) expected.push(items[i].text);
  }
  for (const text of expected) {
    assert(rowsBefore.has(text), `the line "${text}" is on the screen and must be drawn`);
  }
  assert.strictEqual(
    drawnTexts.length,
    expected.length,
    `exactly the lines on screen are drawn (${drawnTexts.length} drawn, ${expected.length} expected)`
  );
}

// The window is measured from the line being sung, not from the song's first line: the dial
// is re-anchored on the sung line when a turn ends, but that has not happened for the first
// line of a song the user seeked into. Here the sung line is row 3 of a short song, and the
// window still holds the rows on both sides of it.
{
  const win = sandbox.haloLyricWindow();
  assert(win.from <= sandbox.haloLyric.current && sandbox.haloLyric.current <= win.to,
    `the window [${win.from},${win.to}] must hold the line being sung (${sandbox.haloLyric.current})`);
  sandbox.haloLyric.current = 0;
  const atStart = sandbox.haloLyricWindow();
  assert.strictEqual(atStart.from, 0, 'a dial sung on the first row must start at the first row');
  assert(atStart.to > atStart.from, 'and it must still run forward from there');
  sandbox.haloLyric.current = 3;
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
  // The arc is the window's own, not a wider one: it reaches past the last row by no more
  // than the thickness of a row, and it stops short of the full circle while the song is
  // shorter than that.
  const base = items[sandbox.haloLyric.current].angle;
  const spanAbs = Math.max(Math.abs(items[win.from].angle - base), Math.abs(items[win.to].angle - base));
  assert(arcHalf >= spanAbs - 1e-9,
    `the mask must cover the window it is drawn for (arc ${arcHalf.toFixed(3)}rad, window ${spanAbs.toFixed(3)}rad)`);
  assert(arcHalf <= spanAbs + 2 * sandbox.haloLyricStep() + 1e-9,
    `the mask must not be wider than the window by more than a row (arc ${arcHalf.toFixed(3)}rad, window ${spanAbs.toFixed(3)}rad, step ${sandbox.haloLyricStep().toFixed(3)}rad)`);
  assert(arcHalf < Math.PI - 1e-9,
    `a song shorter than the circle must not get the whole circle as its mask (arc ${arcHalf.toFixed(3)}rad)`);
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

// The dial turns under the list: every row the screen still shows is carried to where the
// ring has been turned to, at the same size, and the rows that come and go do so at the edge
// of what the screen shows - a row must not light up in the middle of the visible band.
const beforeAngles = new Map(lastDrawAngles);
const dialTurn = sandbox.haloLyricStep() * 2;
const ringRotBefore = sandbox.haloReadAngle() - items[sandbox.haloLyric.current].angle;

// Draw the dial turned by `extra` and say what the screen shows of it against what is drawn:
// the two must agree row by row, and the rows that changed tell us which edge of the band
// they crossed.
function crossings(extra) {
  const rows = drawAndReadRows(extra);
  const angles = new Map(lastDrawAngles);
  let entered = 0;
  let left = 0;
  let onBand = 0;
  for (let i = 0; i < items.length; i++) {
    const vis = anchorOnScreen(items[i].angle + ringRotBefore + extra).inside;
    const isDrawn = rows.has(items[i].text);
    assert(isDrawn === vis,
      `the line "${items[i].text}" ${vis ? 'is on the screen and was not drawn' : 'is off the screen and was drawn anyway'}`);
    if (vis) {
      onBand += 1;
      if (!rowsBefore.has(items[i].text)) entered += 1;
    } else if (rowsBefore.has(items[i].text)) left += 1;
  }
  return { rows, angles, entered, left, onBand };
}

const onward = crossings(dialTurn);
const rowsAfter = onward.rows;
assert(rowsAfter.size > 0, 'the dial must still show lines');
// Turned the other way as well, so the edge rows come in at is judged too and not only the
// edge this fixture happens to have rows against.
const back = crossings(-dialTurn);
assert(onward.left > 0, `turning the dial must carry rows out of the band (out ${onward.left})`);
assert(back.entered > 0, `and turning it back must carry rows into the band (in ${back.entered})`);
assert(onward.entered + onward.left <= 6 && back.entered + back.left <= 6,
  `rows may only change at the edge of the band, not in numbers (forward ${onward.entered}/${onward.left}, back ${back.entered}/${back.left})`);
// A row that stays on the screen is carried by exactly the turn - it does not hold its place
// while the ring moves, and it does not overshoot.
let carried = 0;
for (const text of rowsAfter.keys()) {
  if (!rowsBefore.has(text)) continue;
  const moved = sandbox.haloNormAngle(onward.angles.get(text) - beforeAngles.get(text));
  assert(Math.abs(moved - dialTurn) < 1e-6,
    `the line "${text}" must be carried by the turn (${dialTurn.toFixed(4)}rad), moved ${moved.toFixed(4)}rad`);
  carried += 1;
}
assert(carried >= rowsAfter.size - 6,
  `the turn must carry the rows it had, not replace them (carried ${carried} of ${rowsAfter.size} rows)`);
// Every row the screen shows sits on the reading side of the ring, where the list runs
// outward from the rim: a row is measured by the point its first glyph is anchored on, and on
// the far half of the ring the line is turned around and anchored by its far end instead.
assert.strictEqual(back.onBand, back.rows.size,
  `every row on the screen must be one the list reads outward from (band ${back.onBand}, drawn ${back.rows.size})`);
console.log(`  dial turn: ${rowsBefore.size} rows read before, ${onward.rows.size} after (${onward.entered} crossed in, ${onward.left} out; turning back ${back.entered} in, ${back.left} out)`);
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

// A line longer than the screen is not shrunk. It keeps the app's lyric size and runs off
// the edge the way a list scrolls off its container - and the size does not follow the
// ring's own geometry either: the room left on a ray is measured through the camera, so
// fitting text to it made the row shrink while the ring pulsed to the beat and while the
// user zoomed. The font comes from the app's lyric size knob and from nothing else.
{
  const longText = 'L'.repeat(300);
  sandbox.lyricsLines = [
    { t: 0, text: 'a short line' },
    { t: 4, text: longText }
  ];
  sandbox.haloBuildLyricRing();
  const rowDrawn = (mutate, undo) => {
    mutate();
    sandbox.haloState.ringRot = 0;
    drawContext.calls.length = 0;
    sandbox.haloDrawLyricText(drawContext);
    undo();
    const row = drawContext.calls.find((call) => call.op === 'fillText' && call.text === longText);
    assert(row, 'the long line must still be drawn, at its own size, however much of it fits');
    return row;
  };
  const sung = rowDrawn(() => { sandbox.haloLyric.current = 1; }, () => {});
  const cases = [
    ['the ring pulsing to the beat', () => { sandbox.haloState.pulse = 1.09; }, () => { sandbox.haloState.pulse = 1; }],
    ['the user zooming in', () => { sandbox.haloCam.zoom = 1.6; }, () => { sandbox.haloCam.zoom = 1; }],
    ['the user panning', () => { sandbox.haloCam.panX = 240; }, () => { sandbox.haloCam.panX = 0; }],
    ['the ring built at a different size', () => sandbox.haloLayoutStage(900, 1600), () => sandbox.haloLayoutStage(VIEW_W, VIEW_H)],
    ['another line being the sung one', () => { sandbox.haloLyric.current = 0; }, () => { sandbox.haloLyric.current = 1; }]
  ];
  for (const [name, mutate, undo] of cases) {
    const row = rowDrawn(mutate, undo);
    assert.strictEqual(row.scale, sung.scale,
      `the row must not be scaled when ${name}: ${row.scale} against ${sung.scale}`);
    assert.strictEqual(row.font, sung.font,
      `the row's font must not change when ${name}: "${row.font}" against "${sung.font}"`);
  }
  assert(Math.abs(sung.scale - 1) < 1e-9, `no lyric row may be scaled to fit anything, got ${sung.scale}`);
  assert(/20\.0px/.test(sung.font),
    `the row must be drawn at the app's lyric size (20px at fx.lyricScale 1), got "${sung.font}"`);

  // The knob the user moves still moves the size - "fixed" is not the same as "frozen".
  sandbox.fx.lyricScale = 1.5;
  sandbox.haloBuildLyricRing();
  const bigger = rowDrawn(() => {}, () => {});
  assert(/30\.0px/.test(bigger.font), `the app's lyric size knob must still size the text, got "${bigger.font}"`);
  sandbox.fx.lyricScale = 1;
  sandbox.haloBuildLyricRing();
}

// -------------------------------------------- the window that runs the whole way round
// The complaint this answers: a line came into view at about four o'clock, well inside the
// band of the ring the screen shows. At the shipped cap of 0 the dial is laid out the whole
// way round and stops at the point opposite the read mark, so a row is born and dies behind
// the ring where nothing of it reads. A song shorter than one turn cannot show any of this -
// its window is the song itself - so the fixture here is a long one.
{
  const LONG = 240;
  const lines = [];
  for (let i = 0; i < LONG; i++) lines.push({ t: i * 4, text: `line ${i} of the long song` });
  sandbox.lyricsLines = lines;
  sandbox.haloTuning.lyricRows = 0;
  sandbox.haloBuildLyricRing();
  const song = sandbox.haloLyric.items;
  const step = sandbox.haloLyricStep();
  const read = sandbox.haloReadAngle();
  // The pose the user sees: the sung line parked on the read mark, which is where a turn
  // leaves it. The dial's own angles are measured from that line.
  const ringRotAt = (k) => read - song[k].angle;
  // Where the first glyph of row i sits on the screen when the dial is aimed at row k.
  const anchorAt = (i, k) => anchorOnScreen(song[i].angle + ringRotAt(k));

  const spread = song[song.length - 1].angle - song[0].angle;
  assert(spread > 2 * Math.PI + step,
    `the fixture must be a song that wraps past the circle, spread ${spread.toFixed(2)}rad against ${step.toFixed(3)}rad rows`);
  const perSide = Math.floor(Math.PI / step);
  assert(perSide >= 4 && 2 * perSide + 1 < LONG,
    `the circle must hold fewer rows than the song has (${perSide} each side, song ${LONG})`);

  function pose(k) {
    sandbox.haloLyric.current = k;
    sandbox.haloState.ringRot = ringRotAt(k);
    drawContext.calls.length = 0;
    sandbox.haloDrawLyricText(drawContext);
    const drawn = [];
    for (const call of drawContext.calls) {
      if (call.op === 'fillText' && drawn.indexOf(call.text) < 0) drawn.push(call.text);
    }
    const win = sandbox.haloLyricWindow();
    return { k, win, arcHalf: sandbox.haloLyricArcHalf(win), drawn: new Set(drawn) };
  }

  // Rows well inside the song, where it is the circle and not the song's own start or end
  // that bounds the window on both sides.
  // The framing is the one the app ships with (the ring centre off screen to the left, nobody
  // panning): the point opposite the read mark is then behind the ring and out of the screen.
  // A user who drags the camera until that point shows has asked to see the seam itself, which
  // any bounded window has to have somewhere.
  const from = perSide + 1;
  const to = LONG - perSide - 2;
  let births = 0;
  let deaths = 0;
  let bandRows = 0;
  let previous = null;
  for (let k = from; k <= to; k++) {
    const here = pose(k);
    const win = here.win;
    assert(win.from <= k && k <= win.to,
      `the window [${win.from},${win.to}] must hold the line being sung (${k})`);
    const back = song[k].angle - song[win.from].angle;
    const fwd = song[win.to].angle - song[k].angle;
    assert(back <= Math.PI + 1e-9 && fwd <= Math.PI + 1e-9,
      `no row may sit further from the sung line than the point opposite the read mark (back ${back.toFixed(3)}rad, forward ${fwd.toFixed(3)}rad)`);
    // It has to reach that point, not stop short of it: stopping short is what left a gap
    // the row popped into view across.
    if (win.from > 0) {
      assert(Math.PI - back <= step + 1e-9,
        `the window must run back to the opposite point, not stop ${Math.PI - back}rad short of it`);
      assert(back < Math.PI && song[k].angle - song[win.from - 1].angle > Math.PI,
        'the row the window leaves out behind it must really sit past the opposite point');
    }
    if (win.to < song.length - 1) {
      assert(Math.PI - fwd <= step + 1e-9,
        `the window must run forward to the opposite point, not stop ${Math.PI - fwd}rad short of it`);
    }
    // Both ends of the run are the same place on the ring: the list covers the whole circle.
    assert(Math.abs(sandbox.haloNormAngle(song[win.to].angle - song[win.from].angle)) <= step + 1e-9,
      `the window's two ends must meet (${sandbox.haloNormAngle(song[win.to].angle - song[win.from].angle).toFixed(3)}rad apart)`);
    // The masked arc is then the circle itself, so the mask cuts nothing the screen shows.
    assert(Math.abs(here.arcHalf - Math.PI) < 1e-9,
      `an uncapped dial must be masked over the whole circle, arc ${here.arcHalf.toFixed(4)}rad`);
    // What the screen shows of those rows is what is drawn, and nothing else.
    let onScreen = 0;
    for (let i = 0; i < song.length; i++) {
      const vis = anchorAt(i, k).inside;
      const isDrawn = here.drawn.has(song[i].text);
      if (i >= win.from && i <= win.to) {
        assert(vis === isDrawn,
          `row ${i} ${vis ? 'is on the screen and was not drawn' : 'is off the screen and was drawn anyway'} (sung row ${k}, ${sandbox.haloNormAngle(song[i].angle - song[k].angle).toFixed(3)}rad from the mark)`);
        if (vis) onScreen += 1;
      } else {
        assert(!isDrawn, `row ${i} is outside the window and must not be drawn (sung row ${k})`);
      }
    }
    assert(onScreen > 3, `the pose must leave several rows on the screen, got ${onScreen}`);
    bandRows = onScreen;
    // A row that changes whether the dial holds it must be off the screen for both poses:
    // that is what being born at the point opposite the read mark has to mean on screen. If
    // it were on screen, the user would watch a line appear in the middle of the band.
    if (previous) {
      for (let i = 0; i < song.length; i++) {
        const was = i >= previous.win.from && i <= previous.win.to;
        const now = i >= win.from && i <= win.to;
        if (was === now) continue;
        assert(!anchorAt(i, previous.k).inside && !anchorAt(i, k).inside,
          `row ${i} entered or left the window while the screen showed it (sung row ${previous.k} -> ${k}, ${anchorAt(i, k).x.toFixed(0)},${anchorAt(i, k).y.toFixed(0)})`);
        if (!was) births += 1; else deaths += 1;
      }
    }
    previous = here;
  }
  assert(births >= to - from, `every row of singing must take in a row at the opposite point, got ${births}`);
  assert(deaths >= to - from, `and drop one there, got ${deaths}`);
  console.log(`  whole circle: window holds ${2 * perSide + 1} of ${LONG} rows, ${bandRows} of them on the screen, ${births} rows born and ${deaths} dropped behind the ring`);

  // The knob still caps: fewer rows, a narrower mask, and rows the screen shows left out on
  // purpose. Without this the cap-0 branch above would only be proving that a big window is
  // a big window.
  for (const cap of [1, 3, 7, 20]) {
    sandbox.haloTuning.lyricRows = cap;
    const k = Math.floor(LONG / 2);
    const here = pose(k);
    const win = here.win;
    assert.strictEqual(win.rows, cap, `the cap must be the number of rows the window holds, got ${win.rows}`);
    assert.strictEqual(win.to - win.from + 1, cap, `a cap of ${cap} must hold ${cap} rows, got ${win.to - win.from + 1}`);
    assert(win.from <= k && k <= win.to,
      `the capped window [${win.from},${win.to}] must still hold the line being sung (${k})`);
    const back = song[k].angle - song[win.from].angle;
    const fwd = song[win.to].angle - song[k].angle;
    assert(here.arcHalf >= Math.max(back, fwd) - 1e-9,
      `the mask must cover the rows the cap keeps (arc ${here.arcHalf.toFixed(3)}rad, window ${Math.max(back, fwd).toFixed(3)}rad)`);
    assert(here.arcHalf < Math.PI - 1e-9,
      `a capped dial must be masked to less than the circle, arc ${here.arcHalf.toFixed(3)}rad`);
    let leftOut = 0;
    for (let i = 0; i < song.length; i++) {
      const inWindow = i >= win.from && i <= win.to;
      const vis = anchorAt(i, k).inside;
      if (inWindow) assert(here.drawn.has(song[i].text) === vis, `row ${i} must read exactly when the screen shows it (cap ${cap})`);
      else if (vis) leftOut += 1;
    }
    assert(leftOut > 0, `a cap of ${cap} must leave rows the screen shows undrawn, got ${leftOut}`);
  }

  // Virtualization, the half of it the whole circle cannot show on its own: a row outside the
  // window is never measured, and only the rows that are drawn get measured.
  sandbox.haloTuning.lyricRows = 9;
  sandbox.haloBuildLyricRing();
  const fresh = sandbox.haloLyric.items;
  assert(fresh.every((item) => item.textWidth === 0), 'a rebuilt dial measures nothing');
  const k = Math.floor(LONG / 2);
  const capped = pose(k);
  const win = capped.win;
  for (let i = 0; i < fresh.length; i++) {
    const measured = fresh[i].textWidth > 0;
    const isDrawn = capped.drawn.has(fresh[i].text);
    assert(measured === isDrawn, `row ${i} ${measured ? 'was measured but not drawn' : 'was drawn but not measured'}`);
  }
  assert(capped.drawn.size < fresh.length,
    `a song of ${fresh.length} rows must not be measured or drawn in full (drew ${capped.drawn.size})`);
  sandbox.haloTuning.lyricRows = 0;
  sandbox.haloBuildLyricRing();
}

// ------------------------------------------------------ the decoration band
// A block of beams is kept or dropped as one piece, so the rule has to be judged on the
// block's own rays. What this refuses to accept: a block dropped while one of its rays is
// plainly on the screen. The march is the test's own geometry - it walks each ray from the
// beam base outwards and projects the points - so it does not borrow the module's answer.
// Blocks whose only hit is within a few pixels of the viewport edge are set aside: there the
// sampled march and the analytic rule are entitled to disagree, and counting them would make
// this claim depend on the random scatter of the beams rather than on the rule.
{
  sandbox.haloBuildStrands();
  const z = sandbox.haloSceneZoom(1);
  const centre = centreOnScreen();
  const s = sandbox.haloState;
  // The beams turn with the decorations, not with the lyric dial: the two are different
  // quantities since the dial was split off, and a test that read the wrong one would agree
  // with the module only while that quantity happened to be zero.
  const EDGE = 4;
  let checked = 0;
  let setAside = 0;
  let keptVisible = 0;
  for (const layer of sandbox.haloStrandLayers) {
    const rot = s.decoRot * layer.rotK + layer.off;
    for (const wedge of layer.wedges) {
      const keep = sandbox.haloWedgeVisible(wedge, layer);
      let plainlyVisible = false;
      let borderline = false;
      for (const frac of [0.5, wedge.n / 2, wedge.n - 0.5]) {
        const a = (wedge.i0 + frac) * layer.step + rot;
        for (let r = s.RO + 3; r <= s.RMAX; r += 2) {
          const x = centre.x + z * r * Math.cos(a);
          const y = centre.y + z * r * Math.sin(a);
          if (x < 0 || x > VIEW_W || y < 0 || y > VIEW_H) continue;
          const nearEdge = Math.min(x, VIEW_W - x, y, VIEW_H - y) < EDGE;
          if (nearEdge) borderline = true; else plainlyVisible = true;
        }
      }
      if (plainlyVisible) {
        checked += 1;
        if (keep) keptVisible += 1;
        assert(keep,
          `a block of ${wedge.n} beams had a ray plainly on the screen and was dropped anyway ` +
          `(layer step ${(layer.step * 180 / Math.PI).toFixed(2)}deg)`);
      } else if (borderline) {
        setAside += 1;
      }
      if (!keep) {
        // The other direction, where it is unambiguous: nothing of the block is on screen.
        assert(!plainlyVisible, 'a block was dropped although a ray of it was on the screen');
      }
    }
  }
  assert(checked >= 5, `the fixture must put several blocks plainly on screen, got ${checked}`);
  assert(keptVisible === checked, 'every plainly visible block must be kept');
  console.log(`  beams: ${checked} blocks plainly on screen (all kept), ${setAside} set aside at the edge`);
}

console.log('[OK] The ring turn lasts the 转环时长 knob, the cull follows the screen and the lyric rows keep one size.');
