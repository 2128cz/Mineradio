'use strict';

// 预设 16「日本霓虹」(NEON FUJI).
//
// The scene reproduces the look of "Cyber Fuji 2020" by kaiware007
// (https://www.shadertoy.com/view/Wt33Wf, 2020-01-28), whose sun and grid functions are
// Copyright (c) Jan Mróz (jaszunio15), licensed CC BY 3.0. The GLSL here is written for this
// project against that reference - it is not a copy of the original source. Attribution travels
// with the build: see 21-neon-fuji-preset.LICENSE.txt, NOTICE.md and docs/THIRD_PARTY_PORTS.md.
//
// What this preset adds on top of the reference is the lyrics: each line is a neon car that drives
// in from the vanishing point - a bright core, a stretched afterimage behind it, and a sweeping
// light band underneath, all driven by the same beat the rest of the app reads.

var NEON_PRESET_INDEX = 16;

// Every knob is declared here; the console store (07-fx/14-neon-tuning.js) keeps defaults in this
// one place too, so a missing store simply means "everything at its declared default".
var NEON_TUNING_SCHEMA = {
  // ---- extracted from the reference shader. Defaults equal its literals, so leaving every knob
  // alone reproduces the original frame (the fidelity bench checks exactly that).
  battery: { def: 1.0, min: 0.2, max: 1.2, kind: 'ratio', rebuild: 'live' },
  horizon: { def: -0.2, min: -0.6, max: 0.1, kind: 'ratio', rebuild: 'live' },
  roadDepth: { def: 3.0, min: 1, max: 10, kind: 'ratio', rebuild: 'live' },
  roadSpread: { def: 1.0, min: 0.2, max: 3, kind: 'ratio', rebuild: 'live' },
  gridScale: { def: 0.01, min: 0.002, max: 0.05, kind: 'ratio', rebuild: 'live' },
  gridSpeed: { def: 4.0, min: 0, max: 12, kind: 'ratio', rebuild: 'live' },
  gridDensity: { def: 5.0, min: 1, max: 12, kind: 'ratio', rebuild: 'live' },
  gridBloom: { def: 0.4, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  sunX: { def: 0.75, min: -2, max: 2, kind: 'unit', rebuild: 'live' },
  sunY: { def: 0.2, min: -2, max: 2, kind: 'unit', rebuild: 'live' },
  sunRadius: { def: 0.3, min: 0.05, max: 0.6, kind: 'ratio', rebuild: 'live' },
  sunStripes: { def: 100, min: 10, max: 300, kind: 'count', rebuild: 'live' },
  sunBloom: { def: 0.7, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  fujiX: { def: -0.75, min: -2, max: 2, kind: 'unit', rebuild: 'live' },
  fujiY: { def: 0.5, min: -2, max: 2, kind: 'unit', rebuild: 'live' },
  fujiWidth: { def: 1.75, min: 0.5, max: 4, kind: 'unit', rebuild: 'live' },
  fujiBase: { def: 0.2, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  fujiHeight: { def: 0.5, min: 0.1, max: 2, kind: 'ratio', rebuild: 'live' },
  snowFreq: { def: 20, min: 0, max: 60, kind: 'count', rebuild: 'live' },
  snowSpeed: { def: 2, min: 0, max: 8, kind: 'ratio', rebuild: 'live' },
  snowAmp: { def: 0.05, min: 0, max: 0.2, kind: 'ratio', rebuild: 'live' },
  snowLevel: { def: 0.2, min: -0.5, max: 0.6, kind: 'ratio', rebuild: 'live' },
  cloudOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  cloudSpeed: { def: 0.1, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  cloudWidth: { def: 0.075, min: 0.02, max: 0.2, kind: 'ratio', rebuild: 'live' },
  fogGain: { def: 1.0, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  // ---- the palette: the reference's own colours, exposed so the look can be warmed or cooled
  // without touching the composition. sat 0 keeps the reference, 1 doubles it.
  paletteSat: { def: 0, min: -1, max: 1, kind: 'ratio', rebuild: 'live' },
  paletteWarm: { def: 0, min: -1, max: 1, kind: 'ratio', rebuild: 'live' },
  // ---- our camera (the reference has none; it sits still and looks down the road)
  camHeight: { def: 1.0, min: -2, max: 6, kind: 'unit', rebuild: 'live' },
  camFov: { def: 52, min: 25, max: 90, kind: 'deg', rebuild: 'live' },
  // ---- our addition: the lyric cars
  carSize: { def: 1.0, min: 0.2, max: 3, kind: 'ratio', rebuild: 'live' },
  carRideHeight: { def: -0.12, min: -0.4, max: 0.4, kind: 'ratio', rebuild: 'live' },
  trailLength: { def: 1.6, min: 0, max: 6, kind: 'ratio', rebuild: 'live' },
  trailOpacity: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  lightBand: { def: 0.7, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  carGlow: { def: 1.2, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  beatKick: { def: 0.5, min: 0, max: 2, kind: 'ratio', rebuild: 'live' }
};

// The reference's fixed palette, in the order the composition uses it.
var NEON_PALETTE = {
  sky: [0.0, 0.1, 0.2],
  grid: [1.0, 0.5, 1.0],
  sun: [1.0, 0.2, 1.0],
  sunWarm: [1.0, 0.4, 0.1],
  fujiDark: [0.0, 0.0, 0.25],
  fujiBright: [1.0, 0.0, 0.5],
  snow: [1.0, 0.5, 1.0],
  horizonNear: [1.0, 0.12, 0.8],
  horizonFar: [0.0, 0.0, 0.2],
  cloud: [0.0, 0.0, 0.2]
};

// Keeps the reference's own colour unless the two colour knobs move: saturation is a mix toward
// the grey of the same luminance, warmth is a shift along the red/blue axis.
function neonPaletteColor(target, rgb) {
  var sat = neonParam('paletteSat');
  var warm = neonParam('paletteWarm');
  if (!target) return;
  var r = rgb[0], g = rgb[1], b = rgb[2];
  if (sat) {
    var grey = (r * 0.299 + g * 0.587 + b * 0.114);
    r = grey + (r - grey) * (1 + sat);
    g = grey + (g - grey) * (1 + sat);
    b = grey + (b - grey) * (1 + sat);
  }
  if (warm) {
    r += warm * 0.10;
    b -= warm * 0.10;
  }
  target.setRGB(Math.min(1.5, Math.max(0, r)), Math.min(1.5, Math.max(0, g)), Math.min(1.5, Math.max(0, b)));
}

function neonParam(key) {
  var store = (typeof neonTuning !== 'undefined') ? neonTuning : null;
  if (store && store[key] !== undefined && store[key] !== null) return store[key];
  var spec = NEON_TUNING_SCHEMA[key];
  return spec ? spec.def : 0;
}

function neonPresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === NEON_PRESET_INDEX;
}

var NEON_FAR_Z = -90;
var NEON_NEAR_Z = -7;

var neonState = {
  built: false, group: null, quad: null, quadMat: null, bgScene: null, bgCamera: null,
  cars: [], frames: 0, error: '', lastCostMs: 0, camPrimed: false
};

// ---------------------------------------------------------------- the sky

// The fragment runs as a plain full-screen quad, so it is written in Shadertoy shape and wrapped by
// the driver that already ships here. Colours are mixed from three knobs instead of being fixed,
// because the reference's palette is the whole point of the look.
var NEON_SCENE_FS = [
  'uniform vec3 iResolution;',
  'uniform float iTime;',
  'uniform vec4 iMouse;',
  'uniform float uBattery;',
  'uniform float uHorizon;',
  'uniform float uRoadDepth;',
  'uniform float uRoadSpread;',
  'uniform float uGridScale;',
  'uniform float uGridSpeed;',
  'uniform float uGridDensity;',
  'uniform float uGridBloom;',
  'uniform vec3 uGridColor;',
  'uniform vec3 uSkyColor;',
  'uniform float uSunX;',
  'uniform float uSunY;',
  'uniform float uSunRadius;',
  'uniform float uSunStripes;',
  'uniform float uSunBloom;',
  'uniform vec3 uSunColor;',
  'uniform vec3 uSunWarm;',
  'uniform float uFujiX;',
  'uniform float uFujiY;',
  'uniform float uFujiWidth;',
  'uniform float uFujiBase;',
  'uniform float uFujiHeight;',
  'uniform vec3 uFujiDark;',
  'uniform vec3 uFujiBright;',
  'uniform vec3 uSnowColor;',
  'uniform float uSnowFreq;',
  'uniform float uSnowSpeed;',
  'uniform float uSnowAmp;',
  'uniform float uSnowLevel;',
  'uniform vec3 uHorizonNear;',
  'uniform vec3 uHorizonFar;',
  'uniform float uCloudOn;',
  'uniform float uCloudSpeed;',
  'uniform float uCloudWidth;',
  'uniform vec3 uCloudColor;',
  'uniform float uFogGain;',
  '',
  // ---- ported from the reference (see tests/fixtures/neon-fuji-reference.glsl).
  // The expressions are the reference's; only its literals became uniforms, so a default-valued
  // parameter set reproduces the original frame.
  'float sun(vec2 uv, float battery) {',
  '  float val = smoothstep(uSunRadius, uSunRadius - 0.01, length(uv));',
  '  float bloom = smoothstep(uSunBloom, 0.0, length(uv));',
  '  float cut = 3.0 * sin((uv.y + iTime * 0.2 * (battery + 0.02)) * uSunStripes)',
  '    + clamp(uv.y * 14.0 + 1.0, -6.0, 6.0);',
  '  cut = clamp(cut, 0.0, 1.0);',
  '  return clamp(val * cut, 0.0, 1.0) + bloom * 0.6;',
  '}',
  '',
  'float grid(vec2 uv, float battery) {',
  '  vec2 size = vec2(uv.y, uv.y * uv.y * 0.2) * uGridScale;',
  '  uv += vec2(0.0, iTime * uGridSpeed * (battery + 0.05));',
  '  uv = abs(fract(uv) - 0.5);',
  '  vec2 lines = smoothstep(size, vec2(0.0), uv);',
  '  lines += smoothstep(size * uGridDensity, vec2(0.0), uv) * uGridBloom * battery;',
  '  return clamp(lines.x + lines.y, 0.0, 3.0);',
  '}',
  '',
  'float dot2(in vec2 v) { return dot(v, v); }',
  '',
  'float sdTrapezoid(in vec2 p, in float r1, float r2, float he) {',
  '  vec2 k1 = vec2(r2, he);',
  '  vec2 k2 = vec2(r2 - r1, 2.0 * he);',
  '  p.x = abs(p.x);',
  '  vec2 ca = vec2(p.x - min(p.x, (p.y < 0.0) ? r1 : r2), abs(p.y) - he);',
  '  vec2 cb = p - k1 + k2 * clamp(dot(k1 - p, k2) / dot2(k2), 0.0, 1.0);',
  '  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;',
  '  return s * sqrt(min(dot2(ca), dot2(cb)));',
  '}',
  '',
  'float sdLine(in vec2 p, in vec2 a, in vec2 b) {',
  '  vec2 pa = p - a, ba = b - a;',
  '  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);',
  '  return length(pa - ba * h);',
  '}',
  '',
  'float sdBox(in vec2 p, in vec2 b) {',
  '  vec2 d = abs(p) - b;',
  '  return length(max(d, vec2(0))) + min(max(d.x, d.y), 0.0);',
  '}',
  '',
  'float opSmoothUnion(float d1, float d2, float k) {',
  '  float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);',
  '  return mix(d2, d1, h) - k * h * (1.0 - h);',
  '}',
  '',
  'float sdCloud(in vec2 p, in vec2 a1, in vec2 b1, in vec2 a2, in vec2 b2, float w) {',
  '  float lineVal1 = sdLine(p, a1, b1);',
  '  float lineVal2 = sdLine(p, a2, b2);',
  '  vec2 ww = vec2(w * 1.5, 0.0);',
  '  vec2 left = max(a1 + ww, a2 + ww);',
  '  vec2 right = min(b1 - ww, b2 - ww);',
  '  vec2 boxCenter = (left + right) * 0.5;',
  '  float boxH = abs(a2.y - a1.y) * 0.5;',
  '  float boxVal = sdBox(p - boxCenter, vec2(0.04, boxH)) + w;',
  '  float uniVal1 = opSmoothUnion(lineVal1, boxVal, 0.05);',
  '  float uniVal2 = opSmoothUnion(lineVal2, boxVal, 0.05);',
  '  return min(uniVal1, uniVal2);',
  '}',
  '',
  // The composition order is the picture: grid before the sky branch, the sun under the mountain,
  // the horizon tint added (not mixed), the clouds last, then the fog and the battery desaturation.
  'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
  '  vec2 uv = (2.0 * fragCoord.xy - iResolution.xy) / iResolution.y;',
  '  float battery = uBattery;',
  '  float fog = smoothstep(0.1, -0.02, abs(uv.y - uHorizon));',
  '  vec3 col = uSkyColor;',
  '  if (uv.y < uHorizon) {',
  '    uv.y = uRoadDepth / (abs(uv.y - uHorizon) + 0.05);',
  '    uv.x *= uv.y * uRoadSpread;',
  '    float gridVal = grid(uv, battery);',
  '    col = mix(col, uGridColor, gridVal);',
  '  } else {',
  '    float fujiD = min(uv.y * 4.5 - 0.5, 1.0);',
  '    uv.y -= battery * 1.1 - 0.51;',
  '    vec2 sunUV = uv + vec2(uSunX, uSunY);',
  '    col = uSunColor;',
  '    float sunVal = sun(sunUV, battery);',
  '    col = mix(col, uSunWarm, sunUV.y * 2.0 + 0.2);',
  '    col = mix(vec3(0.0, 0.0, 0.0), col, sunVal);',
  '    float fujiVal = sdTrapezoid(uv + vec2(uFujiX, uFujiY), uFujiWidth + pow(uv.y * uv.y, 2.1), uFujiBase, uFujiHeight);',
  '    float waveVal = uv.y + sin(uv.x * uSnowFreq + iTime * uSnowSpeed) * uSnowAmp + uSnowLevel;',
  '    float wave_width = smoothstep(0.0, 0.01, waveVal);',
  '    col = mix(col, mix(uFujiDark, uFujiBright, fujiD), step(fujiVal, 0.0));',
  '    col = mix(col, uSnowColor, wave_width * step(fujiVal, 0.0));',
  '    col = mix(col, uSnowColor, 1.0 - smoothstep(0.0, 0.01, abs(fujiVal)));',
  '    col += mix(col, mix(uHorizonNear, uHorizonFar, clamp(uv.y * 3.5 + 3.0, 0.0, 1.0)), step(0.0, fujiVal));',
  '    if (uCloudOn > 0.5) {',
  '      vec2 cloudUV = uv;',
  '      cloudUV.x = mod(cloudUV.x + iTime * uCloudSpeed, 4.0) - 2.0;',
  '      float cloudTime = iTime * 0.5;',
  '      float cloudY = -0.5;',
  '      float cloudVal1 = sdCloud(cloudUV, vec2(0.1 + sin(cloudTime + 140.5) * 0.1, cloudY), vec2(1.05 + cos(cloudTime * 0.9 - 36.56) * 0.1, cloudY), vec2(0.2 + cos(cloudTime * 0.867 + 387.165) * 0.1, 0.25 + cloudY), vec2(0.5 + cos(cloudTime * 0.9675 - 15.162) * 0.09, 0.25 + cloudY), uCloudWidth);',
  '      cloudY = -0.6;',
  '      float cloudVal2 = sdCloud(cloudUV, vec2(-0.9 + cos(cloudTime * 1.02 + 541.75) * 0.1, cloudY), vec2(-0.5 + sin(cloudTime * 0.9 - 316.56) * 0.1, cloudY), vec2(-1.5 + cos(cloudTime * 0.867 + 37.165) * 0.1, 0.25 + cloudY), vec2(-0.6 + sin(cloudTime * 0.9675 + 665.162) * 0.09, 0.25 + cloudY), uCloudWidth);',
  '      float cloudVal = min(cloudVal1, cloudVal2);',
  '      col = mix(col, uCloudColor, 1.0 - smoothstep(uCloudWidth - 0.0001, uCloudWidth, cloudVal));',
  '      col += vec3(1.0, 1.0, 1.0) * (1.0 - smoothstep(0.0, 0.01, abs(cloudVal - uCloudWidth)));',
  '    }',
  '  }',
  '  col += fog * fog * fog * uFogGain;',
  '  col = mix(vec3(col.r, col.r, col.r) * 0.5, col, battery * 0.7);',
  '  fragColor = vec4(col, 1.0);',
  '}',
  'void main() { vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy); gl_FragColor = c; }'
].join('\n');


function neonBuildScene() {
  if (neonState.built) return true;
  if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene) return false;
  try {
    var group = new THREE.Group();
    group.name = 'neon-fuji';
    var geo = new THREE.PlaneGeometry(2, 2);
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        iResolution: shadertoyUvUniforms(1, 1),
        iTime: { value: 0 },
        iMouse: { value: [0, 0, 0, 0] },
        uBattery: { value: 0 },
        uHorizon: { value: 0 },
        uRoadDepth: { value: 0 },
        uRoadSpread: { value: 0 },
        uGridScale: { value: 0 },
        uGridSpeed: { value: 0 },
        uGridDensity: { value: 0 },
        uGridBloom: { value: 0 },
        uGridColor: { value: new THREE.Color() },
        uSkyColor: { value: new THREE.Color() },
        uSunX: { value: 0 },
        uSunY: { value: 0 },
        uSunRadius: { value: 0 },
        uSunStripes: { value: 0 },
        uSunBloom: { value: 0 },
        uSunColor: { value: new THREE.Color() },
        uSunWarm: { value: new THREE.Color() },
        uFujiX: { value: 0 },
        uFujiY: { value: 0 },
        uFujiWidth: { value: 0 },
        uFujiBase: { value: 0 },
        uFujiHeight: { value: 0 },
        uFujiDark: { value: new THREE.Color() },
        uFujiBright: { value: new THREE.Color() },
        uSnowColor: { value: new THREE.Color() },
        uSnowFreq: { value: 0 },
        uSnowSpeed: { value: 0 },
        uSnowAmp: { value: 0 },
        uSnowLevel: { value: 0 },
        uHorizonNear: { value: new THREE.Color() },
        uHorizonFar: { value: new THREE.Color() },
        uCloudOn: { value: 0 },
        uCloudSpeed: { value: 0 },
        uCloudWidth: { value: 0 },
        uCloudColor: { value: new THREE.Color() },
        uFogGain: { value: 0 },
        uBeat: { value: 0 },
      },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.999999, 1.0); }',
      fragmentShader: NEON_SCENE_FS,
      depthTest: false,
      depthWrite: false
    });
    // Drawn first, at the far plane: it ignores the camera's projection entirely (the vertex stage
    // writes clip space), so the sky is stable whatever the camera does.
    var quad = new THREE.Mesh(geo, mat);
    quad.frustumCulled = false;
    quad.renderOrder = -100;
    group.add(quad);
    scene.add(group);
    neonState.group = group;
    neonState.quad = quad;
    neonState.quadMat = mat;
    neonState.built = true;
    return true;
  } catch (err) {
    neonState.error = String(err && (err.message || err)).slice(0, 200);
    return false;
  }
}

