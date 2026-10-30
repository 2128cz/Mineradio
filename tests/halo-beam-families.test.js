const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's outer elements are several families, not one: thin rays with a travelling tail,
// a row of wide solid bars, and the bars closed up into a sector. Each family is its own layer
// and each one has to move with the song, so this reads the strokes back off the drawing.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

// The wedge scatter is random; a fixture that fails must be reproducible.
const seededMath = Object.create(Math);
let seed = 20261029;
seededMath.random = function () {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

// Every stroke the layer put down, as the (inner radius, outer radius) of the line it drew.
class Path2DStub {
  constructor() { this.pts = []; }
  moveTo(x, y) { this.pts.push([x, y]); }
  lineTo(x, y) { this.pts.push([x, y]); }
}

const strokes = [];
const drawContext = {
  font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
  globalAlpha: 1, lineWidth: 1, lineCap: '',
  save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {},
  beginPath() {}, closePath() {}, fill() {},
  stroke(p) { strokes.push({ path: p, lineWidth: this.lineWidth, alpha: this.globalAlpha, fog: !!this.haloFog }); },
  moveTo() {}, lineTo() {}, rect() {},
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
  parseFloat, parseInt, Set, Map, Uint8ClampedArray, Uint8Array, Path2D: Path2DStub,
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
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: modulePath });

const tuning = {};
for (const key of Object.keys(sandbox.HALO_TUNING_SCHEMA)) tuning[key] = sandbox.HALO_TUNING_SCHEMA[key].def;
// The default framing puts the ring's centre off the left edge and the ring itself taller
// than the window, so the viewport only ever shows one stretch of the beam circle and a
// sparse family has nothing to compare itself against. This is about what each cluster
// reads, so the ring is put in the middle of the screen and small enough to fit on it.
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
s.time = 0;
sandbox.haloCam.panX = 0;
sandbox.haloCam.panY = 0;
sandbox.haloCam.zoom = 1;

const BINS = 512;
const NYQUIST = 22050;
function spectrum(level) {
  const bins = new Uint8Array(BINS);
  if (level) bins.fill(level);
  return bins;
}
let analyserBins = spectrum(0);
sandbox.analyser = {
  frequencyBinCount: BINS,
  getByteFrequencyData(target) { target.set(analyserBins); }
};
function useSpectrum(bins) {
  analyserBins = bins;
  sandbox.haloReadAudioBands(0);
}

function step(dt, frames) {
  for (let i = 0; i < frames; i++) {
    s.time += dt;
    sandbox.haloUpdateStrands(dt, 0.2);
  }
}

const EXPECTED_KINDS = ['ray', 'bar', 'fan'];
function midAngle(layer, wedge) {
  return sandbox.haloNormAngle((wedge.i0 + wedge.n / 2) * layer.step + s.decoRot * layer.rotK + layer.off);
}
function layersOf(kind) {
  return sandbox.haloStrandLayers.filter((layer) => layer.kind === kind);
}

// The strokes one pass of the drawing leaves behind, as radii from the ring's centre.
function drawnRadii(layer) {
  strokes.length = 0;
  sandbox.haloDrawStrands(drawContext, layer, null);
  const out = [];
  for (const st of strokes) {
    // The faint wrapper a block is drawn in is not the block.
    if (st.fog) continue;
    const pts = st.path.pts;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const r = (p) => Math.hypot(p[0] - s.cx, p[1] - s.cy);
      out.push({ inner: r(pts[i]), outer: r(pts[i + 1]), lineWidth: st.lineWidth, alpha: st.alpha });
    }
  }
  return out;
}

function louden(seconds) {
  useSpectrum(spectrum(255));
  step(1 / 30, Math.round(seconds * 30));
}

