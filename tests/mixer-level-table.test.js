'use strict';

// 预设 17 的 iChannel0：64 个对数频段 bin。参考在任意 hash 处采样这张表，所以每个模块都能接
// 到自己那一点频谱。这里直接跑模块里的映射/跟随/写表函数。

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

const bins = Number((src.match(/var MIXER_BINS = (\d+);/) || [])[1]);
assert.equal(bins, 64);

const run = new Function('frequencyData', 'bass', 'mid', 'treble',
  'var MIXER_BINS = 64;\n'
  + fn('mixerClamp01') + '\n' + fn('mixerSpectrumIndex') + '\n' + fn('mixerBandValues') + '\n'
  + fn('mixerFillSpectrum') + '\n' + fn('mixerWriteSpectrum')
  + '\nreturn { mixerSpectrumIndex, mixerFillSpectrum, mixerWriteSpectrum };')(
  new Uint8Array(1024).fill(0), 0, 0, 0);

// 1) the log index: non-decreasing, covers the whole FFT from low to high
{
  let last = -1;
  for (let j = 0; j < bins; j++) {
    const idx = run.mixerSpectrumIndex(j, bins);
    assert.ok(idx >= last, 'the spectrum index must not go backwards');
    last = idx;
  }
  assert.ok(run.mixerSpectrumIndex(0, bins) <= 2, 'the first bin sits at the low end');
  assert.ok(run.mixerSpectrumIndex(bins - 1, bins) >= 900, 'the last bin reaches the high end');
}

// 2) smoothing: a step in the FFT moves the level up gradually and stays in 0..1
{
  const fft = new Uint8Array(1024).fill(0);
  const targetBin = Math.round(bins * 0.85);
  fft[run.mixerSpectrumIndex(targetBin, bins)] = 255;
  const level = new Float32Array(bins);
  const run2 = new Function('frequencyData', 'bass', 'mid', 'treble',
    'var MIXER_BINS = 64;\n'
    + fn('mixerClamp01') + '\n' + fn('mixerSpectrumIndex') + '\n' + fn('mixerBandValues') + '\n'
    + fn('mixerFillSpectrum')
    + '\nreturn { mixerFillSpectrum };')(fft, 0, 0, 0);
  run2.mixerFillSpectrum(level, null, 0.6);
  const first = level[targetBin];
  assert.ok(first > 0 && first < 1, 'one frame moves part of the way, not the whole way');
  for (let i = 0; i < 20; i++) run2.mixerFillSpectrum(level, null, 0.6);
  const settled = level[targetBin];
  assert.ok(settled > first, 'repeated frames converge upward');
  assert.ok(settled <= 1, 'the level stays normalised');
  assert.equal(level[0], 0, 'bins without energy stay dark');
}

// 3) fallback: with no analyser data the bands shape the 64 bins
{
  const level = new Float32Array(bins);
  const run3 = new Function('frequencyData', 'bass', 'mid', 'treble',
    'var MIXER_BINS = 64;\n'
    + fn('mixerClamp01') + '\n' + fn('mixerSpectrumIndex') + '\n' + fn('mixerBandValues') + '\n'
    + fn('mixerFillSpectrum')
    + '\nreturn { mixerFillSpectrum };')(null, 0.9, 0.4, 0.1);
  for (let i = 0; i < 12; i++) run3.mixerFillSpectrum(level, null, 0.2);
  assert.ok(level[2] > 0.3, 'bass shows at the low bins');
  assert.ok(level[bins - 2] > 0.02, 'treble shows at the high bins');
  assert.ok(level[2] > level[bins - 2], 'and the low end is stronger for a bass-heavy input');
}

// 4) the texel layout: R=G=level, B=bin position, A=255
{
  const data = new Uint8Array(bins * 4);
  const level = new Float32Array(bins);
  level[7] = 0.8;
  level[bins - 1] = 0.5;
  run.mixerWriteSpectrum(data, level);
  assert.equal(data[7 * 4], Math.round(0.8 * 255));
  assert.equal(data[7 * 4 + 1], Math.round(0.8 * 255));
  assert.equal(data[7 * 4 + 2], Math.round((7 / (bins - 1)) * 255));
  assert.equal(data[7 * 4 + 3], 255);
  assert.equal(data[(bins - 1) * 4 + 2], 255, 'the last bin reads as the high end');
  assert.equal(data[0], 0, 'silent bins stay zero');
}

// 5) silence clears the table
{
  const data = new Uint8Array(bins * 4);
  const level = new Float32Array(bins).fill(0.9);
  for (let i = 0; i < 40; i++) run.mixerFillSpectrum(level, null, 0.5);
  level.fill(0);
  run.mixerWriteSpectrum(data, level);
  assert.ok(data.every((v, i) => i % 4 === 2 || i % 4 === 3 || v === 0), 'silence clears R/G, metadata stays');
}

console.log('OK mixer-spectrum: ' + bins + ' log bins, smoothed, band fallback, silence clears');