// ---------------------------------------------------------------- the cars

// One canvas per active line. Rebuilt only when the line changes, because a canvas upload is the
// one budgeted resource in this renderer (one new texture per frame, at most).
function neonLineText(line) {
  if (!line) return '';
  return String(line.text || line.content || line.textContent || '');
}

function neonActiveLines() {
  var lines = (typeof lyricsLines !== 'undefined' && lyricsLines) ? lyricsLines : null;
  if (!lines || !lines.length) return [];
  var t = (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
  var idx = 0;
  for (var i = 0; i < lines.length; i++) {
    var at = Number(lines[i] && (lines[i].time != null ? lines[i].time : lines[i].t));
    if (isFinite(at) && at <= t + 0.02) idx = i; else break;
  }
  var out = [];
  for (var k = 0; k < 2; k++) {
    var line = lines[idx + k];
    if (!line) continue;
    var next = lines[idx + k + 1];
    var start = Number(line && (line.time != null ? line.time : line.t));
    var end = next ? Number(next.time != null ? next.time : next.t) : start + 4;
    if (!isFinite(start)) start = t;
    if (!isFinite(end) || end <= start) end = start + 4;
    out.push({ text: neonLineText(line), start: start, end: end, current: k === 0 });
  }
  return out;
}

function neonCssColor(r, g, b, a) {
  return 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + a + ')';
}

// The palette is read from the app's lyric colours so this preset does not invent a second colour
// scheme for text; the glow is a brighter copy of the same hue.
function neonLyricPalette() {
  var palette = { main: '#ffd7f4', glow: '#ff4fd8' };
  try {
    if (typeof lyricPalette === 'function') {
      var p = lyricPalette();
      if (p && p.primary) palette.main = p.primary;
      if (p && p.highlight) palette.glow = p.highlight;
    }
  } catch (e) { /* the palette helper is optional */ }
  return palette;
}

function neonMakeCar() {
  var group = new THREE.Group();
  var canvas = document.createElement('canvas');
  canvas.width = 8; canvas.height = 8;
  var tex = new THREE.CanvasTexture(canvas);
  if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  var bodyMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending
  });
  var body = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bodyMat);
  body.frustumCulled = false;
  var trailMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending
  });
  var trail = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), trailMat);
  trail.frustumCulled = false;
  // The band under the car: a wide, faint plane that reads as the light the car drags over the road.
  var bandMat = new THREE.MeshBasicMaterial({
    color: 0xff4fd8, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending
  });
  var band = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bandMat);
  band.frustumCulled = false;
  group.add(trail);
  group.add(band);
  group.add(body);
  neonState.group.add(group);
  return {
    group: group, canvas: canvas, texture: tex, body: body, bodyMat: bodyMat,
    trail: trail, trailMat: trailMat, band: band, bandMat: bandMat,
    text: '', aspect: 4, width: 1, height: 0.25
  };
}

