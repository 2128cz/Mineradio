'use strict';

// 预设 17 的电平表：8 频段 × 8 个历史步，texel = age * 8 + band。
// R 是电平、G 是峰值保持、B 是频段、A 是年龄；这里直接跑模块里的写表函数。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '22-mixer-desk-preset.js'), 'utf8');

function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const end = src.indexOf('\n}\n', start) + 3;
  return src.slice(start, end);
}

const bands = Number((src.match(/var MIXER_LEVEL_BANDS = (\d+);/) || [])[1]);
const ages = Number((src.match(/var MIXER_LEVEL_AGES = (\d+);/) || [])[1]);
assert.equal(bands, 8);
assert.equal(ages, 8);

const run = new Function('bass', 'mid', 'treble',
  'var MIXER_LEVEL_BANDS = 8; var MIXER_LEVEL_AGES = 8;\n'
  + fn('mixerClamp01') + '\n' + fn('mixerBandValues') + '\n' + fn('mixerWriteLevelTable')
  + '\nreturn { mixerBandValues, mixerWriteLevelTable };')(0.5, 0.25, 0.1);

const data = new Uint8Array(bands * ages * 4);
const level = new Float32Array(bands);
const peak = new Float32Array(bands);

// 1) impulse on band 3, newest row
level[3] = 0.8;
peak[3] = 0.8;
run.mixerWriteLevelTable(data, level, peak, false);
const texel = (age, band) => (age * bands + band) * 4;
assert.equal(data[texel(0, 3)], Math.round(0.8 * 255), 'age 0 is the newest level');
assert.equal(data[texel(0, 3) + 1], Math.round(0.8 * 255), 'peak hold is at least the level');
assert.equal(data[texel(0, 3) + 2], Math.round((3 / (bands - 1)) * 255), 'B carries the band');
assert.equal(data[texel(0, 3) + 3], 0, 'A of the newest row is age 0');
assert.equal(data[texel(4, 3) + 3], Math.round((4 / (ages - 1)) * 255), 'A carries the age');
for (let band = 0; band < bands; band++) {
  if (band === 3) continue;
  assert.equal(data[texel(0, band)], 0, 'only the excited band lights up');
}

// 2) shift: the old row moves back one age, and the peak holds above the decayed level
level[3] = 0.3;
peak[3] = Math.max(peak[3] * 0.94, 0.3);
run.mixerWriteLevelTable(data, level, peak, true);
assert.equal(data[texel(1, 3)], Math.round(0.8 * 255), 'the previous row lands on age 1');
assert.equal(data[texel(0, 3)], Math.round(0.3 * 255), 'the new row carries the decayed level');
assert.ok(data[texel(0, 3) + 1] > data[texel(0, 3)], 'the peak cap stays above the falling level');

// 3) silence: level and peak both reach zero; band/age metadata survives
level.fill(0);
peak.fill(0);
for (let i = 0; i < ages; i++) run.mixerWriteLevelTable(data, level, peak, true);
for (let age = 0; age < ages; age++) {
  for (let band = 0; band < bands; band++) {
    assert.equal(data[texel(age, band)], 0, 'silence clears the level');
    assert.equal(data[texel(age, band) + 1], 0, 'silence clears the peak cap');
    assert.equal(data[texel(age, band) + 2], Math.round((band / (bands - 1)) * 255), 'band metadata stays');
  }
}

// 4) bands come from the monitor frame when it is there, and fall back to the globals otherwise
{
  const fromFrame = run.mixerBandValues({
    sonicDetailed: true, subBass: 0.1, bass: 0.2, lowMid: 0.3, mid: 0.4,
    highMid: 0.5, presence: 0.6, brilliance: 0.7, air: 0.8
  });
  assert.deepEqual(Array.from(fromFrame).map((v) => Math.round(v * 10) / 10), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  const fromGlobals = run.mixerBandValues(null);
  assert.ok(Math.abs(fromGlobals[1] - 0.5) < 1e-6, 'bass feeds the low band');
  assert.ok(Math.abs(fromGlobals[3] - 0.25) < 1e-6, 'mid feeds the centre band');
  assert.ok(Math.abs(fromGlobals[6] - 0.1) < 1e-6, 'treble feeds the high band');
}

console.log('OK mixer-levels: ' + bands + ' bands x ' + ages + ' ages, peak hold, silence clears, one row per tick');
