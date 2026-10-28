const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's own module runs here. The sandbox supplies the browser pieces it reaches
// for (a canvas, a viewport, an audio clock, an analyser) and nothing else: the beat
// clock, the level gate and the shake come from the shipped file, so this test goes
// red if that file goes back to shaking the ring over a silent passage.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

function makeRecordingContext() {
  const calls = [];
  return {
    calls,
    save() {}, restore() {},
    translate() {}, rotate() {}, scale() {}, setTransform() {},
    font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
    lineWidth: 1, globalAlpha: 1, filter: 'none', globalCompositeOperation: 'source-over',
    fillText() {}, measureText(text) { return { width: text.length * 12 }; },
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
  moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} quadraticCurveTo() {} bezierCurveTo() {}
}

const drawContext = makeRecordingContext();
const canvas = { width: 1920, height: 1080, style: {}, getContext: () => drawContext };

// The analyser the module falls back to. The byte value it reports is the sound: 0 is
// silence, 128 is a room level track.
let analyserByte = 0;
const sandbox = {
  console,
  Math, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
  parseFloat, parseInt, Set, Map, Uint8ClampedArray, Uint8Array,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  performance: { now: () => 0 },
  devicePixelRatio: 1,
  innerWidth: 1920,
  innerHeight: 1080,
  Path2D: Path2DStub,
  document: {
    getElementById: (id) => (id === 'halo-canvas' ? canvas : null),
    createElement: () => canvas,
    addEventListener() {},
    body: { appendChild() {} }
  },
  fx: { lyricScale: 1 },
  playQueue: [],
  currentIdx: -1,
  lyricsLines: [],
  lyricsTranslationLines: [],
  audio: { currentTime: 0.31, paused: false },
  analyser: {
    frequencyBinCount: 8,
    getByteFrequencyData(buffer) { buffer.fill(analyserByte); }
  }
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
sandbox.haloState.ready = true;

// ------------------------------------------------------------------ the gate curve
// No sound, no motion: the gate is zero.
sandbox.haloAudio.level = 0;
assert.strictEqual(sandbox.haloLevelGate(), 0, 'silence must not let the ring move');
// A room level track lets the whole beat through.
sandbox.haloAudio.level = 0.5;
assert.strictEqual(sandbox.haloLevelGate(), 1, 'a loud passage must let the whole beat through');
// In between it is proportional above the floor, so a quiet passage moves the ring less.
sandbox.haloAudio.level = 0.2;
assert(
  Math.abs(sandbox.haloLevelGate() - (0.2 - 0.06) * 2.6) < 1e-9,
  `the gate must follow the level above its floor, not ${sandbox.haloLevelGate()}`
);
// The floor is the point: an analyser never reaches zero, so a quiet room must not already
// open the gate the way a full chorus does.
sandbox.haloAudio.level = 0.05;
assert.strictEqual(sandbox.haloLevelGate(), 0,
  'a level under the floor is the same as silence, not a quieter beat');
sandbox.haloAudio.level = 0.09;
const justAbove = sandbox.haloLevelGate();
assert(justAbove > 0 && justAbove < 0.1,
  `just above the floor the gate must only crack open, got ${justAbove}`);
// The knob at zero turns the gate off, which is the old behaviour: the beat moves the
// ring whatever the music does.
sandbox.haloTuning.levelGain = 0;
sandbox.haloAudio.level = 0;
assert.strictEqual(sandbox.haloLevelGate(), 1, 'the knob at zero must open the gate');
sandbox.haloTuning.levelGain = 2.6;
sandbox.haloAudio.level = 0;

function runFrames(count) {
  for (let i = 0; i < count; i++) {
    sandbox.haloRenderFrame(canvas, i * 16.7, 1 / 60);
  }
}

// ------------------------------------------------- silence: the ring does not move
{
  analyserByte = 0;
  runFrames(60);
  // The beat hits while the room is silent. The envelope is measured on the frame of
  // the hit: later frames decay it, and a decayed envelope hides a ring that still pops.
  sandbox.haloState.ringPulse = 1;
  runFrames(1);
  assert.strictEqual(sandbox.haloState.shakeX, 0, 'the ring must not shake without sound');
  assert.strictEqual(sandbox.haloState.shakeY, 0, 'the ring must not shake without sound');
  assert(
    Math.abs(sandbox.haloState.pulse - 1) < 1e-9,
    `the ring must not pop without sound, but its scale is ${sandbox.haloState.pulse}`
  );
}

// ------------------------------------------------------ sound: the ring moves
{
  analyserByte = 128;
  runFrames(60);
  sandbox.haloState.ringPulse = 1;
  runFrames(1);
  assert(
    Math.abs(sandbox.haloState.shakeX) > 1e-6,
    'the ring must shake when there is sound'
  );
  assert(
    sandbox.haloState.pulse > 1,
    `the ring must pop on the beat when there is sound, but its scale is ${sandbox.haloState.pulse}`
  );
}

// ------------------------------------- a louder passage moves the ring harder
{
  const shakeAt = (byte) => {
    analyserByte = byte;
    runFrames(60);
    sandbox.haloState.ringPulse = 1;
    runFrames(1);
    return Math.abs(sandbox.haloState.shakeX);
  };
  const quiet = shakeAt(40);
  const loud = shakeAt(200);
  assert(loud > quiet, `a louder passage must shake the ring harder (${loud} vs ${quiet})`);
}

// --------------------------------------------- the beams' beat stretch follows the same gate
{
  const before = sandbox.haloState.beamKick || 0;
  sandbox.haloAudio.level = 0;
  sandbox.haloState.levelGate = 0;
  sandbox.haloStrandBeat(1);
  const silentKick = sandbox.haloState.beamKick || 0;
  sandbox.haloState.beamKick = 0;
  sandbox.haloAudio.level = 0.5;
  sandbox.haloState.levelGate = 1;
  sandbox.haloStrandBeat(1);
  const loudKick = sandbox.haloState.beamKick || 0;
  assert(loudKick > silentKick * 2,
    `a beat must stretch the beams far less in silence (${silentKick.toFixed(2)} against ${loudKick.toFixed(2)})`);
  sandbox.haloState.beamKick = before;
  sandbox.haloAudio.level = 0;
  sandbox.haloState.levelGate = 0;
  console.log(`  beam kick on a beat: silence ${silentKick.toFixed(2)}, loud ${loudKick.toFixed(2)}`);
}

console.log('[OK] The ring\'s beat motion follows the sound: silence is still, a loud passage shakes harder.');
