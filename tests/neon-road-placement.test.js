'use strict';

// 预设 16 的歌词车道：一条线在地平线处以极小字号出现，按 1/深度长到标准字号（t=1），
// 继续放大到屏幕装不下（carExitSize 倍屏高）才消失；屏幕高度只下沉 carDrop，而且到站后不再往下走。
// neonPlaceCar 与 neonExitTravel 直接从模块里取出来跑，判据是数值。

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

const defaults = {};
for (const m of src.matchAll(/(\w+):\s*\{\s*def:\s*(-?[\d.]+),\s*min:\s*-?[\d.]+,\s*max:\s*-?[\d.]+/g)) {
  defaults[m[1]] = Number(m[2]);
}
const neonParam = (key) => (defaults[key] !== undefined ? defaults[key] : 0);

const run = new Function('neonParam', 'neonClamp01',
  fn('neonClamp01') + '\n' + fn('neonExitTravel') + '\n' + fn('neonPlaceCar')
  + '\nreturn { neonPlaceCar: neonPlaceCar, neonExitTravel: neonExitTravel };')(neonParam, (v) => Math.min(1, Math.max(0, Number(v) || 0)));

function place(t, aspect) {
  const car = {
    body: { visible: false,
      position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      scale: { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; } } },
    bodyMat: { opacity: 1 },
    aspect: aspect || 4
  };
  const out = run.neonPlaceCar(car, t, 1);
  const tanHalf = Math.tan((defaults.camFov * Math.PI) / 360);
  const screenFraction = out.h / (2 * out.d * tanHalf);
  const yNdc = car.body.position.y / (out.d * tanHalf);
  return { d: out.d, size: out.size, screenFraction, yNdc, z: car.body.position.z, opacity: car.bodyMat.opacity };
}

const near = defaults.carDepthNear;
const far = defaults.carDepthFar;
const ratio = far / near;
const drop = defaults.horizon - defaults.carDrop;

// 1) arrival: standard size at the near distance, carDrop below the horizon
const arrival = place(1);
assert.ok(Math.abs(arrival.screenFraction - defaults.carSize) < 1e-9,
  `t=1 must be the standard size (got ${arrival.screenFraction}, want ${defaults.carSize})`);
assert.ok(Math.abs(arrival.yNdc - drop) < 1e-9, `t=1 must sit carDrop below the horizon (got ${arrival.yNdc})`);
assert.equal(arrival.d, near);
assert.equal(arrival.z, -near);

// 2) the far end: a speck at the horizon, and the screen size is carSize * near/depth throughout
const startOfRoad = place(0);
// t is floored at 0.0005 so the projection never divides by zero; the far end is therefore a hair
// closer than carDepthFar, and the speck a hair below the horizon.
assert.ok(Math.abs(startOfRoad.d - far) < 0.2, `t=0 must be at the far distance (got ${startOfRoad.d})`);
assert.ok(Math.abs(startOfRoad.screenFraction - defaults.carSize / ratio) < 1e-5,
  `t=0 must be a speck (got ${startOfRoad.screenFraction})`);
assert.ok(Math.abs(startOfRoad.yNdc - defaults.horizon) < 1e-3, 't=0 must sit on the horizon');
for (const t of [0.25, 0.5, 1.5, 1.8]) {
  const p = place(t);
  assert.ok(Math.abs(p.d - near * Math.pow(ratio, 1 - t)) < 1e-9, `depth at t=${t} must follow the exponential`);
  assert.ok(Math.abs(p.screenFraction - p.size) < 1e-9, 'the returned size must be the screen fraction');
  assert.ok(Math.abs(p.size - defaults.carSize * near / p.d) < 1e-9, 'size must be carSize * near/depth');
  const wantY = defaults.horizon - defaults.carDrop * Math.min(1, t);
  assert.ok(Math.abs(p.yNdc - wantY) < 1e-9, `the drop must stop at arrival (t=${t})`);
}

// 3) it grows past the frame and only then leaves: the exit parameter is where the size reaches
// the knob, and just before it the glyphs are still larger than the screen.
const exitT = run.neonExitTravel();
const atExit = place(exitT);
assert.ok(Math.abs(atExit.screenFraction - defaults.carExitSize) < 1e-6,
  `the exit must happen at ${defaults.carExitSize} screen heights (got ${atExit.screenFraction})`);
assert.ok(defaults.carExitSize > 1, 'the text has to leave the frame by being too big to read');
assert.ok(exitT > 1.2, 'the exit has to be after arrival, not on it');
assert.ok(atExit.opacity < 0.05, 'the text must be faded out on the frame it leaves');

// 4) entrance fade: a faint speck at the start, fully opaque by arrival
assert.ok(place(0.02).opacity < 0.2, 'the far end must fade in, not pop');
assert.ok(place(0.5).opacity > place(0.02).opacity, 'the fade must go the right way');

console.log('OK neon-road: arrival ' + Math.round(arrival.screenFraction * 1000) / 10 + '% of height at depth '
  + arrival.d + '; horizon ' + (Math.round(startOfRoad.screenFraction * 10000) / 100) + '%; exit at t=' + exitT.toFixed(2)
  + ' (' + defaults.carExitSize + ' screens, depth ' + atExit.d.toFixed(2) + ')');
