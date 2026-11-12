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
  return { Vector3, Quaternion, Color, Matrix4 };
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

// A series whose price is flat: every open/close/high/low the same Hz, so the only thing that
// moves in these tests is the clock and the write cursor.
const CLOSE = 110;
function makeSeries(count) {
  const open = new Float32Array(count);
  const close = new Float32Array(count);
  const high = new Float32Array(count);
  const low = new Float32Array(count);
  const energy = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    open[i] = CLOSE; close[i] = CLOSE; high[i] = CLOSE; low[i] = CLOSE; energy[i] = 1;
  }
  return { count, candlesPerSec: 10, open, close, high, low, energy };
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

function reset(over) {
  Object.assign(state, {
    series: makeSeries(1000), group: {}, bodies: fakeMesh(), wicks: fakeMesh(),
    curve: fakeCurve(1000), wall: null, written: 0, shown: 0, rate: 1, slowUntil: 0,
    hitList: [], hitIdx: 0, hitSource: '', hits: 0, snaps: 0, backlog: 0, energyRef: 1
  }, over || {});
  S.audio.currentTime = 0;
  S.currentBeatMap = null;
  S.fx = { preset: 16 };
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
  reset({ shown: 98 });
  S.audio.currentTime = 10;             // target = 100 candles
  let prev = state.shown;
  for (let i = 0; i < 40; i++) {
    S.marketStepClock(0.05, 1 + i * 0.05);
    assert.ok(state.shown >= prev - 1e-9, `the head went backwards: ${prev} -> ${state.shown}`);
    assert.ok(state.shown <= S.marketPlayheadCandles() + 1e-9, `the head passed the playhead: ${state.shown} > 100`);
    prev = state.shown;
  }
  assert.ok(Math.abs(state.shown - 100) < 1e-6, `the head did not reach the playhead: ${state.shown}`);
});

test('a beat point drops the rate to hitSlow for hitHold, then the rebound outruns 1x to repay it', () => {
  reset({ shown: 98 });
  S.audio.currentTime = 10;
  // The grid, not the hits: this is what the app supplies for a song whose intro has no drums.
  state.hitList = [{ time: 9.5, strength: 1 }];
  state.hitIdx = 0;
  state.hitSource = 'map';
  const hitSlow = S.marketParam('hitSlow');
  assert.equal(hitSlow, 0.14, 'the default hitSlow moved; this test pinned 0.14');

  S.marketStepClock(0.05, 1.00);
  assert.equal(state.hits, 1, 'the beat point was not consumed');
  assert.ok(Math.abs(state.rate - hitSlow) < 1e-9, `the rate did not drop to hitSlow: ${state.rate}`);
  const afterHit = state.shown;
  assert.ok(afterHit > 98 && afterHit < 98.1, `the slowed step moved ${afterHit - 98} candles, expected ~0.07`);

  S.marketStepClock(0.05, 1.05);        // still inside hitHold (0.10s from 1.00)
  assert.ok(Math.abs(state.rate - hitSlow) < 1e-9, `the rate recovered before the hold ended: ${state.rate}`);
  assert.ok(state.backlog > 1, `the backlog has to grow while the head is held: ${state.backlog}`);

  S.marketStepClock(0.05, 1.12);        // past the hold: the catch-up starts
  assert.ok(state.rate > hitSlow, `the rate did not rebound: ${state.rate}`);
  assert.ok(state.rate < S.marketParam('maxRate'), `the rate overshot maxRate: ${state.rate}`);

  for (let i = 0; i < 400; i++) S.marketStepClock(0.05, 1.2 + i * 0.05);
  assert.ok(Math.abs(state.shown - 100) < 1e-6, `the stall was never repaid: shown ${state.shown}, target 100`);
});

test('the rate stays inside [hitSlow, maxRate] on every step of a full catch-up', () => {
  reset({ shown: 90 });
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
  reset({ shown: 90, snaps: 0 });
  S.audio.currentTime = 5;              // target = 50
  S.marketStepClock(0.016, 3);
  assert.ok(Math.abs(state.shown - 50) < 1e-9, `the seek did not snap: shown ${state.shown}, expected 50`);
  assert.equal(state.snaps, 1, 'a snap has to be counted, or the camera prime is never released');
  assert.equal(state.written, 0, 'a seek has to reset the write cursor');
});

test('a jump bigger than seekSnap is a seek, not a chase', () => {
  reset({ shown: 10, snaps: 0 });
  S.audio.currentTime = 100;            // target = 1000, far past seekSnap
  S.marketStepClock(0.016, 3);
  assert.ok(Math.abs(state.shown - 1000) < 1e-9, `the jump was chased instead of snapped: shown ${state.shown}`);
  assert.equal(state.snaps, 1);
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

function stubCamera() {
  const cam = {
    position: new THREE.Vector3(1, 2, 3),
    fov: 45, aspect: 1.7,
    lookAt() {}, updateProjectionMatrix() {},
    getWorldDirection(v) { return v.set(0, 0, -1); }
  };
  return cam;
}

test('a locked free camera keeps the camera: the preset must yield', () => {
  reset({ shown: 0 });
  S.camera = stubCamera();
  S.freeCamera = { locked: true, active: false, resetTween: false };
  S.marketCam.blend = 1;
  S.marketCam.primed = true;
  const before = [S.camera.position.x, S.camera.position.y, S.camera.position.z];
  S.applyStockCameraPose(0.016);
  assert.deepEqual([S.camera.position.x, S.camera.position.y, S.camera.position.z], before,
    'the market wrote the camera while the free camera was locked');
  assert.equal(S.marketCam.primed, true, 'the preset must not spend its damp state while it is yielding');
  S.freeCamera = undefined;
  S.camera = undefined;
});

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
  assert.ok(Math.abs(S.camera.position.z - (-dist)) < 1e-6, `z: ${S.camera.position.z}`);
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

// ---------------------------------------------------------------- Hz -> price

test('the price axis is logarithmic, one octaveUnits per doubling, anchored at refHz', () => {
  const ref = S.marketParam('refHz');
  const oct = S.marketParam('octaveUnits');
  const floor = S.marketParam('priceFloor');
  assert.ok(Math.abs(S.marketPriceY(ref) - floor) < 1e-9, `refHz must sit on the floor: ${S.marketPriceY(ref)}`);
  assert.ok(Math.abs((S.marketPriceY(ref * 2) - S.marketPriceY(ref)) - oct) < 1e-9, 'one doubling must be one octaveUnits');
  assert.ok(Math.abs((S.marketPriceY(ref * 4) - S.marketPriceY(ref)) - 2 * oct) < 1e-9, 'two doublings must be two octaveUnits');
  let prev = -Infinity;
  for (const hz of [1, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 16000]) {
    const y = S.marketPriceY(hz);
    assert.ok(y > prev, `the price axis must rise with frequency, ${hz}Hz gave ${y} after ${prev}`);
    prev = y;
  }
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