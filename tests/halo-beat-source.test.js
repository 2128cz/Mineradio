const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Which list the ring pops on. The map holds the grid it laid over the song (cameraBeats:
// every slot of every bar, including the ones the analysis wrote off as not a drum) and the
// beat points it thinned out of that grid (pulseBeats). Popping on the first is a refresh
// faster than the eye can read; the song's beat is the second.

const appRoot = path.join(__dirname, '..');
const pick = (envName, relPath) => (process.env[envName] ? path.resolve(process.env[envName]) : path.join(appRoot, relPath));
const modulePath = pick('HALO_MODULE_PATH', 'public/js/modules/02-visual/18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

const seededMath = Object.create(Math);
let seed = 20261029;
seededMath.random = function () {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const drawContext = {
  font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
  globalAlpha: 1, lineWidth: 1, lineCap: '',
  save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {},
  beginPath() {}, closePath() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, rect() {},
  arc() {}, clip() {}, quadraticCurveTo() {}, bezierCurveTo() {}, ellipse() {},
  fillText() {}, strokeText() {}, drawImage() {}, putImageData() {},
  measureText: (text) => ({ width: String(text).length * 12 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} })
};
const canvas = { width: 1920, height: 1080, style: {}, getContext: () => drawContext };

const sandbox = {
  console, Math: seededMath, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
  parseFloat, parseInt, Set, Map, Uint8ClampedArray, Uint8Array,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  performance: { now: () => 0 },
  devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
  audioCtx: { sampleRate: 44100 },
  document: {
    getElementById: (id) => (id === 'halo-canvas' ? canvas : null),
    createElement: () => canvas,
    addEventListener() {}, body: { appendChild() {} }
  },
  fx: { lyricScale: 1 },
  playQueue: [], currentIdx: -1,
  lyricsLines: [], lyricsTranslationLines: []
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
sandbox.haloLayoutStage(1920, 1080);
sandbox.haloBuildStrands();

const s = sandbox.haloState;
s.ringRot = 0;
s.decoRot = 0;
sandbox.haloCam.panX = 0;
sandbox.haloCam.panY = 0;
sandbox.haloCam.zoom = 1;
// The ring must hear the music as present, or the level gate holds the pop back and this
// test measures silence instead of the beat list.
const LOUD = 0.8;
sandbox.haloAudio.level = LOUD;
sandbox.haloAudio.bands = [LOUD, LOUD, LOUD, LOUD, LOUD, LOUD, LOUD, LOUD];
sandbox.haloAudio.kick = 0;
sandbox.haloAudio.kickOnset = 0;

// -------------------------------- the map as the analysis writes it: 120 BPM, grid a half
// The grid runs at eighth notes (0.25 s), the beat points at quarters (0.5 s). The off-grid
// entries carry exactly what the music-tempo pipeline gives a slot it did not hear as a drum.
const GRID = [];
for (let i = 0; i < 20; i++) {
  const onBeat = i % 2 === 0;
  GRID.push({
    time: 0.2 + i * 0.25,
    strength: onBeat ? 0.62 : 0.30,
    impact: onBeat ? 0.55 : 0.12,
    primary: onBeat,
    camera: onBeat,
    pulse: onBeat,
    tone: 'music-tempo'
  });
}
// This is the analysis' own filter (01-audio-beat-analysis.js, pulseBeats): a point has to be
// primary, camera and pulse all at once, and strong enough to be called a beat.
const PULSES = GRID.filter((b) => b.primary !== false && b.camera !== false && b.pulse !== false &&
  (b.strength >= 0.38 || (b.impact || 0) >= 0.20));

function setMap(overrides) {
  sandbox.currentBeatMap = Object.assign({
    gridStep: 0.25,
    tempoSource: 'music-tempo',
    duration: 5.2,
    cameraBeats: GRID,
    pulseBeats: PULSES,
    beats: GRID,
    hits: []
  }, overrides || {});
  sandbox.haloBeat.list = [];
  sandbox.haloBeat.idx = 0;
  sandbox.haloBeat.source = '';
  sandbox.haloBeat.events.length = 0;
  s.ringPulse = 0;
}

function drive(seconds) {
  const fired = [];
  const original = sandbox.haloBeatHit;
  sandbox.haloBeatHit = function (e) {
    original(e);
    fired.push({ t: e.hitAt, w: e.weight, pulse: s.ringPulse });
  };
  const dt = 1 / 60;
  for (let t = 0; t <= seconds; t += dt) {
    s.time = t;
    s.ringPulse = Math.max(0, (s.ringPulse || 0) - dt * 2.4);
    sandbox.haloScheduleBeats(t);
    sandbox.haloRunBeatEvents(t);
  }
  sandbox.haloBeatHit = original;
  return fired;
}

function nearest(target, list) {
  return list.reduce((best, v) => Math.min(best, Math.abs(v - target)), Infinity);
}

// --------------------------------------------------- the beat points, not the whole grid
{
  setMap();
  const within = 3.0;
  const want = PULSES.filter((b) => b.time <= within).map((b) => b.time);
  const onGrid = GRID.filter((b) => b.time <= within && b.camera === false).map((b) => b.time);
  assert(want.length >= 5 && onGrid.length >= 5, `the fixture needs beats and off-beats both (${want.length}/${onGrid.length})`);
  const fired = drive(within);
  assert.strictEqual(fired.length, want.length,
    `the ring must pop once per beat point (${want.length}), got ${fired.length}: ` +
    fired.map((f) => f.t.toFixed(2)).join(', '));
  for (let i = 0; i < fired.length; i++) {
    assert(Math.abs(fired[i].t - want[i]) < 1 / 30,
      `the pop must land on the beat point: ${fired[i].t.toFixed(3)}s against ${want[i].toFixed(2)}s`);
  }
  for (const t of onGrid) {
    assert(nearest(t, fired.map((f) => f.t)) > 0.1,
      `a grid slot the analysis wrote off as not a drum must not pop (${t.toFixed(2)}s)`);
  }
  const rate = fired.length / within;
  assert(rate <= 2.2, `the pop rate must be a beat, not a buzz: ${rate.toFixed(2)} per second`);
  console.log(`  beat points: ${fired.length} pops in ${within}s (${rate.toFixed(2)}/s) ` +
    `against a ${onGrid.length + fired.length}-point grid`);
}

// ----------------------------------------- the list the ring asks for is the thinned one
{
  setMap();
  const picked = sandbox.haloBeatMapEvents();
  assert(picked && picked.length === PULSES.length,
    `the ring must read the beat points, got ${picked && picked.length} against ${PULSES.length}`);
  for (let i = 0; i < picked.length; i++) {
    assert(Math.abs(picked[i].t - PULSES[i].time) < 1e-6, `beat point ${i} must be the one the analysis kept`);
  }
}

// ------------------------------------- a map that only has the grid still pops on it
{
  setMap({ pulseBeats: [] });
  const fired = drive(2.0);
  assert(fired.length > 0, 'a map without a thinned list must still fire');
  assert.strictEqual(fired.length, GRID.filter((b) => b.time <= 2.0).length,
    `the grid is the fallback, every point of it (${fired.length})`);
  console.log(`  fallback: ${fired.length} pops on the raw grid`);
}

// ------------------------------------- and nothing else is allowed to add the density
// The live onset detector is the last suspect for a refresh that follows the level: it must
// stay silent while the map has the beat, or the ring pops on the envelope as well as the grid.
{
  setMap();
  sandbox.haloAudio.kickOnset = 0.9;
  const fired = drive(2.0);
  sandbox.haloAudio.kickOnset = 0;
  assert.strictEqual(fired.length, PULSES.filter((b) => b.time <= 2.0).length,
    `a live onset must not add pops while the map holds the beat (got ${fired.length})`);
  assert.strictEqual(sandbox.haloBeat.source, 'map', 'the map must stay the source');
  console.log(`  live onset under a map: still ${fired.length} pops, source "${sandbox.haloBeat.source}"`);
}

console.log('  beat source: the ring pops on the analysis\' beat points, not on the grid it laid over the song');
