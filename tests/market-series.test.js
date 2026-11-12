'use strict';

// 节奏股市的行情序列：判"音频→数值"这一层真的是确定性的、真的是箱型图。
//
// 事实侧独立于被判文件：FFT 的期望值来自朴素 DFT（另一套算法）和已知频率的正弦，
// 不是从 marketPeakHz 自己的输出反推的。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const modulePath = process.env.MARKET_SERIES_PATH || path.join(root, 'public', 'js', 'modules', '03-beat', '07-market-series.js');
const source = fs.readFileSync(modulePath, 'utf8');

const sandbox = {
  window: {}, console, Math, Date, JSON, Promise, Number, String, Object, Array, Float32Array,
  Uint8Array, Infinity, NaN, isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout
};
sandbox.window.AudioContext = undefined;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: modulePath });

const SR = 44100;

function sine(freq, seconds, amp) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (amp == null ? 0.6 : amp) * Math.sin(2 * Math.PI * freq * i / SR);
  return out;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const opts = { chunk: 4096, slices: 4, minHz: 40, maxHz: 8000 };

// ---------------------------------------------------------------- FFT 对朴素 DFT
{
  const n = 64;
  const pcm = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pcm[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  const mag = sandbox.marketSpectrum(pcm, 0, n);
  const w = sandbox.marketHann(n);
  let worst = 0;
  for (let k = 0; k < n / 2; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < n; t++) {
      const a = -2 * Math.PI * k * t / n;
      re += pcm[t] * w[t] * Math.cos(a);
      im += pcm[t] * w[t] * Math.sin(a);
    }
    const want = Math.sqrt(re * re + im * im);
    worst = Math.max(worst, Math.abs(want - mag[k]) / Math.max(1e-6, want));
  }
  assert.ok(worst < 1e-4, 'the radix-2 transform must agree with a plain DFT, worst relative error ' + worst);
  console.log('fft vs naive DFT: worst relative error ' + worst.toExponential(2));
}

// ---------------------------------------------------------------- 已知频率出准确读数
{
  const readings = [];
  for (const hz of [82.4, 230, 440, 1000, 3200]) {
    const pcm = sine(hz, 4096 / SR * 4);
    const series = sandbox.marketBuildSeries(pcm, SR, opts);
    assert.equal(series.count, 4, 'four full chunks must give four candles');
    const got = series.dom[0];
    readings.push(hz + '->' + got.toFixed(1));
    assert.ok(Math.abs(got - hz) / hz < 0.01, hz + ' Hz must be measured within 1%, got ' + got);
  }
  console.log('dominant frequency: ' + readings.join(', '));
}

// ---------------------------------------------------------------- 箱型图的四条边
{
  // 一块里前半 200 Hz、后半 900 Hz：开盘必须读到前半，收盘读到后半，上下影线包住两者。
  const half = 2048;
  const pcm = concat([sine(200, half / SR), sine(900, half / SR)]);
  const series = sandbox.marketBuildSeries(pcm, SR, opts);
  assert.equal(series.count, 1);
  const o = series.open[0], c = series.close[0], h = series.high[0], l = series.low[0];
  assert.ok(Math.abs(o - 200) / 200 < 0.03, 'the open must read the first sub-window, got ' + o);
  assert.ok(Math.abs(c - 900) / 900 < 0.03, 'the close must read the last sub-window, got ' + c);
  assert.ok(l <= Math.min(o, c) + 1e-6 && h >= Math.max(o, c) - 1e-6, 'the wicks must bracket the body: ' + [o, h, l, c]);
  console.log('one candle across a pitch change: open ' + o.toFixed(1) + ' close ' + c.toFixed(1) + ' low ' + l.toFixed(1) + ' high ' + h.toFixed(1));

  const mixed = concat([sine(110, 0.4), sine(1400, 0.4), sine(300, 0.4), sine(2600, 0.4)]);
  const many = sandbox.marketBuildSeries(mixed, SR, opts);
  for (let i = 0; i < many.count; i++) {
    assert.ok(many.low[i] <= Math.min(many.open[i], many.close[i]) + 1e-6, 'candle ' + i + ': low above the body');
    assert.ok(many.high[i] >= Math.max(many.open[i], many.close[i]) - 1e-6, 'candle ' + i + ': high below the body');
    assert.ok(many.energy[i] > 0, 'candle ' + i + ': a sounding chunk must carry energy');
  }
  console.log('bracketing holds on ' + many.count + ' candles of a four-tone sweep');
}

