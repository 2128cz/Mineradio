'use strict';

// 节奏股市的行为判据。判的是"驱动"这一层，不是形状：
//   - 两个时钟：显示头追赶播放头，鼓点把速度压到 hitSlow，保持期后指数回弹并补齐积压；
//   - 历史不动：already-drawn 的 K 线永远不会被重写，只有生长中的那一根每次重画；
//   - 选表优先级：有节拍网格就用网格（整段前奏都可能没有 hits）；
//   - 相机让位：freeCamera 锁定时预设不得写镜头；
//   - 定价映射：对数、单调、每八度一个 octaveUnits。
//
// 事实侧独立于被判文件：期望值来自 schema 默认值与本文件自己写的常量，不是从输出反推。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const modulePath = process.env.MARKET_PRESET_PATH
  || path.join(root, 'public', 'js', 'modules', '02-visual', '21-rhythm-market-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

// The three r128 types marketCandleScratch builds. Only the methods the module calls are here;
// a stub that quietly accepted everything would hide a call the real class does not have.
function stubThree() {
  function Vector3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
  Vector3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vector3.prototype.copy = function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; };
  Vector3.prototype.add = function (v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; };
  Vector3.prototype.multiplyScalar = function (s) { this.x *= s; this.y *= s; this.z *= s; return this; };
  Vector3.prototype.lerp = function (v, a) {
    this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this;
  };
  function Quaternion() {}
  Quaternion.prototype.set = function (x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; };
  function Color() { this.r = 0; this.g = 0; this.b = 0; }
  Color.prototype.setRGB = function (r, g, b) { this.r = r; this.g = g; this.b = b; return this; };
  function Matrix4() {}
  Matrix4.prototype.compose = function (p, q, s) {
    this.pos = { x: p.x, y: p.y, z: p.z };
    this.scale = { x: s.x, y: s.y, z: s.z };
    return this;
  };
  // The crash sparks: one Points with two attributes and a material.
  function BufferAttribute(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
  function BufferGeometry() { this.attributes = {}; this.disposed = false; }
  BufferGeometry.prototype.setAttribute = function (name, attr) { this.attributes[name] = attr; return this; };
  BufferGeometry.prototype.dispose = function () { this.disposed = true; };
  function PointsMaterial(opts) { Object.assign(this, opts || {}); }
  PointsMaterial.prototype.dispose = function () { this.disposed = true; };
  function Points(geo, mat) { this.geometry = geo; this.material = mat; this.frustumCulled = true; }
  return {
    Vector3, Quaternion, Color, Matrix4,
    BufferAttribute, BufferGeometry, PointsMaterial, Points,
    AdditiveBlending: 2
  };
}

const THREE = stubThree();
const listeners = {};
const sandbox = {
  window: {
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} }
  },
  document: { addEventListener: () => {}, readyState: 'complete', body: { classList: { contains: () => false } } },
  console, Math, Date, JSON, Promise, Number, String, Object, Array, Float32Array, Uint8Array,
  Int32Array, Infinity, NaN, isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
  THREE,
  audio: { currentTime: 0 }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: modulePath });

const S = sandbox;
const state = S.marketState;

// A series whose price sits on the midline: the candles are the iterated drift, so 0 is the
// midline and a flat song is a flat line. These tests move only the clock and the write cursor.
function makeSeries(count) {
  const open = new Float32Array(count);
  const close = new Float32Array(count);
  const high = new Float32Array(count);
  const low = new Float32Array(count);
  const energy = new Float32Array(count);
  for (let i = 0; i < count; i++) energy[i] = 1;
  return {
    count, candlesPerSec: 10, open, close, high, low, energy,
    dom: new Float32Array(count), centreHz: 500, priceRevert: 0.05
  };
}

function fakeMesh() {
  const mesh = {
    count: 0,
    writes: [],
    colorWrites: [],
    instanceMatrix: { updateRange: { offset: 0, count: 0 }, needsUpdate: false },
    instanceColor: { updateRange: { offset: 0, count: 0 }, needsUpdate: false },
    setMatrixAt(i) { mesh.writes.push(i); },
    setColorAt(i) { mesh.colorWrites.push(i); }
  };
  return mesh;
}

