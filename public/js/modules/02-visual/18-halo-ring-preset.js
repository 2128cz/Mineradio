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
// Five deliberate departures from the original, all in docs/PLAN_HALO_RING.md §0.2:
//   - the camera never moves by itself. The original flies between random marks on every
//     beat, which reads as jumping around the screen; here the camera belongs to the
//     user (drag to pan, wheel to zoom) and the beat only makes the ring pop and shake.
//   - the dial's centre sits off the left edge, so only the ring's right side is on
//     screen. The original pinned it to cx = W * 0.07 and lost half the circumference.
//   - the lyrics are a left-aligned list bent along the radial lines outside the rim,
//     not characters distributed around the inner rim.
//   - the spectrum drives the outermost beams; the coloured spoke wheel that used to sit
//     inside the dial is gone.
//   - the glow composite is replaced by wide 'lighter' strokes on the single canvas,
//     so the layer costs one rasterization pass instead of two plus a blur.
//
// The ring turns with the lyrics rather than at random: the rotation target is derived
// from the line's own start time, and the turn begins rotLead seconds before the line is
// sung, so the line lands on the read mark exactly when it starts.

var HALO_PRESET_INDEX = 14;        // tracks MAX_VISUAL_PRESET_INDEX (four places)
var HALO_FPS = 30;                 // the layer's own frame gate
var HALO_LYRIC_BASE_PX = 20;       // lyric text size at fx.lyricScale = 1
var HALO_PREPARE_MS = 300;         // beat phase 1: prepare what lands on the beat
// The beams still have to land on the beat, so the flight time is also how early they are
// sent. They used to cross in 80-250 ms - about five frames - and a passage with two beats a
// second put several of those streaks on the ring at once, which read as a flicker rather
// than as light running in. A slower flight is a longer flight, so the look-ahead has to
// cover it.
var HALO_TRAVEL_FAST = 0.55;       // beam flight time (lands on the beat)
var HALO_TRAVEL_SLOW = 0.9;        // converging bundle flight time
var HALO_BEAT_LOOKAHEAD = 1.2;     // how far ahead the beat map is read
// How often the ring may pop at all. A pop takes about a quarter of a second to grow and start
// dying, so two closer than that are one buzz the eye cannot read as two beats - and a map is
// allowed to lay a grid that fine under a fast song.
var HALO_BEAT_MIN_GAP = 0.24;
var HALO_PULSE_DECAY = 2.4;        // how fast the beat's scale pop dies down
var HALO_LEVEL_FLOOR = 0.06;        // analyser level below which nothing is playing
// The level is a loudness, and a beat only needs a yes or a no from it: once the sound is
// there, this is the part of the beat that survives. Below 1 the ring still answers a
// quiet passage, it just does not answer a silent one.
var HALO_GATE_KEEP = 0.55;
// Radians of arc the 40 Hz-12 kHz sweep spans. The whole circle, so every point on the ring
// stands on its own frequency and no stretch of it is a clamped plateau; half a circle left
// the back of the ring pinned at 40 Hz and 12 kHz, and a visible arc that fell on either end
// was one flat row of beams.
var HALO_BAND_SPREAD = Math.PI * 2;
var HALO_RADIAL_FAR_SCALE = 1.55;    // lyric size multiplier when the whole ring is on screen
var HALO_RADIAL_MAX_HALF = 1.05;     // widest the radial line's window gets, so a long line is cut, not wrapped
var HALO_LYRIC_CONTEXT_SCALE = 0.72; // the rows around the sung one, relative to its size

// The ring's knobs. The schema lives here so the defaults have exactly one home; the
// store and the console bindings live in 07-fx/11-halo-tuning.js.
//
// rebuild: 'stage' re-bakes the web, the panels and the beams, 'lyric' re-lays the lyric
// list, 'live' is read every frame and only needs a redraw.
var HALO_TUNING_SCHEMA = {
  centerX: { def: -0.2, min: -1.2, max: 1.2, kind: 'ratio', rebuild: 'stage' },
  centerY: { def: 0.5, min: -0.5, max: 1.5, kind: 'ratio', rebuild: 'stage' },
  radiusK: { def: 0.36, min: 0.12, max: 0.9, kind: 'ratio', rebuild: 'stage' },
  bandK: { def: 0.155, min: 0.04, max: 0.4, kind: 'ratio', rebuild: 'stage' },
  panelHeight: { def: 38, min: 8, max: 120, kind: 'px', rebuild: 'stage' },
  webCurves: { def: 320, min: 60, max: 1200, kind: 'count', rebuild: 'stage' },
  runners: { def: 96, min: 0, max: 400, kind: 'count', rebuild: 'stage' },
  strandDensity: { def: 0.4, min: 0.05, max: 1, kind: 'ratio', rebuild: 'live' },
  beamLength: { def: 0.55, min: 0.1, max: 1.2, kind: 'ratio', rebuild: 'live' },
  hazeAmount: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  streakAmount: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  spectrumGain: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  beamFollow: { def: 0.75, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  pulseScale: { def: 0.09, min: 0, max: 0.4, kind: 'ratio', rebuild: 'live' },
  shakePx: { def: 6, min: 0, max: 40, kind: 'px', rebuild: 'live' },
  levelGain: { def: 2.6, min: 0, max: 6, kind: 'ratio', rebuild: 'live' },
  readAngle: { def: 0, min: -180, max: 180, kind: 'deg', rebuild: 'lyric' },
  textGap: { def: 26, min: 0, max: 160, kind: 'px', rebuild: 'lyric' },
  lineGap: { def: 18, min: 0, max: 120, kind: 'px', rebuild: 'lyric' },
  lyricRows: { def: 0, min: 0, max: 240, kind: 'count', rebuild: 'live' },
  axialLyric: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  rotLead: { def: 0.55, min: 0, max: 4, kind: 'sec', rebuild: 'live' },
  rotDur: { def: 0.55, min: 0.05, max: 4, kind: 'sec', rebuild: 'live' },
  beatTurn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  panelRefresh: { def: 5, min: 1, max: 12, kind: 'count', rebuild: 'live' }
};

// The live value of a knob. The store is built by a later module, so the schema default
// is the path until 07-fx/11-halo-tuning.js has run.
function haloParam(key) {
  var store = (typeof haloTuning !== 'undefined') ? haloTuning : null;
  if (store && store[key] !== undefined && store[key] !== null) return store[key];
  var spec = HALO_TUNING_SCHEMA[key];
  return spec ? spec.def : 0;
}

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
  engineError: '',
  tier: 'full',
  autoTier: 'full',
  autoPending: '',
  autoIntervals: [],
  autoLastAt: 0,
  autoBadStreak: 0,
  autoWindows: 0,
  autoLastOver: 0,
  autoChanges: 0,
  autoSwitchAt: 0,
  autoBlocked: '',
  autoLog: '',
  autoLine: -1,
  probeCost: -1,
  probeVerdict: '',
  probeLog: '',
  probeError: '',
  probePending: false,
  probeSamples: [],
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
  // The ring's rotation as the things painted on it see it. The lyric dial re-anchors its
  // own angles when a turn finishes (so the angles stay small), and that bookkeeping must
  // not move anything else: it subtracts the same amount from `rot` and from the line
  // angles, which cancels for a lyric line and shows up as a snap for every other element.
  // This is `ringRot` with the re-anchors taken back out: it moves when the ring turns and
  // stays put when the list re-anchors.
  decoRot: 0,
  webRot: 0,
  idleSpin: 0,
  beat: { step: 0, origin: 0, source: '' },   // the tempo grid the turn timing is taken from
  ringPulse: 0,      // the beat's envelope: 1 at the hit, decaying after it
  pulse: 1,          // the scale the whole ring is drawn at
  levelGate: 0,      // how much of the beat the sound allows, 0 in silence
  shakeX: 0,
  shakeY: 0,
  shakeDirX: 1,      // which way the last beat threw the picture, both ends away from zero
  shakeDirY: 0.5,
  beamKick: 0,       // the beat's envelope on the outer beams, 0..1.2, falling on its own
  basePanX: 0,       // the framing knobs' own pan, in world units
  basePanY: 0
};

// The camera is the user's: a pan in world units and a zoom. Nothing in the layer moves
// it by itself - a beat that moved it read as jumping around the screen.
var haloCam = { panX: 0, panY: 0, zoom: 1 };

// The pointer's own state: a drag pans the ring, a click without a drag emits.
var haloPointerState = { down: false, moved: false, x: 0, y: 0 };

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
  lastT: -1,      // the frame the last rotation was measured at, for the hand-over speed
  lastRot: 0,
  vel: 0,         // the dial's angular velocity, rad/s, as of the previous frame
  rebase: 0,     // the total by which the line angles have been re-anchored; haloState.decoRot takes it back out
  turnSource: '', // which producer decided the last turn's timing, printed by the status probe
  tween: null,
  baseAngle: 0,
  // The radial carrier shows one line at a time: which line is on it, which one is still
  // swinging out, and how far the swing has got (0..1). Kept here rather than in the draw
  // so a seek or a rebuilt list is one place to reset it.
  radial: { item: -1, prev: -1, phase: 1, startAt: 0, dur: 0.55 },
  builtFontPx: 0,     // the font the measured widths belong to
  builtStep: 0,       // the row pitch the angles were laid out with; it follows the ring's size
  listKey: '',        // the lines only; the 自动 tier resets on this
  songKey: ''         // the lines and their translations; the rows are rebuilt on this
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
  analyser: null,
  // The per-bin spectrum the beams read: the sonic monitor's raw analyser data when it runs,
  // the halo's own analyser buffer otherwise. Eight bands are too coarse to say where along
  // the ring a level sits.
  spectrum: null
};

function haloPresetIsActive() {
  return typeof fx !== 'undefined' && fx && Number(fx.preset) === HALO_PRESET_INDEX;
}

// ---------------------------------------------------------------- draw tier
//
// The tier is the app's one setting (fx.pvDrawQuality, the same one the PV layer reads), and
// this preset answers for it in its own terms: the two presets draw with different engines, so
// "lean" is not the same set of switches here. What is shared is the promise - 效果档 never
// degrades, 性能档 is the cheaper picture, and 自动 only degrades when this layer is itself the
// one that cannot keep up, and then only on a line boundary.
//
// The cheaper picture here is the same picture at fewer pixels, and that is what the measurement
// says (scripts/halo-draw-bench.js): one frame of the ring costs about 3ms plus 7.3ms per
// megapixel, and taking whole parts of the drawing away barely moves it - the parts overlap, so
// their neighbours still shade the same pixels. What does move it is the pixel count: at three
// quarters of the resolution the identical frame costs 43% less, at half of it 62% less.
//
// Nothing of the picture is removed and nothing of it moves. The text keeps the size it has on
// screen and the ring keeps its place; only the resolution the ring is rasterised at changes,
// which makes the edges softer. That is the one thing 性能档 is allowed to spend.
var HALO_FULL_SCALE = 1;           // 效果档 draws every pixel of the canvas
var HALO_LEAN_SCALE = 0.75;        // 性能档 draws the same picture at three quarters of them
var haloTierScale = HALO_FULL_SCALE;   // the resolution the canvas is at right now

// The 自动 tier decides from this layer's own cost. The window is the same two seconds the PV
// layer uses, counted in the ring's own frames: 60 frames at 30fps.
var HALO_AUTO_WINDOW_FRAMES = 60;
var HALO_FRAME_BUDGET_MS = 1000 / 30;  // the ring draws at 30fps; this is one of its periods
var HALO_AUTO_ENTER_OVER = 35;        // 35 of 60 is the same share PV uses (14 of 24)
var HALO_AUTO_ENTER_WINDOWS = 3;      // and it has to hold for three such windows
var HALO_AUTO_SEEK_BACK_S = 2;        // a rewind this large is a fresh listening pass
var HALO_PROBE_SAMPLES = 7;           // frames the capability probe measures
var HALO_PROBE_COOLDOWN_MS = 30000;   // how long a verdict of "this is not the ring" is believed

function haloTierMode() {
  return typeof normalizePvDrawQuality === 'function'
    ? normalizePvDrawQuality(fx && fx.pvDrawQuality)
    : 'auto';
}

function haloAutoDrawTier() {
  return haloPresetState.autoTier;
}

function haloAutoLog(fromTier, toTier, why) {
  var line = '[HaloDrawTier] ' + fromTier + ' -> ' + toTier + ': ' + why;
  haloPresetState.autoLog = line;
  if (typeof console !== 'undefined' && console && typeof console.info === 'function') console.info(line);
  if (typeof window !== 'undefined' && window && window.__mineradioPerf &&
      typeof window.__mineradioPerf.count === 'function') {
    window.__mineradioPerf.count('halo.draw.tier.' + toTier);
  }
}

// A new song, a rewind, or a released layer is new evidence: the decision belongs to one song's
// content, so it starts again from the full picture instead of carrying over.
function haloAutoReset(reason) {
  var s = haloPresetState;
  var from = s.autoTier;
  s.autoTier = 'full';
  s.autoPending = '';
  s.autoIntervals.length = 0;
  s.autoLastAt = 0;
  s.autoBadStreak = 0;
  s.autoWindows = 0;
  s.autoLastOver = 0;
  s.autoLine = -1;
  if (reason && from !== 'full') haloAutoLog(from, 'full', 'reset (' + reason + ')');
}

// The tier this frame is drawn with. A tier chosen by hand is also the user rejecting what
// 自动 decided, so the automatic decision is dropped here instead of waiting in reserve.
function haloTier() {
  var mode = haloTierMode();
  if (mode === 'full' || mode === 'lean') {
    if (haloPresetState.autoTier !== 'full' || haloPresetState.autoPending) {
      haloAutoReset('a manual tier was chosen');
    }
    return mode;
  }
  return haloAutoDrawTier();
}

// The resolution the tier draws at. The canvas is resized in place and the frame that follows
// draws the whole picture again, so nothing of the picture is lost; the resize and the redraw
// happen in the same task, so the cleared canvas is never the one the user sees.
function haloApplyTierScale(tier) {
  var canvas = haloCanvasElement();
  var s = haloState;
  if (!canvas || !s.ready) return false;
  var scale = tier === 'lean' ? HALO_LEAN_SCALE : HALO_FULL_SCALE;
  if (Math.abs(scale - haloTierScale) < 0.001) return false;
  haloTierScale = scale;
  s.dpr = scale;
  canvas.width = Math.max(2, Math.round(s.w * scale));
  canvas.height = Math.max(2, Math.round(s.h * scale));
  return true;
}

