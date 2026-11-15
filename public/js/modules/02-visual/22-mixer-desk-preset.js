'use strict';

// 预设 17「调音台」(MIXER DESK).
//
// Original scene. The brief was a flowing mixing console; no reference source was used, and the
// layout, module set, palette, camera and lyric panels are this project's own design. It is
// deliberately not a port: the desk is a bounded conveyor of repeating bays (not a growing grid),
// the modules are three independent SDF clusters, and the lyrics live on LCD panels riding the
// desk, which the reference has no notion of.
//
// What it does: the camera sits above the desk, the bays flow past like a tape, and the modules
// (knobs, faders, pads, meters, LEDs) move with the audio bands. The lyric line is split into
// groups of `charsPerPanel` characters; each group gets a panel, panels appear in order, lift as
// their turn arrives, and carry the text that is being sung.

var MIXER_PRESET_INDEX = 17;

var MIXER_PANELS = 8;
var MIXER_ATLAS_COLS = 4;
var MIXER_ATLAS_ROWS = 4;
var MIXER_ATLAS_CELL = 512;
var MIXER_LEVEL_BANDS = 8;
var MIXER_LEVEL_AGES = 8;

// Every knob is declared here; the store (07-fx/15-mixer-tuning.js) keeps no defaults of its own.
var MIXER_TUNING_SCHEMA = {
  // ---- the wall
  viewZoom: { def: 5, min: 1.5, max: 10, kind: 'ratio', rebuild: 'live' },
  viewPanY: { def: 0, min: -1.5, max: 1.5, kind: 'unit', rebuild: 'live' },
  camSway: { def: 0.5, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  flowSpeed: { def: 0.9, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  tileSize: { def: 2, min: 1.2, max: 3.5, kind: 'unit', rebuild: 'live' },
  panelSpacing: { def: 3.4, min: 2.2, max: 8, kind: 'unit', rebuild: 'live' },
  moduleGlow: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  // ---- module motion from the music
  meterGain: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  faderSpeed: { def: 1, min: 0, max: 4, kind: 'ratio', rebuild: 'live' },
  knobTurn: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  // ---- lyric panels
  charsPerPanel: { def: 2, min: 1, max: 6, kind: 'count', rebuild: 'live' },
  panelAhead: { def: 4, min: 1, max: 5, kind: 'count', rebuild: 'live' },
  panelBehind: { def: 2, min: 0, max: 2, kind: 'count', rebuild: 'live' },
  panelLift: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  panelMinGap: { def: 0.38, min: 0.1, max: 1.5, kind: 'sec', rebuild: 'live' },
  panelGlide: { def: 0.7, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  panelAlpha: { def: 0.95, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  maxGroupsPerLine: { def: 14, min: 2, max: 24, kind: 'count', rebuild: 'live' },
  flowLock: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  // ---- audio
  beatGlow: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  audioSmooth: { def: 0.6, min: 0, max: 0.95, kind: 'ratio', rebuild: 'live' },
  // ---- pass
  renderScale: { def: 1, min: 0.5, max: 1, kind: 'ratio', rebuild: 'pass' },
  exposure: { def: 1.05, min: 0.4, max: 2, kind: 'ratio', rebuild: 'live' },
  vignette: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' }
};

var MIXER_PALETTE = {
  voidColor: [0.027, 0.039, 0.063],
  deskBody: [0.071, 0.086, 0.122],
  deskSheen: [0.165, 0.192, 0.251],
  keyWarm: [1.0, 0.83, 0.63],
  rimCool: [0.37, 0.66, 1.0],
  ledAmber: [1.0, 0.69, 0.34],
  meterCyan: [0.34, 0.94, 0.82],
  panelInk: [0.92, 0.96, 1.0]
};

function mixerParam(key) {
  var store = (typeof mixerTuning !== 'undefined') ? mixerTuning : null;
  if (store && store[key] !== undefined && store[key] !== null) return store[key];
  var spec = MIXER_TUNING_SCHEMA[key];
  return spec ? spec.def : 0;
}

function mixerPresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === MIXER_PRESET_INDEX;
}

// ---------------------------------------------------------------- the scene

// The fragment is a plain Shadertoy body behind the driver that already ships here. Everything the
// camera sees is built from these own helpers; none of it is lifted from a reference shader.
var MIXER_SCENE_FS = shadertoyFragment([
  'uniform float uViewZoom;',
  'uniform float uPanY;',
  'uniform float uSwayX;',
  'uniform float uSwayY;',
  'uniform float uTileSize;',
  'uniform float uPanelSpacing;',
  'uniform float uCarousel;',
  'uniform float uPanelBase;',
  'uniform float uPanelCount;',
  'uniform float uPanelLift;',
  'uniform float uModuleGlow;',
  'uniform float uMeterGain;',
  'uniform float uFaderSpeed;',
  'uniform float uKnobTurn;',
  'uniform float uBeatGlow;',
  'uniform float uBass;',
  'uniform float uMid;',
  'uniform float uTreble;',
  'uniform float uBeat;',
  'uniform float uEnergy;',
  'uniform vec3 uAccent;',
  'const int MIXER_PANELS = 8;',
  'const vec2 MIXER_ATLAS = vec2(4.0, 4.0);',
  '',
  'float mHash11(float p) {',
  '  p = fract(p * 0.1031);',
  '  p *= p + 33.33;',
  '  p *= p + p;',
  '  return fract(p);',
  '}',
  'float mHash21(vec2 p) {',
  '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
  '  p3 += dot(p3, p3.yzx + 33.33);',
  '  return fract((p3.x + p3.y) * p3.z);',
  '}',
  'float mRect(vec2 p, vec2 h) {',
  '  vec2 d = abs(p) - h;',
  '  return max(d.x, d.y);',
  '}',
  'vec2 mRot(vec2 p, float a) {',
  '  float c = cos(a), s = sin(a);',
  '  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);',
  '}',
  '',
  // Flat modules, no bevels: a face, a one-line border, and the controls drawn as line art.
  'vec3 mKnobs(vec2 q, float h, float n) {',
  '  vec3 col = vec3(0.050, 0.058, 0.070);',
  '  for (int i = 0; i < 4; i++) {',
  '    if (float(i) >= n) break;',
  '    vec2 c = vec2(0.0);',
  '    if (n > 3.0) c = vec2(mod(float(i), 2.0) - 0.5, floor(float(i) / 2.0) - 0.5) * 0.92;',
  '    else if (n > 1.5) c = vec2(float(i) - 0.5, 0.0) * 1.05;',
  '    float r = n > 3.0 ? 0.30 : (n > 1.5 ? 0.40 : 0.62);',
  '    float d = length(q - c);',
  '    col = mix(col, vec3(0.075, 0.085, 0.10), 1.0 - smoothstep(r - 0.02, r, d));',
  '    col = mix(col, vec3(0.16, 0.18, 0.21), 1.0 - smoothstep(0.0, 0.018, abs(d - r)));',
  '    float ang = uKnobTurn * (h * 6.2 + float(i) * 1.3 + (uBass - 0.2) * 2.0);',
  '    vec2 t = mRot(q - c, -ang);',
  '    float tick = step(abs(t.x), 0.018) * step(r - 0.16, t.y) * step(t.y, r - 0.02);',
  '    col = mix(col, uAccent * (0.75 + 0.25 * uBeat), tick);',
  '  }',
  '  return col;',
  '}',
  'vec3 mFaders(vec2 q, float h, float n) {',
  '  vec3 col = vec3(0.046, 0.054, 0.066);',
  '  for (int i = 0; i < 8; i++) {',
  '    if (float(i) >= n) break;',
  '    float x = (float(i) - (n - 1.0) * 0.5) * (1.55 / max(1.0, n - 1.0));',
  '    float track = step(abs(q.x - x), 0.012) * step(abs(q.y), 0.58);',
  '    col = mix(col, vec3(0.11, 0.13, 0.16), track);',
  '    float slide = 0.5 + 0.5 * sin((uBass * 0.7 + uMid * 0.5) * 3.4 + h * 11.0 + float(i) * 1.7);',
  '    slide = mix(0.5, slide, clamp(uFaderSpeed, 0.0, 1.0));',
  '    float y = (slide - 0.5) * 1.0;',
  '    float cap = step(abs(q.x - x), 0.075) * step(abs(q.y - y), 0.055);',
  '    col = mix(col, vec3(0.20, 0.22, 0.26), cap);',
  '    col = mix(col, uAccent, cap * step(0.55, uBeat) * uBeatGlow * 0.6);',
  '  }',
  '  return col;',
  '}',
  'vec3 mMeter(vec2 q, float h, float n) {',
  '  vec3 col = vec3(0.042, 0.050, 0.060);',
  '  for (int i = 0; i < 8; i++) {',
  '    float x = (float(i) - 3.5) * 0.17;',
  '    float level = texture2D(iChannel0, vec2((float(i) + 0.5) / 8.0, 0.5 / 8.0)).r * uMeterGain;',
  '    float bar = step(abs(q.x - x), 0.055) * step(q.y, -0.55 + level * 1.1) * step(-0.55, q.y);',
  '    col = mix(col, mix(uAccent, vec3(1.0, 0.25, 0.2), smoothstep(0.75, 1.0, level)), bar);',
  '  }',
  '  return col;',
  '}',
  'vec3 mDisplay(vec2 q, float h) {',
  '  vec3 col = vec3(0.016, 0.026, 0.032);',
  '  float inner = 1.0 - smoothstep(0.0, 0.01, mRect(q, vec2(0.78, 0.62)));',
  '  col = mix(col, vec3(0.03, 0.05, 0.06), inner);',
  '  float floorLine = 1.0 - smoothstep(0.0, 0.01, abs(q.y + 0.40));',
  '  col = mix(col, vec3(0.10, 0.12, 0.15), floorLine * inner);',
  '  for (int i = 0; i < 7; i++) {',
  '    float bar = mHash11(h * 7.0 + float(i)) * (0.25 + uMid * 0.9 + uBeat * 0.2);',
  '    float x = -0.62 + float(i) * 0.205;',
  '    float seg = step(abs(q.x - x), 0.055) * step(q.y, -0.36 + bar) * step(-0.39, q.y);',
  '    seg = max(seg, step(abs(q.x - x), 0.055) * step(q.y, -0.30) * step(-0.33, q.y) * 0.35);',
  '    col = mix(col, uAccent * (0.55 + 0.45 * uBeat), seg * inner);',
  '  }',
  '  return col;',
  '}',
  'vec3 mPads(vec2 q, float h) {',
  '  vec3 col = vec3(0.044, 0.052, 0.064);',
  '  for (int j = 0; j < 2; j++) {',
  '    for (int i = 0; i < 4; i++) {',
  '      vec2 c = vec2((float(i) - 1.5) * 0.42, (float(j) - 0.5) * 0.55);',
  '      float pad = 1.0 - smoothstep(0.0, 0.012, mRect(q - c, vec2(0.16, 0.16)));',
  '      float lit = step(0.62 - uBeat * 0.45, mHash11(h * 13.0 + float(i) + float(j) * 7.0));',
  '      col = mix(col, vec3(0.10, 0.12, 0.15), pad);',
  '      col = mix(col, uAccent * (0.5 + 0.8 * uBeat) * uModuleGlow, pad * lit);',
  '    }',
  '  }',
  '  return col;',
  '}',
  '',
  // One module: face, border, controls chosen by the module hash.
  'vec3 mModule(vec2 q, vec2 halfSize, float id) {',
  '  vec3 col = vec3(0.038, 0.045, 0.055);',
  '  col = mix(col, vec3(0.052, 0.056, 0.050), mHash21(vec2(id * 0.53, id * 1.91)) * 0.7);',
  '  float edge = max(abs(q.x) / halfSize.x, abs(q.y) / halfSize.y);',
  '  col = mix(col, vec3(0.085, 0.095, 0.115), smoothstep(0.93, 0.94, edge));',
  '  col = mix(col, vec3(0.018, 0.022, 0.028), smoothstep(0.985, 0.995, edge));',
  '  vec2 qn = q / halfSize * 0.9;',
  '  float h = mHash21(vec2(id * 1.37, id * 0.71));',
  '  vec3 inner = col;',
  '  if (h < 0.30) {',
  '    inner = mKnobs(qn, h, h < 0.10 ? 1.0 : (h < 0.20 ? 2.0 : 4.0));',
  '  } else if (h < 0.58) {',
  '    inner = mFaders(qn, h, h < 0.42 ? 4.0 : 8.0);',
  '  } else if (h < 0.76) {',
  '    inner = mMeter(qn, h, 8.0);',
  '  } else if (h < 0.90) {',
  '    inner = mDisplay(qn, h);',
  '  } else {',
  '    inner = mPads(qn, h);',
  '  }',
  '  return mix(col, inner, 1.0 - smoothstep(0.90, 0.93, edge));',
  '}',
  '',
  // The lyric displays ride on top of the wall: they pop toward the eye as their turn comes, but
  // the style stays flat (a shadow line and a border, no bevel).
  'vec3 mLyrics(vec2 w, inout float mask) {',
  '  vec3 col = vec3(0.0);',
  '  for (int i = 0; i < MIXER_PANELS; i++) {',
  '    if (float(i) >= uPanelCount) break;',
  '    vec4 meta = texture2D(iChannel2, vec2((float(i) + 0.5) / 8.0, 0.5));',
  '    if (meta.w <= 0.002) continue;',
  '    float g = uPanelBase + float(i);',
  '    vec2 c = vec2(g * uPanelSpacing, 0.0);',
  '    float s = 1.0 + meta.z * uPanelLift * 0.22;',
  '    vec2 q = (w - c) / s;',
  '    float d = mRect(q, vec2(1.22, 0.66));',
  '    float shadow = 1.0 - smoothstep(0.0, 0.05, mRect((w - c) / s, vec2(1.28, 0.72)));',
  '    col = mix(col, vec3(0.0), shadow * 0.45 * meta.w);',
  '    float inPanel = 1.0 - smoothstep(0.0, 0.012, d);',
  '    if (inPanel > 0.0) {',
  '      vec2 uv = clamp(vec2(q.x / 2.44 + 0.5, q.y / 1.32 + 0.5), 0.02, 0.98);',
  '      float glyph = texture2D(iChannel1, meta.xy + uv / MIXER_ATLAS).r;',
  '      vec3 ink = mix(uAccent, vec3(1.0), 0.42);',
  '      vec3 glass = vec3(0.012, 0.020, 0.026);',
  '      col = mix(col, glass, inPanel * meta.w);',
  '      col += ink * glyph * (0.7 + meta.z * 0.9) * meta.w * 1.5;',
  '      float border = 1.0 - smoothstep(0.0, 0.02, abs(d + 0.018));',
  '      col += uAccent * border * meta.w * 0.55;',
  '      float bar = step(q.y, -0.52) * step(-0.58, q.y) * step(q.x, -1.10 + 2.20 * meta.z);',
  '      col += uAccent * bar * meta.w * 1.1;',
  '      mask = max(mask, inPanel * meta.w);',
  '    }',
  '  }',
  '  return col;',
  '}',
  '',
  'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
  '  vec2 sc = fragCoord.xy / iResolution.xy * 2.0 - 1.0;',
  '  sc.x *= iResolution.x / iResolution.y;',
  '  vec2 w = sc * uViewZoom + vec2(uCarousel * uPanelSpacing + uSwayX, uPanY + uSwayY);',
  '  float S = max(0.5, uTileSize);',
  '  vec2 macro = floor(w / (2.0 * S));',
  '  vec2 lm = w - macro * 2.0 * S;',
  '  float ph = mHash21(macro);',
  '  vec2 halfSize = vec2(S);',
  '  vec2 local = lm - vec2(S);',
  '  float id = macro.x * 13.7 + macro.y * 31.1;',
  '  if (ph < 0.25) {',
  '    halfSize = vec2(S);',
  '    local = lm - vec2(S);',
  '  } else if (ph < 0.50) {',
  '    float col = floor(lm.x / S);',
  '    halfSize = vec2(S * 0.5, S);',
  '    local = lm - vec2(col * S + S * 0.5, S);',
  '    id += col * 3.3;',
  '  } else if (ph < 0.75) {',
  '    float row = floor(lm.y / S);',
  '    halfSize = vec2(S, S * 0.5);',
  '    local = lm - vec2(S, row * S + S * 0.5);',
  '    id += row * 5.7 + 1.9;',
  '  } else {',
  '    vec2 cell = floor(lm / S);',
  '    halfSize = vec2(S * 0.5);',
  '    local = lm - cell * S - vec2(S * 0.5);',
  '    id += (cell.x + cell.y * 2.0) * 7.1 + 3.3;',
  '  }',
  '  vec3 col = mModule(local, halfSize - 0.018, id);',
  '  float mask = 0.0;',
  '  vec3 lyric = mLyrics(w, mask);',
  '  col = mix(col, lyric, mask);',
  '  fragColor = vec4(col, 1.0);',
  '}'
].join('\n'), { channels: 3 });

var MIXER_BLIT_VS = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = vec4(position.xy, 0.999999, 1.0);',
  '}'
].join('\n');

var MIXER_BLIT_FS = [
  'precision highp float;',
  'uniform sampler2D tDiffuse;',
  'uniform float uExposure;',
  'uniform float uVignette;',
  'uniform float uTime;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;',
  '  float vig = distance(vUv, vec2(0.5));',
  '  c *= 1.0 - uVignette * smoothstep(0.35, 0.85, vig);',
  '  float grain = fract(sin(dot(vUv * vec2(1920.0, 1080.0) + uTime, vec2(12.9898, 78.233))) * 43758.5453);',
  '  c += (grain - 0.5) * 0.02;',
  '  c = pow(max(c, 0.0), vec3(0.4545));',
  '  gl_FragColor = vec4(c, 1.0);',
  '}'
].join('\n');

// ---------------------------------------------------------------- lyric panels: schedule

var MIXER_PLACEHOLDER = ['调音', '台 ·', 'MIX', 'ER', 'DESK', '· ·', 'LIVE', '2026'];

function mixerClamp01(value) {
  var n = Number(value);
  return !isFinite(n) ? 0 : Math.min(1, Math.max(0, n));
}

function mixerSmooth(edge0, edge1, x) {
  var t = mixerClamp01((Number(x) - edge0) / (Number(edge1) - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

function mixerLineText(line) {
  return String(line && (line.text || line.content || line.textContent) || '').trim();
}

function mixerLineClock(line) {
  return Number(line && (line.time != null ? line.time : line.t));
}

function mixerLineDuration(line) {
  var d = Number(line && line.duration);
  return d > 0.15 ? d : 3;
}

// One line -> consecutive groups of `charsPerPanel` characters. A line that would otherwise need
// more groups than the conveyor can show gets wider groups instead of a faster desk.
function mixerSplitGroups(text, chars) {
  var out = [];
  var width = Math.max(1, Math.round(chars) || 1);
  for (var i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}

function mixerGroupPlan(lines, opts) {
  opts = opts || {};
  var chars = Math.max(1, Math.round(Number(opts.charsPerPanel) || 2));
  var maxGroups = Math.max(1, Math.round(Number(opts.maxGroupsPerLine) || 14));
  var minGap = Math.max(0.05, Number(opts.panelMinGap) || 0.38);
  var groups = [];
  (Array.isArray(lines) ? lines : []).forEach(function (line) {
    var text = mixerLineText(line);
    if (!text) return;
    var start = mixerLineClock(line);
    if (!isFinite(start)) return;
    var duration = mixerLineDuration(line);
    var width = chars;
    var count = Math.ceil(text.length / width);
    if (count > maxGroups) {
      width = Math.ceil(text.length / maxGroups);
      count = Math.ceil(text.length / width);
    }
    var gap = Math.max(minGap, duration / Math.max(1, count));
    for (var i = 0; i < count; i++) {
      groups.push({
        text: text.slice(i * width, (i + 1) * width),
        start: start + i * gap,
        end: start + (i + 1) * gap,
        line: line
      });
    }
  });
  return groups;
}

// The desk and the lyrics share one scalar: bay index. Group g reaches the reading position when
// the carousel equals g, and between two group starts the carousel interpolates continuously, so a
// long instrumental gap slows the desk down instead of stopping it.
function mixerCarouselAt(plan, t, glide) {
  if (!plan || !plan.length) return 0;
  var time = Number(t) || 0;
  if (time <= plan[0].start) return 0;
  var lo = 0;
  var hi = plan.length - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (plan[mid].start <= time) lo = mid; else hi = mid - 1;
  }
  var next = lo + 1 < plan.length ? plan[lo + 1].start : plan[lo].end;
  var span = Math.max(0.05, next - plan[lo].start);
  var eased = Math.pow(mixerClamp01((time - plan[lo].start) / span), 1 + Math.max(0, Number(glide) || 0));
  return lo + eased;
}

function mixerPanelZ(group, carousel, bayPitch, zRead) {
  return zRead + (Number(carousel) - Number(group)) * Number(bayPitch);
}

function mixerPanelLift(x) {
  return mixerSmooth(1.4, 0.15, Math.abs(Number(x) || 0));
}

function mixerPanelAlpha(x, ahead, behind) {
  var front = mixerSmooth(ahead + 0.9, ahead - 0.3, x);
  var back = mixerSmooth(behind + 0.9, behind - 0.3, -x);
  return Math.min(front, back);
}

// ---------------------------------------------------------------- audio level table

var mixerLevelState = {
  level: new Float32Array(MIXER_LEVEL_BANDS),
  peak: new Float32Array(MIXER_LEVEL_BANDS),
  clock: 0
};

function mixerBandValues(frame) {
  var out = new Float32Array(MIXER_LEVEL_BANDS);
  if (frame && (frame.sonicDetailed || frame.subBass !== undefined)) {
    out[0] = Number(frame.subBass) || 0;
    out[1] = Number(frame.bass) || 0;
    out[2] = Number(frame.lowMid) || 0;
    out[3] = Number(frame.mid) || 0;
    out[4] = Number(frame.highMid) || 0;
    out[5] = Number(frame.presence) || 0;
    out[6] = Number(frame.brilliance) || 0;
    out[7] = Number(frame.air) || 0;
    return out;
  }
  var bassNow = (typeof bass !== 'undefined' && isFinite(bass)) ? Number(bass) : 0;
  var midNow = (typeof mid !== 'undefined' && isFinite(mid)) ? Number(mid) : 0;
  var trebleNow = (typeof treble !== 'undefined' && isFinite(treble)) ? Number(treble) : 0;
  out[0] = bassNow * 0.9;
  out[1] = bassNow;
  out[2] = midNow * 0.7;
  out[3] = midNow;
  out[4] = midNow * 0.8;
  out[5] = trebleNow * 0.7;
  out[6] = trebleNow;
  out[7] = trebleNow * 0.8;
  return out;
}

// texel = age * 8 + band: R level, G peak hold, B band, A age, newest age at 0.
function mixerWriteLevelTable(data, level, peak, shift) {
  if (shift) {
    for (var age = MIXER_LEVEL_AGES - 1; age >= 1; age--) {
      for (var band = 0; band < MIXER_LEVEL_BANDS; band++) {
        var from = ((age - 1) * MIXER_LEVEL_BANDS + band) * 4;
        var to = (age * MIXER_LEVEL_BANDS + band) * 4;
        data[to] = data[from];
        data[to + 1] = data[from + 1];
      }
    }
  }
  for (var b = 0; b < MIXER_LEVEL_BANDS; b++) {
    var at = b * 4;
    data[at] = Math.round(mixerClamp01(level[b]) * 255);
    data[at + 1] = Math.round(mixerClamp01(peak[b]) * 255);
    for (var a = 0; a < MIXER_LEVEL_AGES; a++) {
      var off = (a * MIXER_LEVEL_BANDS + b) * 4;
      data[off + 2] = Math.round((b / (MIXER_LEVEL_BANDS - 1)) * 255);
      data[off + 3] = Math.round((a / (MIXER_LEVEL_AGES - 1)) * 255);
    }
  }
}

// ---------------------------------------------------------------- state and resources

var mixerState = {
  built: false,
  quadScene: null, quadCam: null, quad: null, mat: null,
  blitScene: null, blitCam: null, blitMat: null,
  rt: null, rtW: 0, rtH: 0, passScale: 0,
  atlasCanvas: null, atlasCtx: null, atlasTex: null,
  panelData: null, panelTex: null, levelData: null, levelTex: null,
  plan: [], planKey: '', planLines: null,
  carousel: 0, lastTime: -1, snapCount: 0,
  panelBase: 0, panelCount: 0,
  cellText: ['', '', '', '', '', '', '', ''],
  atlasUploads: 0,
  frames: 0, lastCostMs: 0, error: '', objects: 0
};

var mixerCam = {
  eye: null, target: null, fwd: null, right: null, up: null, worldUp: null, size: null
};

function mixerAccentHex() {
  try {
    if (typeof lyricPalette === 'function') {
      var p = lyricPalette();
      if (p && p.highlight) return p.highlight;
      if (p && p.primary) return p.primary;
    }
  } catch (err) { /* the palette helper is optional */ }
  return '#ffb156';
}

function mixerCellUV(slot) {
  var col = slot % MIXER_ATLAS_COLS;
  var row = MIXER_ATLAS_ROWS - 1 - Math.floor(slot / MIXER_ATLAS_COLS);
  return { u: col / MIXER_ATLAS_COLS, v: row / MIXER_ATLAS_ROWS, col: col, row: row };
}

function mixerRasterCell(slot, text) {
  var ctx = mixerState.atlasCtx;
  if (!ctx) return;
  var cell = mixerCellUV(slot);
  var x = cell.col * MIXER_ATLAS_CELL;
  var y = (MIXER_ATLAS_ROWS - 1 - cell.row) * MIXER_ATLAS_CELL;
  ctx.clearRect(x, y, MIXER_ATLAS_CELL, MIXER_ATLAS_CELL);
  if (!text) return;
  var accent = mixerAccentHex();
  ctx.save();
  // The cell is square and the panel is wide: squash the glyphs horizontally here so the panel's
  // 1.72 stretch brings them back to their natural shape.
  var squash = 0.56;
  ctx.font = '500 236px "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(x + MIXER_ATLAS_CELL / 2, y + MIXER_ATLAS_CELL / 2);
  ctx.scale(squash, 1);
  ctx.shadowColor = accent;
  ctx.shadowBlur = 10;
  ctx.fillStyle = accent;
  ctx.fillText(text, 0, 0);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#eaf6ff';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function mixerInitialUniforms() {
  return {
    iResolution: shadertoyUvUniforms(1, 1),
    iTime: { value: 0 },
    iFrame: { value: 0 },
    iMouse: { value: [0, 0, 0, 0] },
    iChannel0: { value: null },
    iChannel1: { value: null },
    iChannel2: { value: null },
    uViewZoom: { value: 1 },
    uPanY: { value: 0 },
    uSwayX: { value: 0 },
    uSwayY: { value: 0 },
    uTileSize: { value: 2 },
    uPanelSpacing: { value: 3.4 },
    uCarousel: { value: 0 },
    uPanelBase: { value: 0 },
    uPanelCount: { value: 0 },
    uPanelLift: { value: 0.35 },
    uModuleGlow: { value: 1 },
    uMeterGain: { value: 1 },
    uFaderSpeed: { value: 1 },
    uKnobTurn: { value: 1 },
    uBeatGlow: { value: 1 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uEnergy: { value: 0 },
    uAccent: { value: new THREE.Vector3(1, 0.69, 0.34) }
  };
}

function mixerBuildScene() {
  if (mixerState.built) return true;
  if (typeof THREE === 'undefined' || typeof renderer === 'undefined' || !renderer) return false;
  try {
    mixerCam.eye = new THREE.Vector3(0, 0.98, 2.15);
    mixerCam.target = new THREE.Vector3(0, -0.2, -2.6);
    mixerCam.fwd = new THREE.Vector3(0, 0, -1);
    mixerCam.right = new THREE.Vector3(1, 0, 0);
    mixerCam.up = new THREE.Vector3(0, 1, 0);
    mixerCam.worldUp = new THREE.Vector3(0, 1, 0);
    mixerCam.size = new THREE.Vector2(1, 1);
    mixerState.accentColor = new THREE.Color();

    var canvas = document.createElement('canvas');
    canvas.width = MIXER_ATLAS_CELL * MIXER_ATLAS_COLS;
    canvas.height = MIXER_ATLAS_CELL * MIXER_ATLAS_ROWS;
    var ctx = canvas.getContext('2d');
    var atlasTex = new THREE.CanvasTexture(canvas);
    if (THREE.sRGBEncoding !== undefined) atlasTex.encoding = THREE.sRGBEncoding;
    atlasTex.minFilter = THREE.LinearFilter;
    atlasTex.generateMipmaps = false;
    atlasTex.needsUpdate = true;

    var levelData = new Uint8Array(MIXER_LEVEL_BANDS * MIXER_LEVEL_AGES * 4);
    var levelTex = new THREE.DataTexture(levelData, MIXER_LEVEL_BANDS * MIXER_LEVEL_AGES, 1,
      THREE.RGBAFormat, THREE.UnsignedByteType);
    levelTex.magFilter = THREE.NearestFilter;
    levelTex.minFilter = THREE.NearestFilter;
    levelTex.needsUpdate = true;

    var panelData = new Uint8Array(MIXER_PANELS * 4);
    var panelTex = new THREE.DataTexture(panelData, MIXER_PANELS, 1,
      THREE.RGBAFormat, THREE.UnsignedByteType);
    panelTex.magFilter = THREE.NearestFilter;
    panelTex.minFilter = THREE.NearestFilter;
    panelTex.needsUpdate = true;

    var uniforms = mixerInitialUniforms();
    uniforms.iChannel0.value = levelTex;
    uniforms.iChannel1.value = atlasTex;
    uniforms.iChannel2.value = panelTex;
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.999999, 1.0); }',
      fragmentShader: MIXER_SCENE_FS,
      depthTest: false,
      depthWrite: false
    });

    var quadScene = new THREE.Scene();
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    quadScene.add(quad);

    var blitMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: 1.05 },
        uVignette: { value: 0.35 },
        uTime: { value: 0 }
      },
      vertexShader: MIXER_BLIT_VS,
      fragmentShader: MIXER_BLIT_FS,
      depthTest: false,
      depthWrite: false
    });
    var blitScene = new THREE.Scene();
    var blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
    blitQuad.frustumCulled = false;
    blitScene.add(blitQuad);

    mixerState.atlasCanvas = canvas;
    mixerState.atlasCtx = ctx;
    mixerState.atlasTex = atlasTex;
    mixerState.levelData = levelData;
    mixerState.levelTex = levelTex;
    mixerState.panelData = panelData;
    mixerState.panelTex = panelTex;
    mixerState.mat = mat;
    mixerState.quadScene = quadScene;
    mixerState.quadCam = quadCam;
    mixerState.quad = quad;
    mixerState.blitMat = blitMat;
    mixerState.blitScene = blitScene;
    mixerState.blitCam = blitCam;
    mixerLevelState.level.fill(0);
    mixerLevelState.peak.fill(0);
    mixerLevelState.clock = 0;
    mixerWriteLevelTable(levelData, mixerLevelState.level, mixerLevelState.peak, false);
    mixerState.cellText = ['', '', '', '', '', '', '', ''];
    mixerState.plan = [];
    mixerState.planKey = '';
    mixerState.carousel = 0;
    mixerState.lastTime = -1;
    mixerState.panelBase = 0;
    mixerState.panelCount = 0;
    mixerState.objects = quadScene.children.length + blitScene.children.length;
    mixerState.built = true;
    return true;
  } catch (err) {
    mixerState.error = String(err && (err.message || err)).slice(0, 200);
    return false;
  }
}

