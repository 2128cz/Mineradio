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
  // ---- the sky and the road
  horizon: { def: 0.34, min: 0.1, max: 0.75, kind: 'ratio', rebuild: 'live' },
  gridSpeed: { def: 1.0, min: 0, max: 6, kind: 'ratio', rebuild: 'live' },
  gridWidth: { def: 1.0, min: 0.2, max: 4, kind: 'ratio', rebuild: 'live' },
  gridGlow: { def: 0.6, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  sunSize: { def: 0.42, min: 0.1, max: 0.9, kind: 'ratio', rebuild: 'live' },
  sunStripes: { def: 24, min: 4, max: 80, kind: 'count', rebuild: 'live' },
  fujiHeight: { def: 0.5, min: 0.05, max: 1.0, kind: 'ratio', rebuild: 'live' },
  fog: { def: 0.55, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  // ---- the palette (the reference is magenta sun / cyan grid on deep blue)
  skyColor: { def: 0.0, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  sunColor: { def: 1.0, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  roadColor: { def: 0.55, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  // ---- the camera: this preset sits still and looks down the road
  camHeight: { def: 1.0, min: -2, max: 6, kind: 'unit', rebuild: 'live' },
  camFov: { def: 52, min: 25, max: 90, kind: 'deg', rebuild: 'live' },
  // ---- the cars
  carSize: { def: 1.0, min: 0.2, max: 3, kind: 'ratio', rebuild: 'live' },
  carRideHeight: { def: -0.12, min: -0.4, max: 0.4, kind: 'ratio', rebuild: 'live' },
  trailLength: { def: 1.6, min: 0, max: 6, kind: 'ratio', rebuild: 'live' },
  trailOpacity: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  lightBand: { def: 0.7, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  carGlow: { def: 1.2, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  beatKick: { def: 0.5, min: 0, max: 2, kind: 'ratio', rebuild: 'live' }
};

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
  'uniform float uHorizon;',
  'uniform float uGridSpeed;',
  'uniform float uGridWidth;',
  'uniform float uGridGlow;',
  'uniform float uSunSize;',
  'uniform float uSunStripes;',
  'uniform float uFujiHeight;',
  'uniform float uFog;',
  'uniform vec3 uSky;',
  'uniform vec3 uSun;',
  'uniform vec3 uRoad;',
  'uniform float uBeat;',
  '',
  'float neonLine(float v, float w) {',
  '  return smoothstep(w, 0.0, abs(fract(v) - 0.5));',
  '}',
  '',
  // The road: perspective divide around the horizon, two line frequencies, scrolling forward.
  'float neonGrid(vec2 p, float speed) {',
  '  vec2 size = vec2(p.y, p.y * p.y * 0.22) * 0.01 * uGridWidth;',
  '  p.y += iTime * 2.2 * speed;',
  '  float fine = neonLine(p.x, size.x) + neonLine(p.y, size.y);',
  '  float wide = neonLine(p.x * 0.25, size.x * 5.0) + neonLine(p.y * 0.25, size.y * 5.0);',
  '  return clamp(fine + wide * 0.55 * uGridGlow, 0.0, 2.0);',
  '}',
  '',
  // The sun: a disc with horizontal cuts that drift upward, plus a soft bloom ring.
  'float neonSun(vec2 p) {',
  '  float r = length(p);',
  '  float disc = smoothstep(uSunSize, uSunSize * 0.94, r);',
  '  float cut = clamp(sin((p.y + iTime * 0.18) * uSunStripes) * 0.5 + 0.5 - uSunSize * 0.55, 0.0, 1.0);',
  '  cut = smoothstep(0.35, 0.6, cut);',
  '  float bloom = smoothstep(uSunSize * 1.9, uSunSize * 0.6, r) * 0.35;',
  '  return disc * mix(1.0, cut, step(p.y, 0.0)) + bloom;',
  '}',
  '',
  // The mountain: a trapezoid near the horizon, with a wavy snow line and an outline.
  'float neonFuji(vec2 p) {',
  '  float h = uFujiHeight;',
  '  float slope = 1.35;',
  '  float halfWidth = max(0.0, (h - p.y) / slope);',
  '  float side = abs(p.x) - halfWidth;',
  '  float isBody = step(p.y, 0.0) * step(-h, p.y);',
  '  float snow = smoothstep(0.0, 0.02, (p.y + h * 0.62) + sin(p.x * 22.0) * 0.02);',
  '  float edge = smoothstep(0.035, 0.0, abs(side));',
  '  return clamp(isBody * 0.55 + snow * 0.25 + edge * 0.9, 0.0, 1.5);',
  '}',
  '',
  'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
  '  vec2 uv = (2.0 * fragCoord.xy - iResolution.xy) / iResolution.y;',
  '  float h = uHorizon;',
  '  vec3 col = mix(uSky * 0.35, uSky, clamp((uv.y + 1.0) * 0.5, 0.0, 1.0));',
  '  col += uSun * 0.10 * smoothstep(0.9, 0.0, length(vec2(uv.x - 0.55, (uv.y - h) * 1.6)));',
  // sky side
  '  if (uv.y > h) {',
  '    vec2 sunP = uv - vec2(0.55, h + 0.22);',
  '    col = mix(col, uSun * 1.5 + 0.2, clamp(neonSun(sunP), 0.0, 1.0));',
  '    vec2 fujiP = uv - vec2(-0.5, h);',
  '    float fuji = neonFuji(fujiP);',
  '    col = mix(col, mix(uSky * 0.2, uSun * 0.55, clamp(fujiP.y / -uFujiHeight + 1.0, 0.0, 1.0)), clamp(fuji, 0.0, 1.0) * 0.85);',
  '    col += uSun * 0.25 * smoothstep(0.06, 0.0, abs(uv.y - h));',
  '  } else {',
  // road side: perspective divide, then the grid
  '    vec2 p = uv;',
  '    p.y = 1.2 / (abs(p.y - h) + 0.06);',
  '    p.x *= p.y * 0.9;',
  '    float fog = smoothstep(1.0, 0.05, abs(uv.y - h) * 6.0);',
  '    float g = neonGrid(p * 0.55, uGridSpeed);',
  '    col = mix(col, uRoad, clamp(g, 0.0, 1.0) * (1.0 - 0.55 * fog));',
  '    col += uRoad * 0.35 * g * uGridGlow;',
  '    col = mix(col, uSky * 0.12 + uRoad * 0.25, fog * uFog);',
  '  }',
  '  col += uBeat * 0.06 * vec3(1.0, 0.4, 0.9);',
  '  col = pow(max(col, vec3(0.0)), vec3(0.85));',
  '  fragColor = vec4(col, 1.0);',
  '}',
  // Shadertoy shape: the body defines mainImage, the wrapper calls it once.
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
        uHorizon: { value: neonParam('horizon') },
        uGridSpeed: { value: neonParam('gridSpeed') },
        uGridWidth: { value: neonParam('gridWidth') },
        uGridGlow: { value: neonParam('gridGlow') },
        uSunSize: { value: neonParam('sunSize') },
        uSunStripes: { value: neonParam('sunStripes') },
        uFujiHeight: { value: neonParam('fujiHeight') },
        uFog: { value: neonParam('fog') },
        uSky: { value: new THREE.Color() },
        uSun: { value: new THREE.Color() },
        uRoad: { value: new THREE.Color() },
        uBeat: { value: 0 }
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
    var u = mat.uniforms;
    u.iTime.value = (Number(now) || 0) / 1000;
    u.uHorizon.value = neonParam('horizon');
    u.uGridSpeed.value = neonParam('gridSpeed');
    u.uGridWidth.value = neonParam('gridWidth');
    u.uGridGlow.value = neonParam('gridGlow');
    u.uSunSize.value = neonParam('sunSize');
    u.uSunStripes.value = neonParam('sunStripes');
    u.uFujiHeight.value = neonParam('fujiHeight');
    u.uFog.value = neonParam('fog');
    var sky = neonParam('skyColor');
    var sun = neonParam('sunColor');
    var road = neonParam('roadColor');
    u.uSky.value.setRGB(0.04 + sky * 0.10, 0.03 + sky * 0.05, 0.14 + sky * 0.25);
    u.uSun.value.setRGB(0.55 + sun * 0.45, 0.10 + sun * 0.30, 0.45 + sun * 0.50);
    u.uRoad.value.setRGB(0.10 + road * 0.35, 0.20 + road * 0.55, 0.55 + road * 0.45);
    if (typeof renderer !== 'undefined' && renderer && renderer.domElement) {
      // The drawing buffer is already in device pixels; r128's getDrawingBufferSize wants a Vector2
      // and throws on a plain object, which is what an earlier version did once per frame.
      var el = renderer.domElement;
      u.iResolution.value = shadertoyUvUniforms(Math.max(1, el.width), Math.max(1, el.height)).value;
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
