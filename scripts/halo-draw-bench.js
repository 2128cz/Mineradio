'use strict';

// HALO (preset 14) draw-cost bench. Measures one delivered frame of the shipped ring module
// under each drawing part, so the 性能档 profile is decided on numbers instead of guesses.
// Read-only: it loads the shipped module into a throwaway window, feeds it a synthetic song
// (lyrics, beat map, spectrum) and changes nothing in the app.
//
//   node_modules/electron/dist/electron.exe scripts/halo-draw-bench.js
//   node_modules/electron/dist/electron.exe scripts/halo-draw-bench.js --sizes=1920x1080 --samples=40
//
// The ring draws at CSS pixels (HALO_RENDER_SCALE, no devicePixelRatio), so the canvas size is
// the only size input; dpr is not a factor here the way it is for the PV engine.
//
// Run-to-run spread on the same machine is ~10-20% and cross-machine differences are large, so
// this reports a table for the SAME scene before/after - which is what
// docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md asks for instead of absolute numbers from one box.
//
// The comparison is only fair if every row draws the same picture. The ring's content is
// driven by the clock (beats spawn comets, flares and shots), so a row measured later in the
// run would be drawing a busier scene than a row measured earlier. Every phase therefore gets
// a fresh page - a fresh module, a fresh clock at zero and the same warm-up - and the phase
// order is rotated between rounds so a slow minute lands on all rows alike.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_SIZES = ['1920x1080', '1280x720'];
const DEFAULT_SAMPLES = 30;          // frames measured per phase per round
const DEFAULT_ROUNDS = 4;            // rounds; every phase is measured in every round
const DEFAULT_WARMUP = 30;           // frames before the measurement starts (same for every phase)
const DEFAULT_RAF_FRAMES = 90;       // animation frames in the rAF probe
const HALO_FPS = 30;
const FRAME_BUDGET_MS = 1000 / HALO_FPS;   // the ring's own frame period, not the display's

// The parts of one frame. Each row neutralises one drawing function by replacing the global the
// shipped module calls, so the row is the marginal cost of that part - the shipped code is not
// edited, and the two tier rows (full / lean) go through the shipped tier instead.
const HALO_PARTS = [
  { name: 'haze', fn: 'haloDrawHaze', kills: 'the haze bands (the radial fog around the rim)' },
  { name: 'flares', fn: 'haloDrawFlares', kills: 'the root flares' },
  { name: 'comets', fn: 'haloDrawComets', kills: 'the comet bundles that sweep in on a beat' },
  { name: 'emits', fn: 'haloDrawEmits', kills: 'the shots fired by a click' },
  { name: 'flyers', fn: 'haloDrawFlyers', kills: 'the fly-out streaks' },
  { name: 'strands', fn: 'haloDrawStrands', kills: 'the five strand layers (the spectrum beams)' },
  { name: 'web', fn: 'haloDrawWeb', kills: 'the baked inner web' },
  { name: 'ring', fn: 'haloDrawRing', kills: 'the ring band and its ticks' },
  { name: 'lyric', fn: 'haloDrawLyricText', kills: 'the lyric text' },
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
  const samples = Number(get('samples') || DEFAULT_SAMPLES);
  if (!isFinite(samples) || samples < 1) throw new Error(`bad --samples`);
  const rounds = Number(get('rounds') || DEFAULT_ROUNDS);
  if (!isFinite(rounds) || rounds < 1) throw new Error(`bad --rounds`);
  const warmup = Number(get('warmup') || DEFAULT_WARMUP);
  if (!isFinite(warmup) || warmup < 1) throw new Error(`bad --warmup`);
  const rafFrames = Number(get('rafFrames') || DEFAULT_RAF_FRAMES);
  if (!isFinite(rafFrames) || rafFrames < 0) throw new Error(`bad --rafFrames`);
  const only = get('phases');
  return {
    sizes, samples, rounds, warmup, rafFrames,
    only: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null,
    markdown: argv.includes('--markdown'),
    probeVariants: argv.includes('--probeVariants'),
    out: get('out'),
  };
}