function fakeCurve(count) {
  return {
    geometry: {
      attributes: { position: { array: new Float32Array(count * 3), updateRange: { offset: 0, count: 0 }, needsUpdate: false } },
      drawRange: { start: 0, count: 0 },
      setDrawRange(a, b) { this.drawRange = { start: a, count: b }; }
    },
    material: { opacity: 1 }
  };
}

function fakeGroup() {
  return {
    children: [],
    add(o) { this.children.push(o); },
    remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); }
  };
}

function reset(over) {
  Object.assign(state, {
    series: makeSeries(1000), group: fakeGroup(), bodies: fakeMesh(), wicks: fakeMesh(),
    curve: fakeCurve(1000), wall: null, written: 0, shown: 0, rate: 1, slowUntil: 0,
    hitList: [], hitIdx: 0, hitSource: '', hits: 0, snaps: 0, backlog: 0, energyRef: 1,
    lastPlayhead: -1, wallFlash: 0, zoomDist: 0, zoomRange: 0, sparks: null, lastStep: 0.016
  }, over || {});
  S.audio.currentTime = 0;
  S.currentBeatMap = null;
  S.fx = { preset: 16 };
  S.marketCam.shake = 0;
  S.marketCam.shakePhase = 0;
  S.marketCam.dist = 0;
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('[OK]  ' + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log('[RED] ' + name);
    console.log('      ' + String(err && err.message || err).split('\n').join('\n      '));
  }
}

// ---------------------------------------------------------------- the two clocks

test('the display head never passes the playhead and never moves backwards', () => {
  reset({ shown: 98, lastPlayhead: 9.984 });
  S.audio.currentTime = 10;             // target = 100 candles, a normal 16ms frame
  let prev = state.shown;
  for (let i = 0; i < 40; i++) {
    S.marketStepClock(0.05, 1 + i * 0.05);
    assert.ok(state.shown >= prev - 1e-9, `the head went backwards: ${prev} -> ${state.shown}`);
    assert.ok(state.shown <= S.marketPlayheadCandles() + 1e-9, `the head passed the playhead: ${state.shown} > 100`);
    prev = state.shown;
  }
  assert.ok(Math.abs(state.shown - 100) < 1e-6, `the head did not reach the playhead: ${state.shown}`);
  assert.equal(state.snaps, 0, 'a two-candle lag is not a seek');
});

test('lag left by a hiccup is chased, never snapped to the latest candle', () => {
  // 30 candles of lag, but the audio clock only moved 16ms since the last frame. That is the head
  // being behind, not the user seeking - and snapping here is the "stutter then teleport" the
  // chart used to do.
  reset({ shown: 0, lastPlayhead: 2.984 });
  S.audio.currentTime = 3;              // target = 30
  S.marketStepClock(0.016, 1);
  assert.equal(state.snaps, 0, 'accumulated lag must not be treated as a seek');
  assert.ok(state.shown < 1, `the head teleported: ${state.shown}`);
  assert.ok(state.backlog > 25, `the backlog has to be visible: ${state.backlog}`);
  assert.ok(state.rate > 1, 'the rate has to climb to repay the backlog');
});