// The boundary is a lyric line: the ring turns to the next line, and a tier change lands on
// that turn - never in the middle of one, which is the rule the PV layer follows for its cuts.
function haloAutoBoundary(t, now) {
  var s = haloPresetState;
  if (s.lastT && (s.lastT - t) > HALO_AUTO_SEEK_BACK_S) {
    haloAutoReset('rewound to ' + (Math.round(t * 10) / 10) + 's');
  }
  var line = haloLyric.current;
  var boundary = line >= 0 && line !== s.autoLine;
  if (line >= 0) s.autoLine = line;
  if (boundary && s.autoPending) {
    var from = s.autoTier;
    s.autoTier = s.autoPending;
    s.autoPending = '';
    s.autoBadStreak = 0;
    s.autoChanges += 1;
    s.autoSwitchAt = now;
    haloAutoLog(from, s.autoTier,
      s.autoLastOver + '/' + HALO_AUTO_WINDOW_FRAMES + ' frames late, held for ' + HALO_AUTO_ENTER_WINDOWS +
      ' windows; the ring costs ' + s.probeCost + 'ms of its ' + (Math.round(HALO_FRAME_BUDGET_MS * 10) / 10) +
      'ms budget (line ' + line + ')');
  }
  return boundary;
}

// The probe answers one question: can this machine draw the ring's full picture inside the
// ring's own frame budget? If it can, the slowness the app is feeling is not the ring's, and
// the ring keeps its picture - the doctrine's second boundary, no visible downgrade for a
// reason that has nothing to do with this layer.
//
// The measurement is taken in the render loop, around the frame the app draws anyway, on the
// canvas that is on screen: that is the surface the picture is really drawn on, so nothing has
// to be assumed about how another one would behave.
// Reading the live canvas back does not cost it its acceleration: fifty readbacks in a row
// left it drawing at the same speed.
function haloAutoProbe() {
  var s = haloPresetState;
  s.autoProbeAt = Date.now();
  s.probePending = true;
  s.probeSamples.length = 0;
  s.probeVerdict = 'measuring';
}

// The baseline for one measured frame. The first readback is not timed: it waits for
// whatever the previous frame left pending, so the second one has nothing new to rasterise
// and pays for the transfer alone. That is the number the frame's cost is subtracted from.
function haloProbeBaseline(ctx) {
  try {
    ctx.getImageData(0, 0, 1, 1);
    var t0 = performance.now();
    ctx.getImageData(0, 0, 1, 1);
    return performance.now() - t0;
  } catch (err) {
    var s = haloPresetState;
    s.probeError = String((err && err.message) || err);
    s.probePending = false;
    s.probeVerdict = 'failed';
    s.probeLog = '[HaloDrawTier] probe failed: ' + (s.probeError || 'no measurement');
    return -1;
  }
}

// The frame's cost: how long the readback after the drawing took, less the baseline.
function haloProbeSample(ctx, base) {
  var s = haloPresetState;
  var t0 = performance.now();
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch (err) {
    s.probeError = String((err && err.message) || err);
    s.probePending = false;
    s.probeVerdict = 'failed';
    s.probeLog = '[HaloDrawTier] probe failed: ' + (s.probeError || 'no measurement');
    return;
  }
  var cost = Math.round((performance.now() - t0 - base) * 100) / 100;
  s.probeSamples.push(cost);
  if (s.probeSamples.length < HALO_PROBE_SAMPLES) return;
  s.probePending = false;
  var sorted = s.probeSamples.slice().sort(function (a, b) { return a - b; });
  var median = sorted[Math.floor(sorted.length / 2)];
  s.probeCost = median;
  var budget = Math.round(HALO_FRAME_BUDGET_MS * 10) / 10;
  var size = Math.round(haloState.w) + 'x' + Math.round(haloState.h);
  if (median > HALO_FRAME_BUDGET_MS) {
    s.probeVerdict = 'over';
    s.probeLog = '[HaloDrawTier] probe: the ring costs ' + median + 'ms of its ' + budget + 'ms budget at ' + size;
    s.autoPending = 'lean';
  } else {
    s.probeVerdict = 'within';
    s.probeLog = '[HaloDrawTier] probe: the ring costs ' + median + 'ms of its ' + budget + 'ms budget at ' + size +
      ' - the ring is not what is slow';
  }
  if (typeof console !== 'undefined' && console && typeof console.info === 'function') console.info(s.probeLog);
}

// One window of the ring's own frames, sampled per window. Sticky by design, exactly like the
// PV layer: while 性能档 is on, a cheap frame only proves the downgrade is working, so the
// recovery is the next song or the user picking 效果档.
function haloAutoObserve(now) {
  var s = haloPresetState;
  if (haloTierMode() !== 'auto' || s.autoBlocked || s.autoTier !== 'full' || s.autoPending) {
    s.autoIntervals.length = 0;
    return;
  }
  var last = s.autoLastAt;
  s.autoLastAt = now;
  if (!last) return;
  s.autoIntervals.push(now - last);
  if (s.autoIntervals.length < HALO_AUTO_WINDOW_FRAMES) return;
  var over = 0;
  for (var i = 0; i < s.autoIntervals.length; i++) {
    if (s.autoIntervals[i] > HALO_FRAME_BUDGET_MS) over += 1;
  }
  s.autoIntervals.length = 0;
  s.autoWindows += 1;
  s.autoLastOver = over;
  if (over < HALO_AUTO_ENTER_OVER) {
    s.autoBadStreak = 0;
    return;
  }
  s.autoBadStreak += 1;
  if (s.autoBadStreak < HALO_AUTO_ENTER_WINDOWS) return;
  // The ring's frames are late. That alone says nothing about who is late - the app's main
  // loop, the WebGL background or this layer can all be the reason - so the probe is what
  // decides, and its verdict is only re-asked after a cooldown.
  if (s.probePending) return;
  if (s.probeVerdict === 'within' && (Date.now() - s.autoProbeAt) < HALO_PROBE_COOLDOWN_MS) return;
  haloAutoProbe();
}

function haloLayerElement() { return document.getElementById('halo-layer'); }
function haloCanvasElement() { return document.getElementById('halo-canvas'); }

function haloRand(a, b) { return a + Math.random() * (b - a); }
function haloPick(list) { return list[(Math.random() * list.length) | 0]; }
function haloGauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }
function haloClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function haloNormAngle(a) { return ((a + Math.PI) % HALO_TAU + HALO_TAU) % HALO_TAU - Math.PI; }
function haloEaseIO(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

// One turn of the dial. With nothing to inherit this is the same ease-in-out curve the turn
// has always used; when it takes over mid-flight, `v0` - the speed the dial already had - is
// the slope it starts from, so the movement joins at that speed and still lands on the line
// at rest. That hand-over is the difference between continuing a motion and restarting one.
function haloEaseJoin(k, from, to, v0, dur) {
  if (!v0) return from + (to - from) * haloEaseIO(k);
  var k2 = k * k;
  var k3 = k2 * k;
  return (2 * k3 - 3 * k2 + 1) * from + (k3 - 2 * k2 + k) * (v0 * dur) + (-2 * k3 + 3 * k2) * to;
}
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
  // The ring's centre sits where the framing knobs put it. The default is off the left
  // edge, so only the ring's right side is on screen.
  s.cx = s.w * haloParam('centerX');
  s.cy = s.h * haloParam('centerY');
  s.R = Math.max(24, s.w * haloParam('radiusK'));
  s.band = s.R * haloParam('bandK');
  s.RO = s.R + s.band;
  s.RMAX = Math.hypot(s.w - s.cx, s.h - s.cy) + 60;
  s.dpr = haloTierScale;
  // The base pan is what puts the ring's centre at the framing knobs' position; the
  // user's own pan is added on top of it.
  s.basePanX = (0.5 - haloParam('centerX')) * s.w;
  s.basePanY = (0.5 - haloParam('centerY')) * s.h;
}

function haloResize() {
  var layer = haloLayerElement();
  var canvas = haloCanvasElement();
  if (!layer || !canvas) return false;
  var w = layer.clientWidth || window.innerWidth || 1280;
  var h = layer.clientHeight || window.innerHeight || 720;
  haloLayoutStage(w, h);
  canvas.width = Math.max(2, Math.round(w * haloTierScale));
  canvas.height = Math.max(2, Math.round(h * haloTierScale));
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  haloBuildWeb();
  haloBuildSlots();
  haloBuildStrands();
  haloBuildFlyers();
  haloBuildGradients();
  haloState.ready = true;
  // The probe's verdict belongs to one size: after a resize the machine may well be able to
  // draw the picture at the new size, so the verdict is asked again.
  haloPresetState.probeCost = -1;
  haloPresetState.probeVerdict = '';
  haloPresetState.probeLog = '';
  haloPresetState.probePending = false;
  haloPresetState.probeSamples.length = 0;
  haloPresetState.autoProbeAt = 0;
  return true;
}

// ---------------------------------------------------------------- camera

// The camera is the user's. The ring sits where the framing knobs put it and the user
// pans and zooms on top of that; no beat, no lyric line and no timer moves it.
function haloPanTotalX() { return haloState.basePanX + haloCam.panX; }
function haloPanTotalY() { return haloState.basePanY + haloCam.panY; }

// The linear factor of the transform: the user's zoom and the layer's own depth (a layer
// drawn further back is a touch smaller). The beat is not in here - it pops the ring
// against the rest of the picture, and the eye reads the difference between the two.
function haloSceneZoom(depth) {
  var s = haloState;
  var back = depth == null ? 1 : (1 - (1 - depth) * 0.12);
  return haloCam.zoom * back;
}

// `pop` is how much larger the thing being drawn is than the rest of the picture. Only the
// ring pass has one; the mesh, haze and beams are drawn at the camera's own scale.
function haloApplyCameraTransform(ctx, scale, depth, pop) {
  var s = haloState;
  var z = haloSceneZoom(depth) * (pop || 1);
  var ex = -z * s.cx - haloCam.zoom * haloPanTotalX() + s.w / 2 + s.shakeX;
  var ey = -z * s.cy - haloCam.zoom * haloPanTotalY() + s.h / 2 + s.shakeY;
  ctx.setTransform(scale * z, 0, 0, scale * z, scale * ex, scale * ey);
}

function haloToScreen(x, y) {
  var s = haloState;
  var z = haloSceneZoom(1);
  return {
    x: (x - s.cx) * z - haloCam.zoom * haloPanTotalX() + s.w / 2 + s.shakeX,
    y: (y - s.cy) * z - haloCam.zoom * haloPanTotalY() + s.h / 2 + s.shakeY
  };
}

// The world point under a screen pixel: the inverse of haloToScreen.
function haloToWorld(sx, sy) {
  var s = haloState;
  var z = haloSceneZoom(1);
  return {
    x: s.cx + (sx - s.w / 2 - s.shakeX + haloCam.zoom * haloPanTotalX()) / z,
    y: s.cy + (sy - s.h / 2 - s.shakeY + haloCam.zoom * haloPanTotalY()) / z
  };
}

// A drag moves the world with the pointer, one screen pixel per screen pixel.
function haloPanBy(dx, dy) {
  var z = Math.max(0.2, haloCam.zoom);
  haloCam.panX -= dx / z;
  haloCam.panY -= dy / z;
}