// The page the ring runs in. The stubs are the app globals the module reads; the module itself
// is the shipped file, copied next to the page, so the bench measures what ships.
const PAGE_SETUP = `
  window.fx = { preset: 14, lyricScale: 1, pvDrawQuality: 'full' };
  window.playQueue = [{ id: 'bench-song', name: 'bench' }];
  window.currentIdx = 0;
  window.lyricsLines = [];
  window.lyricsTranslationLines = [];
  window.currentBeatMap = { beats: [] };
  window.sonicAudioMonitorState = { frame: null };
  window.lyricTimingSongKey = function () { return 'bench-song'; };
  window.getActiveLyricTimingOffsetSeconds = function () { return 0; };
  window.haloTuning = null;
  // The tier setting is the app's, so the bench brings the same normaliser the app has.
  window.normalizePvDrawQuality = function (v) { return v === 'full' || v === 'lean' ? v : 'auto'; };
`;

// One phase, measured on a freshly loaded page. Everything the phase sees - the scene, the
// clock, the warm-up - is identical to every other phase's, so the only difference between the
// rows is the drawing.
const PAGE_RUN = String.raw`async function (opts) {
  const canvas = document.getElementById('halo-canvas');
  const layer = document.getElementById('halo-layer');
  if (!canvas || !layer) return { ok: false, error: 'no canvas' };
  if (typeof window.haloResize !== 'function') return { ok: false, error: 'the module has no haloResize()' };

  // A synthetic song: 24 lines four seconds apart, a beat every 0.5s, and a spectrum that
  // breathes. Without them the ring draws an idle picture and the numbers mean nothing.
  const lines = [];
  for (let i = 0; i < 24; i++) {
    lines.push({ t: i * 4, text: '第 ' + (i + 1) + ' 行歌词 the quick brown fox jumps over' });
  }
  window.lyricsLines = lines;
  window.lyricsTranslationLines = [];
  const beats = [];
  for (let t = 0; t < 120; t += 0.5) beats.push(t);
  window.currentBeatMap = { beats: beats };
  window.sonicAudioMonitorState = { frame: { subBass: 0.2, bass: 0.4, lowMid: 0.5, mid: 0.6, highMid: 0.5, presence: 0.4, brilliance: 0.3, air: 0.2, energy: 0.4, kickEnvelope: 0.2, kickOnset: 0 } };

  // The clock is a function so the bench can move it; the module reads the same one.
  let clock = 0;
  window.haloPlayheadSeconds = function () { return clock; };

  // A render scale is the one lever that changes the number of pixels the ring draws, so it
  // is applied before the ring is built: the canvas backing store and every drawing are
  // scaled together, exactly as the module's own HALO_FULL_SCALE does it.
  if (opts.renderScale) {
    window.HALO_FULL_SCALE = opts.renderScale;
    window.haloTierScale = opts.renderScale;
  }

  // The ring is built here, not by the app: the web, the slots, the strands and the gradients
  // all come from haloResize(), which reads the layer's box.
  if (!window.haloResize()) return { ok: false, error: 'haloResize() refused' };
  window.haloBuildLyricRing();
  // The GPU backend is what the app uses, so the bench keeps it: the draw calls are recorded
  // and rasterised later, and the readback forces that rasterisation to happen inside the
  // measured window.
  const ctx2d = canvas.getContext('2d');

  const dt = 1 / 30;
  const jsAll = [];
  const drawFrame = function () {
    clock += dt;
    window.sonicAudioMonitorState.frame.energy = 0.3 + 0.2 * Math.sin(clock * 2);
    window.sonicAudioMonitorState.frame.kickEnvelope = Math.max(0, 0.4 - ((clock % 0.5) * 2));
    window.haloRenderFrame(canvas, performance.now(), dt);
    // What the shipped module measures for itself: the JS time around the draw calls. On a
    // GPU canvas that is the command recording, not the rasterisation, so the tier machine
    // only ever sees what the app itself would see.
    if (window.haloPresetState && typeof window.haloPresetState.lastCostMs === 'number') {
      jsAll.push(window.haloPresetState.lastCostMs);
    }
  };

  // The phase: the tier goes through the shipped tier machine, a part is neutralised by
  // replacing the global the module calls.
  window.fx.pvDrawQuality = opts.tier;
  if (opts.patch === 'all') {
    for (const fn of opts.parts) window[fn] = function () {};
    window.haloDrawStrandTips = function () {};
  } else if (opts.patch === 'decor') {
    for (const fn of opts.decorParts) window[fn] = function () {};
  } else if (opts.patch && opts.patch.indexOf('only:') === 0) {
    // Only one part is left standing: what it costs alone is what it brings into the frame.
    const keep = opts.patch.slice(5);
    for (const fn of opts.parts) if (fn !== keep) window[fn] = function () {};
    window.haloDrawStrandTips = function () {};
  } else if (opts.patch) {
    window[opts.patch] = function () {};
  }

  // Warm up: the first frames build the web, the slots, the strands and the gradients, and
  // the GPU compiles and uploads them. Every phase gets the same warm-up, so none of them
  // pays for what the others paid.
  for (let i = 0; i < opts.warmup; i++) drawFrame();
  ctx2d.getImageData(0, 0, 1, 1);

  // The cost of one frame is not the time around the draw calls: the canvas records them and
  // rasterises later, and the readback that forces the rasterisation waits for a frame
  // boundary, which costs the same whatever was drawn.
  //
  // So every frame is measured on its own: first a readback with nothing new to rasterise
  // (the baseline: the wait and the transfer), then the draw plus the same readback. The
  // difference is what the drawing itself cost. Measuring frame by frame instead of in
  // batches keeps the batch size from turning into a bias - a batch of K frames lets the
  // canvas drop the frames in between, which is why an earlier batch-slope estimator could
  // report the cheaper picture as the more expensive one.
  const readback = function () {
    const t0 = performance.now();
    ctx2d.getImageData(0, 0, 1, 1);
    return performance.now() - t0;
  };
  const costs = [];
  for (let i = 0; i < opts.samples; i++) {
    const base = readback();
    drawFrame();
    const withDraw = readback();
    costs.push(withDraw - base);
  }

  // The probe the app itself can do: draw the frame the way the app draws it - one frame per
  // animation frame, no readback, nothing forcing the rasterisation - and watch the interval
  // between the animation frames. If the ring is too heavy for the machine, the compositor
  // cannot keep up and the interval stretches; if the ring is cheap, the interval stays at
  // the display's. The same run without the drawing is the control.
  //
  // The wait is bounded twice over. A window bigger than the screen is treated as occluded,
  // the compositor stops producing frames for it, and requestAnimationFrame then never fires -
  // so a probe that has not seen its first frame after two seconds is not going to see one,
  // and a probe that has all its frames is done. Without the bounds the bench would wait for
  // a frame that is never coming, once per phase, for minutes.
  const rafProbe = function (draw) {
    return new Promise(function (resolve) {
      const ts = [];
      let n = 0;
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        clearTimeout(firstFrame);
        clearTimeout(overall);
        resolve(ts);
      };
      const firstFrame = setTimeout(finish, 2000);
      const overall = setTimeout(finish, 15000);
      const step = function (t) {
        ts.push(t);
        if (draw) drawFrame();
        n += 1;
        if (n < opts.rafFrames) requestAnimationFrame(step);
        else finish();
      };
      requestAnimationFrame(step);
    });
  };
  const intervals = function (ts) {
    const out = [];
    for (let i = 1; i < ts.length; i++) out.push(ts[i] - ts[i - 1]);
    out.sort(function (a, b) { return a - b; });
    return out;
  };
  let raf = null;
  if (opts.rafFrames > 3) {
    const rafDraw = intervals(await rafProbe(true));
    const rafIdle = intervals(await rafProbe(false));
    raf = { draw: rafDraw, idle: rafIdle };
  }

  // The probe the app itself uses to decide. It measures the frame the app draws, on the
  // canvas that is on screen, so the bench asks for it and then draws the frames it needs.
  //
  // It is asked once: asking again right after makes the reading climb (the frames pile up
  // behind the readbacks), and the first ask is the one the app would ever see - the app
  // asks once, after three bad windows, with the frames 33ms apart. The raw samples are
  // reported next to the median, because the spread is the honest answer to "how much does
  // one measurement say".
  let probe = -1;
  let probeSamples = [];
  if (typeof window.haloAutoProbe === 'function') {
    window.haloAutoProbe();
    for (let j = 0; j < 10; j++) drawFrame();
    probe = window.haloPresetState ? window.haloPresetState.probeCost : -1;
    probeSamples = (window.haloPresetState && window.haloPresetState.probeSamples) || [];
  }

  // What the probe is measuring: the same question asked of different canvases and different
  // clocks. The bench's own number is the reference. Off by default: it is a one-off
  // experiment that answers "where may the probe be asked", not a cost measurement.
  let probeVariants = {};
  if (opts.probeVariants) {
    probeVariants = (function () {
      const out = {};
      const measure = function (label, target, draw) {
        try {
          const c = target.getContext('2d');
          if (!c) { out[label] = -1; return; }
          const rb = function () {
            const t0 = performance.now();
            c.getImageData(0, 0, 1, 1);
            return performance.now() - t0;
          };
          const costs = [];
          // One warm-up round first: a canvas nobody has read back yet pays a one-time cost on
          // its first readback, and that cost would land in the baseline and make the drawing
          // look cheaper than it is.
          draw(c); rb();
          for (let i = 0; i < 3; i++) {
            const base = rb();
            draw(c);
            const withDraw = rb();
            costs.push(withDraw - base);
          }
          costs.sort(function (a, b) { return a - b; });
          out[label] = Math.round(costs[1] * 100) / 100;
          // The page's console is forwarded to the bench's output, so a variant that never
          // finishes says which one it was.
          console.log('[probeVariant] ' + label + ' ' + out[label]);
        } catch (err) {
          out[label] = -1;
        }
      };
      const throwaway = function (visible) {
        const p = document.createElement('canvas');
        p.width = canvas.width;
        p.height = canvas.height;
        p.style.position = 'absolute';
        p.style.left = '0';
        p.style.top = '0';
        p.style.pointerEvents = 'none';
        if (!visible) p.style.opacity = '0';
        layer.appendChild(p);
        return p;
      };
      // The canvas the bench draws on, with the app's real frame.
      measure('live-real', canvas, function () { window.haloRenderFrame(canvas, performance.now(), 1 / 30); });
      // The same canvas, but the probe's frame: nothing moves.
      measure('live-dt0', canvas, function () { window.haloDrawFrame(ctx2d, 0); });
      // Does reading the live canvas back cost it its acceleration? Fifty readbacks, then the
      // same measurement again: if the canvas had fallen back to the CPU, this would be slower.
      for (let i = 0; i < 50; i++) ctx2d.getImageData(0, 0, 1, 1);
      measure('live-after-readback', canvas, function () { window.haloRenderFrame(canvas, performance.now(), 1 / 30); });
      // A throwaway canvas, hidden and visible, with the probe's frame.
      const hidden = throwaway(false);
      measure('throw-hidden', hidden, function (c) { window.haloDrawFrame(c, 0); });
      const visible = throwaway(true);
      measure('throw-visible', visible, function (c) { window.haloDrawFrame(c, 0); });
      // A throwaway canvas, detached from the page.
      const detached = document.createElement('canvas');
      detached.width = canvas.width;
      detached.height = canvas.height;
      measure('throw-detached', detached, function (c) { window.haloDrawFrame(c, 0); });
      if (hidden.parentNode) hidden.parentNode.removeChild(hidden);
      if (visible.parentNode) visible.parentNode.removeChild(visible);
      return out;
    })();
  }

  return {
    ok: true,
    costs: costs,
    js: jsAll.slice(-opts.samples),
    raf: raf,
    probe: probe,
    probeSamples: probeSamples,
    probeVariants: probeVariants,
    tier: window.haloPresetState ? window.haloPresetState.tier : '',
    box: { cssW: opts.cssW, cssH: opts.cssH, canvasW: canvas.width, canvasH: canvas.height, layerW: layer.clientWidth, layerH: layer.clientHeight, ready: !!window.haloState.ready },
  };
}`;