test('a beat eases the rate down and back: the speed is continuous through the beat', () => {
  reset({ shown: 98, lastPlayhead: 9.984 });
  S.audio.currentTime = 10;
  state.hitList = [{ time: 9.5, strength: 1 }];
  state.hitIdx = 0;
  state.hitSource = 'map';
  const hitSlow = S.marketParam('hitSlow');
  const maxRate = S.marketParam('maxRate');
  assert.equal(hitSlow, 0.14, 'the default hitSlow moved; this test pinned 0.14');

  const rates = [];
  S.marketStepClock(0.05, 1.00);
  assert.equal(state.hits, 1, 'the beat point was not consumed');
  rates.push(state.rate);
  assert.ok(state.rate < 1, `the rate did not start dropping: ${state.rate}`);
  assert.ok(state.rate > hitSlow, `the rate dropped to hitSlow in one frame - that is the stutter, not an ease: ${state.rate}`);
  assert.ok(state.shown < 98.5, `the first slowed frame still moved ${state.shown - 98} candles`);

  for (const now of [1.03, 1.06, 1.09]) {
    S.marketStepClock(0.05, now);       // inside hitHold (0.10s from 1.00)
    rates.push(state.rate);
  }
  assert.ok(state.rate < hitSlow + 0.12, `the rate never reached the stall: ${state.rate}`);
  assert.ok(state.backlog > 0.5, `the backlog has to grow while the head is held: ${state.backlog}`);

  for (const now of [1.14, 1.2, 1.3]) {
    S.marketStepClock(0.05, now);
    rates.push(state.rate);
  }
  assert.ok(state.rate > hitSlow, `the rate did not rebound: ${state.rate}`);
  assert.ok(state.rate <= maxRate + 1e-9, `the rate overshot maxRate: ${state.rate}`);

  for (let i = 1; i < rates.length; i++) {
    assert.ok(Math.abs(rates[i] - rates[i - 1]) < 0.6,
      `the rate jumped ${Math.abs(rates[i] - rates[i - 1]).toFixed(2)} in one frame: ${rates.map((r) => r.toFixed(2)).join(' ')}`);
  }
  for (let i = 0; i < 400; i++) S.marketStepClock(0.05, 1.4 + i * 0.05);
  assert.ok(Math.abs(state.shown - 100) < 1e-6, `the stall was never repaid: shown ${state.shown}, target 100`);
});

test('the rate stays inside [hitSlow, maxRate] on every step of a full catch-up', () => {
  reset({ shown: 90, lastPlayhead: 9.984 });
  S.audio.currentTime = 10;
  state.hitList = [{ time: 9, strength: 1 }, { time: 9.5, strength: 1 }];
  state.hitIdx = 0;
  state.hitSource = 'map';
  const lo = S.marketParam('hitSlow');
  const hi = S.marketParam('maxRate');
  for (let i = 0; i < 400; i++) {
    S.marketStepClock(0.05, 1 + i * 0.05);
    assert.ok(state.rate >= lo - 1e-9, `rate ${state.rate} fell below hitSlow ${lo} at step ${i}`);
    assert.ok(state.rate <= hi + 1e-9, `rate ${state.rate} passed maxRate ${hi} at step ${i}`);
  }
});

test('seeking backwards makes the head land on the new playhead instead of running to it', () => {
  reset({ shown: 90, snaps: 0, lastPlayhead: 10 });
  S.audio.currentTime = 5;              // target = 50
  S.marketStepClock(0.016, 3);
  assert.ok(Math.abs(state.shown - 50) < 1e-9, `the seek did not snap: shown ${state.shown}, expected 50`);
  assert.equal(state.snaps, 1, 'a snap has to be counted, or the camera prime is never released');
  assert.equal(state.written, 0, 'a seek has to reset the write cursor');
});

test('a jump in the audio clock bigger than seekSnap is a seek, not a chase', () => {
  reset({ shown: 10, snaps: 0, lastPlayhead: 0 });
  S.audio.currentTime = 100;            // the audio clock itself jumped 100s
  S.marketStepClock(0.016, 3);
  assert.ok(Math.abs(state.shown - 1000) < 1e-9, `the jump was chased instead of snapped: shown ${state.shown}`);
  assert.equal(state.snaps, 1);
});

// ---------------------------------------------------------------- the beat's kickback

test('a beat kicks the camera and lights the wall on the same hit, and both decay', () => {
  reset({ shown: 98, lastPlayhead: 9.984 });
  S.audio.currentTime = 10;
  state.hitList = [{ time: 9.5, strength: 0.8 }];
  state.hitIdx = 0;
  state.hitSource = 'map';
  S.marketStepClock(0.016, 1);
  const amp = S.marketParam('camShake') * 0.8;
  assert.ok(Math.abs(S.marketCam.shake - amp) < 1e-9, `the shake must be camShake * strength, got ${S.marketCam.shake}`);
  assert.equal(state.wallFlash, 1, 'the wall has to flash on the same hit');
  const before = S.marketCam.shake;
  for (let i = 0; i < 25; i++) S.marketStepClock(0.016, 1.1 + i * 0.016);
  assert.ok(S.marketCam.shake < before * 0.2, `the shake has to decay: ${S.marketCam.shake} from ${before}`);
  assert.ok(state.wallFlash < 0.2, `the flash has to decay: ${state.wallFlash}`);
  assert.ok(S.marketCam.shakePhase > 0.3, 'the shake needs a phase, or it has no wobble frequency');
});

