'use strict';

// 预设 16 的歌词车道：t=0 在地平线且尺寸为 0，t=1 是标准字号；位置与尺寸都按 1/深度。
// 这条臂把 neonPlaceCar 从模块里取出来直接跑（它只碰 Math 与 neonParam），所以判据是数值，
// 不是"源码里出现过某个式子"。实机帧数与异常由 CDP 探针另行读数。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '21-neon-fuji-preset.js'), 'utf8');

const defaults = { camFov: 52 };
for (const m of src.matchAll(/(\w+):\s*\{\s*def:\s*(-?[\d.]+),\s*min:\s*-?[\d.]+,\s*max:\s*-?[\d.]+/g)) {
  defaults[m[1]] = Number(m[2]);
}
const neonParam = (key) => (defaults[key] !== undefined ? defaults[key] : 0);

const start = src.indexOf('function neonPlaceCar(');
assert.ok(start > 0, 'neonPlaceCar must exist: it is the only place that turns t into a road point');
const end = src.indexOf('\n}\n', start) + 3;
const neonPlaceCar = new Function('neonParam', src.slice(start, end) + '\nreturn neonPlaceCar;')(neonParam);

function place(t, aspect) {
  const car = {
    body: { visible: false, position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      scale: { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; } } },
    bodyMat: { opacity: 1 },
    aspect: aspect || 4
  };
  const out = neonPlaceCar(car, t, 1);
  const tanHalf = Math.tan((defaults.camFov * Math.PI) / 360);
  const screenFraction = out.h / (2 * out.d * tanHalf);
  const yNdc = car.body.position.y / (out.d * tanHalf);
  return { d: out.d, h: out.h, w: out.w, screenFraction, yNdc, z: car.body.position.z };
}

const near = defaults.carDepthNear;

// 1) the end of the road: the standard size, the standard drop below the horizon
const endOfRoad = place(1);
assert.ok(Math.abs(endOfRoad.screenFraction - defaults.carSize) < 1e-9,
  `t=1 must be the standard size (got ${endOfRoad.screenFraction}, want ${defaults.carSize})`);
assert.ok(Math.abs(endOfRoad.yNdc - (defaults.horizon - defaults.carDrop)) < 1e-9,
  `t=1 must sit carDrop below the horizon (got ${endOfRoad.yNdc})`);
assert.equal(endOfRoad.d, near);
assert.equal(endOfRoad.z, -near);

// 2) both the screen size and the depth are 1/t
for (const t of [0.05, 0.1, 0.25, 0.5, 0.8]) {
  const p = place(t);
  assert.ok(Math.abs(p.d - near / t) < 1e-9, `depth at t=${t} must be ${near / t} (got ${p.d})`);
  assert.ok(Math.abs(p.screenFraction - defaults.carSize * t) < 1e-9,
    `screen fraction at t=${t} must be ${defaults.carSize * t} (got ${p.screenFraction})`);
  assert.ok(Math.abs(p.yNdc - (defaults.horizon - defaults.carDrop * t)) < 1e-9,
    `the car at t=${t} must sit on the road toward the drop point (got ${p.yNdc})`);
}
// Half the t = twice the screen size: that is what reads as perspective instead of a sprite tween.
const half = place(0.5), quarter = place(0.25);
assert.ok(Math.abs(half.screenFraction / quarter.screenFraction - 2) < 1e-9,
  'halving the travel must double the screen size');

// 3) t=0 sits on the horizon at (almost) zero size, not at NaN or a negative scale
const startOfRoad = place(0);
assert.ok(isFinite(startOfRoad.screenFraction) && startOfRoad.screenFraction > 0, 't=0 must still be a finite, positive size');
assert.ok(startOfRoad.screenFraction < 1e-3, `t=0 must be a speck at the horizon (got ${startOfRoad.screenFraction})`);
assert.ok(startOfRoad.d <= 400, 'the start of the road must be capped, or the car is parsecs away');
assert.ok(startOfRoad.yNdc <= defaults.horizon + 1e-9, 'the start of the road must not sit above the horizon');

// 4) the afterimage is the same road, earlier: same function, earlier t, copies of one texture
assert.ok(src.includes('var tk = t - (k + 1) * trailGap;'), 'the trails must be earlier points on the same road');
assert.ok(/neonPlaceCar\(\{ body: slot\.mesh, bodyMat: slot\.mat, aspect: car\.aspect \}, tk, 1\)/.test(src),
  'each afterimage copy must be placed by the same projection');
assert.strictEqual((src.match(/function neonPlaceCar\(/g) || []).length, 1, 'there must be exactly one placement function');
assert.ok(src.includes('car.band.position.set(0, placed.y - placed.h * 0.62, -placed.d);'),
  'the light band must ride the same projected point');

console.log('OK neon-road: t=1 ' + Math.round(endOfRoad.screenFraction * 1000) / 10 + '% of screen height at depth '
  + endOfRoad.d + ', t=0.05 ' + (Math.round(place(0.05).screenFraction * 10000) / 100) + '%; size and depth both 1/t');