function pageHtml() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>halo draw bench</title>'
    + '<style>html,body{margin:0;padding:0;background:#000;overflow:hidden;height:100%}'
    + '#halo-layer{position:absolute;left:0;top:0;right:0;bottom:0}'
    + '#halo-canvas{position:absolute;left:0;display:block}</style>'
    + '</head><body><div id="halo-layer"><canvas id="halo-canvas"></canvas></div>'
    + '<script>' + PAGE_SETUP + '</script>'
    + '<script src="halo.js"></script>'
    + '</body></html>';
}

function prepareScratchDir(appRoot) {
  const dir = path.join(os.tmpdir(), 'mineradio-halo-draw-bench');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js'),
    path.join(dir, 'halo.js'));
  fs.writeFileSync(path.join(dir, 'bench.html'), pageHtml(), 'utf8');
  return dir;
}

function toMarkdown(rows) {
  const lines = [];
  for (const row of rows) {
    if (!row.ok) { lines.push(`\n${row.label}: ${row.error || 'failed'}`); continue; }
    lines.push(`\n### ${row.label} — ${row.box.cssW}x${row.box.cssH}`);
    lines.push('');
    lines.push(`| 方案 | 实际档位 | 画布 | 中位 ms | 均值 ms | p95 | 最小 | >${Math.round(FRAME_BUDGET_MS * 10) / 10}ms | 相对 full(中位) | 模块自测 JS 中位 | JS p95 | 探针 ms | 探针样本 |`);
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const base = row.results.full && row.results.full.p50 ? row.results.full.p50 : null;
    for (const key of Object.keys(row.results)) {
      const s = row.results[key];
      if (!s || s.error) { lines.push(`| ${key} | ${(s && s.error) || '—'} | | | | | | | | | | |`); continue; }
      const saving = base ? `${Math.round((1 - s.p50 / base) * 100)}%` : '—';
      const px = s.canvasW ? `${s.canvasW}x${s.canvasH}` : '—';
      lines.push(`| ${key} | ${s.tier || '—'} | ${px} | ${s.p50} | ${s.mean} | ${s.p95} | ${s.min} | ${s.over}/${s.n} | ${key === 'full' ? '—' : saving} | ${s.js ? s.js.p50 : '—'} | ${s.js ? s.js.p95 : '—'} | ${s.probe >= 0 ? s.probe : '—'} | ${(s.probeSamples || []).join(' / ') || '—'} |`);
    }
    if (row.probeVariants) {
      const labels = Object.keys(row.probeVariants.full || {});
      if (labels.length) {
        lines.push('');
        lines.push('| 方案 | ' + labels.join(' | ') + ' |');
        lines.push('| --- | ' + labels.map(() => '---').join(' | ') + ' |');
        for (const key of Object.keys(row.results)) {
          const v = row.probeVariants[key];
          if (!v) continue;
          lines.push(`| ${key} | ` + labels.map((l) => (v[l] === undefined ? '—' : v[l])).join(' | ') + ' |');
        }
      }
    }
  }
  return lines.join('\n');
}