function mixerAlignPassSize() {
  if (typeof renderer === 'undefined' || !renderer || !mixerState.mat) return false;
  renderer.getDrawingBufferSize(mixerCam.size);
  var scale = Math.min(1, Math.max(0.4, mixerParam('renderScale')));
  var w = Math.max(32, Math.round((mixerCam.size.x || 1) * scale));
  var h = Math.max(32, Math.round((mixerCam.size.y || 1) * scale));
  if (mixerState.rt && mixerState.rtW === w && mixerState.rtH === h && mixerState.passScale === scale) return true;
  if (!mixerState.rt) {
    mixerState.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
  } else {
    mixerState.rt.setSize(w, h);
  }
  mixerState.rtW = w;
  mixerState.rtH = h;
  mixerState.passScale = scale;
  mixerState.mat.uniforms.iResolution.value = shadertoyUvUniforms(w, h).value;
  mixerState.blitMat.uniforms.tDiffuse.value = mixerState.rt.texture;
  return true;
}

// ---------------------------------------------------------------- per-frame

function mixerSyncPlan() {
  var lines = (typeof lyricsLines !== 'undefined' && lyricsLines) ? lyricsLines : [];
  var chars = Math.max(1, Math.round(mixerParam('charsPerPanel')));
  var maxGroups = Math.max(1, Math.round(mixerParam('maxGroupsPerLine')));
  var minGap = Math.max(0.05, mixerParam('panelMinGap'));
  var first = lines.length ? mixerLineClock(lines[0]) : 0;
  var last = lines.length ? mixerLineClock(lines[lines.length - 1]) : 0;
  var sum = 0;
  for (var i = 0; i < lines.length; i++) sum += mixerLineText(lines[i]).length;
  var key = lines.length + '|' + first + '|' + last + '|' + sum + '|' + chars + '|' + maxGroups + '|' + minGap;
  if (key === mixerState.planKey) return;
  mixerState.planKey = key;
  mixerState.plan = mixerGroupPlan(lines, {
    charsPerPanel: chars, maxGroupsPerLine: maxGroups, panelMinGap: minGap
  });
  mixerState.cellText = ['', '', '', '', '', '', '', ''];
}