test('the wall flare reaches the material colour, and is white when there is none', () => {
  reset({ shown: 10 });
  let rgb = null;
  state.wall = { material: { opacity: 1, color: { setRGB(r, g, b) { rgb = [r, g, b]; } } } };
  state.wallFlash = 1;
  S.marketUpdateInstances();
  assert.ok(rgb, 'the wall material colour must be written every frame');
  assert.ok(rgb[0] > 1.1, `the flare must brighten the map: ${rgb}`);
  assert.ok(rgb[0] > rgb[1] && rgb[1] > rgb[2], 'the flare should be warm, not grey');
  state.wallFlash = 0;
  S.marketUpdateInstances();
  assert.ok(Math.abs(rgb[0] - 1) < 1e-9 && Math.abs(rgb[2] - 1) < 1e-9, `no flash must leave the map white: ${rgb}`);
  state.wall = null;
});

// ---------------------------------------------------------------- the framing

test('auto zoom frames the recent swing to zoomFill of the visible height', () => {
  reset({ shown: 1, lastStep: 1 });
  state.series.high[0] = 2; state.series.high[1] = 2;
  state.series.low[0] = -2; state.series.low[1] = -2;
  state.zoomDist = 0;
  S.marketUpdateZoom();
  const range = S.marketSeriesY(2) - S.marketSeriesY(-2);
  const tan = Math.tan(S.marketParam('fovDeg') * Math.PI / 360);
  const want = range / (S.marketParam('zoomFill') * 2 * tan);
  assert.ok(Math.abs(state.zoomDist - want) < 1e-6, `zoom distance ${state.zoomDist} vs ${want}`);
  assert.ok(Math.abs(state.zoomRange - range) < 1e-9, `the framed range has to be remembered: ${state.zoomRange}`);

  // And the pose uses it: on +Z, at yaw 0 and pitch 0, the eye sits `dist` behind the head.
  assert.equal(S.marketCameraScratch(), true);
  const pos = new THREE.Vector3(), look = new THREE.Vector3();
  S.marketCameraGoal(pos, look);
  assert.ok(Math.abs(pos.z - want) < 1e-6, `the camera must stand at the framed distance, got z=${pos.z}`);

  // Turning auto zoom off must give the manual distance back.
  S.marketTuning = { autoZoom: 0 };
  try {
    S.marketCameraGoal(pos, look);
    assert.ok(Math.abs(pos.z - S.marketParam('camDist')) < 1e-6, `auto off must use camDist: ${pos.z}`);
  } finally {
    S.marketTuning = undefined;
  }
});

// ---------------------------------------------------------------- the crash sparks

test('a candle that lands far below the swing throws embers where it hit, then burns out', () => {
  reset({ shown: 50 });
  const s = state.series;
  for (let i = 0; i < 40; i++) {
    s.high[i] = 0.5; s.low[i] = -0.5; s.open[i] = -0.3; s.close[i] = -0.3;
  }
  s.high[40] = 0; s.low[40] = -4; s.open[40] = -0.3; s.close[40] = -3.5;
  const calm = S.marketSpawnCrashSpark(30);
  assert.equal(calm, 0, 'a candle inside the swing is not a crash');
  const power = S.marketSpawnCrashSpark(40);
  assert.ok(power > 0.5, `a 3.7 unit drop on a 1 unit swing has to fire: ${power}`);
  const sp = state.sparks;
  let alive = 0;
  for (let i = 0; i < sp.life.length; i++) if (sp.life[i] > 0) alive++;
  assert.ok(alive >= 14, `the crash must light a fan of embers: ${alive}`);
  // They start at the landing point: the crash candle's low, on the chart plane.
  assert.ok(Math.abs(sp.pos[1] - S.marketSeriesY(-4)) < 1e-6, `the first ember must sit on the low: ${sp.pos[1]}`);
  for (let i = 0; i < 200; i++) S.marketStepSparks(0.016);
  let still = 0;
  for (let i = 0; i < sp.life.length; i++) if (sp.life[i] > 0) still++;
  assert.equal(still, 0, 'the embers must burn out');
});