function neonRasterCar(car, text) {
  if (!car || car.text === text) return;
  car.text = text;
  var pal = neonLyricPalette();
  var px = 72;
  var canvas = car.canvas;
  var ctx = canvas.getContext('2d');
  var font = '600 ' + px + 'px "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
  ctx.font = font;
  var width = Math.max(64, Math.ceil(ctx.measureText(text || ' ').width + px * 0.6));
  var height = Math.ceil(px * 1.5);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d');
  }
  ctx.clearRect(0, 0, width, height);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = px * 0.55;
  ctx.fillStyle = pal.glow;
  ctx.fillText(text || '', width / 2, height / 2);
  ctx.shadowBlur = px * 0.18;
  ctx.fillStyle = pal.main;
  ctx.fillText(text || '', width / 2, height / 2);
  car.texture.needsUpdate = true;
  car.aspect = width / height;
}

function neonDisposeScene() {
  if (!neonState.group) return;
  neonState.cars.forEach(function (car) {
    if (car.texture) car.texture.dispose();
    [car.body, car.trail, car.band].forEach(function (mesh) {
      if (mesh && mesh.geometry) mesh.geometry.dispose();
      if (mesh && mesh.material) mesh.material.dispose();
    });
  });
  neonState.cars = [];
  if (neonState.quad) {
    if (neonState.quad.geometry) neonState.quad.geometry.dispose();
    if (neonState.quadMat) neonState.quadMat.dispose();
  }
  neonState.quad = null;
  neonState.quadMat = null;
  if (typeof scene !== 'undefined' && scene) scene.remove(neonState.group);
  neonState.group = null;
  neonState.built = false;
  neonState.camPrimed = false;
}

