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
  beginPath() {}, closePath() {}, fill() {}, stroke(p) { strokes.push({ path: p, lineWidth: this.lineWidth, alpha: this.globalAlpha }); },
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
      const hz = 40 * Math.pow(300, midAngle(layer, loud) / Math.PI + 0.5);
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

console.log('[OK] The outer ring is several element families and every one of them plays the song.');