// ------------------------------------------------------------------ the families are there
{
  const kinds = Array.from(new Set(sandbox.haloStrandLayers.map((layer) => layer.kind)));
  for (const kind of EXPECTED_KINDS) {
    assert(kinds.includes(kind),
      `the outer ring needs a ${kind} family of its own, found ${kinds.join(', ')}`);
    assert(layersOf(kind).length > 0, `no ${kind} layer was built`);
  }
  const rayW = Math.max.apply(null, layersOf('ray').map((layer) => layer.lw));
  const barW = Math.min.apply(null, layersOf('bar').map((layer) => layer.lw));
  assert(barW > rayW * 3, `the bars must be a wider family than the rays (${barW} against ${rayW})`);
  console.log(`  families: ${kinds.join(', ')} on ${sandbox.haloStrandLayers.length} layers, ` +
    `rays ${rayW}px wide against bars ${barW}px`);
}

// ------------------------------------------------- a bar is one length; a ray bundle is a dome
{
  louden(4);
  const rayLayer = layersOf('ray')[0];
  const barLayer = layersOf('bar')[0];
  const blocky = [barLayer].concat(layersOf('fan'));
  for (const layer of sandbox.haloStrandLayers) {
    const lines = drawnRadii(layer);
    assert(lines.length > 3, `the ${layer.kind} layer must put strokes on screen (${lines.length})`);
  }
  // Rays: the middle of a cluster reaches further than its edges, and the profile varies.
  const rays = drawnRadii(rayLayer);
  const raySpan = Math.max.apply(null, rays.map((l) => l.outer)) - Math.min.apply(null, rays.map((l) => l.outer));
  assert(raySpan > 1, `a ray cluster is domed, not a row of equal lines (spread ${raySpan.toFixed(2)}px)`);
  // Bars: every line in a cluster is the same length, and reaches the full length it was given.
  for (const layer of blocky) {
    const lines = drawnRadii(layer);
    const byLength = new Map();
    for (const line of lines) byLength.set(Math.round(line.outer * 1000), (byLength.get(Math.round(line.outer * 1000)) || 0) + 1);
    const longest = Math.max.apply(null, Array.from(byLength.values()));
    assert(longest >= 3,
      `the ${layer.kind} layer must draw whole rows of equal-length bars (largest group ${longest})`);
    const inner = new Set(lines.map((l) => Math.round(l.inner)));
    assert(inner.size === 1, `every ${layer.kind} bar starts on the rim of the ring, got ${inner.size} starts`);
  }
  console.log('  shape: a ray cluster spans ' + raySpan.toFixed(1) + 'px of lengths, the bars all start on the rim');
}

// --------------------------------------------- only the rays carry a travelling tail, and only
// the rays are collected for it: a bar is drawn solid from the rim to its tip.
{
  louden(1);
  for (const layer of sandbox.haloStrandLayers) {
    const collect = { dash: [], tip: [] };
    sandbox.haloDrawStrands(drawContext, layer, collect);
    const solid = Math.max.apply(null, drawnRadii(layer).map((l) => l.outer));
    if (layer.kind === 'ray') {
      assert(collect.dash.length > 0, 'the rays must hand over their travelling tails');
    } else {
      assert.strictEqual(collect.dash.length, 0, `a ${layer.kind} is solid, it has no tail to scroll`);
      assert.strictEqual(collect.tip.length, 0, `a ${layer.kind} is solid, it has no tip to light`);
      const full = layer.wedges.filter((w) => w.vis).reduce((m, w) => Math.max(m, w.len * (s.RMAX - s.RO - 20) * tuning.beamLength * layer.lenK), 0);
      assert(solid > full * 0.6,
        `a ${layer.kind} must be drawn to its full length (${solid.toFixed(1)}px of ${full.toFixed(1)}px)`);
    }
  }
  console.log('  tails: the rays pass their dashes on, the bars and the sector are drawn solid');
}

// -------------------------------------- a sector is bars that touch; a bar row is bars apart
{
  louden(3);
  const coverage = (layer) => {
    const cov = drawnRadii(layer).map((l) => l.lineWidth / (layer.step * (l.inner + (l.outer - l.inner) / 2)));
    cov.sort((a, b) => a - b);
    return cov[Math.floor(cov.length / 2)];
  };
  const barCov = coverage(layersOf('bar')[0]);
  const fanCov = coverage(layersOf('fan')[0]);
  assert(barCov < 0.5, `the bars must stand apart from each other (they cover ${barCov.toFixed(2)} of their gap)`);
  assert(fanCov > 0.7, `the sector must close its bars into one shape (it covers ${fanCov.toFixed(2)} of its gap)`);
  console.log(`  width: a bar row covers ${barCov.toFixed(2)} of the gap between its bars, the sector ${fanCov.toFixed(2)}`);
}

