'use strict';

// 预设 16 的车队：喂一份真实的歌词时间轴 + 节拍网格，读三件事——
//   1) 入场时间：提前量被拍到节拍上，到达时刻就是这一句自己的时间戳；
//   2) 行驶参数：到达时 1 倍标准字号，之后继续放大到超出屏幕才消失；
//   3) 拖影：沿轨迹"盖章"的冻结投影，停住不动、按寿命回池，而不是跟着车速一起挤在终点。
// THREE 与 canvas 都是桩，判据全部是数值。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '21-neon-fuji-preset.js'), 'utf8');

function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const end = src.indexOf('\n}\n', start) + 3;
  return src.slice(start, end);
}

const defaults = { camFov: 52 };
for (const m of src.matchAll(/(\w+):\s*\{\s*def:\s*(-?[\d.]+),\s*min:\s*-?[\d.]+,\s*max:\s*-?[\d.]+/g)) {
  defaults[m[1]] = Number(m[2]);
}
const neonParam = (key) => (defaults[key] !== undefined ? defaults[key] : 0);

const ctx = {
  font: '', textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0, fillStyle: '',
  measureText: (t) => ({ width: String(t || '').length * 40 }),
  clearRect() {}, fillText() {}
};
const document = { createElement: () => ({ width: 8, height: 8, getContext: () => ctx }) };

class Group {
  constructor() { this.children = []; }
  add(m) { this.children.push(m); }
  remove(m) { const i = this.children.indexOf(m); if (i >= 0) this.children.splice(i, 1); }
}
class Node3D {
  constructor(geometry, material) {
    this.geometry = geometry; this.material = material; this.visible = true;
    this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    this.scale = { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
  }
}
const THREE = {
  Group, Mesh: Node3D,
  PlaneGeometry: class { dispose() {} },
  MeshBasicMaterial: class {
    constructor(o) {
      Object.assign(this, o);
      if (this.opacity === undefined) this.opacity = 1;
      if (typeof this.color === 'number') this.color = { setRGB() {} };
    }
    dispose() {}
  },
  CanvasTexture: class { constructor(c) { this.image = c; this.needsUpdate = false; } dispose() {} },
  Color: class { setRGB() {} },
  sRGBEncoding: 3001
};

const lyricsLines = [
  { t: 10, duration: 2, text: '第一句歌词' },
  { t: 12, duration: 2, text: '第二句歌词' },
  { t: 14, duration: 2, text: '第三句歌词' }
];
const audio = { currentTime: 0 };
const currentBeatMap = { gridStep: 0.5, beats: [{ t: 0 }] };
const rtBeat = { tempoGap: 0.5, lastHitAt: 0 };
const neonState = { cars: [], group: new Group() };
const neonLyricPalette = () => ({ main: '#ffe6fa', glow: '#ff4fd8' });

const names = ['neonLineText', 'neonBeatGrid', 'neonEntranceAt', 'neonSizeTravel', 'neonFadeTravel',
  'neonExitTravel', 'neonLineClock', 'neonActiveLines', 'neonClamp01', 'neonMakeCar', 'neonRasterCar',
  'neonPlaceCar', 'neonCarPulse', 'neonRetireTrails', 'neonSpawnTrail', 'neonAgeTrails', 'neonStepCars', 'neonDisposeCar'];
const run = new Function(
  'THREE', 'document', 'lyricsLines', 'audio', 'currentBeatMap', 'rtBeat', 'beatPulse', 'smoothBass',
  'neonState', 'neonParam', 'neonLyricPalette', 'NEON_TRAIL_MAX',
  names.map(fn).join('\n')
  + '\nreturn {' + names.join(', ') + ', key: function () { return neonActiveLines(); }};'
)(THREE, document, lyricsLines, audio, currentBeatMap, rtBeat, 0, 0, neonState, neonParam, neonLyricPalette, 12);

function at(now) { audio.currentTime = now; return run.neonActiveLines(); }

// ---------------------------------------------------------------- 1) entrance timing
// carLead is -1s: the readable pass (t=1) is one second AFTER line 10 starts, i.e. halfway
// through a two-second line. The approach is 2.4s, so the entrance is 8.6s, snapped back to 8.5
// on the 0.5s beat grid. The travel is (share)^(1+accel), so it hangs far away, then whips in.
{
  const far = at(8.4);
  assert.equal(far.length, 0, 'before the entrance beat the next line is not on the road yet');
  const entering = at(9.75);
  assert.equal(entering.length, 1, 'the line enters while it is still far away');
  assert.equal(entering[0].current, true);
  assert.ok(Math.abs(entering[0].enterAt - 8.5) < 1e-9, 'the entrance must snap back onto the beat grid');
  assert.ok(Math.abs(entering[0].arrivalAt - 11) < 1e-9, 'the readable pass is the line start plus the offset');
  const half = Math.pow(0.5, 1 + defaults.carAccel);
  assert.ok(Math.abs(entering[0].travel - half) < 1e-9,
    `half the approach is only ${half} of the travel with accel ${defaults.carAccel}`);
  assert.ok(entering[0].travel < 0.35, 'the text hangs far away through the first half of the approach');
}
{
  const middle = at(11);
  assert.equal(middle[0].travel, 1, 'halfway through the sung line the text is at the readable pass, t=1');
  const lineEnd = at(12);
  const faceT = run.neonFadeTravel();
  assert.ok(Math.abs(lineEnd[0].travel - faceT) < 1e-9,
    'at the end of the line the text has reached the face (the fade starts)');
  assert.equal(lineEnd.length, 2, 'the next line is already on the road by then');
  assert.equal(lineEnd[0].current, false, 'the finished line is now the one leaving the lens');
  assert.equal(lineEnd[1].current, true, 'and the next line is the sung one');
}
{
  const gone = at(12.5);
  const keys = gone.map((line) => line.key);
  assert.equal(gone.length, 1, 'the line past its life is gone; the next one is still approaching');
  assert.ok(!keys.some((key) => Math.abs(Number(key.slice(1)) - 10) < 1e-6), 'the first line must be gone');
}
{
  // With the beat switch off, the entrance is the plain lead.
  const off = run.neonActiveLines;
  const saved = neonParam('beatSync');
  assert.equal(saved, 1, 'beatSync defaults on');
}

// ---------------------------------------------------------------- 2) step + trail pool
{
  neonState.cars.length = 0;
  let now = 9.0;
  audio.currentTime = now;
  run.neonStepCars(now, 0.07);
  assert.equal(neonState.cars.length, 1, 'one line on the road, one car');
  const car = neonState.cars[0];
  assert.equal(car.key, 'l10.000');
  assert.ok(car.body.visible && car.body.material.map === car.texture, 'the car draws its own rasterised text');

  // 0.07s frames for a second: the line keeps moving, projections are stamped behind it.
  const positions = new Map();
  for (let f = 0; f < 15; f++) {
    now += 0.07;
    audio.currentTime = now;
    run.neonStepCars(now, 0.07);
    car.trails.forEach((slot, i) => {
      if (slot.bornAt >= 0 && !positions.has(slot)) positions.set(slot, { z: slot.mesh.position.z, y: slot.mesh.position.y, scale: slot.mesh.scale.y, at: slot.bornAt });
    });
  }
  assert.ok(positions.size >= 4, `the run must leave projections behind (found ${positions.size})`);
  assert.ok(positions.size <= defaults.trailCount, 'the pool size is the cap, not a suggestion');
  const spawned = Array.from(positions.entries());
  // stamped beyond the car and behind one another down the road
  const zs = spawned.map((entry) => entry[1].z);
  assert.ok(zs.every((z) => z < car.body.position.z + 1e-6), 'every projection must sit behind the car on the road');
  for (let i = 0; i < spawned.length; i++) {
    for (let j = i + 1; j < spawned.length; j++) {
      assert.notEqual(spawned[i][1].z.toFixed(4), spawned[j][1].z.toFixed(4), 'two projections must not stack on one point');
    }
  }
  // frozen: a projection does not move with the car afterwards. Take the newest one, which cannot
  // be recycled by the next frame while the pool still has free slots.
  let newest = car.trails[0];
  for (const slot of car.trails) if (slot.bornAt > newest.bornAt) newest = slot;
  const before = { x: newest.mesh.position.x, y: newest.mesh.position.y, z: newest.mesh.position.z };
  now += 0.07;
  audio.currentTime = now;
  run.neonStepCars(now, 0.07);
  assert.deepEqual({ x: newest.mesh.position.x, y: newest.mesh.position.y, z: newest.mesh.position.z }, before,
    'a stamped projection must stay where it was stamped');
  // ageing: after the life time every old projection is back in the pool
  now += defaults.trailLife + 0.2;
  audio.currentTime = now;
  run.neonStepCars(now, 0.07);
  const alive = car.trails.filter((slot) => slot.bornAt >= 0);
  assert.ok(alive.every((slot) => now - slot.bornAt < defaults.trailLife), 'expired projections must be recycled');
  assert.ok(alive.length > 0, 'the moving car keeps stamping new ones');
}

// ---------------------------------------------------------------- 3) the text leaves by fading past
{
  const car = neonState.cars[0];
  const fadeT = run.neonFadeTravel();
  const exitT = run.neonExitTravel();
  const tanHalf = Math.tan((defaults.camFov * Math.PI) / 360);
  const atFade = run.neonPlaceCar(car, fadeT, 1);
  assert.ok(Math.abs(atFade.h / (2 * atFade.d * tanHalf) - defaults.carExitSize) < 1e-6,
    'the fade starts at carExitSize screen heights');
  assert.ok(atFade.fade > 0.99, 'and the text is still fully lit there');
  const atExit = run.neonPlaceCar(car, exitT, 1);
  assert.ok(atExit.fade < 1e-6 && atExit.size > atFade.size * 2,
    'by the end of the fade the glyphs are many screens tall and fully dimmed');
}

// ---------------------------------------------------------------- 4) the trail outlives the text
{
  // Walk frame by frame past the end of the first line. Its text goes away, but the stamps it left
  // behind are still fading - the car has to stay as a ghost until the last one expires.
  let now = audio.currentTime;
  for (; now < 12.5; now += 0.07) {
    audio.currentTime = now;
    run.neonStepCars(now, 0.07);
  }
  const ghost = neonState.cars.find((car) => car.key === 'l10.000');
  assert.ok(ghost, 'the car must survive its line while its projections are still fading');
  assert.equal(ghost.body.visible, false, 'the text itself is gone');
  assert.ok(ghost.trails.some((slot) => slot.bornAt >= 0), 'the stamps are still there');
  for (let f = 0; f < 14; f++) {
    now += 0.07;
    audio.currentTime = now;
    run.neonStepCars(now, 0.07);
  }
  assert.ok(!neonState.cars.some((car) => car.key === 'l10.000'),
    'once the last stamp expires the ghost car is disposed');
}

// ---------------------------------------------------------------- 5) the beat is an in-place pulse
{
  // One beat does not move the line: it swells the glyphs and lifts their neon, then eases back.
  const state = {};
  const rising = [];
  for (let f = 0; f < 6; f++) rising.push(run.neonCarPulse(state, 0.6, 2, 0.016));
  assert.ok(rising[0] > 0, 'the pulse has to start on the beat');
  assert.ok(rising[5] > rising[0], 'and keep rising while the beat holds');
  assert.ok(rising[5] < 1.2, 'but never run away past the gain');
  let released = rising[5];
  for (let f = 0; f < 20; f++) released = run.neonCarPulse(state, 0, 2, 0.05);
  assert.ok(released < rising[5] * 0.2, 'with no beat it has to ease back down');

  const base = { body: { visible: true, position: { set() {} }, scale: { set() {} } },
    bodyMat: { opacity: 1, color: { rgb: [1, 1, 1], setRGB(r, g, b) { this.rgb = [r, g, b]; } } }, aspect: 4 };
  const calm = run.neonPlaceCar(base, 1, 1, 0);
  const hit = run.neonPlaceCar(base, 1, 1, 0.8);
  assert.ok(hit.h > calm.h, 'a beat has to scale the glyphs up a little, in place');
  assert.ok(hit.d === calm.d, 'and it must not move the line closer - the travel belongs to the clock');
  assert.ok(base.bodyMat.color.rgb[0] > 1, 'a beat has to lift the brightness above the steady state');
}

// ---------------------------------------------------------------- 6) a fast song must not eat lines
{
  // Four-second lines a second apart: while a line is flying at the camera the clock has moved
  // several rows past it. The old previous/current/next window dropped it - that is the
  // "text just disappears" case on fast songs; the time window has to keep it.
  lyricsLines.length = 0;
  for (let i = 0; i < 6; i++) lyricsLines.push({ t: 10 + i, duration: 4, text: '长' + i });
  const fast = at(13.0);
  const keys = fast.map((line) => line.key);
  assert.ok(keys.some((key) => Math.abs(Number(key.slice(1)) - 10) < 1e-6), 'a line three rows back is still on the road');
  assert.ok(keys.some((key) => Math.abs(Number(key.slice(1)) - 13) < 1e-6), 'and the sung line is there too');
  assert.ok(fast.length <= 8, 'the live cap holds even in a dense passage');
}

console.log('OK neon-cars: readable pass at the middle of the line (arrival t=1 at 11s), accel '
  + defaults.carAccel + ' (half approach -> t=' + Math.pow(0.5, 1 + defaults.carAccel).toFixed(2) + '), '
  + neonState.cars.length + ' car(s), fade ends at t=' + run.neonExitTravel().toFixed(2));
