'use strict';

// PV (preset 13) draw-cost bench. Measures one delivered koma of the vendored JIZURA renderer
// under each downgrade option, at a chosen canvas size, so tier decisions are made on numbers
// instead of guesses. Read-only: it loads the engine and real archives, draws into a throwaway
// window, and changes nothing in the app.
//
//   node_modules/electron/dist/electron.exe scripts/pv-draw-bench.js
//   node_modules/electron/dist/electron.exe scripts/pv-draw-bench.js --sizes=2160x1620 --phases=full,fast,noTrans
//
// --plan=<archive.json> pins one archive so two runs are comparable; --limit picks the largest
// archives when no plan is given. The archive layout is { plan, recipe, source, ... } as written
// by pv-archive.js.
//
// Run-to-run spread on the same machine is ~10-20% and cross-machine differences are large, so
// this reports a table for the SAME scene before/after - which is what
// docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md asks for instead of absolute numbers from one box.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The options the app can hand to J.Renderer.frame() to trade effect cost for frame time. Each
// entry is asserted against the vendored engine by tests/pv-draw-bench-guard.test.js, because a
// vendor bump that renames a knob would otherwise silently turn a tier into a no-op.
const PV_ENGINE_KNOBS = [
  { name: 'fast', pattern: /this\.filterOK && !opt\.fast/, kills: 'per-glyph filters, camera filters and the bloom/glow pass' },
  { name: 'noGhost', pattern: /!opt\.noGhost/, kills: 'the two chroma ghost passes' },
  { name: 'noPost', pattern: /!opt\.noPost\) this\.post\(/, kills: 'the whole post chain: glitch events, glow, scanlines, grain, vignette' },
  { name: 'noTrans', pattern: /!opt\.noTrans/, kills: 'the cut-to-cut composite of the previous cut (hard cut instead)' },
  { name: 'noHud', pattern: /!opt\.noHud/, kills: 'the hud overlay (measured free)' },
];

const DEFAULT_SIZES = ['1280x720', '1920x1080'];
const DEFAULT_DPRS = [1, 1.5];
const DEFAULT_PHASES = ['full', 'fast', 'noGhost', 'noPost', 'noTrans', 'fastNoTrans', 'cheap', 'warm', 'bleed'];
const DEFAULT_SAMPLES = 120;
const DEFAULT_LIMIT = 1;
const FRAME_BUDGET_MS = 1000 / 60;
const KOMA_BUDGET_MS = 1000 / 12;

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const list = (name, fallback) => {
    const raw = get(name);
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
  };
  return {
    plan: get('plan'),
    cache: get('cache'),
    // electron.exe is a GUI binary: a piped stdout can wedge the launcher on Windows, so results
    // are always appended to a file as well as echoed.
    out: get('out'),
    sizes: list('sizes', DEFAULT_SIZES).map((s) => s.split('x').map(Number)),
    dprs: list('dprs', DEFAULT_DPRS.map(String)).map(Number),
    phases: list('phases', DEFAULT_PHASES),
    samples: Number(get('samples') || DEFAULT_SAMPLES),
    limit: Number(get('limit') || DEFAULT_LIMIT),
    markdown: process.argv.includes('--markdown'),
  };
}

// Mirrors how the app resolves it (desktop/main.js:5132 sets MINERADIO_PV_CACHE_DIR to
// cacheSettings.rootPath + '/pvs'), with the userData fallback the cache settings also use.
function resolveCacheDir(explicit) {
  const tried = [];
  const userData = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Mineradio')
    : path.join(os.homedir(), '.config', 'Mineradio');
  if (explicit) { tried.push(explicit); }
  if (process.env.MINERADIO_PV_CACHE_DIR) { tried.push(process.env.MINERADIO_PV_CACHE_DIR); }
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(userData, 'cache-settings.json'), 'utf8'));
    if (settings && settings.rootPath) { tried.push(path.join(settings.rootPath, 'pvs')); }
  } catch (_) { /* no settings file yet - fall through */ }
  tried.push(path.join(userData, 'cache', 'pvs'));
  for (const dir of tried) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch (_) { /* not there */ }
  }
  throw Object.assign(new Error(`PV cache not found; tried ${tried.join(' , ')}`), { code: 'PV_BENCH_NO_CACHE' });
}

