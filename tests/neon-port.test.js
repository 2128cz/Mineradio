'use strict';

// 预设 16 的移植判据：它是参考 shader 的移植，不是"照着画面重画"。
// 这条臂盯三件事：参考的特征表达式还在、默认值等于参考常量、组合顺序的关键步骤没被换掉。
// 像素级对齐由 scripts/neon-fidelity-bench.js 负责（需要 GPU，不进静态门）。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '21-neon-fuji-preset.js'), 'utf8');
const fixture = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'neon-fuji-reference.glsl'), 'utf8');

assert.ok(fixture.includes('float sdTrapezoid'), 'the reference fixture must keep its SDF helpers');

// 1) the reference's distinctive expressions survive the port
for (const expr of [
  'smoothstep(uSunRadius, uSunRadius - 0.01, length(uv))',
  'iTime * 0.2 * (battery + 0.02)) * uSunStripes',
  'clamp(uv.y * 14.0 + 1.0, -6.0, 6.0)',
  'vec2(uv.y, uv.y * uv.y * 0.2) * uGridScale',
  'iTime * uGridSpeed * (battery + 0.05)',
  'lines += smoothstep(size * uGridDensity, vec2(0.0), uv) * uGridBloom * battery',
  'uRoadDepth / (abs(uv.y - uHorizon) + 0.05)',
  'uv.x *= uv.y * uRoadSpread',
  'pow(uv.y * uv.y, 2.1)',
  'sin(uv.x * uSnowFreq + iTime * uSnowSpeed) * uSnowAmp + uSnowLevel',
  'opSmoothUnion(lineVal1, boxVal, 0.05)',
  'fog * fog * fog * uFogGain',
  'mix(vec3(col.r, col.r, col.r) * 0.5, col, battery * 0.7)'
]) {
  assert.ok(src.includes(expr), 'the port lost a reference expression: ' + expr);
}

// 2) defaults must equal the reference literals, or the fidelity bench can never be zero
const schema = {};
for (const m of src.matchAll(/([A-Za-z_]\w*):\s*\{\s*def:\s*(-?[\d.]+)/g)) schema[m[1]] = Number(m[2]);
for (const [key, want] of Object.entries({
  battery: 1.0, horizon: -0.2, roadDepth: 3.0, roadSpread: 1.0, gridScale: 0.01, gridSpeed: 4.0,
  gridDensity: 5.0, gridBloom: 0.4, sunX: 0.75, sunY: 0.2, sunRadius: 0.3, sunStripes: 100,
  sunBloom: 0.7, fujiX: -0.75, fujiY: 0.5, fujiWidth: 1.75, fujiBase: 0.2, fujiHeight: 0.5,
  snowFreq: 20, snowSpeed: 2, snowAmp: 0.05, snowLevel: 0.2, cloudSpeed: 0.1, cloudWidth: 0.075
})) {
  assert.equal(schema[key], want, 'the default for ' + key + ' must be the reference literal ' + want);
}

// 3) the composition order: grid branch first, then the sun under the mountain, clouds last
const mainStart = src.indexOf('void mainImage(out vec4 fragColor');
const main = src.slice(mainStart, src.indexOf("'}", mainStart));
const order = ['uRoadDepth / (abs', 'col = uSunColor', 'sdTrapezoid', 'wave_width', 'uHorizonNear', 'uCloudOn', 'fog * fog * fog'];
let at = -1;
for (const step of order) {
  const next = main.indexOf(step);
  assert.ok(next > at, 'the composition order changed at: ' + step);
  at = next;
}
console.log('OK neon-port: 13 reference expressions, 24 defaults, 7 ordered steps');
