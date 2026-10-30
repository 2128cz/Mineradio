const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Where the beat's scale pop goes. It has to move the ring against the rest of the picture:
// a pop that scales the whole scene, the background with it, is a picture that got 2% bigger
// and nothing in it changed. This runs the shipped module's own frame and reads the matrices
// it hands the canvas.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

const transforms = [];
function makeContext() {
  return {
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    setTransform(a, b, c, d, e, f) { transforms.push({ a, b, c, d, e, f }); },
    font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
    lineWidth: 1, globalAlpha: 1, filter: 'none', globalCompositeOperation: 'source-over',
    fillText() {}, measureText(text) { return { width: String(text).length * 12 }; },
    clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
    fill() {}, stroke() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, ellipse() {}, clip() {},
    drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; },
    putImageData() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; }
  };
}

class Path2DStub {
  moveTo() {} lineTo() {} closePath() {} arc() {} rect() {}
  quadraticCurveTo() {} bezierCurveTo() {}
}

const drawContext = makeContext();
const canvas = { width: 1920, height: 1080, style: {}, getContext: () => drawContext };

const sandbox = {
  console,
  Math, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
  parseFloat, parseInt, Set, Map, Uint8ClampedArray, Uint8Array,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  performance: { now: () => 0 },
  devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
  Path2D: Path2DStub,
  document: {
    getElementById: (id) => (id === 'halo-canvas' ? canvas : null),
    createElement: () => canvas,
    addEventListener() {},
    body: { appendChild() {} }
  },
  fx: { lyricScale: 1 },
  playQueue: [], currentIdx: -1,
  lyricsLines: [], lyricsTranslationLines: [],
  audio: { currentTime: 12.5, paused: false },
  analyser: { frequencyBinCount: 8, getByteFrequencyData() {} }
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
sandbox.haloBuildWeb();
sandbox.haloBuildSlots();
sandbox.haloBuildStrands();
sandbox.haloBuildFlyers();
sandbox.haloBuildGradients();
sandbox.haloState.ready = true;
sandbox.haloCam.zoom = 1;
sandbox.haloCam.panX = 0;
sandbox.haloCam.panY = 0;

function frameAt(pulse) {
  transforms.length = 0;
  sandbox.haloState.pulse = pulse;
  sandbox.haloState.shakeX = 0;
  sandbox.haloState.shakeY = 0;
  sandbox.haloDrawFrame(drawContext, 1 / 30);
  return transforms.slice();
}

const rest = frameAt(1);
const popped = frameAt(1.25);
assert(rest.length >= 4, `a frame must hand the canvas several layer transforms, got ${rest.length}`);
assert.strictEqual(rest.length, popped.length, 'the same frame must lay out the same layers');

// The camera is the user's: nothing in the frame's own linear factor may depend on the beat.
sandbox.haloState.pulse = 1.6;
assert.strictEqual(sandbox.haloSceneZoom(1), sandbox.haloCam.zoom,
  'the scene zoom must not carry the beat - the camera is the user\'s framing');
sandbox.haloState.pulse = 1;

// The last transform of the frame is the ring's own pass: the data ring and the lyric rows
// drawn on it. Everything before it is the picture the ring sits in.
const ringRest = rest[rest.length - 1];
const ringPopped = popped[popped.length - 1];
assert(Math.abs(ringPopped.a - ringRest.a * 1.25) < 1e-9,
  `the ring must be drawn 1.25 times its rest scale, got ${ringPopped.a} against ${ringRest.a}`);

// And the picture behind it must not have moved with it - that difference is the whole effect.
for (let i = 0; i < rest.length - 1; i++) {
  assert(Math.abs(rest[i].a - popped[i].a) < 1e-12 && Math.abs(rest[i].e - popped[i].e) < 1e-12,
    `layer ${i} of the background must not pop with the ring`);
}

// The pop is about the ring's centre, not about the screen: the centre the framing knobs put
// somewhere stays exactly there while the ring grows.
function screenCentreOf(matrix, cx) {
  return matrix.a * cx + matrix.e;
}
const cx = sandbox.haloState.cx;
assert(Math.abs(screenCentreOf(ringRest, cx) - screenCentreOf(ringPopped, cx)) < 1e-9,
  'a popping ring must keep its centre where the user framed it');

// A pop the eye can see needs room: at the knob's default the ring grows by the whole
// pulseScale, so the default cannot be a rounding error either.
const POP_FLOOR = 0.05;
assert(sandbox.HALO_TUNING_SCHEMA.pulseScale.def >= POP_FLOOR,
  `the default pop must be at least ${(POP_FLOOR * 100).toFixed(0)}% of the ring, got ` +
  sandbox.HALO_TUNING_SCHEMA.pulseScale.def);

console.log(`[OK] The beat pops the ring against a picture that does not, around the centre the user framed.`);
