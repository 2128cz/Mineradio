const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's turn is timed off the song's tempo, and the test measures that it really is.
//
// The user's request: the rhythm points of a song are a fixed interval, so use that interval
// as the ring's rotation time - a fast song turns fast, a slow song turns slow. The knob
// 按节拍转环 switches it on; with it off, the console's own 转环时长 / 转环提前量 knobs rule.
//
// What this refuses to accept is a *silent* fallback: every measurement here also reads which
// producer decided the timing (haloState.beat.source, haloLyric.turnSource), because a test
// that passes while the tempo was never found would be proving nothing.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

function makeContext() {
  const noop = () => {};
  const ctx = {
    font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
    lineWidth: 1, globalAlpha: 1, filter: 'none', globalCompositeOperation: 'source-over',
    lineCap: '', lineJoin: '',
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop, setTransform: noop,
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

class Path2DStub {
  moveTo() {} lineTo() {} closePath() {} arc() {} rect() {}
  quadraticCurveTo() {} bezierCurveTo() {}
}

const canvas = { width: 1920, height: 1080, style: {}, getContext: () => makeContext() };
const audio = { currentTime: 0, paused: false };
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
  analyser: { frequencyBinCount: 8, getByteFrequencyData(b) { b.fill(120); } },
  currentBeatMap: null,
  rtBeat: null
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
assert.strictEqual(sandbox.HALO_TUNING_SCHEMA.beatTurn.kind, 'bool', '按节拍转环 has to be a switch, not a slider');
assert.strictEqual(sandbox.HALO_TUNING_SCHEMA.beatTurn.def, 1, 'the switch ships on: the user asked for tempo turns');

sandbox.haloLayoutStage(1920, 1080);
sandbox.haloBuildWeb();
sandbox.haloBuildSlots();
sandbox.haloBuildStrands();
sandbox.haloBuildFlyers();
sandbox.haloBuildGradients();
sandbox.haloState.ready = true;

// Lyric lines deliberately off the beat grid: a turn has to end on the line, so its length
// cannot just be the beat interval rounded.
// The frame step the test simulates at: coarse enough to stay quick, fine enough that a
// start snapped to a beat is distinguishable from one that is not.
const DT = 1 / 40;
const LYRICS = [];
for (let i = 0; i < 20; i++) LYRICS.push({ t: 3.7 + i * 2.3, text: 'line ' + (i + 1) });
sandbox.lyricsLines = LYRICS;

// A beat map at `step` seconds per beat, with an arbitrary phase so the grid is not t=0.
function beatMap(step, phase, withGridStep) {
  const beats = [];
  for (let t = phase; t < 70; t += step) beats.push({ time: t, strength: 0.7, impact: 0.6 });
  const map = { cameraBeats: beats, beats: beats, tempoSource: 'music-tempo' };
  if (withGridStep) map.gridStep = step;
  return map;
}

// Run real frames and collect every turn the module starts.
function drive(seconds) {
  const dt = DT;
  const turns = [];
  let lastTween = null;
  let markError = 0;
  for (let t = 0; t <= seconds; t += dt) {
    audio.currentTime = t;
    sandbox.haloRenderFrame(canvas, t * 1000, dt);
    const tween = sandbox.haloLyric.tween;
    if (tween && tween !== lastTween) {
      turns.push({ item: tween.item, startAt: tween.startAt, dur: tween.dur, source: sandbox.haloLyric.turnSource });
    }
    lastTween = tween;
    const item = sandbox.haloLyric.items[sandbox.haloLyric.current];
    if (item && !tween) {
      markError = Math.max(markError, Math.abs(sandbox.haloNormAngle(
        item.angle + sandbox.haloState.ringRot - sandbox.haloReadAngle())));
    }
  }
  return { turns, markError, beat: Object.assign({}, sandbox.haloState.beat) };
}

function reset(map, rtBeat) {
  sandbox.currentBeatMap = map;
  sandbox.rtBeat = rtBeat;
  sandbox.haloBeat.list = [];
  sandbox.haloBeat.idx = 0;
  sandbox.haloBeat.source = '';
  sandbox.haloBuildLyricRing();
}

const FAST = 0.4;    // 150 BPM
const SLOW = 1.0;    // 60 BPM
const PHASE = 0.17;

// ------------------------------------------------------------ the beat map's grid step
sandbox.haloTuning.beatTurn = 1;
sandbox.haloTuning.rotDur = 0.55;
sandbox.haloTuning.rotLead = 0.55;
reset(beatMap(FAST, PHASE, true), null);
let fast = drive(13);
assert(fast.turns.length >= 3, `the fixture must start several turns, got ${fast.turns.length}`);
assert.strictEqual(fast.beat.source, 'beat map', `the tempo has to come from the beat map, got "${fast.beat.source}"`);
assert(Math.abs(fast.beat.step - FAST) < 1e-9, `the grid must be read as ${FAST}s, got ${fast.beat.step}`);
for (const turn of fast.turns) {
  assert(/^beat map /.test(turn.source), `this turn must be timed by the beat map, source says "${turn.source}"`);
  // One beat at least, and less than two, because the turn ends on the line and starts on a beat.
  assert(turn.dur >= FAST - 1e-9 && turn.dur < FAST * 2,
    `a turn lasted ${turn.dur.toFixed(3)}s, outside one beat (${FAST}s) and two`);
  // The decided start is the line minus that length, and it has to land on a beat. (The
  // tween's own startAt is the first frame at or after it, which is a frame later.)
  const decided = LYRICS[turn.item].t - turn.dur;
  const k = (decided - PHASE) / FAST;
  assert(Math.abs(k - Math.round(k)) < 1e-6,
    `the turn was decided for ${decided.toFixed(4)}s, which is not on the beat grid (k = ${k.toFixed(4)})`);
  assert(turn.startAt >= decided - 1e-9 && turn.startAt <= decided + DT + 1e-9,
    `the turn began at ${turn.startAt.toFixed(4)}s, not on the frame of its decided start ${decided.toFixed(4)}s`);
}
assert(fast.markError < 1e-6, `the sung line must land on the read mark, worst error ${fast.markError}`);

// ------------------------------------------------- the same fixture at a slow tempo
reset(beatMap(SLOW, PHASE, true), null);
let slow = drive(14);
assert.strictEqual(slow.beat.source, 'beat map', 'the slow fixture must also read the map');
assert(slow.turns.length >= 3, `the slow fixture must start several turns, got ${slow.turns.length}`);
const mean = (turns) => turns.reduce((sum, t) => sum + t.dur, 0) / turns.length;
// The whole point of the request: the turn's length tracks the tempo. Each turn lasts
// between one and two beats, so the two songs' ranges must sit on either side of their own
// beat intervals, and no turn of the slow song may be as quick as the fastest of the fast one.
const fastDurs = fast.turns.map((t) => t.dur);
const slowDurs = slow.turns.map((t) => t.dur);
assert(fastDurs.every((d) => d >= FAST - 1e-9 && d < FAST * 2),
  `the 150 BPM turns lasted ${fastDurs.map((d) => d.toFixed(3)).join(', ')}s, outside one and two beats of 0.4s`);
assert(slowDurs.every((d) => d >= SLOW - 1e-9 && d < SLOW * 2),
  `the 60 BPM turns lasted ${slowDurs.map((d) => d.toFixed(3)).join(', ')}s, outside one and two beats of 1.0s`);
assert(Math.min.apply(null, slowDurs) > Math.max.apply(null, fastDurs),
  `the quickest 60 BPM turn (${Math.min.apply(null, slowDurs).toFixed(3)}s) was not slower than the slowest 150 BPM ` +
  `turn (${Math.max.apply(null, fastDurs).toFixed(3)}s): the turn length does not track the tempo`);
console.log(`  measured: 150 BPM turns ${Math.min.apply(null, fastDurs).toFixed(3)}..${Math.max.apply(null, fastDurs).toFixed(3)}s ` +
  `(mean ${mean(fast.turns).toFixed(3)}), 60 BPM turns ${Math.min.apply(null, slowDurs).toFixed(3)}..${Math.max.apply(null, slowDurs).toFixed(3)}s ` +
  `(mean ${mean(slow.turns).toFixed(3)})`);

// ------------------------------------------------- a map with no grid step: use the gaps
const noStep = beatMap(FAST, PHASE, false);
reset(noStep, null);
let gaps = drive(10);
assert.strictEqual(gaps.beat.source, 'beat map',
  `a map without a grid step must still yield a tempo, from its beat times; got "${gaps.beat.source}"`);
assert(Math.abs(gaps.beat.step - FAST) < 1e-6,
  `the spacing measured off the beat times must be ${FAST}, got ${gaps.beat.step}`);

// ------------------------------------------------------- no map: the realtime tracker
reset(null, { tempoGap: 0.5, lastHitAt: 4.25 });
let live = drive(10);
assert.strictEqual(live.beat.source, 'realtime', `without a map the tracker is the producer, got "${live.beat.source}"`);
assert(Math.abs(live.beat.step - 0.5) < 1e-9, `the realtime gap must be used, got ${live.beat.step}`);
assert(live.turns.length >= 3, `the realtime fixture must start turns, got ${live.turns.length}`);
assert(live.turns.every((t) => /^realtime /.test(t.source)),
  `every turn must say the realtime tracker decided it, got ${live.turns.map((t) => JSON.stringify(t.source)).join(', ')}`);

// --------------------------------------------- nothing knows the tempo: say so, and fall back
reset(null, null);
let blind = drive(10);
assert.strictEqual(blind.beat.step, 0, 'no tempo must mean a zero step');
assert(blind.beat.source && blind.beat.source !== 'beat map' && blind.beat.source !== 'realtime',
  `a zero has to name the layer it is zero at, got "${blind.beat.source}"`);
assert(blind.turns.length >= 2, 'the fallback must still turn the ring');
for (const turn of blind.turns) {
  assert(Math.abs(turn.dur - sandbox.haloTuning.rotDur) < 1e-9,
    `with no tempo the turn must be exactly the 转环时长 knob, got ${turn.dur}`);
}

// ------------------------------------------- the switch off: the knobs rule, untouched
sandbox.currentBeatMap = beatMap(FAST, PHASE, true);
sandbox.haloTuning.beatTurn = 0;
reset(beatMap(FAST, PHASE, true), null);
let off = drive(10);
assert.strictEqual(off.beat.source, 'knob off', `with the switch off the grid must not be consulted, got "${off.beat.source}"`);
assert.strictEqual(off.beat.step, 0, 'the switch off must produce a zero step, and a reason');
for (const turn of off.turns) {
  assert(Math.abs(turn.dur - sandbox.haloTuning.rotDur) < 1e-9,
    `off, the turn is the 转环时长 knob (${sandbox.haloTuning.rotDur}s), got ${turn.dur}`);
  const decided = LYRICS[turn.item].t - sandbox.haloTuning.rotLead;
  assert(turn.startAt >= decided - 1e-9 && turn.startAt <= decided + DT + 1e-9,
    `off, the turn must begin on the frame it is due: decided ${decided.toFixed(4)}, began ${turn.startAt.toFixed(4)}`);
  assert(/^knobs/.test(turn.source), `the source must say the knobs decided, got "${turn.source}"`);
}

// A knob the user cannot reach is not a knob: the switch has to be in the console layout.
const consoleText = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
const htmlText = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert(consoleText.includes("fxConsoleItem('t-halobeatTurn'"), 'the switch must be listed in the console group');
assert(/id="t-halobeatTurn"[^>]*onclick="toggleHaloTuning\('beatTurn'\)"/.test(htmlText),
  'the switch must be in the markup and flip through the store');

console.log('[OK] The ring turns to the song\'s tempo: fast songs turn fast, slow songs turn slow, and the fallback says so.');
