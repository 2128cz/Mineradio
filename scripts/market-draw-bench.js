'use strict';

// RHYTHM MARKET (preset 16) draw-cost bench. Measures one delivered frame of the shipped market
// module in a WebGL scene built the way the app builds it, so the cost is decided on numbers
// instead of guesses. Read-only: the shipped modules are loaded into a throwaway hidden window,
// fed a synthetic song, and nothing in the running app is touched - which is also why it works
// while the user's own window is minimized and the app's loop is parked by design.
//
//   node_modules/electron/dist/electron.exe scripts/market-draw-bench.js
//   node_modules/electron/dist/electron.exe scripts/market-draw-bench.js --sizes=1920x1080 --samples=40
//   node_modules/electron/dist/electron.exe scripts/market-draw-bench.js --heads=0.1,0.5,1 --markdown
//
// The chart grows with the song, so the number of candles on screen is the scaling axis: --heads
// picks where the playhead sits (a fraction of the song). The default is the end of the song,
// which is the worst case - every candle the song will ever have is on screen at once.
//
// Run-to-run spread on one machine is ~10-20%, so this reports a table for the SAME scene with
// one part removed at a time, which is what docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md asks for
// instead of absolute numbers from one box. Every phase gets a fresh page (fresh module, fresh
// clock, same warm-up) and the phase order rotates between rounds, so a slow minute lands on all
// rows alike.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_SIZES = ['1920x1080', '1280x720'];
const DEFAULT_SAMPLES = 30;
const DEFAULT_ROUNDS = 3;
const DEFAULT_WARMUP = 30;
const DEFAULT_REPEAT = 8;
const DEFAULT_SONG_SEC = 300;
const FRAME_BUDGET_MS = 1000 / 60;

// One row per part. Each hides exactly one thing, so the row is that part's marginal cost; the
// shipped code is never edited. 'none' is the floor: the same loop, the same camera motion, the
// same audio clock, with the market neither drawing nor updating.
const MARKET_PARTS = [
  { name: 'full', hide: null, stubUpdate: false },
  { name: 'nodraw', hide: 'group', stubUpdate: false },
  { name: 'none', hide: 'group', stubUpdate: true },
  { name: 'no-wall', hide: 'wall', stubUpdate: false },
  { name: 'no-candles', hide: 'candles', stubUpdate: false },
];

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const sizes = (get('sizes') || DEFAULT_SIZES.join(',')).split(',').map((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s.trim());
    if (!m) throw new Error(`bad size: ${s}`);
    return [Number(m[1]), Number(m[2])];
  });
  const num = (name, def, min) => {
    const v = Number(get(name) || def);
    if (!isFinite(v) || v < min) throw new Error(`bad --${name}`);
    return v;
  };
  const heads = (get('heads') || '0.5,1').split(',').map((s) => {
    const v = Number(s);
    if (!isFinite(v) || v <= 0 || v > 1) throw new Error(`bad --heads: ${s}`);
    return v;
  });
  const only = get('phases');
  return {
    sizes, heads,
    samples: num('samples', DEFAULT_SAMPLES, 1),
    rounds: num('rounds', DEFAULT_ROUNDS, 1),
    warmup: num('warmup', DEFAULT_WARMUP, 1),
    repeat: num('repeat', DEFAULT_REPEAT, 1),
    songSec: num('songSec', DEFAULT_SONG_SEC, 1),
    only: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null,
    markdown: argv.includes('--markdown'),
    out: get('out'),
  };
}

// The app globals the two shipped modules read. The renderer is created with the app's own
// options (01-scene/00-renderer-quality.js:177) so the bench draws through the same backend.
const PAGE_SETUP = String.raw`
  window.fx = { preset: 16 };
  window.playQueue = [{ id: 'bench-song', name: 'bench', source: 'bench' }];
  window.currentIdx = 0;
  window.audio = { currentTime: 0, duration: 300, currentSrc: 'bench://song', src: 'bench://song', paused: false, readyState: 4 };
  window.currentBeatMap = null;
  window.beatOnsetFlag = false;
  window.marketTuning = null;
  window.uniforms = { uHasCover: { value: 0 } };
  window.scene = new THREE.Scene();
  window.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  window.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('canvas-container').appendChild(renderer.domElement);
`;

function pageHtml() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>market draw bench</title>'
    + '<style>html,body{margin:0;padding:0;background:#000;overflow:hidden;height:100%}'
    + '#canvas-container{position:absolute;left:0;top:0;right:0;bottom:0}</style>'
    + '</head><body><div id="canvas-container"></div>'
    + '<script src="three.js"></script>'
    + '<script>' + PAGE_SETUP + '</script>'
    + '<script src="market-series.js"></script>'
    + '<script src="market-preset.js"></script>'
    + '</body></html>';
}