function emit(file, text) {
  fs.appendFileSync(file, text);
  try { process.stdout.write(text); } catch (_) { /* GUI binary: the pipe may not be there */ }
}

function stat(costs) {
  const sorted = costs.slice().sort(function (a, b) { return a - b; });
  const at = function (q) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]; };
  const mean = sorted.reduce(function (a, b) { return a + b; }, 0) / sorted.length;
  return {
    mean: Math.round(mean * 100) / 100,
    p50: Math.round(at(0.5) * 100) / 100,
    p95: Math.round(at(0.95) * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
  };
}

// The phases the bench measures. The tier rows go through the shipped tier machine; the
// part rows neutralise one drawing function each.
function phaseList() {
  const phases = [{ name: 'full', tier: 'full', patch: null }];
  phases.push({ name: 'lean', tier: 'lean', patch: null });
  // The decoration the lean profile drops, stubbed directly: if this row and the lean row
  // disagree, the tier is not reaching the drawing.
  phases.push({ name: 'no-decor', tier: 'full', patch: 'decor' });
  for (const part of HALO_PARTS) phases.push({ name: 'no-' + part.name, tier: 'full', patch: part.fn });
  // Only one part is left standing: what it costs alone is what it brings into the frame.
  // The rows that remove a part but keep the rest answer a different question (what a part
  // adds on top of the others); these answer what each part costs by itself.
  for (const part of HALO_PARTS) phases.push({ name: 'only-' + part.name, tier: 'full', patch: 'only:' + part.fn });
  // The render scale: the one lever that changes how many pixels the ring draws.
  phases.push({ name: 'scale-075', tier: 'full', patch: null, renderScale: 0.75 });
  phases.push({ name: 'scale-050', tier: 'full', patch: null, renderScale: 0.5 });
  phases.push({ name: 'none', tier: 'full', patch: 'all' });
  return phases;
}

