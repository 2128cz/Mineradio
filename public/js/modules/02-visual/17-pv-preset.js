'use strict';

// PV preset (index 13): draws the JIZURA frame for the current song into #pv-layer.
//
// Shape follows your decisions: the plan is real-time drawn (gate: p95 < 25ms and <= 12x the
// same-round floor), koma=12 means one new drawing every 83ms, and the plan itself comes from
// the archive the queue prefetch already stores - so playback only reads and draws.
//
// The engine is loaded on first use only, into this process (a second engine in a hidden window
// would mean shipping every frame across a boundary). It is injected as a script element once:
// the bundle declares one top-level `const J`, so a second injection would throw.
//
// Everything the layer owns is released when the preset is not active: the renderer (its
// offscreen canvases are the expensive part, ~40MB at 1080p), the plan, and the canvas
// backing store - which is zeroed, because a detached canvas keeps its memory otherwise.

var PV_PRESET_INDEX = 13;   // tracks MAX_VISUAL_PRESET_INDEX (three places; quick-check pins them)
var PV_TARGET_FPS = 12;     // koma: 12 drawings per second, matching how the plan was built
var PV_PLAN_RETRY_MS = 5000;
// The bleed canvas is this box / 8 and CSS stretches it back, so the upscale itself is the blur.
var PV_BLEED_DIVISOR = 8;
var PV_BLEED_DIM = 0.45;          // black laid over the small canvas so the bars stay a surround
// Glyph decomposition is the 100-340ms spike at cut entry (it rasterises each new character and
// reads it back). Warm it ahead of the playhead, but only out of measured slack: a third of the
// koma window is left over after a frame that cost less than PV_WARM_BUDGET_MS, and a warm frame
// is far cheaper than a real one because its canvas is only PV_WARM_MAX_HEIGHT tall.
var PV_WARM_BUDGET_MS = Math.round(1000 / PV_TARGET_FPS / 3);
var PV_WARM_EVERY_DRAWS = 2;
var PV_WARM_KOMA_PER_CUT = 3;
var PV_WARM_MAX_HEIGHT = 240;     // buckets follow env.scale, which only depends on the width

// Draw tiers, decided by the measurements in docs/pv-perf-baseline.md and not by the canvas size:
// cost there tracks glyphs and events (0.69Mpx 5.73ms vs 3.50Mpx 7.44ms), so pixels are a weak
// signal. 效果档 is what the layer has always sent. 性能档 adds the two options that flattened the
// frame-time tail at 3.50Mpx - mean 7.44 -> 1.82ms, p95 16.6 -> 6.2ms, transition frames
// 11.74 -> 1.93ms - against a 16.7ms budget. noGhost and noPost also measure well but take the
// chroma depth and the whole post chain, so they stay out of the tier until the numbers say a
// tier needs them.
var PV_TIER_BUILDERS = {
  full: function (scale) { return { scale: scale }; },
  lean: function (scale) { return { scale: scale, fast: true, noTrans: true }; },
};

// 自动 resolves to a concrete tier decided by pvAutoDrawTier() below; the manual tiers answer for
// themselves and switch the auto machinery off entirely.
function pvDrawMode() {
  return typeof normalizePvDrawQuality === 'function'
    ? normalizePvDrawQuality(fx && fx.pvDrawQuality)
    : 'auto';
}

function pvDrawTier() {
  var mode = pvDrawMode();
  if (mode === 'full' || mode === 'lean') {
    // Choosing a tier by hand is also the user rejecting what 自动 decided, so the automatic
    // decision is dropped here instead of waiting in reserve for the next time 自动 is selected.
    if (pvPresetState.autoTier !== 'full' || pvPresetState.autoPending) pvAutoReset('a manual tier was chosen');
    return mode;
  }
  return pvAutoDrawTier();
}

function pvTierOptions(tier, scale) {
  var build = PV_TIER_BUILDERS[tier] || PV_TIER_BUILDERS.full;
  return build(scale);
}