// ---------------------------------------------------------------- what is already on screen

test('a candle that is already history is never written again', () => {
  reset({ shown: 10.5, written: 0 });
  S.marketUpdateInstances();
  const first = state.bodies.writes.slice();
  assert.deepEqual(first, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], `the first frame must write every candle up to the growing head, got ${first}`);
  assert.equal(state.written, 10, `the write cursor must stop at the last complete candle (got ${state.written})`);
  assert.equal(state.bodies.count, 11, `the growing head is drawn as its own instance (count ${state.bodies.count})`);
  assert.deepEqual(state.wicks.writes.slice(), first, 'the wick of a candle must be written with its body');

  state.bodies.writes.length = 0;
  state.wicks.writes.length = 0;
  state.shown = 11.5;
  S.marketUpdateInstances();
  assert.deepEqual(state.bodies.writes, [10, 11], `only the completed candle and the new head may be written: ${state.bodies.writes}`);
  assert.equal(state.written, 11);

  state.bodies.writes.length = 0;
  state.shown = 12.0;                   // exactly on a boundary: no growing tail this frame
  S.marketUpdateInstances();
  assert.deepEqual(state.bodies.writes, [11], `a frame that only completes one candle writes one: ${state.bodies.writes}`);
  assert.ok(state.bodies.writes.every((i) => i >= 11), 'no index below the write cursor may be rewritten');
});

test('the curve follows the same count as the bodies', () => {
  reset({ shown: 7.25, written: 0 });
  S.marketUpdateInstances();
  assert.deepEqual(state.curve.geometry.drawRange, { start: 0, count: 8 }, `the line must draw the head too: ${JSON.stringify(state.curve.geometry.drawRange)}`);
  const arr = state.curve.geometry.attributes.position.array;
  assert.ok(Math.abs(arr[7 * 3] - S.marketCandleX(7)) < 1e-6, 'the head vertex must sit at the head candle x');
  assert.ok(Math.abs(arr[6 * 3 + 2]) < 1e-9, 'the curve lives on the chart plane (z = 0)');
});

// ---------------------------------------------------------------- which list drives the stall

test('the beat grid drives the timing, with the heard hits as a fallback', () => {
  reset();
  S.currentBeatMap = {
    hits: [{ time: 1, strength: 1 }],
    pulseBeats: [{ time: 2, strength: 0.5 }, { time: 3, strength: 0.5 }]
  };
  let list = S.marketHitList();
  assert.equal(list.length, 2, `the grid must win over the heard hits: got ${list.length} points`);
  assert.equal(list[0].time, 2, 'the grid list is the one that came back');

  S.currentBeatMap = { hits: [{ time: 1, strength: 1 }] };
  list = S.marketHitList();
  assert.equal(list.length, 1, 'with no grid the heard hits are the fallback');
  assert.equal(list[0].time, 1);

  // An empty list is not a list: a song whose grid came back empty must fall through to the next
  // source instead of stalling the chart forever.
  S.currentBeatMap = { pulseBeats: [], cameraBeats: [{ time: 4, strength: 0.5 }] };
  list = S.marketHitList();
  assert.equal(list.length, 1, 'an empty pulse list must fall through to cameraBeats');
  assert.equal(list[0].time, 4);
});

test('with beatSync off the rate never drops, even with a beat point waiting', () => {
  reset({ shown: 98 });
  S.audio.currentTime = 10;
  state.hitList = [{ time: 9.5, strength: 1 }];
  state.hitIdx = 0;
  state.hitSource = 'map';
  S.marketTuning = { beatSync: 0 };
  try {
    S.marketStepClock(0.05, 1);
    assert.equal(state.hits, 0, 'a beat point was consumed with the stretch switched off');
    assert.ok(state.rate >= 1 - 1e-9, `the rate fell below 1 with the stretch off: ${state.rate}`);
  } finally {
    S.marketTuning = undefined;
  }
});

