const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The light that runs in on a beat. It used to cross the ring in 80-250 ms, so a passage with
// two beats a second left several streaks on screen at once and none of them could be read.
// The flight is slow now, the ring keeps at most two in the air, and the beat's visible
// emphasis sits on the data panel that updates under it.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
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

const s = sandbox.haloState;
s.ringRot = 0;
s.decoRot = 0;
sandbox.haloCam.panX = 0;
sandbox.haloCam.panY = 0;
sandbox.haloCam.zoom = 1;
// The comets are placed against the playhead; the fixture drives it with the same clock.
sandbox.audio = { currentTime: 0 };

// A dense passage: a beat every 0.3 s (200 BPM). The old flight was longer than the gap, so
// the streaks piled up on top of each other.
const DENSE = [];
for (let i = 0; i < 20; i++) {
  // Every fourth beat is a hard one, which sends two beams and takes the slow flight.
  const hard = i % 4 === 2;
  DENSE.push({ time: 0.4 + i * 0.3, strength: hard ? 0.95 : 0.6, impact: hard ? 0.9 : 0.6, camera: true });
}
sandbox.currentBeatMap = {
  gridStep: 0.3,
  tempoSource: 'music-tempo',
  duration: 8,
  cameraBeats: DENSE,
  pulseBeats: DENSE,
  hits: []
};

// Every comet the ring sends, as it is sent.
const launched = [];
const realSpawn = sandbox.haloSpawnComet;
sandbox.haloSpawnComet = function (ang, travel, weight, hitAt) {
  realSpawn(ang, travel, weight, hitAt);
  launched.push(sandbox.haloCometList[sandbox.haloCometList.length - 1]);
};

function inFlight(at) {
  return sandbox.haloCometList.filter((c) => at >= c.startAt && at <= c.endAt);
}

let mostInFlight = 0;
const dt = 1 / 60;
for (let t = 0; t <= 6; t += dt) {
  sandbox.audio.currentTime = t;
  s.time = t;
  sandbox.haloScheduleBeats(t);
  sandbox.haloRunBeatEvents(t);
  sandbox.haloUpdateComets(dt);
  mostInFlight = Math.max(mostInFlight, inFlight(t).length);
}

// ------------------------------------------------------------ the flight takes real time
{
  assert(launched.length > 0, 'the beat must still send its light');
  // The first beat is only 0.4 s away when playback starts, so the ring cannot send its light
  // any earlier than that; every beat it can see coming gets the whole flight.
  const settled = launched.filter((c) => c.startAt > 0.05);
  assert(settled.length > 0, 'the ring must send light for the beats it can anticipate');
  let shortest = Infinity;
  for (const c of settled) shortest = Math.min(shortest, c.endAt - c.startAt);
  assert(shortest >= 0.5,
    `a mapped beat's flight must last long enough to see (shortest ${shortest.toFixed(2)}s)`);
  // Half a second after it is sent, the head is still out in the ring: with a 5-frame flight
  // it would have landed and faded long before.
  const c = settled[0];
  const at = c.startAt + 0.5;
  assert(at < c.endAt, `the flight must still be running 0.5 s after launch (${c.startAt.toFixed(2)}..${c.endAt.toFixed(2)})`);
  assert(settled.some((x) => x.endAt - x.startAt > 0.8),
    'a hard beat must send its light on the slow flight');
  console.log(`  flight: ${launched.length} beams in 6 s, each ${shortest.toFixed(2)}-` +
    `${Math.max.apply(null, settled.map((x) => x.endAt - x.startAt)).toFixed(2)} s in the air`);
}

// ------------------------------------------- and a dense passage does not stack them up
{
  assert(mostInFlight <= 2,
    `at most two beams may be in the air at once, saw ${mostInFlight} on a 0.3 s grid`);
  assert(mostInFlight >= 1, 'the dense passage must still send light');
  console.log(`  dense: ${mostInFlight} beams in the air at once on a 0.3 s grid`);
}

// ------------------------------------ a live onset sends no beam, only the panel update
{
  // The fallback detector hears a hit after it has happened. A beam sent then would cross the
  // ring in a couple of frames, which is exactly the flicker this change removes; the beat is
  // still there as the ring's pop and the panel flash.
  sandbox.haloBeat.events.length = 0;
  sandbox.audio.currentTime = 6.9;
  const sent = launched.length;
  s.ringPulse = 0;
  sandbox.haloEnqueueBeat(7, 0.8, true);
  for (let t = 6.9; t <= 7.1; t += dt) {
    sandbox.audio.currentTime = t;
    sandbox.haloRunBeatEvents(t);
    sandbox.haloUpdateComets(dt);
  }
  assert.strictEqual(launched.length, sent, 'a live onset must not put a beam in the air');
  assert(s.ringPulse > 0, 'the live onset must still pop the ring');
  console.log('  live onset: no beam sent, the pop and the panel keep the beat');
}

// ------------------------------------------------ the beat lands on the panel that updates
{
  const slot = { a: 0, hpx: 10, c: { old: true }, next: { fresh: true }, flash: 0 };
  const fresh = slot.next;
  sandbox.haloSlotList.push(slot);
  sandbox.haloBeatHit({ hitAt: 6, weight: 1, slots: [slot] });
  assert.strictEqual(slot.c, fresh, 'the hit must swap in the panel rendered for it');
  assert.strictEqual(slot.flash, 1, `the swapped panel must light up (flash ${slot.flash})`);
  // The glow has to outlast the streak it belongs to: half a second later it is still on.
  for (let i = 0; i < 15; i++) sandbox.haloDrawRing(drawContext, 1 / 30);
  assert(slot.flash > 0.3,
    `the panel's update must still be readable half a second later (flash ${slot.flash.toFixed(2)})`);
  console.log(`  panel: swapped on the hit, still glowing 0.5 s later (${slot.flash.toFixed(2)})`);
}

console.log('[OK] The beat\'s light crosses the ring slowly, at most twice at once, and lands on the panel it updated.');