function mixerAdvanceCarousel(step, time) {
  var plan = mixerState.plan;
  var t = Number(time) || 0;
  if (!plan.length) {
    mixerState.carousel += Math.max(0, mixerParam('flowSpeed')) * step;
    mixerState.lastTime = t;
    return;
  }
  var glide = mixerParam('panelGlide');
  var snap = mixerState.lastTime >= 0 &&
    (t < mixerState.lastTime - 1e-3 || Math.abs(t - mixerState.lastTime) > 1.2);
  if (snap) {
    mixerState.snapCount++;
    mixerState.carousel = mixerCarouselAt(plan, t, 0);
  } else if (mixerParam('flowLock') <= 0) {
    mixerState.carousel += Math.max(0, mixerParam('flowSpeed')) * step;
  } else {
    mixerState.carousel = mixerCarouselAt(plan, t, glide);
  }
  mixerState.lastTime = t;
}

function mixerUpdateLevels(frame, dt, smooth) {
  var values = mixerBandValues(frame);
  var k = Math.max(0.08, 1 - Math.min(0.95, Math.max(0, Number(smooth) || 0)) * 0.85);
  for (var b = 0; b < MIXER_LEVEL_BANDS; b++) {
    mixerLevelState.level[b] += (values[b] - mixerLevelState.level[b]) * k;
    mixerLevelState.peak[b] = Math.max(mixerLevelState.peak[b] * 0.94, mixerLevelState.level[b]);
  }
  mixerLevelState.clock += Math.max(0, dt);
  var ticked = false;
  while (mixerLevelState.clock >= 1 / 12) {
    mixerLevelState.clock -= 1 / 12;
    ticked = true;
  }
  if (ticked) {
    mixerWriteLevelTable(mixerState.levelData, mixerLevelState.level, mixerLevelState.peak, true);
    mixerState.levelTex.needsUpdate = true;
  }
  return ticked;
}