// ---------------------------------------------------------------- the frame

// One place that maps every knob onto its uniform; a default set reproduces the reference frame.
function neonFeedUniforms(u, nowSec) {
  if (!u) return;
  u.iTime.value = nowSec;
  u.uBattery.value = neonParam('battery');
  u.uHorizon.value = neonParam('horizon');
  u.uRoadDepth.value = neonParam('roadDepth');
  u.uRoadSpread.value = neonParam('roadSpread');
  u.uGridScale.value = neonParam('gridScale');
  u.uGridSpeed.value = neonParam('gridSpeed');
  u.uGridDensity.value = neonParam('gridDensity');
  u.uGridBloom.value = neonParam('gridBloom');
  u.uSunX.value = neonParam('sunX');
  u.uSunY.value = neonParam('sunY');
  u.uSunRadius.value = neonParam('sunRadius');
  u.uSunStripes.value = neonParam('sunStripes');
  u.uSunBloom.value = neonParam('sunBloom');
  u.uFujiX.value = neonParam('fujiX');
  u.uFujiY.value = neonParam('fujiY');
  u.uFujiWidth.value = neonParam('fujiWidth');
  u.uFujiBase.value = neonParam('fujiBase');
  u.uFujiHeight.value = neonParam('fujiHeight');
  u.uSnowFreq.value = neonParam('snowFreq');
  u.uSnowSpeed.value = neonParam('snowSpeed');
  u.uSnowAmp.value = neonParam('snowAmp');
  u.uSnowLevel.value = neonParam('snowLevel');
  u.uCloudOn.value = neonParam('cloudOn');
  u.uCloudSpeed.value = neonParam('cloudSpeed');
  u.uCloudWidth.value = neonParam('cloudWidth');
  u.uFogGain.value = neonParam('fogGain');
  neonPaletteColor(u.uSkyColor.value, NEON_PALETTE.sky);
  neonPaletteColor(u.uGridColor.value, NEON_PALETTE.grid);
  neonPaletteColor(u.uSunColor.value, NEON_PALETTE.sun);
  neonPaletteColor(u.uSunWarm.value, NEON_PALETTE.sunWarm);
  neonPaletteColor(u.uFujiDark.value, NEON_PALETTE.fujiDark);
  neonPaletteColor(u.uFujiBright.value, NEON_PALETTE.fujiBright);
  neonPaletteColor(u.uSnowColor.value, NEON_PALETTE.snow);
  neonPaletteColor(u.uHorizonNear.value, NEON_PALETTE.horizonNear);
  neonPaletteColor(u.uHorizonFar.value, NEON_PALETTE.horizonFar);
  neonPaletteColor(u.uCloudColor.value, NEON_PALETTE.cloud);
}