var pvPresetState = {
  active: false,
  engineReady: false,
  engineError: '',
  enginePromise: null,
  planPromise: null,
  planRetryAt: 0,
  renderer: null,
  plan: null,
  planKey: '',
  planSongKey: '',
  planError: '',
  draws: 0,
  skips: 0,
  released: 0,
  lastDrawAt: 0,
  lastCostMs: 0,
  lastT: 0,
  tier: 'full',
  autoTier: 'full',
  autoPending: '',
  autoCosts: [],
  autoBadStreak: 0,
  autoWindows: 0,
  autoLastOver: 0,
  autoChanges: 0,
  autoSwitchAt: 0,
  autoBlocked: '',
  autoLog: '',
  cutIndex: -1,
  fitMode: '',
  fitCrop: 0,
  bleedActive: false,
  warmCanvas: null,
  warmIndex: 0,
  warmScale: 0,
  warmSteps: 0,
  drawsSinceWarm: 0,
  prefetchFollowing: false,
};

// The 自动 tier decides from measured draw cost alone. Canvas size is deliberately not an input:
// docs/pv-perf-baseline.md measured 5.73ms at 0.69Mpx against 7.44ms at 3.50Mpx, so the work is
// per glyph and per event, and a rule that read the resolution would cut the picture in front of a
// machine that was never short of time (docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md 第二边界).
var PV_AUTO_WINDOW_DRAWS = 24;        // two seconds of komas at PV_TARGET_FPS
var PV_AUTO_BUDGET_MS = 1000 / 60;    // a draw over this blew the frame it ran in
var PV_AUTO_ENTER_OVER = 14;          // 14 of 24 blown is "the layer is not keeping up"
var PV_AUTO_ENTER_WINDOWS = 3;        // and it has to hold for three windows, which is what 持续 means
var PV_AUTO_SEEK_BACK_S = 2;          // a rewind this large is a fresh listening pass: re-judge

function pvAutoDrawTier() {
  return pvPresetState.autoTier;
}

function pvAutoLog(fromTier, toTier, why) {
  var line = '[PvDrawTier] ' + fromTier + ' -> ' + toTier + ': ' + why;
  pvPresetState.autoLog = line;
  if (typeof console !== 'undefined' && console && typeof console.info === 'function') console.info(line);
  if (typeof window !== 'undefined' && window && window.__mineradioPerf &&
      typeof window.__mineradioPerf.count === 'function') {
    window.__mineradioPerf.count('pv.draw.tier.' + toTier);
  }
}

// A new plan, a rewind, or a released layer is new evidence: the decision belongs to one song's
// content density, so it starts again from the full picture instead of carrying over. A plan that
// proved it cannot draw 性能档 is not new evidence - that stays blocked until the plan changes.
function pvAutoReset(reason) {
  var s = pvPresetState;
  var from = s.autoTier;
  s.autoTier = 'full';
  s.autoPending = '';
  s.autoCosts.length = 0;
  s.autoBadStreak = 0;
  s.autoWindows = 0;
  s.autoLastOver = 0;
  s.cutIndex = -1;
  if (reason && from !== 'full') pvAutoLog(from, 'full', 'reset (' + reason + ')');
}

// A different song's content can draw fine even if the last one could not, so the block is the one
// thing a rewind does not clear.
function pvAutoNewPlan(reason) {
  pvPresetState.autoBlocked = '';
  pvAutoReset(reason);
}

// A tier the engine cannot draw is not a tier: go back to the full picture and stop 自动 trying for
// the rest of this plan, so one broken cut cannot make the layer oscillate.
function pvAutoGiveUp(why) {
  var s = pvPresetState;
  if (s.autoBlocked) return;
  s.autoBlocked = why;
  s.autoTier = 'full';
  s.autoPending = '';
  s.autoCosts.length = 0;
  pvAutoLog('lean', 'full', 'auto disabled: ' + why);
}