function mixerPanelTextFor(group) {
  var plan = mixerState.plan;
  if (plan.length) return (group >= 0 && group < plan.length) ? plan[group].text : '';
  var list = MIXER_PLACEHOLDER;
  return list[((group % list.length) + list.length) % list.length];
}

function mixerSyncPanels() {
  var ahead = Math.max(1, Math.round(mixerParam('panelAhead')));
  var behind = Math.max(0, Math.round(mixerParam('panelBehind')));
  var count = Math.min(MIXER_PANELS, 1 + ahead + behind);
  var index = mixerState.plan.length
    ? Math.min(mixerState.plan.length - 1, Math.max(0, Math.floor(mixerState.carousel + 1e-6)))
    : Math.max(0, Math.floor(mixerState.carousel + 1e-6));
  var base = Math.max(0, index - behind);
  var alphaScale = mixerClamp01(mixerParam('panelAlpha'));
  var data = mixerState.panelData;
  var dirty = false;
  mixerState.panelBase = base;
  mixerState.panelCount = count;
  for (var slot = 0; slot < MIXER_PANELS; slot++) {
    var off = slot * 4;
    if (slot >= count) {
      data[off] = 0; data[off + 1] = 0; data[off + 2] = 0; data[off + 3] = 0;
      continue;
    }
    var group = base + slot;
    var text = mixerPanelTextFor(group);
    if (mixerState.cellText[slot] !== text) {
      mixerRasterCell(slot, text);
      mixerState.cellText[slot] = text;
      dirty = true;
    }
    var cell = mixerCellUV(slot);
    data[off] = Math.round(cell.u * 255);
    data[off + 1] = Math.round(cell.v * 255);
    var x = mixerState.carousel - group;
    var lift = text ? mixerPanelLift(x) : 0;
    var alpha = text ? mixerPanelAlpha(x, ahead, behind) * alphaScale : 0;
    data[off + 2] = Math.round(mixerClamp01(lift) * 255);
    data[off + 3] = Math.round(mixerClamp01(alpha) * 255);
  }
  mixerState.panelTex.needsUpdate = true;
  if (dirty) {
    mixerState.atlasTex.needsUpdate = true;
    mixerState.atlasUploads++;
  }
}