function prepareScratchDir(appRoot) {
  const dir = path.join(os.tmpdir(), 'mineradio-market-draw-bench');
  fs.mkdirSync(dir, { recursive: true });
  const copy = (from, to) => fs.copyFileSync(path.join(appRoot, from), path.join(dir, to));
  copy('public/vendor/three.r128.min.js', 'three.js');
  copy('public/js/modules/03-beat/07-market-series.js', 'market-series.js');
  copy('public/js/modules/02-visual/21-rhythm-market-preset.js', 'market-preset.js');
  fs.writeFileSync(path.join(dir, 'bench.html'), pageHtml(), 'utf8');
  return dir;
}

function stat(costs) {
  if (!costs || !costs.length) return null;
  const sorted = costs.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    n: sorted.length,
    mean: r2(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: r2(at(0.5)), p95: r2(at(0.95)), max: r2(sorted[sorted.length - 1]), min: r2(sorted[0]),
  };
}

function emit(file, text) {
  fs.appendFileSync(file, text);
  try { process.stdout.write(text); } catch (_) { /* GUI binary: the pipe may not be there */ }
}

function toMarkdown(rows) {
  const lines = [];
  for (const row of rows) {
    if (!row.ok) { lines.push(`\n${row.label}: ${row.error || 'failed'}`); continue; }
    lines.push(`\n### ${row.label} — ${row.box.cssW}x${row.box.cssH} · 播放头 ${Math.round(row.head * 100)}%`);
    lines.push('');
    lines.push(`K线 ${row.box.candles} 根 / 已写 ${row.box.written} · 停盘 ${row.box.hits} 次(${row.box.hitSource}) · 画布 ${row.box.canvasW}x${row.box.canvasH} · dpr ${row.box.dpr} · 每样本重绘 ${row.box.repeat} 次 · 频谱分析 ${row.box.analysisMs}ms · 颜色缓冲 ${row.box.colourLen} 项 / 峰值 ${row.box.colourPeak}`);
    lines.push('');
    lines.push(`| 方案 | 中位 ms | 均值 | p95 | 最大 | >${Math.round(FRAME_BUDGET_MS * 10) / 10}ms | 相对 full(中位) | 模块自测 JS 中位 | draw calls | 三角形 |`);
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const base = row.results.full && row.results.full.p50 ? row.results.full.p50 : null;
    for (const key of Object.keys(row.results)) {
      const s = row.results[key];
      if (!s) { lines.push(`| ${key} | — | | | | | | | | |`); continue; }
      const saving = base ? `${Math.round((1 - s.p50 / base) * 100)}%` : '—';
      lines.push(`| ${key} | ${s.p50} | ${s.mean} | ${s.p95} | ${s.max} | ${s.over}/${s.n} | ${key === 'full' ? '—' : saving} | ${s.js ? s.js.p50 : '—'} | ${s.calls} | ${s.tris} |`);
    }
  }
  return lines.join('\n');
}