// plan.cuts is sorted (the archive contract in pv-archive.js pins it), so the playhead's cut is a
// binary search. A cut with no usable end is treated as one second long, the same stand-in the warm
// pass uses.
function pvCutStart(cut) { return Number(cut && cut.start) || 0; }
function pvCutEnd(cut) {
  var end = Number(cut && cut.end);
  return isFinite(end) && end > 0 ? end : pvCutStart(cut) + 1;
}
function pvCutIndexAt(cuts, t) {
  var lo = 0;
  var hi = cuts.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var cut = cuts[mid];
    if (t < pvCutStart(cut)) hi = mid - 1;
    else if (t >= pvCutEnd(cut)) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// Called before every real draw: keeps the cut cursor, and lands a pending decision on the first
// koma of a new cut - never partway through one, because 性能档 changes what a transition looks like
// and half of each would be the flash the doctrine forbids.
function pvAutoBoundary(t, now) {
  var s = pvPresetState;
  if (s.lastT && (s.lastT - t) > PV_AUTO_SEEK_BACK_S + (1 / PV_TARGET_FPS)) {
    pvAutoReset('rewound to ' + (Math.round(t * 10) / 10) + 's');
  }
  var cuts = s.plan && Array.isArray(s.plan.cuts) ? s.plan.cuts : null;
  var index = cuts && cuts.length ? pvCutIndexAt(cuts, t) : -1;
  var boundary = index >= 0 && index !== s.cutIndex;
  if (index >= 0) s.cutIndex = index;
  if (boundary && s.autoPending) {
    var from = s.autoTier;
    s.autoTier = s.autoPending;
    s.autoPending = '';
    s.autoBadStreak = 0;
    s.autoChanges += 1;
    s.autoSwitchAt = now;
    pvAutoLog(from, s.autoTier,
      s.autoLastOver + '/' + PV_AUTO_WINDOW_DRAWS + ' draws over ' + (Math.round(PV_AUTO_BUDGET_MS * 10) / 10) +
      'ms, held for ' + PV_AUTO_ENTER_WINDOWS + ' windows (cut ' + index + ')');
  }
  return boundary;
}

// One real draw cost, sampled per window. Sticky by design: while 性能档 is on, a cheap frame only
// proves the downgrade is working, and the only way to learn whether full quality fits again is to
// pay for the frames it would drop - so recovery is the next plan, or the user picking 效果档.
function pvAutoObserve(cost) {
  var s = pvPresetState;
  if (pvDrawMode() !== 'auto' || s.autoBlocked || s.autoTier !== 'full' || s.autoPending) {
    s.autoCosts.length = 0;
    return;
  }
  s.autoCosts.push(cost);
  if (s.autoCosts.length < PV_AUTO_WINDOW_DRAWS) return;
  var over = 0;
  for (var i = 0; i < s.autoCosts.length; i++) {
    if (s.autoCosts[i] > PV_AUTO_BUDGET_MS) over += 1;
  }
  s.autoCosts.length = 0;
  s.autoWindows += 1;
  s.autoLastOver = over;
  if (over < PV_AUTO_ENTER_OVER) {
    s.autoBadStreak = 0;
    return;
  }
  s.autoBadStreak += 1;
  if (s.autoBadStreak >= PV_AUTO_ENTER_WINDOWS) s.autoPending = 'lean';
}

function pvPresetIsActive() {
  return typeof fx !== 'undefined' && fx && Number(fx.preset) === PV_PRESET_INDEX;
}

function pvLayerElement() { return document.getElementById('pv-layer'); }
function pvCanvasElement() { return document.getElementById('pv-canvas'); }
function pvBleedElement() { return document.getElementById('pv-bleed'); }

// The playing song is derived from the queue, the way the rest of the app derives it
// (05-playback/00-api-quality-output.js:230, 10-queue-actions.js:73) - there is no
// "currentSong" global to read.
function pvCurrentSong() {
  if (Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length) return playQueue[currentIdx];
  return null;
}

// One-shot engine load. Restarting the app is the only way to unload it, which is fine: it is
// 2.1MB of code and it is shared by every song for as long as PV is used at all.
function pvEnsureEngine() {
  if (window.J && typeof window.J.Renderer === 'function') {
    pvPresetState.engineReady = true;
    return Promise.resolve(window.J);
  }
  if (pvPresetState.enginePromise) return pvPresetState.enginePromise;
  pvPresetState.enginePromise = fetch('/pv-engine.js', { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('PV_ENGINE_HTTP_' + res.status);
      return res.text();
    })
    .then(function (text) {
      if (typeof text !== 'string' || text.indexOf('J.Renderer') < 0) throw new Error('PV_ENGINE_TEXT_INVALID');
      var el = document.createElement('script');
      el.setAttribute('data-pv-engine', '1');
      el.textContent = text;
      document.head.appendChild(el);
      var J = window.J;
      if (!J || typeof J.Renderer !== 'function' || typeof J.cutAt !== 'function') throw new Error('PV_ENGINE_NOT_READY');
      pvPresetState.engineReady = true;
      pvPresetState.engineError = '';
      return J;
    })
    .catch(function (err) {
      pvPresetState.enginePromise = null;
      pvPresetState.engineError = String((err && err.message) || err);
      return null;
    });
  return pvPresetState.enginePromise;
}

// Ask for the archive (hit or freshly planned) and keep its plan in memory. The plan request
// deliberately ignores the prefetch switch: this is the render layer needing it now.
// Explicit entry point for tests and for any future caller that already holds the song and its
// lines. Taking them as arguments keeps a fixture out of playQueue/currentIdx, which are app
// state: the prefetch and this module both persist derived state, and a probe must not.
function pvPlanForSong(song, lines, translationLines, opts) {
  opts = opts || {};
  if (!song || !Array.isArray(lines) || !lines.length) return Promise.resolve({ ok: false, reason: 'no-plan-payload' });
  if (typeof pvEnsurePlanNow !== 'function') return Promise.resolve({ ok: false, reason: 'no-plan-client' });
  return pvApplyPlan(song, lines, translationLines || [], opts).then(function (ok) {
    return ok ? { ok: true, planKey: pvPresetState.planKey, cuts: pvPresetState.plan ? pvPresetState.plan.cuts.length : null } : { ok: false, reason: pvPresetState.planError || 'plan-failed' };
  });
}

function pvApplyPlan(song, lines, translationLines, opts) {
  opts = opts || {};
  var songKey = typeof pvSongKeyFor === 'function' ? pvSongKeyFor(song) : '';
  if (!songKey) { pvPresetState.planError = 'no-song-key'; return Promise.resolve(false); }
  pvPresetState.planPromise = pvEnsurePlanNow(song, lines, translationLines)
    .then(function (res) {
      if (!res || !res.ok) throw new Error('PV_PLAN_' + ((res && res.reason) || 'failed'));
      return fetch('/api/pv/archive?key=' + encodeURIComponent(res.key), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.ok || !data.archive || !data.archive.plan) throw new Error('PV_ARCHIVE_UNREADABLE');
          return pvEnsureEngine().then(function (J) {
            if (!J) throw new Error('PV_ENGINE_' + (pvPresetState.engineError || 'unavailable'));
            pvPresetState.plan = data.archive.plan;
            // a new plan means new characters: start the warm pass over
            pvPresetState.warmIndex = 0;
            pvPresetState.warmScale = 0;
            pvPresetState.drawsSinceWarm = 0;
            // and new evidence for 自动, which is why the downgrade never carries into the next song
            pvAutoNewPlan('plan ' + res.key);
            pvPresetState.planKey = res.key;
            pvPresetState.planSongKey = songKey;
            pvPresetState.renderer = typeof J.Renderer === 'function' ? new J.Renderer() : null;
            pvPresetState.planError = '';
            pvPresetState.planRetryAt = 0;
            var canvas = pvCanvasElement();
            if (canvas && pvPresetState.renderer && !opts.skipFirstFrame) pvDrawLayerFrame(canvas, typeof performance !== 'undefined' ? performance.now() : Date.now());
            return !!pvPresetState.renderer;
          });
        });
    })
    .catch(function (err) {
      pvPresetState.planError = String((err && err.message) || err);
      pvPresetState.planRetryAt = Date.now() + PV_PLAN_RETRY_MS;
      return false;
    })
    .then(function (ok) {
      pvPresetState.planPromise = null;
      return ok;
    });
  return pvPresetState.planPromise;
}