function mixerFeedUniforms(nowSec) {
  if (!mixerState.mat) return;
  var u = mixerState.mat.uniforms;
  var sway = Math.max(0, mixerParam('camSway'));
  u.iTime.value = nowSec;
  u.iFrame.value = mixerState.frames | 0;
  u.uViewZoom.value = Math.max(0.2, mixerParam('viewZoom'));
  u.uPanY.value = mixerParam('viewPanY');
  u.uSwayX.value = Math.sin(nowSec * 0.8) * 0.10 * sway;
  u.uSwayY.value = Math.sin(nowSec * 0.56) * 0.05 * sway;
  u.uTileSize.value = Math.max(0.5, mixerParam('tileSize'));
  u.uPanelSpacing.value = Math.max(1, mixerParam('panelSpacing'));
  u.uCarousel.value = mixerState.carousel;
  u.uPanelBase.value = mixerState.panelBase;
  u.uPanelCount.value = mixerState.panelCount;
  u.uPanelLift.value = Math.max(0, mixerParam('panelLift'));
  u.uModuleGlow.value = Math.max(0, mixerParam('moduleGlow'));
  u.uMeterGain.value = Math.max(0, mixerParam('meterGain'));
  u.uFaderSpeed.value = Math.max(0, mixerParam('faderSpeed'));
  u.uKnobTurn.value = Math.max(0, mixerParam('knobTurn'));
  u.uBeatGlow.value = Math.max(0, mixerParam('beatGlow'));
  u.uBass.value = (typeof bass !== 'undefined' && isFinite(bass)) ? Number(bass) : 0;
  u.uMid.value = (typeof mid !== 'undefined' && isFinite(mid)) ? Number(mid) : 0;
  u.uTreble.value = (typeof treble !== 'undefined' && isFinite(treble)) ? Number(treble) : 0;
  u.uBeat.value = (typeof beatPulse !== 'undefined' && isFinite(beatPulse)) ? Number(beatPulse) : 0;
  u.uEnergy.value = (typeof audioEnergy !== 'undefined' && isFinite(audioEnergy)) ? Number(audioEnergy) : 0;
  if (mixerState.accentColor) {
    mixerState.accentColor.set(mixerAccentHex());
    u.uAccent.value.set(mixerState.accentColor.r, mixerState.accentColor.g, mixerState.accentColor.b);
  }
  mixerState.blitMat.uniforms.uExposure.value = Math.max(0, mixerParam('exposure'));
  mixerState.blitMat.uniforms.uVignette.value = mixerClamp01(mixerParam('vignette'));
  mixerState.blitMat.uniforms.uTime.value = nowSec;
}

