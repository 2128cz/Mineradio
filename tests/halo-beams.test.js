const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The outer beams, driven by the shipped module: each cluster reads one bin of the spectrum
// at the angle it sits on, the level multiplies its length, and a beat grows every beam and
// then falls back on its own.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

// The wedge scatter is random; a fixture that fails must be reproducible.
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
  // The analyser's rate decides the bin the angle points at; 44.1 kHz is the app's own.
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
s.shakeX = 0;
s.shakeY = 0;
sandbox.haloCam.panX = 0;
sandbox.haloCam.panY = 0;
sandbox.haloCam.zoom = 1;

const BINS = 512;
const NYQUIST = 22050;
function binFor(hz) { return Math.round(hz / NYQUIST * BINS); }
// The inverse of the module's own sweep: 40 Hz at the arc's start, 12 kHz at its end.
function angleFor(hz) { return (Math.log(hz / 40) / Math.log(300) - 0.5) * Math.PI; }

function spectrum(level) {
  const bins = new Uint8Array(BINS);
  if (level) bins.fill(level);
  return bins;
}

// The module's own plumbing: it reads the analyser, keeps the per-bin data and the beams read
// that. The test feeds the analyser rather than writing haloAudio.spectrum, so a broken fill
// is a failure here and not a silent zero.
let analyserBins = spectrum(0);
sandbox.analyser = {
  frequencyBinCount: BINS,
  getByteFrequencyData(target) { target.set(analyserBins); }
};
function useSpectrum(bins) {
  analyserBins = bins;
  sandbox.haloReadAudioBands(0);
  assert(sandbox.haloAudio.spectrum && sandbox.haloAudio.spectrum.length === BINS,
    'the module must keep the per-bin spectrum it read');
}

function step(dt, frames, env) {
  for (let i = 0; i < frames; i++) {
    s.time += dt;
    sandbox.haloUpdateStrands(dt, env == null ? 0.2 : env);
  }
}

function wedges() {
  const out = [];
  for (const layer of sandbox.haloStrandLayers) {
    const rot = s.decoRot * layer.rotK + layer.off;
    for (const wedge of layer.wedges) {
      const mid = sandbox.haloNormAngle((wedge.i0 + wedge.n / 2) * layer.step + rot);
      out.push({ layer, wedge, mid, vis: !!wedge.vis });
    }
  }
  return out;
}

function visibleNear(centre, half) {
  return wedges().filter((w) => w.vis && Math.abs(sandbox.haloNormAngle(w.mid - centre)) <= half);
}

// --------------------------------------------------- one bin per cluster, by its own angle
{
  const loudHz = 300;
  const quietHz = 2000;
  const loudAngle = angleFor(loudHz);
  const quietAngle = angleFor(quietHz);
  const bins = spectrum(0);
  for (let i = -2; i <= 2; i++) bins[binFor(loudHz) + i] = 255;
  useSpectrum(bins);

  const atLoud = sandbox.haloBeamSpectrum(loudAngle);
  const atQuiet = sandbox.haloBeamSpectrum(quietAngle);
  assert(atLoud > 0.9, `the bin at ${loudHz} Hz must read as loud, got ${atLoud.toFixed(3)}`);
  assert(atQuiet < 0.05, `the bin at ${quietHz} Hz must read as silent, got ${atQuiet.toFixed(3)}`);
  // Two angles a third of the arc apart pick different bins, which eight bands could not.
  const between = sandbox.haloBeamSpectrum((loudAngle + quietAngle) / 2);
  assert(Math.abs(between - atLoud) > 0.3,
    `a cluster between the two must read its own bin, got ${between.toFixed(3)}`);

  s.beamKick = 0;
  step(1 / 30, 90);
  const nearLoud = visibleNear(loudAngle, 0.16);
  const nearQuiet = visibleNear(quietAngle, 0.16);
  assert(nearLoud.length >= 2 && nearQuiet.length >= 2,
    `the fixture must put clusters at both frequencies (${nearLoud.length} / ${nearQuiet.length})`);
  const meanLen = (list) => list.reduce((sum, w) => sum + w.wedge.len, 0) / list.length;
  const loudLen = meanLen(nearLoud);
  const quietLen = meanLen(nearQuiet);
  assert(loudLen > quietLen * 1.5,
    `the cluster on the loud bin must be longer (${loudLen.toFixed(3)} against ${quietLen.toFixed(3)})`);
  assert(quietLen < 0.3,
    `the cluster on a silent bin must be short, got ${quietLen.toFixed(3)}`);
  console.log(`  bins: ${loudHz} Hz -> ${atLoud.toFixed(2)} (len ${loudLen.toFixed(2)}), ` +
    `${quietHz} Hz -> ${atQuiet.toFixed(2)} (len ${quietLen.toFixed(2)}), between -> ${between.toFixed(2)}`);
}

