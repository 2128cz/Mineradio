const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's own rotation, measured on real frames of the shipped module.
//
// The user's report: while the ring turns to the next lyric line every effect slides with
// it, and the moment the turn ends they all jump back to where they were. The lyric dial
// re-anchors its line angles when a turn finishes (so they stay small). That is bookkeeping
// inside the list: the dial's own rotation takes a whole step in one frame and the lyric
// line absorbs it, but everything painted on the ring has no such offset, so it followed
// that step and snapped back.
//
// What is measured here is where things are actually painted, not what a state field says:
// a panel's screen angle out of haloDrawRing's rotate call, and a beam's out of the first
// point haloDrawStrands puts down. A completion of a turn is spotted from the lyric list
// (the sung index moved), which no mutation of the rotation can hide.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

function makeContext() {
  const calls = [];
  const noop = () => {};
  const ctx = {
    calls,
    font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
    lineWidth: 1, globalAlpha: 1, filter: 'none', globalCompositeOperation: 'source-over',
    lineCap: '', lineJoin: '',
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop,
    rotate(a) { calls.push({ op: 'rotate', a }); },
    fillText: noop, strokeText: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop, fill: noop, stroke: noop, moveTo: noop, lineTo: noop,
    arc: noop, rect: noop, quadraticCurveTo: noop, bezierCurveTo: noop, ellipse: noop,
    clip: noop, drawImage: noop, putImageData: noop, setLineDash: noop,
    measureText: (t) => ({ width: String(t).length * 11 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null
  };
  return ctx;
}

const frameContext = makeContext();
const canvas = { width: 1920, height: 1080, style: {}, getContext: () => frameContext };
const audio = { currentTime: 0, paused: false };

// The Path2D the beams are drawn through: the first point put down is a line on the ring,
// and its angle around the centre is where that beam really sits.
let beamPoints = [];
class Path2DStub {
  constructor() { this.points = beamPoints; }
  moveTo(x, y) { this.points.push([x, y]); }
  lineTo() {} closePath() {} arc() {} rect() {} quadraticCurveTo() {} bezierCurveTo() {}
}

const sandbox = {
  console, Math, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
  parseFloat, parseInt, Set, Map, Uint8ClampedArray, Uint8Array,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  performance: { now: () => 0 },
  devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
  Path2D: Path2DStub,
  document: {
    getElementById: (id) => (id === 'halo-canvas' ? canvas : null),
    createElement: () => ({ width: 8, height: 8, style: {}, getContext: () => makeContext() }),
    addEventListener() {}, body: { appendChild() {} }
  },
  fx: { lyricScale: 1 },
  playQueue: [], currentIdx: 0,
  lyricsLines: [], lyricsTranslationLines: [],
  audio,
  analyser: { frequencyBinCount: 8, getByteFrequencyData(b) { b.fill(120); } }
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

const tuning = {};
for (const key of Object.keys(sandbox.HALO_TUNING_SCHEMA)) tuning[key] = sandbox.HALO_TUNING_SCHEMA[key].def;
sandbox.haloTuning = tuning;
sandbox.haloTuning.rotDur = 0.4;
sandbox.haloTuning.rotLead = 0.3;

const LINES = 24;
const WIDE = [];
for (let i = 0; i < LINES; i++) WIDE.push({ t: i * 2, text: 'line ' + (i + 1) });
sandbox.lyricsLines = WIDE;
sandbox.haloLayoutStage(1920, 1080);
sandbox.haloBuildWeb();
sandbox.haloBuildSlots();
sandbox.haloBuildStrands();
sandbox.haloBuildFlyers();
sandbox.haloBuildGradients();
sandbox.haloBuildLyricRing();
sandbox.haloState.ready = true;

const step = sandbox.haloLyricStep();
const dt = 1 / 120;

// Where the effects are painted, frame by frame, taken out of the draw calls themselves.
const panelAngles = [];
const beamAngles = [];
const innerDrawRing = sandbox.haloDrawRing;
sandbox.haloDrawRing = function (ctx, dt2) {
  const start = frameContext.calls.length;
  const out = innerDrawRing(ctx, dt2);
  // One rotate per visible panel, in list order: the first one is a panel's screen angle.
  const rotates = frameContext.calls.slice(start).filter((call) => call.op === 'rotate');
  panelAngles.push(rotates.length ? rotates[0].a : null);
  return out;
};
const innerDrawStrands = sandbox.haloDrawStrands;
sandbox.haloDrawStrands = function (ctx, layer, collect) {
  const before = beamPoints.length;
  const out = innerDrawStrands(ctx, layer, collect);
  // Only the first strand layer of the frame is sampled; its points are world coordinates,
  // so the angle around the ring's centre is what the cull and the eye both see.
  if (before === 0 && beamPoints.length > before) {
    const s = sandbox.haloState;
    beamAngles.push(Math.atan2(beamPoints[0][1] - s.cy, beamPoints[0][0] - s.cx));
  }
  return out;
};

let worstPanelJump = 0;
let worstBeamJump = 0;
let maxRingJump = 0;
let markError = 0;
let completions = 0;
let prevPanel = null;
let prevBeam = null;
let prevRing = null;
let prevCurrent = sandbox.haloLyric.current;
let prevTime = null;

for (let t = 0; t <= 44; t += dt) {
  audio.currentTime = t;
  beamPoints = [];
  sandbox.haloRenderFrame(canvas, t * 1000, dt);
  if (!sandbox.haloState.ready) continue;
  const s = sandbox.haloState;
  const current = sandbox.haloLyric.current;
  const panel = panelAngles.length ? panelAngles[panelAngles.length - 1] : null;
  const beam = beamAngles.length ? beamAngles[beamAngles.length - 1] : null;
  const ring = s.ringRot;
  // A turn is complete when the sung line moved on. Nothing about that is rotation bookkeeping,
  // so no mutation of the rotation can make this detector miss it.
  const completed = current > prevCurrent && prevCurrent >= 0;
  if (Math.abs(t - prevTime - dt) < 1e-9 && prevRing !== null) {
    maxRingJump = Math.max(maxRingJump, Math.abs(ring - prevRing));
  }
  if (completed && prevTime !== null && Math.abs(t - prevTime - dt) < 1e-9) {
    completions += 1;
    if (panel !== null && prevPanel !== null) {
      worstPanelJump = Math.max(worstPanelJump, Math.abs(sandbox.haloNormAngle(panel - prevPanel)));
    }
    if (beam !== null && prevBeam !== null) {
      worstBeamJump = Math.max(worstBeamJump, Math.abs(sandbox.haloNormAngle(beam - prevBeam)));
    }
  }
  prevPanel = panel; prevBeam = beam; prevRing = ring; prevCurrent = current; prevTime = t;
  // The reason the re-anchors exist: once the dial has settled, the line being sung sits on
  // the read mark. Mid-turn the old line is deliberately sliding off it - that is how the new
  // one arrives - so only settled frames are measured.
  const item = sandbox.haloLyric.items[current];
  if (item && !sandbox.haloLyric.tween) {
    markError = Math.max(markError, Math.abs(sandbox.haloNormAngle(item.angle + ring - sandbox.haloReadAngle())));
  }
}

assert(completions >= 3, `the fixture must complete several turns, got ${completions}`);
assert(panelAngles.some((a) => a !== null), 'the fixture must have painted panels');
assert(beamAngles.length > 0, 'the fixture must have painted beams');

// The turn ends with the dial's own rotation taking a whole step in one frame: that is the
// step the effects used to follow.
assert(maxRingJump > step * 0.5,
  `the dial's own rotation must take the re-anchor step (worst frame ${maxRingJump.toFixed(4)}, one step ${step.toFixed(4)})`);

// And nothing painted on the ring may follow it. A quarter of a row step is far below the
// snap the user saw (a whole step) and far above what one frame of easing moves.
assert(worstPanelJump < step * 0.25,
  `a panel jumped ${worstPanelJump.toFixed(4)} rad when a turn ended, against a row step of ${step.toFixed(4)}: ` +
  'the effects on the ring snap back to where they were');
assert(worstBeamJump < step * 0.25,
  `a beam jumped ${worstBeamJump.toFixed(4)} rad when a turn ended, against a row step of ${step.toFixed(4)}: ` +
  'the effects on the ring snap back to where they were');

// The lyric list still does what the re-anchor is for.
assert(markError < 1e-6, `the sung line must stay on the read mark, worst error ${markError}`);

// ------------------------------------------------------- a turn that never got to finish
// Lines this close together mean the next turn is due before the running one has landed, so
// the dial must chain: keep going at the speed it had and bend towards the new line. The old
// behaviour aimed the new turn from a standstill, which reads as the previous animation being
// killed and restarted from zero.
{
  const tight = [];
  for (let i = 0; i < 40; i++) tight.push({ t: 1.2 + i * 0.35, text: 'tight line ' + (i + 1) });
  sandbox.lyricsLines = tight;
  sandbox.haloTuning.beatTurn = 0;      // the knobs decide here: there is no beat map in this fixture
  sandbox.haloTuning.rotDur = 0.4;
  sandbox.haloTuning.rotLead = 0.3;
  sandbox.haloBuildLyricRing();

  const speeds = [];
  const joins = [];
  let lastTween = null;
  let lastStartAt = null;
  let pending = null;
  let prev = null;
  for (let t = 0; t <= 8; t += dt) {
    audio.currentTime = t;
    sandbox.haloRenderFrame(canvas, t * 1000, dt);
    const rot = sandbox.haloLyric.rot;
    const v = prev === null ? 0 : (rot - prev) / dt;
    // The frame after a hand-over is where the carried speed shows: the turn joins at the
    // value the dial already had, so the switch frame itself cannot move - that is position
    // continuity, not a stop.
    if (pending) {
      joins.push({ before: pending, after: v });
      pending = null;
    }
    const tw = sandbox.haloLyric.tween;
    // A hand-over is the same live turn re-aimed at a newer line: the object survives and
    // only its start moves. A fresh turn after a landing is not one - the dial had stopped.
    if (tw && tw === lastTween && tw.startAt !== lastStartAt && speeds.length) {
      pending = speeds[speeds.length - 1];
    }
    if (tw) { lastStartAt = tw.startAt; }
    lastTween = tw;
    speeds.push(v);
    prev = rot;
  }
  assert(joins.length >= 2, `the fixture must hand over mid-turn at least twice, got ${joins.length}`);
  for (const join of joins) {
    assert(Math.abs(join.before) > 1e-4, 'the fixture must hand over while the dial is actually moving');
    const kept = Math.abs(join.after - join.before) / Math.abs(join.before);
    assert(kept < 0.6,
      `at the hand-over the dial lost ${(kept * 100).toFixed(0)}% of its speed in one frame ` +
      `(${join.before.toFixed(4)} -> ${join.after.toFixed(4)} rad/s): the running turn was killed ` +
      'and restarted from rest instead of joining the next one');
  }
  console.log(`  hand-overs: ${joins.length}, worst speed change ${(Math.max.apply(null, joins.map((j) => Math.abs(j.after - j.before) / Math.abs(j.before))) * 100).toFixed(1)}%`);

  sandbox.lyricsLines = WIDE.slice();
  sandbox.haloTuning.beatTurn = 1;
  sandbox.haloTuning.rotDur = 0.55;
  sandbox.haloTuning.rotLead = 0.55;
  sandbox.haloBuildLyricRing();
}

console.log('[OK] The ring\'s rotation carries the effects through the turn instead of snapping back at its end.');
