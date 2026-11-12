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

// ---------------------------------------------------------------- 箱型图：连续、包住路径、越走越远
{
  // 价格是累计出来的，所以"收盘读到后半块的峰频"不再是判据；判据是：
  // 开 = 上一根收盘（没有跳空）、影线包住整根路径、持续在高频的段落会一路上行。
  // A fixed midline makes "above it climbs, below it falls" a direct claim. With the auto midline
  // a uniform song has no drift at all (its own mean is the midline), which is also correct.
  const upOnly = sandbox.marketBuildSeries(sine(1600, 1), SR, Object.assign({}, opts, { priceCentre: 400 }));
  assert.ok(upOnly.count > 1);
  for (let i = 1; i < upOnly.count; i++) {
    assert.equal(upOnly.open[i], upOnly.close[i - 1], 'candle ' + i + ' must open where the last one closed');
  }
  assert.ok(upOnly.close[upOnly.count - 1] > upOnly.close[0],
    'a passage entirely above the midline must climb: ' + upOnly.close[0].toFixed(3) + ' -> ' + upOnly.close[upOnly.count - 1].toFixed(3));
  const downOnly = sandbox.marketBuildSeries(sine(120, 1), SR, Object.assign({}, opts, { priceCentre: 400 }));
  assert.ok(downOnly.close[downOnly.count - 1] < downOnly.close[0],
    'a passage entirely below the midline must fall: ' + downOnly.close[0].toFixed(3) + ' -> ' + downOnly.close[downOnly.count - 1].toFixed(3));

  const mixed = concat([sine(110, 0.4), sine(1400, 0.4), sine(300, 0.4), sine(2600, 0.4)]);
  const many = sandbox.marketBuildSeries(mixed, SR, opts);
  for (let i = 0; i < many.count; i++) {
    assert.ok(many.low[i] <= Math.min(many.open[i], many.close[i]) + 1e-6, 'candle ' + i + ': low above the body');
    assert.ok(many.high[i] >= Math.max(many.open[i], many.close[i]) - 1e-6, 'candle ' + i + ': high below the body');
    assert.ok(many.energy[i] > 0, 'candle ' + i + ': a sounding chunk must carry energy');
    if (i) assert.equal(many.open[i], many.close[i - 1], 'candle ' + i + ' must open where the last one closed');
  }
  console.log('box: ' + many.count + ' continuous candles; 1600 Hz climbs to ' + upOnly.close[upOnly.count - 1].toFixed(2)
    + ', 120 Hz falls to ' + downOnly.close[downOnly.count - 1].toFixed(2));
}

// ---------------------------------------------------------------- 用户举的那个例子，按累计语义
{
  // 低频段 → 低于中线 → 一路跌；人声段 → 高于中线 → 一路涨。中线是这首歌自己的峰频几何平均，
  // 所以两段各自朝相反方向走，而不是各自停在一个绝对数值上。
  const pcm = concat([sine(230, 1.0), sine(1200, 1.0)]);
  const series = sandbox.marketBuildSeries(pcm, SR, opts);
  const half = Math.floor(series.count / 2);
  assert.ok(Math.abs(series.centreHz - Math.sqrt(230 * 1200)) / series.centreHz < 0.03,
    'the auto midline must sit between the two passages (got ' + series.centreHz.toFixed(0) + ' Hz)');
  assert.ok(series.close[half - 1] < series.close[0], 'the bass passage must fall');
  assert.ok(series.close[series.count - 1] > series.close[half], 'the vocal passage must rise');
  const low = Math.min.apply(null, Array.from(series.close));
  const high = Math.max.apply(null, Array.from(series.close));
  assert.ok(high - low > 1, 'the chart must actually move: range ' + (high - low).toFixed(2) + ' octaves');
  console.log('bass then vocal: midline ' + series.centreHz.toFixed(0) + ' Hz, closes ' +
    series.close[0].toFixed(2) + ' -> ' + series.close[half - 1].toFixed(2) + ' -> ' + series.close[series.count - 1].toFixed(2));
}

