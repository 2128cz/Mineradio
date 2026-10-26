'use strict';

// Feasibility probe for getting the PV (preset 13) koma off the main thread. The deliverable is
// a conclusion, not a feature: nothing here is wired into the app, and the hash-pinned vendor
// engine is loaded as it ships.
//
//   node_modules/electron/dist/electron.exe scripts/pv-offmain-probe.js --markdown
//   ... --size=1920x1080 --dpr=1 --samples=60 --plan=<archive.json>
//
// Two roads, measured separately:
//
//   (a) split-frame delivery. The engine already draws in two layers for transparent PNG export
//       (opt.transparent + opt.layer='back'|'front'): 'back' is the background graphic and the
//       decorations behind the lyrics, 'front' is the lyrics and everything after them. If one
//       koma could be delivered as two cheaper halves, the peak of a frame would drop even though
//       the whole costs the same. frame() clears the canvas on entry, so the halves cannot go to
//       the same canvas - this measures the two-canvas version and whether it still looks the same.
//
//   (b) OffscreenCanvas + Worker. The engine is written against the DOM: it calls
//       document.createElement('canvas') for its caches and document.fonts for its faces. This
//       asks whether a Worker with a small polyfill can build a Renderer and draw a real frame at
//       all, and what a frame costs there compared with the main thread.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCacheDir } = require('./pv-draw-bench.js');

const DEFAULT_SIZE = '1920x1080';
const DEFAULT_SAMPLES = 60;
const COMPARE_TIMES = 6;
const FRAME_BUDGET_MS = 1000 / 60;

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const size = (get('size') || DEFAULT_SIZE).split('x').map(Number);
  return {
    plan: get('plan'),
    cache: get('cache'),
    out: get('out'),
    cssW: size[0], cssH: size[1],
    dpr: Number(get('dpr') || 1),
    samples: Number(get('samples') || DEFAULT_SAMPLES),
    limit: Number(get('limit') || 1),
    markdown: argv.includes('--markdown'),
  };
}

