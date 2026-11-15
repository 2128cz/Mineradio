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

var MIXER_MARCH_MAX = 160;
var MIXER_PANELS = 8;
var MIXER_ATLAS_COLS = 4;
var MIXER_ATLAS_ROWS = 4;
var MIXER_ATLAS_CELL = 512;
var MIXER_LEVEL_BANDS = 8;
var MIXER_LEVEL_AGES = 8;

// Every knob is declared here; the store (07-fx/15-mixer-tuning.js) keeps no defaults of its own.
var MIXER_TUNING_SCHEMA = {
  // ---- camera
  camEyeY: { def: 0.94, min: 0.55, max: 1.55, kind: 'unit', rebuild: 'live' },
  camPitch: { def: -16, min: -34, max: -2, kind: 'deg', rebuild: 'live' },
  camSway: { def: 0.5, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  camFov: { def: 52, min: 30, max: 80, kind: 'deg', rebuild: 'live' },
  // ---- the conveyor
  flowSpeed: { def: 0.9, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  bayPitch: { def: 1.05, min: 0.6, max: 2, kind: 'unit', rebuild: 'live' },
  deskWidth: { def: 2.7, min: 1.6, max: 4.2, kind: 'unit', rebuild: 'live' },
  bayDetail: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  moduleGlow: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  // ---- module motion from the music
  meterGain: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  faderSpeed: { def: 1, min: 0, max: 4, kind: 'ratio', rebuild: 'live' },
  knobTurn: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  // ---- lyric panels
  charsPerPanel: { def: 2, min: 1, max: 6, kind: 'count', rebuild: 'live' },
  panelAhead: { def: 4, min: 1, max: 5, kind: 'count', rebuild: 'live' },
  panelBehind: { def: 2, min: 0, max: 2, kind: 'count', rebuild: 'live' },
  panelLift: { def: 0.22, min: 0, max: 0.6, kind: 'unit', rebuild: 'live' },
  panelMinGap: { def: 0.38, min: 0.1, max: 1.5, kind: 'sec', rebuild: 'live' },
  panelGlide: { def: 0.7, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  panelAlpha: { def: 0.95, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  maxGroupsPerLine: { def: 14, min: 2, max: 24, kind: 'count', rebuild: 'live' },
  flowLock: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  // ---- audio
  beatGlow: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  audioSmooth: { def: 0.6, min: 0, max: 0.95, kind: 'ratio', rebuild: 'live' },
  // ---- march and pass
  marchSteps: { def: 64, min: 24, max: 160, kind: 'count', rebuild: 'live' },
  shadowSteps: { def: 8, min: 0, max: 32, kind: 'count', rebuild: 'live' },
  renderScale: { def: 0.9, min: 0.5, max: 1, kind: 'ratio', rebuild: 'pass' },
  maxDist: { def: 9, min: 5, max: 16, kind: 'unit', rebuild: 'live' },
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
  'uniform vec3 uCamEye;',
  'uniform vec3 uCamFwd;',
  'uniform vec3 uCamRight;',
  'uniform vec3 uCamUp;',
  'uniform float uTanHalf;',
  'uniform float uFlow;',
  'uniform float uCarousel;',
  'uniform float uBayPitch;',
  'uniform float uDeskWidth;',
  'uniform float uBayDetail;',
  'uniform float uModuleGlow;',
  'uniform float uMeterGain;',
  'uniform float uFaderSpeed;',
  'uniform float uKnobTurn;',
  'uniform float uBeatGlow;',
  'uniform float uPanelBase;',
  'uniform float uPanelCount;',
  'uniform float uPanelLift;',
  'uniform float uSteps;',
  'uniform float uShadowSteps;',
  'uniform float uFar;',
  'uniform float uBass;',
  'uniform float uMid;',
  'uniform float uTreble;',
  'uniform float uBeat;',
  'uniform float uEnergy;',
  'uniform vec3 uKeyColor;',
  'uniform vec3 uRimColor;',
  'uniform vec3 uSkyColor;',
  'uniform vec3 uUnderColor;',
  'uniform vec3 uAccent;',
  'const int MIXER_PANELS = 8;',
  'const vec2 MIXER_ATLAS = vec2(4.0, 4.0);',
  'const float PI = 3.14159265;',
  '',
  'float mdHash11(float p) {',
  '  p = fract(p * 0.1031);',
  '  p *= p + 33.33;',
  '  p *= p + p;',
  '  return fract(p);',
  '}',
  'float mdHash21(vec2 p) {',
  '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
  '  p3 += dot(p3, p3.yzx + 33.33);',
  '  return fract((p3.x + p3.y) * p3.z);',
  '}',
  'float mdBox(vec3 p, vec3 b, float r) {',
  '  vec3 q = abs(p) - b + r;',
  '  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;',
  '}',
  'float mdBox2(vec2 p, vec2 b) {',
  '  vec2 d = abs(p) - b;',
  '  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);',
  '}',
  'float mdCylY(vec3 p, float r, float h) {',
  '  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);',
  '  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));',
  '}',
  'float mdTorus(vec3 p, float R, float r) {',
  '  vec2 q = vec2(length(p.xz) - R, p.y);',
  '  return length(q) - r;',
  '}',
  'float mdRepeat1(float x, float period) {',
  '  return mod(x, period) - period * 0.5;',
  '}',
  'float mdSmin(float a, float b, float k) {',
  '  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);',
  '  return mix(b, a, h) - k * h * (1.0 - h);',
  '}',
  'vec2 mdRot(vec2 p, float a) {',
  '  float c = cos(a), s = sin(a);',
  '  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);',
  '}',
  '',
  // ---- one bay of modules. Three clusters, chosen by a hash of the bay and column.
  'vec2 mixerKnobs(vec3 p, float h) {',
  '  vec2 res = vec2(1e5, 1.0);',
  '  for (int k = 0; k < 3; k++) {',
  '    float x = (float(k) - 1.0) * 0.19;',
  '    vec3 q = p - vec3(x, 0.0, 0.02);',
  '    float body = mdCylY(q - vec3(0.0, 0.055, 0.0), 0.075, 0.042);',
  '    if (body < res.x) res = vec2(body, 1.0);',
  '    float ang = (0.6 + 2.2 * h + float(k) * 0.7) * mix(-1.0, 1.0, uKnobTurn)',
  '              + (uBass - 0.25) * 1.4 * uKnobTurn;',
  '    vec3 n = q - vec3(0.0, 0.098, 0.0);',
  '    n.xz = mdRot(n.xz, ang);',
  '    float notch = mdBox(n, vec3(0.008, 0.004, 0.042), 0.002);',
  '    if (notch < res.x) res = vec2(notch, 5.0);',
  '  }',
  '  return res;',
  '}',
  'vec2 mixerFaders(vec3 p, float h) {',
  '  vec2 res = vec2(1e5, 7.0);',
  '  for (int k = 0; k < 4; k++) {',
  '    float x = (float(k) - 1.5) * 0.125;',
  '    float slide = mix(-0.11, 0.11, 0.5 + 0.5 * sin((uBass * 0.8 + uMid * 0.6) * 4.0 + h * 17.0 + float(k) * 1.7));',
  '    slide *= clamp(uFaderSpeed, 0.0, 2.0);',
  '    float track = mdBox(p - vec3(x, 0.022, 0.0), vec3(0.011, 0.007, 0.24), 0.004);',
  '    float cap = mdBox(p - vec3(x, 0.042, slide), vec3(0.032, 0.019, 0.015), 0.006);',
  '    if (track < res.x) res = vec2(track, 7.0);',
  '    if (cap < res.x) res = vec2(cap, 2.0);',
  '  }',
  '  return res;',
  '}',
  'vec2 mixerPads(vec3 p, float h) {',
  '  vec2 res = vec2(1e5, 3.0);',
  '  for (int j = 0; j < 2; j++) {',
  '    for (int i = 0; i < 4; i++) {',
  '      vec3 q = p - vec3((float(i) - 1.5) * 0.135, 0.026, (float(j) - 0.5) * 0.14);',
  '      float pad = mdBox(q, vec3(0.06, 0.016, 0.06), 0.008);',
  '      if (pad < res.x) res = vec2(pad, 3.0);',
  '    }',
  '  }',
  '  float meter = 1e5;',
  '  for (int s = 0; s < 8; s++) {',
  '    vec3 q = p - vec3(0.355, 0.022 + float(s) * 0.021, 0.0);',
  '    float seg = mdBox(q, vec3(0.026, 0.008, 0.105), 0.003);',
  '    if (seg < meter) meter = seg;',
  '  }',
  '  if (meter < res.x) res = vec2(meter, 4.0);',
  '  return res;',
  '}',
  'vec2 mixerLeds(vec3 p, float h) {',
  '  vec2 res = vec2(1e5, 5.0);',
  '  for (int i = 0; i < 6; i++) {',
  '    vec3 q = p - vec3((float(i) - 2.5) * 0.082, 0.020, 0.205);',
  '    float doty = mdCylY(q, 0.014, 0.007);',
  '    if (doty < res.x) res = vec2(doty, 5.0);',
  '  }',
  '  return res;',
  '}',
  'vec2 mixerBays(vec3 p) {',
  '  vec2 res = vec2(1e5, 1.0);',
  '  float halfW = uDeskWidth * 0.5 - 0.06;',
  '  if (abs(p.x) > halfW) return res;',
  '  float xPitch = clamp(0.94, 0.7, uDeskWidth / 2.0);',
  '  float bx = floor(p.x / xPitch + 0.5);',
  '  float q = p.z - uFlow;',
  '  float b = floor(q / uBayPitch + 0.5);',
  '  if (p.z > 0.10 || p.z < -3.85) return res;',
  '  vec3 lp = p;',
  '  lp.x = p.x - bx * xPitch;',
  '  lp.z = q - b * uBayPitch;',
  '  float h = mdHash21(vec2(bx * 1.37 + 3.1, b * 0.73 + 8.7));',
  '  vec2 plate = vec2(mdBox(lp - vec3(0.0, 0.010, 0.0), vec3(xPitch * 0.47, 0.010, uBayPitch * 0.42), 0.008), 6.0);',
  '  vec2 mods = (h < 0.36) ? mixerKnobs(lp, h) : ((h < 0.68) ? mixerFaders(lp, h) : mixerPads(lp, h));',
  '  if (uBayDetail < 0.05) mods = vec2(1e5, 1.0);',
  '  res = plate;',
  '  if (mods.x < res.x) res = mods;',
  '  vec2 leds = mixerLeds(lp, h);',
  '  if (leds.x < res.x) res = leds;',
  '  return res;',
  '}',
  '',
  // ---- the desk itself
  'float mixerDeck(vec3 p) {',
  '  float d = mdBox(p - vec3(0.0, -0.16, -1.7), vec3(uDeskWidth * 0.5, 0.16, 2.35), 0.025);',
  '  d = min(d, mdBox(p - vec3(-uDeskWidth * 0.5, 0.03, -1.7), vec3(0.035, 0.10, 2.35), 0.02));',
  '  d = min(d, mdBox(p - vec3( uDeskWidth * 0.5, 0.03, -1.7), vec3(0.035, 0.10, 2.35), 0.02));',
  '  d = min(d, mdBox(p - vec3(0.0, 0.09, -4.02), vec3(uDeskWidth * 0.53, 0.14, 0.05), 0.02));',
  '  d = max(d, -mdBox(p - vec3(0.0, 0.002, -3.30), vec3(uDeskWidth * 0.5, 0.010, 0.012), 0.0));',
  '  return d;',
  '}',
  '',
  // ---- lyric panels: explicit boxes, placed from the conveyor index the JS side hands over
  'vec2 mixerPanels(vec3 p) {',
  '  vec2 res = vec2(1e5, 10.0);',
  '  for (int i = 0; i < MIXER_PANELS; i++) {',
  '    if (float(i) >= uPanelCount) break;',
  '    vec4 meta = texture2D(iChannel2, vec2((float(i) + 0.5) / 8.0, 0.5));',
  '    if (meta.w <= 0.002) continue;',
  '    float g = uPanelBase + float(i);',
  '    float xoff = uCarousel - g;',
  '    vec3 c = vec3(0.0, 0.10 + meta.z * uPanelLift, 0.15 + xoff * uBayPitch);',
  '    vec3 q = p - c;',
  '    q.yz = mdRot(q.yz, -0.38);',
  '    float bez = mdBox(q, vec3(0.28, 0.014, 0.165), 0.010);',
  '    float glass = mdBox(q - vec3(0.0, 0.012, 0.0), vec3(0.26, 0.006, 0.145), 0.006);',
  '    float d = min(bez, glass);',
  '    if (d < res.x) res = vec2(d, 10.0 + float(i));',
  '  }',
  '  return res;',
  '}',
  '',
  'vec2 mixerMap(vec3 p) {',
  '  vec2 res = vec2(mixerDeck(p), 0.0);',
  '  vec2 bay = mixerBays(p);',
  '  if (bay.x < res.x) res = bay;',
  '  vec2 pan = mixerPanels(p);',
  '  if (pan.x < res.x) res = pan;',
  '  vec2 strip = vec2(',
  '    min(mdBox(p - vec3(0.0, 0.045, -3.30), vec3(uDeskWidth * 0.5, 0.008, 0.010), 0.006),',
  '        mdBox(p - vec3(0.0, 0.045, 0.055), vec3(uDeskWidth * 0.5, 0.008, 0.010), 0.006)), 8.0);',
  '  if (strip.x < res.x) res = strip;',
  '  return res;',
  '}',
  '',
  'vec3 mixerNormal(vec3 p) {',
  '  float e = 0.0016;',
  '  vec3 n = vec3(',
  '    mixerMap(p + vec3(e, 0.0, 0.0)).x - mixerMap(p - vec3(e, 0.0, 0.0)).x,',
  '    mixerMap(p + vec3(0.0, e, 0.0)).x - mixerMap(p - vec3(0.0, e, 0.0)).x,',
  '    mixerMap(p + vec3(0.0, 0.0, e)).x - mixerMap(p - vec3(0.0, 0.0, e)).x);',
  '  return normalize(n + vec3(0.0, 1e-5, 0.0));',
  '}',
  '',
  'float mixerAO(vec3 p, vec3 n) {',
  '  float occ = 0.0;',
  '  float sca = 1.0;',
  '  for (int i = 0; i < 3; i++) {',
  '    float h = 0.018 + 0.045 * float(i);',
  '    occ += (h - mixerMap(p + n * h).x) * sca;',
  '    sca *= 0.65;',
  '  }',
  '  return clamp(1.0 - 2.4 * occ, 0.0, 1.0);',
  '}',
  '',
  'float mixerShadow(vec3 ro, vec3 rd) {',
  '  float res = 1.0;',
  '  float t = 0.03;',
  '  for (int i = 0; i < 32; i++) {',
  '    if (float(i) >= uShadowSteps) break;',
  '    float h = mixerMap(ro + rd * t).x;',
  '    res = min(res, 10.0 * h / t);',
  '    t += clamp(h, 0.02, 0.22);',
  '    if (res < 0.03 || t > 1.7) break;',
  '  }',
  '  return clamp(res, 0.0, 1.0);',
  '}',
  '',
  'float mixerMarch(vec3 ro, vec3 rd, out float hitId) {',
  '  float t = 0.02;',
  '  hitId = -1.0;',
  '  for (int i = 0; i < 160; i++) {',
  '    if (float(i) >= uSteps) break;',
  '    vec3 p = ro + rd * t;',
  '    vec2 m = mixerMap(p);',
  '    if (m.x < max(0.0009, t * 0.0016)) { hitId = m.y; break; }',
  '    t += max(m.x * 0.85, 0.0035);',
  '    if (t > uFar) break;',
  '  }',
  '  return t;',
  '}',
  '',
  'vec3 mixerShade(vec3 p, vec3 rd, float id) {',
  '  vec3 n = mixerNormal(p);',
  '  vec3 base = uUnderColor * 0.5;',
  '  vec3 specCol = vec3(0.25);',
  '  float specPow = 36.0;',
  '  vec3 emit = vec3(0.0);',
  '  if (id < 0.5) {',
  '    base = mix(uUnderColor, vec3(0.11, 0.13, 0.18), 0.55);',
  '    base *= 0.9 + 0.1 * mdHash21(floor(p.xz * 18.0));',
  '  } else if (id < 1.5) {',
  '    base = vec3(0.30, 0.31, 0.34) * 0.55;',
  '    specCol = vec3(0.9); specPow = 52.0;',
  '  } else if (id < 2.5) {',
  '    base = vec3(0.16, 0.17, 0.20);',
  '    specCol = vec3(0.35); specPow = 40.0;',
  '  } else if (id < 3.5) {',
  '    float lit = step(0.55 - uBeat * 0.5, mdHash21(floor(p.xz * 60.0)));',
  '    base = vec3(0.05, 0.08, 0.10);',
  '    emit += vec3(0.15, 0.55, 0.85) * lit * (0.3 + uBeat * 1.6) * uModuleGlow;',
  '    specCol = vec3(0.6); specPow = 70.0;',
  '  } else if (id < 4.5) {',
  '    float seg = clamp((p.y - 0.02) / 0.17, 0.0, 1.0);',
  '    float band = floor(seg * 7.0 + 0.5);',
  '    float lvl = texture2D(iChannel0, vec2((band + 0.5) / 8.0, 0.5 / 8.0)).r * uMeterGain;',
  '    float on = step(seg, lvl);',
  '    emit += mix(vec3(0.1, 0.7, 0.55), uKeyColor, seg) * on * 1.6 * uModuleGlow;',
  '    base = vec3(0.04);',
  '  } else if (id < 5.5) {',
  '    float bl = 0.35 + 0.65 * step(0.35, uBeat);',
  '    emit += uKeyColor * bl * uBeatGlow * 2.2 * uModuleGlow;',
  '    base = vec3(0.05);',
  '  } else if (id < 6.5) {',
  '    base = vec3(0.055, 0.065, 0.08);',
  '    specCol = vec3(0.2); specPow = 30.0;',
  '  } else if (id < 7.5) {',
  '    base = vec3(0.02, 0.022, 0.03);',
  '    specCol = vec3(0.15); specPow = 26.0;',
  '  } else if (id < 9.5) {',
  '    base = vec3(0.10, 0.11, 0.13); specCol = vec3(0.9); specPow = 70.0;',
  '    emit += uAccent * (0.9 + uBeat * uBeatGlow) * uModuleGlow;',
  '  } else {',
  '    int pi = int(id - 10.0 + 0.5);',
  '    vec4 meta = texture2D(iChannel2, vec2((float(pi) + 0.5) / 8.0, 0.5));',
  '    float g = uPanelBase + float(pi);',
  '    float xoff = uCarousel - g;',
  '    vec3 c = vec3(0.0, 0.10 + meta.z * uPanelLift, 0.15 + xoff * uBayPitch);',
  '    vec3 q = p - c;',
  '    q.yz = mdRot(q.yz, -0.38);',
  '    vec2 uv = clamp(vec2(q.x / 0.52 + 0.5, q.z / 0.29 + 0.5), 0.02, 0.98);',
  '    float glyph = texture2D(iChannel1, meta.xy + uv / MIXER_ATLAS).r;',
  '    float scan = 0.86 + 0.14 * sin(uv.y * 140.0 + iTime * 4.0);',
  '    vec3 ink = mix(uAccent, vec3(1.0), 0.5);',
  '    base = vec3(0.006, 0.008, 0.012) + ink * 0.02;',
  '    emit += ink * glyph * (0.45 + meta.z * 1.1) * meta.w * 1.15 * uModuleGlow * scan;',
  '    float edge = smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));',
  '    emit += uAccent * (1.0 - edge) * 0.35 * meta.w;',
  '    specCol = vec3(0.05); specPow = 120.0;',
  '  }',
  '  vec3 v = -rd;',
  '  vec3 col = base * 0.35;',
  '  col += base * mix(uUnderColor, uSkyColor, n.y * 0.5 + 0.5) * 0.35;',
  '  vec3 l1 = normalize(vec3(-0.55, 1.0, -0.30));',
  '  float sh = mixerShadow(p + n * 0.004, l1);',
  '  float nl1 = max(0.0, dot(n, l1));',
  '  vec3 h1 = normalize(l1 + v);',
  '  float s1 = pow(max(0.0, dot(n, h1)), specPow);',
  '  col += uKeyColor * 1.15 * sh * nl1 * (base / PI + specCol * s1 * 0.7);',
  '  vec3 l2 = normalize(vec3(0.75, 0.40, 0.85));',
  '  float nl2 = max(0.0, dot(n, l2));',
  '  vec3 h2 = normalize(l2 + v);',
  '  float s2 = pow(max(0.0, dot(n, h2)), specPow);',
  '  col += uRimColor * 0.85 * nl2 * (base / PI + specCol * s2 * 0.5);',
  '  col *= mixerAO(p, n) * 0.75 + 0.25;',
  '  col += emit;',
  '  return col;',
  '}',
  '',
  'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
  '  vec2 sc = (fragCoord.xy / iResolution.xy) * 2.0 - 1.0;',
  '  sc.x *= iResolution.x / iResolution.y;',
  '  vec3 ro = uCamEye;',
  '  vec3 rd = normalize(uCamFwd + (uCamRight * sc.x + uCamUp * sc.y) * uTanHalf);',
  '  float hitId = -1.0;',
  '  float t = mixerMarch(ro, rd, hitId);',
  '  vec3 bg = mix(uUnderColor * 0.35, uSkyColor, clamp(rd.y * 0.6 + 0.45, 0.0, 1.0));',
  '  vec3 col = bg;',
  '  if (hitId >= 0.0) {',
  '    vec3 p = ro + rd * t;',
  '    col = mixerShade(p, rd, hitId);',
  '    col = mix(col, bg, 1.0 - exp(-max(0.0, t - 0.5) * 0.10));',
  '  }',
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
  ctx.font = '700 236px "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(x + MIXER_ATLAS_CELL / 2, y + MIXER_ATLAS_CELL / 2);
  ctx.scale(squash, 1);
  ctx.shadowColor = accent;
  ctx.shadowBlur = 14;
  ctx.fillStyle = accent;
  ctx.fillText(text, 0, 0);
  ctx.shadowBlur = 5;
  ctx.fillStyle = '#eaf6ff';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function mixerInitialUniforms() {
  var v3 = function (x, y, z) { return new THREE.Vector3(x || 0, y || 0, z || 0); };
  return {
    iResolution: shadertoyUvUniforms(1, 1),
    iTime: { value: 0 },
    iFrame: { value: 0 },
    iMouse: { value: [0, 0, 0, 0] },
    iChannel0: { value: null },
    iChannel1: { value: null },
    iChannel2: { value: null },
    uCamEye: { value: v3(0, 0.98, 2.15) },
    uCamFwd: { value: v3(0, 0, -1) },
    uCamRight: { value: v3(1, 0, 0) },
    uCamUp: { value: v3(0, 1, 0) },
    uTanHalf: { value: 0.5 },
    uFlow: { value: 0 },
    uCarousel: { value: 0 },
    uBayPitch: { value: 1.05 },
    uDeskWidth: { value: 2.7 },
    uBayDetail: { value: 1 },
    uModuleGlow: { value: 1 },
    uMeterGain: { value: 1 },
    uFaderSpeed: { value: 1 },
    uKnobTurn: { value: 1 },
    uBeatGlow: { value: 1 },
    uPanelBase: { value: 0 },
    uPanelCount: { value: 0 },
    uPanelLift: { value: 0.22 },
    uSteps: { value: 64 },
    uShadowSteps: { value: 8 },
    uFar: { value: 9 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uEnergy: { value: 0 },
    uKeyColor: { value: v3.apply(null, MIXER_PALETTE.keyWarm) },
    uRimColor: { value: v3.apply(null, MIXER_PALETTE.rimCool) },
    uSkyColor: { value: v3(0.05, 0.08, 0.12) },
    uUnderColor: { value: v3.apply(null, MIXER_PALETTE.voidColor) },
    uAccent: { value: v3(1, 0.69, 0.34) }
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

function mixerFeedCamera(nowSec) {
  var sway = Math.max(0, mixerParam('camSway'));
  var eyeY = mixerParam('camEyeY');
  var dist = 4.4;
  var pitch = mixerParam('camPitch') * Math.PI / 180;
  mixerCam.eye.set(
    Math.sin(nowSec * 0.8) * 0.035 * sway,
    eyeY + Math.sin(nowSec * 0.56) * 0.012 * sway,
    2.15
  );
  mixerCam.target.set(0, eyeY + Math.tan(pitch) * dist, 2.15 - dist);
  mixerCam.fwd.subVectors(mixerCam.target, mixerCam.eye).normalize();
  mixerCam.right.crossVectors(mixerCam.fwd, mixerCam.worldUp).normalize();
  mixerCam.up.crossVectors(mixerCam.right, mixerCam.fwd).normalize();
}

function mixerFeedUniforms(nowSec) {
  if (!mixerState.mat) return;
  var u = mixerState.mat.uniforms;
  var fov = Math.min(120, Math.max(20, mixerParam('camFov')));
  mixerFeedCamera(nowSec);
  u.iTime.value = nowSec;
  u.iFrame.value = mixerState.frames | 0;
  u.uCamEye.value.copy(mixerCam.eye);
  u.uCamFwd.value.copy(mixerCam.fwd);
  u.uCamRight.value.copy(mixerCam.right);
  u.uCamUp.value.copy(mixerCam.up);
  u.uTanHalf.value = Math.tan(fov * Math.PI / 360);
  u.uFlow.value = mixerState.carousel * mixerParam('bayPitch');
  u.uCarousel.value = mixerState.carousel;
  u.uBayPitch.value = Math.max(0.2, mixerParam('bayPitch'));
  u.uDeskWidth.value = Math.max(1, mixerParam('deskWidth'));
  u.uBayDetail.value = Math.max(0, mixerParam('bayDetail'));
  u.uModuleGlow.value = Math.max(0, mixerParam('moduleGlow'));
  u.uMeterGain.value = Math.max(0, mixerParam('meterGain'));
  u.uFaderSpeed.value = Math.max(0, mixerParam('faderSpeed'));
  u.uKnobTurn.value = Math.max(0, mixerParam('knobTurn'));
  u.uBeatGlow.value = Math.max(0, mixerParam('beatGlow'));
  u.uPanelBase.value = mixerState.panelBase;
  u.uPanelCount.value = mixerState.panelCount;
  u.uPanelLift.value = Math.max(0, mixerParam('panelLift'));
  u.uSteps.value = Math.max(8, Math.min(MIXER_MARCH_MAX, mixerParam('marchSteps')));
  u.uShadowSteps.value = Math.max(0, Math.min(32, mixerParam('shadowSteps')));
  u.uFar.value = Math.max(2, mixerParam('maxDist'));
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