function neonUpdateCamera() {
  if (typeof camera === 'undefined' || !camera) return;
  if (typeof freeCamera !== 'undefined' && freeCamera && (freeCamera.active || freeCamera.resetTween)) return;
  var fov = neonParam('camFov');
  if (Math.abs(camera.fov - fov) > 1e-4) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  // The road's vanishing point is the origin; the eye sits a little above it and looks slightly down.
  camera.position.set(0, neonParam('camHeight'), 6);
  if (camera.lookAt) camera.lookAt(0, -0.15, -10);
}

function neonStepCars(nowSec, dt) {
  var lines = neonActiveLines();
  while (neonState.cars.length < lines.length) neonState.cars.push(neonMakeCar());
  while (neonState.cars.length > lines.length) {
    var extra = neonState.cars.pop();
    if (extra.texture) extra.texture.dispose();
    neonState.group.remove(extra.group);
  }
  var beat = (typeof beatPulse !== 'undefined' && isFinite(beatPulse)) ? Number(beatPulse) : 0;
  var kick = (typeof smoothBass !== 'undefined' && isFinite(smoothBass)) ? Number(smoothBass) : 0;
  var boost = 1 + neonParam('beatKick') * (beat * 0.6 + kick * 0.4);
  for (var i = 0; i < lines.length; i++) {
    var car = neonState.cars[i];
    var line = lines[i];
    neonRasterCar(car, line.text);
    // 0 at the line's start (far away), 1 when it ends (passing the lens). The car is on the road
    // the whole time, so its depth is what moves - not its screen position.
    var span = Math.max(0.2, line.end - line.start);
    var t = neonClamp01((nowSec - line.start) / span);
    var z = NEON_FAR_Z + (NEON_NEAR_Z - NEON_FAR_Z) * t;
    var size = neonParam('carSize') * (line.current ? 1 : 0.72);
    var height = Math.max(0.05, size * 0.55);
    var width = height * Math.max(1, car.aspect);
    var ride = neonParam('carRideHeight');
    car.group.visible = true;
    car.group.position.set(0, ride, z);
    car.body.scale.set(width, height, 1);
    car.bodyMat.opacity = 0.55 + 0.45 * (line.current ? 1 : 0.6);
    // The afterimage sits behind the car on the road and fades with distance from it.
    var trailLen = neonParam('trailLength') * Math.max(0.3, size);
    car.trail.position.set(0, 0, -trailLen);
    car.trail.scale.set(width * 0.9, height * 0.55, 1);
    car.trailMat.opacity = neonClamp01(neonParam('trailOpacity') * (0.4 + 0.6 * t));
    // The light band: a wide, thin glow under the car that flashes on the beat.
    car.band.position.set(0, -height * 0.62, 0);
    car.band.scale.set(width * 1.5, Math.max(0.02, height * 0.13), 1);
    car.bandMat.opacity = neonClamp01(neonParam('lightBand') * (0.25 + 0.75 * beat) * boost);
    car.bandMat.color.setRGB(1.0, 0.35, 0.85);
  }
  return boost;
}