// ---------------------------------------------------------------- 用户举的那个例子
{
  // 低频段占优 → 数值低（跌）；人声段 → 1k+（涨）。
  const pcm = concat([sine(230, 0.5), sine(1200, 0.5)]);
  const series = sandbox.marketBuildSeries(pcm, SR, opts);
  const bassEnd = Math.floor(0.5 * SR / opts.chunk);
  let bassMax = 0, vocalMin = Infinity;
  for (let i = 0; i < bassEnd; i++) bassMax = Math.max(bassMax, series.dom[i]);
  for (let i = bassEnd + 1; i < series.count; i++) vocalMin = Math.min(vocalMin, series.dom[i]);
  assert.ok(bassMax < 300, 'the bass passage must stay under 300 Hz, got ' + bassMax);
  assert.ok(vocalMin > 1000, 'the vocal passage must read above 1 kHz, got ' + vocalMin);
  console.log('bass passage peaks at ' + bassMax.toFixed(0) + ' Hz, vocal passage floors at ' + vocalMin.toFixed(0) + ' Hz');
}

// ---------------------------------------------------------------- 确定性
{
  const pcm = concat([sine(180, 0.3), sine(760, 0.3), sine(2400, 0.3), sine(90, 0.3)]);
  const a = sandbox.marketBuildSeries(pcm, SR, opts);
  const b = sandbox.marketBuildSeries(pcm, SR, opts);
  for (const field of ['t', 'open', 'high', 'low', 'close', 'dom', 'energy']) {
    assert.deepEqual(Array.from(a[field]), Array.from(b[field]), field + ' must be identical across two runs');
  }
  assert.equal(a.signature, b.signature);
  const changed = sandbox.marketBuildSeries(pcm, SR, Object.assign({}, opts, { chunk: 2048 }));
  assert.notEqual(changed.signature, a.signature, 'a different chunk length is a different series');
  assert.equal(changed.count, Math.floor(pcm.length / 2048));
  console.log('determinism: ' + a.count + ' candles identical across runs, signature ' + a.signature);
}

// ---------------------------------------------------------------- seek 落点
{
  const pcm = sine(300, 2);
  const series = sandbox.marketBuildSeries(pcm, SR, opts);
  const perSec = SR / opts.chunk;
  for (const t of [0, 0.001, 0.09, 0.5, 1.234, 1.999]) {
    assert.equal(sandbox.marketIndexAt(series, t), Math.min(series.count, Math.floor(t * perSec)), 'index at ' + t + 's');
  }
  assert.equal(sandbox.marketIndexAt(series, -5), 0, 'before the start clamps to the first candle');
  assert.equal(sandbox.marketIndexAt(series, 999), series.count, 'past the end clamps to the count');
  assert.equal(sandbox.marketIndexAt(null, 3), 0);
  console.log('seek landing: index(t) = floor(t*' + perSec.toFixed(3) + ') clamped to [0,' + series.count + ']');
}

// ---------------------------------------------------------------- 分块异步 == 一次算完
{
  const pcm = concat([sine(150, 0.6), sine(880, 0.6), sine(2100, 0.6), sine(420, 0.6)]);
  const whole = sandbox.marketBuildSeries(pcm, SR, opts);
  return sandbox.marketBuildSeriesAsync(pcm, SR, opts, sandbox.marketSeriesToken).then(function (joined) {
    assert.ok(joined, 'the async path must produce a series');
    assert.equal(joined.count, whole.count, 'the joined series must have every candle');
    for (const field of ['t', 'open', 'high', 'low', 'close', 'dom', 'energy']) {
      const x = Array.from(joined[field]), y = Array.from(whole[field]);
      assert.deepEqual(x, y, field + ' must survive the chunked join (timestamps are shifted onto the song clock)');
    }
    assert.ok(Math.abs(joined.duration - whole.duration) < 1e-6, 'duration must survive the join');
    console.log('chunked async join: ' + joined.count + ' candles identical to the one-shot build');

    // 被取代的分析必须交回 null，而不是把旧歌的行情写进当前歌。
    const stale = sandbox.marketBuildSeriesAsync(pcm, SR, opts, sandbox.marketSeriesToken + 99);
    return stale;
  }).then(function (stale) {
    assert.equal(stale, null, 'a superseded token must resolve to null');
    console.log('cancellation: a stale token resolves to null');
    console.log('OK market-series');
  });
}