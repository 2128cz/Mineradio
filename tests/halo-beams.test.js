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
// The sweep runs all the way around the ring now, so a cluster's frequency is its angle. The
// default framing pushes the ring's centre off the left edge and makes it taller than the
// window, which shows only one stretch of the circle: the fixture needs the whole ring on
// screen, or there is no second angle to compare a bin against.
tuning.centerX = 0.5;
tuning.centerY = 0.5;
tuning.radiusK = 0.16;
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
// The inverse of the module's own sweep: 40 Hz at the sweep's start, 12 kHz at its end, over
// whatever arc the module spreads it across.
function hzAt(angle) {
  return 40 * Math.pow(300,
    sandbox.haloNormAngle(angle - sandbox.haloReadAngle()) / sandbox.HALO_BAND_SPREAD + 0.5);
}

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
  // Which clusters are on screen is the module's decision, so it has to run once before the
  // fixture can pick two of them.
  useSpectrum(spectrum(0));
  step(1 / 30, 2);
  // Two visible clusters of the same layer, as far apart as the framing allows. The sweep runs
  // all the way around now, so their angles are two different frequencies by construction and
  // the fixture does not have to guess where a layer put its clusters.
  const visible = wedges().filter((w) => w.vis);
  let loud = null;
  let quiet = null;
  let apart = 0;
  for (const a of visible) {
    for (const b of visible) {
      if (a.layer !== b.layer) continue;
      const d = Math.abs(sandbox.haloNormAngle(a.mid - b.mid));
      if (d > apart) { apart = d; loud = a; quiet = b; }
    }
  }
  assert(loud && apart > 1,
    `the fixture needs two clusters of one layer apart on the ring (best ${apart.toFixed(2)})`);
  const loudHz = Math.round(hzAt(loud.mid));
  const quietHz = Math.round(hzAt(quiet.mid));
  const bins = spectrum(0);
  for (let i = -2; i <= 2; i++) bins[binFor(loudHz) + i] = 255;
  useSpectrum(bins);

  const atLoud = sandbox.haloBeamSpectrum(loud.mid);
  const atQuiet = sandbox.haloBeamSpectrum(quiet.mid);
  assert(atLoud > 0.9, `the bin at ${loudHz} Hz must read as loud, got ${atLoud.toFixed(3)}`);
  assert(atQuiet < 0.05, `the bin at ${quietHz} Hz must read as silent, got ${atQuiet.toFixed(3)}`);
  // Halfway between the two is a third frequency, and it must read as its own: eight bands
  // could not tell it from the loud one.
  const between = sandbox.haloBeamSpectrum((loud.mid + quiet.mid) / 2);
  assert(Math.abs(between - atLoud) > 0.3,
    `a cluster between the two must read its own bin, got ${between.toFixed(3)}`);

  s.beamKick = 0;
  step(1 / 30, 90);
  // One bin wide: anything further out is a different frequency, however close it looks.
  const binHalf = sandbox.HALO_BAND_SPREAD / BINS;
  const onLayerNear = (w, half) => wedges().filter((other) => other.layer === w.layer && other.vis &&
    Math.abs(sandbox.haloNormAngle(other.mid - w.mid)) <= half);
  const nearLoud = onLayerNear(loud, binHalf);
  const nearQuiet = onLayerNear(quiet, binHalf);
  assert(nearLoud.length >= 1 && nearQuiet.length >= 1,
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

  // Face value, the way the song page's spectrum reads a bar. A gain on the read put every
  // bin above 0.71 at the ceiling, so the loud half of a song was one flat wall of beams.
  const a1 = -0.5;
  const a2 = 0.9;
  const levels = spectrum(0);
  levels[binFor(hzAt(a1))] = 153;
  levels[binFor(hzAt(a2))] = 230;
  useSpectrum(levels);
  const read1 = sandbox.haloBeamSpectrum(a1);
  const read2 = sandbox.haloBeamSpectrum(a2);
  assert(Math.abs(read1 - 0.6) < 0.03 && Math.abs(read2 - 0.9) < 0.03,
    `two loud bins must stay apart, read ${read1.toFixed(2)} and ${read2.toFixed(2)} for 0.60 and 0.90`);
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

// ------------------------------------------ at full follow the ring is a circular spectrum
// The top of the follow knob is not just "faster easing": it is "the ring is the spectrum".
// Every cluster drops the randomness that made it its own beam and takes its length from the
// bin under its angle, so the silhouette around the circle is the song's spectrum - the look
// the user asked for - instead of a smooth swell travelling out from one point. Measured as
// the correlation between the bin a cluster stands on and the length it reaches.
{
  // Kept under the ceiling: a bin that pins a beam at its cap would flatten the top of the
  // profile and the correlation would fail for a reason that is not the straightening.
  const profile = (i) => 0.1 + 0.25 * (0.5 + 0.5 * Math.sin(i * 0.37));
  const bins = spectrum(0);
  for (let i = 0; i < BINS; i++) bins[i] = Math.round(255 * profile(i));
  const rayLayers = sandbox.haloStrandLayers.filter((layer) => layer.kind === 'ray');

  function corr(pairs) {
    const n = pairs.length;
    const mx = pairs.reduce((sum, p) => sum + p[0], 0) / n;
    const my = pairs.reduce((sum, p) => sum + p[1], 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const p of pairs) {
      const dx = p[0] - mx;
      const dy = p[1] - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    return syy < 1e-12 ? 1 : sxy / Math.sqrt(sxx * syy);
  }
  function shape() {
    return Math.min.apply(null, rayLayers.map((layer) => corr(wedges()
      .filter((w) => w.layer === layer && w.vis)
      .map((w) => [sandbox.haloBeamSpectrum(w.mid), w.wedge.len]))));
  }
  function settle(follow) {
    tuning.beamFollow = follow;
    s.beamKick = 0;
    s.levelGate = 1;
    useSpectrum(bins);
    step(1 / 30, 240);
  }

  settle(1);
  const followCorr = shape();
  assert(followCorr > 0.95,
    `at full follow each cluster's length must be the bin under it, correlation ${followCorr.toFixed(3)}`);
  settle(0);
  const idleCorr = shape();
  assert(idleCorr < followCorr - 0.1,
    `with follow off the ring must keep its own scatter, correlation ${idleCorr.toFixed(3)} against ${followCorr.toFixed(3)}`);

  // Each cluster's own scatter - its base length, its length scale, its gain - is what made
  // the ring read as beams rather than as a spectrum. At the top of the knob it must be gone:
  // move one cluster's scatter to the far end and its length on the same bin must not move.
  settle(1);
  const probe = wedges().filter((w) => w.layer === rayLayers[0] && w.vis)[0];
  assert(probe, 'the fixture needs a visible ray cluster');
  const steady = probe.wedge.len;
  const keep = { gain: probe.wedge.gain, base: probe.wedge.base, lenS: probe.wedge.lenS };
  probe.wedge.gain = 0.2;
  probe.wedge.base = 0.3;
  probe.wedge.lenS = 0.4;
  step(1 / 30, 30);
  const aligned = probe.wedge.len;
  assert(Math.abs(aligned - steady) < 1e-6,
    `at full follow the bin alone must set the length (${steady.toFixed(4)} -> ${aligned.toFixed(4)} after its own scatter moved)`);
  tuning.beamFollow = 0.75;
  step(1 / 30, 60);
  const loose = probe.wedge.len;
  assert(Math.abs(loose - steady) > steady * 0.05,
    `below the top the cluster's own scatter must still show (${steady.toFixed(4)} -> ${loose.toFixed(4)})`);
  Object.assign(probe.wedge, keep);

  // The beat's travelling wave belongs to the ring's own character too. At full follow it is
  // left out: a beat may lift the ring, but it must not put a gradient back into the silhouette.
  settle(1);
  sandbox.haloStrandBeat(1);
  step(1 / 30, 2);
  const beatCorr = shape();
  assert(beatCorr > 0.95,
    `a beat must not reshape the ring at full follow, correlation ${beatCorr.toFixed(3)}`);
  console.log(`  straighten: following the spectrum gives correlation ${followCorr.toFixed(3)} ` +
    `(${idleCorr.toFixed(3)} with the ring's own scatter), still ${beatCorr.toFixed(3)} after a beat`);
}
tuning.beamFollow = sandbox.HALO_TUNING_SCHEMA.beamFollow.def;

console.log('[OK] The outer beams read their own spectrum bin, take their length from it, and grow on the beat.');