// ------------------------------------------------- and the sector is painted behind the rays
// The two camera groups are chosen by the layer, not by the order the layers were built in,
// so a new family cannot quietly end up on top of the picture.
{
  const drawn = [];
  const realDraw = sandbox.haloDrawStrands;
  sandbox.haloDrawStrands = (ctx, layer, collect) => { drawn.push(layer.kind + (collect ? '/tails' : '')); };
  sandbox.haloDrawStrandGroup(drawContext, 0.95, null);
  const back = drawn.join(',');
  drawn.length = 0;
  sandbox.haloDrawStrandGroup(drawContext, 1, { dash: [], tip: [] });
  const front = drawn.join(',');
  sandbox.haloDrawStrands = realDraw;
  assert(back.includes('fan'), `the sector must be drawn in the far group (${back})`);
  assert(!front.includes('fan') && !front.includes('bar'),
    `the blocky families must not be painted again in front (${front})`);
  assert(front.includes('ray'), `the near group must still carry the rays (${front})`);
  console.log(`  order: behind = ${back}, in front = ${front}`);
}

// ------------------------------------------------------ every family moves with the sound
// One narrow band is lit and nothing else, at the angle of one cluster of that family: the
// cluster standing on the light must reach and the one standing in the dark must not.
{
  for (const kind of EXPECTED_KINDS) {
    for (const layer of layersOf(kind)) {
      const on = layer.wedges.filter((w) => w.vis && Math.abs(midAngle(layer, w)) < 1.35);
      let loud = null;
      let quiet = null;
      let best = 0;
      for (const a of on) {
        for (const b of on) {
          const d = Math.abs(midAngle(layer, a) - midAngle(layer, b));
          if (d > best) { best = d; loud = a; quiet = b; }
        }
      }
      assert(loud && best > 0.5,
        `the fixture needs two ${kind} clusters half a radian apart on the ring ` +
        `(best ${best.toFixed(2)} of ${on.length} in the sweep)`);
      const hz = 40 * Math.pow(300, midAngle(layer, loud) / sandbox.HALO_BAND_SPREAD + 0.5);
      const bins = spectrum(0);
      const bin = Math.round(hz / NYQUIST * BINS);
      for (let i = -2; i <= 2; i++) bins[bin + i] = 255;
      useSpectrum(bins);
      step(1 / 30, 120);
      assert(loud.len > quiet.len * 3,
        `the ${kind} family must read its own bin ` +
        `(${loud.len.toFixed(3)} at ${Math.round(hz)} Hz against ${quiet.len.toFixed(3)} in the dark)`);
    }
  }
  console.log('  spectrum: every family answers its own bin');
}

// ------------------------------------------- and every family stretches on the beat, then falls
{
  s.levelGate = 1;
  louden(2);
  const before = sandbox.haloStrandLayers.map((layer) => ({
    layer,
    len: layer.wedges.filter((w) => w.vis).reduce((sum, w) => sum + w.len, 0)
  }));
  sandbox.haloStrandBeat(1);
  step(1 / 30, 2);
  for (const b of before) {
    const now = b.layer.wedges.filter((w) => w.vis).reduce((sum, w) => sum + w.len, 0);
    assert(now > b.len + 1e-6, `a beat must stretch the ${b.layer.kind} family too (${b.len.toFixed(2)} -> ${now.toFixed(2)})`);
  }
  step(1 / 30, 150);
  for (const b of before) {
    const now = b.layer.wedges.filter((w) => w.vis).reduce((sum, w) => sum + w.len, 0);
    assert(Math.abs(now - b.len) < b.len * 0.15 + 0.05,
      `the ${b.layer.kind} family must fall back after the beat (${b.len.toFixed(2)} -> ${now.toFixed(2)})`);
  }
  console.log(`  beat: all ${before.length} layers stretched on the beat and fell back`);
}

