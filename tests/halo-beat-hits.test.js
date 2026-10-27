const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's pop has to land on the drum hits the analysis heard, not on the tempo grid it
// lays over the song. This runs the shipped ring module against a map that holds both - a
// metronome grid at 120 BPM and real hits between its points - and watches which times the
// ring actually fires on, plus the pulse each hit leaves behind.

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
const NOT_HITS = [
  { time: 0.70, strength: 0.80, impact: 0.80, camera: false },
  { time: 2.66, strength: 0.80, impact: 0.80, camera: true, grid: true }
];

function setMap(overrides) {
  sandbox.currentBeatMap = Object.assign({
    gridStep: 0.5,
    tempoSource: 'music-tempo',
    duration: 4,
    cameraBeats: GRID,
    pulseBeats: GRID,
    beats: GRID,
    hits: HITS.concat(NOT_HITS)
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

// ------------------------------------------------- the ring fires on the hits, not the grid
{
  setMap();
  const fired = drive(3);
  assert(fired.length > 0, 'the ring must fire on the map');
  assert.strictEqual(fired.length, HIT_TIMES.length,
    `the ring must fire once per hit (${HIT_TIMES.length}), got ${fired.length}: ${fired.map((f) => f.t.toFixed(2)).join(', ')}`);
  for (const f of fired) {
    assert(nearest(f.t, HIT_TIMES) < 1 / 30,
      `a pop at ${f.t.toFixed(3)}s is not on a hit (hits: ${HIT_TIMES.join(', ')})`);
  }
  // A grid point with no drum underneath it must stay quiet: that is the metronome the ring
  // used to follow. (A hit that happens to land on the beat is fine - real kicks do.)
  for (const g of GRID) {
    if (nearest(g.time, HIT_TIMES) < 1 / 30) continue;
    assert(nearest(g.time, fired.map((x) => x.t)) > 0.1,
      `the grid point at ${g.time.toFixed(2)}s has no drum hit and must not pop the ring`);
  }
  for (const f of NOT_HITS) {
    assert(nearest(f.time, fired.map((x) => x.t)) > 0.1,
      `the entry at ${f.time}s is not a drum hit and must not fire (${f.camera === false ? 'not drum-like' : 'a grid point'})`);
  }
  // The pulse follows the hit's own strength: the heavy hit pops harder than a light one.
  const byStrength = fired.map((f) => ({ w: f.w, pulse: f.pulse })).sort((a, b) => b.w - a.w);
  assert(byStrength[0].w > byStrength[byStrength.length - 1].w + 0.2,
    'the fixture must hold one heavy hit and one light one');
  assert(byStrength[0].pulse > byStrength[byStrength.length - 1].pulse + 0.1,
    `a heavy hit must pop harder (${byStrength[0].pulse.toFixed(2)} against ${byStrength[byStrength.length - 1].pulse.toFixed(2)})`);
  assert(byStrength[0].pulse <= 1.0001 && byStrength[0].pulse > 0.8,
    `the heaviest hit must reach a full pop, got ${byStrength[0].pulse.toFixed(2)}`);
  console.log(`  hits: ${fired.map((f) => f.t.toFixed(2) + 's/' + f.pulse.toFixed(2)).join(', ')} ` +
    `(grid at ${GRID[0].time.toFixed(2)}, ${GRID[1].time.toFixed(2)}…)`);
}

// ------------------------------------------- a map with no hits falls back to its own beats
{
  setMap({ hits: [], beats: [], pulseBeats: [], cameraBeats: GRID });
  const fired = drive(1.6);
  assert(fired.length > 0, 'a map without hits must still fire');
  for (const f of fired) {
    assert(nearest(f.t, GRID.map((g) => g.time)) < 1 / 30,
      `the fallback must use the camera beats (${f.t.toFixed(3)}s)`);
  }
  console.log(`  fallback: ${fired.length} pops on the grid`);
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

console.log('[OK] The ring pops on the detected drum hits, with each hit\'s own strength.');