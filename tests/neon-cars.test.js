'use strict';

// 预设 16 的车队：喂一份真实的歌词时间轴与播放时间，看 neonStepCars 是否真的建出两辆车、
// 把当前句放在路上、并给出同一文本的拖影副本。离线跑（THREE 与 canvas 都是桩），
// 所以"有车、在路上、有拖影"是读出来的，不是看着源码猜的。

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
const document = {
  createElement: () => ({ width: 8, height: 8, getContext: () => ctx })
};

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
      // The real material wraps a hex literal in THREE.Color; the stub only needs to accept setRGB.
      if (typeof this.color === 'number') this.color = { setRGB() {} };
    }
    dispose() {}
  },
  CanvasTexture: class { constructor(c) { this.image = c; this.needsUpdate = false; } dispose() {} },
  Color: class { setRGB() {} },
  sRGBEncoding: 3001
};

const lyricsLines = [
  { time: 10, text: '第一句歌词' },
  { time: 12, text: '第二句歌词' }
];
const audio = { currentTime: 11 };
const neonState = { cars: [], group: new Group() };
const neonLyricPalette = () => ({ main: '#ffe6fa', glow: '#ff4fd8' });

const run = new Function(
  'THREE', 'document', 'lyricsLines', 'audio', 'neonState', 'neonParam', 'neonLyricPalette', 'NEON_TRAIL_MAX',
  [fn('neonLineText'), fn('neonActiveLines'), fn('neonMakeCar'), fn('neonRasterCar'), fn('neonPlaceCar'),
    fn('neonStepCars'), fn('neonClamp01')].join('\n')
  + '\nreturn { neonActiveLines: neonActiveLines, neonStepCars: neonStepCars, neonPlaceCar: neonPlaceCar };'
)(THREE, document, lyricsLines, audio, neonState, neonParam, neonLyricPalette, 12);

const active = run.neonActiveLines();
assert.equal(active.length, 2, 'the current line and the next one are the preset window');
assert.equal(active[0].text, '第一句歌词');
assert.equal(active[0].current, true);
assert.equal(active[1].current, false);

run.neonStepCars(audio.currentTime, 0.016);
assert.equal(neonState.cars.length, 2, 'two active lines must build two cars');
const car = neonState.cars[0];
assert.ok(car.body.visible, 'the current car must be visible');
assert.ok(car.body.material.map === car.texture, 'the car must draw its rasterised text');

// t = (11 - 10) / 2 = 0.5 -> depth 12, screen fraction 5% of the height
const tanHalf = Math.tan((defaults.camFov * Math.PI) / 360);
const d = -car.body.position.z;
const frac = car.body.scale.y / (2 * d * tanHalf);
assert.ok(Math.abs(d - 12) < 1e-9, `the current car must be at depth 12 (got ${d})`);
assert.ok(Math.abs(frac - defaults.carSize * 0.5) < 1e-9, `the current car must be at half size (got ${frac})`);
assert.ok(car.band.visible !== false && car.band.scale.x > car.body.scale.x, 'the light band must be wider than the text');

// The trail: copies of the same text at earlier t, each smaller and fainter than the one before.
const visibleTrails = car.trails.filter((slot) => slot.mesh.visible);
assert.equal(visibleTrails.length, Math.round(defaults.trailCount), 'the trail count knob must decide how many copies ride along');
const depths = visibleTrails.map((slot) => -slot.mesh.position.z);
const fracs = visibleTrails.map((slot) => slot.mesh.scale.y / (2 * (-slot.mesh.position.z) * tanHalf));
for (let i = 1; i < depths.length; i++) {
  assert.ok(depths[i] > depths[i - 1], 'every afterimage copy must be further down the road than the one in front');
  // The world height is the same for every copy (the standard car is a fixed size on the road);
  // what shrinks is its share of the screen, because it is seen from further away.
  assert.ok(fracs[i] < fracs[i - 1], 'and occupy a smaller share of the screen than the one in front');
  assert.ok(visibleTrails[i].mat.opacity < visibleTrails[i - 1].mat.opacity, 'and be fainter than the one in front');
}
assert.ok(visibleTrails.every((slot) => slot.mesh.material.map === car.texture),
  'every copy has to share the one rasterised texture, or a lyric line uploads a dozen times');

// The next line is still behind the horizon: clamped to a speck at the start of the road.
const next = neonState.cars[1];
assert.ok(next.body.scale.y < car.body.scale.y, 'the line that has not started yet must be smaller than the current one');
assert.ok(-next.body.position.z >= -car.body.position.z, 'and further away');

console.log('OK neon-cars: 2 lines -> ' + neonState.cars.length + ' cars, current at depth ' + d
  + ' (' + Math.round(frac * 1000) / 10 + '% of height), ' + visibleTrails.length + ' afterimage copies');