function pvEnsurePlan(force) {
  var song = pvCurrentSong();
  if (!song) { pvPresetState.planError = 'no-song'; return Promise.resolve(false); }
  var songKey = typeof pvSongKeyFor === 'function' ? pvSongKeyFor(song) : '';
  var lines = typeof lyricsLines !== 'undefined' ? lyricsLines : null;
  if (!songKey) { pvPresetState.planError = 'no-song-key'; return Promise.resolve(false); }
  if (!Array.isArray(lines) || !lines.length) { pvPresetState.planError = 'no-lyrics'; return Promise.resolve(false); }
  if (!force && pvPresetState.plan && pvPresetState.planSongKey === songKey) return Promise.resolve(true);
  if (pvPresetState.planPromise) return pvPresetState.planPromise;
  // A failed attempt must not re-plan on every frame; retry on the window, or immediately when
  // the song changed (a new song has its own archive).
  if (!force && pvPresetState.planError && Date.now() < pvPresetState.planRetryAt && pvPresetState.planSongKey === songKey) {
    return Promise.resolve(false);
  }
  var translationLines = typeof lyricsTranslationLines !== 'undefined' ? lyricsTranslationLines : [];
  return pvApplyPlan(song, lines, translationLines, {});
}

// The playhead the layer draws at, behind a function so a probe can override the clock instead
// of assigning the audio element: replacing that global is how one probe leaked its fixture into
// the app's persisted playback snapshot (09-queue-snapshot-autoplay.js writes localStorage every
// couple of seconds while a song is current).
function pvPlayheadSeconds() {
  if (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) return Math.max(0, audio.currentTime);
  return 0;
}

