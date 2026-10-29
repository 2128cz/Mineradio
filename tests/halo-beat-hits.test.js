const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's pop keeps the tempo grid's timing, and the analysis' detected hits decide how
// hard each beat lands: a grid beat with a drum under it pops harder than one with nothing
// under it, and a hit that sits between beats does not move the pop at all.

const appRoot = path.join(__dirname, '..');
const pick = (envName, relPath) => (process.env[envName] ? path.resolve(process.env[envName]) : path.join(appRoot, relPath));
const modulePath = pick('HALO_MODULE_PATH', 'public/js/modules/02-visual/18-halo-ring-preset.js');
const modalPath = pick('HALO_CACHE_MODAL_PATH', 'public/js/modules/03-beat/03-local-beat-cache-modal.js');
const corePath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js');
const source = fs.readFileSync(modulePath, 'utf8');

const seededMath = Object.create(Math);
let seed = 20261027;
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
// No panels: the beat's flash prep is a no-op on an empty slot list, and the panel bitmaps
// need a full 2d context that this test does not otherwise use.

const s = sandbox.haloState;
s.ringRot = 0;
s.decoRot = 0;
sandbox.haloCam.panX = 0;
sandbox.haloCam.panY = 0;
sandbox.haloCam.zoom = 1;

// ------------------------------- the map: a metronome plus the hits that are not on it
const GRID = [];
for (let i = 0; i < 12; i++) GRID.push({ time: 0.25 + i * 0.5, strength: 0.6, impact: 0.6, camera: true, primary: true });
// Syncopated: every hit sits a beat's third after a grid point, so a pop on the grid and a
// pop on the hit are a fifth of a second apart and cannot be confused.
const HIT_TIMES = [0.44, 0.94, 1.44, 1.94, 2.44];
const HITS = HIT_TIMES.map((time, i) => ({
  time,
  strength: i === 2 ? 0.95 : 0.55,
  impact: i === 2 ? 0.90 : 0.50,
  camera: true
}));
// Entries that must not count as hits: one the analysis did not judge drum-like, and one the
// analysis synthesised as a grid point.
// Two hits that land on grid beats: those beats must pop harder than the rest. And two
// entries near other grid beats that must not count at all.
const ACCENT_HITS = [
  { time: 0.26, strength: 0.95, impact: 0.90, camera: true },
  { time: 1.76, strength: 0.95, impact: 0.90, camera: true }
];
const NOT_HITS = [
  { time: 0.70, strength: 0.80, impact: 0.80, camera: false },
  { time: 2.70, strength: 0.80, impact: 0.80, camera: true, grid: true }
];

function setMap(overrides) {
  sandbox.currentBeatMap = Object.assign({
    gridStep: 0.5,
    tempoSource: 'music-tempo',
    duration: 4,
    cameraBeats: GRID,
    pulseBeats: GRID,
    beats: GRID,
    hits: HITS.concat(ACCENT_HITS).concat(NOT_HITS)
  }, overrides || {});
}