// ---------------------------------------------------------------- the camera

function stubCamera(pos, look) {
  const p = pos || { x: 1, y: 2, z: 3 };
  const l = look || { x: 0, y: 0, z: 0 };
  const cam = {
    position: new THREE.Vector3(p.x, p.y, p.z),
    fov: 45, aspect: 1.7,
    lookAt() {}, updateProjectionMatrix() {},
    getWorldDirection(v) {
      const dx = l.x - cam.position.x, dy = l.y - cam.position.y, dz = l.z - cam.position.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      return v.set(dx / len, dy / len, dz / len);
    }
  };
  return cam;
}

test('a pinned free camera does not hold the market view', () => {
  // locked but not active is where the free camera was left, not an input. Holding the preset
  // at that pose leaves the chart unframed and makes the panel's 重置视角 move nothing.
  reset({ shown: 0 });
  S.camera = stubCamera();
  S.freeCamera = { locked: true, active: false, resetTween: null };
  S.marketCam.blend = 1;
  S.marketCam.primed = false;
  S.marketCam.yaw = 0;
  S.marketCam.pitch = 0;
  S.marketCam.zoom = 1;
  S.applyStockCameraPose(0.016);
  assert.ok(Math.abs(S.camera.position.x - (S.marketCandleX(0) + S.marketParam('camLead'))) < 1e-6,
    `the pin held the camera at (${S.camera.position.x}, ${S.camera.position.y}, ${S.camera.position.z})`);
  S.freeCamera = undefined;
  S.camera = undefined;
});

for (const [name, freeCamera] of [
  ['a free camera the user is flying', { locked: false, active: true, resetTween: null }],
  ['a free camera easing back into place', { locked: true, active: false, resetTween: {} }],
]) {
  test(`${name} keeps the camera`, () => {
    reset({ shown: 0 });
    S.camera = stubCamera();
    S.freeCamera = freeCamera;
    S.marketCam.blend = 1;
    S.marketCam.primed = true;
    const before = [S.camera.position.x, S.camera.position.y, S.camera.position.z];
    S.applyStockCameraPose(0.016);
    assert.deepEqual([S.camera.position.x, S.camera.position.y, S.camera.position.z], before,
      'the market wrote the camera while the free camera owned it');
    assert.equal(S.marketCam.primed, true, 'the preset must not spend its damp state while it is yielding');
    S.freeCamera = undefined;
    S.camera = undefined;
  });
}

test('with the free camera released the pose damps onto the head, learned from real dt', () => {
  reset({ shown: 0 });
  S.camera = stubCamera();
  S.freeCamera = { locked: false, active: false, resetTween: false };
  S.marketCam.blend = 1;
  S.marketCam.primed = false;          // an unprimed camera takes the goal whole, not a fraction
  S.marketCam.yaw = 0;
  S.marketCam.pitch = 0;
  S.marketCam.zoom = 1;
  S.applyStockCameraPose(0.016);
  const dist = S.marketParam('camDist');
  const lead = S.marketParam('camLead');
  const lift = S.marketParam('camHeight');
  assert.ok(Math.abs(S.camera.position.x - (S.marketCandleX(0) + lead)) < 1e-6, `x: ${S.camera.position.x}`);
  assert.ok(Math.abs(S.camera.position.y - (S.marketCurveY(0) + lift)) < 1e-6, `y: ${S.camera.position.y}`);
  assert.ok(Math.abs(S.camera.position.z - dist) < 1e-6, `z: ${S.camera.position.z} (the lens must be on the +Z side)`);
  assert.ok(Math.abs(S.camera.fov - S.marketParam('fovDeg')) < 1e-6, `fov: ${S.camera.fov}`);
  assert.equal(S.marketCam.primed, true, 'the first pose must prime the damp');

  // The next frame moves a fraction, and the fraction follows the time constant: a longer dt
  // must close more of the same gap. That is what makes the camera park at a drum hit - the
  // head it follows stopped, not its own clock. The damped pose starts the same 10 units off
  // the goal both times, or the second measurement would inherit the first one's residual.
  const goalX = S.marketCandleX(state.shown) + S.marketParam('camLead');
  S.marketCam.posX = goalX + 10;
  S.camera.position.set(1, 2, 3);
  S.applyStockCameraPose(0.016);
  const shortGap = Math.abs(S.marketCam.posX - goalX);
  S.marketCam.posX = goalX + 10;
  S.camera.position.set(1, 2, 3);
  S.applyStockCameraPose(0.064);
  const longGap = Math.abs(S.marketCam.posX - goalX);
  assert.ok(longGap < shortGap, `a longer dt must close more of the gap (${shortGap} -> ${longGap})`);
  assert.ok(shortGap > 0 && shortGap < 10, `one frame must close part of the gap, not all or none (${shortGap})`);
  assert.ok(Math.abs(S.camera.position.x - S.marketCam.posX) < 1e-6, 'the damped pose has to reach the camera');
  S.freeCamera = undefined;
  S.camera = undefined;
});

