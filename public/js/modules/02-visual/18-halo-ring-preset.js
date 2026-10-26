'use strict';

// HALO ring (preset 14): the lyric dial.
// Licence of the ported elements: MIT, Copyright (c) 2026 RYDER CODE / Ms MAIKEBAIs CAT;
// the full text ships as 18-halo-ring-preset.LICENSE.txt next to this file.
//
// Ported from HALOFLUX's lab.html by element, not by engine (docs/PLAN_HALO_RING.md §2).
// What came across: the ring band with its data panels, the baked inner web, the outer
// radial beams, the fly-out streaks, the haze bands and the root flares. What did not:
// the 56-parameter console, the right-hand panels, the synthetic beat clock (PATTERN),
// the separate glow buffer, and the bokeh/atmosphere/vignette/ring-shadow/depth-blur
// layers - the beat and the spectrum come from Mineradio, and the author's own final
// defaults (BAKED_MINE) have those four layers off.
//
// Three deliberate departures from the original, all in docs/PLAN_HALO_RING.md §0.2:
//   - the dial is centred; the original pins it to the left edge (cx = W * 0.07), which
//     puts half the circumference - and therefore half the lyrics - off screen.
//   - the lyric lines ride the inner rim, so the current line can be read at the top.
//   - the glow composite is replaced by wide 'lighter' strokes on the single canvas,
//     so the layer costs one rasterization pass instead of two plus a blur.
//
// The ring turns with the lyrics rather than at random: the rotation target is derived
// from the line's own start time, and the turn begins HALO_ROT_LEAD seconds before the
// line is sung, so the line lands on the read mark exactly when it starts.

var HALO_PRESET_INDEX = 14;        // tracks MAX_VISUAL_PRESET_INDEX (four places)
var HALO_FPS = 30;                 // the layer's own frame gate
var HALO_RENDER_SCALE = 1;         // internal resolution multiplier; devicePixelRatio is NOT used
var HALO_RADIUS_K = 0.34;          // ring radius as a fraction of min(width, height)
var HALO_BAND_K = 0.155;           // ring band thickness as a fraction of the radius
var HALO_WEB_CURVES = 320;         // baked inner web curves (the original bakes 2600)
var HALO_RUNNER_COUNT = 96;        // travelling streaks on the web (the original: 336..788)
var HALO_STRAND_DENSITY = 0.4;     // multiplier on the original wedge density
var HALO_SLOT_MIN_PX = 16;         // ring data panel heights
var HALO_SLOT_MAX_PX = 62;
var HALO_LYRIC_FONT_PX = 15;       // lyric text size on the dial
var HALO_LYRIC_GAP_PX = 30;        // clear space between two lyric arcs
var HALO_READ_ANGLE = -Math.PI / 2;// the top of the dial: where the current line is read
var HALO_ROT_LEAD = 0.55;          // the ring starts turning this long before the line is sung
var HALO_ROT_DUR = 0.55;           // how long that turn takes
var HALO_PREPARE_MS = 300;         // beat phase 1: prepare what lands on the beat
var HALO_TRAVEL_FAST = 0.08;       // beam flight time (lands on the beat)
var HALO_TRAVEL_SLOW = 0.25;       // converging bundle flight time
var HALO_BEAT_LOOKAHEAD = 0.45;    // how far ahead the beat map is read
var HALO_PANEL_REFRESH_MIN = 3;    // panels refreshed on a beat
var HALO_PANEL_REFRESH_MAX = 8;

var HALO_TAU = Math.PI * 2;
var HALO_FONT = '"JetBrains Mono","Microsoft YaHei",Consolas,monospace';

var haloPresetState = {
  active: false,
  layerPresent: false,
  released: 0,
  draws: 0,
  skips: 0,
  lastCostMs: 0,
  lastT: 0,
  frames: 0,
  costSamples: [],
  engineError: ''
};

var haloState = {
  ready: false,
  w: 0,
  h: 0,
  cx: 0,
  cy: 0,
  R: 1,
  RO: 2,
  band: 1,
  RMAX: 1,
  dpr: 1,
  time: 0,
  ringRot: 0,
  webRot: 0,
  idleSpin: 0
};

var haloCam = { x: 0, y: 0, z: 1 };
var haloCamMove = null;            // {fromX, fromY, fromZ, toX, toY, toZ, startAt, endAt}
var haloCamTarget = null;

var haloSlotList = [];
var haloWeb = null;                // baked inner web canvas
var haloWebCurves = [];
var haloRunnerList = [];
var haloCometList = [];
var haloStrandLayers = [];
var haloFlyerList = [];
var haloFlyBands = [];
var haloHazeList = [];
var haloFlareList = [];
var haloGradient = {};

var haloLyric = {
  items: [],
  current: -1,
  pending: -1,
  rot: 0,
  tween: null,
  baseAngle: 0,
  songKey: ''
};

var haloBeat = {
  list: [],
  idx: 0,
  events: [],
  lastOnsetAt: -1,
  source: 'none',
  count: 0
};

var haloAudio = {
  bands: [0, 0, 0, 0, 0, 0, 0, 0],
  level: 0,
  bass: 0,
  mid: 0,
  high: 0,
  kick: 0,
  buffer: null,
  analyser: null
};

function haloPresetIsActive() {
  return typeof fx !== 'undefined' && fx && Number(fx.preset) === HALO_PRESET_INDEX;
}

function haloLayerElement() { return document.getElementById('halo-layer'); }
function haloCanvasElement() { return document.getElementById('halo-canvas'); }
function haloCalloutElement() { return document.getElementById('halo-callout'); }

function haloRand(a, b) { return a + Math.random() * (b - a); }
function haloPick(list) { return list[(Math.random() * list.length) | 0]; }
function haloGauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }
function haloClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function haloNormAngle(a) { return ((a + Math.PI) % HALO_TAU + HALO_TAU) % HALO_TAU - Math.PI; }
function haloEaseIO(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function haloEaseOut(t) { return 1 - Math.pow(1 - t, 3); }

// The clock is behind a function so a probe can override it instead of assigning the audio
// element - replacing that global is how one probe leaked its fixture into the app's
// persisted playback snapshot.
function haloPlayheadSeconds() {
  if (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) return Math.max(0, audio.currentTime);
  return 0;
}

// ---------------------------------------------------------------- geometry

function haloLayoutStage(w, h) {
  var s = haloState;
  s.w = Math.max(2, w);
  s.h = Math.max(2, h);
  s.cx = s.w / 2;
  s.cy = s.h / 2;
  s.R = Math.max(24, Math.min(s.w, s.h) * HALO_RADIUS_K);
  s.band = s.R * HALO_BAND_K;
  s.RO = s.R + s.band;
  s.RMAX = Math.hypot(s.w - s.cx, s.h / 2) + 60;
  s.dpr = HALO_RENDER_SCALE;
}

function haloResize() {
  var layer = haloLayerElement();
  var canvas = haloCanvasElement();
  if (!layer || !canvas) return false;
  var w = layer.clientWidth || window.innerWidth || 1280;
  var h = layer.clientHeight || window.innerHeight || 720;
  haloLayoutStage(w, h);
  canvas.width = Math.max(2, Math.round(w * HALO_RENDER_SCALE));
  canvas.height = Math.max(2, Math.round(h * HALO_RENDER_SCALE));
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  haloBuildWeb();
  haloBuildSlots();
  haloBuildStrands();
  haloBuildFlyers();
  haloBuildGradients();
  haloState.ready = true;
  return true;
}

// ---------------------------------------------------------------- camera

function haloApplyCameraTransform(ctx, scale, depth) {
  var cam = haloCam;
  var z = 1 + (cam.z - 1) * depth;
  var x = haloState.w / 2 + (cam.x - haloState.w / 2) * depth;
  var y = haloState.h / 2 + (cam.y - haloState.h / 2) * depth;
  ctx.setTransform(scale * z, 0, 0, scale * z, scale * (haloState.w / 2 - x * z), scale * (haloState.h / 2 - y * z));
}

function haloToScreen(x, y) {
  var cam = haloCam;
  return {
    x: (x - cam.x) * cam.z + haloState.w / 2,
    y: (y - cam.y) * cam.z + haloState.h / 2
  };
}

// The camera holds on the last mark and travels to the next one, arriving exactly on the
// beat: the interpolation is a function of the time to the beat, not of the frame phase.
function haloCameraUpdate(t) {
  var move = haloCamMove;
  if (!move) {
    haloCam.x = haloState.w / 2;
    haloCam.y = haloState.h / 2;
    haloCam.z = 1;
    return;
  }
  var span = Math.max(0.05, move.endAt - move.startAt);
  var k = haloClamp((t - move.startAt) / span, 0, 1);
  var e = haloEaseIO(k);
  haloCam.x = move.fromX + (move.toX - move.fromX) * e;
  haloCam.y = move.fromY + (move.toY - move.fromY) * e;
  haloCam.z = move.fromZ + (move.toZ - move.fromZ) * e;
}

// Pick the next mark. Three shapes: push in, travel along the ring, pull out. The choice
// follows the beat's weight so a heavy beat pushes in.
function haloCameraPickTarget(weight, at) {
  var s = haloState;
  var mid = (s.R + s.RO) / 2;
  var ang = haloRand(0, HALO_TAU);
  var deep = weight > 0.62;
  var zoom = deep ? haloRand(1.7, 2.4) : (weight < 0.32 ? haloRand(0.86, 1.0) : haloRand(1.1, 1.5));
  var radius = deep ? haloRand(0.55, 0.85) * mid : haloRand(0.9, 1.5) * mid;
  return {
    x: s.cx + Math.cos(ang) * radius,
    y: s.cy + Math.sin(ang) * radius,
    z: zoom
  };
}

function haloCameraScheduleMove(hitAt, weight, startAt) {
  var s = haloState;
  var target = haloCameraPickTarget(weight, hitAt);
  haloCamMove = {
    fromX: haloCam.x, fromY: haloCam.y, fromZ: haloCam.z,
    toX: target.x, toY: target.y, toZ: target.z,
    startAt: startAt != null ? startAt : haloPlayheadSeconds(),
    endAt: hitAt
  };
}

function haloCameraSnapToCentre() {
  haloCam.x = haloState.w / 2;
  haloCam.y = haloState.h / 2;
  haloCam.z = 1;
  haloCamMove = null;
}

// ---------------------------------------------------------------- audio

// The bands come from the sonic monitor when it is running (it is stepped by the main loop
// every audio frame, so this is free). The fallback reads the analyser into a private
// buffer: it must not touch the shared frequencyData, because the main loop reads that
// array in the same frame.
function haloReadAudioBands(t) {
  var a = haloAudio;
  a.bands[0] = a.bands[1] = a.bands[2] = a.bands[3] = 0;
  a.bands[4] = a.bands[5] = a.bands[6] = a.bands[7] = 0;
  a.level = 0;
  a.kick = 0;
  var frame = (typeof sonicAudioMonitorState !== 'undefined' && sonicAudioMonitorState) ? sonicAudioMonitorState.frame : null;
  if (frame) {
    a.bands[0] = Number(frame.subBass) || 0;
    a.bands[1] = Number(frame.bass) || 0;
    a.bands[2] = Number(frame.lowMid) || 0;
    a.bands[3] = Number(frame.mid) || 0;
    a.bands[4] = Number(frame.highMid) || 0;
    a.bands[5] = Number(frame.presence) || 0;
    a.bands[6] = Number(frame.brilliance) || 0;
    a.bands[7] = Number(frame.air) || 0;
    a.level = Number(frame.energy) || 0;
    a.kick = Number(frame.kickEnvelope) || 0;
    a.kickOnset = Number(frame.kickOnset) || 0;
    return;
  }
  a.kickOnset = 0;
  var analyser = (typeof analyser !== 'undefined') ? analyser : null;
  if (!analyser || typeof analyser.getByteFrequencyData !== 'function') return;
  var bins = analyser.frequencyBinCount || 0;
  if (!bins) return;
  if (!a.buffer || a.buffer.length !== bins) a.buffer = new Uint8Array(bins);
  try { analyser.getByteFrequencyData(a.buffer); } catch (err) { return; }
  var nyquist = 22050;
  var sampleRate = (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.sampleRate) ? audioCtx.sampleRate : 44100;
  nyquist = sampleRate / 2;
  var edges = [[32, 58], [58, 118], [118, 260], [260, 720], [720, 1800], [1800, 4200], [4200, 9000], [9000, 16000]];
  var binHz = nyquist / bins;
  for (var b = 0; b < edges.length; b++) {
    var lo = Math.max(0, Math.floor(edges[b][0] / binHz));
    var hi = Math.min(bins - 1, Math.ceil(edges[b][1] / binHz));
    var sum = 0;
    for (var i = lo; i <= hi; i++) sum += a.buffer[i];
    a.bands[b] = haloClamp((sum / Math.max(1, hi - lo + 1)) / 255, 0, 1);
  }
  a.level = (a.bands[0] + a.bands[1] + a.bands[2] + a.bands[3] + a.bands[4] + a.bands[5] + a.bands[6] + a.bands[7]) / 8;
}

// ---------------------------------------------------------------- beats

// The beat map is the preferred source: it knows the future, so the visual can be started
// early enough to land on the beat. The realtime kick detector is the fallback - it fires
// after the onset, so nothing can be early there and the flight times are shortened.
function haloBeatMapEvents() {
  if (typeof currentBeatMap === 'undefined' || !currentBeatMap) return null;
  var events = currentBeatMap.cameraBeats || currentBeatMap.beats || currentBeatMap.kicks || [];
  if (!events || !events.length) return null;
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var time = typeof e === 'number' ? e : (e && typeof e.time === 'number' ? e.time : NaN);
    if (!isFinite(time)) continue;
    var weight = typeof e === 'number' ? 0.5 : haloClamp((e.strength != null ? e.strength : 0.5) * 0.5 + (e.impact != null ? e.impact : 0.4) * 0.5, 0, 1);
    out.push({ t: time, w: weight });
  }
  return out.length ? out : null;
}