function listArchives(cacheDir, limit) {
  return fs.readdirSync(cacheDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ n, size: fs.statSync(path.join(cacheDir, n)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, Math.max(1, limit))
    .map((r) => path.join(cacheDir, r.n));
}

function readArchivePlan(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const plan = raw && raw.plan ? raw.plan : raw;
  if (!plan || !Array.isArray(plan.cuts) || !plan.cuts.length) {
    throw Object.assign(new Error(`no plan.cuts in ${file}`), { code: 'PROBE_BAD_ARCHIVE' });
  }
  return { plan, label: path.basename(file), json: JSON.stringify(plan) };
}

// Road (a): the two-layer delivery, measured in the page that owns the main thread.
const PAGE_LAYERED = String.raw`async function () {
  const plan = window.__plan;
  const J = window.J;
  if (!J || typeof J.Renderer !== 'function') return { error: 'NO_ENGINE' };
  if (!plan) return { error: 'NO_PLAN' };
  const cssW = %CSSW%, cssH = %CSSH%, dpr = %DPR%;
  const planW = Math.max(1, plan.W || 1920), planH = Math.max(1, plan.H || 1080);
  const contain = Math.min(cssW / planW, cssH / planH);
  const w = Math.max(2, Math.round(planW * contain * dpr));
  const h = Math.max(2, Math.round(planH * contain * dpr));
  const scale = w / planW;
  const mk = function () {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };
  const fullCanvas = mk(), backCanvas = mk(), frontCanvas = mk(), outCanvas = mk();
  const fullCtx = fullCanvas.getContext('2d');
  const backCtx = backCanvas.getContext('2d');
  const frontCtx = frontCanvas.getContext('2d');
  const outCtx = outCanvas.getContext('2d');

  const cuts = plan.cuts || [];
  const times = [];
  const span = Math.max(1, plan.duration || 200);
  for (let i = 0; i < %SAMPLES%; i++) times.push((i + 0.5) * span / %SAMPLES%);

  const renderer = new J.Renderer();
  // The yardstick: what the app draws today, and what the same picture costs when the engine is
  // asked to leave the background out. The second one is the honest comparison for the split -
  // 透明 mode itself changes the frame (no black fill, no key background), so a split that only
  // beats the opaque frame has not proved anything about layering.
  const opaque = function (t) { renderer.frame(fullCtx, plan, t, { scale }); };
  const wholeTransparent = function (t) { renderer.frame(fullCtx, plan, t, { scale, transparent: true }); };
  const back = function (t) { renderer.frame(backCtx, plan, t, { scale, transparent: true, layer: 'back' }); };
  const front = function (t) { renderer.frame(frontCtx, plan, t, { scale, transparent: true, layer: 'front' }); };
  // The other reading of "two cheaper halves": each frame draws only one of the layers, so the peak
  // per frame is one layer plus a composite instead of the whole picture.
  const alternate = function (t, i) { if (i % 2) back(t); else front(t); composite(); };
  const composite = function () {
    outCtx.setTransform(1, 0, 0, 1, 0, 0);
    outCtx.globalAlpha = 1; outCtx.globalCompositeOperation = 'source-over'; outCtx.filter = 'none';
    outCtx.clearRect(0, 0, w, h);
    outCtx.drawImage(backCanvas, 0, 0);
    outCtx.drawImage(frontCanvas, 0, 0);
  };

  const pct = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; };
  const round2 = (x) => Math.round(x * 100) / 100;
  const stat = function (ms) {
    if (!ms.length) return null;
    return {
      n: ms.length, mean: round2(ms.reduce((a, b) => a + b, 0) / ms.length),
      p50: round2(pct(ms, 50)), p95: round2(pct(ms, 95)), max: round2(Math.max.apply(null, ms)),
      overFrame: ms.filter((x) => x > %FRAME_BUDGET%).length,
    };
  };
  const timed = function (run) {
    const s = performance.now();
    run();
    return performance.now() - s;
  };

  // Untimed warm-up: the engine is interpreted and then hot-pathed, and the first sweep of a
  // session pays for that.
  const warm = new J.Renderer();
  for (let i = 0; i < 8; i++) warm.frame(fullCtx, plan, times[i % times.length], { scale });
  for (let i = 0; i < 4; i++) { warm.frame(backCtx, plan, times[i], { scale, transparent: true, layer: 'back' }); warm.frame(frontCtx, plan, times[i], { scale, transparent: true, layer: 'front' }); }

  const msOpaque = [], msWhole = [], msBack = [], msFront = [], msComp = [], msSum = [], msAlt = [];
  for (let pass = 0; pass < 2; pass++) {
    if (pass) { msOpaque.length = 0; msWhole.length = 0; msBack.length = 0; msFront.length = 0; msComp.length = 0; msSum.length = 0; msAlt.length = 0; }
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const a = timed(() => opaque(t));
      const b = timed(() => wholeTransparent(t));
      const c = timed(() => back(t));
      const d = timed(() => front(t));
      const e = timed(() => composite());
      const f = timed(() => alternate(t, i));
      if (pass) {
        msOpaque.push(a); msWhole.push(b); msBack.push(c); msFront.push(d); msComp.push(e);
        msSum.push(c + d + e);
        msAlt.push(f);
      }
    }
  }

  // Does the stack still look like the single frame? Compared at a handful of times, on the
  // pixels: the mean and the worst channel difference, and how many pixels moved at all.
  const diffAgainst = function (canvasA, canvasB) {
    const oa = canvasA.getContext('2d').getImageData(0, 0, w, h).data;
    let sum = 0, worst = 0, moved = 0, n = 0;
    const ob = canvasB.getContext('2d').getImageData(0, 0, w, h).data;
    for (let i = 0; i < oa.length; i += 4) {
      const d1 = Math.abs(oa[i] - ob[i]) + Math.abs(oa[i + 1] - ob[i + 1]) + Math.abs(oa[i + 2] - ob[i + 2]);
      sum += d1; n += 1;
      if (d1 > worst) worst = d1;
      if (d1 > 24) moved += 1;
    }
    return { mean: round2(sum / n), worst: Math.round(worst), movedPct: round2(100 * moved / n) };
  };
  // Three readings per sample time. The engine keeps time-driven state between calls, so each
  // variant gets its own renderer and the same run-up of earlier times: whatever differs after
  // that is the variant, not leftover state from the variant before it.
  //   opaqueVsTransparent - what 透明 mode itself costs the picture,
  //   opaqueVsStack       - what the whole scheme costs against what the app draws today,
  //   transparentVsStack  - the layering question on its own: the same 透明 frame, one pass or two.
  const wholeCanvas = mk();
  const wholeCtx = wholeCanvas.getContext('2d');
  const PRIME = 8;
  const stacked = [];
  for (let i = 0; i < %COMPARE%; i++) {
    const idx = Math.floor(i * times.length / %COMPARE%);
    const t = times[idx];
    const rO = new J.Renderer(), rW = new J.Renderer(), rS = new J.Renderer();
    for (let k = Math.max(0, idx - PRIME); k < idx; k++) {
      rO.frame(fullCtx, plan, times[k], { scale });
      rW.frame(wholeCtx, plan, times[k], { scale, transparent: true });
      rS.frame(backCtx, plan, times[k], { scale, transparent: true, layer: 'back' });
      rS.frame(frontCtx, plan, times[k], { scale, transparent: true, layer: 'front' });
    }
    rO.frame(fullCtx, plan, t, { scale });
    rW.frame(wholeCtx, plan, t, { scale, transparent: true });
    rS.frame(backCtx, plan, t, { scale, transparent: true, layer: 'back' });
    rS.frame(frontCtx, plan, t, { scale, transparent: true, layer: 'front' });
    composite();
    stacked.push({
      t: round2(t),
      opaqueVsTransparent: diffAgainst(fullCanvas, wholeCanvas),
      opaqueVsStack: diffAgainst(fullCanvas, outCanvas),
      transparentVsStack: diffAgainst(wholeCanvas, outCanvas),
    });
  }

  return {
    ok: true,
    box: { cssW, cssH, dpr, canvasW: w, canvasH: h, pixels: w * h, design: plan.W + 'x' + plan.H },
    plan: { cuts: cuts.length, lines: (plan.lines || []).length, events: (plan.events || []).length, duration: plan.duration },
    results: {
      opaque: stat(msOpaque),
      'transparent-whole': stat(msWhole),
      'layer-back': stat(msBack),
      'layer-front': stat(msFront),
      composite: stat(msComp),
      'split-total': stat(msSum),
      'alternate-frame': stat(msAlt),
    },
    diffs: stacked,
  };
}`;

// Road (b): the engine inside a Worker, drawing into an OffscreenCanvas. The worker body is its own
// constant - it ships to the Worker as a Blob, so PAGE_WORKER only inlines a JSON copy of it.
const WORKER_SRC = String.raw`
    // The smallest polyfill that lets the engine's module code run: it creates canvases through
    // document.createElement and registers faces through document.fonts.
    const created = [];
    self.document = {
      createElement(tag) {
        if (tag === 'canvas') {
          const c = new OffscreenCanvas(2, 2);
          c.style = {};
          created.push(c);
          return c;
        }
        return { style: {}, appendChild() {}, setAttribute() {}, sheet: { insertRule() {} } };
      },
      head: { appendChild() {} },
      documentElement: { style: {} },
      body: { appendChild() {} },
      fonts: { add() {}, load() { return Promise.resolve([]); }, check() { return false; }, ready: Promise.resolve() },
      hidden: false,
    };
    self.window = self;
    self.self = self;
    let report = { loaded: false, drew: 0, frameMs: [], error: '' };
    try {
      self.onmessage = async function (ev) {
        const msg = ev.data;
        try {
          (0, eval)(msg.engineSrc);
          report.loaded = true;
          const J = self.J;
          if (!J || typeof J.Renderer !== 'function') throw new Error('the engine did not define J.Renderer in a Worker');
          const canvas = new OffscreenCanvas(msg.w, msg.h);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('OffscreenCanvas 2d context refused');
          const renderer = new J.Renderer();
          const scale = msg.w / (msg.plan.W || 1920);
          for (let i = 0; i < msg.warmup; i++) renderer.frame(ctx, msg.plan, msg.times[i % msg.times.length], { scale });
          for (const t of msg.times) {
            const s = performance.now();
            renderer.frame(ctx, msg.plan, t, { scale });
            report.frameMs.push(performance.now() - s);
            report.drew += 1;
          }
          const blob = await canvas.convertToBlob({ type: 'image/png' });
          report.bytes = blob.size;
        } catch (err) {
          report.error = String((err && err.stack) || err).split('\n').slice(0, 4).join(' | ');
        }
        postMessage(report);
      };
    } catch (err) {
      report.error = String((err && err.stack) || err).split('\n').slice(0, 4).join(' | ');
      postMessage(report);
    }
  `;
const PAGE_WORKER = String.raw`async function () {
  const workerSource = %WORKER_SRC%;
  const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const worker = new Worker(blobUrl);
  const plan = window.__plan;
  const span = Math.max(1, plan.duration || 200);
  const times = [];
  for (let i = 0; i < %SAMPLES%; i++) times.push((i + 0.5) * span / %SAMPLES%);
  const engineSrc = window.__engineSrc;
  const answer = new Promise(function (resolve) {
    worker.onmessage = function (ev) { resolve(ev.data); worker.terminate(); };
    worker.onerror = function (e) { resolve({ loaded: false, drew: 0, frameMs: [], error: 'worker error: ' + (e && e.message) }); worker.terminate(); };
  });
  worker.postMessage({ engineSrc, plan, w: %W%, h: %H%, times, warmup: 8 });
  const out = await Promise.race([
    answer,
    new Promise((resolve) => setTimeout(() => resolve({ loaded: false, drew: 0, frameMs: [], error: 'TIMEOUT (45s)' }), 45000)),
  ]);
  const round2 = (x) => Math.round(x * 100) / 100;
  const ms = out.frameMs || [];
  const sorted = ms.slice().sort((a, b) => a - b);
  return {
    ok: true,
    loaded: !!out.loaded,
    drew: out.drew,
    bytes: out.bytes || 0,
    error: out.error || '',
    stats: ms.length ? {
      n: ms.length, mean: round2(ms.reduce((a, b) => a + b, 0) / ms.length),
      p50: round2(sorted[Math.floor(sorted.length / 2)]),
      p95: round2(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
      max: round2(sorted[sorted.length - 1]),
    } : null,
  };
}`;

function toMarkdown(layered, worker, planLabel) {
  const lines = [];
  lines.push(`\n### 探针 (a) 分层交付 — ${planLabel}`);
  if (!layered || !layered.ok) {
    lines.push(`${layered && layered.error ? layered.error : 'failed'}`);
  } else {
    const b = layered.box;
    lines.push(`画布 ${b.canvasW}x${b.canvasH}（${(b.pixels / 1e6).toFixed(2)} Mpx，设计 ${b.design}），主线程 JS 时间`);
    lines.push('');
    lines.push(`| 方案 | 均值 ms | p50 | p95 | max | >${Math.round(FRAME_BUDGET_MS * 10) / 10}ms | 相对 transparent-whole |`);
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    const base = layered.results['transparent-whole'] && layered.results['transparent-whole'].mean;
    for (const key of Object.keys(layered.results)) {
      const s = layered.results[key];
      if (!s) { lines.push(`| ${key} | — | | | | | |`); continue; }
      const rel = base ? `${(s.mean / base).toFixed(2)}x` : '—';
      lines.push(`| ${key} | ${s.mean} | ${s.p50} | ${s.p95} | ${s.max} | ${s.overFrame}/${s.n} | ${key === 'transparent-whole' ? '—' : rel} |`);
    }
    lines.push('');
    lines.push('像素差（三通道绝对差之和：均值 / 最大 / 变化>24 的像素占比）');
    lines.push('');
    lines.push('| 取样 t | 不透明 vs 整幅透明 | 不透明 vs back+front 叠加 | 整幅透明 vs back+front 叠加 |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of layered.diffs) {
      const f = (s) => `${s.mean} / ${s.worst} / ${s.movedPct}%`;
      lines.push(`| ${d.t}s | ${f(d.opaqueVsTransparent)} | ${f(d.opaqueVsStack)} | ${f(d.transparentVsStack)} |`);
    }
  }
  lines.push(`\n### 探针 (b) OffscreenCanvas + Worker — ${planLabel}`);
  if (!worker || !worker.ok) {
    lines.push(`${worker && worker.error ? worker.error : 'failed'}`);
  } else {
    lines.push(`引擎在 Worker 里加载：${worker.loaded ? '成功' : '失败'}；画出帧数 ${worker.drew}${worker.bytes ? `；convertToBlob 一帧 ${worker.bytes} 字节` : ''}`);
    if (worker.error) lines.push(`错误：${worker.error}`);
    if (worker.stats) {
      const s = worker.stats;
      lines.push(`Worker 内一帧 JS 时间：均值 ${s.mean} ms，p50 ${s.p50}，p95 ${s.p95}，max ${s.max}（n=${s.n}）`);
    }
  }
  return lines.join('\n');
}

function emit(file, text) {
  fs.appendFileSync(file, text);
  try { process.stdout.write(text); } catch (_) { /* GUI binary: the pipe may not be there */ }
}

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv);
  const dir = path.join(os.tmpdir(), 'mineradio-pv-offmain-probe');
  fs.mkdirSync(dir, { recursive: true });
  const enginePath = path.join(appRoot, 'vendor', 'jizura', 'jizura-engine.js');
  const engineSrc = fs.readFileSync(enginePath, 'utf8');
  fs.copyFileSync(enginePath, path.join(dir, 'engine.js'));
  fs.writeFileSync(path.join(dir, 'probe.html'),
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000">'
    + '<script src="engine.js"></script>'
    + `<script>window.__engineSrc = ${JSON.stringify(engineSrc)};</script>`
    + '</body></html>', 'utf8');
  const outFile = args.out ? path.resolve(args.out) : path.join(dir, args.markdown ? 'result.md' : 'result.jsonl');
  fs.writeFileSync(outFile, '', 'utf8');

  const files = args.plan ? [path.resolve(args.plan)] : listArchives(resolveCacheDir(args.cache), args.limit);
  const { app, BrowserWindow } = require('electron');
  for (const [name, value] of [['autoplay-policy', 'no-user-gesture-required'], ['use-angle', 'd3d11']]) {
    app.commandLine.appendSwitch(name, value);
  }
  for (const name of ['enable-gpu-rasterization', 'enable-oop-rasterization', 'disable-renderer-backgrounding',
    'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) {
    app.commandLine.appendSwitch(name);
  }
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadFile(path.join(dir, 'probe.html'));

  const entry = readArchivePlan(files[0]);
  await win.webContents.executeJavaScript(`window.__plan = ${entry.json}; true;`, true);

  const planW = Math.max(1, entry.plan.W || 1920), planH = Math.max(1, entry.plan.H || 1080);
  const contain = Math.min(args.cssW / planW, args.cssH / planH);
  const w = Math.max(2, Math.round(planW * contain * args.dpr));
  const h = Math.max(2, Math.round(planH * contain * args.dpr));

  let layered;
  try {
    const script = PAGE_LAYERED
      .replace(/%CSSW%/g, String(args.cssW)).replace(/%CSSH%/g, String(args.cssH))
      .replace(/%DPR%/g, String(args.dpr)).replace(/%SAMPLES%/g, String(args.samples))
      .replace(/%COMPARE%/g, String(COMPARE_TIMES))
      .replace(/%FRAME_BUDGET%/g, String(FRAME_BUDGET_MS));
    layered = await win.webContents.executeJavaScript(`(${script})()`, true);
  } catch (err) {
    layered = { ok: false, error: String((err && err.message) || err) };
  }
  let worker;
  try {
    const script = PAGE_WORKER.replace(/%SAMPLES%/g, String(args.samples)).replace(/%W%/g, String(w)).replace(/%H%/g, String(h))
      .replace('%WORKER_SRC%', () => JSON.stringify(WORKER_SRC));
    worker = await win.webContents.executeJavaScript(`(${script})()`, true);
  } catch (err) {
    worker = { ok: false, error: String((err && err.message) || err) };
  }

  if (args.markdown) emit(outFile, toMarkdown(layered, worker, entry.label) + '\n');
  else emit(outFile, JSON.stringify({ layered, worker }) + '\n');
  emit(outFile, `\npv-offmain-probe: ${entry.label} ${w}x${h} -> ${outFile}\n`);
  win.destroy();
  app.exit(layered.ok && worker.ok ? 0 : 1);
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) {
  main().catch((err) => {
    const text = `pv-offmain-probe failed: ${String((err && err.stack) || err)}\n`;
    try {
      const dir = path.join(os.tmpdir(), 'mineradio-pv-offmain-probe');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'result.log'), text);
    } catch (_) { /* nothing else to try */ }
    try { process.stderr.write(text); } catch (_) { /* as above */ }
    process.exit(1);
  });
}

module.exports = { parseArgs, readArchivePlan, toMarkdown };