// ---------------------------------------------------------------- 回中线：0 是纯迭代，越大越贴中线
{
  const song = concat([sine(120, 2), sine(2400, 2), sine(150, 2), sine(3000, 2)]);
  const spread = (revert) => {
    const s = sandbox.marketBuildSeries(song, SR, Object.assign({}, opts, { priceRevert: revert }));
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < s.count; i++) { lo = Math.min(lo, s.close[i]); hi = Math.max(hi, s.close[i]); }
    return hi - lo;
  };
  const pure = spread(0);
  const leaky = spread(0.3);
  assert.ok(pure > leaky * 1.5, 'a leak back to the midline must hold the walk in: pure ' + pure.toFixed(2) + ' vs ' + leaky.toFixed(2));
  console.log('revert 0 vs 0.3: walk range ' + pure.toFixed(2) + ' vs ' + leaky.toFixed(2) + ' octaves');
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

// ---------------------------------------------------------------- 对数轴：评价不从算术上偏袒高频
{
  // 白噪声里每个 bin 都是同分布的。线性逐 bin 扫描时，最高一个八度握着全部 bin 的一半，
  // 于是它会拿走大约一半的块；对数轴上每个八度的候选数相同，最高八度只该分到 1/8 上下。
  // 这条判据直接量"偏袒"本身，而不是别处反推的阈值。
  const n = 4096 * 400;
  const pcm = new Float32Array(n);
  let seed = 987654321;
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pcm[i] = (seed / 0x7fffffff) * 2 - 1; }
  const series = sandbox.marketBuildSeries(pcm, SR, Object.assign({}, opts, { earWeight: 0, peakGate: 0 }));
  let high = 0, low = 0;
  for (let i = 0; i < series.count; i++) {
    if (series.dom[i] > 4000) high++;
    if (series.dom[i] < 80) low++;
  }
  const highFrac = high / series.count, lowFrac = low / series.count;
  assert.ok(highFrac < 0.30, 'the top octave holds half the linear bins and must not win half the noise blocks: ' + (highFrac * 100).toFixed(1) + '%');
  assert.ok(lowFrac < 0.30, 'a log axis must not hand the bottom octave the noise either: ' + (lowFrac * 100).toFixed(1) + '%');
  console.log('white noise peaks: above 4 kHz in ' + (highFrac * 100).toFixed(1) + '% of blocks, below 80 Hz in ' + (lowFrac * 100).toFixed(1) + '%');
}

// ---------------------------------------------------------------- 等响曲线：它就是"阈值"
{
  // A 加权在 1 kHz 归一到 1，往低频急剧下降——这就是"人耳不是平的"在数字上的样子。
  assert.ok(Math.abs(sandbox.marketAWeight(1000) - 1) < 0.02, 'A-weighting must be 1 at 1 kHz, got ' + sandbox.marketAWeight(1000));
  assert.ok(sandbox.marketAWeight(100) < 0.2, '100 Hz must be attenuated hard, got ' + sandbox.marketAWeight(100));
  assert.ok(sandbox.marketAWeight(40) < 0.05, '40 Hz must be close to erased, got ' + sandbox.marketAWeight(40));
  let prev = 0;
  for (const hz of [40, 60, 100, 200, 400, 700, 1000]) {
    const w = sandbox.marketAWeight(hz);
    assert.ok(w > prev, 'the curve must rise from 40 Hz to 1 kHz, ' + hz + ' Hz gave ' + w);
    prev = w;
  }
  console.log('A-weighting 40/100/1k/4k = ' + [40, 100, 1000, 4000].map((f) => sandbox.marketAWeight(f).toFixed(3)).join(' / '));

  // 70 Hz 强、1.2 kHz 弱：平直评价由低频拿走；把曲线开满，人耳听到的那个赢。
  // 0.15 这个幅度是量出来的分界（0.06 时连满档加权也翻不过去：宽的频带把窄的纯音摊薄了）。
  const mix = new Float32Array(4096);
  for (let i = 0; i < 4096; i++) {
    mix[i] = 0.5 * Math.sin(2 * Math.PI * 70 * i / SR) + 0.15 * Math.sin(2 * Math.PI * 1200 * i / SR);
  }
  const flat = sandbox.marketBuildSeries(mix, SR, Object.assign({}, opts, { earWeight: 0, peakGate: 0 }));
  const ear = sandbox.marketBuildSeries(mix, SR, Object.assign({}, opts, { earWeight: 1, peakGate: 0 }));
  assert.ok(flat.dom[0] < 120, 'a flat evaluation must read the strong bass, got ' + flat.dom[0]);
  assert.ok(ear.dom[0] > 800, 'the equal-loudness curve must hand the peak to the mid tone, got ' + ear.dom[0]);
  console.log('same block: flat reads ' + flat.dom[0].toFixed(1) + ' Hz, equal-loudness reads ' + ear.dom[0].toFixed(1) + ' Hz');
}