// The wheel zooms towards the cursor: the world point under it stays under it.
function haloZoomAt(sx, sy, factor) {
  var s = haloState;
  var before = haloToWorld(sx, sy);
  var next = haloClamp(haloCam.zoom * factor, 0.35, 3.2);
  if (next === haloCam.zoom) return;
  haloCam.zoom = next;
  var z = haloSceneZoom(1);
  var panX = ((before.x - s.cx) * z + s.w / 2 - sx) / next;
  var panY = ((before.y - s.cy) * z + s.h / 2 - sy) / next;
  haloCam.panX = panX - s.basePanX;
  haloCam.panY = panY - s.basePanY;
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
  a.spectrum = null;
  var frame = (typeof sonicAudioMonitorState !== 'undefined' && sonicAudioMonitorState) ? sonicAudioMonitorState.frame : null;
  if (frame) {
    a.spectrum = sonicAudioMonitorState.raw || null;
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
  // The analyser is a global of the app. It must not be named `analyser` here: a local
  // `var analyser` shadows the global from the top of the function, so `typeof analyser`
  // would always be 'undefined' and the fallback would never read anything.
  var an = (typeof analyser !== 'undefined') ? analyser : null;
  if (!an || typeof an.getByteFrequencyData !== 'function') return;
  var bins = an.frequencyBinCount || 0;
  if (!bins) return;
  if (!a.buffer || a.buffer.length !== bins) a.buffer = new Uint8Array(bins);
  try { an.getByteFrequencyData(a.buffer); } catch (err) { return; }
  a.spectrum = a.buffer;
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
// One list of beat events out of whatever the map holds. With `requireCamera` the list is
// the detected drum hits only: an entry the analysis did not judge drum-like is not a hit,
// and a synthesised grid point is not one either.
function haloBeatList(events, requireCamera) {
  if (!events || !events.length) return null;
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var time = typeof e === 'number' ? e : (e && typeof e.time === 'number' ? e.time : NaN);
    if (!isFinite(time)) continue;
    var isObject = !!e && typeof e === 'object';
    if (requireCamera && isObject && e.camera === false) continue;
    if (isObject && e.grid === true) continue;
    var strength = isObject ? Number(e.strength) : 0.5;
    if (!isFinite(strength)) strength = 0.5;
    if (requireCamera && strength < 0.30) continue;
    var impact = isObject ? Number(e.impact) : strength;
    if (!isFinite(impact)) impact = strength;
    out.push({ t: time, w: haloClamp(strength * 0.5 + impact * 0.5, 0, 1) });
  }
  out.sort(function (a, b) { return a.t - b.t; });
  return out.length ? out : null;
}

// A grid beat that has a detected drum hit under it keeps its strength; one with nothing
// under it is a metronome tick and pops lighter. The timing never moves - the hit detector
// is only allowed to say how hard a beat lands, not when.
function haloAccentGridWithHits(list, hits) {
  if (!list || !list.length || !hits || !hits.length) return list;
  var j = 0;
  for (var i = 0; i < list.length; i++) {
    while (j < hits.length && hits[j].t < list[i].t - 0.09) j++;
    var onHit = j < hits.length && Math.abs(hits[j].t - list[i].t) <= 0.09;
    var w = list[i].w;
    list[i].w = haloClamp(onHit ? Math.max(w, hits[j].w * 0.85) : w * 0.55, 0, 1);
  }
  return list;
}

// Two pops closer than the eye can separate are one buzz. Where the list has them, the harder
// beat is the one that stays: the listener hears the accent, and the weaker one was only ever
// filling the space between. The times themselves are never moved.
function haloThrottleBeats(list) {
  if (!list || list.length < 2) return list;
  var out = [list[0]];
  for (var i = 1; i < list.length; i++) {
    var prev = out[out.length - 1];
    if (list[i].t - prev.t >= HALO_BEAT_MIN_GAP) { out.push(list[i]); continue; }
    if (list[i].w > prev.w) out[out.length - 1] = list[i];
  }
  return out;
}

function haloBeatMapEvents() {
  if (typeof currentBeatMap === 'undefined' || !currentBeatMap) return null;
  // The pulse rides the song's beat points: the list the analysis thinned for the visuals.
  // cameraBeats is the whole grid it laid over the song - every slot of the bar, including
  // the ones it wrote off as not a drum - and popping on all of them is a refresh the eye
  // reads as a buzz. The hits still only say whether a beat point has a drum under it (one
  // without a drum pops lighter); they never move the timing, which stays the grid's.
  var list = haloBeatList(currentBeatMap.pulseBeats, false) ||
    haloBeatList(currentBeatMap.cameraBeats, false);
  if (list) return haloThrottleBeats(haloAccentGridWithHits(list, haloBeatList(currentBeatMap.hits, true)));
  return haloThrottleBeats(haloBeatList(currentBeatMap.hits, true) ||
    haloBeatList(currentBeatMap.beats || currentBeatMap.kicks, false));
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
  if (haloAudio.kickOnset > 0 && t - haloBeat.lastOnsetAt >= HALO_BEAT_MIN_GAP) {
    haloBeat.lastOnsetAt = t;
    haloEnqueueBeat(t + 0.02, haloClamp(0.35 + 0.55 * haloAudio.kickOnset, 0, 1), true);
  }
}

function haloEnqueueBeat(hitAt, weight, late) {
  haloBeat.events.push({
    hitAt: hitAt,
    weight: weight,
    late: !!late,
    travel: weight > 0.62 ? HALO_TRAVEL_SLOW : HALO_TRAVEL_FAST,
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
  // Pre-render the panels that will flash. The fresh canvas waits in slot.next, so the
  // swap at the hit is a pointer assignment and cannot hitch the frame.
  var count = Math.max(1, Math.round(haloParam('panelRefresh')));
  var slots = haloPickVisibleSlots(Math.max(1, Math.floor(count / 2)), count);
  e.slots = slots;
  for (var i = 0; i < slots.length; i++) slots[i].next = haloRenderSlot(slots[i]);
}

function haloBeatLaunch(e) {
  // A live onset is heard after it happened, so there is no time to send a light that lands
  // on the beat; a rushed streak is exactly the flicker that could not be read. That beat is
  // carried by the pop and the panel flashing under it.
  if (e.late) return;
  // A slow flight lasts about as long as two beats, so a dense passage would queue up more
  // streaks than anyone can follow. Two bundles in flight is the most the ring shows at once;
  // the beat itself is still carried by the ring's pop and the panel that updates under it.
  var flying = 0;
  for (var i = 0; i < haloCometList.length; i++) if (!haloCometList[i].hit) flying++;
  // One beam per beat, two on a hard one - and a beat that cannot fit is skipped, not sent
  // late to race across the ring.
  var count = Math.max(0, Math.min(e.weight > 0.62 ? 2 : 1, 2 - flying));
  for (var k = 0; k < count; k++) {
    var ang = haloRand(0, HALO_TAU);
    haloSpawnComet(ang, e.travel, e.weight, e.hitAt);
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
    // The panel that just took the new bitmap holds its glow long enough to be read: with the
    // beams now crossing the ring slowly, this flash - not the streak - is what says "this
    // block updated on that beat".
    slot.flash = 1;
  }
  // The beat's whole job now: the ring pops out and shakes where it stands. The camera
  // stays where the user left it. A hard hit pops harder than a light one - the map's own
  // strength, not a constant for every grid point. The floor has to be low: the weights the
  // accent chain hands over run from about 0.08 to 0.85, and a floor of 0.45 squeezed that
  // whole range into a 1.5x difference, which is not a beat you can see getting stronger.
  // The size is the beat's own weight and nothing else. The live kick envelope used to be
  // allowed to outrank it, but that envelope is a curve that stays well above zero the whole
  // time a song is loud, so every pop ended up at the loudest size the knob allows and the
  // ring read as a picture painted from the volume instead of a beat the song chose. Whether
  // there is music at all is the level gate's job, in haloRenderFrame, not the hit's.
  var weight = haloClamp(e.weight, 0, 1);
  haloState.ringPulse = Math.max(haloState.ringPulse || 0, 0.15 + 0.85 * weight);
  // Which way this beat throws the picture. Both ends are kept away from zero so a beat
  // always has a throw to read, and the two axes are not tied to the same sign.
  haloState.shakeDirX = haloRand(0.55, 1) * (Math.random() < 0.5 ? -1 : 1);
  haloState.shakeDirY = haloRand(0.35, 0.85) * (Math.random() < 0.5 ? -1 : 1);
  haloStrandBeat(weight);
}

// ---------------------------------------------------------------- lyric dial

function haloCurrentSong() {
  if (Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length) return playQueue[currentIdx];
  if (typeof currentCoverSong === 'function') return currentCoverSong();
  return null;
}

function haloLyricHash(text) {
  var h = 2166136261;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 1676997213) >>> 0;
  }
  return (h >>> 0).toString(36);
}

// The lines themselves. The 自动 draw tier is decided from this, so a translation that
// arrives a moment after the lines must not look like a new song to it.
function haloLyricListKey() {
  var lines = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
  var song = haloCurrentSong();
  var key = '';
  if (typeof lyricTimingSongKey === 'function') key = lyricTimingSongKey(song);
  return haloLyricHash(key + '|' + lines.length + '|' + (lines.length ? lines[0].text : '')) + ':' + lines.length;
}

// The dial is synced on this key, which includes the translations: they are matched to the
// lines by the app's own lyric pipeline and can arrive after the lines (the NetEase fallback
// does). A translation-only change is written into the existing rows (haloSyncLyrics); only a
// new song or a new size rebuilds the dial. A row drawn before its translation landed would
// otherwise keep that hole for the whole song.
function haloLyricSignature() {
  var lines = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
  var count = 0;
  var text = '';
  for (var i = 0; i < lines.length; i++) {
    var translated = haloLyricTranslationOf(lines[i]);
    if (!translated) continue;
    count++;
    text += translated + '|';
  }
  return haloLyricListKey() + '|' + count + '|' + haloLyricHash(text);
}

// A line's translation is the one the app attached to it (attachLyricTranslations, by time).
// Pairing lyricsTranslationLines[i] with lyricsLines[i] is not the same thing: a song whose
// translation list is shorter than the original has holes in it, and every translation after
// the first hole shifts onto the wrong line.
function haloLyricTranslationOf(line) {
  if (!line) return '';
  if (typeof normalizeLyricTranslationText === 'function') return normalizeLyricTranslationText(line.translation);
  return String(line.translation || '').trim();
}

// The text size follows the app's own lyric size knob, so the two never disagree.
function haloLyricFontPx() {
  var scale = 1;
  if (typeof fx !== 'undefined' && fx && isFinite(Number(fx.lyricScale))) scale = Number(fx.lyricScale);
  return Math.max(9, Math.min(48, HALO_LYRIC_BASE_PX * haloClamp(scale, 0.35, 1.65)));
}

// Where the current line is read: the rim segment the list scrolls past.
function haloReadAngle() { return haloParam('readAngle') * Math.PI / 180; }

// The lyrics are an ordinary left-aligned list that has been bent over the ring's edge:
// every line starts on its own radial line at the rim and runs outward from there, so the
// block still reads top to bottom, one row per line.
function haloBuildLyricRing() {
  // A different list of lines is new evidence for 自动, the same way a new plan is for the PV
  // layer: the decision belongs to one song's content and does not carry into the next.
  var prevKey = haloLyric.listKey;
  var lines = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
  var offset = 0;
  if (typeof getActiveLyricTimingOffsetSeconds === 'function') offset = getActiveLyricTimingOffsetSeconds();
  haloLyric.items = [];
  haloLyric.current = -1;
  haloLyric.pending = -1;
  haloLyric.tween = null;
  haloLyric.rot = haloReadAngle();
  haloLyric.rebase = 0;
  // A rebuilt dial has teleported: nothing is in motion any more.
  haloLyric.vel = 0;
  haloLyric.lastT = -1;
  haloLyric.radial = { item: -1, prev: -1, phase: 1, startAt: 0, dur: 0.55 };
  haloLyric.baseAngle = 0;
  var fontPx = haloLyricFontPx();
  // One row per line: the step is a line height plus the gap the user asked for.
  var step = haloLyricStep();
  var acc = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var text = String((line && line.text) || '').trim();
    if (!text) continue;
    // The width is not measured here: only the lines inside the window are measured, and
    // only when they are drawn. A song has hundreds of lines and the dial shows a handful.
    var item = {
      index: haloLyric.items.length,
      text: text,
      textWidth: 0,      // measured with the font of the row that shows it
      widthFontPx: 0,
      angle: acc,
      startAt: Math.max(0, (Number(line.t) || 0) + offset),
      lineIndex: i,
      sub: haloLyricTranslationOf(line)
    };
    haloLyric.items.push(item);
    acc += step;
  }
  haloLyric.builtFontPx = fontPx;
  // The pitch is a pixel row height over the ring's radius, so a resized ring needs its rows
  // laid out again - otherwise the rows keep the old pitch and the sung row stops standing
  // out by the same amount.
  haloLyric.builtStep = haloLyricStep();
  haloLyric.listKey = haloLyricListKey();
  haloLyric.songKey = haloLyricSignature();
  if (prevKey !== haloLyric.listKey) haloAutoReset('a new lyric list');
  return haloLyric.items.length;
}

// Rows are laid out by the lines alone; a translation that lands late only changes what each
// row reads. It is refreshed in place, not rebuilt: a rebuild would put the dial back on the
// read mark and snap the turn in the middle of the song.
function haloSyncLyrics() {
  var font = haloLyricFontPx();
  var step = haloLyricStep();
  var sig = haloLyricSignature();
  if (sig === haloLyric.songKey && font === haloLyric.builtFontPx && step === haloLyric.builtStep) return;
  if (haloLyricListKey() === haloLyric.listKey && font === haloLyric.builtFontPx &&
      step === haloLyric.builtStep && haloLyric.items.length) {
    var lines = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
    for (var i = 0; i < haloLyric.items.length; i++) {
      haloLyric.items[i].sub = haloLyricTranslationOf(lines[haloLyric.items[i].lineIndex]);
    }
    haloLyric.songKey = sig;
    return;
  }
  haloBuildLyricRing();
}

// The row height of the dial as the angle it takes on the ring: one line plus the gap.
function haloLyricStep() {
  return (haloLyricFontPx() * 1.45 + haloParam('lineGap')) / Math.max(1, haloState.RO);
}

// How many lines the dial holds, and the arc they cover.
//
// The knob is a cap. At 0 - the shipped default - the list runs the whole way round: it
// stops at the point opposite the read mark, so a line is born and dies behind the ring
// instead of popping into view at two or four o'clock. Any other number centres a shorter
// list on the line being sung, which is what the pitch and the gap alone would give.
function haloLyricWindow() {
  var items = haloLyric.items;
  var rows = Math.round(haloParam('lyricRows'));
  var anchor = haloLyric.current < 0 ? 0 : haloLyric.current;
  // Measured from the line being sung, not from the song's first line: the dial is
  // re-anchored when a turn finishes, but the first line of a seeked song is not, and the
  // opposite point has to be the opposite of the mark either way.
  var base = items[anchor] ? items[anchor].angle : 0;
  if (!(rows > 0)) {
    var from = anchor;
    var to = anchor;
    while (from > 0 && base - items[from - 1].angle < Math.PI) from--;
    while (to < items.length - 1 && items[to + 1].angle - base < Math.PI) to++;
    return { from: from, to: to, rows: 0, base: base };
  }
  var first = Math.max(0, anchor - Math.floor(rows / 2));
  return { from: first, to: Math.min(items.length - 1, first + rows - 1), rows: rows, base: base };
}

// Half the angle the window covers, with the thickness of a row in it. The mask is drawn
// over this arc around the read mark, so a line that leaves the window is cut there rather
// than reappearing somewhere else on the ring. It never exceeds the circle itself: when the
// window runs the whole way round, the mask's two ends meet behind the ring.
function haloLyricArcHalf(win) {
  var items = haloLyric.items;
  var textR = haloState.RO + haloParam('textGap');
  if (!items.length || !items[win.from] || !items[win.to]) return Math.PI;
  var span = Math.max(Math.abs(items[win.from].angle - win.base), Math.abs(items[win.to].angle - win.base));
  var thickness = haloLyricStep() + (haloLyricFontPx() * 1.6) / Math.max(1, textR);
  return Math.min(Math.PI, span + thickness);
}

// The width of a line, measured with the font of the row that shows it and kept for the
// frames it stays in the window.
function haloLyricWidth(item, ctx, fontPx) {
  if (item.textWidth > 0 && item.widthFontPx === fontPx) return item.textWidth;
  var w = ctx && typeof ctx.measureText === 'function' ? ctx.measureText(item.text).width : 0;
  if (!isFinite(w) || w <= 0) w = item.text.length * fontPx * 0.6;
  item.textWidth = w;
  item.widthFontPx = fontPx;
  return w;
}