// --------------------------------------------------------------- silence, then a full spectrum
{
  s.beamKick = 0;
  useSpectrum(spectrum(0));
  step(1 / 30, 120);
  const silent = wedges().filter((w) => w.vis);
  assert(silent.length > 3, 'the fixture must keep several clusters on screen');
  const longest = Math.max.apply(null, silent.map((w) => w.wedge.len));
  assert(longest < 0.3, `silence must leave every beam short, longest ${longest.toFixed(3)}`);
  const silentLen = new Map(silent.map((w) => [w.wedge, w.wedge.len]));

  useSpectrum(spectrum(255));
  step(1 / 30, 120);
  const loud = new Map(wedges().filter((w) => w.vis).map((w) => [w.wedge, w.wedge.len]));
  let doubled = 0;
  for (const [wedge, len] of silentLen) {
    if ((loud.get(wedge) || 0) > len * 2) doubled += 1;
  }
  assert.strictEqual(doubled, silentLen.size,
    `a full spectrum must lengthen every beam (${doubled} of ${silentLen.size} more than doubled)`);
  const shortest = Math.min.apply(null, Array.from(loud.values()));
  console.log(`  levels: silence longest ${longest.toFixed(2)}, full spectrum shortest ${shortest.toFixed(2)}, ` +
    `${doubled} of ${silentLen.size} more than doubled`);
}

// ------------------------------------------------------- a beat grows every beam, then falls
{
  s.beamKick = 0;
  // The beat's stretch is gated by the music's level, exactly like the pop and the shake:
  // this fixture is a passage with sound in it.
  s.levelGate = 1;
  useSpectrum(spectrum(128));
  step(1 / 30, 150);
  const before = wedges().filter((w) => w.vis);
  assert(before.length > 3, 'the fixture must keep several clusters on screen');
  const byWedge = new Map(before.map((w) => [w.wedge, w.wedge.len]));

  sandbox.haloStrandBeat(1);
  assert(s.beamKick > 0.9, `a beat must raise the beams' envelope, got ${s.beamKick}`);
  step(1 / 30, 3);
  const after = new Map(wedges().filter((w) => w.vis && byWedge.has(w.wedge)).map((w) => [w.wedge, w.wedge.len]));
  let grew = 0;
  for (const [wedge, len] of byWedge) {
    if ((after.get(wedge) || 0) > len + 1e-6) grew += 1;
  }
  assert.strictEqual(grew, byWedge.size,
    `a beat must lengthen every visible beam, ${grew} of ${byWedge.size} grew`);

  const peakKick = s.beamKick;
  step(1 / 30, 30);
  const midKick = s.beamKick;
  assert(midKick < peakKick * 0.6, `the envelope must fall by itself (${peakKick.toFixed(2)} -> ${midKick.toFixed(2)})`);
  step(1 / 30, 90);
  const settled = new Map(wedges().filter((w) => w.vis && byWedge.has(w.wedge)).map((w) => [w.wedge, w.wedge.len]));
  for (const [wedge, len] of byWedge) {
    assert(Math.abs((settled.get(wedge) || 0) - len) < len * 0.12 + 0.02,
      `the beam must fall back to its own level after the beat (${len.toFixed(3)} -> ${(settled.get(wedge) || 0).toFixed(3)})`);
  }
  console.log(`  beat: ${byWedge.size} beams grew, envelope ${peakKick.toFixed(2)} -> ` +
    `${midKick.toFixed(2)} in 1 s, back within 12%`);
}

