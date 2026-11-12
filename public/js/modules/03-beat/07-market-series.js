'use strict';

// 节奏股市的行情序列 / the market series behind preset 16.
//
// The chart is a pure function of the song's own samples: chunk i covers
// [i*chunk/sr, (i+1)*chunk/sr), so the candle a playhead lands on is floor(t*sr/chunk) and
// nothing about it depends on when the analysis ran or on what the realtime analyser happened
// to see. That is what lets a seek to the far end of a song put every candle exactly where it
// belongs, the way the lyric presets put their rows.
//
// The app's realtime analyser cannot do this (it only ever holds the current frame), and the
// beat analysis that does decode the whole song throws its AudioBuffer away - so this module
// decodes once more and keeps the PCM of the current song only.

var MARKET_SERIES_CACHE = {};
var MARKET_SERIES_CACHE_LIMIT = 4;
var MARKET_PCM_CACHE = { key: '', pcm: null, sampleRate: 0 };
var marketSeriesToken = 0;
var marketSeriesState = {
  key: '', phase: 'idle', progress: 0, count: 0, error: '',
  costMs: 0, sampleRate: 0, chunk: 0, slices: 0, cached: false
};

// ---------------------------------------------------------------- the transform
//
// Iterative radix-2, in place. The sizes this preset asks for are powers of two by
// construction (chunkSamples is a power-of-two knob and the sub-windows divide it evenly).
function marketFft(re, im) {
  var n = re.length;
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      var tr = re[i]; re[i] = re[j]; re[j] = tr;
      var ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (var len = 2; len <= n; len <<= 1) {
    var ang = -2 * Math.PI / len;
    var wr = Math.cos(ang), wi = Math.sin(ang);
    for (var k = 0; k < n; k += len) {
      var cr = 1, ci = 0;
      for (var m = 0; m < len / 2; m++) {
        var ur = re[k + m], ui = im[k + m];
        var vr = re[k + m + len / 2] * cr - im[k + m + len / 2] * ci;
        var vi = re[k + m + len / 2] * ci + im[k + m + len / 2] * cr;
        re[k + m] = ur + vr; im[k + m] = ui + vi;
        re[k + m + len / 2] = ur - vr; im[k + m + len / 2] = ui - vi;
        var nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

var marketWindowCache = {};
function marketHann(n) {
  var w = marketWindowCache[n];
  if (w) return w;
  w = new Float32Array(n);
  for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  marketWindowCache[n] = w;
  return w;
}

var marketScratch = { n: 0, re: null, im: null, mag: null };
function marketScratchFor(n) {
  if (marketScratch.n !== n) {
    marketScratch = { n: n, re: new Float32Array(n), im: new Float32Array(n), mag: new Float32Array(n / 2) };
  }
  return marketScratch;
}

// One window's magnitude spectrum, in place on the scratch buffers.
function marketSpectrum(pcm, start, n) {
  var s = marketScratchFor(n);
  var w = marketHann(n);
  var end = Math.min(pcm.length, start + n);
  for (var i = 0; i < n; i++) {
    var v = start + i < end ? pcm[start + i] : 0;
    s.re[i] = v * w[i];
    s.im[i] = 0;
  }
  marketFft(s.re, s.im);
  for (var k = 0; k < n / 2; k++) s.mag[k] = Math.sqrt(s.re[k] * s.re[k] + s.im[k] * s.im[k]);
  return s.mag;
}

// The strongest bin inside [minHz,maxHz], refined between bins. A chunk's pitch is rarely on a
// bin centre, and rounding to the bin would quantise the whole chart into 43 Hz steps.
function marketPeakHz(mag, n, sampleRate, minHz, maxHz) {
  var binHz = sampleRate / n;
  var a = Math.max(1, Math.floor(minHz / binHz));
  var b = Math.min(mag.length - 2, Math.ceil(maxHz / binHz));
  if (b < a) return { hz: 0, mag: 0 };
  var best = a, bestVal = -1;
  for (var k = a; k <= b; k++) {
    if (mag[k] > bestVal) { bestVal = mag[k]; best = k; }
  }
  if (bestVal <= 0) return { hz: 0, mag: 0 };
  var l = Math.log(mag[best - 1] + 1e-12);
  var c = Math.log(bestVal + 1e-12);
  var r = Math.log(mag[best + 1] + 1e-12);
  var den = l - 2 * c + r;
  var delta = den !== 0 ? 0.5 * (l - r) / den : 0;
  if (!isFinite(delta) || delta < -1 || delta > 1) delta = 0;
  return { hz: (best + delta) * binHz, mag: bestVal };
}

function marketSeriesSignature(opts) {
  return [opts.chunk, opts.slices, opts.minHz, opts.maxHz].join('|');
}

// ---------------------------------------------------------------- the series
//
// Pure: same samples and same options give the same numbers, every time. No clock, no RNG, no
// dependency on the app's state - which is what makes the chart reproducible across a seek.
function marketBuildSeries(pcm, sampleRate, opts) {
  var chunk = Math.max(64, Math.round(opts.chunk));
  var slices = Math.max(1, Math.round(opts.slices));
  var minHz = Math.max(1, Number(opts.minHz) || 1);
  var maxHz = Math.min(sampleRate / 2, Number(opts.maxHz) || sampleRate / 2);
  var sub = Math.max(32, Math.floor(chunk / slices));
  var count = Math.floor(pcm.length / chunk);
  var out = {
    sampleRate: sampleRate, chunk: chunk, slices: slices, minHz: minHz, maxHz: maxHz,
    count: count, duration: pcm.length / sampleRate, candlesPerSec: sampleRate / chunk,
    signature: marketSeriesSignature({ chunk: chunk, slices: slices, minHz: minHz, maxHz: maxHz }),
    t: new Float32Array(count), open: new Float32Array(count), high: new Float32Array(count),
    low: new Float32Array(count), close: new Float32Array(count), dom: new Float32Array(count),
    energy: new Float32Array(count)
  };
  for (var i = 0; i < count; i++) {
    var start = i * chunk;
    out.t[i] = start / sampleRate;
    var sum = 0;
    for (var k = 0; k < chunk; k++) { var v = pcm[start + k]; sum += v * v; }
    out.energy[i] = Math.sqrt(sum / chunk);
    // The chunk's own value: the full-window spectrum, so a bass fundamental is resolved at
    // sampleRate/chunk rather than at the coarser sub-window spacing.
    out.dom[i] = marketPeakHz(marketSpectrum(pcm, start, chunk), chunk, sampleRate, minHz, maxHz).hz;
    // The box: each sub-window's own strongest frequency. First is the open, last the close,
    // the extremes the wicks - a real candlestick, every number of it from the audio.
    var o = 0, c = 0, hi = -Infinity, lo = Infinity;
    for (var s = 0; s < slices; s++) {
      var at = start + Math.min(chunk - sub, Math.round(s * (chunk - sub) / Math.max(1, slices - 1)));
      if (slices === 1) at = start;
      var hz = marketPeakHz(marketSpectrum(pcm, at, sub), sub, sampleRate, minHz, maxHz).hz;
      if (s === 0) o = hz;
      c = hz;
      if (hz > hi) hi = hz;
      if (hz < lo) lo = hz;
    }
    out.open[i] = o; out.close[i] = c;
    out.high[i] = hi === -Infinity ? 0 : hi;
    out.low[i] = lo === Infinity ? 0 : lo;
  }
  return out;
}

// The candle a playhead lands on. Clamped, so the head of the chart is the last candle and the
// start of the song is the first one, whatever the audio element reports.
function marketIndexAt(series, seconds) {
  if (!series || !series.count) return 0;
  var idx = Math.floor(Math.max(0, Number(seconds) || 0) * series.sampleRate / series.chunk);
  return Math.max(0, Math.min(series.count, idx));
}

function marketSeriesCacheGet(key, signature) {
  var hit = MARKET_SERIES_CACHE[key];
  return hit && hit.signature === signature ? hit : null;
}

function marketSeriesCachePut(key, series) {
  MARKET_SERIES_CACHE[key] = series;
  var keys = Object.keys(MARKET_SERIES_CACHE);
  while (keys.length > MARKET_SERIES_CACHE_LIMIT) {
    var oldest = keys.shift();
    if (oldest !== key) delete MARKET_SERIES_CACHE[oldest];
  }
}

// One song's PCM is tens of megabytes, so only the current one is kept; the series itself is
// small and a handful of them stay warm for going back to a track.
function marketPcmCacheGet(key) {
  return MARKET_PCM_CACHE.key === key && MARKET_PCM_CACHE.pcm ? MARKET_PCM_CACHE : null;
}

function marketReleaseSeries() {
  marketSeriesToken++;
  MARKET_PCM_CACHE = { key: '', pcm: null, sampleRate: 0 };
  marketSeriesState.phase = 'idle';
  marketSeriesState.progress = 0;
  marketSeriesState.key = '';
}

async function marketDecodeSong(url, token) {
  var resp = await fetch(url);
  if (token !== marketSeriesToken) return null;
  var ab = await resp.arrayBuffer();
  if (token !== marketSeriesToken) return null;
  var Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  var ctx = new Ctor();
  var buffer = await new Promise(function (resolve, reject) {
    ctx.decodeAudioData(ab.slice(0), resolve, reject);
  }).catch(function () { return null; });
  if (ctx.close) ctx.close();
  if (token !== marketSeriesToken || !buffer) return null;
  return { pcm: buffer.getChannelData(0), sampleRate: buffer.sampleRate };
}

// Fetch/decode/analyse a song's series. Resolves to the series, or to null when the call was
// superseded (another song, another knob) - a stale analysis must never overwrite the live one.
async function marketEnsureSeries(key, url, opts) {
  var signature = marketSeriesSignature(opts);
  var cached = marketSeriesCacheGet(key, signature);
  if (cached) {
    marketSeriesState.phase = 'ready';
    marketSeriesState.cached = true;
    marketSeriesState.key = key;
    marketSeriesState.count = cached.count;
    marketSeriesState.progress = 1;
    return cached;
  }
  var token = ++marketSeriesToken;
  var startedAt = Date.now();
  marketSeriesState = {
    key: key, phase: 'fetch', progress: 0, count: 0, error: '',
    costMs: 0, sampleRate: 0, chunk: opts.chunk, slices: opts.slices, cached: false
  };
  try {
    var pcm = marketPcmCacheGet(key);
    if (!pcm) {
      pcm = await marketDecodeSong(url, token);
      if (!pcm) return null;
      MARKET_PCM_CACHE = { key: key, pcm: pcm.pcm, sampleRate: pcm.sampleRate };
    }
    if (token !== marketSeriesToken) return null;
    marketSeriesState.phase = 'analyze';
    marketSeriesState.sampleRate = pcm.sampleRate;
    var series = await marketBuildSeriesAsync(pcm.pcm, pcm.sampleRate, opts, token);
    if (!series || token !== marketSeriesToken) return null;
    series.key = key;
    marketSeriesCachePut(key, series);
    marketSeriesState.phase = 'ready';
    marketSeriesState.count = series.count;
    marketSeriesState.progress = 1;
    marketSeriesState.costMs = Date.now() - startedAt;
    return series;
  } catch (err) {
    if (token !== marketSeriesToken) return null;
    marketSeriesState.phase = 'error';
    marketSeriesState.error = String(err && (err.message || err)).slice(0, 200);
    return null;
  }
}

// The same numbers as marketBuildSeries, reached in slices so a four-minute song does not
// freeze the frame loop while it is being measured.
async function marketBuildSeriesAsync(pcm, sampleRate, opts, token) {
  var chunk = Math.max(64, Math.round(opts.chunk));
  var total = Math.floor(pcm.length / chunk);
  var step = 48;
  var parts = [];
  for (var at = 0; at < total; at += step) {
    var head = Math.min(total, at + step);
    var view = pcm.subarray(at * chunk, head * chunk);
    var part = marketBuildSeries(view, sampleRate, opts);
    // subarray starts at a chunk boundary, so the part's own indices are relative: shift the
    // timestamps back onto the song's clock before joining.
    for (var i = 0; i < part.count; i++) part.t[i] += at * chunk / sampleRate;
    parts.push(part);
    marketSeriesState.progress = total ? head / total : 1;
    if (token !== marketSeriesToken) return null;
    if (head < total) {
      if (typeof yieldToPaint === 'function') await yieldToPaint();
      else await new Promise(function (r) { setTimeout(r, 0); });
    }
    if (token !== marketSeriesToken) return null;
  }
  return marketJoinSeries(parts, sampleRate, opts, pcm.length);
}

function marketJoinSeries(parts, sampleRate, opts, totalSamples) {
  var count = 0;
  for (var p = 0; p < parts.length; p++) count += parts[p].count;
  var out = marketBuildSeries(new Float32Array(0), sampleRate, opts);
  ['t', 'open', 'high', 'low', 'close', 'dom', 'energy'].forEach(function (field) {
    out[field] = new Float32Array(count);
  });
  out.count = count;
  var at = 0;
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    ['t', 'open', 'high', 'low', 'close', 'dom', 'energy'].forEach(function (field) {
      out[field].set(part[field], at);
    });
    at += part.count;
  }
  // The song's own length, not the last candle's end: a trailing partial chunk is still music.
  out.duration = totalSamples / sampleRate;
  return out;
}

function marketSeriesStatus() {
  return {
    key: marketSeriesState.key, phase: marketSeriesState.phase,
    progress: Math.round(marketSeriesState.progress * 1000) / 1000,
    count: marketSeriesState.count, error: marketSeriesState.error,
    costMs: marketSeriesState.costMs, sampleRate: marketSeriesState.sampleRate,
    chunk: marketSeriesState.chunk, slices: marketSeriesState.slices,
    cached: marketSeriesState.cached,
    pcmHeld: !!MARKET_PCM_CACHE.pcm, seriesHeld: Object.keys(MARKET_SERIES_CACHE).length
  };
}