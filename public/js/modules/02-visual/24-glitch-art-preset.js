'use strict';

// 故障艺术 (preset 19). Reference: Shadertoy "lfscD7" — a fault-art presentation fragment
// (Vignette + bloom + a downsampled texelFetch composite + a saturate/pow/lift tone curve).
// The page could not be fetched (403), so the supplied presentation pass is the authoritative
// fragment and everything else is split into its named components: a hashed-block source, a
// separable bloom, the low-res composite and the vignette. Helpers the reference names but does
// not define here (PCG, SeparableBlurUp, SetGlobals) are reimplemented against the same contract.
// Licence UNVERIFIED — see the sidecar/NOTICE before shipping a build.
//
// Every constant that shapes the picture is a knob in GLITCH_SCHEMA (one home for the defaults),
// and the source reads the same 64-bin spectrum + 8-band frame the other presets use, so the audio
// wiring lives in glitchFeedUniforms().

var GLITCH_PRESET_INDEX = 19;

var GLITCH_SCHEMA = {
  // ---- source: the corrupted signal
  blockSize: { def: 9, min: 2, max: 40, kind: 'count', rebuild: 'live' },
  glitchShift: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  tearAmount: { def: 0.45, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  tearSpeed: { def: 0.6, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  rgbSplit: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  scanline: { def: 0.25, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  grain: { def: 0.18, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  hue: { def: 0.85, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  // ---- presentation: the reference fragment's constants
  renderScale: { def: 0.85, min: 0.5, max: 1, kind: 'ratio', rebuild: 'pass' },
  downsample: { def: 3, min: 1, max: 8, kind: 'count', rebuild: 'pass' },
  bloomOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  bloomStrength: { def: 0.6, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  bloomRadius: { def: 2.5, min: 0.5, max: 8, kind: 'ratio', rebuild: 'live' },
  lift: { def: 0.1, min: 0, max: 0.5, kind: 'ratio', rebuild: 'live' },
  gamma: { def: 0.8, min: 0.4, max: 1.5, kind: 'ratio', rebuild: 'live' },
  vignetteStrength: { def: 0.5, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  vignetteScale: { def: 0.6, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  vignetteExponent: { def: 3, min: 1, max: 8, kind: 'ratio', rebuild: 'live' },
  // ---- audio wiring
  audioDrive: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  audioGlitch: { def: 0.6, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  audioTear: { def: 0.5, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  audioBloom: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  beatPulse: { def: 0.4, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  // ---- centre logo + glitched lyrics (the app's lyric text around the hexagon)
  logoOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  logoSize: { def: 1, min: 0.5, max: 2, kind: 'ratio', rebuild: 'live' },
  lyricOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  lyricGlitch: { def: 0.6, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  lyricSize: { def: 1, min: 0.5, max: 1.6, kind: 'ratio', rebuild: 'live' },
  styleCycle: { def: 6, min: 2, max: 20, kind: 'sec', rebuild: 'live' }
};

var GLITCH_SOURCE_FS = `
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform int iFrame;
uniform float uBlock;
uniform float uShift;
uniform float uTear;
uniform float uTearSpeed;
uniform float uRgb;
uniform float uScan;
uniform float uGrain;
uniform float uHue;
uniform float uDrive;
uniform float uBeat;
uniform float uBass;
uniform float uMid;
uniform float uTreble;

// The reference seeds a PRNG per frame; this preset only needs one stable word per cell, so a
// GLSL1 float hash stands in for PCG (no integer bit ops, same determinism contract).
float glitchHash(float n) {
  vec3 p3 = fract(vec3(n) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float glitchHash2(vec2 p, float seed) {
  return glitchHash(p.x * 127.1 + p.y * 311.7 + seed * 17.0);
}
vec3 glitchHsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
// The signal field: diagonal colour bands with a slow wobble. Every block reads this field at a
// displaced coordinate, so the tearing needs no extra buffers or fetches.
float glitchField(vec2 p, float t) {
  float wave = sin(p.x * 0.017 + t * 1.7) * 0.5 + sin(p.y * 0.031 - t * 1.1) * 0.5;
  return 0.5 + 0.5 * sin(wave * 2.6 + p.y * 0.009 + p.x * 0.004);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 res = iResolution.xy;
  float t = iTime;
  float bass = clamp(uBass * uDrive, 0.0, 1.5);
  float mid = clamp(uMid * uDrive, 0.0, 1.5);
  float treble = clamp(uTreble * uDrive, 0.0, 1.5);
  float beat = uBeat * (0.4 + bass);
  // The tear band slides down the frame; bass pushes it wider and faster.
  float bandY = fract(t * uTearSpeed * 0.11 + beat * 0.05) * res.y;
  float bandW = (0.02 + 0.07 * bass + 0.05 * beat + 0.02 * mid) * res.y * uTear;
  float band = smoothstep(bandW, 0.0, abs(frag.y - bandY)) * uTear;
  // Per-block displacement and data moshing, hashed from the block cell. The layout is held for a
  // few frames so it reads as corrupted data instead of white-noise flicker.
  float frameSeed = floor(float(iFrame) * 0.1667);
  vec2 cell = floor(frag / max(1.0, uBlock));
  float h = glitchHash2(cell, frameSeed);
  float pick = glitchHash2(cell + vec2(19.7, 7.3), frameSeed);
  float drive = uShift + uBeat * 0.0;
  vec2 shift = vec2((h - 0.5) * drive * uBlock * 3.0 * (0.35 + treble * 0.9), 0.0);
  shift += vec2((pick - 0.5) * uBlock * 4.5 * band, 0.0);
  vec2 sampleP = frag + shift;
  // A minority of blocks jump to a distant column: the classic broken-buffer look.
  sampleP.x += step(0.82, pick) * (pick - 0.5) * res.x * 0.35 * uShift;
  // Channel split: the same field sampled at three offsets.
  float r = glitchField(sampleP + vec2(uRgb * 7.0, 0.0), t);
  float g = glitchField(sampleP, t);
  float b = glitchField(sampleP - vec2(uRgb * 7.0, 0.0), t);
  float lum = (r + g + b) / 3.0;
  float hue = fract(uHue + pick * 0.18 + lum * 0.22 + bass * 0.05);
  vec3 col = glitchHsv(hue, 0.72 + 0.22 * pick, 0.18 + 0.78 * lum);
  // Posterise per block and invert a few, then scanlines and per-frame grain.
  float levels = floor(4.0 + pick * 9.0);
  col = floor(col * levels + 0.5) / levels;
  col = mix(col, 1.0 - col, step(0.9, h));
  col *= 1.0 - uScan * (0.45 + 0.55 * sin(frag.y * 3.14159265 * 0.35));
  col += (glitchHash2(frag, float(iFrame)) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// Component split: the reference calls SeparableBlurUp() inside the composite. Here the separable
// blur is its own pair of passes (horizontal, then vertical) over the low-res source, so the
// composite only has to fetch the finished bloom once.
var GLITCH_BLUR_FS = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 18.0);
    sum += texture2D(uTex, vUv + uDir * uTexel * fi * uRadius).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}
`;

// The supplied presentation fragment, kept in Shadertoy shape: Vignette() verbatim with its three
// #defines lifted to uniforms, then the bloom + texelFetch(downsampled screen) + saturate/pow/lift
// chain. texelFetch(iChannel1, ivec2(xy)/kScreenDownsample) becomes a nearest sample at the centre
// of the matching low-res texel.
var GLITCH_COMPOSITE_FS = `
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform vec2 uLowRes;
uniform float uDs;
uniform float uBloomOn;
uniform float uBloomStrength;
uniform float uLift;
uniform float uGamma;
uniform float uVigStrength;
uniform float uVigScale;
uniform float uVigExponent;
uniform sampler2D uLyricMain;
uniform sampler2D uLyricSub;
uniform vec4 uMainRect;
uniform vec4 uSubRect;
uniform float uLyricOn;
uniform float uLyricGlitch;
uniform float uHasSub;
uniform float uLogoOn;
uniform float uLogoSize;
uniform float uStyleHue;
uniform float uBeat;
uniform float uBass;
uniform float uAspect;
uniform float uStyleSeed;
const float kRoot2 = 1.41421356237;
const float kTau = 6.28318530718;

float glitchHash(float n) {
  vec3 p3 = fract(vec3(n) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float glitchHash2(vec2 p, float seed) {
  return glitchHash(p.x * 127.1 + p.y * 311.7 + seed * 17.0);
}
vec3 glitchHsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}

float Vignette(vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  uv.x = (uv.x - 0.5) * (iResolution.x / iResolution.y) + 0.5;
  float x = 2.0 * (uv.x - 0.5);
  float y = 2.0 * (uv.y - 0.5);
  float dist = sqrt(x * x + y * y) / kRoot2;
  return mix(1.0, max(0.0, 1.0 - pow(dist * uVigScale, uVigExponent)), uVigStrength);
}

// Hexagon logo: a dark plate, a neon outline with a hashed horizontal tear, an inner rotating ring
// and a scanline wash. The style hue comes from the same phase that seeds the lyric glitch, so the
// words and the icon read as one picture.
vec4 hexLogo(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  p /= max(0.2, uLogoSize);
  float ang = iTime * 0.16;
  p = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p;
  vec2 cell = floor(uv * vec2(90.0, 60.0));
  float h = glitchHash2(cell, uStyleSeed * 1.3 + 3.0);
  float tear = (h - 0.5) * 0.05 * uLyricGlitch;
  float dA = max(abs(p.x), dot(abs(p), normalize(vec2(1.0, 1.7320508)))) - 0.135;
  vec2 pt = p + vec2(tear, 0.0);
  float dB = max(abs(pt.x), dot(abs(pt), normalize(vec2(1.0, 1.7320508)))) - 0.135;
  float inside = smoothstep(0.006, -0.006, dA);
  float ringA = smoothstep(0.006, 0.001, abs(dA));
  float ringB = smoothstep(0.006, 0.001, abs(dB));
  float inner = max(abs(p.x), dot(abs(p), normalize(vec2(1.0, 1.7320508)))) - 0.082;
  float ringI = smoothstep(0.004, 0.0008, abs(inner));
  vec3 hueA = glitchHsv(uStyleHue, 0.82, 1.0);
  vec3 hueB = glitchHsv(fract(uStyleHue + 0.45), 0.82, 1.0);
  vec3 col = vec3(0.025, 0.02, 0.045) * inside;
  col += hueA * ringA * (1.1 + uBeat * 1.2);
  col += hueB * ringB * 0.55;
  col += hueB * ringI * 0.6;
  float scan = 1.0 - 0.16 * inside * (0.5 + 0.5 * sin(uv.y * 1300.0 + iTime * 4.0));
  col *= scan;
  float alpha = max(inside * 0.62, max(ringA, max(ringB, ringI)) * 0.95);
  return vec4(col, alpha);
}

// Glitched lyric plate: the canvas text is sampled through a screen-space block shift, a moving
// tear band and a chromatic split whose fringes take the logo's style hue.
vec4 lyricPlate(vec2 uv, sampler2D tex, vec4 rect, float seed) {
  vec2 cell = floor(uv * vec2(150.0, 90.0) / max(1.0, uLyricGlitch * 1.5 + 0.5));
  float h = glitchHash2(cell, seed);
  float pick = glitchHash2(cell + 13.7, seed);
  float bandY = fract(iTime * 0.19 + seed * 0.13);
  float band = smoothstep(0.03, 0.0, abs(uv.y - bandY)) * (0.5 + uBass);
  vec2 shift = vec2((h - 0.5) * 0.05 * uLyricGlitch + (pick - 0.5) * 0.10 * band, 0.0);
  vec2 tuv = (uv + shift - rect.xy) / rect.zw;
  float inside = step(0.0, tuv.x) * step(tuv.x, 1.0) * step(0.0, tuv.y) * step(tuv.y, 1.0);
  tuv = clamp(tuv, 0.0, 1.0);
  vec2 off = vec2(0.0035 * (0.5 + uLyricGlitch), 0.0);
  vec4 c0 = texture2D(tex, tuv);
  float aR = texture2D(tex, clamp(tuv + off, 0.0, 1.0)).a;
  float aB = texture2D(tex, clamp(tuv - off, 0.0, 1.0)).a;
  vec3 fringe = glitchHsv(fract(uStyleHue + 0.5), 0.9, 1.0);
  vec3 col = c0.rgb;
  col += fringe * max(0.0, aR - aB) * uLyricGlitch * 1.4;
  col += vec3(1.0, 0.25, 0.55) * max(0.0, aB - aR) * uLyricGlitch * 0.9;
  float scan = 1.0 - 0.14 * (0.5 + 0.5 * sin(uv.y * 950.0 + iTime * 5.0));
  return vec4(col * scan, max(c0.a, max(aR, aB) * 0.7) * inside);
}

void mainImage(out vec4 rgba, vec2 xy) {
  vec2 uv = xy / iResolution.xy;
  vec3 rgb = vec3(0.0);
  if (uBloomOn > 0.5) rgb = texture2D(iChannel0, xy / iResolution.xy).xyz * uBloomStrength;
  vec2 cell = floor(xy / max(1.0, uDs));
  cell = min(cell, uLowRes - 1.0);
  rgb += texture2D(iChannel1, (cell + 0.5) / uLowRes).xyz * 0.6;
  rgb = clamp(rgb, 0.0, 1.0);
  rgb = pow(rgb, vec3(uGamma));
  rgb = mix(vec3(uLift), vec3(1.0 - uLift), rgb);
  float vig = Vignette(xy);
  rgb *= vig;
  if (uLogoOn > 0.5) {
    vec4 logo = hexLogo(uv);
    logo.rgb *= vig;
    rgb = mix(rgb, logo.rgb, logo.a);
  }
  if (uLyricOn > 0.5) {
    float phase = uStyleSeed;
    vec4 main = lyricPlate(uv, uLyricMain, uMainRect, phase * 2.7 + 1.0);
    main.rgb *= vig;
    rgb = mix(rgb, main.rgb, main.a);
    if (uHasSub > 0.5) {
      vec4 sub = lyricPlate(uv, uLyricSub, uSubRect, phase * 2.7 + 5.0);
      sub.rgb *= vig;
      rgb = mix(rgb, sub.rgb, sub.a);
    }
  }
  rgba = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}

void main() {
  vec4 rgba = vec4(0.0);
  mainImage(rgba, gl_FragCoord.xy);
  gl_FragColor = rgba;
}
`;

var GLITCH_QUAD_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.999999, 1.0);
}
`;

var glitchState = {
  built: false,
  error: '',
  size: null,
  lowRt: null,
  bloomA: null,
  bloomB: null,
  lowW: 0,
  lowH: 0,
  bloomW: 0,
  bloomH: 0,
  sourceMat: null,
  blurMat: null,
  compositeMat: null,
  passes: null,
  frames: 0,
  mainCanvas: null,
  subCanvas: null,
  mainTex: null,
  subTex: null,
  mainKey: '',
  subKey: ''
};

function glitchClamp(value, min, max) {
  var n = Number(value);
  if (!isFinite(n)) n = min;
  return Math.min(max, Math.max(min, n));
}

function glitchParam(key) {
  var spec = GLITCH_SCHEMA[key];
  var raw = (typeof glitchArtTuning !== 'undefined' && glitchArtTuning && glitchArtTuning[key] !== undefined)
    ? glitchArtTuning[key]
    : (spec ? spec.def : 0);
  var n = Number(raw);
  if (!isFinite(n)) n = spec ? spec.def : 0;
  return spec ? glitchClamp(n, spec.min, spec.max) : n;
}

function glitchPresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === GLITCH_PRESET_INDEX;
}

// ---------------------------------------------------------------- spectrum + bands

function glitchBandValues(frame) {
  var out = [0, 0, 0, 0, 0, 0, 0, 0];
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


// ---------------------------------------------------------------- lyric plates + centre logo
// The text is a canvas texture; the composite glitches it in screen space, which is what lets the
// same fault effect run over type. Timeline/font/colour helpers are the app's (shared with the
// town preset), so the console's lyric settings keep working here.

function glitchLyricItems() {
  if (typeof nyanTownLyricItems === 'function') { try { return nyanTownLyricItems(); } catch (_) {} }
  return [];
}
function glitchLyricSung(items, t) {
  if (typeof nyanTownLyricSungIndex === 'function') { try { return nyanTownLyricSungIndex(items, t); } catch (_) {} }
  return -1;
}
function glitchLyricPalette() {
  if (typeof nyanTownLyricPalette === 'function') { try { return nyanTownLyricPalette(); } catch (_) {} }
  return { primary: '#d6f8ff', highlight: '#eef7ff', context: '#9cffdf', glow: '#9cffdf', signature: 'default' };
}
function glitchLyricFontCss(px) {
  if (typeof nyanTownLyricFontCss === 'function') { try { return nyanTownLyricFontCss(px); } catch (_) {} }
  return '900 ' + px.toFixed(1) + 'px sans-serif';
}
function glitchTranslationShown() {
  if (typeof nyanTownLyricTranslationShown === 'function') { try { return !!nyanTownLyricTranslationShown(); } catch (_) {} }
  return false;
}
function glitchLyricSpacing(px) {
  if (typeof lyricLetterSpacingPx === 'function') { try { return Number(lyricLetterSpacingPx(px)) || 0; } catch (_) {} }
  return 0;
}

function glitchDrawPlate(canvas, text, fontPx, color, glow) {
  if (!canvas || !text) return false;
  var ctx = canvas.getContext('2d');
  var w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  var size = fontPx;
  var font = glitchLyricFontCss(size);
  ctx.font = font;
  var spacing = glitchLyricSpacing(size);
  if ('letterSpacing' in ctx) ctx.letterSpacing = spacing.toFixed(2) + 'px';
  var width = ctx.measureText(text).width || 0;
  var limit = w * 0.94;
  if (width > limit && width > 0) {
    size *= limit / width;
    font = glitchLyricFontCss(size);
    ctx.font = font;
    spacing = glitchLyricSpacing(size);
    if ('letterSpacing' in ctx) ctx.letterSpacing = spacing.toFixed(2) + 'px';
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(4, 2, 12, 0.72)';
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.strokeText(text, w / 2, h / 2);
  ctx.shadowColor = glow;
  ctx.shadowBlur = size * 0.32;
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);
  ctx.shadowBlur = 0;
  ctx.fillText(text, w / 2, h / 2);
  return true;
}

function glitchUpdateLyrics(clock) {
  var cu = glitchState.compositeMat && glitchState.compositeMat.uniforms;
  if (!cu || !glitchState.mainTex) return;
  var items = glitchLyricItems();
  var t = clock;
  if (typeof getAdjustedLyricPlaybackTime === 'function') {
    var adjusted = Number(getAdjustedLyricPlaybackTime(clock));
    if (isFinite(adjusted)) t = adjusted;
  }
  var sung = glitchLyricSung(items, t);
  var item = (sung >= 0 && items[sung]) ? items[sung] : null;
  var palette = glitchLyricPalette();
  var subText = (item && glitchTranslationShown()) ? String(item.sub || '') : '';
  if (item) {
    var mainKey = palette.signature + '|' + item.text;
    if (glitchState.mainKey !== mainKey) {
      glitchDrawPlate(glitchState.mainCanvas, item.text, 118, palette.highlight, palette.glow);
      glitchState.mainKey = mainKey;
      glitchState.mainTex.needsUpdate = true;
    }
  } else if (glitchState.mainKey !== '') {
    glitchState.mainCanvas.getContext('2d').clearRect(0, 0, glitchState.mainCanvas.width, glitchState.mainCanvas.height);
    glitchState.mainKey = '';
    glitchState.mainTex.needsUpdate = true;
  }
  var subKey = palette.signature + '|' + subText;
  if (glitchState.subKey !== subKey) {
    if (subText) glitchDrawPlate(glitchState.subCanvas, subText, 54, palette.context, palette.glow);
    else glitchState.subCanvas.getContext('2d').clearRect(0, 0, glitchState.subCanvas.width, glitchState.subCanvas.height);
    glitchState.subKey = subKey;
    glitchState.subTex.needsUpdate = true;
  }
  cu.uHasSub.value = subText ? 1 : 0;
}

// One phase drives the logo's hue and the lyric glitch seed: the two move through styles together.
function glitchUpdateStyle(clock) {
  var cu = glitchState.compositeMat && glitchState.compositeMat.uniforms;
  if (!cu) return;
  var cycle = Math.max(2, glitchParam('styleCycle'));
  var seed = Math.floor(clock / cycle);
  cu.uStyleSeed.value = seed;
  cu.uStyleHue.value = (glitchParam('hue') + seed * 0.137) % 1;
  cu.uLyricOn.value = glitchParam('lyricOn') > 0 ? 1 : 0;
  cu.uLogoOn.value = glitchParam('logoOn') > 0 ? 1 : 0;
  cu.uLogoSize.value = glitchParam('logoSize');
  var aspect = cu.uAspect.value || 1.78;
  var scale = glitchParam('lyricSize');
  var mainW = Math.min(1.35, 0.92 * scale);
  var mainH = mainW * aspect / (1536 / 224);
  var mainY = Math.min(0.64, 0.97 - mainH);
  var subW = Math.min(1.1, 0.62 * scale);
  var subH = subW * aspect / (1024 / 112);
  var subY = Math.max(0.03, Math.min(0.16, 0.33 - subH));
  cu.uMainRect.value.set(0.5 - mainW / 2, mainY, mainW, mainH);
  cu.uSubRect.value.set(0.5 - subW / 2, subY, subW, subH);
}

// The whole audio wiring is here: bands -> the source uniforms, the spectrum -> the 64-bin texture,
// and the master drive knobs. Nothing else in the preset reads audio.
function glitchFeedAudio(frame) {
  var bands = glitchBandValues(frame);
  var drive = glitchParam('audioDrive');
  var beat = (typeof beatPulse !== 'undefined' && isFinite(beatPulse)) ? Number(beatPulse) : 0;
  var u = glitchState.sourceMat && glitchState.sourceMat.uniforms;
  if (u) {
    u.uBass.value = bands[1];
    u.uMid.value = bands[3];
    u.uTreble.value = bands[6];
    u.uBeat.value = glitchClamp(beat, 0, 1) * glitchParam('beatPulse');
    u.uShift.value = glitchParam('glitchShift') * (1 + glitchParam('audioGlitch') * bands[3] * drive);
    u.uTear.value = glitchParam('tearAmount') * (1 + glitchParam('audioTear') * bands[1] * drive);
    u.uRgb.value = glitchParam('rgbSplit') * (0.6 + 0.8 * bands[6] * drive);
  }
  var cu = glitchState.compositeMat && glitchState.compositeMat.uniforms;
  if (cu) {
    cu.uBloomStrength.value = glitchParam('bloomStrength') * (1 + glitchParam('audioBloom') * bands[1] * drive);
    cu.uBass.value = bands[1];
    cu.uBeat.value = glitchClamp(beat, 0, 1) * glitchParam('beatPulse');
    cu.uLyricGlitch.value = glitchParam('lyricGlitch') * (0.65 + 0.7 * bands[6] * drive);
  }
}

// ---------------------------------------------------------------- pass plumbing

function glitchMakePass(material, geometry) {
  var scene = new THREE.Scene();
  var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene: scene, camera: camera, mesh: mesh };
}

function glitchBuildScene() {
  if (glitchState.built) return true;
  try {
    var mainCanvas = document.createElement('canvas');
    mainCanvas.width = 1536;
    mainCanvas.height = 224;
    var subCanvas = document.createElement('canvas');
    subCanvas.width = 1024;
    subCanvas.height = 112;
    var mainTex = new THREE.CanvasTexture(mainCanvas);
    mainTex.minFilter = THREE.LinearFilter;
    mainTex.magFilter = THREE.LinearFilter;
    mainTex.generateMipmaps = false;
    var subTex = new THREE.CanvasTexture(subCanvas);
    subTex.minFilter = THREE.LinearFilter;
    subTex.magFilter = THREE.LinearFilter;
    subTex.generateMipmaps = false;
    var geometry = new THREE.PlaneGeometry(2, 2);
    var sourceMat = new THREE.ShaderMaterial({
      uniforms: {
        iResolution: { value: new THREE.Vector3(1, 1, 1) },
        iTime: { value: 0 },
        iFrame: { value: 0 },
        uBlock: { value: 9 },
        uShift: { value: 0.35 },
        uTear: { value: 0.45 },
        uTearSpeed: { value: 0.6 },
        uRgb: { value: 0.35 },
        uScan: { value: 0.25 },
        uGrain: { value: 0.18 },
        uHue: { value: 0.85 },
        uDrive: { value: 1 },
        uBeat: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 }
      },
      vertexShader: GLITCH_QUAD_VS,
      fragmentShader: GLITCH_SOURCE_FS,
      depthTest: false,
      depthWrite: false
    });
    var blurMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2(0.001, 0.001) },
        uRadius: { value: 2.5 }
      },
      vertexShader: GLITCH_QUAD_VS,
      fragmentShader: GLITCH_BLUR_FS,
      depthTest: false,
      depthWrite: false
    });
    var compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        iResolution: { value: new THREE.Vector3(1, 1, 1) },
        iChannel0: { value: null },
        iChannel1: { value: null },
        uLowRes: { value: new THREE.Vector2(1, 1) },
        uDs: { value: 3 },
        uBloomOn: { value: 1 },
        uBloomStrength: { value: 0.6 },
        uLift: { value: 0.1 },
        uGamma: { value: 0.8 },
        uVigStrength: { value: 0.5 },
        uVigScale: { value: 0.6 },
        uVigExponent: { value: 3 },
        iTime: { value: 0 },
        uLyricMain: { value: mainTex },
        uLyricSub: { value: subTex },
        uMainRect: { value: new THREE.Vector4(0, 0.64, 0.92, 0.24) },
        uSubRect: { value: new THREE.Vector4(0, 0.14, 0.62, 0.12) },
        uLyricOn: { value: 1 },
        uLyricGlitch: { value: 0.6 },
        uHasSub: { value: 0 },
        uLogoOn: { value: 1 },
        uLogoSize: { value: 1 },
        uStyleHue: { value: 0.85 },
        uStyleSeed: { value: 0 },
        uBeat: { value: 0 },
        uBass: { value: 0 },
        uAspect: { value: 1.78 }
      },
      vertexShader: GLITCH_QUAD_VS,
      fragmentShader: GLITCH_COMPOSITE_FS,
      depthTest: false,
      depthWrite: false
    });
    glitchState.geometry = geometry;
    glitchState.sourceMat = sourceMat;
    glitchState.blurMat = blurMat;
    glitchState.compositeMat = compositeMat;
    glitchState.mainCanvas = mainCanvas;
    glitchState.subCanvas = subCanvas;
    glitchState.mainTex = mainTex;
    glitchState.subTex = subTex;
    glitchState.mainKey = '';
    glitchState.subKey = '';
    glitchState.passes = {
      source: glitchMakePass(sourceMat, geometry),
      blur: glitchMakePass(blurMat, geometry),
      composite: glitchMakePass(compositeMat, geometry)
    };
    glitchState.built = true;
    glitchState.error = '';
    return true;
  } catch (err) {
    glitchState.error = String(err && (err.message || err)).slice(0, 200);
    return false;
  }
}

function glitchAlignPassSize() {
  if (typeof renderer === 'undefined' || !renderer || !glitchState.compositeMat) return false;
  if (!glitchState.size) glitchState.size = new THREE.Vector2();
  renderer.getDrawingBufferSize(glitchState.size);
  var w = Math.max(32, glitchState.size.x || 1);
  var h = Math.max(32, glitchState.size.y || 1);
  var ds = Math.max(1, Math.round(glitchParam('downsample')));
  var scale = glitchParam('renderScale');
  var lowW = Math.max(16, Math.round(w * scale / ds));
  var lowH = Math.max(16, Math.round(h * scale / ds));
  var bloomW = Math.max(8, Math.ceil(lowW / 2));
  var bloomH = Math.max(8, Math.ceil(lowH / 2));
  var sized = glitchState.lowRt && glitchState.lowW === lowW && glitchState.lowH === lowH
    && glitchState.bloomW === bloomW && glitchState.bloomH === bloomH;
  if (sized) return true;
  if (!glitchState.lowRt) {
    var opts = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    };
    glitchState.lowRt = new THREE.WebGLRenderTarget(lowW, lowH, opts);
    glitchState.bloomA = new THREE.WebGLRenderTarget(bloomW, bloomH, opts);
    glitchState.bloomB = new THREE.WebGLRenderTarget(bloomW, bloomH, opts);
  } else {
    glitchState.lowRt.setSize(lowW, lowH);
    glitchState.bloomA.setSize(bloomW, bloomH);
    glitchState.bloomB.setSize(bloomW, bloomH);
  }
  glitchState.lowW = lowW;
  glitchState.lowH = lowH;
  glitchState.bloomW = bloomW;
  glitchState.bloomH = bloomH;
  glitchState.sourceMat.uniforms.iResolution.value.set(lowW, lowH, 1);
  glitchState.compositeMat.uniforms.iResolution.value.set(w, h, 1);
  glitchState.compositeMat.uniforms.uAspect.value = w / h;
  glitchState.compositeMat.uniforms.uLowRes.value.set(lowW, lowH);
  glitchState.compositeMat.uniforms.iChannel0.value = glitchState.bloomB.texture;
  glitchState.compositeMat.uniforms.iChannel1.value = glitchState.lowRt.texture;
  return true;
}

function glitchApplyKnobs() {
  var s = glitchState.sourceMat && glitchState.sourceMat.uniforms;
  if (s) {
    s.uBlock.value = glitchParam('blockSize');
    s.uTearSpeed.value = glitchParam('tearSpeed');
    s.uScan.value = glitchParam('scanline');
    s.uGrain.value = glitchParam('grain');
    s.uHue.value = glitchParam('hue');
    s.uDrive.value = glitchParam('audioDrive');
  }
  var c = glitchState.compositeMat && glitchState.compositeMat.uniforms;
  if (c) {
    c.uDs.value = Math.max(1, Math.round(glitchParam('downsample')));
    c.uBloomOn.value = glitchParam('bloomOn') > 0 ? 1 : 0;
    c.uLift.value = glitchParam('lift');
    c.uGamma.value = glitchParam('gamma');
    c.uVigStrength.value = glitchParam('vignetteStrength');
    c.uVigScale.value = glitchParam('vignetteScale');
    c.uVigExponent.value = glitchParam('vignetteExponent');
  }
  var b = glitchState.blurMat && glitchState.blurMat.uniforms;
  if (b) b.uRadius.value = glitchParam('bloomRadius');
}

function glitchUpdateLayer(now, dt, sonicFrame) {
  if (!glitchPresetIsActive()) return false;
  if (!glitchState.built && !glitchBuildScene()) return false;
  glitchApplyKnobs();
  var clock = (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) ? Number(audio.currentTime) : 0;
  glitchState.sourceMat.uniforms.iTime.value = clock;
  glitchState.sourceMat.uniforms.iFrame.value = glitchState.frames | 0;
  glitchState.compositeMat.uniforms.iTime.value = clock;
  glitchFeedAudio(sonicFrame);
  glitchUpdateStyle(clock);
  glitchUpdateLyrics(clock);
  glitchState.frames++;
  void now;
  void dt;
  return true;
}

function glitchRenderFrame() {
  if (!glitchPresetIsActive()) return false;
  if (typeof renderer === 'undefined' || !renderer) return false;
  if (!glitchState.built && !glitchBuildScene()) return false;
  if (!glitchAlignPassSize()) return false;
  try {
    renderer.setRenderTarget(glitchState.lowRt);
    renderer.render(glitchState.passes.source.scene, glitchState.passes.source.camera);
    var blur = glitchState.blurMat;
    blur.uniforms.uTex.value = glitchState.lowRt.texture;
    blur.uniforms.uDir.value.set(1, 0);
    blur.uniforms.uTexel.value.set(1 / glitchState.lowW, 1 / glitchState.lowH);
    renderer.setRenderTarget(glitchState.bloomA);
    renderer.render(glitchState.passes.blur.scene, glitchState.passes.blur.camera);
    blur.uniforms.uTex.value = glitchState.bloomA.texture;
    blur.uniforms.uDir.value.set(0, 1);
    blur.uniforms.uTexel.value.set(1 / glitchState.bloomW, 1 / glitchState.bloomH);
    renderer.setRenderTarget(glitchState.bloomB);
    renderer.render(glitchState.passes.blur.scene, glitchState.passes.blur.camera);
    renderer.setRenderTarget(null);
    renderer.render(glitchState.passes.composite.scene, glitchState.passes.composite.camera);
    return true;
  } catch (err) {
    glitchState.error = String(err && (err.message || err)).slice(0, 200);
    renderer.setRenderTarget(null);
    return false;
  }
}

function glitchDisposeScene() {
  if (glitchState.lowRt) glitchState.lowRt.dispose();
  if (glitchState.bloomA) glitchState.bloomA.dispose();
  if (glitchState.bloomB) glitchState.bloomB.dispose();
  if (glitchState.sourceMat) glitchState.sourceMat.dispose();
  if (glitchState.blurMat) glitchState.blurMat.dispose();
  if (glitchState.compositeMat) glitchState.compositeMat.dispose();
  if (glitchState.geometry) glitchState.geometry.dispose();
  if (glitchState.mainTex) glitchState.mainTex.dispose();
  if (glitchState.subTex) glitchState.subTex.dispose();
  glitchState.built = false;
  glitchState.lowRt = null;
  glitchState.bloomA = null;
  glitchState.bloomB = null;
  glitchState.lowW = 0;
  glitchState.lowH = 0;
  glitchState.bloomW = 0;
  glitchState.bloomH = 0;
  glitchState.sourceMat = null;
  glitchState.blurMat = null;
  glitchState.compositeMat = null;
  glitchState.passes = null;
  glitchState.geometry = null;
  glitchState.mainCanvas = null;
  glitchState.subCanvas = null;
  glitchState.mainTex = null;
  glitchState.subTex = null;
  glitchState.mainKey = '';
  glitchState.subKey = '';
  glitchState.frames = 0;
}

function applyGlitchArtPresetNow(prev, next) {
  var on = Number(next) === GLITCH_PRESET_INDEX;
  var was = Number(prev) === GLITCH_PRESET_INDEX;
  if (on) {
    glitchBuildScene();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('glitch-art-preset');
  } else if (was) {
    glitchDisposeScene();
  }
  return on;
}

function glitchArtStatus() {
  return {
    active: glitchPresetIsActive(),
    built: glitchState.built,
    frames: glitchState.frames,
    error: glitchState.error,
    low: [glitchState.lowW, glitchState.lowH],
    bloom: [glitchState.bloomW, glitchState.bloomH],
    downsample: Math.round(glitchParam('downsample'))
  };
}

// The reference is a full-frame picture: no app particles, no lyric layer.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'glitch-art',
    isActive: glitchPresetIsActive,
    suppresses: {
      particles: true, bloom: true, float: true, backCover: true,
      starRiver: true, ripples: true, lyricsParticles: true, stageLyrics: true
    }
  });
}