// ---------------------------------------------------- follow: the sound, not the beam's own ramp
// The knob is the beams' own easing. At no follow a beam breathes on a slow idle sine and
// crawls to its length; at full follow it is the bin it sits on and nothing else moves it.
function longestVisible() {
  const on = wedges().filter((w) => w.vis);
  assert(on.length > 3, 'the fixture must keep several clusters on screen');
  return Math.max.apply(null, on.map((w) => w.wedge.len));
}

// Put every beam back to nothing, with a silent room, and then hand the room a full spectrum.
// The same clusters are used every time, so the two follow settings race on one track.
function burst(follow) {
  tuning.beamFollow = follow;
  s.beamKick = 0;
  useSpectrum(spectrum(0));
  step(1 / 30, 150);
  for (const w of wedges()) {
    w.wedge.av = 0;
    w.wedge.len = 0.02;
    w.wedge.kick = 0;
  }
  useSpectrum(spectrum(255));
}

// How many 1/30 s frames the longest beam takes to reach `fraction` of where it ends up.
function framesToReach(follow, fraction) {
  burst(follow);
  step(1 / 30, 200);
  const goal = longestVisible() * fraction;
  burst(follow);
  for (let n = 1; n <= 90; n++) {
    step(1 / 30, 1);
    if (longestVisible() >= goal) return n;
  }
  return Infinity;
}

const idleFrames = framesToReach(0, 0.9);
const followFrames = framesToReach(1, 0.9);
assert(followFrames <= 4,
  `at full follow a beam must be at its bin within a tenth of a second, took ${followFrames} frames`);
assert(idleFrames >= followFrames * 2,
  `the old easing must be the slower one (${idleFrames} frames against ${followFrames})`);
console.log(`  follow: the longest beam reached 90% of its bin in ${followFrames} frames at full follow, ` +
  `${idleFrames} without`);

// A beam at full follow falls as fast as it rose, which is what the user heard as the ring
// lagging behind the song: a short bin must give a short beam, not a long one still fading.
// Measured against the quiet room's own length, because a beam is never zero there.
function fallFrames(follow) {
  burst(follow);
  step(1 / 30, 60);
  const up = longestVisible();
  useSpectrum(spectrum(0));
  step(1 / 30, 300);
  const floor = longestVisible();
  const goal = floor + (up - floor) * 0.1;
  burst(follow);
  step(1 / 30, 60);
  useSpectrum(spectrum(0));
  for (let n = 1; n <= 300; n++) {
    step(1 / 30, 1);
    if (longestVisible() <= goal) return n;
  }
  return Infinity;
}

{
  const followDown = fallFrames(1);
  const idleDown = fallFrames(0);
  assert(followDown < idleDown, `falling back must be quicker with follow too (${followDown} frames against ${idleDown})`);
  assert(followDown <= 25, `a beam must be out of the way within 0.9 s of its bin going quiet, took ${followDown} frames`);
  console.log(`  follow: the longest beam fell back to a tenth of its travel in ${followDown} frames at full follow, ` +
    `${idleDown} without`);
}

// And the idle motion has to be gone, not merely quieter: a silent room must leave the beams
// at one still length, whatever the clock says.
for (const follow of [0, 1]) {
  tuning.beamFollow = follow;
  s.beamKick = 0;
  useSpectrum(spectrum(0));
  step(1 / 30, 240);
  const still = new Map(wedges().filter((w) => w.vis).map((w) => [w.wedge, w.wedge.len]));
  step(1 / 30, 240);
  let drift = 0;
  for (const [wedge, len] of still) drift = Math.max(drift, Math.abs(wedge.len - len));
  if (follow) {
    assert(drift < 1e-9,
      `a beam that follows the sound must not breathe on its own in silence, drifted ${drift.toExponential(3)}`);
  } else {
    assert(drift > 1e-4, `the idle breathing is the no-follow picture, drifted ${drift.toExponential(3)}`);
  }
  console.log(`  silence at follow ${follow}: the longest beam moved ${drift.toExponential(2)} over 8 s`);
}
tuning.beamFollow = sandbox.HALO_TUNING_SCHEMA.beamFollow.def;

console.log('[OK] The outer beams read their own spectrum bin, take their length from it, and grow on the beat.');
