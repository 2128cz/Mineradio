'use strict';

// 预设 16「日本霓虹」(NEON FUJI).
//
// The scene is a port of "Cyber Fuji 2020" by kaiware007
// (https://www.shadertoy.com/view/Wt33Wf, 2020-01-28), whose sun and grid functions are
// Copyright (c) Jan Mróz (jaszunio15), licensed CC BY 3.0. Its functions and composition order
// are kept; its literals are the defaults of the knobs in NEON_TUNING_SCHEMA, and the pixel bench
// (scripts/neon-fidelity-bench.js) checks the result against the reference fixture. Attribution
// travels with the build: see 21-neon-fuji-preset.LICENSE.txt, NOTICE.md and
// docs/THIRD_PARTY_PORTS.md.
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
  roadDepth: { def: 1, min: 1, max: 10, kind: 'ratio', rebuild: 'live' },
  roadSpread: { def: 0.86, min: 0.2, max: 3, kind: 'ratio', rebuild: 'live' },
  gridScale: { def: 0.006, min: 0.002, max: 0.05, kind: 'ratio', rebuild: 'live' },
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
  camFov: { def: 52, min: 25, max: 90, kind: 'deg', rebuild: 'live' },
  camShake: { def: 0.6, min: 0, max: 2, kind: 'unit', rebuild: 'live' },
  camShakeRate: { def: 1.0, min: 0.1, max: 4, kind: 'ratio', rebuild: 'live' },
  // ---- our addition: the lyric cars. A line enters on a beat, rides from the horizon through
  // the lens, and leaves the frame only once it is too big to read - it never slides off the
  // bottom. carSize is the size at the line's own timestamp.
  carSize: { def: 0.10, min: 0.02, max: 0.4, kind: 'ratio', rebuild: 'live' },
  carDepthNear: { def: 18, min: 1, max: 40, kind: 'unit', rebuild: 'live' },
  carDepthFar: { def: 90, min: 20, max: 400, kind: 'unit', rebuild: 'live' },
  // Negative = the readable pass sits that many seconds after the line starts, so a line sung for
  // a while is already in the middle of the screen half way through; positive = before its line.
  carLead: { def: -1.0, min: -3, max: 6, kind: 'sec', rebuild: 'live' },
  carApproach: { def: 2.4, min: 0.4, max: 6, kind: 'sec', rebuild: 'live' },
  carDrop: { def: 0.13, min: -0.6, max: 0.6, kind: 'ratio', rebuild: 'live' },
  carAccel: { def: 0.9, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  carRise: { def: 0.9, min: 0, max: 3, kind: 'unit', rebuild: 'live' },
  carExitSize: { def: 0.9, min: 0.4, max: 3, kind: 'ratio', rebuild: 'live' },
  carFadeTravel: { def: 0.55, min: 0.1, max: 2, kind: 'unit', rebuild: 'live' },
  beatSync: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  trailCount: { def: 24, min: 0, max: 48, kind: 'count', rebuild: 'live' },
  trailInterval: { def: 0.03, min: 0.02, max: 0.4, kind: 'sec', rebuild: 'live' },
  trailLife: { def: 0.95, min: 0.1, max: 2, kind: 'sec', rebuild: 'live' },
  trailOpacity: { def: 0.13, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  lightBand: { def: 1.23, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  beatKick: { def: 2, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  // ---- the beat's own shape, all live: how far the pulse is allowed to go, how fast it arrives
  // and leaves, and how much of it the scene behind the text takes.
  beatScale: { def: 0.12, min: 0, max: 0.6, kind: 'unit', rebuild: 'live' },
  beatGlow: { def: 0.45, min: 0, max: 1.5, kind: 'unit', rebuild: 'live' },
  beatAttack: { def: 22, min: 4, max: 60, kind: 'count', rebuild: 'live' },
  beatRelease: { def: 7, min: 1, max: 30, kind: 'count', rebuild: 'live' },
  beatScene: { def: 1.0, min: 0, max: 2, kind: 'ratio', rebuild: 'live' }
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
  // The beat reaches the scene itself: the neon lines, the sun's bloom, the horizon haze and the
  // cloud outlines all lift on it. Zero is the untouched reference frame (the bench renders it so).
  'uniform float uBeat;',
  'uniform vec2 uShake;',
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
  '  return clamp(val * cut, 0.0, 1.0) + bloom * 0.6 * (1.0 + uBeat * 0.5);',
  '}',
  '',
  'float grid(vec2 uv, float battery) {',
  '  vec2 size = vec2(uv.y, uv.y * uv.y * 0.2) * uGridScale;',
  '  uv += vec2(0.0, iTime * uGridSpeed * (battery + 0.05));',
  '  uv = abs(fract(uv) - 0.5);',
  '  vec2 lines = smoothstep(size, vec2(0.0), uv);',
  '  lines += smoothstep(size * uGridDensity, vec2(0.0), uv) * uGridBloom * battery;',
  '  return clamp(lines.x + lines.y, 0.0, 3.0) * (1.0 + uBeat * 0.45);',
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
  '  uv += uShake;',
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
  '    col = mix(col, mix(uFujiDark * (1.0 + uBeat * 0.3), uFujiBright * (1.0 + uBeat * 0.25), fujiD), step(fujiVal, 0.0));',
  '    col = mix(col, uSnowColor * (1.0 + uBeat * 0.4), wave_width * step(fujiVal, 0.0));',
  '    col = mix(col, uSnowColor * (1.0 + uBeat * 0.4), 1.0 - smoothstep(0.0, 0.01, abs(fujiVal)));',
  '    col += mix(col, mix(uHorizonNear, uHorizonFar, clamp(uv.y * 3.5 + 3.0, 0.0, 1.0)), step(0.0, fujiVal)) * (1.0 + uBeat * 0.25);',
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
  '      col += vec3(1.0, 1.0, 1.0) * (1.0 - smoothstep(0.0, 0.01, abs(cloudVal - uCloudWidth))) * (1.0 + uBeat * 0.6);',
  '    }',
  '  }',
  '  col += fog * fog * fog * uFogGain * (1.0 + uBeat * 0.3);',
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
        uShake: { value: new THREE.Vector2(0, 0) },
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

// The beat grid, taken in the same order of trust the ring uses: the map's own grid step, then
// the realtime tempo tracker. A zero step means nothing knows, and the timing falls back to the
// pure timeline.
function neonBeatGrid() {
  var map = (typeof currentBeatMap !== 'undefined' && currentBeatMap) ? currentBeatMap : null;
  if (map) {
    var step = Number(map.gridStep) || 0;
    var list = Array.isArray(map.beats) ? map.beats : null;
    var first = list && list.length ? list[0] : null;
    var origin = first == null ? NaN : Number(first.t != null ? first.t : first.time);
    if (step > 0.15 && step <= 2 && isFinite(origin)) return { step: step, origin: origin, source: 'beat map' };
  }
  var rt = (typeof rtBeat !== 'undefined' && rtBeat) ? Number(rtBeat.tempoGap) || 0 : 0;
  if (rt > 0.15 && rt <= 2) return { step: rt, origin: Number(rtBeat.lastHitAt) || 0, source: 'realtime' };
  return { step: 0, origin: 0, source: 'no tempo' };
}

// When this line starts its run at the horizon: carLead seconds before it is sung, snapped back
// onto the beat when a grid is known, so the text enters with the music instead of between beats.
function neonEntranceAt(startAt, lead, grid) {
  var enterAt = startAt - Math.max(0.25, lead);
  if (grid && grid.step > 0 && isFinite(grid.origin)) {
    var snapped = grid.origin + Math.floor((enterAt - grid.origin) / grid.step) * grid.step;
    if (snapped <= enterAt + 1e-6) enterAt = snapped;
  }
  // Never later than a third of a second before the line, or the arrival would miss its clock.
  return Math.min(enterAt, startAt - 0.35);
}

// The travel parameter at which a line has grown to `size` screen heights: size is carSize · near/d,
// so this inverts the same exponential the placement uses.
function neonSizeTravel(size) {
  var near = Math.max(0.5, neonParam('carDepthNear'));
  var far = Math.max(near * 1.2, neonParam('carDepthFar'));
  var ratio = far / near;
  var base = Math.max(0.01, neonParam('carSize'));
  return 1 + Math.log(Math.max(base * 1.001, size) / base) / Math.log(ratio);
}

// Where the text starts dimming: by the time it is this big the line is past the eye, and both its
// brightness and its opacity fall from here. It keeps moving the whole time - the frame is left by
// the glyphs sweeping overhead, not by them being cut off.
function neonFadeTravel() {
  return neonSizeTravel(neonParam('carExitSize'));
}

// End of life: the fade has finished and the line is recycled. The extra travel is what gives the
// afterimage stamps behind it room to live out their own life instead of vanishing with the text.
function neonExitTravel() {
  return neonFadeTravel() + Math.max(0.05, neonParam('carFadeTravel'));
}

function neonLineClock(line) {
  return Number(line && (line.time != null ? line.time : line.t));
}

// Every line whose travel window contains the current moment: the previous one still leaving the
// lens, the sung one, and the next one already on the road. Each carries its own t, so the window
// is decided by the clock and not by "how many rows the layout happens to show".
function neonActiveLines() {
  var lines = (typeof lyricsLines !== 'undefined' && lyricsLines) ? lyricsLines : null;
  if (!lines || !lines.length) return [];
  var now = (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
  var arrivalOffset = neonParam('carLead');
  var approach = Math.max(0.4, neonParam('carApproach'));
  var accel = 1 + Math.max(0, neonParam('carAccel'));
  var grid = neonParam('beatSync') > 0 ? neonBeatGrid() : { step: 0, origin: 0, source: 'sync off' };
  var exitT = neonExitTravel();
  var faceT = neonFadeTravel();
  var idx = 0;
  for (var i = 0; i < lines.length; i++) {
    var at = neonLineClock(lines[i]);
    if (isFinite(at) && at <= now + 0.02) idx = i; else break;
  }
  var out = [];
  // A fast song advances several lines while one line is still flying at the camera, so the window
  // cannot be "previous, current, next" by index: anything still inside its own travel window gets
  // a car, and the oldest are dropped only past the live cap.
  var candidates = [];
  for (var back = 0; back < 9; back++) {
    if (idx - back < 0) break;
    candidates.push(idx - back);
  }
  for (var fwd = 1; fwd <= 2; fwd++) {
    if (idx + fwd >= lines.length) break;
    candidates.push(idx + fwd);
  }
  for (var ci = 0; ci < candidates.length; ci++) {
    var k = candidates[ci] - idx;
    var line = lines[candidates[ci]];
    if (!line) continue;
    var start = neonLineClock(line);
    if (!isFinite(start)) continue;
    var next = lines[candidates[ci] + 1];
    var nextStart = next ? neonLineClock(next) : NaN;
    // The sung span is the line's own duration when the parser gave one; otherwise it runs until
    // the next line. This is the "line is over" moment the run is aimed at.
    var span = Number(line.duration) > 0.15 ? Number(line.duration)
      : (isFinite(nextStart) && nextStart > start ? nextStart - start : 4);
    var end = start + Math.max(0.6, span);
    // The readable pass: t=1 when the text is carLead seconds before the line start; a negative
    // lead puts it that many seconds AFTER the start, so the usual setting lands the middle of a
    // sung line in the middle of the screen. A short line gets its pass at its own end at the
    // latest - otherwise an offset longer than the line would put the face moment before arrival.
    var arrivalAt = Math.min(start - arrivalOffset, end - 0.15);
    var enterAt = neonEntranceAt(arrivalAt, approach, grid);
    var dur = Math.max(0.35, arrivalAt - enterAt);
    var p = (now - enterAt) / dur;
    var t;
    if (p <= 1) {
      // The approach accelerates: p is the share of the lead and the travel is its power, so the
      // line hangs far away and then whips in.
      t = p > 0 ? Math.pow(p, accel) : p;
    } else {
      // After the readable pass the run is aimed at the end of the line: at line end it reaches the
      // face (carExitSize), which is the moment only the middle of the glyphs still fits the frame.
      var q = (now - arrivalAt) / Math.max(0.25, end - arrivalAt);
      t = 1 + (faceT - 1) * Math.pow(q, accel);
    }
    if (!(t > 0) || t >= exitT) continue;
    out.push({
      key: 'l' + start.toFixed(3), text: neonLineText(line), start: start, end: end,
      enterAt: enterAt, arrivalAt: arrivalAt, travel: t, current: k === 0
    });
  }
  // Oldest first, so the cars are created and aged in a stable order; keep the newest ones when a
  // very dense passage would otherwise open more than the cap.
  out.sort(function (a, b) { return a.start - b.start; });
  if (out.length > 8) out = out.slice(out.length - 8);
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

var NEON_TRAIL_MAX = 48;

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
  // The afterimage is a pool of frozen projections: each one is stamped where the line was when
  // it was spawned, stays there, fades, and goes back to the pool. It is not a copy that keeps
  // following the car - that version collapsed into a pile at the end of the road.
  var trails = [];
  for (var i = 0; i < NEON_TRAIL_MAX; i++) {
    var mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
      blending: THREE.AdditiveBlending
    });
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    group.add(mesh);
    trails.push({ mesh: mesh, mat: mat, bornAt: -1 });
  }
  var bandMat = new THREE.MeshBasicMaterial({
    color: 0xff4fd8, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending
  });
  var band = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bandMat);
  band.frustumCulled = false;
  group.add(band);
  group.add(body);
  neonState.group.add(group);
  return {
    group: group, canvas: canvas, texture: tex, body: body, bodyMat: bodyMat,
    trails: trails, band: band, bandMat: bandMat, text: '', aspect: 4,
    key: '', trailClock: 0, lastTravel: -1
  };
}

function neonRasterCar(car, text) {
  if (!car || car.text === text) return;
  car.text = text;
  // The texture is shared by the whole pool, so a snapshot of the old line cannot survive the
  // new text; retire it now rather than let it change words mid-flight.
  neonRetireTrails(car);
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

// One point of the run, in screen terms. The virtual distance is exponential in t, so t = 0 is
// carDepthFar away and t = 1 is carDepthNear; past 1 the line keeps coming and its screen size is
// carSize * near/depth, which is what makes it grow past the frame. The height on screen only
// drops carDrop, and only until arrival - the text flies past the eye, it does not slide off the
// bottom of the frame.
function neonPlaceCar(car, t, opacityScale, pulse) {
  var fov = Math.min(100, Math.max(20, neonParam('camFov')));
  var tanHalf = Math.tan(fov * Math.PI / 360);
  var near = Math.max(0.5, neonParam('carDepthNear'));
  var far = Math.max(near * 1.2, neonParam('carDepthFar'));
  var ratio = far / near;
  var tt = Math.max(0.0005, t);
  var d = Math.max(near * 0.02, near * Math.pow(ratio, 1 - tt));
  var size = neonParam('carSize') * (near / d);
  var horizon = neonParam('horizon');
  // The drop stops at arrival; after that the run lifts, so the glyphs sweep up over the camera
  // rather than sliding off the bottom of the frame.
  var after = Math.max(0, tt - 1);
  var yNdc = horizon - neonParam('carDrop') * Math.min(1, tt) + neonParam('carRise') * after * after;
  // The beat's punch: the line does not move, the glyphs swell in place and their neon brightens
  // for the length of the pulse. Both amounts are knobs.
  var pv = Math.max(0, Number(pulse) || 0);
  var worldH = Math.max(0.0001, size * 2 * d * tanHalf) * (1 + pv * Math.max(0, neonParam('beatScale')));
  var worldW = worldH * Math.max(1, car.aspect);
  var yWorld = yNdc * d * tanHalf;
  // Fades: in over the first tenth of the run, out from carExitSize over carFadeTravel. The fade
  // dims the glyphs as well as dissolving them - a huge white plane would read as a flash.
  var fadeIn = Math.min(1, tt / 0.10);
  var fadeStart = neonFadeTravel();
  var fadeSpan = Math.max(0.05, neonExitTravel() - fadeStart);
  var fade = 1 - neonClamp01((tt - fadeStart) / fadeSpan);
  var bright = fade <= 0 ? 0 : Math.min(1.6, fade * (1 + pv * Math.max(0, neonParam('beatGlow'))));
  car.body.visible = true;
  car.body.position.set(0, yWorld, -d);
  car.body.scale.set(worldW, worldH, 1);
  car.bodyMat.opacity = neonClamp01((0.35 + 0.65 * opacityScale) * fadeIn * fade);
  if (car.bodyMat.color && car.bodyMat.color.setRGB) car.bodyMat.color.setRGB(bright, bright, bright);
  return { d: d, y: yWorld, w: worldW, h: worldH, size: size, fade: fade };
}

function neonRetireTrails(car) {
  for (var i = 0; i < car.trails.length; i++) {
    car.trails[i].bornAt = -1;
    car.trails[i].mesh.visible = false;
    car.trails[i].mat.opacity = 0;
  }
}

// Stamp the line's current projection into a free slot. The slot is frozen where the car is at
// this instant - position and size - and only its opacity changes after that.
function neonSpawnTrail(car, nowSec, capacity, opacity, brightness) {
  var slot = null;
  var k;
  for (k = 0; k < capacity; k++) {
    if (car.trails[k].bornAt < 0) { slot = car.trails[k]; break; }
  }
  if (!slot) {
    slot = car.trails[0];
    for (k = 1; k < capacity; k++) {
      if (car.trails[k].bornAt < slot.bornAt) slot = car.trails[k];
    }
  }
  slot.bornAt = nowSec;
  slot.fade = neonClamp01(brightness == null ? 1 : brightness);
  slot.mesh.visible = true;
  slot.mesh.position.set(car.body.position.x, car.body.position.y, car.body.position.z);
  slot.mesh.scale.set(car.body.scale.x, car.body.scale.y, 1);
  if (slot.mat.color && slot.mat.color.setRGB) slot.mat.color.setRGB(slot.fade, slot.fade, slot.fade);
  slot.mat.opacity = neonClamp01(opacity * slot.fade);
}

// Age every live stamp in the pool. Returns how many are still alive, which is also the answer to
// "may this car be disposed yet" - the text can be gone while its afterimages are still on screen.
function neonAgeTrails(car, nowSec, trailLife, trailOpacity, beat, capacity) {
  var alive = 0;
  for (var k = 0; k < NEON_TRAIL_MAX; k++) {
    var slot = car.trails[k];
    if (slot.bornAt < 0 || k >= capacity) {
      slot.bornAt = -1;
      slot.mesh.visible = false;
      slot.mat.opacity = 0;
      continue;
    }
    var age = nowSec - slot.bornAt;
    if (age >= trailLife) {
      slot.bornAt = -1;
      slot.mesh.visible = false;
      slot.mat.opacity = 0;
      continue;
    }
    slot.mesh.visible = true;
    slot.mat.opacity = neonClamp01(trailOpacity * (1 - age / trailLife) * (0.65 + 0.35 * beat) * (slot.fade == null ? 1 : slot.fade));
    alive++;
  }
  return alive;
}

// The beat is an animation, not a second clock: the line does not travel further, its glyphs
// punch in place. The attack/release rates are knobs (fast in, slow out reads as a pop; equal
// rates read as a breathing), beatKick is the amount and 0 turns it off.
function neonCarPulse(car, beat, kick, dt) {
  var target = Math.min(1.5, Math.max(0, Number(beat) || 0) * Math.max(0, Number(kick) || 0));
  var step = Math.max(0, Math.min(0.12, Number(dt) || 0));
  var attack = Math.max(1, neonParam('beatAttack'));
  var release = Math.max(0.5, neonParam('beatRelease'));
  var rate = target > (car.pulse || 0) ? attack : release;
  var k = 1 - Math.exp(-rate * step);
  car.pulse = (car.pulse || 0) + (target - (car.pulse || 0)) * k;
  return car.pulse;
}

function neonStepCars(nowSec, dt) {
  var lines = neonActiveLines();
  var wanted = {};
  var i, k;
  for (i = 0; i < lines.length; i++) wanted[lines[i].key] = lines[i];
  var beat = (typeof beatPulse !== 'undefined' && isFinite(beatPulse)) ? Number(beatPulse) : 0;
  var kick = (typeof smoothBass !== 'undefined' && isFinite(smoothBass)) ? Number(smoothBass) : 0;
  var boost = 1 + neonParam('beatKick') * (beat * 0.6 + kick * 0.4);
  var trailCount = Math.min(NEON_TRAIL_MAX, Math.max(0, Math.round(neonParam('trailCount'))));
  var trailInterval = Math.max(0.02, neonParam('trailInterval'));
  var trailLife = Math.max(0.1, neonParam('trailLife'));
  var trailOpacity = Math.max(0, neonParam('trailOpacity'));
  var step = Math.max(0, Math.min(0.12, Number(dt) || 0));
  // Cars are keyed by the line they carry, not by array position: reusing a slot for the next
  // line would swap the text under a stamp that is still floating down the road.
  for (i = 0; i < lines.length; i++) {
    var key = lines[i].key;
    var found = null;
    for (k = 0; k < neonState.cars.length; k++) if (neonState.cars[k].key === key) { found = neonState.cars[k]; break; }
    if (!found) {
      found = neonMakeCar();
      found.key = key;
      neonState.cars.push(found);
    }
  }
  for (i = neonState.cars.length - 1; i >= 0; i--) {
    var car = neonState.cars[i];
    var line = wanted[car.key];
    if (!line) {
      // The line has left. Keep the car as a ghost until its last stamp expires, so the trail is
      // given the room to dissolve instead of being deleted with the text.
      car.body.visible = false;
      car.band.visible = false;
      car.lastTravel = -1;
      car.trailClock = 0;
      car.pulse = 0;
      if (neonAgeTrails(car, nowSec, trailLife, trailOpacity, beat, trailCount) === 0) {
        neonDisposeCar(car);
        neonState.cars.splice(i, 1);
      }
      continue;
    }
    neonRasterCar(car, line.text || ' ');
    if (!line.text) {
      car.body.visible = false;
      car.band.visible = false;
      neonRetireTrails(car);
      continue;
    }
    // The song clock only; the beat animates the glyphs in place (neonCarPulse) instead of moving
    // the line forward, so the readable moment is not shifted by the music.
    var pulse = neonCarPulse(car, beat, neonParam('beatKick'), step);
    var placed = neonPlaceCar(car, line.travel, line.current ? 1 : 0.7, pulse);
    // Band under the car: the light it drags over the road. Flashes with the beat, dims with the text.
    car.band.visible = placed.fade > 0.05;
    car.band.position.set(0, placed.y - placed.h * 0.62, -placed.d);
    car.band.scale.set(placed.w * 1.25, Math.max(0.001, placed.h * 0.10), 1);
    car.bandMat.opacity = neonClamp01(neonParam('lightBand') * (0.25 + 0.75 * beat) * boost * 0.8 * placed.fade);
    car.bandMat.color.setRGB(1.0, 0.35, 0.85);
    // Spawn the next stamp only while the line is actually travelling, and only once the previous
    // frame had a position to leave behind.
    var moved = car.lastTravel >= 0 && Math.abs(line.travel - car.lastTravel) > 1e-5;
    if (moved && trailCount > 0) {
      car.trailClock += step;
      if (car.trailClock >= trailInterval) {
        car.trailClock = Math.min(trailInterval, car.trailClock - trailInterval);
        neonSpawnTrail(car, nowSec, trailCount, trailOpacity, placed.fade);
      }
    } else if (!moved) {
      car.trailClock = 0;
    }
    car.lastTravel = line.travel;
    neonAgeTrails(car, nowSec, trailLife, trailOpacity, beat, trailCount);
  }
  return boost;
}

function neonDisposeCar(car) {
  if (!car) return;
  if (car.texture) car.texture.dispose();
  var meshes = [car.body, car.band];
  (car.trails || []).forEach(function (slot) { meshes.push(slot.mesh); });
  meshes.forEach(function (mesh) {
    if (mesh && mesh.geometry) mesh.geometry.dispose();
    if (mesh && mesh.material) mesh.material.dispose();
  });
  if (neonState.group && car.group) neonState.group.remove(car.group);
}

function neonDisposeScene() {
  if (!neonState.group) return;
  neonState.cars.forEach(function (car) { neonDisposeCar(car); });
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

// The view shakes with the beat: the envelope decides how hard, camShakeRate how fast it wobbles,
// and the same offset is handed to the shader (uShake) so the neon scene moves with the text
// instead of staying nailed to the screen.
function neonShakeOffset(beat, timeSec, amp, rate) {
  var a = Math.max(0, Number(beat) || 0) * Math.max(0, Number(amp) || 0);
  var t = Number(timeSec) || 0;
  var w = Math.max(0.1, Number(rate) || 0) * 9;
  var ax = Math.sin(t * w) * a * 0.02;
  var ay = Math.cos(t * w * 0.83) * a * 0.02;
  return { lookX: ax * 10, lookY: ay * 10, uvX: ax, uvY: ay, amp: a };
}

function neonUpdateCamera(nowSec, beat) {
  var rest = { lookX: 0, lookY: 0, uvX: 0, uvY: 0, amp: 0 };
  if (typeof camera === 'undefined' || !camera) return rest;
  if (typeof freeCamera !== 'undefined' && freeCamera && (freeCamera.active || freeCamera.resetTween)) return rest;
  var fov = neonParam('camFov');
  if (Math.abs(camera.fov - fov) > 1e-4) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  var shake = neonShakeOffset(beat, nowSec, neonParam('camShake'), neonParam('camShakeRate'));
  // The road's vanishing point is the origin; the eye sits a little above it and looks slightly
  // down, and the look target carries the shake so the whole lens turns with the beat.
  camera.position.set(0, 0, 0);
  if (camera.lookAt) camera.lookAt(shake.lookX, shake.lookY, -10);
  return shake;
}

function neonClamp01(v) {
  var n = Number(v);
  return !isFinite(n) ? 0 : Math.min(1, Math.max(0, n));
}

function updateNeonLayer(now, dt) {
  if (!neonPresetIsActive()) return false;
  var startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  if (!neonState.built && !neonBuildScene()) return false;
  var nowSec = (Number(now) || 0) / 1000;
  var beatNow = (typeof beatPulse !== 'undefined' && isFinite(beatPulse)) ? Number(beatPulse) : 0;
  // The pose is written here rather than in the loop's camera section: this preset owns the lens
  // while it is active, and the write still happens before the frame is rendered. The returned
  // offset is the same shake the background takes, so picture and text move together.
  var shake = neonUpdateCamera(nowSec, beatNow);
  var step = Math.max(0, Math.min(0.1, Number(dt) || 0));
  var mat = neonState.quadMat;
  if (mat) {
    neonFeedUniforms(mat.uniforms, nowSec);
    if (typeof renderer !== 'undefined' && renderer && renderer.domElement) {
      // The drawing buffer is already in device pixels; r128's getDrawingBufferSize wants a
      // Vector2 and throws on a plain object, which is what an earlier version did every frame.
      var el = renderer.domElement;
      mat.uniforms.iResolution.value = shadertoyUvUniforms(Math.max(1, el.width), Math.max(1, el.height)).value;
    }
    if (mat.uniforms.uShake && mat.uniforms.uShake.value && mat.uniforms.uShake.value.set) {
      mat.uniforms.uShake.value.set(shake.uvX || 0, shake.uvY || 0);
    }
  }
  var boost = neonStepCars(nowSec, step);
  if (mat) {
    // beatScene scales how much of the beat the neon scene behind the text takes; 0 leaves it still.
    var sceneBeat = neonClamp01(boost - 1) * Math.max(0, neonParam('beatScene'));
    mat.uniforms.uBeat.value = Math.min(1.5, sceneBeat);
  }
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
  var trails = 0;
  var travels = [];
  neonState.cars.forEach(function (car) {
    for (var i = 0; i < car.trails.length; i++) if (car.trails[i].bornAt >= 0) trails++;
    travels.push(Math.round((car.lastTravel || 0) * 100) / 100);
  });
  return {
    active: neonPresetIsActive(), built: neonState.built, frames: neonState.frames,
    costMs: Math.round(neonState.lastCostMs * 100) / 100, error: neonState.error,
    cars: neonState.cars.length, trails: trails, travels: travels,
    camera: (typeof camera !== 'undefined' && camera) ? Math.round(camera.fov) : null,
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