function neonClamp01(v) {
  var n = Number(v);
  return !isFinite(n) ? 0 : Math.min(1, Math.max(0, n));
}

function updateNeonLayer(now, dt) {
  if (!neonPresetIsActive()) return false;
  var startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  if (!neonState.built && !neonBuildScene()) return false;
  // The pose is written here rather than in the loop's camera section: this preset owns the lens
  // while it is active, and the write still happens before the frame is rendered.
  neonUpdateCamera();
  var step = Math.max(0, Math.min(0.1, Number(dt) || 0));
  var mat = neonState.quadMat;
  if (mat) {
    neonFeedUniforms(mat.uniforms, (Number(now) || 0) / 1000);
    if (typeof renderer !== 'undefined' && renderer && renderer.domElement) {
      // The drawing buffer is already in device pixels; r128's getDrawingBufferSize wants a
      // Vector2 and throws on a plain object, which is what an earlier version did every frame.
      var el = renderer.domElement;
      mat.uniforms.iResolution.value = shadertoyUvUniforms(Math.max(1, el.width), Math.max(1, el.height)).value;
    }
  }
  var boost = neonStepCars((Number(now) || 0) / 1000, step);
  if (mat) mat.uniforms.uBeat.value = neonClamp01(boost - 1);
  neonState.frames++;
  neonState.lastCostMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - startedAt;
  return true;
}

function applyNeonPresetNow(prev, next) {
  var on = Number(next) === NEON_PRESET_INDEX;
  var was = Number(prev) === NEON_PRESET_INDEX;
  if (on) {
    neonBuildScene();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('neon-preset');
  } else if (was) {
    neonDisposeScene();
  }
  return on;
}

function neonStatus() {
  return {
    active: neonPresetIsActive(), built: neonState.built, frames: neonState.frames,
    costMs: Math.round(neonState.lastCostMs * 100) / 100, error: neonState.error,
    cars: neonState.cars.length, camera: (typeof camera !== 'undefined' && camera) ? Math.round(camera.fov) : null,
    group: neonState.group ? neonState.group.children.length : 0
  };
}

// The sky is the whole picture here: the cover field, bloom, the floating layer, the back cover,
// the star river, the ripples and the small lyric particles are all taken over rather than left
// behind the road. The stage lyric rows are taken over too - this preset draws its own lines.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'neon-layer',
    isActive: neonPresetIsActive,
    suppresses: {
      particles: true, bloom: true, float: true, backCover: true,
      starRiver: true, ripples: true, lyricsParticles: true, stageLyrics: true
    }
  });
}