function listArchives(cacheDir, limit) {
  return fs.readdirSync(cacheDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ n, size: fs.statSync(path.join(cacheDir, n)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, Math.max(1, limit))
    .map((r) => path.join(cacheDir, r.n));
}

const PAGE_SWEEP = String.raw`async function () {
  const plan = window.__plan;
  const J = window.J;
  if (!J || typeof J.Renderer !== 'function') return { error: 'NO_ENGINE' };
  if (!plan) return { error: 'NO_PLAN' };
  const cssW = %CSSW%, cssH = %CSSH%, forceDpr = %DPR%;
  const dpr = forceDpr || Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const planW = Math.max(1, plan.W || 1920), planH = Math.max(1, plan.H || 1080);
  const contain = Math.min(cssW / planW, cssH / planH);
  const dispW = Math.max(2, Math.round(planW * contain));
  const dispH = Math.max(2, Math.round(planH * contain));
  const w = Math.max(2, Math.round(dispW * dpr));
  const h = Math.max(2, Math.round(dispH * dpr));
  const canvas = document.getElementById('pv-bench-canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const scale = w / planW;
  const warmH = Math.min(Math.max(2, Math.round(planH * scale)), 240);
  const warmCanvas = document.createElement('canvas');
  warmCanvas.width = w; warmCanvas.height = warmH;
  const warmCtx = warmCanvas.getContext('2d');
  const bleedCanvas = document.createElement('canvas');
  bleedCanvas.width = Math.max(16, Math.round((cssW * dpr) / 8));
  bleedCanvas.height = Math.max(16, Math.round((cssH * dpr) / 8));
  const bleedCtx = bleedCanvas.getContext('2d');

  const cuts = plan.cuts || [];
  const cutAt = (t) => {
    let lo = 0, hi = cuts.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cuts[mid].start <= t) lo = mid + 1; else hi = mid; }
    return cuts[lo - 1] || cuts[0];
  };
  const times = [];
  const span = Math.max(1, plan.duration || 200);
  for (let i = 0; i < %SAMPLES%; i++) times.push((i + 0.5) * span / %SAMPLES%);

  const renderer = new J.Renderer();
  const runners = {
    full: (t) => renderer.frame(ctx, plan, t, { scale }),
    fast: (t) => renderer.frame(ctx, plan, t, { scale, fast: true }),
    noGhost: (t) => renderer.frame(ctx, plan, t, { scale, noGhost: true }),
    noPost: (t) => renderer.frame(ctx, plan, t, { scale, noPost: true }),
    noTrans: (t) => renderer.frame(ctx, plan, t, { scale, noTrans: true }),
    noHud: (t) => renderer.frame(ctx, plan, t, { scale, noHud: true }),
    fastNoTrans: (t) => renderer.frame(ctx, plan, t, { scale, fast: true, noTrans: true }),
    fastNoGhost: (t) => renderer.frame(ctx, plan, t, { scale, fast: true, noGhost: true }),
    cheap: (t) => renderer.frame(ctx, plan, t, { scale, fast: true, noGhost: true, noTrans: true }),
    warm: (t) => renderer.frame(warmCtx, plan, t, { scale, noGhost: true, noPost: true, noHud: true }),
    bleed: () => {
      bleedCtx.setTransform(1, 0, 0, 1, 0, 0);
      bleedCtx.globalAlpha = 1;
      bleedCtx.globalCompositeOperation = 'source-over';
      bleedCtx.clearRect(0, 0, bleedCanvas.width, bleedCanvas.height);
      bleedCtx.drawImage(canvas, 0, 0, bleedCanvas.width, bleedCanvas.height);
      bleedCtx.fillStyle = 'rgba(0,0,0,0.45)';
      bleedCtx.fillRect(0, 0, bleedCanvas.width, bleedCanvas.height);
    },
  };

  const pct = (arr, p) => {
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  };
  const round2 = (x) => Math.round(x * 100) / 100;
  const stats = (ms, trans, plain) => ({
    n: ms.length,
    mean: round2(ms.reduce((x, y) => x + y, 0) / ms.length),
    p50: round2(pct(ms, 50)),
    p95: round2(pct(ms, 95)),
    p99: round2(pct(ms, 99)),
    max: round2(Math.max.apply(null, ms)),
    overFrame: ms.filter((x) => x > %FRAME_BUDGET%).length,
    overKoma: ms.filter((x) => x > %KOMA_BUDGET%).length,
    transitionN: trans.length,
    transitionMean: trans.length ? round2(trans.reduce((x, y) => x + y, 0) / trans.length) : null,
    plainMean: plain.length ? round2(plain.reduce((x, y) => x + y, 0) / plain.length) : null,
  });

  const results = {};
  // Untimed warm-up. The engine is interpreted, then hot-pathed by TurboFan, and the first sweep
  // of a session pays for that: measured without it, the same phase varied 9.15ms / 5.68ms between
  // two runs at the same size. Warming on a few frames is what makes the table comparable.
  const warmup = new J.Renderer();
  for (let i = 0; i < 8; i++) warmup.frame(ctx, plan, times[i % times.length], { scale });

  // A fresh Renderer has an empty glyph cache, which is what the first song of a session pays.
  const coldRenderer = new J.Renderer();
  const coldMs = [];
  for (const t of times) {
    const s = performance.now();
    coldRenderer.frame(ctx, plan, t, { scale });
    coldMs.push(performance.now() - s);
  }
  results.cold = stats(coldMs, [], []);

  for (const phase of %PHASES%) {
    const run = runners[phase];
    if (!run) { results[phase] = { error: 'UNKNOWN_PHASE' }; continue; }
    const ms = [];
    const trans = [];
    const plain = [];
    // A later phase runs on a heap the earlier ones dirtied, so the first time through the list is
    // discarded and only the second pass is reported.
    for (let pass = 0; pass < 2; pass++) {
      if (pass) { ms.length = 0; trans.length = 0; plain.length = 0; }
      for (const t of times) {
        const cut = cutAt(t);
        const inTrans = !!(cut && cut.trans && cut.trans !== 'cut' && (t - cut.start) < (cut.transDur || 0.28));
        const s = performance.now();
        run(t);
        const d = performance.now() - s;
        ms.push(d);
        (inTrans ? trans : plain).push(d);
      }
    }
    results[phase] = stats(ms, trans, plain);
  }
  return {
    ok: true,
    box: { cssW, cssH, dpr, canvasW: w, canvasH: h, pixels: w * h, warmH, bleedW: bleedCanvas.width, bleedH: bleedCanvas.height },
    plan: { cuts: cuts.length, lines: (plan.lines || []).length, events: (plan.events || []).length, duration: plan.duration, design: plan.W + 'x' + plan.H },
    results,
  };
}`;

function pageHtml() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>pv draw bench</title></head>'
    + '<body style="margin:0;background:#000"><canvas id="pv-bench-canvas"></canvas>'
    + '<script src="engine.js"></script></body></html>';
}