// The song's beat grid: how far apart its rhythm points are, and a beat to count them from.
//
// The point of the whole thing is that this spacing is fixed for a song, so it can drive how
// fast the ring turns: a fast song turns fast, a slow song turns slow. Three producers, in
// the order the app trusts its own data: the beat map's grid step, the gaps between the map's
// own beat times (older caches and podcast maps carry no step), then the realtime tempo
// tracker. `step: 0` means none of them knows, and `source` says which one was reached.
function haloBeatGrid() {
  haloState.beat = { step: 0, origin: 0, source: 'knob off' };
  if (!(haloParam('beatTurn') > 0)) return haloState.beat;
  var map = (typeof currentBeatMap !== 'undefined' && currentBeatMap) ? currentBeatMap : null;
  var list = (haloBeat.source === 'map' && haloBeat.list.length >= 4) ? haloBeat.list : null;
  var step = map ? Number(map.gridStep) || 0 : 0;
  if (!(step > 0.15 && step <= 2) && list) {
    var gaps = [];
    for (var i = 1; i < Math.min(list.length, 12); i++) {
      var d = list[i].t - list[i - 1].t;
      if (d > 0.15 && d <= 2) gaps.push(d);
    }
    if (gaps.length) {
      gaps.sort(function (a, b) { return a - b; });
      step = gaps[gaps.length >> 1];
    }
  }
  if (step > 0.15 && step <= 2 && list) {
    haloState.beat = { step: step, origin: list[0].t, source: 'beat map' };
    return haloState.beat;
  }
  var rt = (typeof rtBeat !== 'undefined' && rtBeat) ? Number(rtBeat.tempoGap) || 0 : 0;
  if (rt > 0.15 && rt <= 2) {
    haloState.beat = { step: rt, origin: Number(rtBeat.lastHitAt) || 0, source: 'realtime' };
    return haloState.beat;
  }
  haloState.beat = { step: 0, origin: 0, source: map ? 'beat map has no grid' : 'no beat map, no realtime tempo' };
  return haloState.beat;
}

// When the ring starts turning for the line that begins at `startAt`, and for how long.
//
// With the knob off, that is the framing the console gives: rotLead seconds of lead and
// rotDur seconds of travel. With it on, the tempo decides: one beat of travel, and the start
// snapped back onto a beat, so the movement lands with the rhythm instead of stopping
// somewhere between two beats. The turn always ends on the line, because the sung line has
// to arrive at the read mark.
function haloTurnWindow(startAt) {
  var grid = haloBeatGrid();
  if (grid.step > 0 && grid.origin) {
    var start = grid.origin + Math.floor((startAt - grid.step - grid.origin) / grid.step) * grid.step;
    if (start < startAt - grid.step * 2) start = startAt - grid.step * 2;
    var dur = startAt - start;
    if (dur > 0.05) return { startAt: start, dur: dur, source: grid.source + ' beat ' + grid.step.toFixed(3) + 's' };
  }
  return {
    startAt: startAt - Math.max(0, haloParam('rotLead')),
    dur: Math.max(0.05, haloParam('rotDur')),
    // Starts with 'knobs' on purpose: the reason the knobs won is printed after it, and a
    // reader (or a test) must not mistake that reason for the tempo having decided.
    source: 'knobs, because ' + grid.source
  };
}

// Re-anchor the lyric list on one row: that row's angle becomes 0 and the dial takes the
// same shift, so nothing moves on screen but the numbers start again from zero.
//
// A turn that is re-aimed before it finishes never reaches the end-of-turn re-base, so a
// dense song walks the dial's own angle away by a step per line - and when something finally
// re-bases it, the value is a full turn or more away from zero and the next turn has to
// travel all of it. Anchoring on every new target is the zero-crossing test: past a whole
// turn the dial starts counting from zero again instead of from 2*PI.
function haloAnchorLyric(index) {
  var items = haloLyric.items;
  var item = items[index];
  if (!item) return;
  var shift = item.angle;
  if (!shift) return;
  for (var i = 0; i < items.length; i++) items[i].angle -= shift;
  haloLyric.rot += shift;
  haloLyric.rebase += shift;
}