// Beyond this linear crop per side, covering the viewport would eat too much of the composition
// and the layer falls back to contain (bars) instead. 0.15 is set from the measured worst case:
// a window sitting exactly between two of the engine's aspects (the widest pair gap is 1:1↔4:3
// and 3:4↔9:16 at ln 0.288) needs a 0.134 total crop, so every reachable shape still covers, and
// the overflow never exceeds ~6.7% of a frame edge.
var PV_MAX_COVER_CROP = 0.15;

// Contain-fit or cover-fit, decided per frame from the layer box: cover keeps the whole screen
// painted (decor running past the edges, which is the point of the layer), and the crop it needs
// is small because the plan was already chosen for this window shape.
function pvFitForBox(planW, planH, cssW, cssH) {
  var contain = Math.min(cssW / planW, cssH / planH);
  var cover = Math.max(cssW / planW, cssH / planH);
  var crop = Math.max(1 - cssW / (planW * cover), 1 - cssH / (planH * cover));
  if (crop > PV_MAX_COVER_CROP) return { scale: contain, mode: 'contain', crop: crop };
  return { scale: cover, mode: 'cover', crop: crop };
}

function pvDrawLayerFrame(canvas, now) {
  var plan = pvPresetState.plan;
  var renderer = pvPresetState.renderer;
  if (!plan || !renderer) return false;
  var t = pvPlayheadSeconds();
  var layer = pvLayerElement();
  var cssW = (layer && layer.clientWidth) || canvas.clientWidth || 0;
  var cssH = (layer && layer.clientHeight) || canvas.clientHeight || 0;
  if (cssW < 2 || cssH < 2) return false;
  var planW = Math.max(1, plan.W || 1920);
  var planH = Math.max(1, plan.H || 1080);
  // The engine anchors a frame at (0,0) of whichever canvas it is handed, so the canvas is sized
  // to the design at the chosen scale and the layer centres it: contain leaves symmetric bars,
  // cover lets the composition run off the edges. Either way the canvas covers every pixel the
  // viewer should see, and nothing is left transparent to show through as noise.
  var fit = pvFitForBox(planW, planH, cssW, cssH);
  var dispW = Math.max(2, Math.round(planW * fit.scale));
  var dispH = Math.max(2, Math.round(planH * fit.scale));
  var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  var w = Math.max(2, Math.round(dispW * dpr));
  var h = Math.max(2, Math.round(dispH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = dispW + 'px';
    canvas.style.height = dispH + 'px';
  }
  pvPresetState.fitMode = fit.mode;
  pvPresetState.fitCrop = Math.round(fit.crop * 1000) / 1000;
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;
  var started = performance.now();
  pvAutoBoundary(t, started);
  var tier = pvDrawTier();
  try {
    renderer.frame(ctx, plan, t, pvTierOptions(tier, w / planW));
  } catch (err) {
    // One bad frame must not wedge the layer: report, drop the renderer, and let the retry
    // window rebuild it rather than throwing every frame.
    pvPresetState.planError = 'draw:' + String((err && err.message) || err);
    pvPresetState.renderer = null;
    pvPresetState.planRetryAt = Date.now() + PV_PLAN_RETRY_MS;
    if (tier === 'lean' && pvDrawMode() === 'auto') pvAutoGiveUp(pvPresetState.planError);
    return false;
  }
  var cost = Math.round((performance.now() - started) * 100) / 100;
  pvPresetState.draws += 1;
  pvPresetState.tier = tier;
  pvPresetState.lastDrawAt = now;
  pvPresetState.lastCostMs = cost;
  pvPresetState.lastT = t;
  pvAutoObserve(cost);
  pvDrawBleedFrame(canvas, cssW, cssH, dispW, dispH, dpr);
  return true;
}

// A viewport wider than any aspect the engine composes (32:9 tops out past 21:9) cannot be covered
// without cropping the lyric line - measured at 5120x1440, covering clips glyphs in 59 of 60
// frames - so the bars stay geometrically, and this fills them with the frame's own edge instead
// of black. The source is downsampled by PV_BLEED_DIVISOR and CSS stretches it back, which is
// what does the blurring; the dim is baked into the small canvas so no filter runs over 7.4Mpx.
function pvDrawBleedFrame(source, cssW, cssH, dispW, dispH, dpr) {
  var bleed = pvBleedElement();
  if (!bleed) return;
  var bars = dispW < cssW - 2 || dispH < cssH - 2;
  if (!bars) {
    if (bleed.width !== 2 || bleed.height !== 2) { bleed.width = 2; bleed.height = 2; }
    if (pvPresetState.bleedActive) { bleed.classList.remove('on'); pvPresetState.bleedActive = false; }
    return;
  }
  var w = Math.max(16, Math.round((cssW * dpr) / PV_BLEED_DIVISOR));
  var h = Math.max(16, Math.round((cssH * dpr) / PV_BLEED_DIVISOR));
  if (bleed.width !== w || bleed.height !== h) { bleed.width = w; bleed.height = h; }
  var bctx = bleed.getContext('2d');
  if (!bctx) return;
  try {
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalAlpha = 1;
    bctx.globalCompositeOperation = 'source-over';
    bctx.clearRect(0, 0, w, h);
    bctx.drawImage(source, 0, 0, w, h);
    bctx.fillStyle = 'rgba(0,0,0,' + PV_BLEED_DIM + ')';
    bctx.fillRect(0, 0, w, h);
  } catch (_) { return; }
  if (!pvPresetState.bleedActive) { bleed.classList.add('on'); pvPresetState.bleedActive = true; }
}

// The spike is not the drawing, it is the first time a character is seen: decompose rasterises
// the glyph, reads it back and splits it into strokes. Walk the plan ahead of the playhead so
// that work happens while a frame still has slack. The cache key follows size * env.scale, so
// the warm canvas only has to match the width; keeping it short is what makes the step cheap.
function pvWarmNextKoma() {
  var plan = pvPresetState.plan;
  var renderer = pvPresetState.renderer;
  var canvas = pvCanvasElement();
  if (!plan || !renderer || !canvas || !canvas.width) return false;
  var cuts = Array.isArray(plan.cuts) ? plan.cuts : null;
  if (!cuts || !cuts.length) return false;
  var planW = Math.max(1, plan.W || 1920);
  var planH = Math.max(1, plan.H || 1080);
  var scale = canvas.width / planW;
  if (!pvPresetState.warmScale || Math.abs(scale - pvPresetState.warmScale) / pvPresetState.warmScale > 0.05) {
    // different buckets than the ones already decomposed - start the pass again
    pvPresetState.warmScale = scale;
    pvPresetState.warmIndex = 0;
  }
  var total = cuts.length * PV_WARM_KOMA_PER_CUT;
  if (pvPresetState.warmIndex >= total) return false;
  var cv = pvPresetState.warmCanvas;
  if (!cv) { cv = pvPresetState.warmCanvas = document.createElement('canvas'); }
  var w = Math.max(2, Math.round(planW * scale));
  var h = Math.min(Math.max(2, Math.round(planH * scale)), PV_WARM_MAX_HEIGHT);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  var ctx = cv.getContext('2d');
  if (!ctx) return false;
  var cut = cuts[Math.floor(pvPresetState.warmIndex / PV_WARM_KOMA_PER_CUT)];
  if (!cut) { pvPresetState.warmIndex = total; return false; }
  var slot = pvPresetState.warmIndex % PV_WARM_KOMA_PER_CUT;
  var dur = Math.max(0.1, (cut.end || cut.start + 1) - cut.start);
  var offsets = [0.02, 0.22, Math.min(0.6, dur * 0.4)];
  var t = cut.start + offsets[slot];
  try {
    renderer.frame(ctx, plan, t, { scale: scale, noGhost: true, noPost: true, noHud: true });
  } catch (_) {
    // Warming is opportunistic: if a sample throws, stop the pass rather than wedge the layer.
    pvPresetState.warmIndex = total;
    return false;
  }
  pvPresetState.warmIndex += 1;
  pvPresetState.warmSteps += 1;
  return true;
}

function pvReleasePvLayer() {
  var canvas = pvCanvasElement();
  if (canvas) {
    // A canvas keeps its backing store while detached, so zeroing the size is the release.
    canvas.width = 2;
    canvas.height = 2;
    canvas.style.width = '';
    canvas.style.height = '';
    var ctx = canvas.getContext('2d');
    if (ctx) { try { ctx.clearRect(0, 0, 2, 2); } catch (_) {} }
  }
  var bleed = pvBleedElement();
  if (bleed) {
    bleed.width = 2;
    bleed.height = 2;
    bleed.classList.remove('on');
  }
  pvPresetState.bleedActive = false;
  pvPresetState.warmCanvas = null;
  pvPresetState.warmIndex = 0;
  pvPresetState.warmScale = 0;
  pvPresetState.drawsSinceWarm = 0;
  pvAutoReset();
  var layer = pvLayerElement();
  if (layer) layer.classList.remove('active');
  pvPresetState.active = false;
  pvPresetState.renderer = null;
  pvPresetState.plan = null;
  pvPresetState.planKey = '';
  pvPresetState.planSongKey = '';
  pvPresetState.released += 1;
}

function pvPresetStatus() {
  return {
    index: PV_PRESET_INDEX,
    active: pvPresetState.active,
    layerPresent: !!pvLayerElement(),
    canvas: (function () { var c = pvCanvasElement(); return c ? { w: c.width, h: c.height } : null; })(),
    engineReady: pvPresetState.engineReady,
    engineError: pvPresetState.engineError,
    hasJ: typeof window.J !== 'undefined' && !!window.J,
    planKey: pvPresetState.planKey,
    planSongKey: pvPresetState.planSongKey,
    planError: pvPresetState.planError,
    hasRenderer: !!pvPresetState.renderer,
    hasPlan: !!pvPresetState.plan,
    cuts: pvPresetState.plan && Array.isArray(pvPresetState.plan.cuts) ? pvPresetState.plan.cuts.length : null,
    draws: pvPresetState.draws,
    skips: pvPresetState.skips,
    released: pvPresetState.released,
    lastT: pvPresetState.lastT,
    lastCostMs: pvPresetState.lastCostMs,
    tierSetting: typeof normalizePvDrawQuality === 'function' ? normalizePvDrawQuality(fx && fx.pvDrawQuality) : 'auto',
    tier: pvPresetState.tier,
    tierNow: pvDrawTier(),
    auto: {
      tier: pvPresetState.autoTier,
      pending: pvPresetState.autoPending,
      blocked: pvPresetState.autoBlocked,
      badStreak: pvPresetState.autoBadStreak,
      windows: pvPresetState.autoWindows,
      lastOver: pvPresetState.autoLastOver,
      windowDraws: PV_AUTO_WINDOW_DRAWS,
      budgetMs: Math.round(PV_AUTO_BUDGET_MS * 10) / 10,
      changes: pvPresetState.autoChanges,
      switchAt: pvPresetState.autoSwitchAt,
      cutIndex: pvPresetState.cutIndex,
      log: pvPresetState.autoLog,
    },
    fitMode: pvPresetState.fitMode,
    fitCrop: pvPresetState.fitCrop,
    bleed: (function () { var b = pvBleedElement(); return b ? { w: b.width, h: b.height, on: pvPresetState.bleedActive } : null; })(),
    warm: { index: pvPresetState.warmIndex, steps: pvPresetState.warmSteps, scale: Math.round(pvPresetState.warmScale * 1000) / 1000 },
  };
}

// Called from the main loop every frame (cheap when the preset is not selected).
function updatePvLayer(now, dt) {
  var active = pvPresetIsActive();
  if (typeof setPvPrefetchEnabled === 'function' && pvPresetState.prefetchFollowing !== active) {
    // The prefetch follows the preset: while PV is on, the next songs get planned; when it is
    // off there is nothing to prefetch for.
    pvPresetState.prefetchFollowing = active;
    setPvPrefetchEnabled(active);
  }
  if (!active) {
    if (pvPresetState.active || pvPresetState.plan || pvPresetState.renderer) pvReleasePvLayer();
    return false;
  }
  pvPresetState.active = true;
  var layer = pvLayerElement();
  if (layer && layer.className.indexOf('active') < 0) layer.classList.add('active');
  pvEnsurePlan(false);
  if (!pvPresetState.plan || !pvPresetState.renderer) return false;
  var canvas = pvCanvasElement();
  if (!canvas) return false;
  var gate = window.__mineradioMainFrameGates && window.__mineradioMainFrameGates.pv;
  var step = gate && typeof consumeFrameGate === 'function'
    ? consumeFrameGate(gate, now, dt, PV_TARGET_FPS, false, 'pv-layer')
    : Math.max(0, Number(dt) || 0);
  if (step <= 0) { pvPresetState.skips += 1; return false; }
  var drew = pvDrawLayerFrame(canvas, now);
  // Spend only measured slack on warming: one step every PV_WARM_EVERY_DRAWS delivered frames,
  // and never right after a frame that already used most of the koma window.
  if (drew) pvPresetState.drawsSinceWarm += 1;
  if (drew && pvPresetState.drawsSinceWarm >= PV_WARM_EVERY_DRAWS && pvPresetState.lastCostMs <= PV_WARM_BUDGET_MS) {
    pvPresetState.drawsSinceWarm = 0;
    pvWarmNextKoma();
  }
  return drew;
}

// Switching the preset must take effect immediately, not on the next frame: with nothing playing
// the main loop parks, so a frame-driven-only switch leaves the layer and the takeover stale
// until something else wakes it (the same trap the takeover mask hit).
function applyPvPresetNow() {
  try { updatePvLayer(typeof performance !== 'undefined' ? performance.now() : Date.now(), 16); } catch (_) {}
  if (typeof applyVisualTakeoverNow === 'function') applyVisualTakeoverNow();
  return pvPresetStatus();
}

// A preset that replaces the scene has to say so: the mask suppresses these eight layers while
// it is active, and releasing it (switching to any other preset) brings them back untouched.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'pv-layer',
    isActive: pvPresetIsActive,
    suppresses: {
      particles: true,
      bloom: true,
      float: true,
      backCover: true,
      starRiver: true,
      ripples: true,
      lyricsParticles: true,
      stageLyrics: true,
    },
  });
}