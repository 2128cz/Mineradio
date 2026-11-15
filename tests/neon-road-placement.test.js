'use strict';

// 预设 16 的歌词车道：地平线处极小 → 到站标准字号（t=1）→ 继续加速放大、向上掠过镜头，
// 期间亮度与透明度一起淡化，淡化走完才回收。判据是数值，不是源码形状。

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

const names = ['neonClamp01', 'neonSizeTravel', 'neonFadeTravel', 'neonExitTravel', 'neonPlaceCar'];
const run = new Function('neonParam', names.map(fn).join('\n')
  + '\nreturn {' + names.join(', ') + '};')(neonParam);

function place(t, aspect) {
  const car = {
    body: { visible: false,
      position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      scale: { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; } } },
    bodyMat: { opacity: 1, color: { rgb: [1, 1, 1], setRGB(r, g, b) { this.rgb = [r, g, b]; } } },
    aspect: aspect || 4
  };
  const out = run.neonPlaceCar(car, t, 1);
  const tanHalf = Math.tan((defaults.camFov * Math.PI) / 360);
  const screenFraction = out.h / (2 * out.d * tanHalf);
  const yNdc = car.body.position.y / (out.d * tanHalf);
  return { d: out.d, size: out.size, screenFraction, yNdc, z: car.body.position.z, opacity: car.bodyMat.opacity, fade: out.fade, rgb: car.bodyMat.color.rgb };
}

const near = defaults.carDepthNear;
const far = defaults.carDepthFar;
const ratio = far / near;
const arrivalY = defaults.horizon - defaults.carDrop;

// 1) arrival: standard size just below the horizon line, fully lit
const arrival = place(1);
assert.ok(Math.abs(arrival.screenFraction - defaults.carSize) < 1e-9,
  `t=1 must be the standard size (got ${arrival.screenFraction}, want ${defaults.carSize})`);
assert.ok(Math.abs(arrival.yNdc - arrivalY) < 1e-9, `t=1 must sit carDrop below the horizon (got ${arrival.yNdc})`);
assert.ok(Math.abs(arrival.yNdc) < 0.12, 'the readable pass has to be near the middle of the screen, not at the bottom');
assert.equal(arrival.d, near);
assert.equal(arrival.z, -near);
assert.ok(Math.abs(arrival.fade - 1) < 1e-9 && Math.abs(arrival.opacity - 1) < 1e-9, 'arrival is fully lit and opaque');

// 2) the far end: a speck on the horizon, size carSize * near/depth all the way
const startOfRoad = place(0);
assert.ok(Math.abs(startOfRoad.d - far) < 0.2, `t=0 must be at the far distance (got ${startOfRoad.d})`);
assert.ok(Math.abs(startOfRoad.screenFraction - defaults.carSize / ratio) < 1e-5,
  `t=0 must be a speck (got ${startOfRoad.screenFraction})`);
assert.ok(Math.abs(startOfRoad.yNdc - defaults.horizon) < 1e-3, 't=0 must sit on the horizon');
for (const t of [0.25, 0.5, 1.5]) {
  const p = place(t);
  assert.ok(Math.abs(p.d - near * Math.pow(ratio, 1 - t)) < 1e-9, `depth at t=${t} must follow the exponential`);
  assert.ok(Math.abs(p.screenFraction - p.size) < 1e-9, 'the returned size must be the screen fraction');
  assert.ok(Math.abs(p.size - defaults.carSize * near / p.d) < 1e-9, 'size must be carSize * near/depth');
  if (t <= 1) assert.ok(Math.abs(p.yNdc - (defaults.horizon - defaults.carDrop * t)) < 1e-9, 'the drop runs until arrival');
}

// 3) past the camera: the path lifts, so the glyphs go overhead instead of sliding off the bottom
{
  const p = place(1.5);
  assert.ok(Math.abs(p.yNdc - (arrivalY + defaults.carRise * 0.25)) < 1e-9, 'after arrival the path must rise');
  const higher = place(2);
  assert.ok(higher.yNdc > p.yNdc, 'and keep rising as it comes');
  assert.ok(higher.yNdc > 0, 'the text must pass above the camera axis');
}

// 4) fade starts at carExitSize, runs for carFadeTravel, and dims brightness as well as alpha
{
  const fadeAt = run.neonFadeTravel();
  const exitAt = run.neonExitTravel();
  assert.ok(exitAt > fadeAt + 0.3, 'there has to be travel left after the fade starts, for the trail to dissolve in');
  const atFade = place(fadeAt);
  assert.ok(Math.abs(atFade.size - defaults.carExitSize) < 1e-6,
    `the fade must start at ${defaults.carExitSize} screen heights (got ${atFade.size})`);
  assert.ok(atFade.fade > 0.99 && atFade.opacity > 0.99, 'the fade has not started yet at that point');
  const atExit = place(exitAt);
  assert.ok(atExit.fade < 1e-6, 'the fade must be finished at the end of life');
  assert.ok(atExit.opacity < 1e-6, 'and the text must be transparent then');
  assert.ok(atExit.rgb.every((c) => c < 1e-6), 'brightness has to fade with the opacity, not stay white');
  assert.ok(place(exitAt - 0.3).opacity > place(exitAt).opacity, 'opacity must keep falling toward the end');
  assert.ok(place(exitAt - 0.3).fade < 1, 'and so must brightness');
  assert.ok(atExit.size > 2, 'by then the text is many screen heights tall');
}

console.log('OK neon-road: arrival ' + Math.round(arrival.screenFraction * 1000) / 10 + '% at depth ' + arrival.d
  + '; horizon ' + (Math.round(startOfRoad.screenFraction * 10000) / 100) + '%; fade starts at t=' + run.neonFadeTravel().toFixed(2)
  + ' (' + defaults.carExitSize + ' screens), life ends at t=' + run.neonExitTravel().toFixed(2)
  + ' (' + place(run.neonExitTravel()).size.toFixed(1) + ' screens)');