// ------------------------------------ and the families do not move as one piece any more
// One formula for all six layers was the thing that looked stiff: every beam took the same
// step in the same time, and a beat multiplied them all by the same number. Each family keeps
// its own speed and its own share of the beat now, and each cluster its own gain on its bin.
{
  s.levelGate = 1;
  const firstVisible = (layer) => layer.wedges.filter((w) => w.vis)[0];

  // How many frames a cluster needs to get 90% of the way to the length a full spectrum gives
  // it. Same measurement for every layer, so the numbers are comparable across families.
  function settleFrames(layer) {
    const wedge = firstVisible(layer);
    assert(wedge, `the ${layer.kind} layer needs a visible cluster`);
    useSpectrum(spectrum(0));
    step(1 / 30, 30);
    const from = wedge.len;
    useSpectrum(spectrum(255));
    step(1 / 30, 90);
    const to = wedge.len;
    useSpectrum(spectrum(0));
    step(1 / 30, 30);
    useSpectrum(spectrum(255));
    for (let i = 1; i <= 90; i++) {
      step(1 / 30, 1);
      if (wedge.len >= from + 0.9 * (to - from)) return i;
    }
    return 90;
  }
  const rayFrames = Math.min.apply(null, layersOf('ray').map(settleFrames));
  const barFrames = Math.max.apply(null, layersOf('bar').map(settleFrames));
  assert(barFrames * 1.4 < rayFrames,
    `a bar must answer its bin much sooner than a ray (${barFrames} frames against ${rayFrames}); ` +
    'one rise rate for both is the stiff look this replaced');

  // The same beat, and the families take different amounts of it. Measured on a mid spectrum so
  // no family is already pinned at its ceiling, and with the pulse wave left out: this is the
  // beat's own multiplier, which belongs to the family.
  useSpectrum(spectrum(90));
  step(1 / 30, 120);
  const share = {};
  for (const kind of EXPECTED_KINDS) {
    const wedge = firstVisible(layersOf(kind)[0]);
    const before = wedge.len;
    let peak = 0;
    s.beamKick = 1;
    for (let i = 0; i < 30; i++) {
      step(1 / 30, 1);
      peak = Math.max(peak, wedge.len);
    }
    share[kind] = peak / Math.max(1e-6, before);
    s.beamKick = 0;
    useSpectrum(spectrum(90));
    step(1 / 30, 120);
  }
  assert(share.ray > share.bar * 1.08 && share.bar > share.fan * 1.05,
    `a beat must lift the families by their own amounts, got ray ${share.ray.toFixed(3)}, ` +
    `bar ${share.bar.toFixed(3)}, sector ${share.fan.toFixed(3)}`);

  // A cluster's own gain is part of its level: the same bin must move it less when the gain
  // is taken away. Otherwise every cluster on one band grows by the same amount.
  const barLayer = layersOf('bar')[0];
  const probe = firstVisible(barLayer);
  const withGain = (() => {
    useSpectrum(spectrum(0));
    step(1 / 30, 30);
    useSpectrum(spectrum(255));
    step(1 / 30, 12);
    return probe.len;
  })();
  const gain = probe.gain;
  probe.gain = 0;
  const noGain = (() => {
    useSpectrum(spectrum(0));
    step(1 / 30, 30);
    useSpectrum(spectrum(255));
    step(1 / 30, 12);
    return probe.len;
  })();
  probe.gain = gain;
  assert(withGain > 0.05 && noGain < withGain * 0.3,
    `a cluster's own gain must reach its bin (${withGain.toFixed(3)} with the gain, ${noGain.toFixed(3)} without)`);
  // And the gains must actually be spread out, or the clusters on one band still move alike.
  const gains = barLayer.wedges.map((w) => w.gain);
  const gainSpread = Math.max.apply(null, gains) - Math.min.apply(null, gains);
  assert(gainSpread > 0.25,
    `the clusters of one layer must not share one gain (spread ${gainSpread.toFixed(2)})`);

  console.log(`  motion: a bar settles in ${barFrames} frames, a ray in ${rayFrames}; the same beat lifts ` +
    `ray ${share.ray.toFixed(2)}x, bar ${share.bar.toFixed(2)}x, sector ${share.fan.toFixed(2)}x; ` +
    `a cluster's gain takes it from ${noGain.toFixed(3)} to ${withGain.toFixed(3)}`);
}