function haloRefreshBeatSource() {
  var events = haloBeatMapEvents();
  if (events) {
    if (haloBeat.source !== 'map' || haloBeat.list.length !== events.length) {
      haloBeat.list = events;
      haloBeat.idx = 0;
      haloBeat.source = 'map';
    }
    return;
  }
  if (haloBeat.source !== 'live') {
    haloBeat.list = [];
    haloBeat.idx = 0;
    haloBeat.source = 'live';
  }
}

function haloScheduleBeats(t) {
  haloRefreshBeatSource();
  var list = haloBeat.list;
  if (list && list.length) {
    while (haloBeat.idx < list.length && list[haloBeat.idx].t < t - 0.25) haloBeat.idx++;
    while (haloBeat.idx < list.length && list[haloBeat.idx].t <= t + HALO_BEAT_LOOKAHEAD) {
      var beat = list[haloBeat.idx++];
      haloEnqueueBeat(beat.t, beat.w, false);
    }
    return;
  }
  if (haloAudio.kickOnset > 0 && t - haloBeat.lastOnsetAt > 0.12) {
    haloBeat.lastOnsetAt = t;
    haloEnqueueBeat(t + 0.02, haloClamp(0.35 + 0.55 * haloAudio.kickOnset, 0, 1), true);
  }
}

function haloEnqueueBeat(hitAt, weight, late) {
  haloBeat.events.push({
    hitAt: hitAt,
    weight: weight,
    late: !!late,
    travel: late ? HALO_TRAVEL_FAST : (weight > 0.62 ? HALO_TRAVEL_SLOW : HALO_TRAVEL_FAST),
    prepared: false,
    launched: false,
    hit: false,
    slots: null
  });
  if (haloBeat.events.length > 24) haloBeat.events.splice(0, haloBeat.events.length - 24);
  haloBeat.count++;
}

// Three phases per beat: prepare (render the panels that will flash, start the camera
// move), launch (send the beams so they land on the beat), hit (swap, flash, arrive).
// Only the launch is quantised by the frame; the arrival is a function of the clock.
function haloRunBeatEvents(t) {
  var events = haloBeat.events;
  for (var i = events.length - 1; i >= 0; i--) {
    var e = events[i];
    if (!e.prepared && t >= e.hitAt - HALO_PREPARE_MS / 1000) {
      e.prepared = true;
      haloBeatPrepare(e);
    }
    if (!e.launched && t >= e.hitAt - e.travel) {
      e.launched = true;
      haloBeatLaunch(e);
    }
    if (!e.hit && t >= e.hitAt) {
      e.hit = true;
      haloBeatHit(e);
    }
    if (t > e.hitAt + 0.8) events.splice(i, 1);
  }
}

function haloBeatPrepare(e) {
  // The camera move has to start before the beat so it can arrive on it.
  var startAt = e.late ? haloPlayheadSeconds() : Math.max(haloPlayheadSeconds(), e.hitAt - 0.45);
  haloCameraScheduleMove(e.hitAt, e.weight, startAt);
  // Pre-render the panels that will flash. The fresh canvas waits in slot.next, so the
  // swap at the hit is a pointer assignment and cannot hitch the frame.
  var slots = haloPickVisibleSlots(HALO_PANEL_REFRESH_MIN, HALO_PANEL_REFRESH_MAX);
  e.slots = slots;
  for (var i = 0; i < slots.length; i++) slots[i].next = haloRenderSlot(slots[i]);
}

function haloBeatLaunch(e) {
  var s = haloState;
  var count = e.weight > 0.62 ? 3 : 2;
  for (var i = 0; i < count; i++) {
    var ang = haloRand(0, HALO_TAU);
    haloSpawnComet(ang, e.travel, e.weight);
  }
}

function haloBeatHit(e) {
  var slots = e.slots || [];
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    if (slot.next) {
      slot.c = slot.next;
      slot.next = null;
    }
    slot.flash = 0.85;
  }
  haloState.ringPulse = 1;
}

// ---------------------------------------------------------------- lyric dial

function haloCurrentSong() {
  if (Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length) return playQueue[currentIdx];
  if (typeof currentCoverSong === 'function') return currentCoverSong();
  return null;
}

function haloLyricSignature() {
  var lines = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
  var song = haloCurrentSong();
  var key = '';
  if (typeof lyricTimingSongKey === 'function') key = lyricTimingSongKey(song);
  var h = 2166136261;
  var text = key + '|' + lines.length + '|' + (lines.length ? lines[0].text : '');
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 1676997213) >>> 0;
  }
  return (h >>> 0).toString(36) + ':' + lines.length;
}

// The lyric lines are laid out on the inner rim. Each line owns an arc whose length is its
// own measured width, so the ring turns exactly one line's worth per line.
function haloBuildLyricRing() {
  var canvas = haloCanvasElement();
  var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  var lines = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
  var translations = (typeof lyricsTranslationLines !== 'undefined' && Array.isArray(lyricsTranslationLines)) ? lyricsTranslationLines : [];
  var offset = 0;
  if (typeof getActiveLyricTimingOffsetSeconds === 'function') offset = getActiveLyricTimingOffsetSeconds();
  haloLyric.items = [];
  haloLyric.current = -1;
  haloLyric.pending = -1;
  haloLyric.tween = null;
  haloLyric.rot = HALO_READ_ANGLE;
  haloLyric.baseAngle = 0;
  var fontPx = HALO_LYRIC_FONT_PX;
  var measure = ctx || null;
  // The characters are measured with the font they will be drawn in, otherwise the arc
  // lengths are computed against the default 10px face and the dial does not close.
  if (measure) {
    measure.save();
    measure.font = '600 ' + fontPx + 'px ' + HALO_FONT;
  }
  var maxArcPx = Math.max(120, haloState.R * 1.5);
  var acc = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var text = String((line && line.text) || '').trim();
    if (!text) continue;
    var chars = Array.from(text);
    var widths = [];
    var total = 0;
    for (var c = 0; c < chars.length; c++) {
      var w = measure ? measure.measureText(chars[c]).width : chars[c].length * fontPx;
      if (!isFinite(w) || w <= 0) w = fontPx * 0.6;
      widths.push(w);
      total += w;
    }
    var scale = total > maxArcPx ? Math.max(0.42, maxArcPx / total) : 1;
    var arcPx = total * scale + HALO_LYRIC_GAP_PX;
    var item = {
      index: haloLyric.items.length,
      text: text,
      chars: chars,
      widths: widths,
      scale: scale,
      totalWidth: total * scale,
      arc: arcPx / Math.max(1, haloState.R),
      angle: 0,
      startAt: Math.max(0, (Number(line.t) || 0) + offset),
      sub: ''
    };
    if (translations[i] && translations[i].text) item.sub = String(translations[i].text).trim();
    item.angle = acc + item.arc / 2;
    acc += item.arc;
    haloLyric.items.push(item);
  }
  if (measure) measure.restore();
  haloLyric.songKey = haloLyricSignature();
  return haloLyric.items.length;
}

function haloLyricUpdate(t) {
  var items = haloLyric.items;
  if (!items.length) return;
  // Find the line that should be on the read mark, and the one coming next.
  var current = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].startAt <= t + 0.001) current = i;
    else break;
  }
  if (current < 0) current = 0;
  if (haloLyric.tween) {
    var tw = haloLyric.tween;
    var k = haloClamp((t - tw.startAt) / Math.max(0.05, tw.dur), 0, 1);
    haloLyric.rot = tw.from + (tw.to - tw.from) * haloEaseIO(k);
    if (k >= 1) {
      haloLyric.tween = null;
      haloLyric.current = tw.item;
      // Rebase so the accumulated angles stay small: the screen angles do not change.
      var rebase = items[tw.item].angle;
      for (var j = 0; j < items.length; j++) items[j].angle -= rebase;
      haloLyric.rot += rebase;
    }
    return;
  }
  if (current === haloLyric.current) return;
  var next = current;
  if (haloLyric.current < 0) {
    // First line: put it on the mark straight away.
    haloLyric.current = next;
    haloLyric.rot = HALO_READ_ANGLE - items[next].angle;
    return;
  }
  var lead = items[next].startAt - t;
  if (lead > HALO_ROT_LEAD) {
    // The turn starts HALO_ROT_LEAD before the line; until then the mark stays put.
    return;
  }
  if (lead < -1.5) {
    // A seek jumped the clock: snap instead of spinning.
    haloLyric.current = next;
    haloLyric.rot = HALO_READ_ANGLE - items[next].angle;
    var rebase2 = items[next].angle;
    for (var m = 0; m < items.length; m++) items[m].angle -= rebase2;
    haloLyric.rot += rebase2;
    return;
  }
  haloLyric.pending = next;
  haloLyric.tween = {
    item: next,
    from: haloLyric.rot,
    to: HALO_READ_ANGLE - items[next].angle,
    startAt: t,
    dur: Math.max(0.08, lead)
  };
}

// ---------------------------------------------------------------- inner web