// One phase, measured on a freshly loaded page. The song, the beat grid, the playhead and the
// warm-up are identical across phases, so the only difference between the rows is what is drawn.
const PAGE_RUN = String.raw`async function (opts) {
  if (typeof window.marketBuildSeries !== 'function') return { ok: false, error: 'the series module did not load' };
  if (typeof window.updateStockMarket !== 'function') return { ok: false, error: 'the market module did not load' };
  const sr = 44100;
  const n = Math.round(opts.songSec * sr);

  // A synthetic song whose loudest band moves: a 70Hz kick under a 120BPM envelope, two mid
  // tones whose gains cross over slowly, and a thin high partial. The peak therefore walks
  // between bass and vocal, which is what makes the chart rise and fall instead of sitting flat.
  const pcm = new Float32Array(n);
  const w70 = 2 * Math.PI * 70 / sr, w300 = 2 * Math.PI * 300 / sr;
  const w1200 = 2 * Math.PI * 1200 / sr, w5000 = 2 * Math.PI * 5000 / sr;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const beat = (t % 0.5) < 0.08 ? 1 : 0.25;
    const cross = 0.5 + 0.5 * Math.sin(t * 0.11);
    pcm[i] = 0.55 * beat * Math.sin(w70 * i)
      + 0.5 * cross * Math.sin(w300 * i)
      + 0.5 * (1 - cross) * Math.sin(w1200 * i)
      + 0.10 * Math.sin(w5000 * i);
  }

  const analysisStart = performance.now();
  const series = window.marketBuildSeries(pcm, sr, { chunk: 4096, slices: 4, minHz: 40, maxHz: 8000 });
  const analysisMs = Math.round(performance.now() - analysisStart);
  if (!series || !series.count) return { ok: false, error: 'marketBuildSeries returned nothing' };

  // A beat grid so the stall path runs: without it the display clock never slows and the frame
  // being priced is not the frame the app draws on a drum hit.
  const pulseBeats = [];
  for (let t = 0.25; t < opts.songSec; t += 0.5) pulseBeats.push({ time: t, strength: 0.6, impact: 0.6 });
  window.currentBeatMap = { pulseBeats: pulseBeats, cameraBeats: pulseBeats, hits: pulseBeats, duration: opts.songSec };

  window.audio.duration = opts.songSec;
  window.audio.currentTime = opts.head * opts.songSec;
  window.camera.aspect = opts.cssW / opts.cssH;
  window.camera.updateProjectionMatrix();
  if (!window.marketBuildScene()) return { ok: false, error: 'marketBuildScene refused' };
  window.marketAcceptSeries(series, 'bench:bench-song', '4096|4|40|8000');
  if (!window.marketState.series) return { ok: false, error: 'the series was not accepted' };

  const realUpdate = window.updateStockMarket;
  if (opts.stubUpdate) window.updateStockMarket = function () {};
  const st = window.marketState;
  if (opts.hide === 'group' && st.group) st.group.visible = false;
  if (opts.hide === 'wall' && st.wall) st.wall.visible = false;
  if (opts.hide === 'candles') {
    if (st.bodies) st.bodies.visible = false;
    if (st.wicks) st.wicks.visible = false;
    if (st.curve) st.curve.visible = false;
  }

  const dt = 1 / 60;
  let clock = performance.now();
  const jsAll = [];
  const stepFrame = function () {
    clock += dt * 1000;
    window.audio.currentTime = Math.min(opts.songSec, window.audio.currentTime + dt);
    window.updateStockMarket(clock, dt);
    window.applyStockCameraPose(dt);
    window.renderer.render(window.scene, window.camera);
    if (typeof st.lastCostMs === 'number') jsAll.push(st.lastCostMs);
  };

  // Warm up: the first frame writes every candle up to the playhead and the GPU compiles and
  // uploads the instance buffers. Every phase pays the same warm-up, so none is charged for it.
  for (let i = 0; i < opts.warmup; i++) stepFrame();

  // WebGL records commands and rasterises later, so the time around render() is the recording,
  // not the picture. A one-pixel readback forces the rasterisation; doing one with nothing new
  // to rasterise first gives the baseline (the wait and the transfer), and the difference is
  // what the drawing cost.
  //
  // The market is cheap enough that one frame's drawing sits inside the readback's own jitter
  // (a per-frame difference went negative), so the same picture is drawn opts.repeat times between
  // the two readbacks and the difference is divided. These are explicit render() calls into the
  // same unchanged scene, not animation frames, so the driver cannot drop the ones in between -
  // every one of them is a real draw. The clock is stepped once per sample, outside the repeat.
  const gl = window.renderer.getContext();
  const pixel = new Uint8Array(4);
  const readback = function () {
    const t0 = performance.now();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return performance.now() - t0;
  };
  const repeat = Math.max(1, opts.repeat | 0);
  readback();
  const costs = [];
  for (let i = 0; i < opts.samples; i++) {
    const base = readback();
    clock += dt * 1000;
    window.audio.currentTime = Math.min(opts.songSec, window.audio.currentTime + dt);
    window.updateStockMarket(clock, dt);
    window.applyStockCameraPose(dt);
    if (typeof st.lastCostMs === 'number') jsAll.push(st.lastCostMs);
    for (let k = 0; k < repeat; k++) window.renderer.render(window.scene, window.camera);
    costs.push((readback() - base) / repeat);
  }

  const info = window.renderer.info.render;
  // A candle with no colour draws black. setColorAt allocates instanceColor from the mesh count
  // at the moment of the first call, so an empty buffer is the whole difference between a chart
  // and a silhouette - and it is invisible to every count and draw-call reading.
  const ic = st.bodies && st.bodies.instanceColor;
  let colourPeak = 0;
  if (ic && ic.array) {
    for (let k = 0; k < Math.min(ic.array.length, Math.max(0, st.written) * 3); k++) {
      if (ic.array[k] > colourPeak) colourPeak = ic.array[k];
    }
  }
  if (!ic || !ic.array || !ic.array.length) {
    return { ok: false, error: 'the bodies have no instanceColor buffer: every candle would draw black' };
  }
  if (st.written > 0 && colourPeak <= 0) {
    return { ok: false, error: 'every written candle colour is zero: the chart is a silhouette' };
  }
  const out = {
    ok: true,
    costs: costs,
    js: jsAll.slice(-opts.samples),
    calls: info.calls,
    tris: info.triangles,
    box: {
      cssW: opts.cssW, cssH: opts.cssH,
      canvasW: window.renderer.domElement.width, canvasH: window.renderer.domElement.height,
      dpr: window.renderer.getPixelRatio(),
      candles: series.count, written: st.written,
      shown: Math.round(st.shown * 100) / 100,
      hits: st.hits, hitSource: st.hitSource,
      analysisMs: analysisMs, repeat: repeat,
      colourLen: ic.array.length, colourPeak: Math.round(colourPeak * 1000) / 1000,
      groupVisible: st.group ? st.group.visible : null,
      bodies: st.bodies ? st.bodies.count : 0,
    },
  };
  window.updateStockMarket = realUpdate;
  return out;
}`;

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv);
  const scratch = prepareScratchDir(appRoot);
  const pagePath = path.join(scratch, 'bench.html');
  const outFile = args.out ? path.resolve(args.out) : path.join(scratch, args.markdown ? 'result.md' : 'result.jsonl');
  fs.writeFileSync(outFile, '', 'utf8');
  const { app, BrowserWindow } = require('electron');
  for (const [name, value] of [['autoplay-policy', 'no-user-gesture-required'], ['use-angle', 'd3d11']]) {
    app.commandLine.appendSwitch(name, value);
  }
  for (const name of ['enable-gpu-rasterization', 'disable-renderer-backgrounding',
    'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) {
    app.commandLine.appendSwitch(name);
  }
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 1920, height: 1080,
    webPreferences: { backgroundThrottling: false, sandbox: false },
  });

  const rows = [];
  let failures = 0;
  for (const [cssW, cssH] of args.sizes) {
    win.setContentSize(cssW, cssH);
    for (const head of args.heads) {
      let phases = MARKET_PARTS.slice();
      if (args.only) phases = phases.filter((p) => args.only.indexOf(p.name) >= 0);
      if (!phases.length) {
        const row = { label: 'market', ok: false, error: 'no phase matched --phases' };
        rows.push(row); failures++;
        emit(outFile, (args.markdown ? toMarkdown([row]) : JSON.stringify(row)) + '\n');
        continue;
      }
      const acc = {};
      const jsAcc = {};
      const meta = {};
      const boxes = {};
      let failure = '';
      for (let r = 0; r < args.rounds && !failure; r++) {
        const order = phases.slice(r % phases.length).concat(phases.slice(0, r % phases.length));
        for (const phase of order) {
          await win.loadFile(pagePath);
          const opts = {
            cssW, cssH, head, hide: phase.hide, stubUpdate: phase.stubUpdate,
            warmup: args.warmup, samples: args.samples, songSec: args.songSec, repeat: args.repeat,
          };
          let res;
          try {
            res = await win.webContents.executeJavaScript(`(${PAGE_RUN})(${JSON.stringify(opts)})`, true);
          } catch (err) {
            res = { ok: false, error: String((err && err.message) || err) };
          }
          if (!res || !res.ok) { failure = (res && res.error) || 'failed'; break; }
          boxes[phase.name] = res.box;
          if (!acc[phase.name]) { acc[phase.name] = []; jsAcc[phase.name] = []; }
          for (const c of res.costs) acc[phase.name].push(c);
          for (const v of res.js) jsAcc[phase.name].push(v);
          meta[phase.name] = { calls: res.calls, tris: res.tris };
        }
      }
      if (failure) {
        const row = { label: 'market', ok: false, error: failure, head };
        rows.push(row); failures++;
        emit(outFile, (args.markdown ? toMarkdown([row]) : JSON.stringify(row)) + '\n');
        continue;
      }
      const results = {};
      for (const phase of phases) {
        const s = stat(acc[phase.name]);
        s.over = acc[phase.name].filter((c) => c > FRAME_BUDGET_MS).length;
        s.js = stat(jsAcc[phase.name]);
        s.calls = meta[phase.name].calls;
        s.tris = meta[phase.name].tris;
        results[phase.name] = s;
      }
      const row = { label: 'market', ok: true, head, box: boxes.full || boxes[phases[0].name] || null, results };
      rows.push(row);
      emit(outFile, (args.markdown ? toMarkdown([row]) : JSON.stringify(row)) + '\n');
    }
  }
  win.destroy();
  emit(outFile, `\nmarket-draw-bench: ${rows.length} sweeps, ${failures} failed -> ${outFile}\n`);
  app.exit(failures ? 1 : 0);
}

// Electron loads the entry file with require.main set to its own 'electron' module, so the usual
// `require.main === module` guard never fires there: the app would start and sit idle forever.
const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) {
  main().catch((err) => {
    emit(path.join(os.tmpdir(), 'mineradio-market-draw-bench', 'result.jsonl'),
      'market-draw-bench failed: ' + String((err && err.stack) || err) + '\n');
    process.exitCode = 1;
  });
}