function updateMixerDeskLayer(now, dt, sonicFrame) {
  if (!mixerPresetIsActive()) return false;
  var startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  if (!mixerState.built && !mixerBuildScene()) return false;
  var step = Math.max(0, Math.min(0.12, Number(dt) || 0));
  var nowSec = (Number(now) || 0) / 1000;
  var time = (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) ? Number(audio.currentTime) : nowSec;
  mixerSyncPlan();
  mixerAdvanceCarousel(step, time);
  mixerUpdateLevels(sonicFrame, step, mixerParam('audioSmooth'));
  mixerSyncPanels();
  mixerFeedUniforms(nowSec);
  mixerState.frames++;
  mixerState.lastCostMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - startedAt;
  return true;
}

function renderMixerDeskFrame() {
  if (!mixerPresetIsActive()) return false;
  if (typeof renderer === 'undefined' || !renderer) return false;
  if (!mixerState.built && !mixerBuildScene()) return false;
  if (!mixerAlignPassSize()) return false;
  try {
    renderer.setRenderTarget(mixerState.rt);
    renderer.render(mixerState.quadScene, mixerState.quadCam);
    renderer.setRenderTarget(null);
    renderer.render(mixerState.blitScene, mixerState.blitCam);
  } catch (err) {
    try { renderer.setRenderTarget(null); } catch (ignored) { /* already off-target */ }
    mixerState.error = String((err && (err.message || err)) || err).slice(0, 200);
    return false;
  }
  return true;
}