test('resetMarketCamera returns the view to the axis and unprimes the damp', () => {
  reset({ shown: 0 });
  S.marketCam.yaw = 1.2;
  S.marketCam.pitch = -0.4;
  S.marketCam.zoom = 2.5;
  S.marketCam.primed = true;
  S.resetMarketCamera();
  assert.equal(S.marketCam.yaw, 0);
  assert.equal(S.marketCam.pitch, 0);
  assert.equal(S.marketCam.zoom, 1);
  assert.equal(S.marketCam.primed, false, 'a camera that is primed would glide from the old view');
});

// ---------------------------------------------------------------- the colours and the side

test('red on the way up by default, and the switch swaps the pair', () => {
  reset({ shown: 0 });
  state.energyRef = 1;
  assert.equal(S.marketCandleScratch(), true, 'the colour scratch must allocate');
  const read = () => ({ r: S.marketScratchColor.r, g: S.marketScratchColor.g, b: S.marketScratchColor.b });
  S.marketTuning = undefined;
  let c = (S.marketCandleColor(true, 1), read());
  assert.ok(c.r > c.g * 2 && c.r > c.b * 2, `an up candle must be red by default, got ${c.r}/${c.g}/${c.b}`);
  c = (S.marketCandleColor(false, 1), read());
  assert.ok(c.g > c.r * 2, `a down candle must be green by default, got ${c.r}/${c.g}/${c.b}`);
  S.marketTuning = { colorFlip: 1 };
  try {
    c = (S.marketCandleColor(true, 1), read());
    assert.ok(c.g > c.r * 2, `with 绿涨红跌 on, an up candle must be green, got ${c.r}/${c.g}/${c.b}`);
    c = (S.marketCandleColor(false, 1), read());
    assert.ok(c.r > c.g * 2, `with 绿涨红跌 on, a down candle must be red, got ${c.r}/${c.g}/${c.b}`);
  } finally {
    S.marketTuning = undefined;
  }
});

test('the camera stands on +Z so the chart grows left to right on screen', () => {
  reset({ shown: 12 });
  S.camera = stubCamera();
  S.freeCamera = undefined;
  S.marketCam.blend = 1;
  S.marketCam.primed = false;
  S.marketCam.yaw = 0;
  S.marketCam.pitch = 0;
  S.marketCam.zoom = 1;
  S.applyStockCameraPose(0.016);
  // A camera looking along -Z has world +X on its screen-right; from -Z (looking along +Z) the
  // same world axis lands on the left and the chart grows backwards.
  assert.ok(S.camera.position.z > 0, `the camera must be on the +Z side, got z=${S.camera.position.z}`);
  assert.ok(S.camera.position.x > S.marketCandleX(12), 'camLead must put the lens past the head, toward the un-drawn future');
  S.camera = undefined;
});