function haloLyricUpdate(t) {
  var items = haloLyric.items;
  if (!items.length) return;
  // The dial's angular velocity, read before anything moves it: a turn that takes over
  // while the previous one is still running has to carry that speed, not restart from rest.
  var elapsed = t - haloLyric.lastT;
  if (elapsed > 1e-6 && elapsed < 0.5) haloLyric.vel = (haloLyric.rot - haloLyric.lastRot) / elapsed;
  haloLyric.lastT = t;
  haloLyric.lastRot = haloLyric.rot;
  // The line being sung, and the one the ring is turning towards.
  var sung = -1;
  var upcoming = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].startAt <= t + 0.001) sung = i;
    else { upcoming = i; break; }
  }
  if (sung < 0) sung = 0;
  if (upcoming < 0) upcoming = items.length - 1;

  // The radial carrier shows one line at a time. A line change starts a swing: the line
  // that was read leaves towards the generation point and the new one arrives on the same
  // disc, so the two hand over at the seam instead of one replacing the other on a frame.
  // The swing lasts as long as a turn, so the two carriers move on the same clock.
  var radial = haloLyric.radial;
  if (sung !== radial.item) {
    radial.prev = radial.item;
    radial.item = sung;
    radial.phase = 0;
    radial.startAt = t;
    radial.dur = Math.max(0.12, haloTurnWindow(items[upcoming].startAt).dur || 0.55);
  }
  if (radial.phase < 1) {
    radial.phase = haloClamp((t - radial.startAt) / Math.max(0.12, radial.dur), 0, 1);
  }

  // The turn starts on the song's beat grid when the app knows it (the 按节拍转环 knob), and
  // on the console's own lead otherwise: the knob is the speed of the turn, not a by-product
  // of how much time was left.
  var turn = haloTurnWindow(items[upcoming].startAt);
  var dur = turn.dur;
  var turnStart = turn.startAt;
  haloLyric.turnSource = turn.source;

  if (haloLyric.tween) {
    var tw = haloLyric.tween;
    if (sung > tw.item) {
      // A seek jumped past the line this turn was heading for: drop the turn.
      haloLyric.tween = null;
      haloLyric.vel = 0;
    } else {
      if (tw.item !== upcoming && t >= turnStart) {
        // A newer line is due before this turn finished: aim at that one instead, and carry
        // the speed the dial already had. Restarting the curve from rest is what made the
        // ring stop dead for a frame and ease back up, which reads as a new animation
        // cutting the old one off.
        haloAnchorLyric(upcoming);
        tw.item = upcoming;
        tw.from = haloLyric.rot;
        tw.to = haloReadAngle() - items[upcoming].angle;
        tw.startAt = t;
        tw.v0 = haloLyric.vel;
      }
      var k = haloClamp((t - tw.startAt) / Math.max(0.05, tw.dur), 0, 1);
      haloLyric.rot = haloEaseJoin(k, tw.from, tw.to, tw.v0 || 0, tw.dur);
      if (k >= 1) {
        haloLyric.tween = null;
        haloLyric.current = tw.item;
        // Rebase so the accumulated angles stay small: the screen angles do not change.
        var rebase = items[tw.item].angle;
        for (var j = 0; j < items.length; j++) items[j].angle -= rebase;
        haloLyric.rot += rebase;
        haloLyric.rebase += rebase;
      }
      return;
    }
  }

  if (haloLyric.current < 0) {
    // First line: put it on the mark straight away, and start the list's angles from zero
    // even when the song was seeked into - otherwise every later turn carries the offset.
    haloLyric.current = sung;
    haloLyric.rot = haloReadAngle() - items[sung].angle;
    haloAnchorLyric(sung);
    haloLyric.vel = 0;
    return;
  }

  // A seek left the mark behind the song: jump to the line being sung.
  if (sung > haloLyric.current || sung < haloLyric.current - 1) {
    haloLyric.current = sung;
    haloLyric.rot = haloReadAngle() - items[sung].angle;
    haloAnchorLyric(sung);
    // The line arrived by jump, not by glide: there is no motion left to hand over.
    haloLyric.vel = 0;
    return;
  }

  if (upcoming === haloLyric.current) return;
  if (t < turnStart) return;
  if (t >= items[upcoming].startAt) {
    // The window has passed (the render loop was parked): put the line on the mark.
    haloLyric.current = upcoming;
    haloLyric.rot = haloReadAngle() - items[upcoming].angle;
    haloAnchorLyric(upcoming);
    haloLyric.vel = 0;
    return;
  }
  haloLyric.pending = upcoming;
  haloAnchorLyric(upcoming);
  haloLyric.tween = {
    item: upcoming,
    from: haloLyric.rot,
    to: haloReadAngle() - items[upcoming].angle,
    startAt: t,
    dur: dur,
    v0: haloLyric.vel
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
  for (var i = 0; i < Math.round(haloParam('webCurves')); i++) {
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
  var count = Math.round(haloParam('runners'));
  for (var i = 0; i < count; i++) haloRunnerList.push(haloNewRunner(true));
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

// The spectrum drives the ring's outermost beams, one bin per cluster.
//
// The eight bands are too coarse to say where along the ring a level sits - a cluster reads
// the average of a fifth of the spectrum - so the beams read the analyser's own bins: the
// cluster's angle picks a point on a log sweep from 40 Hz to 12 kHz across the visible arc,
// and that frequency picks one bin. Equal angle per octave, which is how a spectrum analyser
// reads. The bin and its two neighbours are peaked, so one noisy bin does not leave a beam
// empty, and the result is the level the beam's length is multiplied by.
function haloBeamSpectrum(angle) {
  var bins = haloAudio.spectrum;
  if (!bins || !bins.length) return 0;
  var rel = haloNormAngle(angle - haloReadAngle());
  var t = haloClamp(rel / HALO_BAND_SPREAD + 0.5, 0, 0.9999);
  // Both sources hand over bins that run 0..Nyquist, whatever their count, so the frequency
  // the angle points at is one division away from its index.
  var nyquist = (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.sampleRate) ? audioCtx.sampleRate / 2 : 22050;
  var bin = Math.round(40 * Math.pow(300, t) / Math.max(1, nyquist) * bins.length);
  var lo = Math.max(0, bin - 1);
  var hi = Math.min(bins.length - 1, bin + 1);
  var peak = 0;
  for (var i = lo; i <= hi; i++) peak = Math.max(peak, bins[i] || 0);
  // Read at face value, the way the app's own spectrum panel reads a bin. The old 1.4 was
  // there to keep a quiet bin from leaving a beam empty, but it put every bin above 0.71 at
  // the ceiling, so the loud half of a song was one flat wall of full-length beams.
  return haloClamp(peak / 255, 0, 1);
}

// How far the beams take their length from the sound instead of from their own animation.
// The element families below the drawing (the rays, the wide bars, the fans) all read this.
function haloBeamFollow() {
  return haloClamp(Number(haloParam('beamFollow')) || 0, 0, 1);
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
    var ph = haloParam('panelHeight');
    var hpx = haloRand(ph * 0.42, ph * 1.6);
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
  var angle = slot.a + haloState.decoRot;
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

// A layer of wedges: the blocks of strokes the outer ring is painted from. The original uses
// five layers with angular steps from 0.12 to 0.45 degrees and 4..90 strokes each, which is
// about 8000 strokes a frame; the density knob scales the coverage so the same shape can be
// dialed back.
//
// `kind` is what a wedge reads as. 'ray' is the bundle of thin lines with a dashed tail and a
// domed profile. 'bar' is a row of solid bars, all the same length, separated by their own
// angular step. 'fan' pushes the bars together until the row is one solid sector, so its
// stroke width comes from the step and the `lw` argument is not used.
function haloMakeStrandLayer(stepDeg, rotK, lumK, lw, lenK, solidK, cover, nMin, nMax, brightP, kind, back) {
  var step = stepDeg * Math.PI / 180;
  var family = kind || 'ray';
  var flat = family !== 'ray';
  var nb = Math.floor(HALO_TAU / step);
  var wedges = [];
  var count = Math.max(1, Math.round(nb * cover * haloParam('strandDensity') / ((nMin + nMax) / 2)));
  for (var j = 0; j < count; j++) {
    var n = nMin + ((Math.random() * (nMax - nMin)) | 0);
    var bright = Math.random() < brightP;
    var wedge = {
      i0: (Math.random() * nb) | 0,
      n: n,
      base: haloRand(0.35, 1),
      len: haloRand(0.1, 0.5),
      kick: 0,
      av: 0,             // the spectrum band this wedge sits on, smoothed
      ph: Math.random() * HALO_TAU,
      ph2: Math.random() * HALO_TAU,
      f1: haloRand(0.22, 0.6),
      f2: haloRand(0.8, 1.7),
      lum: bright ? haloRand(0.75, 1) : haloRand(0.16, 0.55),
      tint: Math.random() < 0.5 ? 1 : 0,
      // Widths run wide: one cluster in five is fat enough to be a block of its own. The
      // sector is the exception - its strokes have to stay closed up or the sector breaks
      // into a comb.
      lwK: family === 'fan' ? haloRand(0.9, 1.12)
        : (Math.random() < 0.2 ? haloRand(1.35, 2.1) : haloRand(0.6, 1.15)),
      lenS: haloRand(0.6, 1.25),
      // How hard this cluster follows the bin it stands on. Two clusters reading the same
      // level must not grow by the same amount, or the ring moves as one piece.
      gain: haloRand(0.78, 1.24),
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
  return {
    step: step, rotK: rotK, lumK: lumK, lw: lw, lenK: lenK,
    solidK: flat ? 1 : solidK,
    // The rays are the picture and the blocks are what they are drawn on. A bar or a sector is
    // wide, solid and drawn in one unbroken row, so at the rays' own brightness it stops being a
    // backdrop and becomes the subject of the frame: the ring turns into a wall of white blocks
    // with some thin lines left over.
    brightK: family === 'bar' ? 0.32 : (family === 'fan' ? 0.26 : 1),
    kind: family,
    // How the family answers the sound. The rays glide: their length climbs slowly and falls
    // back slowly, and what motion they have at rest is their own breathing. The bars and the
    // sector snap: a cluster reaches its new length within a frame or two and drops back
    // quickly, which is what makes them read as blocks driven by the beat rather than as
    // faster rays. One formula for all six layers made the ring move as a single piece.
    dyn: family === 'ray' ? 'soft' : 'bounce',
    // How much of a beat this family takes. A beat that multiplied every layer by the same
    // amount scaled the whole outer ring as one object; a ray leaps, a bar lifts, the sector
    // barely moves. The beat is still one event - only the response belongs to the family.
    beatK: family === 'ray' ? 1 : (family === 'bar' ? 0.6 : 0.42),
    // How far the family travels between a bin it cannot hear and a full one. The rays keep a
    // short rest length, which is what their breathing and their slow tail live on. The bars
    // and the sector keep none: their height is the spectrum and nothing else, so a silent
    // passage takes them all the way down to nothing instead of leaving a wall standing there.
    dynMin: family === 'ray' ? 0.16 : 0,
    dynK: family === 'ray' ? 1.32 : (family === 'bar' ? 1.14 : 1.0),
    // Which of the two camera groups the layer is painted in: the far side of the ring first,
    // then the near side. The blocky families sit on the far side so the rays read over them.
    depth: family === 'ray' ? (back ? 0.95 : 1) : 0.95,
    wedges: wedges, off: Math.random() * HALO_TAU
  };
}

function haloBuildStrands() {
  haloStrandLayers = [
    haloMakeStrandLayer(0.22, 0.45, 0.30, 0.55, 1.15, 0.9, 1.1, 20, 90, 0.2, '', true),
    haloMakeStrandLayer(0.16, 0.75, 0.58, 0.8, 1.05, 0.7, 0.9, 14, 70, 0.28, '', true),
    haloMakeStrandLayer(0.12, 1.0, 1.0, 1.0, 1.0, 0.5, 0.75, 12, 60, 0.32),
    // The bars and the sector sit far back: the same gradient and the same mix of tinted and
    // plain clusters, held under a fifth of the rays' light so the thin lines read over them.
    haloMakeStrandLayer(2.2, 1.0, 0.34, 6.0, 0.8, 1, 1.4, 2, 8, 0.3, 'bar'),
    haloMakeStrandLayer(0.12, 1.0, 0.85, 1.0, 1.0, 0.5, 0.55, 14, 70, 0.32),
    haloMakeStrandLayer(3.6, 1.0, 0.32, 1.0, 0.7, 1, 1.6, 4, 8, 0.45, 'fan')
  ];
  haloPulseList = [];
}

// The outer elements are drawn family by family, not in the order they were built: adding or
// removing a layer must not quietly change what covers what.
function haloDrawStrandGroup(ctx, depth, collect) {
  for (var i = 0; i < haloStrandLayers.length; i++) {
    var layer = haloStrandLayers[i];
    if (layer.depth !== depth) continue;
    // Only the rays have a tail to hand over; a bar and a sector are solid to their tip.
    haloDrawStrands(ctx, layer, layer.kind === 'ray' ? collect : null);
  }
}

// How far out the screen reaches along a given direction: the distance from the ring's
// centre to the viewport edge, measured along that ray.
//
// The ray starts at the ring's centre, because that is the point the world is arranged
// around: the camera transform puts the centre wherever the framing knobs and the user's
// own pan put it, and everything on the ring is measured from there. Measuring from the
// world origin instead (the transform's own offset) keeps the wrong rays and drops the
// ones that are really on screen, which is what made the decorations and the lyrics
// appear and vanish as the ring was dragged.
//
// Both ends of the run matter. The centre is off screen in the default framing (and
// whenever the user pans it out), and then the screen does not start at the centre: the
// ray first crosses a viewport edge at `enter`. A test on the exit alone keeps the stretch
// between the centre and that edge, which is drawn for nothing and, for a lyric line,
// starts the text off screen.
function haloVisibleSpan(angle, pop) {
  var s = haloState;
  var z = haloSceneZoom(1) * (pop || 1);
  var ox = s.w / 2 - haloCam.zoom * haloPanTotalX() + s.shakeX;
  var oy = s.h / 2 - haloCam.zoom * haloPanTotalY() + s.shakeY;
  var ca = Math.cos(angle);
  var sa = Math.sin(angle);
  var enter = 0;
  var exit = Infinity;
  if (Math.abs(ca) > 1e-6) {
    var tx1 = (0 - ox) / (z * ca);
    var tx2 = (s.w - ox) / (z * ca);
    enter = Math.max(enter, Math.min(tx1, tx2));
    exit = Math.min(exit, Math.max(tx1, tx2));
  } else if (ox < 0 || ox > s.w) {
    return { enter: Infinity, exit: -Infinity };
  }
  if (Math.abs(sa) > 1e-6) {
    var ty1 = (0 - oy) / (z * sa);
    var ty2 = (s.h - oy) / (z * sa);
    enter = Math.max(enter, Math.min(ty1, ty2));
    exit = Math.min(exit, Math.max(ty1, ty2));
  } else if (oy < 0 || oy > s.h) {
    return { enter: Infinity, exit: -Infinity };
  }
  if (exit < enter) return { enter: Infinity, exit: -Infinity };
  return { enter: enter, exit: exit };
}

// Does the stretch [r0, r1] of the ray at `angle` reach the screen? `pop` is the layer's
// own scale against the camera, so the ring's beats do not make its outer decorations
// blink out at the edge of the screen.
function haloRayVisible(angle, r0, r1, pop) {
  var span = haloVisibleSpan(angle, pop);
  return span.exit >= r0 && span.enter <= r1;
}

function haloWedgeVisible(wedge, layer) {
  var s = haloState;
  var rot = s.decoRot * layer.rotK + layer.off;
  var r0 = s.RO + 3;
  // A wedge is a block of lines over its own angular span (up to about 20deg on the dense
  // layer). Deciding the block on its middle ray alone drops the whole block, the lines
  // that are still on screen with it, so the block's two edges get a say too.
  var a0 = (wedge.i0 + 0.5) * layer.step + rot;
  var a1 = (wedge.i0 + wedge.n - 0.5) * layer.step + rot;
  var mid = (wedge.i0 + wedge.n / 2) * layer.step + rot;
  return haloRayVisible(a0, r0, s.RMAX) || haloRayVisible(mid, r0, s.RMAX) || haloRayVisible(a1, r0, s.RMAX);
}

function haloUpdateStrands(dt, env) {
  var s = haloState;
  var follow = haloBeamFollow();
  // Straightening. The follow knob is also "how much of the ring is the spectrum": at the top
  // of its travel every cluster drops the randomness that makes it its own beam - its base
  // length, its length scale, its gain on the bin - the beat's travelling wave is left out and
  // the easing collapses. What is left on the ring is the bin under each cluster and nothing
  // else, which is what a spectrum looks like. Below the top the ring keeps its own character,
  // because the twelfth power keeps this at almost nothing through the usable range.
  var align = Math.pow(follow, 12);
  var shapeK = 1 - align;
  var snap = 1 + 9 * align;
  // The beat's own envelope for the beams: every beat multiplies every beam's length, then
  // it falls back over a second or so without anything else driving it.
  s.beamKick = Math.max(0, (s.beamKick || 0) * Math.exp(-dt * 2.6));
  for (var p = haloPulseList.length - 1; p >= 0; p--) {
    var pulse = haloPulseList[p];
    pulse.c += pulse.v * dt;
    pulse.life -= dt;
    if (pulse.life <= 0) haloPulseList.splice(p, 1);
  }
  for (var i = 0; i < haloStrandLayers.length; i++) {
    var layer = haloStrandLayers[i];
    // Two speeds of motion, not one. A bar reaches its new length in a frame or two and lets go
    // fast; a ray climbs and sags. One formula for all six layers made the ring move as a single
    // piece, which is what read as stiff. The follow knob scales both, so at full follow even the
    // rays answer quickly - but a bar still answers several times faster than a ray, and the
    // level it answers to is smoothed less.
    var bounce = layer.dyn === 'bounce';
    // `snap` is the straightening's other half: at the top of the follow knob the easing is ten
    // times faster, so a bin that changes is on screen by the next frame instead of sliding in
    // over a third of a second - a spectrum that lags its song is the "smooth" the knob was
    // supposed to fix.
    var rise = (bounce ? (9 + 18 * follow) : (4 + 13 * follow)) * snap;
    var fall = (bounce ? (2.2 + 4 * follow) : (1.3 + 2.4 * follow)) * snap;
    var avRise = (bounce ? (16 + 10 * follow) : (8 + 12 * follow)) * snap;
    var avFall = (bounce ? (5 + 5 * follow) : (2.2 + 4.5 * follow)) * snap;
    for (var w = 0; w < layer.wedges.length; w++) {
      var wedge = layer.wedges[w];
      var rot = s.decoRot * layer.rotK + layer.off;
      var am = haloNormAngle((wedge.i0 + wedge.n / 2) * layer.step + rot);
      wedge.vis = haloWedgeVisible(wedge, layer);
      wedge.flow += dt * wedge.dsp * (0.45 + 2.2 * env);
      // The spectrum drives the outer beams: a wedge reads the band its own angle sits
      // on, and that band pushes the beam further out and brightens it. The cluster's own
      // gain is part of the level, so two clusters on the same band do not grow alike - until
      // the knob is at the top, where every cluster has to read its bin at face value.
      var gainEff = 1 + (wedge.gain - 1) * shapeK;
      var av = haloClamp(haloBeamSpectrum(am) * haloParam('spectrumGain') * gainEff, 0, 1);
      wedge.av += (av - wedge.av) * Math.min(1, (av > wedge.av ? avRise : avFall) * dt);
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
      // The length is the level at this cluster's own bin times the cluster's own length, and
      // the beat multiplies it: a beat grows every beam and the envelope falls back by itself.
      var beat = 1 + 0.85 * layer.beatK * (s.beamKick || 0) + 0.5 * layer.beatK * wedge.kick;
      // The ceiling rises with the beat too: a loud passage already pins most beams at their
      // full length, and a beat that could only multiply a clamped value would be invisible.
      var cap = (bounce ? 1 : 1.05) + layer.beatK * (0.5 * (s.beamKick || 0) + 0.2 * wedge.kick);
      // The cluster's own base length and length scale are the last of the randomness to go:
      // they differ by nearly three to one across a layer, so while they are in, the ring's
      // silhouette is each cluster's luck rather than the spectrum under it.
      var baseEff = 1 + (wedge.base - 1) * shapeK;
      var lenEff = 1 + (wedge.lenS - 1) * shapeK;
      if (bounce) {
        // A block: it takes its length from its bin and drops straight back. No breathing and
        // no slow tail - that is the rays' character, and giving it to the bars is what made
        // the families look like one thing.
        // Nothing gets in without the bin: nothing here has a floor, and even the beat wave is
        // scaled by the level, so a wave that reaches a cluster standing in silence must not put
        // the blocks back up - that is the wall that used to stand there between songs.
        var targetB = Math.min(cap, baseEff * (layer.dynMin + layer.dynK * wedge.av) * beat * lenEff + hit * 0.75 * wedge.av * shapeK);
        wedge.kick *= Math.exp(-dt * (2.4 + 0.4 * follow));
        wedge.len += (targetB - wedge.len) * Math.min(1, (targetB > wedge.len ? rise : fall) * dt);
        continue;
      }
      // The idle breathing is what is left of the ray's own animation once it stopped
      // following the sound, so at full follow a ray has no motion but the music's.
      var n1 = 0.5 + 0.5 * Math.sin(s.time * wedge.f1 + wedge.ph);
      var breath = (1 - follow) * 0.05 * (0.6 + 0.4 * n1);
      var target = Math.min(cap, breath + baseEff * (layer.dynMin + layer.dynK * wedge.av) * beat * lenEff + hit * (0.7 + 0.05 * follow) * shapeK);
      wedge.kick *= Math.exp(-dt * 1.8);
      wedge.len += (target - wedge.len) * Math.min(1, (target > wedge.len ? rise : fall) * dt);
    }
  }
}

// A beat sends a wave around the ring and kicks a few wedges.
function haloStrandBeat(weight) {
  var s = haloState;
  // The beams stretch with the beat only as far as the music allows, the same rule the pop
  // and the shake follow.
  var room = 0.2 + 0.8 * haloMotionGate();
  s.beamKick = Math.min(1.2, Math.max(s.beamKick || 0, (0.35 + (Number(weight) || 0) * 0.75) * room));
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
  var span = (s.RMAX - s.RO - 20) * haloParam('beamLength');
  var r0 = s.RO + 3;
  var rot = s.decoRot * layer.rotK + layer.off;
  var edgeAlpha = [0.28, 0.62, 1];
  // The lines inside a cluster shimmer a little out of phase; follow takes that away too, so
  // a cluster's own lines do not argue with the bin they all read.
  var wob = 0.08 * (1 - haloBeamFollow());
  // The blocky families: every stroke in the cluster gets the same length and the same
  // brightness, so the row reads as bars (or, with the step closed up, as one sector) rather
  // than as a bundle of rays with a domed profile.
  var flat = layer.kind !== 'ray';
  ctx.lineCap = 'butt';
  for (var i = 0; i < layer.wedges.length; i++) {
    var wedge = layer.wedges[i];
    if (!wedge.vis) continue;
    var L = wedge.len * span * layer.lenK;
    if (L < 3) continue;
    var a0 = haloNormAngle(wedge.i0 * layer.step + rot);
    var alpha = Math.min(1, wedge.lum * layer.lumK * (0.3 + 0.7 * Math.min(1, wedge.len * 1.8)) * layer.brightK * (1 + wedge.av * 0.8));
    if (alpha < 0.005) continue;
    var lwW = layer.kind === 'fan'
      ? layer.step * (r0 + L * 0.5) * 0.95 * wedge.lwK
      : layer.lw * wedge.lwK;
    var paths = [new Path2D(), new Path2D(), new Path2D()];
    for (var k = 0; k < wedge.n; k++) {
      var a = a0 + (k + 0.5) * layer.step;
      var ca = Math.cos(a);
      var sa = Math.sin(a);
      var edge = Math.sin(Math.PI * (k + 0.5) / wedge.n);
      var pr = flat ? 1 : wedge.prof[k];
      var l = flat ? L : L * pr * (0.5 + 0.5 * Math.sqrt(edge)) * (1 - wob + wob * Math.sin(s.time * wedge.pf[k] + wedge.pp[k]));
      var b = flat ? 2 : (edge < 0.38 ? 0 : (edge < 0.72 ? 1 : 2));
      var solid = l * (layer.solidK + 0.3 * pr * (1 - layer.solidK));
      paths[b].moveTo(s.cx + ca * r0, s.cy + sa * r0);
      paths[b].lineTo(s.cx + ca * (r0 + solid), s.cy + sa * (r0 + solid));
      if (!collect || flat) continue;
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
    // The blocks are grey haze, not white light: they take no tint at all, so the only colour
    // on the ring is the rays' own. The rays keep the tinted gradients.
    ctx.strokeStyle = flat ? 'rgba(206,210,220,1)' : (haloGradient['s' + wedge.tint] || haloGradient.s0);
    ctx.lineWidth = lwW;
    for (var b2 = 0; b2 < 3; b2++) {
      ctx.globalAlpha = alpha * edgeAlpha[b2];
      ctx.stroke(paths[b2]);
    }
    if (flat) {
      // One wide, faint stroke around the same row: the blocks sit in fog instead of being cut
      // out of the black, which is what keeps them behind the rays even while they move. It is
      // flagged so the stroke log can tell the fog from the block it wraps.
      ctx.haloFog = true;
      ctx.globalAlpha = alpha * 0.5;
      ctx.lineWidth = lwW * 2.2;
      ctx.stroke(paths[2]);
      ctx.haloFog = false;
    } else if (wedge.lum > 0.85) {
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
    rot0: s.decoRot,
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
    var d = Math.abs(haloNormAngle(slot.a + haloState.decoRot - angle));
    if (d < bd) { bd = d; best = slot; }
  }
  if (best && bd < 0.12) best.flash = Math.max(best.flash, 1);
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
      haloFlashSlotAt(c.angle + (haloState.decoRot - c.rot0));
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
    ctx.rotate(s.decoRot - c.rot0);
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
    a: a - s.decoRot,
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
      a: a + (i / n - 0.5) * spread + haloGauss() * 0.0015 - s.decoRot,
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
    var a = haloNormAngle(f.a + s.decoRot);
    if (!haloRayVisible(a, Math.max(s.RO + 3, f.r - f.len), f.r)) continue;
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
    ctx.globalAlpha = Math.min(1, HALO_FLY_A[f0.lv] * (f0.burst ? 1.4 : 0.9) * haloParam('streakAmount'));
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
    a: haloRand(0, HALO_TAU) - haloState.decoRot,
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
    a: a == null ? haloRand(0, HALO_TAU) * 0.95 - haloState.decoRot : a,
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
  var step = HALO_HAZE_STEP * 0.55 / Math.max(0.15, haloParam('strandDensity'));
  ctx.globalCompositeOperation = 'lighter';
  for (var i = 0; i < haloHazeList.length; i++) {
    var h = haloHazeList[i];
    var e = haloHazeEnv(h);
    if (e <= 0.01) continue;
    var L = h.cur * span;
    if (L < 4) continue;
    var mid = h.a + s.decoRot + h.drift * h.age;
    haloRadialLines(ctx, mid - h.w / 2, mid + h.w / 2, step, r0, L, h.seed, 0.45);
    ctx.strokeStyle = haloGradient['h' + h.tint] || haloGradient.h1;
    var haze = haloParam('hazeAmount');
    ctx.globalAlpha = Math.min(1, h.alpha * e * 0.05 * haze);
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.globalAlpha = Math.min(1, h.alpha * e * 0.6 * haze);
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
  var step = HALO_HAZE_STEP * 0.45 / Math.max(0.15, haloParam('strandDensity'));
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = haloGradient.s0 || '#fff';
  for (var i = 0; i < haloFlareList.length; i++) {
    var f = haloFlareList[i];
    var t = f.age / f.life;
    var e = (t < 0.15 ? t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 2)) * f.alpha;
    if (e <= 0.01) continue;
    var L = f.len * (0.6 + 0.4 * haloEaseOut(Math.min(1, t * 3)));
    var mid = f.a + s.decoRot;
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
    if (slot.flash > 0) slot.flash = Math.max(0, slot.flash - dt * 1.25);
    if (!slot.c) continue;
    if (!haloSlotVisible(slot)) continue;
    var A = slot.a + s.decoRot;
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
// original's ring sat at the left edge, this one sits in the middle. Each loop names the
// radii it really draws at — the hairlines are in the band, the inner ticks inside R and
// the outer ones past RO — because one shared threshold keeps the wrong set.
function haloRingTicks(stepRad, r0, r1, fn) {
  var s = haloState;
  var count = Math.ceil(HALO_TAU / stepRad);
  for (var n = 0; n < count; n++) {
    var a = n * stepRad + s.decoRot;
    if (!haloRayVisible(a, r0, r1, s.pulse)) continue;
    fn(Math.cos(a), Math.sin(a), n, a);
  }
}

function haloDrawRim(ctx) {
  var s = haloState;
  var RB = haloRimWidth();
  var pulse = s.ringPulse || 0;
  ctx.beginPath();
  var step = 0.5 * Math.PI / 180;
  haloRingTicks(step, s.R, s.RO, function (ca, sa, n) {
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
  haloRingTicks(1 * Math.PI / 180, s.R - 5, s.R - 2, function (ca, sa) {
    ctx.moveTo(ca * (s.R - 2), sa * (s.R - 2));
    ctx.lineTo(ca * (s.R - 5), sa * (s.R - 5));
  });
  haloRingTicks(0.25 * Math.PI / 180, s.RO + 2, s.RO + 11, function (ca, sa, n) {
    var m = ((n % 20) + 20) % 20;
    var L = m === 0 ? 9 : m % 5 === 0 ? 5 : 2.5;
    ctx.moveTo(ca * (s.RO + 2), sa * (s.RO + 2));
    ctx.lineTo(ca * (s.RO + 2 + L), sa * (s.RO + 2 + L));
  });
  ctx.strokeStyle = 'rgba(230,233,240,0.5)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
}

// -------------------------------------------------------------- lyric motion

// The lyric rows enter and leave with the app's own lyric motion, not with one of the
// ring's: the console's 歌词动画 section decides how a line arrives and goes (漂浮/柔滑/玻璃/
// 线光/故障), how soft the movement is, how clear the neighbouring lines are, where the edge
// fades and, for the glitch style, how the text breaks up. The ring reuses that profile on
// its own layout, so the two never disagree about what a line's entrance looks like.
function haloLyricMotion() {
  if (typeof lyricMotionProfile === 'function') {
    var profile = lyricMotionProfile();
    if (profile && profile.style) return profile;
  }
  // The same defaults the profile carries, for a harness that runs this file alone.
  var own = (typeof fx !== 'undefined' && fx) ? fx : null;
  var soft = own && isFinite(Number(own.lyricMotionSoftness)) ? haloClamp(Number(own.lyricMotionSoftness), 0, 1.3) : 0.72;
  return {
    style: (own && own.lyricMotionStyle) || 'float',
    enter: 0.62 * soft,
    exit: 0.52 * soft,
    slide: 0.38 * soft,
    contextDrift: 0.066,
    edgeBoost: 1,
    sweep: 0.72,
    shimmer: 0.22,
    glitch: 0,
    glitchSlice: 0,
    glitchChroma: 0,
    glitchRate: 1,
    glitchJitter: 0,
    glitchCameraBind: false,
    floatAmp: 1
  };
}

// The knobs beside the motion: how clear the neighbouring rows are, how far their clarity
// falls off, and where the screen's edge starts taking a row away.
function haloLyricContextSettings() {
  var own = (typeof fx !== 'undefined' && fx) ? fx : null;
  var opacity = own && isFinite(Number(own.lyricContextOpacity)) ? Number(own.lyricContextOpacity) : 0.54;
  var spread = own && isFinite(Number(own.lyricContextSpread)) ? Number(own.lyricContextSpread) : 1.96;
  var edge = own && isFinite(Number(own.lyricEdgeFade)) ? Number(own.lyricEdgeFade) : 0.32;
  return {
    opacity: haloClamp(opacity, 0.12, 1),
    spread: haloClamp(spread, 0.6, 2.4),
    edgeFade: haloClamp(edge, 0, 1)
  };
}

// ---------------------------------------------------------- lyric colour and carrier

// The colours are the app's own lyric colours: a custom colour from the visual settings
// wins, otherwise the palette taken from the cover - the same two the stage lyrics paint
// with. The ring decides no colour of its own, so a theme change reaches it the way it
// reaches everything else. With the modules that own those settings absent (the test
// harness runs this file alone) the same defaults are used.
function haloLyricPalette() {
  var own = (typeof fx !== 'undefined' && fx) ? fx : null;
  var source = null;
  if (own && own.lyricColorMode === 'custom' && typeof lyricPaletteFromHex === 'function') {
    source = lyricPaletteFromHex(own.lyricColor);
  } else if (typeof stageLyrics !== 'undefined' && stageLyrics) {
    source = stageLyrics.coverPalette || stageLyrics.palette || null;
  }
  if (typeof effectiveLyricPalette === 'function') return effectiveLyricPalette(source);
  var base = (own && own.lyricColor) || '#a9b8c8';
  var hi = (own && own.lyricHighlightColor) || '#fff0b8';
  return { primary: base, secondary: '#9cffdf', highlight: hi, glow: 'rgba(143,233,255,0.34)', glowColor: '#9cffdf' };
}

// A palette entry with an alpha on it. The entries are hex colours; anything else (an
// rgba() the palette already carries) is passed through untouched.
function haloRgba(color, alpha) {
  var text = String(color || '').trim();
  var m = /^#([0-9a-f]{6})$/i.exec(text);
  var hex = m ? m[1] : '';
  if (!hex) {
    var three = /^#([0-9a-f]{3})$/i.exec(text);
    if (three) hex = three[1][0] + three[1][0] + three[1][1] + three[1][1] + three[1][2] + three[1][2];
  }
  if (!hex) return text;
  var n = parseInt(hex, 16);
  var a = haloClamp(Number(alpha) || 0, 0, 1);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a.toFixed(3) + ')';
}

// What the screen shows of the ring: how much of it, where the visible stretch is
// centred, and where the ring's own centre landed. The lyric carrier follows this.
function haloViewArc() {
  var s = haloState;
  var z = haloCam.zoom;
  var cx = s.w / 2 - z * haloPanTotalX();
  var cy = s.h / 2 - z * haloPanTotalY();
  var n = 72;
  var seen = 0;
  var sx = 0;
  var sy = 0;
  for (var i = 0; i < n; i++) {
    var a = i / n * HALO_TAU;
    var x = cx + z * s.R * Math.cos(a);
    var y = cy + z * s.R * Math.sin(a);
    if (x < 0 || x > s.w || y < 0 || y > s.h) continue;
    seen += 1;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  return { frac: seen / n, mid: seen ? Math.atan2(sy, sx) : 0, cx: cx, cy: cy };
}

// Which carrier the camera is asking for.
//
// side   - the rim runs off the screen left and right: the list bends along the rim, one
//          row per line, which is what the preset ships with.
// inside - only the middle of the ring is on screen: one line at a time, both texts on
//          inner arcs.
// top    - the ring's top is what the camera shows: the original on the outer arc, the
//          translation inside it, both above.
// bottom - its bottom: the original on the inner arc and the translation on the outer one.
//          At the bottom of a circle the inner arc is the upper one on screen, so this
//          keeps the original above its translation.
// whole  - the whole ring fits: both texts on the outer arc, the original across the top
//          and the translation along the bottom, at a size that reads from further away.
function haloViewRegion() {
  var s = haloState;
  // The console says which carrier to use. The camera only picks where on the ring the
  // radial line sits - it must never switch back to the list, because that switch is what
  // made the lyrics jump between two layouts while the camera moved.
  if (haloParam('axialLyric') > 0) return 'side';
  var arc = haloViewArc();
  var centred = arc.cx >= s.w * 0.08 && arc.cx <= s.w * 0.92 && arc.cy >= s.h * 0.08 && arc.cy <= s.h * 0.92;
  // The whole-ring carrier puts the text *outside* the rim, so "the whole ring is visible"
  // has to include the ring the text rides on and the line's own height - otherwise the
  // line is painted into the screen's edge on the way in.
  var z = haloCam.zoom;
  var need = (s.RO + haloParam('textGap') + haloLyricFontPx() * 1.9) * z;
  var fits = arc.cx - need >= 0 && arc.cx + need <= s.w && arc.cy - need >= 0 && arc.cy + need <= s.h;
  if (centred && fits) return 'whole';
  if (arc.frac < 0.05) return 'inside';
  var sideways = Math.abs(Math.cos(arc.mid)) > 0.6;
  if (!centred) {
    // A side view keeps the text straight along the read ray: a bent line at the side of the
    // ring stands on end. Top and bottom views can use the arcs, where they read.
    return sideways ? 'inline' : (Math.sin(arc.mid) < 0 ? 'top' : 'bottom');
  }
  // The ring is on screen but too big to show the whole: the text goes inside it.
  return 'inside';
}

// Where that line lives: the two radii that carry the original and the translation, and
// the angle each one sits at. `seam` is the point opposite the read mark - the same point
// the dial's rows are born and cut at, so the read angle knob moves both carriers alike.
function haloRadialPlan(region) {
  var s = haloState;
  var arc = haloViewArc();
  var fontPx = haloLyricFontPx();
  var gap = fontPx * 1.35 + haloParam('lineGap') * 0.5;
  var outer = s.RO + haloParam('textGap');
  var plan = {
    region: region,
    seam: haloNormAngle(haloReadAngle() + Math.PI),
    font: fontPx,
    r0: outer,
    r1: outer,
    a0: -Math.PI / 2,
    a1: -Math.PI / 2
  };
  if (region === 'whole') {
    plan.font = fontPx * HALO_RADIAL_FAR_SCALE;
    plan.r0 = outer + plan.font * 0.55;
    plan.r1 = plan.r0;
    plan.a0 = -Math.PI / 2;
    plan.a1 = Math.PI / 2;
    return plan;
  }
  if (region === 'inline') {
    // Straight along the read ray, ending at the ring's inner edge. The radius belongs to the
    // ring, so moving the camera carries the line the way it carries everything else; the
    // screen only caps it, and never below a few line heights.
    var read = haloReadAngle();
    var run = haloVisibleSpan(read);
    var rim = Math.max(plan.font * 3, s.R - s.band * 1.1);
    var reach = isFinite(run.exit) ? Math.max(plan.font * 3, run.exit - plan.font * 2) : rim;
    plan.mode = 'radial';
    plan.a0 = plan.a1 = read;
    plan.r0 = Math.min(rim, reach);
    plan.r1 = plan.r0;
    return plan;
  }
  if (region === 'inside') {
    // The carrier belongs to the ring: it rides at a fixed fraction of the ring's radius, so
    // moving the camera carries it the way it carries everything else on the ring instead of
    // sliding the other way. The screen only caps it when the ring is bigger than the view,
    // and never below a few lines' height - a wide screen zoomed in used to squeeze this
    // carrier to nothing.
    var z = Math.max(0.2, haloCam.zoom);
    var room = Math.max(0, Math.min(arc.cx, s.w - arc.cx, arc.cy, s.h - arc.cy) / z);
    var attached = s.R * 0.72;
    var screenMax = Math.max(plan.font * 3.2, room * 0.92);
    var inside = Math.min(attached, screenMax);
    plan.r0 = inside;
    plan.r1 = Math.max(plan.font * 1.8, inside - gap * 0.8);
    plan.a0 = -Math.PI / 2;
    plan.a1 = plan.a0;
    return plan;
  }
  plan.a0 = plan.a1 = region === 'top' ? -Math.PI / 2 : Math.PI / 2;
  // Both arcs sit outside the rim, one line-height apart: the one further out is the upper
  // one on screen at the top of the circle and the lower one at the bottom, which is what
  // keeps the original above its translation either way.
  if (region === 'top') {
    plan.r0 = outer + gap;
    plan.r1 = outer;
  } else {
    plan.r0 = outer;
    plan.r1 = outer + gap;
  }
  return plan;
}

// The per-glyph widths of a line laid on the circle, measured once with the font of the
// run that shows it. One line at a time, so this is at most two measurements per line.
function haloArcMetrics(ctx, item, key, text, fontPx, weight) {
  var cache = item[key];
  if (cache && cache.fontPx === fontPx && cache.text === text) return cache;
  var chars = text.split('');
  var widths = [];
  var total = 0;
  ctx.font = weight + ' ' + fontPx.toFixed(1) + 'px ' + HALO_FONT;
  for (var i = 0; i < chars.length; i++) {
    var w = ctx.measureText(chars[i]).width;
    if (!(w > 0)) w = fontPx * 0.6;
    widths.push(w);
    total += w;
  }
  cache = { fontPx: fontPx, text: text, chars: chars, widths: widths, total: total };
  item[key] = cache;
  return cache;
}

// One line painted along the ring's own circle: each glyph sits on the arc with its feet
// towards the centre and stays upright on screen, so the ring bends the line instead of
// turning the letters. Below the middle of the circle the glyphs face inwards, which is
// what keeps the bottom half readable.
function haloDrawArcLine(ctx, item, key, text, fontPx, weight, radius, center, faceOut, alpha, color, winCenter, winHalf) {
  var metrics = haloArcMetrics(ctx, item, key, text, fontPx, weight);
  var face = faceOut ? 1 : -1;
  var span = metrics.total / Math.max(1, radius);
  // A line that fits is centred on the read spot; one that does not starts at the window's
  // entry edge, so what is cut is the end of the line and not the middle of it.
  var a = center - face * Math.min(span / 2, winHalf - 0.02);
  ctx.font = weight + ' ' + fontPx.toFixed(1) + 'px ' + HALO_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (var i = 0; i < metrics.chars.length; i++) {
    var half = metrics.widths[i] / 2 / Math.max(1, radius);
    a += face * half;
    var off = Math.abs(haloNormAngle(a - winCenter));
    // A line longer than its window is cut there, the way a list scrolls off its edge -
    // it is not allowed to keep going and wrap around the rest of the circle.
    if (off > winHalf) break;
    // Fade towards the window's ends, so a line leaving through the generation point
    // dissolves instead of being sliced by a hard edge.
    var edge = haloClamp((winHalf - off) / 0.18, 0, 1);
    ctx.save();
    ctx.rotate(a + (faceOut ? Math.PI / 2 : -Math.PI / 2));
    ctx.translate(0, faceOut ? -radius : radius);
    ctx.fillStyle = haloRgba(color, alpha * edge);
    ctx.fillText(metrics.chars[i], 0, 0);
    ctx.restore();
    a += face * half;
  }
}

// The angular window the radial line is cut at: a sector of the ring, the same shape the
// dial's mask has, so a line leaving the window is cut there and nowhere else.
function haloSectorClip(ctx, rIn, rOut, center, half) {
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1, rIn), center - half, center + half);
  ctx.arc(0, 0, Math.max(2, rOut), center + half, center - half, true);
  ctx.closePath();
  ctx.clip();
}

// One disc: the original on one arc, its translation on the other. `offset` is how far
// round the disc has turned from where the line is read, which is what swings a line in
// and out through the generation point.
function haloDrawRadialDisc(ctx, item, plan, offset, alpha, pal) {
  var a0 = plan.a0 + offset;
  var faceOut0 = Math.sin(plan.a0) < 0;
  var m = haloArcMetrics(ctx, item, 'arcMain', item.text, plan.font, '600');
  var half0 = Math.min(HALO_RADIAL_MAX_HALF, m.total / Math.max(1, plan.r0) / 2 + 0.22);
  ctx.save();
  haloSectorClip(ctx, plan.r0 - plan.font * 1.3, plan.r0 + plan.font * 1.3, a0, half0);
  haloDrawArcLine(ctx, item, 'arcMain', item.text, plan.font, '600', plan.r0, a0, faceOut0,
    alpha, pal.highlight, a0, half0);
  ctx.restore();
  if (!item.sub) return;
  var a1 = plan.a1 + offset;
  var faceOut1 = Math.sin(plan.a1) < 0;
  var subFont = plan.font * 0.66;
  var ms = haloArcMetrics(ctx, item, 'arcSub', item.sub, subFont, '400');
  var half1 = Math.min(HALO_RADIAL_MAX_HALF, ms.total / Math.max(1, plan.r1) / 2 + 0.2);
  ctx.save();
  haloSectorClip(ctx, plan.r1 - subFont * 1.3, plan.r1 + subFont * 1.3, a1, half1);
  haloDrawArcLine(ctx, item, 'arcSub', item.sub, subFont, '400', plan.r1, a1, faceOut1,
    alpha * 0.8, pal.primary, a1, half1);
  ctx.restore();
}

// The radial carrier itself. One line is read; while the disc turns, the line that was
// read swings towards the generation point and the new one arrives from the other side of
// the wheel, both cut by their own window, so the two are aligned on the same disc and the
// outgoing text meets the incoming one at the seam.
// A line laid straight along the read ray inside the ring, its translation under it. With the
// text horizontal it reads at any side of the ring; the line ends at the ring's inner edge so
// it never crosses the band, and it rides the ring's radius rather than the screen's.
function haloDrawRadialRow(ctx, item, plan, offset, alpha, pal) {
  var size = plan.font;
  var flip = Math.cos(plan.a0) < 0;
  var width = 0;
  ctx.save();
  ctx.rotate(flip ? plan.a0 + Math.PI : plan.a0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + size.toFixed(1) + 'px ' + HALO_FONT;
  width = haloLyricWidth(item, ctx, size);
  var x0 = flip ? -(plan.r0 + width) : plan.r0 - width;
  x0 += offset;
  ctx.fillStyle = haloRgba(pal.highlight, alpha);
  ctx.fillText(item.text, x0, 0);
  if (item.sub) {
    ctx.font = '400 ' + (size * 0.62).toFixed(1) + 'px ' + HALO_FONT;
    ctx.fillStyle = haloRgba(pal.primary, alpha * 0.8);
    ctx.fillText(item.sub, x0, size * 0.95);
  }
  ctx.restore();
}

function haloDrawRadialLyric(ctx, region) {
  var s = haloState;
  var items = haloLyric.items;
  var plan = haloRadialPlan(region);
  var pal = haloLyricPalette();
  var rl = haloLyric.radial || { item: -1, prev: -1, phase: 1 };
  var cur = rl.item >= 0 ? rl.item : Math.max(0, haloLyric.current);
  var phase = haloClamp(rl.phase, 0, 1);
  var spin = haloNormAngle(plan.seam - plan.a0);
  var ease = haloEaseIO(phase);
  ctx.save();
  ctx.translate(s.cx, s.cy);
  if (plan.mode === 'radial') {
    // The straight line does not turn like a disc: it slides in along the ray and fades.
    var slide = plan.font * 1.6;
    if (rl.prev >= 0 && rl.prev !== cur && phase < 1 && items[rl.prev]) {
      haloDrawRadialRow(ctx, items[rl.prev], plan, Math.min(0, phase * slide), 1 - phase * 0.5, pal);
    }
    if (items[cur]) {
      haloDrawRadialRow(ctx, items[cur], plan, -Math.max(0, 1 - phase) * slide, Math.min(1, 0.35 + phase * 0.65), pal);
    }
    ctx.restore();
    return;
  }
  if (rl.prev >= 0 && rl.prev !== cur && phase < 1 && items[rl.prev]) {
    // The disc turns: the line being left behind has gone `ease` of the way to the seam,
    // the new one is still `1 - ease` of the way behind it.
    haloDrawRadialDisc(ctx, items[rl.prev], plan, spin * ease, 1 - phase * 0.45, pal);
  }
  if (items[cur]) {
    haloDrawRadialDisc(ctx, items[cur], plan, spin * (ease - 1), Math.min(1, 0.25 + phase * 0.75), pal);
  }
  ctx.restore();
}

// The lyric list is an ordinary left-aligned list that has been bent over the ring's
// edge: every line starts on its own radial line at the rim and runs outward from
// there, so the block still reads top to bottom, one row per line. The line being sung
// sits on the read mark, which is the middle of the block: the lines already sung are
// above it and the ones still to come below, so the list runs in at the bottom and out
// at the top.
//
// The block is a window, not the whole song: at 0 on the knob it runs to the point
// opposite the read mark, and any other number caps it to that many lines centred on the
// one being sung. Lines outside it are not measured and not drawn, and the mask over the
// window's arc cuts a line at the window's end rather than letting it reappear elsewhere.
function haloDrawLyricText(ctx) {
  var s = haloState;
  var items = haloLyric.items;
  if (!items.length) return;
  // Which carrier the camera is asking for: the list bent along the rim, or one line on
  // the ring's own circle. The region is kept on the state so the status probe and the
  // tests can say which one drew the frame.
  var region = haloViewRegion();
  s.lyricRegion = region;
  if (region !== 'side') {
    haloDrawRadialLyric(ctx, region);
    return;
  }
  var pal = haloLyricPalette();
  var motion = haloLyricMotion();
  var context = haloLyricContextSettings();
  var fontPx = haloLyricFontPx();
  var contextPx = Math.max(9, fontPx * HALO_LYRIC_CONTEXT_SCALE);
  var textR = s.RO + haloParam('textGap');
  var read = haloReadAngle();
  var win = haloLyricWindow();
  var arcHalf = haloLyricArcHalf(win);
  var step = haloLyricStep();
  // How wide a band at the screen's edge takes a row away: the console's 边缘渐隐 and the
  // motion style's own edge boost.
  var edgePx = Math.max(8, (18 + 140 * context.edgeFade) * (motion.edgeBoost || 1));
  var glitchOn = motion.style === 'glitch' && motion.glitch > 0;
  var contextAlpha = 0.08 + 0.62 * context.opacity;
  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  ctx.arc(0, 0, textR - fontPx, read - arcHalf, read + arcHalf);
  ctx.arc(0, 0, s.RMAX * 4, read + arcHalf, read - arcHalf, true);
  ctx.closePath();
  ctx.clip();
  for (var i = win.from; i <= win.to; i++) {
    var item = items[i];
    if (!item) continue;
    var center = item.angle + s.ringRot;
    var current = i === haloLyric.current;
    // The screen's own run along this ray, measured at the ring's rest scale: the layout
    // and the edge fade belong to that, so a beat must not reflow the rows. The cull alone
    // accounts for the pop, because a popped ring carries a row that the rest scale would
    // have put past the edge.
    var span = haloVisibleSpan(center);
    var drawnR = textR * (s.pulse || 1);
    if (span.enter > drawnR || span.exit < drawnR) continue;
    var near = Math.abs(haloNormAngle(center - read));
    // How close this row is to being the one being sung, 0..1. It is continuous, so a row
    // grows into the read spot and shrinks out of it while the ring turns instead of
    // jumping size at the moment the turn ends.
    var focusNear = haloClamp(1 - near / Math.max(1e-6, step * 1.6), 0, 1);
    var size = contextPx + (fontPx - contextPx) * focusNear;
    // How far inside the screen the row's first glyph sits: 0 well inside, 1 at the edge.
    // The app's motion profile says what happens over that last band - a slide, a fade, or
    // nothing at all for the smoothest style.
    var anchor = haloToScreen(s.cx + Math.cos(center) * textR, s.cy + Math.sin(center) * textR);
    var margin = Math.min(anchor.x, s.w - anchor.x, anchor.y, s.h - anchor.y);
    var leaving = haloClamp(1 - margin / edgePx, 0, 1);
    var alpha = contextAlpha * (0.35 + 0.65 * focusNear) + (1 - contextAlpha) * focusNear * focusNear;
    alpha *= 1 - leaving * motion.exit;
    // 漂浮: the rows around the read spot drift up and down a little; the sung row breathes.
    var floatPx = 0;
    if (motion.floatAmp > 0) {
      floatPx = Math.sin(s.time * 1.10 + i * 0.73) * motion.contextDrift * 26 * motion.floatAmp * (1 - 0.55 * focusNear);
    }
    var slidePx = leaving * motion.slide * contextPx * 2.4;
    // A row that does not fit runs off the edge of the screen the way a list scrolls off
    // its container; nothing about the font depends on how much of the ray is left.
    ctx.font = '600 ' + size.toFixed(1) + 'px ' + HALO_FONT;
    var drawnW = haloLyricWidth(item, ctx, size);
    // The line runs away from the centre. On the left half of the ring that would put
    // the glyphs upside down, so there the the line is turned around and anchored by its
    // far end instead; the reading direction stays left to right either way.
    var flip = Math.cos(center) < 0;
    var lit = focusNear > 0.5;
    ctx.save();
    ctx.rotate(flip ? center + Math.PI : center);
    ctx.translate(flip ? -(textR + drawnW + slidePx) : textR + slidePx, floatPx);
    ctx.textAlign = 'left';
    // 线光: the sung row carries a soft glow; 玻璃: a thin frosted edge under it.
    if (lit && motion.style === 'shine') {
      ctx.shadowColor = haloRgba(pal.glowColor || pal.secondary, 0.55);
      ctx.shadowBlur = 6 + motion.sweep * 9;
    }
    if (lit && motion.style === 'glass') {
      ctx.fillStyle = haloRgba(pal.primary, alpha * 0.30);
      ctx.fillText(item.text, 1.6, 1.2);
    }
    // 故障: the sung row jitters and splits into colour fringes; with 跟随鼓点故障 the burst
    // rides the ring's own beat instead of running free.
    var jitterX = 0;
    var jitterY = 0;
    if (glitchOn && focusNear > 0.35) {
      var burst = motion.glitchCameraBind ? haloClamp(s.ringPulse || 0, 0, 1) : 1;
      var phase = s.time * (61.0 + motion.glitchRate * 26.0) + i * 2.399963;
      jitterX = Math.sin(phase) * (0.4 + motion.glitchSlice * 2.4) * motion.glitchJitter * burst;
      jitterY = Math.cos(phase * 0.61) * (0.2 + motion.glitchSlice * 1.2) * motion.glitchJitter * burst;
      if (motion.glitchChroma > 0 && burst > 0.05) {
        var chroma = (0.6 + motion.glitchChroma * 2.6) * focusNear;
        ctx.fillStyle = 'rgba(255,86,86,' + (alpha * 0.30).toFixed(3) + ')';
        ctx.fillText(item.text, jitterX - chroma, jitterY);
        ctx.fillStyle = 'rgba(96,224,255,' + (alpha * 0.30).toFixed(3) + ')';
        ctx.fillText(item.text, jitterX + chroma, jitterY);
      }
    }
    ctx.fillStyle = haloRgba(lit ? pal.highlight : pal.primary, alpha);
    ctx.fillText(item.text, jitterX, jitterY);
    if (item.sub && (lit || focusNear > 0.25)) {
      ctx.font = '400 ' + (size * 0.62).toFixed(1) + 'px ' + HALO_FONT;
      ctx.fillStyle = haloRgba(pal.highlight, alpha * 0.5);
      ctx.fillText(item.sub, jitterX, size * 0.95 + jitterY);
    }
    ctx.restore();
  }
  ctx.restore();
}

// The click shoots a line out of the dial. The shot starts inside the ring and runs
// through the rim, and the panel it crosses lights up.
var haloEmitList = [];

function haloEmitFromPoint(px, py) {
  var s = haloState;
  var w = haloToWorld(px, py);
  var dx = w.x - s.cx;
  var dy = w.y - s.cy;
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

  // the mesh sits a little further back than the ring
  haloApplyCameraTransform(ctx, scale, 0.9);
  haloDrawWeb(ctx);

  haloApplyCameraTransform(ctx, scale, 1);
  haloDrawComets(ctx);
  haloDrawEmits(ctx);

  haloApplyCameraTransform(ctx, scale, 0.95);
  haloDrawHaze(ctx);
  haloDrawStrandGroup(ctx, 0.95, null);
  haloDrawFlyers(ctx, false);

  haloApplyCameraTransform(ctx, scale, 1);
  var collect = { dash: [], tip: [] };
  haloDrawStrandGroup(ctx, 1, collect);
  haloDrawStrandTips(ctx, collect);
  haloDrawFlyers(ctx, true);
  haloDrawFlares(ctx);

  // The ring is the layer that owns the beat: it grows and shrinks against a picture that
  // does not, which is what makes the pop readable at all.
  haloApplyCameraTransform(ctx, scale, 1, s.pulse);
  haloDrawRing(ctx, dt);
  haloDrawLyricText(ctx);
}

// ---------------------------------------------------------------- lifecycle

var haloLayerBound = false;

function haloEnsureLayer() {
  var layer = haloLayerElement();
  var canvas = haloCanvasElement();
  if (!layer || !canvas) return false;
  if (!haloLayerBound) {
    haloLayerBound = true;
    // The layer sits below the WebGL canvas, so the canvas would never see a pointer
    // event. The handlers live on the window instead and leave the UI alone.
    window.addEventListener('pointerdown', haloOnPointerDown, true);
    window.addEventListener('pointermove', haloOnPointerMove, true);
    window.addEventListener('pointerup', haloOnPointerUp, true);
    window.addEventListener('wheel', haloOnWheel, { passive: true });
    window.addEventListener('resize', function () {
      if (haloPresetIsActive()) haloRebuild();
    });
  }
  return true;
}

// The pointer position in the canvas' own pixels.
function haloCanvasPoint(ev) {
  var canvas = haloCanvasElement();
  if (!canvas) return null;
  var rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  var s = haloState;
  return {
    x: (ev.clientX - rect.left) * (s.w / rect.width),
    y: (ev.clientY - rect.top) * (s.h / rect.height),
    scale: s.w / rect.width
  };
}

function haloPointerOverUi(ev) {
  return typeof isPointerOverUi === 'function' && isPointerOverUi(ev);
}

function haloOnPointerDown(ev) {
  if (!haloPresetIsActive()) return;
  if (haloPointerOverUi(ev)) return;
  if (typeof ev.button === 'number' && ev.button !== 0) return;
  haloPointerState.down = true;
  haloPointerState.moved = false;
  haloPointerState.x = ev.clientX;
  haloPointerState.y = ev.clientY;
}

// A drag pans the ring; the pointer keeps holding the same world point.
function haloOnPointerMove(ev) {
  if (!haloPointerState.down) return;
  var dx = ev.clientX - haloPointerState.x;
  var dy = ev.clientY - haloPointerState.y;
  if (!haloPointerState.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) haloPointerState.moved = true;
  if (!haloPointerState.moved) return;
  var p = haloCanvasPoint(ev);
  haloPanBy(dx * (p ? p.scale : 1), dy * (p ? p.scale : 1));
  haloPointerState.x = ev.clientX;
  haloPointerState.y = ev.clientY;
}

// A click without a drag shoots a line out of the dial.
function haloOnPointerUp(ev) {
  if (!haloPointerState.down) return;
  haloPointerState.down = false;
  if (haloPointerState.moved) return;
  var p = haloCanvasPoint(ev);
  if (p) haloEmitFromPoint(p.x, p.y);
}

// The wheel zooms towards the cursor.
function haloOnWheel(ev) {
  if (!haloPresetIsActive()) return;
  if (haloPointerOverUi(ev)) return;
  var p = haloCanvasPoint(ev);
  if (!p) return;
  haloZoomAt(p.x, p.y, ev.deltaY > 0 ? 0.92 : 1.08);
}

// The lyric arc depends on the radius, so a resize rebuilds the dial as well.
function haloRebuild() {
  if (!haloResize()) return false;
  haloBuildLyricRing();
  haloLyricUpdate(haloPlayheadSeconds());
  return true;
}

// How much of the beat the sound allows. The beat map is a fixed timeline: it fires on
// the grid whatever the music is doing, so a silent passage - or a track that is not
// playing at all - used to shake the ring just like a chorus. The level is the honest
// signal: no sound, no motion. The level of most music sits well below 1, so it is
// scaled up before it is clamped. The knob at zero turns the gate off, which is the
// old behaviour: the beat moves the ring whatever the music does.
// How much of the beat the sound allows. The level is the music's own spectrum, not the
// player's volume: silence (or a passage with nothing in it) reads near zero. The floor is
// there because an analyser never quite reaches zero - without it a quiet room already
// opened the gate, which is why the ring moved the same in silence and in a chorus.
function haloLevelGate() {
  var gain = haloParam('levelGain');
  if (!(gain > 0)) return 1;
  var level = Number(haloAudio.level) || 0;
  return haloClamp((level - HALO_LEVEL_FLOOR) * gain, 0, 1);
}

// What the beat is actually multiplied by. haloLevelGate's own curve stays a measure of
// the room: read straight, a track that sits at the usual eight-bin mean of 0.2 would take
// half of every pop, and the ring's motion would follow the mix's loudness instead of the
// drums. Silence is still exactly that.
function haloMotionGate() {
  var g = haloClamp(Number(haloState.levelGate) || 0, 0, 1);
  if (g <= 0) return 0;
  return HALO_GATE_KEEP + (1 - HALO_GATE_KEEP) * g;
}

function haloRenderFrame(canvas, now, dt) {
  var s = haloState;
  if (!s.ready) return false;
  var t = haloPlayheadSeconds();
  s.time = t;
  // The audio has to be read before the ring moves: the level decides how much it moves.
  haloReadAudioBands(t);
  // The beat's own job: the ring pops out and shakes where it stands. The camera is
  // the user's and nothing here moves it.
  s.ringPulse = Math.max(0, (s.ringPulse || 0) - dt * HALO_PULSE_DECAY);
  // The ring's motion follows the sound. The beat map is a fixed timeline, so it keeps
  // firing over a silent passage and over a track that is not playing at all; the level
  // is what says whether there is anything to react to.
  var gate = haloLevelGate();
  s.levelGate += (gate - (s.levelGate || 0)) * Math.min(1, dt * 10);
  var motion = haloMotionGate();
  s.pulse = 1 + haloParam('pulseScale') * s.ringPulse * motion;
  var shake = haloParam('shakePx') * s.ringPulse * motion;
  // The throw is the beat's own: the picture is displaced along the direction the hit chose
  // and slides back as that beat's envelope dies. It used to be a sine of the playhead - a
  // buzz at a phase with nothing to do with the drum, so a beat that happened to land on a
  // node of that sine was a beat nobody could see, and the whole ring jittered between hits.
  s.shakeX = s.shakeDirX * shake;
  s.shakeY = s.shakeDirY * shake * 0.6;
  // The lyrics may have changed (a new song, or the translation arrived), or the app's
  // lyric size knob may have moved: the measured widths belong to the font they were
  // taken with.
  haloSyncLyrics();
  haloLyricUpdate(t);
  s.ringRot = haloLyric.rot;
  // The things painted on the ring follow the ring, not the lyric list's bookkeeping.
  s.decoRot = s.ringRot - haloLyric.rebase;
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
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;
  var started = performance.now();
  haloAutoBoundary(t, started);
  // The tier is read once per frame, not per part: a tier change has to be a decision for the
  // whole frame, never half a frame in one quality and half in another. The change resizes
  // the canvas, so it happens before anything is drawn into it.
  haloApplyTierScale(haloTier());
  // The probe takes its baseline before the drawing and its reading after it, around the frame
  // the app draws anyway - that is the only place the ring's real cost can be seen.
  var probeBase = haloPresetState.probePending ? haloProbeBaseline(ctx) : -1;
  try {
    haloDrawFrame(ctx, dt);
  } catch (err) {
    haloPresetState.engineError = String((err && err.message) || err);
    return false;
  }
  if (probeBase >= 0) haloProbeSample(ctx, probeBase);
  haloPresetState.draws += 1;
  haloPresetState.lastDrawAt = now;
  haloPresetState.lastCostMs = Math.round((performance.now() - started) * 100) / 100;
  haloPresetState.lastT = t;
  haloPresetState.tier = haloTier();
  haloAutoObserve(now);
  return true;
}

// Called from the main loop every frame (cheap when the preset is not selected).
// `force` skips the frame gate: the console edits land at once, even when the loop
// is parked because nothing is playing.
function updateHaloLayer(now, dt, force) {
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
  var step = (force || !gate || typeof consumeFrameGate !== 'function')
    ? Math.max(0, Number(dt) || 0)
    : consumeFrameGate(gate, now, dt, HALO_FPS, false, 'halo-layer');
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
    updateHaloLayer(typeof performance !== 'undefined' ? performance.now() : Date.now(), 1 / HALO_FPS, true);
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
  haloState.ready = false;
  haloState.ringPulse = 0;
  haloState.pulse = 1;
  haloState.ringRot = 0;
  haloState.decoRot = 0;
  haloState.levelGate = 0;
  haloState.shakeX = 0;
  haloState.shakeY = 0;
  haloState.shakeDirX = 1;
  haloState.shakeDirY = 0.5;
  // A released layer is not evidence for 自动: the next song starts from the full picture.
  haloAutoReset();
  // The clock starts again with the layer: the gap between the last frame of the old layer
  // and the first of the new one is not a slow frame.
  haloPresetState.autoLastAt = 0;
  haloPointerState.down = false;
  haloPointerState.moved = false;
  // The camera goes back to the framing knobs' default when the preset is left.
  haloCam.panX = 0;
  haloCam.panY = 0;
  haloCam.zoom = 1;
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
  haloLyric.listKey = '';
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
lyric: {
      lines: haloLyric.items.length,
      current: haloLyric.current,
      key: haloLyric.songKey,
      // Which carrier drew the last frame, and how far the radial disc has swung: a bare
      // "no radial" has to be able to tell "the camera said side" from "the code never ran".
      region: haloState.lyricRegion || 'unpainted',
      radial: {
        item: haloLyric.radial.item,
        prev: haloLyric.radial.prev,
        phase: Math.round(haloLyric.radial.phase * 1000) / 1000
      }
    },
    tierSetting: haloTierMode(),
    tier: haloPresetState.tier,
    tierNow: haloTier(),
    scale: haloTierScale,
    auto: {
      tier: haloPresetState.autoTier,
      pending: haloPresetState.autoPending,
      blocked: haloPresetState.autoBlocked,
      badStreak: haloPresetState.autoBadStreak,
      windows: haloPresetState.autoWindows,
      lastOver: haloPresetState.autoLastOver,
      windowFrames: HALO_AUTO_WINDOW_FRAMES,
      budgetMs: Math.round(HALO_FRAME_BUDGET_MS * 10) / 10,
      changes: haloPresetState.autoChanges,
      switchAt: haloPresetState.autoSwitchAt,
      line: haloPresetState.autoLine,
      log: haloPresetState.autoLog,
      probeCost: haloPresetState.probeCost,
      probeVerdict: haloPresetState.probeVerdict,
      probeLog: haloPresetState.probeLog,
    },
    // Which producer set the last turn's length, and what it thought the beat spacing was.
    // A zero here has to say whether the knob is off or nothing knows the tempo.
    turn: {
      beatSec: Math.round(haloState.beat.step * 1000) / 1000,
      beatSource: haloState.beat.source,
      lastTurn: haloLyric.turnSource,
      dur: haloLyric.tween ? Math.round(haloLyric.tween.dur * 1000) / 1000 : 0
    },
    camera: {
      panX: Math.round(haloCam.panX),
      panY: Math.round(haloCam.panY),
      zoom: Math.round(haloCam.zoom * 1000) / 1000
    },
    // What the ring hears: the music's own level and how much of the beat it allows. A
    // gate of 0 with a song playing is the analyser's fault, not the music's silence.
    // The motion gate is the one the beat is actually multiplied by, and the kick is what
    // sets a beat's size when the live drum is louder than the map's opinion of it.
    audio: {
      level: Math.round((haloAudio.level || 0) * 1000) / 1000,
      gate: Math.round((haloState.levelGate || 0) * 1000) / 1000,
      motionGate: Math.round(haloMotionGate() * 1000) / 1000,
      kick: Math.round((haloAudio.kick || 0) * 1000) / 1000,
      pulse: Math.round((haloState.ringPulse || 0) * 1000) / 1000
    },
    tuning: (function () {
      var out = {};
      for (var key in HALO_TUNING_SCHEMA) out[key] = haloParam(key);
      return out;
    })(),
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