// The web is the blurred mesh inside the dial. The original bakes 2600 curves into four
// canvases the size of the whole disc and blurs each of them; we bake one canvas with a
// third of the curves and blur it once, then modulate the whole layer's brightness
// instead of keeping three extra pulse canvases.
function haloBuildWeb() {
  var s = haloState;
  var size = Math.max(8, Math.ceil(2 * s.R + 4));
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.translate(s.R + 2, s.R + 2);
  var base = ctx.createRadialGradient(0, 0, s.R * 0.2, 0, 0, s.R);
  base.addColorStop(0, '#111215');
  base.addColorStop(1, '#0c0d0f');
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(0, 0, s.R, 0, HALO_TAU);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, s.R, 0, HALO_TAU);
  ctx.clip();
  haloWebCurves = [];
  for (var i = 0; i < HALO_WEB_CURVES; i++) {
    var a1 = Math.random() * HALO_TAU;
    var a2 = a1 + haloRand(0.6, Math.PI * 1.4);
    var curve = {
      p0: { x: Math.cos(a1) * s.R, y: Math.sin(a1) * s.R },
      c: { x: 0, y: 0 },
      p1: { x: Math.cos(a2) * s.R, y: Math.sin(a2) * s.R }
    };
    var cr = Math.sqrt(Math.random()) * s.R * 0.9;
    var ca = Math.random() * HALO_TAU;
    curve.c = { x: Math.cos(ca) * cr, y: Math.sin(ca) * cr };
    haloWebCurves.push(curve);
    var alpha = (0.03 + Math.pow(Math.random(), 3) * 0.28) * 0.9;
    var pick = Math.random();
    ctx.strokeStyle = pick < 0.05
      ? 'rgba(240,166,198,' + alpha.toFixed(3) + ')'
      : (pick < 0.1 ? 'rgba(180,170,235,' + alpha.toFixed(3) + ')' : 'rgba(228,231,238,' + alpha.toFixed(3) + ')');
    ctx.lineWidth = haloRand(0.4, 1.1);
    ctx.beginPath();
    ctx.moveTo(curve.p0.x, curve.p0.y);
    ctx.quadraticCurveTo(curve.c.x, curve.c.y, curve.p1.x, curve.p1.y);
    ctx.stroke();
  }
  // node markers
  ctx.font = '6px ' + HALO_FONT;
  ctx.textBaseline = 'middle';
  for (var n = 0; n < 40; n++) {
    var rr2 = Math.sqrt(Math.random()) * s.R * 0.92;
    var ang = Math.random() * HALO_TAU;
    var px = Math.cos(ang) * rr2;
    var py = Math.sin(ang) * rr2;
    var size2 = haloRand(2, 4.5);
    ctx.strokeStyle = 'rgba(235,238,244,' + haloRand(0.35, 0.8).toFixed(3) + ')';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(px, py, size2, 0, HALO_TAU);
    ctx.stroke();
    if (Math.random() < 0.4) {
      ctx.beginPath();
      ctx.arc(px + size2 * 2.2, py, size2 * 0.8, 0, HALO_TAU);
      ctx.stroke();
    }
  }
  // dotted chains of small rings
  for (var k = 0; k < 3; k++) {
    var rad = s.R * haloRand(0.45, 0.85);
    var a0 = haloRand(0, HALO_TAU);
    var cnt = 22 + ((Math.random() * 14) | 0);
    ctx.strokeStyle = 'rgba(235,238,244,.55)';
    ctx.lineWidth = 0.8;
    for (var d = 0; d < cnt; d++) {
      var a = a0 + d * 0.022;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rad, Math.sin(a) * rad, 2.2, 0, HALO_TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
  // One blur pass over the whole mesh. The original runs one per canvas, four times.
  try {
    var blurred = document.createElement('canvas');
    blurred.width = size;
    blurred.height = size;
    var bctx = blurred.getContext('2d');
    if (bctx && 'filter' in bctx) {
      bctx.drawImage(canvas, 0, 0);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.filter = 'blur(2.2px)';
      ctx.drawImage(blurred, 0, 0);
      ctx.filter = 'none';
      ctx.globalAlpha = 0.55;
      ctx.drawImage(blurred, 0, 0);
      ctx.restore();
    }
  } catch (err) {
    // A missing filter is not fatal: the mesh stays sharp.
  }
  haloWeb = canvas;
  haloBuildRunners();
}

function haloCurvePoint(curve, t) {
  var u = 1 - t;
  return {
    x: u * u * curve.p0.x + 2 * u * t * curve.c.x + t * t * curve.p1.x,
    y: u * u * curve.p0.y + 2 * u * t * curve.c.y + t * t * curve.p1.y
  };
}

// The streaks that run along the mesh. The original keeps 336..788 of them and fades them
// through a full-size trail buffer; we keep a small pool and draw the streak directly.
function haloBuildRunners() {
  haloRunnerList = [];
  for (var i = 0; i < HALO_RUNNER_COUNT; i++) haloRunnerList.push(haloNewRunner(true));
}

function haloNewRunner(init) {
  var curves = haloWebCurves;
  var curve = curves.length ? curves[(Math.random() * curves.length) | 0] : null;
  var t = init ? Math.random() : 0;
  var point = curve ? haloCurvePoint(curve, t) : { x: 0, y: 0 };
  var k = Math.random();
  var mode = 1;
  var speed = 0.2;
  if (k < 0.3) { mode = 0; speed = haloRand(0.15, 0.28); }
  else if (k < 0.65) { mode = 1; speed = haloRand(0.1, 0.3); }
  else if (k < 0.8) { mode = 0; speed = haloRand(0.04, 0.08); }
  else if (k < 0.92) { mode = 0; speed = haloRand(0.5, 0.85); }
  else { mode = 2; speed = haloRand(0.06, 0.12); }
  return { curve: curve, t: t, sp: speed, mode: mode, px: point.x, py: point.y, ox: point.x, oy: point.y, bright: Math.random() < 0.1 };
}

function haloUpdateRunners(dt, surge) {
  for (var i = 0; i < haloRunnerList.length; i++) {
    var r = haloRunnerList[i];
    if (!r.curve) { haloRunnerList[i] = haloNewRunner(true); continue; }
    var speed = r.mode === 1 ? r.sp * surge : (r.mode === 2 ? r.sp + 1.3 * r.t * r.t : r.sp);
    r.t += dt * speed;
    if (r.t >= 1) {
      haloRunnerList[i] = haloNewRunner(false);
      continue;
    }
    var p = haloCurvePoint(r.curve, r.t);
    r.ox = r.px;
    r.oy = r.py;
    r.px = p.x;
    r.py = p.y;
  }
}

// The spectrum lives inside the dial: eight bands mapped onto eight groups of spokes, low
// frequencies near the centre and high ones near the rim. This is the readout that the
// separate spectrum panel used to provide.
var HALO_SPOKE_COUNT = 64;
var HALO_SPOKE_BANDS = [
  'rgba(150,190,255,', 'rgba(140,205,235,', 'rgba(140,225,205,', 'rgba(170,235,175,',
  'rgba(215,235,150,', 'rgba(240,220,150,', 'rgba(245,190,175,', 'rgba(230,175,235,'
];

function haloDrawSpectrumSpokes(ctx) {
  var s = haloState;
  var bands = haloAudio.bands;
  var level = haloAudio.level;
  var r0 = s.R * 0.14;
  var span = s.R * 0.76;
  ctx.lineCap = 'round';
  for (var i = 0; i < HALO_SPOKE_COUNT; i++) {
    var band = Math.floor(i * haloAudio.bands.length / HALO_SPOKE_COUNT);
    var value = bands[band] || 0;
    var a = (i / HALO_SPOKE_COUNT) * HALO_TAU + haloState.webRot * 0.4;
    var len = span * (0.06 + 0.94 * value * value);
    var alpha = 0.10 + 0.72 * value;
    ctx.strokeStyle = HALO_SPOKE_BANDS[band] + alpha.toFixed(3) + ')';
    ctx.lineWidth = 1 + 2.4 * value;
    ctx.beginPath();
    ctx.moveTo(s.cx + Math.cos(a) * r0, s.cy + Math.sin(a) * r0);
    ctx.lineTo(s.cx + Math.cos(a) * (r0 + len), s.cy + Math.sin(a) * (r0 + len));
    ctx.stroke();
  }
  if (level > 0.02) {
    var g = ctx.createRadialGradient(s.cx, s.cy, 0, s.cx, s.cy, s.R);
    g.addColorStop(0, 'rgba(190,200,255,' + (0.10 * level).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(190,200,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, s.R, 0, HALO_TAU);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- ring panels

var HALO_RING_SC = 2.4;            // supersample factor of a panel bitmap
var HALO_PANEL_HEAD = ['SOLVER/02', 'EXTRACT', 'REF.SCENE 07', 'METHOD M04', 'CHECK', 'RESIDUAL', 'PAPER 37', 'AGENT 09', 'BUFFER A',
  'DIFF FIELD', 'STEP 1284', 'MESH 64x64', 'PROJECT', 'ADVECT', 'BC / WALL', 'LBM D2Q9', 'QUEUE', 'TRACE', 'EQ.(4)', 'FIG.3', 'VALIDATE', 'SCENE 12'];
var HALO_PANEL_KEYS = ['dt', 'CFL', 'nu', 'Re', 'tol', 'iter', 'L2', 'mass', 'div', 'u_max', 'rho', 'err', 'grid', 'seed'];
var HALO_PANEL_CODE = ['load()', 'step(u)', 'proj(p)', 'bc.apply', 'solve()', 'grad p', 'div u', 'assert', 'f_eq', 'stream', 'collide', 'ok', 'PASS',
  'ref#12', 'diff', 'L2<tol', 'u*', '->', '==', 'dt/2', 'emit', 'push', 'read', 'fig3', 'eq4'];
var HALO_PANEL_TINT = [
  [232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240],
  [196, 184, 246], [196, 184, 246], [168, 222, 214], [206, 212, 150]
];

function haloRimWidth() {
  return Math.max(3, haloState.band * 0.065);
}

function haloBuildSlots() {
  var s = haloState;
  haloSlotList = [];
  var mid = s.R + s.band * 0.42;
  var a = 0;
  while (a < HALO_TAU - 0.03) {
    var hpx = haloRand(HALO_SLOT_MIN_PX, HALO_SLOT_MAX_PX);
    var da = hpx / mid;
    var gap = haloRand(3, 9) / mid;
    haloSlotList.push({ a: a + da / 2, da: da, hpx: hpx, c: null, next: null, flash: 0 });
    a += da + gap;
  }
  for (var i = 0; i < haloSlotList.length; i++) {
    haloSlotList[i].c = haloRenderSlot(haloSlotList[i]);
  }
}

function haloSlotVisible(slot) {
  var s = haloState;
  var mid = s.R + s.band * 0.42;
  var angle = slot.a + haloState.ringRot;
  var p = haloToScreen(s.cx + Math.cos(angle) * mid, s.cy + Math.sin(angle) * mid);
  return p.x > -140 && p.x < s.w + 140 && p.y > -140 && p.y < s.h + 140;
}

function haloPickVisibleSlots(min, max) {
  var visible = [];
  for (var i = 0; i < haloSlotList.length; i++) {
    var slot = haloSlotList[i];
    // A slot that already holds a prepared bitmap belongs to a beat; leave it alone.
    if (slot.next) continue;
    if (haloSlotVisible(slot)) visible.push(slot);
  }
  if (!visible.length) return [];
  var count = Math.min(visible.length, Math.round(haloRand(min, max + 1)));
  var picked = [];
  for (var k = 0; k < count; k++) {
    var idx = (Math.random() * visible.length) | 0;
    picked.push(visible[idx]);
    visible.splice(idx, 1);
    if (!visible.length) break;
  }
  return picked;
}

function haloPanelRgba(tint, alpha) {
  return 'rgba(' + tint[0] + ',' + tint[1] + ',' + tint[2] + ',' + alpha + ')';
}

function haloPanelNumber() {
  var k = Math.random();
  if (k < 0.3) return haloRand(0, 1).toFixed(3);
  if (k < 0.55) return haloRand(1, 9).toFixed(1) + 'e-' + (2 + ((Math.random() * 5) | 0));
  if (k < 0.8) return String((Math.random() * 9999) | 0);
  return haloRand(0, 100).toFixed(1);
}

function haloPanelHeader(c, x0, x1, y, tint) {
  c.font = '700 4.3px ' + HALO_FONT;
  c.fillStyle = haloPanelRgba(tint, 0.95);
  c.fillText(haloPick(HALO_PANEL_HEAD), x0, y);
  c.fillStyle = haloPanelRgba(tint, 0.55);
  c.fillText(String((Math.random() * 99) | 0).padStart(2, '0'), x1 - 6, y);
  c.fillStyle = haloPanelRgba(tint, 0.3);
  c.fillRect(x0, y + 5.6, x1 - x0, 0.45);
  return y + 7.5;
}

function haloPanelGlyphStrips(c, x, x1, y0, y1, pitch, opt, tint) {
  for (var lx = x; lx < x1 - 1; lx += pitch) {
    if (opt.colGap && Math.random() < 0.18) { lx += pitch * 0.8; continue; }
    var len = (y1 - y0) * (opt.ragged ? haloRand(0.35, 1) : haloRand(0.85, 1));
    var start = (opt.ragged && Math.random() < 0.3) ? y0 + haloRand(0, (y1 - y0) * 0.3) : y0;
    var y = start;
    var lb = haloRand(0.55, 1);
    while (y < Math.min(y1, start + len)) {
      var cl = opt.solid ? haloRand(2, 6) : haloRand(0.9, 2.2);
      if (Math.random() < 0.9) {
        c.fillStyle = haloPanelRgba(tint, lb * haloRand(0.6, 1));
        c.fillRect(lx, y, opt.th, Math.min(cl, y1 - y));
      }
      y += cl + (Math.random() < 0.12 ? haloRand(1.5, 3) : haloRand(0.5, 0.9));
    }
  }
}

// The panels are instruments, not decoration: bars/kv/spark/wave read the live bands.
var HALO_PANEL_BLOCKS = {
  code: function (c, x0, x1, y0, y1, tint) {
    var y = haloPanelHeader(c, x0, x1, y0, tint);
    c.font = '500 3.5px ' + HALO_FONT;
    var n = 1 + ((Math.random() * 40) | 0);
    while (y < y1 - 3.5) {
      c.fillStyle = haloPanelRgba(tint, 0.3);
      c.fillText(String(n++).padStart(3, '0'), x0, y);
      var xx = x0 + 9;
      var words = 1 + ((Math.random() * 4) | 0);
      for (var i = 0; i < words && xx < x1 - 4; i++) {
        var w = haloPick(HALO_PANEL_CODE);
        c.fillStyle = haloPanelRgba(tint, Math.random() < 0.25 ? 1 : haloRand(0.5, 0.8));
        c.fillText(w, xx, y);
        xx += w.length * 2.15 + 2;
      }
      y += 4.6;
    }
  },
  kv: function (c, x0, x1, y0, y1, tint) {
    var y = (y1 - y0 > 18) ? haloPanelHeader(c, x0, x1, y0, tint) : y0 + 1;
    c.font = '500 3.6px ' + HALO_FONT;
    var bands = haloAudio.bands;
    while (y < y1 - 4) {
      var keyIndex = (Math.random() * HALO_PANEL_KEYS.length) | 0;
      var live = bands[keyIndex % bands.length] || 0;
      c.fillStyle = haloPanelRgba(tint, 0.5);
      c.fillText(HALO_PANEL_KEYS[keyIndex], x0, y);
      var value = live > 0.04 ? live.toFixed(3) : haloPanelNumber();
      c.fillStyle = haloPanelRgba(tint, 0.95);
      c.textAlign = 'right';
      c.fillText(value, x1, y);
      c.textAlign = 'left';
      var bx = x0 + 14;
      var bw = Math.max(0, x1 - x0 - 14 - value.length * 2.2 - 4);
      c.fillStyle = haloPanelRgba(tint, 0.15);
      c.fillRect(bx, y + 1.2, bw, 1.2);
      c.fillStyle = haloPanelRgba(tint, 0.7);
      c.fillRect(bx, y + 1.2, bw * (live > 0.04 ? live : Math.random()), 1.2);
      y += 5.2;
    }
  },
  spark: function (c, x0, x1, y0, y1, tint) {
    var y = haloPanelHeader(c, x0, x1, y0, tint);
    var top = y + 1;
    var bot = y1 - 2;
    var n = 40;
    c.fillStyle = haloPanelRgba(tint, 0.18);
    c.fillRect(x0, bot, x1 - x0, 0.4);
    c.fillRect(x0, (top + bot) / 2, x1 - x0, 0.25);
    c.strokeStyle = haloPanelRgba(tint, 0.95);
    c.lineWidth = 0.55;
    c.beginPath();
    var v = haloClamp(haloAudio.level + haloGauss() * 0.15, 0, 1);
    var lx = 0;
    var ly = 0;
    for (var i = 0; i <= n; i++) {
      v = haloClamp(v + haloGauss() * 0.22, 0, 1);
      lx = x0 + (x1 - x0) * i / n;
      ly = bot - v * (bot - top);
      if (i) c.lineTo(lx, ly); else c.moveTo(lx, ly);
    }
    c.stroke();
    c.fillStyle = '#fff';
    c.fillRect(lx - 0.9, ly - 0.9, 1.8, 1.8);
  },
  bars: function (c, x0, x1, y0, y1, tint) {
    var y = haloPanelHeader(c, x0, x1, y0, tint);
    var n = 8;
    var bh = (y1 - y - 1) / n;
    c.font = '500 3px ' + HALO_FONT;
    var bands = haloAudio.bands;
    for (var i = 0; i < n; i++) {
      var v = bands[i % bands.length] || 0;
      var yy = y + i * bh;
      c.fillStyle = haloPanelRgba(tint, 0.35);
      c.fillText(String(i).padStart(2, '0'), x0, yy);
      c.fillStyle = haloPanelRgba(tint, v > 0.85 ? 1 : 0.65);
      c.fillRect(x0 + 7, yy + 0.4, (x1 - x0 - 7) * v, Math.max(0.8, bh - 1.2));
    }
  },
  prog: function (c, x0, x1, y0, y1, tint) {
    var y = (y1 - y0 > 18) ? haloPanelHeader(c, x0, x1, y0, tint) : y0 + 1;
    c.font = '500 3.4px ' + HALO_FONT;
    while (y < y1 - 5) {
      var p = Math.random();
      c.fillStyle = haloPanelRgba(tint, 0.55);
      c.fillText(haloPick(['read', 'build', 'review', 'qa', 'sync', 'diff']), x0, y);
      c.fillStyle = haloPanelRgba(tint, 0.9);
      c.textAlign = 'right';
      c.fillText(((p * 100) | 0) + '%', x1, y);
      c.textAlign = 'left';
      var bx = x0 + 15;
      var bw = x1 - x0 - 26;
      var segs = 12;
      for (var i = 0; i < segs; i++) {
        c.fillStyle = haloPanelRgba(tint, i / segs < p ? 0.85 : 0.14);
        c.fillRect(bx + i * bw / segs, y + 0.6, bw / segs - 0.6, 2);
      }
      y += 5.4;
    }
  },
  grid: function (c, x0, x1, y0, y1, tint) {
    var y = (y1 - y0 > 20) ? haloPanelHeader(c, x0, x1, y0, tint) : y0 + 1;
    var p = haloRand(2.4, 3.2);
    for (var yy = y; yy < y1 - p + 0.5; yy += p) {
      for (var xx = x0; xx < x1 - p + 0.5; xx += p) {
        var v = Math.random();
        c.fillStyle = v > 0.93 ? 'rgba(240,166,198,.95)' : haloPanelRgba(tint, 0.08 + v * v * 0.8);
        c.fillRect(xx, yy, p - 0.6, p - 0.6);
      }
    }
  },
  gauge: function (c, x0, x1, y0, y1, tint) {
    var r = Math.min((y1 - y0) / 2 - 1.5, 9);
    var gx = x0 + r + 1;
    var gy = (y0 + y1) / 2;
    var v = haloClamp(haloAudio.level + haloGauss() * 0.2, 0, 1);
    c.lineWidth = 1.2;
    c.strokeStyle = haloPanelRgba(tint, 0.15);
    c.beginPath();
    c.arc(gx, gy, r, 0, HALO_TAU);
    c.stroke();
    c.strokeStyle = haloPanelRgba(tint, 0.95);
    c.beginPath();
    c.arc(gx, gy, r, -Math.PI / 2, -Math.PI / 2 + HALO_TAU * v);
    c.stroke();
    c.font = '700 ' + Math.max(3.2, r * 0.55).toFixed(1) + 'px ' + HALO_FONT;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = haloPanelRgba(tint, 1);
    c.fillText(((v * 100) | 0) + '', gx, gy);
    c.textAlign = 'left';
    c.textBaseline = 'top';
    if (x1 - (gx + r) > 20) HALO_PANEL_BLOCKS.kv(c, gx + r + 4, x1, y0, y1, tint);
  },
  wave: function (c, x0, x1, y0, y1, tint) {
    var y = haloPanelHeader(c, x0, x1, y0, tint);
    var mid = (y + y1) / 2;
    var amp = (y1 - y) * 0.38;
    var f1 = haloRand(0.15, 0.4);
    var f2 = haloRand(0.5, 1.2);
    var ph = Math.random() * 6;
    var pairs = [[0.95, 1], [0.4, -0.6]];
    for (var p = 0; p < pairs.length; p++) {
      c.strokeStyle = haloPanelRgba(tint, pairs[p][0]);
      c.lineWidth = 0.5;
      c.beginPath();
      for (var xx = x0; xx <= x1; xx += 0.8) {
        var yy = mid + amp * pairs[p][1] * (Math.sin(xx * f1 + ph) * 0.7 + Math.sin(xx * f2) * 0.3);
        if (xx === x0) c.moveTo(xx, yy); else c.lineTo(xx, yy);
      }
      c.stroke();
    }
  },
  para: function (c, x0, x1, y0, y1, tint) {
    haloPanelGlyphStrips(c, x0, x1, y0, y1, haloRand(2.6, 3.4), { ragged: true, th: 1.3 }, tint);
  },
  cols: function (c, x0, x1, y0, y1, tint) {
    haloPanelGlyphStrips(c, x0, x1, y0, y1, haloRand(3.6, 4.6), { colGap: true, th: 1.5 }, tint);
  },
  barcode: function (c, x0, x1, y0, y1, tint) {
    haloPanelGlyphStrips(c, x0, x1, y0, y1, haloRand(3.2, 4.2), { solid: true, th: 1.8 }, tint);
  },
  matrix: function (c, x0, x1, y0, y1, tint) {
    var p = haloRand(2.1, 2.6);
    var dens = haloRand(0.35, 0.65);
    for (var yy = y0; yy < y1 - 1; yy += p) {
      for (var xx = x0; xx < x1; xx += p) {
        if (Math.random() < dens) {
          c.fillStyle = haloPanelRgba(tint, haloRand(0.5, 1));
          c.fillRect(xx, yy, 1.4, 1.4);
        }
      }
    }
  }
};
var HALO_PANEL_WEIGHT = [['code', 16], ['kv', 11], ['spark', 9], ['bars', 8], ['prog', 7], ['grid', 7], ['gauge', 3], ['wave', 4],
  ['para', 12], ['cols', 7], ['barcode', 6], ['matrix', 8]];
var HALO_PANEL_NEEDS_H = { code: 18, spark: 18, bars: 20, wave: 18, gauge: 16 };

function haloPanelPickBlock(h) {
  for (var tries = 0; tries < 8; tries++) {
    var r = Math.random() * 100;
    var name = 'para';
    for (var i = 0; i < HALO_PANEL_WEIGHT.length; i++) {
      r -= HALO_PANEL_WEIGHT[i][1];
      if (r <= 0) { name = HALO_PANEL_WEIGHT[i][0]; break; }
    }
    if (!HALO_PANEL_NEEDS_H[name] || h >= HALO_PANEL_NEEDS_H[name]) return name;
  }
  return haloPick(['para', 'kv', 'matrix', 'barcode']);
}

function haloRenderSlot(slot) {
  var s = haloState;
  var band = s.band;
  var h = slot.hpx;
  var canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(band * HALO_RING_SC));
  canvas.height = Math.max(1, Math.ceil((h + 2) * HALO_RING_SC));
  var x = canvas.getContext('2d');
  if (!x) return null;
  x.scale(HALO_RING_SC, HALO_RING_SC);
  x.textBaseline = 'top';
  var RB = haloRimWidth();
  var dz0 = RB + 6;
  var dz1 = band * 0.72;
  var oz0 = band * 0.78;
  var oz1 = band - RB - 5;
  var blocks = [];
  if (Math.random() < 0.45 && dz1 - dz0 > 60) {
    var m = dz0 + (dz1 - dz0) * haloRand(0.42, 0.6);
    blocks.push([dz0, m], [m + haloRand(4, 8), dz1]);
  } else {
    blocks.push([dz0, dz1 - haloRand(0, 18)]);
  }
  for (var b = 0; b < blocks.length; b++) {
    var tint = haloPick(HALO_PANEL_TINT);
    var y0 = 1 + haloRand(0, 2);
    var y1 = h + 1 - haloRand(0, 2);
    x.save();
    x.beginPath();
    x.rect(blocks[b][0], y0 - 0.5, blocks[b][1] - blocks[b][0], y1 - y0 + 1);
    x.clip();
    var name = haloPanelPickBlock(y1 - y0);
    if (HALO_PANEL_BLOCKS[name]) HALO_PANEL_BLOCKS[name](x, blocks[b][0], blocks[b][1], y0, y1, tint);
    x.restore();
  }
  // outer index column
  var pitch = haloRand(8, 12);
  x.font = '600 3.1px ' + HALO_FONT;
  for (var yy = haloRand(1, pitch); yy < h - 2; yy += pitch) {
    if (Math.random() < 0.15) continue;
    var xx = oz0 + haloRand(0, 3);
    if (Math.random() < 0.45) {
      x.fillStyle = 'rgba(225,228,236,' + haloRand(0.55, 0.95).toFixed(3) + ')';
      x.fillText(String((Math.random() * 999) | 0).padStart(3, '0'), xx, yy - 1);
      xx += 9;
    }
    var n = 1 + ((Math.random() * 3) | 0);
    for (var i = 0; i < n && xx < oz1; i++) {
      x.fillStyle = 'rgba(225,228,236,' + haloRand(0.5, 0.95).toFixed(3) + ')';
      x.fillRect(xx, yy, haloRand(1.2, 2.4), 1.2);
      xx += haloRand(2.4, 3.6);
    }
  }
  return canvas;
}

// ---------------------------------------------------------------- outer beams

var haloPulseList = [];

function haloMakeProfile(n) {
  var prof = [];
  var v = haloRand(0.45, 1);
  var run = 0;
  for (var k = 0; k < n; k++) {
    if (run-- <= 0) {
      v = haloClamp(v + haloGauss() * 0.4, 0.22, 1);
      run = 2 + ((Math.random() * 5) | 0);
    }
    prof.push(haloClamp(v + haloGauss() * 0.07, 0.18, 1));
  }
  return prof;
}

// A layer of wedges. The original uses five layers with angular steps from 0.12 to 0.45
// degrees and 4..90 strokes each, which is about 8000 strokes a frame; the density knob
// scales the coverage so the same shape can be dialed back.
function haloMakeStrandLayer(stepDeg, rotK, lumK, lw, lenK, solidK, cover, nMin, nMax, brightP, dyn) {
  var step = stepDeg * Math.PI / 180;
  var nb = Math.floor(HALO_TAU / step);
  var wedges = [];
  var count = Math.max(1, Math.round(nb * cover * HALO_STRAND_DENSITY / ((nMin + nMax) / 2)));
  for (var j = 0; j < count; j++) {
    var n = nMin + ((Math.random() * (nMax - nMin)) | 0);
    var bright = Math.random() < brightP;
    var wedge = {
      i0: (Math.random() * nb) | 0,
      n: n,
      base: haloRand(0.35, 1),
      len: haloRand(0.1, 0.5),
      kick: 0,
      ph: Math.random() * HALO_TAU,
      ph2: Math.random() * HALO_TAU,
      f1: haloRand(0.22, 0.6),
      f2: haloRand(0.8, 1.7),
      lum: bright ? haloRand(0.75, 1) : haloRand(0.16, 0.55),
      tint: Math.random() < 0.5 ? 1 : 0,
      lwK: Math.random() < 0.2 ? haloRand(1.35, 2.1) : haloRand(0.6, 1.15),
      lenS: haloRand(0.6, 1.25),
      prof: haloMakeProfile(n),
      pf: [],
      pp: [],
      ds: [],
      dsp: haloRand(0.7, 1.8),
      flow: 0,
      vis: false
    };
    for (var i = 0; i < n; i++) {
      wedge.pf.push(haloRand(1, 4));
      wedge.pp.push(Math.random() * HALO_TAU);
      wedge.ds.push(Math.random());
    }
    wedges.push(wedge);
  }
  return { step: step, rotK: rotK, lumK: lumK, lw: lw, lenK: lenK, solidK: solidK, wedges: wedges, off: Math.random() * HALO_TAU, dyn: dyn || 'soft' };
}

function haloBuildStrands() {
  haloStrandLayers = [
    haloMakeStrandLayer(0.22, 0.45, 0.30, 0.55, 1.15, 0.9, 1.1, 20, 90, 0.2),
    haloMakeStrandLayer(0.16, 0.75, 0.58, 0.8, 1.05, 0.7, 0.9, 14, 70, 0.28),
    haloMakeStrandLayer(0.12, 1.0, 1.0, 1.0, 1.0, 0.5, 0.75, 12, 60, 0.32),
    haloMakeStrandLayer(0.45, 1.0, 0.5, 1.8, 0.8, 0.6, 0.35, 4, 16, 0.3),
    haloMakeStrandLayer(0.12, 1.0, 0.85, 1.0, 1.0, 0.5, 0.55, 14, 70, 0.32, 'bounce')
  ];
  haloPulseList = [];
}

// How far out the screen reaches along a given direction. The dial is centred, so the
// visible radius is the distance from the ring's centre to the viewport edge.
function haloVisibleRadius(angle) {
  var s = haloState;
  var cam = haloCam;
  var hw = (s.w / 2) / cam.z;
  var hh = (s.h / 2) / cam.z;
  var ox = s.cx - cam.x;
  var oy = s.cy - cam.y;
  var ca = Math.cos(angle);
  var sa = Math.sin(angle);
  var t = Infinity;
  if (ca > 1e-6) t = Math.min(t, (hw - ox) / ca);
  else if (ca < -1e-6) t = Math.min(t, (-hw - ox) / ca);
  if (sa > 1e-6) t = Math.min(t, (hh - oy) / sa);
  else if (sa < -1e-6) t = Math.min(t, (-hh - oy) / sa);
  if (!isFinite(t)) return 1e9;
  return t;
}

function haloWedgeVisible(wedge, layer) {
  var rot = haloState.ringRot * layer.rotK + layer.off;
  var mid = (wedge.i0 + wedge.n / 2) * layer.step + rot;
  return haloVisibleRadius(mid) > haloState.RO;
}

function haloUpdateStrands(dt, env) {
  var s = haloState;
  for (var p = haloPulseList.length - 1; p >= 0; p--) {
    var pulse = haloPulseList[p];
    pulse.c += pulse.v * dt;
    pulse.life -= dt;
    if (pulse.life <= 0) haloPulseList.splice(p, 1);
  }
  for (var i = 0; i < haloStrandLayers.length; i++) {
    var layer = haloStrandLayers[i];
    for (var w = 0; w < layer.wedges.length; w++) {
      var wedge = layer.wedges[w];
      var rot = s.ringRot * layer.rotK + layer.off;
      var am = haloNormAngle((wedge.i0 + wedge.n / 2) * layer.step + rot);
      wedge.vis = haloWedgeVisible(wedge, layer);
      wedge.flow += dt * wedge.dsp * (0.45 + 2.2 * env);
      if (!wedge.vis) {
        wedge.len *= 0.98;
        continue;
      }
      var hit = 0;
      for (var q = 0; q < haloPulseList.length; q++) {
        var pl = haloPulseList[q];
        var f = Math.min(1, pl.life / 0.5) * Math.min(1, (pl.L - pl.life) / 0.15 + 0.3);
        hit += pl.amp * f * Math.exp(-Math.pow((am - pl.c) / pl.w, 2));
      }
      if (layer.dyn === 'bounce') {
        var idle = wedge.base * (0.36 + 0.14 * Math.sin(s.time * 0.9 + wedge.ph));
        var target = Math.min(1, idle + hit * 0.75 + wedge.kick * 0.6);
        wedge.kick *= Math.exp(-dt * 2.4);
        wedge.len += (target - wedge.len) * Math.min(1, (target > wedge.len ? 15 : 2.2) * dt);
      } else {
        var n1 = 0.5 + 0.5 * Math.sin(s.time * wedge.f1 + wedge.ph);
        var n2 = 0.5 + 0.5 * Math.sin(s.time * wedge.f2 + wedge.ph2);
        var idle2 = wedge.base * (0.4 + 0.34 * n1 + 0.14 * n2);
        var target2 = Math.min(1.05, (idle2 + hit * 0.7 + wedge.kick * 0.55) * wedge.lenS);
        wedge.kick *= Math.exp(-dt * 1.8);
        wedge.len += (target2 - wedge.len) * Math.min(1, (target2 > wedge.len ? 5 : 1.3) * dt);
      }
    }
  }
}

// A beat sends a wave around the ring and kicks a few wedges.
function haloStrandBeat(weight) {
  var dir = Math.random() < 0.5 ? 1 : -1;
  var big = weight > 0.75;
  var pulse = {
    c: dir > 0 ? -Math.PI - 0.15 : Math.PI + 0.15,
    v: dir * haloRand(0.7, 1.6) * (big ? 0.7 : 1),
    w: big ? haloRand(0.25, 0.4) : haloRand(0.05, 0.16),
    amp: big ? 1 : haloRand(0.45, 0.9),
    life: haloRand(1.2, 2.0),
    L: 0
  };
  pulse.L = pulse.life;
  haloPulseList.push(pulse);
  var all = [];
  for (var i = 0; i < haloStrandLayers.length; i++) {
    var wedges = haloStrandLayers[i].wedges;
    for (var j = 0; j < wedges.length; j++) all.push(wedges[j]);
  }
  if (!all.length) return;
  for (var k = 0; k < 2 + ((Math.random() * 5) | 0); k++) {
    var wedge = haloPick(all);
    wedge.kick = haloRand(0.4, 1);
    if (Math.random() < 0.5) wedge.prof = haloMakeProfile(wedge.n);
  }
}

function haloBuildGradients() {
  var s = haloState;
  var ctx = haloCanvasElement();
  ctx = ctx && ctx.getContext ? ctx.getContext('2d') : null;
  if (!ctx) return;
  haloGradient.canvasCtx = ctx;
  var mk = function (stops, r1) {
    var g = ctx.createRadialGradient(s.cx, s.cy, s.RO, s.cx, s.cy, r1);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  };
  haloGradient.s0 = mk([[0, 'rgba(248,248,255,1)'], [0.35, 'rgba(228,226,242,.8)'], [1, 'rgba(190,190,214,.3)']], s.RMAX * 0.95);
  haloGradient.s1 = mk([[0, 'rgba(240,236,255,1)'], [0.3, 'rgba(196,182,244,.82)'], [1, 'rgba(160,140,228,.3)']], s.RMAX * 0.95);
  haloGradient.s2 = mk([[0, 'rgba(225,245,242,1)'], [0.3, 'rgba(176,214,210,.8)'], [1, 'rgba(140,180,186,.3)']], s.RMAX * 0.95);
  haloGradient.hazeAt = -1;
}

function haloDrawStrands(ctx, layer, collect) {
  var s = haloState;
  var span = s.RMAX - s.RO - 20;
  var r0 = s.RO + 3;
  var rot = s.ringRot * layer.rotK + layer.off;
  var edgeAlpha = [0.28, 0.62, 1];
  ctx.lineCap = 'butt';
  for (var i = 0; i < layer.wedges.length; i++) {
    var wedge = layer.wedges[i];
    if (!wedge.vis) continue;
    var L = wedge.len * span * layer.lenK;
    if (L < 3) continue;
    var a0 = haloNormAngle(wedge.i0 * layer.step + rot);
    var a1 = a0 + wedge.n * layer.step;
    var alpha = Math.min(1, wedge.lum * layer.lumK * (0.3 + 0.7 * Math.min(1, wedge.len * 1.8)) * (layer.dyn === 'bounce' ? 1.3 : 1));
    if (alpha < 0.005) continue;
    var lwW = layer.lw * wedge.lwK;
    var paths = [new Path2D(), new Path2D(), new Path2D()];
    for (var k = 0; k < wedge.n; k++) {
      var a = a0 + (k + 0.5) * layer.step;
      var ca = Math.cos(a);
      var sa = Math.sin(a);
      var edge = Math.sin(Math.PI * (k + 0.5) / wedge.n);
      var b = edge < 0.38 ? 0 : (edge < 0.72 ? 1 : 2);
      var pr = wedge.prof[k];
      var l = L * pr * (0.5 + 0.5 * Math.sqrt(edge)) * (0.92 + 0.08 * Math.sin(s.time * wedge.pf[k] + wedge.pp[k]));
      var solid = l * (layer.solidK + 0.3 * pr * (1 - layer.solidK));
      paths[b].moveTo(s.cx + ca * r0, s.cy + sa * r0);
      paths[b].lineTo(s.cx + ca * (r0 + solid), s.cy + sa * (r0 + solid));
      if (!collect) continue;
      var tail = l - solid;
      var da = alpha * edgeAlpha[b];
      if (tail > 6) {
        for (var d = 0; d < 2; d++) {
          var ph = (wedge.flow + wedge.ds[k] + d * 0.5) % 1;
          var s0 = solid + tail * ph;
          var s1 = Math.min(l, s0 + 3 + tail * 0.22 * (1 - ph * 0.5));
          if (s1 > s0) collect.dash.push(ca, sa, s0, s1, da);
        }
      }
      if ((k + ((s.time * 12) | 0)) % 4 === 0) collect.tip.push(ca, sa, l, da);
    }
    ctx.strokeStyle = haloGradient['s' + wedge.tint] || haloGradient.s0;
    ctx.lineWidth = lwW;
    for (var b2 = 0; b2 < 3; b2++) {
      ctx.globalAlpha = alpha * edgeAlpha[b2];
      ctx.stroke(paths[b2]);
    }
    if (wedge.lum > 0.85) {
      ctx.globalAlpha = Math.min(1, alpha * 0.06);
      ctx.lineWidth = lwW * 2.5;
      ctx.stroke(paths[2]);
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- comets

// A comet is a short bundle of bright lines that sweeps in and dies on the ring. It is
// launched before the beat and its progress is a function of the clock, so the head reaches
// the ring exactly on the beat instead of one frame after the launch.
function haloSpawnComet(ang, travel, weight, hitAt) {
  var s = haloState;
  var lines = [];
  var n = Math.max(2, Math.round((8 + (Math.random() * 12 | 0)) * (0.6 + 0.4 * weight)));
  if (Math.random() < 0.6) {
    // concentric arc bundle hugging the ring: the arcs close in on the rim
    var rad = s.R * haloRand(0.55, 0.9);
    var span = haloRand(0.35, 0.9) * (Math.random() < 0.5 ? -1 : 1);
    var gap = haloRand(2.6, 4.4);
    var a0 = ang - span;
    for (var k = 0; k < n; k++) {
      lines.push({ arc: true, r: rad - k * gap + haloGauss() * 0.6, a0: a0 + haloGauss() * 0.01, span: span });
    }
  } else {
    // converging bundle: an inner random point runs out to the rim
    var oa = ang + haloRand(-1.3, 1.3);
    var orad = s.R * haloRand(0.25, 0.75);
    var o = { x: Math.cos(oa) * orad, y: Math.sin(oa) * orad };
    var spread = haloRand(0.08, 0.25);
    var bend = haloRand(0.2, 0.5) * (Math.random() < 0.5 ? -1 : 1);
    for (var i = 0; i < n; i++) {
      var ta = ang + (i / n - 0.5) * spread;
      var p1 = { x: Math.cos(ta) * (s.R - 2), y: Math.sin(ta) * (s.R - 2) };
      var p0 = { x: o.x + haloGauss() * 10, y: o.y + haloGauss() * 10 };
      var mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
      var dx = p1.x - p0.x, dy = p1.y - p0.y;
      lines.push({ p0: p0, c: { x: mx - dy * bend + haloGauss() * 8, y: my + dx * bend + haloGauss() * 8 }, p1: p1 });
    }
  }
  var now = haloPlayheadSeconds();
  haloCometList.push({
    lines: lines,
    life: 0,
    startAt: now,
    endAt: hitAt != null ? hitAt : now + Math.max(0.05, travel),
    win: haloRand(0.22, 0.4),
    glow: Math.random() < 0.4,
    tint: Math.random() < 0.15,
    rot0: s.ringRot,
    hit: false,
    angle: ang
  });
}

function haloCometPoint(line, t) {
  var s = haloState;
  if (!line.arc) {
    var u = 1 - t;
    return {
      x: u * u * line.p0.x + 2 * u * t * line.c.x + t * t * line.p1.x,
      y: u * u * line.p0.y + 2 * u * t * line.c.y + t * t * line.p1.y
    };
  }
  var r = line.r + (s.R - 2 - line.r) * t * t;
  var a = line.a0 + line.span * t;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function haloStrokeComet(ctx, c, t0, t1, steps) {
  ctx.beginPath();
  for (var l = 0; l < c.lines.length; l++) {
    var line = c.lines[l];
    for (var s = 0; s <= steps; s++) {
      var p = haloCometPoint(line, t0 + (t1 - t0) * (s / steps));
      if (s) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    }
  }
  ctx.stroke();
}

// The panel that the comet runs into lights up. This is the link between the streaks and
// the data ring: the beam that lands here is the one that refreshed this panel.
function haloFlashSlotAt(angle) {
  var best = null;
  var bd = 9;
  for (var i = 0; i < haloSlotList.length; i++) {
    var slot = haloSlotList[i];
    var d = Math.abs(haloNormAngle(slot.a + haloState.ringRot - angle));
    if (d < bd) { bd = d; best = slot; }
  }
  if (best && bd < 0.12) best.flash = Math.max(best.flash, 0.8);
  return best;
}

function haloUpdateComets(dt) {
  for (var i = haloCometList.length - 1; i >= 0; i--) {
    var c = haloCometList[i];
    c.life += dt;
    if (c.life > (c.endAt - c.startAt) + 0.3) {
      haloCometList.splice(i, 1);
      continue;
    }
    if (!c.hit && haloPlayheadSeconds() >= c.endAt) {
      c.hit = true;
      haloFlashSlotAt(c.angle + (haloState.ringRot - c.rot0));
    }
  }
}

function haloDrawComets(ctx) {
  var s = haloState;
  var t = haloPlayheadSeconds();
  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (var i = 0; i < haloCometList.length; i++) {
    var c = haloCometList[i];
    var span = Math.max(0.03, c.endAt - c.startAt);
    var p = haloEaseIO(haloClamp((t - c.startAt) / span, 0, 1));
    var head = Math.min(1, p * (1 + c.win));
    var tail = Math.max(0, p * (1 + c.win) - c.win);
    var fade = c.life > span ? Math.max(0, 1 - (c.life - span) / 0.25) : 1;
    if (fade <= 0) continue;
    ctx.save();
    ctx.rotate(s.ringRot - c.rot0);
    var col = c.tint ? '200,190,250' : '255,255,255';
    ctx.strokeStyle = 'rgba(' + col + ',' + (0.5 * fade).toFixed(3) + ')';
    ctx.lineWidth = 1;
    haloStrokeComet(ctx, c, tail, head, 16);
    var hs = head - (head - tail) * 0.35;
    ctx.strokeStyle = 'rgba(' + col + ',' + fade.toFixed(3) + ')';
    ctx.lineWidth = 1.7;
    haloStrokeComet(ctx, c, hs, head, 7);
    if (c.glow) {
      ctx.strokeStyle = 'rgba(' + col + ',' + (0.28 * fade).toFixed(3) + ')';
      ctx.lineWidth = 3.2;
      haloStrokeComet(ctx, c, hs, head, 5);
    }
    ctx.restore();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- fly-outs

var HALO_FLYER_COUNT = 170;      // the original keeps up to 2250
var HALO_FLY_BURST_K = 0.3;      // the original fires 42..132 lines per burst

function haloNewFlyBand() {
  return { a: haloRand(0, HALO_TAU), w: haloRand(0.01, 0.05), life: haloRand(2, 6) };
}

function haloNewFlyer(init) {
  var a;
  if (Math.random() < 0.5 && haloFlyBands.length) {
    var b = haloPick(haloFlyBands);
    a = b.a + haloGauss() * b.w;
  } else {
    a = haloRand(0, HALO_TAU);
  }
  var s = haloState;
  return {
    a: a - s.ringRot,
    len: 20 + Math.pow(Math.random(), 2) * 320,
    r: init ? haloRand(s.RO, s.RMAX) : s.RO + haloRand(0, 25),
    sp: haloRand(260, 900),
    lw: Math.random() < 0.08 ? haloRand(1.2, 1.7) : haloRand(0.5, 1),
    lv: Math.random() < 0.12 ? 1 : 0,
    tint: Math.random() < 0.22 ? 1 : 0,
    burst: false
  };
}

function haloBuildFlyers() {
  haloFlyBands = [];
  for (var i = 0; i < 7; i++) haloFlyBands.push(haloNewFlyBand());
  haloFlyerList = [];
  var count = Math.min(HALO_FLYER_COUNT, Math.round(40 + haloState.w * 0.07));
  for (var k = 0; k < count; k++) haloFlyerList.push(haloNewFlyer(true));
}

function haloUpdateFlyers(dt, env) {
  for (var b = 0; b < haloFlyBands.length; b++) {
    var band = haloFlyBands[b];
    band.life -= dt;
    if (band.life <= 0) {
      band.a = haloRand(0, HALO_TAU);
      band.w = haloRand(0.01, 0.05);
      band.life = haloRand(2, 6);
    }
  }
  var k = 0.7 + 0.9 * env;
  for (var i = haloFlyerList.length - 1; i >= 0; i--) {
    var f = haloFlyerList[i];
    f.r += f.sp * dt * k;
    if (f.r - f.len > haloState.RMAX) {
      if (f.burst) haloFlyerList.splice(i, 1);
      else haloFlyerList[i] = haloNewFlyer(false);
    }
  }
}

function haloSpawnFlyBurst() {
  var s = haloState;
  var a = haloRand(0, HALO_TAU) * 0.95;
  var n = Math.max(1, Math.round((14 + (Math.random() * 30 | 0)) * HALO_FLY_BURST_K));
  var spread = haloRand(0.01, 0.045);
  var sp = haloRand(450, 1150);
  var len = haloRand(70, 320);
  var r0 = s.RO + haloRand(0, 8);
  var tint = Math.random() < 0.3 ? 1 : 0;
  var lv = Math.random() < 0.45 ? 2 : 1;
  for (var i = 0; i < n; i++) {
    haloFlyerList.push({
      a: a + (i / n - 0.5) * spread + haloGauss() * 0.0015 - s.ringRot,
      len: len * haloRand(0.7, 1.15),
      r: r0 - haloRand(0, len * 0.35),
      sp: sp * haloRand(0.92, 1.08),
      lw: Math.random() < 0.2 ? 1.3 : haloRand(0.6, 1),
      lv: lv,
      tint: tint,
      burst: true
    });
  }
}

// The streaks are bucketed by their paint style so one path covers many of them. The
// original only had to keep them inside its own half-plane; a centred ring needs the
// screen-space test, otherwise the streaks on the far side of the ring are drawn for
// nothing.
var HALO_FLY_A = [0.16, 0.36, 0.7];

function haloDrawFlyers(ctx, bursts) {
  var s = haloState;
  var buckets = {};
  var order = [];
  for (var i = 0; i < haloFlyerList.length; i++) {
    var f = haloFlyerList[i];
    if (f.burst !== bursts) continue;
    var a = haloNormAngle(f.a + s.ringRot);
    var reach = haloVisibleRadius(a);
    if (f.r - f.len > reach) continue;
    var key = f.tint * 10 + f.lv + (f.lw > 1.15 ? 100 : 0) + (f.burst ? 1000 : 0);
    if (!buckets[key]) { buckets[key] = []; order.push(key); }
    buckets[key].push(f, a);
  }
  ctx.globalCompositeOperation = 'lighter';
  for (var oi = 0; oi < order.length; oi++) {
    var key2 = order[oi];
    var arr = buckets[key2];
    var f0 = arr[0];
    ctx.strokeStyle = f0.tint ? (haloGradient.s1 || '#fff') : (haloGradient.s0 || '#fff');
    ctx.globalAlpha = Math.min(1, HALO_FLY_A[f0.lv] * (f0.burst ? 1.4 : 0.9));
    ctx.lineWidth = ((key2 % 1000) >= 100 ? 1.5 : 0.8);
    ctx.beginPath();
    for (var k = 0; k < arr.length; k += 2) {
      var fly = arr[k];
      var ang = arr[k + 1];
      var r0 = Math.max(s.RO + 3, fly.r - fly.len);
      var r1 = fly.r;
      if (r1 <= r0) continue;
      var ca = Math.cos(ang);
      var sa = Math.sin(ang);
      ctx.moveTo(s.cx + ca * r0, s.cy + sa * r0);
      ctx.lineTo(s.cx + ca * r1, s.cy + sa * r1);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- haze and flares

var HALO_HAZE_COUNT = 10;         // the original keeps 22
var HALO_HAZE_STEP = 0.0038;      // the original's angular step between haze lines

function haloHash(x) {
  var s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// A fan of thin lines. The step is stretched with the density knob: the haze is the most
// stroke-hungry layer in the original and it only reads as a soft band.
function haloRadialLines(ctx, a0, a1, step, r0, L, seed, lo) {
  ctx.beginPath();
  var k = 0;
  for (var a = a0; a < a1; a += step, k++) {
    var l = L * (lo + (1 - lo) * haloHash(k + seed));
    var ca = Math.cos(a);
    var sa = Math.sin(a);
    ctx.moveTo(haloState.cx + ca * r0, haloState.cy + sa * r0);
    ctx.lineTo(haloState.cx + ca * (r0 + l), haloState.cy + sa * (r0 + l));
  }
}

function haloSpawnHaze(init) {
  var k = Math.random();
  haloHazeList.push({
    a: haloRand(0, HALO_TAU) - haloState.ringRot,
    w: Math.random() < 0.7 ? haloRand(0.015, 0.07) : haloRand(0.08, 0.18),
    len: haloRand(0.35, 1),
    cur: init ? haloRand(0.2, 0.8) : 0,
    age: init ? haloRand(0, 0.5) : 0,
    life: haloRand(0.35, 1.6),
    alpha: haloRand(0.12, 0.42),
    tint: k < 0.55 ? 0 : k < 0.85 ? 1 : 2,
    drift: haloRand(-0.04, 0.04),
    seed: Math.random() * 1000
  });
}

function haloSpawnFlare(a) {
  haloFlareList.push({
    a: a == null ? haloRand(0, HALO_TAU) * 0.95 - haloState.ringRot : a,
    w: haloRand(0.006, 0.04),
    len: haloRand(18, 110),
    age: 0,
    life: haloRand(0.2, 0.55),
    alpha: haloRand(0.6, 1),
    seed: Math.random() * 1000
  });
}

function haloHazeEnv(h) {
  var a = Math.min(1, h.age / 0.12);
  var o = h.age > h.life ? Math.max(0, 1 - (h.age - h.life) / 0.6) : 1;
  return a * o * (0.85 + 0.15 * Math.sin(h.age * 30));
}

function haloUpdateHaze(dt) {
  for (var i = haloHazeList.length - 1; i >= 0; i--) {
    var h = haloHazeList[i];
    h.age += dt;
    h.cur += (h.len - h.cur) * Math.min(1, 9 * dt);
    if (h.age > h.life + 0.6) haloHazeList.splice(i, 1);
  }
  while (haloHazeList.length < HALO_HAZE_COUNT && Math.random() < 0.25) haloSpawnHaze(false);
  for (var j = haloFlareList.length - 1; j >= 0; j--) {
    var f = haloFlareList[j];
    f.age += dt;
    if (f.age > f.life) haloFlareList.splice(j, 1);
  }
  if (Math.random() < 0.06 * 2) haloSpawnFlare();
}

function haloBuildHazeGradients() {
  var s = haloState;
  if (haloGradient.hazeAt === s.RMAX) return;
  haloGradient.hazeAt = s.RMAX;
  var ctx = haloGradient.canvasCtx;
  if (!ctx) return;
  var mk = function (stops, r1) {
    var g = ctx.createRadialGradient(s.cx, s.cy, s.RO, s.cx, s.cy, r1);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  };
  haloGradient.h0 = mk([[0, 'rgba(205,190,255,.95)'], [0.25, 'rgba(180,165,240,.7)'], [0.7, 'rgba(150,135,215,.25)'], [1, 'rgba(120,110,190,0)']], s.RMAX);
  haloGradient.h1 = mk([[0, 'rgba(250,250,255,1)'], [0.2, 'rgba(225,225,240,.65)'], [0.65, 'rgba(200,200,225,.2)'], [1, 'rgba(180,180,210,0)']], s.RMAX);
  haloGradient.h2 = mk([[0, 'rgba(210,230,225,.9)'], [0.25, 'rgba(180,210,205,.6)'], [0.7, 'rgba(150,185,180,.22)'], [1, 'rgba(120,160,155,0)']], s.RMAX);
}

function haloDrawHaze(ctx) {
  var s = haloState;
  haloBuildHazeGradients();
  var span = s.RMAX - s.RO - 20;
  var r0 = s.RO + 3;
  var step = HALO_HAZE_STEP * 0.55 / Math.max(0.15, HALO_STRAND_DENSITY);
  ctx.globalCompositeOperation = 'lighter';
  for (var i = 0; i < haloHazeList.length; i++) {
    var h = haloHazeList[i];
    var e = haloHazeEnv(h);
    if (e <= 0.01) continue;
    var L = h.cur * span;
    if (L < 4) continue;
    var mid = h.a + s.ringRot + h.drift * h.age;
    haloRadialLines(ctx, mid - h.w / 2, mid + h.w / 2, step, r0, L, h.seed, 0.45);
    ctx.strokeStyle = haloGradient['h' + h.tint] || haloGradient.h1;
    ctx.globalAlpha = Math.min(1, h.alpha * e * 0.05);
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.globalAlpha = Math.min(1, h.alpha * e * 0.6);
    ctx.lineWidth = 0.55;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function haloDrawFlares(ctx) {
  var s = haloState;
  var span = s.RMAX - s.RO - 20;
  var r0 = s.RO + 3;
  var step = HALO_HAZE_STEP * 0.45 / Math.max(0.15, HALO_STRAND_DENSITY);
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = haloGradient.s0 || '#fff';
  for (var i = 0; i < haloFlareList.length; i++) {
    var f = haloFlareList[i];
    var t = f.age / f.life;
    var e = (t < 0.15 ? t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 2)) * f.alpha;
    if (e <= 0.01) continue;
    var L = f.len * (0.6 + 0.4 * haloEaseOut(Math.min(1, t * 3)));
    var mid = f.a + s.ringRot;
    haloRadialLines(ctx, mid - f.w / 2, mid + f.w / 2, step, r0, L, f.seed, 0.4);
    ctx.globalAlpha = Math.min(1, e * 0.06);
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.globalAlpha = Math.min(1, e);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- drawing

// The panels that were re-rendered outside a beat are shown at the start of the frame.
var haloFreshList = [];

function haloSwapFreshPanels() {
  for (var i = haloFreshList.length - 1; i >= 0; i--) {
    var slot = haloFreshList[i];
    if (slot.next) {
      slot.c = slot.next;
      slot.next = null;
    }
    haloFreshList.splice(i, 1);
  }
}

function haloDrawWeb(ctx) {
  var s = haloState;
  if (!haloWeb) return;
  var ws = 2 * s.R + 4;
  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.rotate(s.webRot);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.92;
  ctx.drawImage(haloWeb, -s.R - 2, -s.R - 2, ws, ws);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (var i = 0; i < haloRunnerList.length; i++) {
    var r = haloRunnerList[i];
    if (!r.curve) continue;
    ctx.strokeStyle = r.bright ? 'rgba(240,166,198,0.45)' : 'rgba(250,251,255,0.38)';
    ctx.lineWidth = r.bright ? 1.3 : 0.9;
    ctx.beginPath();
    ctx.moveTo(r.ox, r.oy);
    ctx.lineTo(r.px, r.py);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

// The data ring: a black band with the panels set into it, then the rim hairlines and
// ticks that give the edge its thickness.
function haloDrawRing(ctx, dt) {
  var s = haloState;
  var band = s.RO - s.R;
  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, s.RO, 0, HALO_TAU);
  ctx.arc(0, 0, s.R, 0, HALO_TAU, true);
  ctx.fillStyle = '#040506';
  ctx.fill('evenodd');
  for (var i = 0; i < haloSlotList.length; i++) {
    var slot = haloSlotList[i];
    if (slot.flash > 0) slot.flash = Math.max(0, slot.flash - dt * 2.2);
    if (!slot.c) continue;
    if (!haloSlotVisible(slot)) continue;
    var A = slot.a + s.ringRot;
    var hh = slot.hpx + 2;
    ctx.save();
    ctx.rotate(A);
    ctx.drawImage(slot.c, s.R, -hh / 2, band, hh);
    if (slot.flash > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = slot.flash;
      ctx.drawImage(slot.c, s.R, -hh / 2, band, hh);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }
  haloDrawRim(ctx);
  ctx.restore();
}

// Ticks are culled against the viewport instead of the original's half-plane test: the
// original's ring sat at the left edge, this one sits in the middle.
function haloRingTicks(stepRad, fn) {
  var s = haloState;
  var count = Math.ceil(HALO_TAU / stepRad);
  for (var n = 0; n < count; n++) {
    var a = n * stepRad + s.ringRot;
    if (haloVisibleRadius(a) < s.R) continue;
    fn(Math.cos(a), Math.sin(a), n, a);
  }
}

function haloDrawRim(ctx) {
  var s = haloState;
  var RB = haloRimWidth();
  var pulse = s.ringPulse || 0;
  ctx.beginPath();
  var step = 0.5 * Math.PI / 180;
  haloRingTicks(step, function (ca, sa, n) {
    var m = ((n % 6) + 6) % 6;
    var li = m === 0 ? RB : RB * (0.5 + 0.35 * haloHash(n));
    var lo = m === 0 ? RB : RB * (0.5 + 0.35 * haloHash(n + 77));
    ctx.moveTo(ca * (s.R + 1.5), sa * (s.R + 1.5));
    ctx.lineTo(ca * (s.R + 1.5 + li), sa * (s.R + 1.5 + li));
    ctx.moveTo(ca * (s.RO - 1.5), sa * (s.RO - 1.5));
    ctx.lineTo(ca * (s.RO - 1.5 - lo), sa * (s.RO - 1.5 - lo));
  });
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(232,235,242,' + Math.min(1, 0.10 + 0.5 * pulse).toFixed(3) + ')';
  ctx.lineWidth = 2.6 + 3 * pulse;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(232,235,242,' + Math.min(1, 0.32 + 0.5 * pulse).toFixed(3) + ')';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(240,242,248,0.88)';
  ctx.lineWidth = 0.55;
  ctx.stroke();
  var arc = function (r, lw, a) {
    ctx.strokeStyle = 'rgba(232,235,242,' + a + ')';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, HALO_TAU);
    ctx.stroke();
  };
  arc(s.R, 1.5, 1);
  arc(s.R + RB + 3, 0.6, 0.6);
  arc(s.RO - RB - 3, 0.6, 0.55);
  ctx.globalCompositeOperation = 'lighter';
  arc(s.RO, 3.5, 0.1);
  ctx.globalCompositeOperation = 'source-over';
  arc(s.RO, 1.3, 0.95);
  ctx.beginPath();
  haloRingTicks(1 * Math.PI / 180, function (ca, sa) {
    ctx.moveTo(ca * (s.R - 2), sa * (s.R - 2));
    ctx.lineTo(ca * (s.R - 5), sa * (s.R - 5));
  });
  haloRingTicks(0.25 * Math.PI / 180, function (ca, sa, n) {
    var m = ((n % 20) + 20) % 20;
    var L = m === 0 ? 9 : m % 5 === 0 ? 5 : 2.5;
    ctx.moveTo(ca * (s.RO + 2), sa * (s.RO + 2));
    ctx.lineTo(ca * (s.RO + 2 + L), sa * (s.RO + 2 + L));
  });
  ctx.strokeStyle = 'rgba(230,233,240,0.5)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
}

// The lyric lines ride the inner rim. Each character is set on the tangent of its own
// angle; the lower half is flipped so the text is never upside down.
function haloDrawLyricText(ctx) {
  var s = haloState;
  var items = haloLyric.items;
  if (!items.length) return;
  var radius = s.R - Math.max(11, s.band * 0.2);
  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.font = '600 ' + HALO_LYRIC_FONT_PX + 'px ' + HALO_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var center = item.angle + s.ringRot;
    if (haloVisibleRadius(center) < radius) continue;
    var current = i === haloLyric.current;
    var near = Math.abs(haloNormAngle(center - HALO_READ_ANGLE));
    var focus = current ? 1 : Math.max(0.12, 1 - near * 1.6);
    var alpha = current ? 1 : 0.16 + 0.5 * focus;
    var size = current ? HALO_LYRIC_FONT_PX : HALO_LYRIC_FONT_PX * 0.92;
    ctx.font = '600 ' + size.toFixed(1) + 'px ' + HALO_FONT;
    ctx.fillStyle = 'rgba(238,241,248,' + alpha.toFixed(3) + ')';
    var acc = 0;
    for (var c = 0; c < item.chars.length; c++) {
      var w = item.widths[c] * item.scale;
      var a = center + (acc + w / 2 - item.totalWidth / 2) / radius;
      acc += w;
      var ca = Math.cos(a);
      var sa = Math.sin(a);
      var flip = sa > 0;
      ctx.save();
      ctx.translate(ca * radius, sa * radius);
      ctx.rotate(flip ? a - Math.PI / 2 : a + Math.PI / 2);
      ctx.fillText(item.chars[c], 0, 0);
      ctx.restore();
    }
    if (item.sub && (current || near < 0.9)) {
      var mid = center;
      ctx.save();
      ctx.translate(Math.cos(mid) * (radius - HALO_LYRIC_FONT_PX * 1.5), Math.sin(mid) * (radius - HALO_LYRIC_FONT_PX * 1.5));
      ctx.rotate(Math.sin(mid) > 0 ? mid - Math.PI / 2 : mid + Math.PI / 2);
      ctx.font = '400 11px ' + HALO_FONT;
      ctx.fillStyle = 'rgba(226,230,240,' + (alpha * 0.5).toFixed(3) + ')';
      ctx.fillText(item.sub, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

// The click shoots a line out of the dial. The shot starts inside the ring and runs
// through the rim, and the panel it crosses lights up.
var haloEmitList = [];

function haloEmitFromPoint(px, py) {
  var s = haloState;
  var cam = haloCam;
  var wx = (px - s.w / 2) / cam.z + cam.x;
  var wy = (py - s.h / 2) / cam.z + cam.y;
  var dx = wx - s.cx;
  var dy = wy - s.cy;
  var r = Math.hypot(dx, dy);
  var ang = Math.atan2(dy, dx);
  var inner = Math.min(r, s.R * 0.82);
  var p0 = { x: s.cx + Math.cos(ang) * inner, y: s.cy + Math.sin(ang) * inner };
  var p1 = { x: s.cx + Math.cos(ang) * (s.RO + 60), y: s.cy + Math.sin(ang) * (s.RO + 60) };
  haloEmitList.push({
    p0: p0,
    p1: p1,
    age: 0,
    life: 0.55,
    bend: haloRand(-0.25, 0.25)
  });
  haloFlashSlotAt(ang);
}

function haloUpdateEmits(dt) {
  for (var i = haloEmitList.length - 1; i >= 0; i--) {
    var e = haloEmitList[i];
    e.age += dt;
    if (e.age > e.life) haloEmitList.splice(i, 1);
  }
}

function haloDrawEmits(ctx) {
  var s = haloState;
  if (!haloEmitList.length) return;
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (var i = 0; i < haloEmitList.length; i++) {
    var e = haloEmitList[i];
    var k = haloEaseOut(Math.min(1, e.age / e.life));
    var fade = 1 - Math.max(0, (e.age - e.life * 0.55) / (e.life * 0.45));
    if (fade <= 0) continue;
    var mx = (e.p0.x + e.p1.x) / 2;
    var my = (e.p0.y + e.p1.y) / 2;
    var dx = e.p1.x - e.p0.x;
    var dy = e.p1.y - e.p0.y;
    var cx2 = mx - dy * e.bend;
    var cy2 = my + dx * e.bend;
    var steps = 16;
    ctx.beginPath();
    for (var q = 0; q <= steps; q++) {
      var t = (q / steps) * k;
      var u = 1 - t;
      var x = u * u * e.p0.x + 2 * u * t * cx2 + t * t * e.p1.x;
      var y = u * u * e.p0.y + 2 * u * t * cy2 + t * t * e.p1.y;
      if (q) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = 'rgba(235,240,255,' + (0.9 * fade).toFixed(3) + ')';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(200,214,255,' + (0.22 * fade).toFixed(3) + ')';
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- callout

var HALO_CALLOUT_ANGLE = -Math.PI * 0.74;
var haloCalloutState = { text: null, sub: null, shown: false, w: 220, h: 64 };

function haloUpdateCalloutText() {
  var el = haloCalloutElement();
  if (!el) return;
  var items = haloLyric.items;
  var idx = haloLyric.current;
  if (idx < 0 || idx >= items.length) {
    if (haloCalloutState.shown) {
      el.style.opacity = '0';
      haloCalloutState.shown = false;
    }
    return;
  }
  var item = items[idx];
  if (item.text !== haloCalloutState.text || item.sub !== haloCalloutState.sub) {
    haloCalloutState.text = item.text;
    haloCalloutState.sub = item.sub;
    var body = document.getElementById('halo-callout-text');
    var sub = document.getElementById('halo-callout-sub');
    if (body) body.textContent = item.text;
    if (sub) {
      sub.textContent = item.sub || '';
      sub.style.display = item.sub ? '' : 'none';
    }
    haloCalloutState.w = el.offsetWidth || 220;
    haloCalloutState.h = el.offsetHeight || 64;
  }
  if (!haloCalloutState.shown) {
    el.style.opacity = '1';
    haloCalloutState.shown = true;
  }
}

function haloDrawCallout(ctx) {
  var el = haloCalloutElement();
  if (!el) return;
  haloUpdateCalloutText();
  var s = haloState;
  var anchor = haloToScreen(s.cx + Math.cos(HALO_CALLOUT_ANGLE) * (s.RO + 18), s.cy + Math.sin(HALO_CALLOUT_ANGLE) * (s.RO + 18));
  var bw = haloCalloutState.w;
  var bh = haloCalloutState.h;
  var bx = haloClamp(anchor.x - bw - 26, 12, Math.max(12, s.w - bw - 12));
  var by = haloClamp(anchor.y - bh / 2, 12, Math.max(12, s.h - bh - 12));
  el.style.transform = 'translate(' + bx.toFixed(1) + 'px,' + by.toFixed(1) + 'px)';
  ctx.strokeStyle = 'rgba(230,233,238,0.55)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(bx + bw, by + bh / 2);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(anchor.x - 1.5, anchor.y - 1.5, 3, 3);
}

// ---------------------------------------------------------------- frame

function haloDrawStrandTips(ctx, collect) {
  var s = haloState;
  var r0 = s.RO + 3;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.05;
  var levels = [0.35, 0.65, 1];
  for (var lv = 0; lv < levels.length; lv++) {
    ctx.globalAlpha = Math.min(1, levels[lv] * 0.75);
    ctx.beginPath();
    var dp = collect.dash;
    for (var i = 0; i < dp.length; i += 5) {
      var a = dp[i + 4];
      if (a > levels[lv] || a <= levels[lv] - 0.35) continue;
      ctx.moveTo(s.cx + dp[i] * (r0 + dp[i + 2]), s.cy + dp[i + 1] * (r0 + dp[i + 2]));
      ctx.lineTo(s.cx + dp[i] * (r0 + dp[i + 3]), s.cy + dp[i + 1] * (r0 + dp[i + 3]));
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (var j = 0; j < collect.tip.length; j += 4) {
    ctx.globalAlpha = Math.min(1, collect.tip[j + 3] * 1.2);
    var r = r0 + collect.tip[j + 2];
    ctx.fillRect(s.cx + collect.tip[j] * r - 0.8, s.cy + collect.tip[j + 1] * r - 0.8, 1.6, 1.6);
  }
  ctx.globalAlpha = 1;
}

function haloDrawFrame(ctx, dt) {
  var s = haloState;
  var scale = s.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#08090b';
  ctx.fillRect(0, 0, s.w * scale, s.h * scale);

  // the mesh and the spectrum sit a little further back than the ring
  haloApplyCameraTransform(ctx, scale, 0.9);
  haloDrawWeb(ctx);
  haloApplyCameraTransform(ctx, scale, 0.94);
  haloDrawSpectrumSpokes(ctx);

  haloApplyCameraTransform(ctx, scale, 1);
  haloDrawComets(ctx);
  haloDrawEmits(ctx);

  haloApplyCameraTransform(ctx, scale, 0.95);
  haloDrawHaze(ctx);
  haloDrawStrands(ctx, haloStrandLayers[0], null);
  haloDrawStrands(ctx, haloStrandLayers[1], null);
  haloDrawFlyers(ctx, false);

  haloApplyCameraTransform(ctx, scale, 1);
  var collect = { dash: [], tip: [] };
  haloDrawStrands(ctx, haloStrandLayers[2], collect);
  haloDrawStrands(ctx, haloStrandLayers[4], collect);
  haloDrawStrands(ctx, haloStrandLayers[3], null);
  haloDrawStrandTips(ctx, collect);
  haloDrawFlyers(ctx, true);
  haloDrawFlares(ctx);

  haloDrawRing(ctx, dt);
  haloDrawLyricText(ctx);
  haloDrawCallout(ctx);
}

// ---------------------------------------------------------------- lifecycle

var haloLayerBound = false;

function haloEnsureLayer() {
  var layer = haloLayerElement();
  var canvas = haloCanvasElement();
  if (!layer || !canvas) return false;
  if (!haloLayerBound) {
    haloLayerBound = true;
    canvas.addEventListener('pointerdown', haloOnPointerDown);
    window.addEventListener('resize', function () {
      if (haloPresetIsActive()) haloRebuild();
    });
  }
  return true;
}

function haloOnPointerDown(ev) {
  if (!haloPresetIsActive()) return;
  var canvas = haloCanvasElement();
  if (!canvas) return;
  var rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  var s = haloState;
  var px = (ev.clientX - rect.left) * (s.w / rect.width);
  var py = (ev.clientY - rect.top) * (s.h / rect.height);
  haloEmitFromPoint(px, py);
}

// The lyric arc depends on the radius, so a resize rebuilds the dial as well.
function haloRebuild() {
  if (!haloResize()) return false;
  haloBuildLyricRing();
  haloLyricUpdate(haloPlayheadSeconds());
  return true;
}

function haloRenderFrame(canvas, now, dt) {
  var s = haloState;
  if (!s.ready) return false;
  var t = haloPlayheadSeconds();
  s.time = t;
  // The lyrics may have changed (a new song, or the translation arrived).
  if (haloLyricSignature() !== haloLyric.songKey) {
    haloBuildLyricRing();
  }
  haloCameraUpdate(t);
  haloLyricUpdate(t);
  s.ringRot = haloLyric.rot;
  haloReadAudioBands(t);
  haloScheduleBeats(t);
  haloRunBeatEvents(t);
  var env = haloAudio.level;
  haloUpdateRunners(dt, 0.5 + 2.5 * env);
  haloUpdateStrands(dt, env);
  haloUpdateComets(dt);
  haloUpdateFlyers(dt, env);
  haloUpdateHaze(dt);
  haloUpdateEmits(dt);
  haloSwapFreshPanels();
  s.webRot += dt * (0.03 + env * 0.12);
  s.ringPulse = Math.max(0, (s.ringPulse || 0) - dt * 2.4);
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;
  var started = performance.now();
  try {
    haloDrawFrame(ctx, dt);
  } catch (err) {
    haloPresetState.engineError = String((err && err.message) || err);
    return false;
  }
  haloPresetState.draws += 1;
  haloPresetState.lastDrawAt = now;
  haloPresetState.lastCostMs = Math.round((performance.now() - started) * 100) / 100;
  haloPresetState.lastT = t;
  return true;
}

// Called from the main loop every frame (cheap when the preset is not selected).
function updateHaloLayer(now, dt) {
  if (!haloPresetIsActive()) {
    if (haloPresetState.active) haloReleaseHaloLayer();
    return false;
  }
  if (!haloEnsureLayer()) return false;
  haloPresetState.active = true;
  var layer = haloLayerElement();
  if (layer && layer.className.indexOf('active') < 0) layer.classList.add('active');
  var canvas = haloCanvasElement();
  if (!canvas) return false;
  if (!haloState.ready) {
    if (!haloRebuild()) return false;
  }
  var gate = window.__mineradioMainFrameGates && window.__mineradioMainFrameGates.halo;
  var step = gate && typeof consumeFrameGate === 'function'
    ? consumeFrameGate(gate, now, dt, HALO_FPS, false, 'halo-layer')
    : Math.max(0, Number(dt) || 0);
  if (step <= 0) {
    haloPresetState.skips += 1;
    return false;
  }
  return haloRenderFrame(canvas, now, step);
}

// Switching the preset must take effect immediately: with nothing playing the main loop
// parks, so a frame-driven-only switch would leave the layer stale.
function applyHaloPresetNow() {
  try {
    updateHaloLayer(typeof performance !== 'undefined' ? performance.now() : Date.now(), 16);
  } catch (_) {}
  if (typeof applyVisualTakeoverNow === 'function') applyVisualTakeoverNow();
  return haloPresetStatus();
}

function haloReleaseHaloLayer() {
  var canvas = haloCanvasElement();
  if (canvas) {
    canvas.width = 2;
    canvas.height = 2;
    canvas.style.width = '';
    canvas.style.height = '';
    var ctx = canvas.getContext('2d');
    if (ctx) { try { ctx.clearRect(0, 0, 2, 2); } catch (_) {} }
  }
  var layer = haloLayerElement();
  if (layer) layer.classList.remove('active');
  var callout = haloCalloutElement();
  if (callout) callout.style.opacity = '0';
  haloState.ready = false;
  haloPresetState.active = false;
  haloSlotList = [];
  haloRunnerList = [];
  haloCometList = [];
  haloStrandLayers = [];
  haloFlyerList = [];
  haloFlyBands = [];
  haloHazeList = [];
  haloFlareList = [];
  haloEmitList = [];
  haloFreshList = [];
  haloWeb = null;
  haloWebCurves = [];
  haloLyric.items = [];
  haloLyric.current = -1;
  haloLyric.pending = -1;
  haloLyric.tween = null;
  haloLyric.songKey = '';
  haloCalloutState.shown = false;
  haloCalloutState.text = null;
  haloCalloutState.sub = null;
  haloPresetState.released += 1;
}

function haloPresetStatus() {
  return {
    index: HALO_PRESET_INDEX,
    active: haloPresetState.active,
    layerPresent: !!haloLayerElement(),
    canvas: (function () { var c = haloCanvasElement(); return c ? { w: c.width, h: c.height } : null; })(),
    ready: haloState.ready,
    ring: {
      r: Math.round(haloState.R),
      band: Math.round(haloState.band),
      slots: haloSlotList.length,
      strands: haloStrandLayers.length
    },
    lyric: { lines: haloLyric.items.length, current: haloLyric.current, key: haloLyric.songKey },
    beat: { source: haloBeat.source, count: haloBeat.count },
    audio: {
      level: Math.round(haloAudio.level * 1000) / 1000,
      bands: haloAudio.bands.slice()
    },
    draws: haloPresetState.draws,
    skips: haloPresetState.skips,
    released: haloPresetState.released,
    lastT: haloPresetState.lastT,
    lastCostMs: haloPresetState.lastCostMs,
    error: haloPresetState.engineError
  };
}

// A preset that replaces the scene has to say so: the mask suppresses the layers below while
// it is active, and releasing it brings them back untouched.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'halo-layer',
    isActive: haloPresetIsActive,
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