function drive(seconds) {
  const fired = [];
  const original = sandbox.haloBeatHit;
  sandbox.haloBeatHit = function (e) {
    const before = s.ringPulse || 0;
    original(e);
    fired.push({ t: e.hitAt, w: e.weight, pulse: s.ringPulse });
    assert(s.ringPulse >= before, 'a hit must not lower the pulse');
  };
  const dt = 1 / 60;
  s.ringPulse = 0;
  for (let t = 0; t <= (seconds || 3); t += dt) {
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

// ---------------------------- the ring keeps the tempo grid's timing; hits only add weight
{
  setMap();
  const fired = drive(3);
  const want = GRID.filter((g) => g.time <= 3).map((g) => g.time);
  assert.strictEqual(fired.length, want.length,
    `the ring must pop on every grid beat (${want.length}), got ${fired.length}: ${fired.map((f) => f.t.toFixed(2)).join(', ')}`);
  for (let i = 0; i < fired.length; i++) {
    assert(Math.abs(fired[i].t - want[i]) < 1 / 30,
      `the pop must keep the grid's time: ${fired[i].t.toFixed(3)}s against ${want[i].toFixed(2)}s`);
  }
  // The syncopated hits do not move the timing at all: that detector is what made the ring
  // feel wrong, so it is not allowed to say when a beat lands.
  for (const t of HIT_TIMES) {
    assert(nearest(t, fired.map((f) => f.t)) > 0.1,
      `the hit at ${t}s must not move a pop (the grid is at ${GRID[0].time.toFixed(2)}, ${GRID[1].time.toFixed(2)}…)`);
  }
  const pulseAt = (t) => {
    const f = fired.find((x) => Math.abs(x.t - t) < 1 / 30);
    assert(f, `a pop must land on the grid beat at ${t}s`);
    return f.pulse;
  };
  // A grid beat with a drum under it pops harder than one with nothing under it.
  assert(pulseAt(0.25) > pulseAt(1.25) + 0.1,
    `a grid beat with a drum under it must pop harder (${pulseAt(0.25).toFixed(2)} against ${pulseAt(1.25).toFixed(2)})`);
  // Two entries near other grid beats that are not hits: one the analysis rejected as not
  // drum-like, one it synthesised. Neither may add weight.
  assert(Math.abs(pulseAt(0.75) - pulseAt(1.25)) < 0.05,
    `an entry the analysis did not judge drum-like must not accent a beat (${pulseAt(0.75).toFixed(2)} against ${pulseAt(1.25).toFixed(2)})`);
  assert(Math.abs(pulseAt(2.75) - pulseAt(2.25)) < 0.05,
    `a synthesised grid entry must not accent a beat (${pulseAt(2.75).toFixed(2)} against ${pulseAt(2.25).toFixed(2)})`);
  console.log(`  grid: ${fired.map((f) => f.t.toFixed(2) + 's/' + f.pulse.toFixed(2)).join(', ')} ` +
    `(with a drum ${pulseAt(0.25).toFixed(2)}, without ${pulseAt(1.25).toFixed(2)})`);
  assert(pulseAt(0.25) / pulseAt(1.25) >= 1.7,
    `a beat the analysis heard must be far apart from a metronome tick, got ` +
    `${pulseAt(0.25).toFixed(2)} against ${pulseAt(1.25).toFixed(2)}`);
}

// --------------------------------- the level is not allowed to become the beat's size
// The live kick envelope is a curve that sits well above zero the whole time a song is loud.
// Letting it outrank the weight the map hands over made every pop the loudest size the knob
// allows - the ring stopped reading as a beat the song chose and started reading as a picture
// painted from the volume. Whether there is music at all is the level gate's job (see
// halo-beat-level-gate.test.js); the size belongs to the beat.
{
  setMap();
  sandbox.haloAudio.kick = 0;
  sandbox.haloBeat.idx = 0;
  sandbox.haloBeat.events.length = 0;
  const quiet = drive(3);
  setMap();
  sandbox.haloAudio.kick = 0.95;
  sandbox.haloBeat.idx = 0;
  sandbox.haloBeat.events.length = 0;
  const kicking = drive(3);
  sandbox.haloAudio.kick = 0;
  assert(quiet.length > 0 && kicking.length > 0, 'both passes must see the grid');
  assert.strictEqual(kicking.length, quiet.length,
    'a loud passage must not add beats to the grid or take any away');
  for (let i = 0; i < kicking.length; i++) {
    assert(Math.abs(kicking[i].t - quiet[i].t) < 1 / 30,
      `the timing must not move either (${kicking[i].t.toFixed(3)}s against ${quiet[i].t.toFixed(3)}s)`);
    assert(Math.abs(kicking[i].w - quiet[i].w) < 1e-9,
      `nor the weight the beat was scheduled with (${kicking[i].w.toFixed(3)} against ${quiet[i].w.toFixed(3)})`);
    assert(Math.abs(kicking[i].pulse - quiet[i].pulse) < 1e-9,
      `and a pop must stay the size the map gave it, whatever the envelope is doing ` +
      `(${kicking[i].pulse.toFixed(3)} against ${quiet[i].pulse.toFixed(3)} at ${quiet[i].t.toFixed(2)}s)`);
  }
  const spread = Math.max(...quiet.map((f) => f.pulse)) - Math.min(...quiet.map((f) => f.pulse));
  assert(spread > 0.15, `the beat's own weight still has to show as a difference in size (${spread.toFixed(3)})`);
  console.log(`  live envelope: 0.95 kick changes no pop at all; the map's own spread is ${spread.toFixed(2)}`);
}

// ------------------------------------------- a map with no grid falls back to its own hits
{
  setMap({ cameraBeats: [], pulseBeats: [] });
  const fired = drive(1.6);
  assert(fired.length > 0, 'a map without a grid must still fire');
  const allHits = HIT_TIMES.concat(ACCENT_HITS.map((h) => h.time));
  for (const f of fired) {
    assert(nearest(f.t, allHits) < 1 / 30,
      `the fallback must use the detected hits (${f.t.toFixed(3)}s)`);
  }
  console.log(`  fallback: ${fired.length} pops on the detected hits`);
}

// --------------------------------------- the analysis hands the hits to the map at all
{
  const analyzerPath = pick('BEAT_ANALYZER_PATH', 'public/js/modules/03-beat/01-audio-beat-analysis.js');
  const text = fs.readFileSync(analyzerPath, 'utf8');
  assert(/var hits = beats\.filter\(function \(b\) \{ return !!\(b && b\.camera\); \}\);/.test(text),
    "the analysis must keep the onsets it judged drum-like as the map's hits");
  assert(/return \{ kicks: kicks, beats: beats, hits: hits,/.test(text),
    'and hand them to the map');
}

// ------------------------------------------------- the hits survive the disk cache
{
  const coreText = fs.readFileSync(corePath, 'utf8');
  const combos = /var LOCAL_BEAT_COMBOS = \[[^\]]*\];/.exec(coreText);
  assert(combos, 'the beat combo names must be readable from the core stores');
  const modalText = fs.readFileSync(modalPath, 'utf8');
  const start = modalText.indexOf('function localBeatRound');
  const end = modalText.indexOf('function readLocalBeatPrefs');
  assert(start > 0 && end > start, 'the beat map packer must be readable from the shipped module');
  const packer = {};
  vm.createContext(packer);
  vm.runInContext(
    combos[0] + '\n' + modalText.slice(start, end) +
      '\nthis.pack = packLocalBeatMap; this.unpack = unpackLocalBeatMap; this.VERSION = LOCAL_BEAT_MAP_VERSION;',
    packer
  );
  const map = { duration: 120, gridStep: 0.5, tempoSource: 'music-tempo', cameraBeats: GRID, pulseBeats: GRID, hits: HITS };
  const packed = packer.pack(map);
  assert(Array.isArray(packed.hits) && packed.hits.length === HITS.length,
    `the packed map must keep the hits, got ${packed.hits && packed.hits.length}`);
  const back = packer.unpack(JSON.parse(JSON.stringify(packed)));
  assert(back && Array.isArray(back.hits) && back.hits.length === HITS.length,
    `the unpacked map must keep the hits, got ${back && back.hits && back.hits.length}`);
  for (let i = 0; i < HITS.length; i++) {
    assert(Math.abs(back.hits[i].time - HITS[i].time) < 1e-6,
      `hit ${i} must keep its time (${back.hits[i].time} against ${HITS[i].time})`);
    assert(back.hits[i].camera === true, 'a hit must stay drum-like through the cache');
  }
  // A map packed before the hits existed is dropped, so it is analysed again.
  const stale = Object.assign({}, packed, { v: 3 });
  assert.strictEqual(packer.unpack(stale), null, 'a v3 map must be dropped, not reused');
  console.log(`  cache: ${packed.hits.length} hits packed and ${back.hits.length} unpacked, v${packer.VERSION}, v3 dropped`);
}

console.log('[OK] The ring keeps the tempo grid and pops harder where the analysis heard a drum.');