function mixerDisposeScene() {
  [mixerState.atlasTex, mixerState.levelTex, mixerState.panelTex].forEach(function (tex) {
    if (tex) tex.dispose();
  });
  [mixerState.mat, mixerState.blitMat].forEach(function (mat) { if (mat) mat.dispose(); });
  [mixerState.quad, mixerState.blitScene && mixerState.blitScene.children[0]].forEach(function (mesh) {
    if (mesh && mesh.geometry) mesh.geometry.dispose();
  });
  if (mixerState.rt) mixerState.rt.dispose();
  if (mixerState.quadScene) mixerState.quadScene.clear();
  if (mixerState.blitScene) mixerState.blitScene.clear();
  mixerState.built = false;
  mixerState.quadScene = null;
  mixerState.quadCam = null;
  mixerState.quad = null;
  mixerState.mat = null;
  mixerState.blitScene = null;
  mixerState.blitCam = null;
  mixerState.blitMat = null;
  mixerState.rt = null;
  mixerState.rtW = 0;
  mixerState.rtH = 0;
  mixerState.passScale = 0;
  mixerState.atlasCanvas = null;
  mixerState.atlasCtx = null;
  mixerState.atlasTex = null;
  mixerState.levelData = null;
  mixerState.levelTex = null;
  mixerState.panelData = null;
  mixerState.panelTex = null;
  mixerState.plan = [];
  mixerState.planKey = '';
  mixerState.carousel = 0;
  mixerState.lastTime = -1;
  mixerState.panelBase = 0;
  mixerState.panelCount = 0;
  mixerState.frames = 0;
  mixerState.lastCostMs = 0;
  mixerState.error = '';
  mixerState.objects = 0;
}

