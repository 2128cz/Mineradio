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

// ---------------------------------------------------------------- the beat's own gate
// haloLevelGate is a measure of the room. What the beat is multiplied by is not allowed to
// read it straight: the app reports a normal track as an eight-bin mean of about 0.2, and
// that took almost half of every pop off the ring, so the ring's motion followed the mix's
// loudness instead of the drums.
sandbox.haloAudio.level = 0.2;
sandbox.haloState.levelGate = sandbox.haloLevelGate();
const motionAtTypical = sandbox.haloMotionGate();
assert(motionAtTypical >= 0.7,
  `a typical track must keep most of the beat, got ${motionAtTypical.toFixed(3)}`);
assert(motionAtTypical < 1,
  `and a louder passage must still be able to open it further, got ${motionAtTypical.toFixed(3)}`);
sandbox.haloAudio.level = 0.6;
sandbox.haloState.levelGate = sandbox.haloLevelGate();
assert(sandbox.haloMotionGate() > motionAtTypical,
  'a louder passage must still be allowed to move the ring harder');
sandbox.haloAudio.level = 0.02;
sandbox.haloState.levelGate = sandbox.haloLevelGate();
assert.strictEqual(sandbox.haloMotionGate(), 0, 'a silent room keeps none of the beat');
// The knob at zero turns the whole gate off, and that has to reach the beat too.
sandbox.haloTuning.levelGain = 0;
sandbox.haloState.levelGate = sandbox.haloLevelGate();
assert.strictEqual(sandbox.haloMotionGate(), 1,
  'with the gate turned off the beat must have all of it back');
sandbox.haloTuning.levelGain = 2.6;
sandbox.haloAudio.level = 0;
sandbox.haloState.levelGate = 0;

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

// --------------------------------------------------- the shake belongs to the hit
// The throw used to be a sine of the playhead. Its phase had nothing to do with the drum, so
// a beat that landed on a node of that sine moved nothing, and the frames between beats kept
// jittering at an amplitude the beat had no part in choosing. The hit throws now, and the
// picture slides back as that beat's envelope dies.
{
  analyserByte = 200;
  runFrames(60);
  sandbox.haloState.ringPulse = 1;
  sandbox.haloRenderFrame(canvas, 0, 1 / 30);
  const onTheHit = Math.hypot(sandbox.haloState.shakeX, sandbox.haloState.shakeY);
  assert(onTheHit >= sandbox.haloTuning.shakePx * 0.5,
    `the hit's own frame must carry most of the knob, got ${onTheHit.toFixed(2)}px`);
  const decays = [];
  for (let level = 0.75; level >= 0.25; level -= 0.25) {
    sandbox.haloState.ringPulse = level;
    sandbox.haloRenderFrame(canvas, 0, 1 / 30);
    decays.push(Math.hypot(sandbox.haloState.shakeX, sandbox.haloState.shakeY));
  }
  for (let i = 1; i < decays.length; i++) {
    assert(decays[i] < decays[i - 1],
      `the throw must slide back from the hit, not buzz (${decays[i].toFixed(2)} against ${decays[i - 1].toFixed(2)})`);
  }
  sandbox.haloState.ringPulse = 0;
  sandbox.haloRenderFrame(canvas, 0, 1 / 30);
  assert.strictEqual(Math.hypot(sandbox.haloState.shakeX, sandbox.haloState.shakeY), 0,
    'with nothing left of the beat there is nothing left of the throw');
  console.log(`  throw: hit ${onTheHit.toFixed(2)}px, then ${decays.map((v) => v.toFixed(1)).join(' > ')} and still`);
}