// --------------------------------- and the blocks go out when the room has nothing to hear
// The rays keep a short resting length of their own; the blocks are their bin and nothing else,
// so a quiet passage has to take them all the way down. A floor under them left a wall standing
// in the silence, and the ring looked switched on regardless of the song.
{
  s.levelGate = 1;
  louden(2);
  const blocky = layersOf('bar').concat(layersOf('fan'));
  for (const layer of blocky) {
    assert(drawnRadii(layer).length > 0, `the ${layer.kind} family must stand up while the room is loud`);
  }
  useSpectrum(spectrum(0));
  step(1 / 30, 120);
  for (const layer of blocky) {
    const lines = drawnRadii(layer);
    assert.strictEqual(lines.length, 0,
      `the ${layer.kind} family must come all the way down in silence, it still drew ${lines.length} strokes`);
  }
  // And a beat that lands in the silence must not put them back up: this is the wall the user
  // saw, standing there between songs.
  sandbox.haloStrandBeat(1);
  step(1 / 30, 10);
  for (const layer of blocky) {
    assert.strictEqual(drawnRadii(layer).length, 0,
      `a beat in a silent room must not raise the ${layer.kind} family again`);
  }
  for (const layer of layersOf('ray')) {
    assert(drawnRadii(layer).length > 0, 'the rays keep their own resting length in silence');
  }
  useSpectrum(spectrum(200));
  step(1 / 30, 20);
  for (const layer of blocky) {
    assert(drawnRadii(layer).length > 0, `the ${layer.kind} family must come back when the music does`);
  }
  console.log('  silence: the blocks go out with the sound and come back with it, the rays keep their rest');
}

// ------------------------------------------------ and the rays are the picture, the rest ground
// The outer ring reads as bright thin lines over dimmer blocks. The blocks are wide and solid
// and every one of their strokes is painted at full strength, so giving them the rays' own
// brightness turns the backdrop into the subject: the frame becomes a wall of white bars.
{
  louden(3);
  const alphas = (kind) => layersOf(kind).flatMap((layer) => drawnRadii(layer).map((l) => l.alpha));
  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  const ray = alphas('ray');
  const rayPeak = Math.max.apply(null, ray);
  assert(rayPeak > 0.6, `the rays must still paint at full strength (peak ${rayPeak.toFixed(2)})`);
  const peaks = {};
  for (const kind of ['bar', 'fan']) {
    const list = alphas(kind);
    peaks[kind] = Math.max.apply(null, list);
    assert(peaks[kind] < rayPeak * 0.25,
      `the ${kind} family is the ground, not the picture: its brightest stroke must stay at ` +
      `most a quarter of the rays' (${peaks[kind].toFixed(2)} against ${rayPeak.toFixed(2)})`);
    const fogged = layersOf(kind).some((layer) => {
      strokes.length = 0;
      sandbox.haloDrawStrands(drawContext, layer, null);
      return strokes.some((st) => st.fog);
    });
    assert(fogged, `the ${kind} family must sit in its faint grey wrapper, or it is cut out of the black`);
    assert(median(list) < median(ray) * 0.6,
      `the typical ${kind} stroke must be dimmer than the typical ray ` +
      `(${median(list).toFixed(2)} against ${median(ray).toFixed(2)})`);
  }
  console.log(`  light: rays peak at ${rayPeak.toFixed(2)}, the bars at ${peaks.bar.toFixed(2)}, ` +
    `the sector at ${peaks.fan.toFixed(2)}`);
}

console.log('[OK] The outer ring is several element families and every one of them plays the song.');