function mixerDeskStatus() {
  return {
    active: mixerPresetIsActive(), built: mixerState.built,
    frames: mixerState.frames, costMs: Math.round(mixerState.lastCostMs * 100) / 100,
    error: mixerState.error,
    carousel: Math.round(mixerState.carousel * 1000) / 1000,
    panels: mixerState.panelCount, panelBase: mixerState.panelBase,
    planGroups: mixerState.plan.length, atlasUploads: mixerState.atlasUploads,
    snapCount: mixerState.snapCount,
    passScale: mixerState.passScale, rt: [mixerState.rtW, mixerState.rtH],
    objects: mixerState.objects
  };
}

function applyMixerPresetNow(prev, next) {
  var on = Number(next) === MIXER_PRESET_INDEX;
  var was = Number(prev) === MIXER_PRESET_INDEX;
  if (on) {
    mixerBuildScene();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('mixer-preset');
  } else if (was) {
    mixerDisposeScene();
  }
  return on;
}

// The raymarched desk is the whole picture: every scene layer behind it is taken over, including
// the app's stage lyrics, because the lyrics live on the desk's own panels.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'mixer-desk',
    isActive: mixerPresetIsActive,
    suppresses: {
      particles: true, bloom: true, float: true, backCover: true,
      starRiver: true, ripples: true, lyricsParticles: true, stageLyrics: true
    }
  });
}