// --------------------------------- the floor and the kept share are knobs, not constants
{
  // Both numbers lived as constants in the module: the console had a slider for the gain but
  // no way to say what counts as silence, or how much of the beat survives a partly open gate.
  sandbox.haloAudio.level = 0.3;
  sandbox.haloTuning.levelFloor = 0.06;
  const lowFloor = sandbox.haloLevelGate();
  sandbox.haloTuning.levelFloor = 0.2;
  const highFloor = sandbox.haloLevelGate();
  sandbox.haloTuning.levelFloor = 0.45;
  const floorAboveLevel = sandbox.haloLevelGate();
  sandbox.haloTuning.levelFloor = sandbox.HALO_TUNING_SCHEMA.levelFloor.def;
  assert(Math.abs(lowFloor - (0.3 - 0.06) * 2.6) < 1e-9,
    `levelFloor must sit under the level in the gate curve, got ${lowFloor}`);
  assert(highFloor < lowFloor && highFloor > 0,
    `raising the floor has to take part of the gate away (${lowFloor.toFixed(3)} -> ${highFloor.toFixed(3)})`);
  assert.strictEqual(floorAboveLevel, 0,
    'a floor above the current level is silence as far as this gate is concerned');

  // gateKeep is the floor of the motion multiplier: 0 lets a partly open gate keep only its
  // own share, 1 hands the whole beat back as soon as the room is not silent.
  sandbox.haloState.levelGate = 0.4;
  const keepDefault = sandbox.haloMotionGate();
  sandbox.haloTuning.gateKeep = 0;
  const keepNothing = sandbox.haloMotionGate();
  sandbox.haloTuning.gateKeep = 1;
  const keepWhole = sandbox.haloMotionGate();
  sandbox.haloTuning.gateKeep = sandbox.HALO_TUNING_SCHEMA.gateKeep.def;
  assert(Math.abs(keepNothing - 0.4) < 1e-9,
    `gateKeep at 0 must leave the gate's own share and nothing more, got ${keepNothing}`);
  assert.strictEqual(keepWhole, 1,
    `gateKeep at 1 must hand the whole beat back above the floor, got ${keepWhole}`);
  assert(keepNothing < keepDefault && keepDefault < keepWhole,
    `the knob must order the motion (${keepNothing} < ${keepDefault.toFixed(3)} < ${keepWhole})`);
  sandbox.haloAudio.level = 0;
  sandbox.haloState.levelGate = 0;
  console.log(`  floor/keep: levelFloor 0.06/0.2/0.45 -> gate ${lowFloor.toFixed(3)}/${highFloor.toFixed(3)}/${floorAboveLevel}`
    + `, gateKeep 0/0.55/1 -> motion ${keepNothing.toFixed(3)}/${keepDefault.toFixed(3)}/${keepWhole}`);
}

// --------------------------------------- the pop lives for pulseHold seconds, not a constant
{
  // The decay used to be `dt * 2.4` written into the frame: every beat popped for about
  // 0.42s whatever the user wanted. The knob is the life of the pop in seconds, so a half
  // second of play at 0.1s hold is over and a 2s hold is most of the way through.
  analyserByte = 200;
  const decayed = (hold, seconds) => {
    sandbox.haloTuning.pulseHold = hold;
    sandbox.haloState.ringPulse = 1;
    const frames = Math.round(seconds * 60);
    for (let i = 0; i < frames; i++) sandbox.haloRenderFrame(canvas, i * 16.7, 1 / 60);
    return sandbox.haloState.ringPulse;
  };
  const shortHold = decayed(0.1, 0.5);
  const longHold = decayed(2, 0.5);
  const shipped = decayed(sandbox.HALO_TUNING_SCHEMA.pulseHold.def, 0.21);
  sandbox.haloTuning.pulseHold = sandbox.HALO_TUNING_SCHEMA.pulseHold.def;
  sandbox.haloState.ringPulse = 0;
  sandbox.haloState.levelGate = 0;
  sandbox.haloAudio.level = 0;
  assert.strictEqual(shortHold, 0,
    `a 0.1s pop has to be gone half a second later, found ${shortHold}`);
  assert(longHold > 0.7,
    `a 2s pop has to still be most of the way through at half a second, found ${longHold}`);
  assert(shipped > 0.4 && shipped < 0.6,
    `the shipped default is the old rate (1/2.4 per second): at 0.21s it should sit near 0.5, found ${shipped}`);
  console.log(`  pulseHold: 0.1s -> ${shortHold} after 0.5s, 2s -> ${longHold.toFixed(2)}, default 0.42s -> ${shipped.toFixed(2)}`);
}

console.log('[OK] The ring\'s beat motion follows the sound: silence is still, a loud passage shakes harder.');