// ---------------------------------------------------------------- 突出度门槛：噪声不许冒充价格
{
  const noise = new Float32Array(4096);
  let seed = 424242;
  for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = (seed / 0x7fffffff) * 2 - 1; }
  const mag = Float32Array.from(sandbox.marketSpectrum(noise, 0, 4096));
  const at = (gate) => sandbox.marketPeakHz(mag, 4096, SR, opts.minHz, opts.maxHz, { earWeight: 0.75, peakGate: gate, prevHz: 880 });
  const held = at(0.25);
  const open = at(0);
  assert.equal(held.held, true, 'a noise block must not become the price while the gate is up');
  assert.ok(Math.abs(held.hz - 880) < 1e-6, 'a held block keeps the previous price, got ' + held.hz);
  assert.equal(open.held, false, 'the gate off must report the measured band');
  assert.notEqual(open.hz, 880, 'with the gate off the block is free to pick another price');
  console.log('prominence gate: noise held at ' + held.hz + ' Hz; ungated it reads ' + open.hz.toFixed(1) + ' Hz');
}

// ---------------------------------------------------------------- 轴边界：读数不出 [minHz, maxHz]
{
  const series = sandbox.marketBuildSeries(sine(7900, 4096 / SR), SR, Object.assign({}, opts, { peakGate: 0 }));
  assert.ok(series.dom[0] <= opts.maxHz + 1e-6, 'the top band must not report past maxHz, got ' + series.dom[0]);
  assert.ok(series.dom[0] >= opts.minHz - 1e-6, 'no reading may fall below minHz');
  const silent = new Float32Array(4096);
  const mag = Float32Array.from(sandbox.marketSpectrum(silent, 0, 4096));
  const first = sandbox.marketPeakHz(mag, 4096, SR, opts.minHz, opts.maxHz, { prevHz: 0 });
  assert.equal(first.hz, 0, 'a song that has not started yet has no price');
  const after = sandbox.marketPeakHz(mag, 4096, SR, opts.minHz, opts.maxHz, { prevHz: 440 });
  assert.equal(after.hz, 440, 'digital silence mid-song holds the last price instead of diving to the floor');
  assert.equal(after.held, true);
  console.log('axis bounds: top of range clamps to ' + series.dom[0].toFixed(0) + ' Hz; silence holds at 440 Hz');
}

// ---------------------------------------------------------------- 分块异步 == 一次算完
{
  // Longer than the 48-candle slice the async path measures in, so the join is actually exercised:
  // with one part the equality would hold no matter how the parts were stitched.
  const pcm = concat([sine(150, 1.5), sine(880, 1.5), sine(2100, 1.5), sine(420, 1.5),
    sine(120, 1.5), sine(1800, 1.5), sine(640, 1.5), sine(2600, 1.5)]);
  const whole = sandbox.marketBuildSeries(pcm, SR, opts);
  assert.ok(whole.count > 48 * 2, 'the fixture must span more than two async slices (got ' + whole.count + ' candles)');
  return sandbox.marketBuildSeriesAsync(pcm, SR, opts, sandbox.marketSeriesToken).then(function (joined) {
    assert.ok(joined, 'the async path must produce a series');
    assert.equal(joined.count, whole.count, 'the joined series must have every candle');
    for (const field of ['open', 'high', 'low', 'close', 'dom', 'energy']) {
      const x = Array.from(joined[field]), y = Array.from(whole[field]);
      assert.deepEqual(x, y, field + ' must survive the chunked join');
    }
    // Timestamps are shifted onto the song clock by adding each slice's offset, and they live in a
    // Float32Array: at 8.7 s one float32 step is ~5e-7, so they agree to a microsecond rather than
    // bit for bit. 1 µs against a 93 ms candle is not a difference anyone can see.
    for (let i = 0; i < whole.count; i++) {
      assert.ok(Math.abs(joined.t[i] - whole.t[i]) < 1e-6, 'timestamp ' + i + ' must survive the join ('
        + joined.t[i] + ' vs ' + whole.t[i] + ')');
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