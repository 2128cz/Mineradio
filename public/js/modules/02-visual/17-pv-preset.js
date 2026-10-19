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
  prefetchFollowing: false,
};

function pvPresetIsActive() {
  return typeof fx !== 'undefined' && fx && Number(fx.preset) === PV_PRESET_INDEX;
}

function pvLayerElement() { return document.getElementById('pv-layer'); }
function pvCanvasElement() { return document.getElementById('pv-canvas'); }

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
  if (typeof pvEnsurePlanNow !== 'function') { pvPresetState.planError = 'no-plan-client'; return Promise.resolve(false); }
  var translationLines = typeof lyricsTranslationLines !== 'undefined' ? lyricsTranslationLines : [];
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
            pvPresetState.planKey = res.key;
            pvPresetState.planSongKey = songKey;
            pvPresetState.renderer = typeof J.Renderer === 'function' ? new J.Renderer() : null;
            pvPresetState.planError = '';
            pvPresetState.planRetryAt = 0;
            // Draw the first frame as soon as the plan is in: waiting for the next loop tick
            // would leave the layer black for a frame budget, and would never happen at all
            // while the loop is parked (no playback).
            var canvas = pvCanvasElement();
            if (canvas && pvPresetState.renderer) pvDrawLayerFrame(canvas, typeof performance !== 'undefined' ? performance.now() : Date.now());
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

function pvDrawLayerFrame(canvas, now) {
  var plan = pvPresetState.plan;
  var renderer = pvPresetState.renderer;
  if (!plan || !renderer) return false;
  var t = typeof audio !== 'undefined' && audio && isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
  var cssW = canvas.clientWidth || 0;
  var cssH = canvas.clientHeight || 0;
  var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  var w = Math.max(2, Math.round((cssW || 1280) * dpr));
  var h = Math.max(2, Math.round((cssH || 720) * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;
  var scale = w / Math.max(1, plan.W || 1920);
  var started = performance.now();
  try {
    renderer.frame(ctx, plan, t, { scale: scale });
  } catch (err) {
    // One bad frame must not wedge the layer: report, drop the renderer, and let the retry
    // window rebuild it rather than throwing every frame.
    pvPresetState.planError = 'draw:' + String((err && err.message) || err);
    pvPresetState.renderer = null;
    pvPresetState.planRetryAt = Date.now() + PV_PLAN_RETRY_MS;
    return false;
  }
  pvPresetState.draws += 1;
  pvPresetState.lastDrawAt = now;
  pvPresetState.lastCostMs = Math.round((performance.now() - started) * 100) / 100;
  pvPresetState.lastT = t;
  return true;
}

function pvReleasePvLayer() {
  var canvas = pvCanvasElement();
  if (canvas) {
    // A canvas keeps its backing store while detached, so zeroing the size is the release.
    canvas.width = 2;
    canvas.height = 2;
    var ctx = canvas.getContext('2d');
    if (ctx) { try { ctx.clearRect(0, 0, 2, 2); } catch (_) {} }
  }
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
  return pvDrawLayerFrame(canvas, now);
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