test('the wall sits behind the chart, on the far side from the camera', () => {
  reset({ shown: 0 });
  state.wall = { position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1), visible: true };
  state.wallTex = null;
  S.camera = stubCamera({ x: 4, y: 1.6, z: 9 }, { x: 0, y: 0, z: 0 });
  S.marketPlaceWall();
  assert.equal(state.wall.position.z, -S.marketParam('wallDepth'),
    `the wall must be at -wallDepth, got ${state.wall.position.z}`);
  assert.ok(state.wall.position.z < 0, 'the wall must be behind the chart from a +Z camera');
  assert.ok(state.wall.scale.x > 0 && state.wall.scale.y > 0, 'the wall must cover the frustum');
  state.wall = null;
  S.camera = undefined;
});

// ---------------------------------------------------------------- the price axis

test('the iterated price is scaled by one knob and offset by another, and the curve follows it', () => {
  reset({ shown: 0 });
  const drift = S.marketParam('priceDrift');
  const floor = S.marketParam('priceFloor');
  assert.ok(Math.abs(S.marketSeriesY(0) - floor) < 1e-9, 'the midline must land on priceFloor');
  assert.ok(Math.abs(S.marketSeriesY(1) - (floor + drift)) < 1e-9, 'one octave of drift must be one priceDrift');
  assert.ok(Math.abs(S.marketSeriesY(-2) - (floor - 2 * drift)) < 1e-9, 'the scale must be linear both ways');

  S.marketTuning = { priceDrift: 0.5, priceFloor: 1.25 };
  try {
    assert.ok(Math.abs(S.marketSeriesY(2) - 2.25) < 1e-9, `knobs must be read: got ${S.marketSeriesY(2)}`);
  } finally {
    S.marketTuning = undefined;
  }

  // The curve is the closes read through the same scale, so a head between two closes is between
  // their two heights - that is what the camera damps against.
  state.series.close[0] = 0;
  state.series.close[1] = 1;
  const y0 = S.marketSeriesY(0), y1 = S.marketSeriesY(1);
  assert.ok(Math.abs(S.marketCurveY(0) - y0) < 1e-9, 'the curve at a candle equals its close');
  assert.ok(Math.abs(S.marketCurveY(0.5) - (y0 + (y1 - y0) * 0.5)) < 1e-9, 'the curve glides between closes');
});

test('the candles are laid out left to right at candleSpacing, with their own index', () => {
  const step = S.marketParam('candleSpacing');
  let prev = -Infinity;
  for (let i = 0; i < 200; i++) {
    const x = S.marketCandleX(i);
    assert.ok(Math.abs(x - i * step) < 1e-9, `candle ${i} sits at ${x}, expected ${i * step}`);
    assert.ok(x > prev || i === 0, `the chart must not fold back at candle ${i}`);
    prev = x;
  }
});

// ---------------------------------------------------------------- the scene lifecycle

test('leaving the preset disposes the scene and re-entering rebuilds it', () => {
  reset();
  const group = { children: [], add(o) { this.children.push(o); }, remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); } };
  const scene = { children: [], add(o) { this.children.push(o); }, remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); } };
  S.scene = scene;
  S.fx = { preset: 15 };
  Object.assign(state, {
    group: group, built: true, series: makeSeries(20),
    bodies: Object.assign(fakeMesh(), { geometry: { dispose() {} }, material: { dispose() {} } }),
    wicks: Object.assign(fakeMesh(), { geometry: { dispose() {} }, material: { dispose() {} } }),
    curve: Object.assign(fakeCurve(20), { geometry: Object.assign(fakeCurve(20).geometry, { dispose() {} }), material: { dispose() {}, opacity: 1 } }),
    wall: { visible: true, geometry: { dispose() {} }, material: { dispose() {} } }
  });
  scene.children.push(group);
  assert.equal(S.applyMarketPresetNow(16, 15), false, 'leaving must report that the preset is off');
  assert.equal(state.built, false, 'leaving must unbuild the scene');
  assert.equal(state.group, null, 'leaving must drop the group');
  assert.equal(scene.children.length, 0, 'leaving must take the group out of the scene');
  S.scene = undefined;
});

// __END_TESTS__

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`market-preset-gate: ${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;