function prepareScratchDir(appRoot) {
  const dir = path.join(os.tmpdir(), 'mineradio-pv-draw-bench');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(appRoot, 'vendor', 'jizura', 'jizura-engine.js'), path.join(dir, 'engine.js'));
  fs.writeFileSync(path.join(dir, 'bench.html'), pageHtml(), 'utf8');
  return dir;
}

function readArchivePlan(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const plan = raw && raw.plan ? raw.plan : raw;
  if (!plan || !Array.isArray(plan.cuts) || !plan.cuts.length) {
    throw Object.assign(new Error(`no plan.cuts in ${file}`), { code: 'PV_BENCH_BAD_ARCHIVE' });
  }
  return { plan, label: path.basename(file), json: JSON.stringify(plan) };
}

function toMarkdown(rows) {
  const lines = [];
  for (const row of rows) {
    if (!row.ok) { lines.push(`\n${row.label}: ${row.error || 'failed'}`); continue; }
    lines.push(`\n### ${row.label} — ${row.box.cssW}x${row.box.cssH} @ dpr ${row.box.dpr} → 画布 ${row.box.canvasW}x${row.box.canvasH} (${(row.box.pixels / 1e6).toFixed(2)} Mpx)`);
    lines.push(`方案：${row.plan.cuts} 镜头 / ${row.plan.lines} 行 / ${row.plan.events} 事件 / ${row.plan.duration.toFixed(0)}s / 设计 ${row.plan.design}`);
    lines.push('');
    lines.push('| 选项 | 均值 ms | p50 | p95 | p99 | max | >16.7ms | >83.3ms | 转场帧均值 | 普通帧均值 | 相对 full |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const base = row.results.full && row.results.full.mean ? row.results.full.mean : null;
    for (const key of Object.keys(row.results)) {
      const s = row.results[key];
      if (s.error) { lines.push(`| ${key} | ${s.error} | | | | | | | | | |`); continue; }
      const saving = base ? `${Math.round((1 - s.mean / base) * 100)}%` : '—';
      lines.push(`| ${key} | ${s.mean} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} | ${s.overFrame}/${s.n} | ${s.overKoma}/${s.n} | ${s.transitionMean === null ? '—' : s.transitionMean} | ${s.plainMean === null ? '—' : s.plainMean} | ${key === 'full' ? '—' : saving} |`);
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
  const scratch = prepareScratchDir(appRoot);
  const outFile = args.out ? path.resolve(args.out) : path.join(scratch, args.markdown ? 'result.md' : 'result.jsonl');
  fs.writeFileSync(outFile, '', 'utf8');
  const files = args.plan
    ? [path.resolve(args.plan)]
    : listArchives(resolveCacheDir(args.cache), args.limit);
  const { app, BrowserWindow } = require('electron');
  for (const [name, value] of [['autoplay-policy', 'no-user-gesture-required'], ['use-angle', 'd3d11']]) {
    app.commandLine.appendSwitch(name, value);
  }
  for (const name of ['enable-gpu-rasterization', 'enable-oop-rasterization', 'enable-zero-copy',
    'disable-renderer-backgrounding', 'disable-background-timer-throttling',
    'disable-backgrounding-occluded-windows']) {
    app.commandLine.appendSwitch(name);
  }
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { backgroundThrottling: false, sandbox: false },
  });
  await win.loadFile(path.join(scratch, 'bench.html'));
  const rows = [];
  for (const file of files) {
    const entry = readArchivePlan(file);
    await win.webContents.executeJavaScript(`window.__plan = ${entry.json}; true;`, true);
    for (const [cssW, cssH] of args.sizes) {
      for (const dpr of args.dprs) {
        const script = PAGE_SWEEP
          .replace(/%CSSW%/g, String(cssW))
          .replace(/%CSSH%/g, String(cssH))
          .replace(/%DPR%/g, String(dpr))
          .replace(/%SAMPLES%/g, String(args.samples))
          .replace(/%FRAME_BUDGET%/g, String(FRAME_BUDGET_MS))
          .replace(/%KOMA_BUDGET%/g, String(KOMA_BUDGET_MS))
          .replace(/%PHASES%/g, JSON.stringify(args.phases));
        let res;
        try {
          res = await win.webContents.executeJavaScript(`(${script})()`, true);
        } catch (err) {
          res = { error: String((err && err.message) || err) };
        }
        rows.push({ ...res, label: entry.label });
        if (!args.markdown) emit(outFile, JSON.stringify({ label: entry.label, ...res }) + '\n');
      }
    }
  }
  win.destroy();
  if (args.markdown) emit(outFile, toMarkdown(rows) + '\n');
  emit(outFile, `\npv-draw-bench: ${rows.length} sweeps, ${rows.filter((r) => !r.ok).length} failed -> ${outFile}\n`);
  app.exit(rows.some((r) => !r.ok) ? 1 : 0);
}

// Electron loads the entry file with require.main set to its own 'electron' module, so the usual
// `require.main === module` guard never fires there: the app would start and sit idle forever.
const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly || require.main === module) {
  main().catch((err) => {
    const text = `pv-draw-bench failed: ${String((err && err.stack) || err)}\n`;
    try {
      const dir = path.join(os.tmpdir(), 'mineradio-pv-draw-bench');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'result.log'), text);
    } catch (_) { /* nothing else to try */ }
    try { process.stderr.write(text); } catch (_) { /* as above */ }
    process.exit(1);
  });
}

module.exports = { PV_ENGINE_KNOBS, parseArgs, resolveCacheDir, toMarkdown };