const DECOR_PARTS = ['haloDrawHaze', 'haloDrawFlares', 'haloDrawComets', 'haloDrawEmits', 'haloDrawFlyers'];

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
  for (const name of ['enable-gpu-rasterization', 'enable-oop-rasterization', 'enable-zero-copy',
    'disable-renderer-backgrounding', 'disable-background-timer-throttling',
    'disable-backgrounding-occluded-windows']) {
    app.commandLine.appendSwitch(name);
  }
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    webPreferences: { backgroundThrottling: false, sandbox: false },
  });
  // The page's console is the bench's only way to see where a long run is, so it is forwarded.
  win.webContents.on('console-message', function (event, level, message) {
    // Electron changed the signature: the message is the second argument on the old one and
    // the third on the new one.
    const text = (typeof message === 'string') ? message : (event && event.message) || '';
    if (String(text).indexOf('[probeVariant]') === 0) console.log(String(text));
  });

  const rows = [];
  for (const [cssW, cssH] of args.sizes) {
    win.setContentSize(cssW, cssH);
    let phases = phaseList();
    if (args.only) {
      phases = phases.filter((p) => args.only.indexOf(p.name) >= 0);
      if (!phases.length) {
        const row = { label: 'halo', ok: false, error: 'no phase matched --phases' };
        rows.push(row);
        if (args.markdown) emit(outFile, toMarkdown([row]) + '\n');
        else emit(outFile, JSON.stringify(row) + '\n');
        continue;
      }
    }
    const costs = {};
    const jsCosts = {};
    const rafCosts = {};
    const rafIdleCosts = {};
    const tiers = {};
    const probes = {};
    const probeSamples = {};
    const probeVariants = {};
    const phaseBoxes = {};
    let box = null;
    let failure = '';
    for (let r = 0; r < args.rounds && !failure; r++) {
      // The phase order is rotated every round: the first phase of a round would otherwise
      // always carry the round's setup cost, which is a bias, not a property of the phase.
      const order = phases.slice(r % phases.length).concat(phases.slice(0, r % phases.length));
      for (const phase of order) {
        // A fresh page per phase: the module, its state and the clock all start over, so every
        // phase draws the same picture and only the drawing differs.
        await win.loadFile(pagePath);
        const opts = {
          cssW, cssH,
          tier: phase.tier,
          patch: phase.patch,
          renderScale: phase.renderScale || null,
          parts: HALO_PARTS.map((p) => p.fn),
          decorParts: DECOR_PARTS,
          warmup: args.warmup,
          samples: args.samples,
          rafFrames: args.rafFrames,
          probeVariants: args.probeVariants,
        };
        let res;
        try {
          res = await win.webContents.executeJavaScript(`(${PAGE_RUN})(${JSON.stringify(opts)})`, true);
        } catch (err) {
          res = { ok: false, error: String((err && err.message) || err) };
        }
        if (!res || !res.ok) { failure = (res && res.error) || 'failed'; break; }
        box = res.box;
        if (!costs[phase.name]) {
          costs[phase.name] = []; jsCosts[phase.name] = []; rafCosts[phase.name] = []; rafIdleCosts[phase.name] = [];
        }
        for (const c of res.costs) costs[phase.name].push(c);
        for (const v of res.js) jsCosts[phase.name].push(v);
        for (const v of (res.raf && res.raf.draw) || []) rafCosts[phase.name].push(v);
        for (const v of (res.raf && res.raf.idle) || []) rafIdleCosts[phase.name].push(v);
        // The tier the page believes it is in: a phase that asked for 'lean' but reports 'full'
        // did not take effect, and its numbers must not be read as the lean path's cost.
        tiers[phase.name] = res.tier || '';
        probes[phase.name] = res.probe === undefined ? -1 : res.probe;
        probeSamples[phase.name] = res.probeSamples || [];
        probeVariants[phase.name] = res.probeVariants || {};
        // The canvas the phase drew on: a phase at a smaller scale has a smaller canvas, and the
        // report has to say which one a row was measured on.
        phaseBoxes[phase.name] = res.box || null;
      }
    }
    if (failure) {
      const row = { label: 'halo', ok: false, error: failure };
      rows.push(row);
      if (args.markdown) emit(outFile, toMarkdown([row]) + '\n');
      else emit(outFile, JSON.stringify(row) + '\n');
      continue;
    }
    const results = {};
    for (const phase of phases) {
      const s = stat(costs[phase.name]);
      s.over = costs[phase.name].filter((c) => c > FRAME_BUDGET_MS).length;
      s.n = costs[phase.name].length;
      s.js = stat(jsCosts[phase.name]);
      s.tier = tiers[phase.name] || '';
      s.probe = probes[phase.name] === undefined ? -1 : probes[phase.name];
      s.probeSamples = probeSamples[phase.name] || [];
      s.raf = rafCosts[phase.name].length ? stat(rafCosts[phase.name]) : null;
      s.rafIdle = rafIdleCosts[phase.name].length ? stat(rafIdleCosts[phase.name]) : null;
      const pb = phaseBoxes[phase.name];
      s.canvasW = pb ? pb.canvasW : 0;
      s.canvasH = pb ? pb.canvasH : 0;
      results[phase.name] = s;
    }
    const row = { label: 'halo', ok: true, box, results, probeVariants };
    rows.push(row);
    // Flush each completed size before starting the next one.
    if (args.markdown) emit(outFile, toMarkdown([row]) + '\n');
    else emit(outFile, JSON.stringify(row) + '\n');
  }
  win.destroy();
  emit(outFile, `\nhalo-draw-bench: ${rows.length} sweeps, ${rows.filter((r) => !r.ok).length} failed -> ${outFile}\n`);
  app.exit(rows.some((r) => !r.ok) ? 1 : 0);
}

// Electron loads the entry file with require.main set to its own 'electron' module, so the usual
// `require.main === module` guard never fires there: the app would start and sit idle forever.
const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) {
  main().catch((err) => {
    emit(path.join(os.tmpdir(), 'mineradio-halo-draw-bench', 'result.jsonl'), 'halo-draw-bench failed: ' + String((err && err.stack) || err) + '\n');
    process.exitCode = 1;
  });
}
