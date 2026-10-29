'use strict';

// 银河黑洞 / GALACTIC BLACK HOLE (preset 15)
//
// What this is: a real post-processing pass. The scene (particles, the cover, and the stage
// lyric meshes) is rendered into a WebGLRenderTarget, then one fullscreen quad bends whatever
// came out of it around a black hole and writes the result to the screen. The lyric text is
// bent because it is in the render target: that is why this preset does NOT take stageLyrics
// over the way the ring and the PV layer do - those two draw on a DOM canvas, which no WebGL
// pass can refract.
//
// What is ported from the reference shader (a Kerr-Newman raymarcher with Penrose and
// topology maps, an HDR bloom cascade and Walker-Penrose polarisation):
//   - MapKerrSchildRadius: the Kerr-Schild radial coordinate, including its stable branch for
//     b < 0. It is the coordinate the shadow's outline is a level set of, which is what makes
//     the silhouette go oblate / D-shaped as the spin grows instead of staying a circle.
//   - The horizon algebra in the reference's own mass unit M = 0.5: a = 0.5*iSpin,
//     Q2 = 0.25*iQ2, disc = 0.25 - a*a - Q2, rp/rm = 0.5 +/- sqrt(disc), and the outer static
//     limit sqrt((0.5 + sqrt(0.25 - Q2))^2 + a^2) that the reference draws in its topology map.
//   - The Reinhardt-style rolloff the reference's Image pass uses for its HDR add.
// What is deliberately NOT ported: the geodesic raymarch (a post pass cannot integrate
// null geodesics per pixel at 60 Hz for a whole scene), the maximal-extension/white-hole
// regions, the conformal diagrams, the multi-octave bloom cascade (the app has its own bloom).
//
// So the deflection law is the cheap lensing approximation - bend ~ rp*r/r, i.e. ~1/impact
// parameter - written in the ported Kerr-Schild radius rather than in a plain Euclidean one,
// plus an azimuthal drag ~ a*rp/r for frame dragging. The photon ring is the level set of the
// outer static limit. None of that is a geodesic solve and the code does not claim to be one.

var BLACKHOLE_PRESET_INDEX = 15;    // newest preset: MAX_VISUAL_PRESET_INDEX must equal this
var BH_MASS_UNIT = 0.5;             // the reference's M: rp = 0.5 + sqrt(0.25 - a^2 - Q2)
var BH_RING_WIDTH_FACTOR = 0.16;    // photon ring thickness, in units of the horizon radius
var BH_SHADOW_EDGE_FACTOR = 0.06;   // how fast the shadow's rim fades, same units

// The knobs. The schema lives here so the defaults have exactly one home; the store and the
// console bindings live in 07-fx/12-blackhole-tuning.js, and every row gets its own reset
// button the same way the ring's and the PV layer's rows do.
//
// rebuild: 'pass' re-makes the render target, 'lyric' re-lays the flight, 'live' is read
// every frame and only needs a redraw.
var BH_TUNING_SCHEMA = {
  holeX: { def: 0.14, min: -0.9, max: 0.9, kind: 'ratio', rebuild: 'live' },
  holeY: { def: 0.03, min: -0.7, max: 0.7, kind: 'ratio', rebuild: 'live' },
  holeDepth: { def: 5.2, min: 1.8, max: 9, kind: 'unit', rebuild: 'live' },
  mass: { def: 0.14, min: 0.02, max: 0.5, kind: 'ratio', rebuild: 'live' },
  spin: { def: 0.7, min: -1, max: 1, kind: 'ratio', rebuild: 'live' },
  charge: { def: 0, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  deflect: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  shadowScale: { def: 1.35, min: 1, max: 2, kind: 'ratio', rebuild: 'live' },
  swirl: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  ringGlow: { def: 0.85, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  skyStars: { def: 0.6, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  skyBand: { def: 0.55, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  fovDeg: { def: 58, min: 35, max: 92, kind: 'deg', rebuild: 'live' },
  sideSpread: { def: 6.2, min: 2.5, max: 14, kind: 'unit', rebuild: 'lyric' },
  startNear: { def: 1.6, min: 0.7, max: 4, kind: 'unit', rebuild: 'lyric' },
  flyIn: { def: 0.75, min: 0.15, max: 2.5, kind: 'sec', rebuild: 'live' },
  swallow: { def: 0.55, min: 0.15, max: 2, kind: 'sec', rebuild: 'live' },
  fallCurve: { def: 0.66, min: 0.25, max: 1.6, kind: 'ratio', rebuild: 'live' },
  passScale: { def: 1, min: 0.5, max: 1, kind: 'ratio', rebuild: 'pass' }
};

// The live value of a knob. The store is built by a later module, so the schema default is
// the path until 07-fx/12-blackhole-tuning.js has run.
function bhParam(key) {
  var store = (typeof blackHoleTuning !== 'undefined') ? blackHoleTuning : null;
  if (store && store[key] !== undefined && store[key] !== null) return store[key];
  var spec = BH_TUNING_SCHEMA[key];
  return spec ? spec.def : 0;
}

function bhClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------- the ported kernel
//
// The reference's MapKerrSchildRadius, in JS as well as in the shader: both must agree, so
// tests/blackhole-lens.test.js checks the JS one and reads the GLSL text back for the shape.
function bhKerrSchildRadius(px, py, pz, spinA) {
  var a2 = spinA * spinA;
  var rho2 = px * px + pz * pz;
  var y2 = py * py;
  var b = rho2 + y2 - a2;
  var det = Math.sqrt(b * b + 4 * a2 * y2);
  var r2 = b >= 0 ? 0.5 * (b + det) : (2 * a2 * y2) / Math.max(1e-20, det - b);
  return Math.sqrt(Math.max(0, r2));
}

// The reference's horizon algebra, verbatim in its own units.
function bhHorizonRadii(spin, charge) {
  var a = BH_MASS_UNIT * bhClamp(Number(spin) || 0, -1, 1);
  var q2 = 0.25 * bhClamp(Number(charge) || 0, 0, 1);
  var disc = 0.25 - a * a - q2;
  var root = Math.sqrt(Math.max(0, disc));
  var ergoDisc = 0.25 - q2;
  return {
    a: a,
    q2: q2,
    disc: disc,
    rp: BH_MASS_UNIT + root,                                 // outer event horizon
    rm: BH_MASS_UNIT - root,                                 // inner (Cauchy) horizon
    ergo: Math.sqrt(Math.pow(BH_MASS_UNIT + Math.sqrt(Math.max(0, ergoDisc)), 2) + a * a),
    naked: disc < 0                                          // no horizon at all: a naked singularity
  };
}

// The screen plane's distance from the eye in units where the viewport's half-height is 1:
// visible half-height at distance D is tan(fov/2)*D, so the plane sits at 1/tan(fov/2). This
// is what makes the 视锥 knob change the lens's geometry instead of merely scaling it.
function bhPlaneZ(fovDegrees) {
  var fov = bhClamp(Number(fovDegrees) || 58, 20, 120) * Math.PI / 180;
  return 1 / Math.max(1e-4, Math.tan(fov * 0.5));
}

// The plunge the lyric rows follow: d = d0 * (1 - u)^curve. The radial free-fall solution is
// proportional to (t_end - t)^(2/3), so curve < 1 means the row accelerates into the hole and
// is gone in a blink; curve = 1 would be a constant-speed approach.
function bhFallDistance(d0, progress, curve) {
  var u = bhClamp(Number(progress) || 0, 0, 1);
  var k = bhClamp(Number(curve) || 0.66, 0.05, 3);
  return (Number(d0) || 0) * Math.pow(Math.max(0, 1 - u), k);
}

// ---------------------------------------------------------------- the hole on screen
//
// The hole is a world point (so the lyric rows can fly to it) and its projection (so the lens
// bends around the same pixel). Both are computed once per frame, after the camera modules and
// before the lyric layout, which is what keeps the 视锥 knob and the lyric camera-lock fit
// consistent with each other instead of fighting over camera.fov.
function bhProjectPoint(point, camPos, camDir, camRight, camUp, tanHalfFov, aspect) {
  var dx = point.x - camPos.x, dy = point.y - camPos.y, dz = point.z - camPos.z;
  var along = dx * camDir.x + dy * camDir.y + dz * camDir.z;
  if (!(along > 1e-3) || !(tanHalfFov > 1e-4)) return null;
  var side = dx * camRight.x + dy * camRight.y + dz * camRight.z;
  var vert = dx * camUp.x + dy * camUp.y + dz * camUp.z;
  var ndcX = side / (along * tanHalfFov * (aspect || 1));
  var ndcY = vert / (along * tanHalfFov);
  return { u: ndcX * 0.5 + 0.5, v: ndcY * 0.5 + 0.5, ndcX: ndcX, ndcY: ndcY, distance: along };
}

var bhScratch = null;
function bhEnsureScratch() {
  if (bhScratch || typeof THREE === 'undefined') return bhScratch;
  bhScratch = {
    dir: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(),
    point: new THREE.Vector3(), size: new THREE.Vector2()
  };
  return bhScratch;
}

// The camera basis as plain records, so the maths above can be tested with hand-written
// vectors instead of a THREE matrix.
function bhGatherFrame() {
  var vecs = bhEnsureScratch();
  if (typeof camera === 'undefined' || !camera || !vecs) return null;
  camera.getWorldDirection(vecs.dir);
  vecs.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  vecs.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  var fovRad = (camera.fov || 58) * Math.PI / 180;
  return {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    dir: { x: vecs.dir.x, y: vecs.dir.y, z: vecs.dir.z },
    right: { x: vecs.right.x, y: vecs.right.y, z: vecs.right.z },
    up: { x: vecs.up.x, y: vecs.up.y, z: vecs.up.z },
    tanHalfFov: Math.tan(fovRad * 0.5),
    aspect: camera.aspect || (innerWidth / Math.max(1, innerHeight)),
    fovDeg: camera.fov || 58
  };
}

// Where the hole is: on the camera axis at holeDepth, offset along the camera's own right/up
// by the two position knobs, in units of the visible half-height at that depth - the same
// basis the lyric stage uses for its layout offsets.
function bhComputeFrame() {
  var frame = bhGatherFrame();
  var vecs = bhEnsureScratch();
  if (!frame || !vecs) return null;
  var depth = bhClamp(bhParam('holeDepth'), 1.2, 24);
  var planeH = frame.tanHalfFov * depth;
  vecs.point.set(frame.position.x, frame.position.y, frame.position.z)
    .addScaledVector(frame.dir, depth)
    .addScaledVector(frame.right, bhParam('holeX') * planeH * frame.aspect)
    .addScaledVector(frame.up, bhParam('holeY') * planeH);
  var world = { x: vecs.point.x, y: vecs.point.y, z: vecs.point.z };
  var radii = bhHorizonRadii(bhParam('spin'), bhParam('charge'));
  // The mass knob is the horizon radius in half-height units; the reference's algebra works in
  // its own M = 0.5 units, so one scale converts between them and keeps rp/ergo consistent.
  var scale = bhClamp(bhParam('mass'), 0.005, 0.9) / BH_MASS_UNIT;
  return {
    world: world,
    uv: bhProjectPoint(world, frame.position, frame.dir, frame.right, frame.up, frame.tanHalfFov, frame.aspect),
    distance: depth,
    planeZ: bhPlaneZ(frame.fovDeg),
    fovDeg: frame.fovDeg,
    aspect: frame.aspect || 1,
    radii: radii,
    scale: scale,
    uvHorizon: radii.rp * scale,
    uvShadow: radii.rp * bhClamp(bhParam('shadowScale'), 1, 2) * scale
  };
}

// ---------------------------------------------------------------- the lens shader
//
// The quad spans the viewport, so the vertex stage just forwards the corner attribute.
var BH_PASS_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

var BH_PASS_FS = `
precision highp float;

#define BH_RIM 0.14
#define BH_RING_W 0.16

varying vec2 vUv;

uniform sampler2D uSrc;
uniform vec2 uCenter;
uniform float uAspect;
uniform float uPlaneZ;
uniform float uScale;
uniform float uSpin;
uniform float uCharge;
uniform float uDeflect;
uniform float uShadowScale;
uniform float uSwirl;
uniform float uRing;
uniform float uStars;
uniform float uBand;
uniform float uTime;
uniform float uLevel;

// Kerr-Schild radius, ported from the reference's MapKerrSchildRadius - same two branches.
float ksRadius(float px, float py, float pz, float a) {
  float a2 = a * a;
  float rho2 = px * px + pz * pz;
  float y2 = py * py;
  float b = rho2 + y2 - a2;
  float det = sqrt(b * b + 4.0 * a2 * y2);
  float r2 = b >= 0.0 ? 0.5 * (b + det) : (2.0 * a2 * y2) / max(1e-20, det - b);
  return sqrt(max(r2, 0.0));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// The sky the lens refracts: a galactic band plus two star layers. It is written in the source
// direction, so it bends along with the scene instead of sitting behind the effect.
vec3 skyColor(vec2 nq, float band, float stars) {
  vec3 deep = vec3(0.012, 0.017, 0.030);
  if (band <= 0.001 && stars <= 0.001) return deep;
  vec2 tilt = vec2(nq.x * 0.966 - nq.y * 0.259, nq.x * 0.259 + nq.y * 0.966);
  float core = exp(-pow(tilt.y / 0.19, 2.0));
  float dust = mix(1.0, 0.46, core) * smoothstep(0.14, 0.86, hash12(floor(tilt * 4.2) + 9.0));
  vec3 glow = vec3(0.34, 0.42, 0.68) * core * dust * band * 0.52
            + vec3(0.85, 0.76, 0.62) * pow(core, 3.0) * band * 0.20;
  float grain = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float sc = mix(56.0, 122.0, float(layer));
    vec2 cell = floor(nq * sc);
    float h = hash12(cell + float(layer) * 71.3);
    float on = step(0.985 - float(layer) * 0.003, h);
    vec2 jitter = vec2(hash12(cell + 3.1), hash12(cell + 7.7));
    vec2 d = (nq - (cell + jitter) / sc) * sc;
    float twinkle = 0.72 + 0.28 * sin(uTime * (0.9 + h * 2.6) + h * 22.0);
    grain += on * exp(-dot(d, d) * 24.0) * (0.45 + h) * twinkle;
  }
  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.72), hash12(floor(nq * 56.0) + 5.0));
  return deep + glow + grain * tint * 1.1;
}

void main() {
  vec2 uv = vUv;
  vec2 nq = (uv - uCenter) * vec2(uAspect, 1.0) / max(uScale, 1e-4);

  float a = 0.5 * uSpin;
  float q2 = 0.25 * uCharge;
  float disc = 0.25 - a * a - q2;
  float root = sqrt(max(0.0, disc));
  float rp = 0.5 + root;
  float ergo = sqrt(pow(0.5 + sqrt(max(0.0, 0.25 - q2)), 2.0) + a * a);
  // Two horizons is the reference's subextremal case; with no horizon at all the lens has to
  // close down instead of bending around a singularity nothing shields.
  float horizon = disc > 0.0 ? 1.0 : 0.0;
  float cap = rp * uShadowScale;

  float pz = uPlaneZ / max(uScale, 1e-4);
  float rPlane = ksRadius(nq.x, nq.y, pz, a);

  // Bend ~ rp*r / impact parameter (the 1/b of weak lensing), floored at the shadow's rim so
  // nothing samples from inside the horizon.
  float impact = max(rPlane, cap * 0.92);
  vec2 dir = nq / max(length(nq), 1e-5);
  vec2 src = nq + dir * (uDeflect * horizon * rp * rp / impact);

  // Frame dragging: the azimuthal half of the Lense-Thuring term, ~ a*rp/r.
  float drag = uSwirl * a * rp / impact * horizon;
  float cs = cos(drag), sn = sin(drag);
  src = vec2(src.x * cs - src.y * sn, src.x * sn + src.y * cs);

  // The deflection pulls samples outward, so near the viewport border it would read outside the
  // render target and smear its edge; fade it out over the last few percent instead.
  vec2 srcUv = src * uScale / vec2(uAspect, 1.0) + uCenter;
  float border = min(min(srcUv.x, 1.0 - srcUv.x), min(srcUv.y, 1.0 - srcUv.y));
  srcUv = mix(uv, srcUv, smoothstep(0.0, 0.09, border));

  vec4 sceneTex = texture2D(uSrc, srcUv);
  vec3 sky = skyColor(src, uBand, uStars);
  vec3 deep = vec3(0.012, 0.017, 0.030);
  vec3 color = sceneTex.rgb + sky * (1.0 - sceneTex.a);

  // The shadow: what fell in does not come back. The rim is a fade, not a cut, so a line on its
  // way in is smeared into the hole rather than clipped on a hard circle.
  float swallowed = horizon * (1.0 - smoothstep(cap, cap + BH_RIM * rp, rPlane));
  color *= 1.0 - swallowed;

  // Photon ring on the shadow rim and the outer static limit, then the reference's Reinhardt
  // rolloff so a bright ring cannot clip into a flat white disc.
  float rimW = max(BH_RING_W * rp, 1e-3);
  float ringBand = exp(-pow((rPlane - cap) / rimW, 2.0));
  float ergoBand = exp(-pow((rPlane - ergo) / (rimW * 1.8), 2.0));
  float doppler = 1.0 + 0.62 * a * sin(atan(nq.y, nq.x));
  vec3 ringColor = (vec3(1.0, 0.86, 0.66) * ringBand * 1.35 + vec3(0.62, 0.78, 1.0) * ergoBand * 0.55)
    * uRing * horizon * doppler * (0.65 + 0.55 * uLevel);
  color += ringColor / (1.0 + ringColor);

  // The canvas keeps its alpha: where there is neither scene content, nor starlight, nor the
  // hole itself, the user's own background shows through. The shadow is always opaque - a black
  // hole you can see your wallpaper through is not a black hole.
  float lightness = max(length(sky - deep) * 2.1, max(length(ringColor) * 1.4, swallowed));
  gl_FragColor = vec4(clamp(color, 0.0, 4.0), clamp(max(sceneTex.a, lightness), 0.0, 1.0));
}
`;

// ---------------------------------------------------------------- the pass
//
// One render target plus one fullscreen quad. Nothing else in the app renders to a target
// today (the scene goes straight to screen), so this owns the whole of it: it is built when the
// preset is selected, resized against the renderer's own drawing buffer every frame, and
// disposed when the preset is left, so a user who never selects it pays nothing for it.
var blackHoleState = {
  active: false,
  rt: null,
  quadScene: null,
  quadCamera: null,
  material: null,
  width: 0,
  height: 0,
  passScale: 0,
  frame: null,
  level: 0,
  draws: 0,
  fallbacks: 0,
  lastCostMs: 0,
  error: ''
};

function blackHolePresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === BLACKHOLE_PRESET_INDEX;
}

function bhDisposePass() {
  if (blackHoleState.rt && blackHoleState.rt.dispose) blackHoleState.rt.dispose();
  if (blackHoleState.material && blackHoleState.material.dispose) blackHoleState.material.dispose();
  if (blackHoleState.quadScene) {
    for (var i = 0; i < blackHoleState.quadScene.children.length; i++) {
      var child = blackHoleState.quadScene.children[i];
      if (child.geometry && child.geometry.dispose) child.geometry.dispose();
    }
    blackHoleState.quadScene.clear();
  }
  blackHoleState.rt = null;
  blackHoleState.material = null;
  blackHoleState.quadScene = null;
  blackHoleState.quadCamera = null;
  blackHoleState.width = 0;
  blackHoleState.height = 0;
  blackHoleState.passScale = 0;
}

function bhSharedTimeUniform() {
  if (typeof uniforms !== 'undefined' && uniforms && uniforms.uTime) return uniforms.uTime;
  return { value: 0 };
}

function bhBuildPass() {
  if (typeof THREE === 'undefined' || typeof renderer === 'undefined' || !renderer) return false;
  var vecs = bhEnsureScratch();
  if (!vecs) return false;
  try {
    var scale = bhClamp(bhParam('passScale'), 0.4, 1);
    var size = renderer.getDrawingBufferSize(vecs.size);
    var w = Math.max(32, Math.round((size.x || innerWidth) * scale));
    var h = Math.max(32, Math.round((size.y || innerHeight) * scale));
    var rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false
    });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    var material = new THREE.ShaderMaterial({
      vertexShader: BH_PASS_VS,
      fragmentShader: BH_PASS_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      uniforms: {
        uSrc: { value: rt.texture },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: 1 },
        uPlaneZ: { value: 1.8 },
        uScale: { value: 0.28 },
        uSpin: { value: 0.7 },
        uCharge: { value: 0 },
        uDeflect: { value: 1 },
        uShadowScale: { value: 1.35 },
        uSwirl: { value: 1 },
        uRing: { value: 0.85 },
        uStars: { value: 0.6 },
        uBand: { value: 0.55 },
        uLevel: { value: 0 },
        uTime: bhSharedTimeUniform()
      }
    });
    var quadScene = new THREE.Scene();
    var quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    quadScene.add(quad);
    blackHoleState.rt = rt;
    blackHoleState.material = material;
    blackHoleState.quadScene = quadScene;
    blackHoleState.quadCamera = quadCamera;
    blackHoleState.width = w;
    blackHoleState.height = h;
    blackHoleState.passScale = scale;
    blackHoleState.error = '';
    return true;
  } catch (error) {
    blackHoleState.error = String((error && error.message) || error);
    bhDisposePass();
    return false;
  }
}

// The target follows the renderer, never the window: applyRendererPowerMode owns setPixelRatio
// and setSize, and deep-background sleep shrinks the drawing buffer to 4x4, so a target built
// from innerWidth would be the wrong size at exactly the moments the app is trying to save power.
function bhAlignPassSize() {
  if (typeof renderer === 'undefined' || !renderer || !blackHoleState.rt) return;
  var vecs = bhEnsureScratch();
  if (!vecs) return;
  var scale = bhClamp(bhParam('passScale'), 0.4, 1);
  var size = renderer.getDrawingBufferSize(vecs.size);
  var w = Math.max(32, Math.round((size.x || 0) * scale));
  var h = Math.max(32, Math.round((size.y || 0) * scale));
  if (w === blackHoleState.width && h === blackHoleState.height && scale === blackHoleState.passScale) return;
  blackHoleState.rt.setSize(w, h);
  blackHoleState.width = w;
  blackHoleState.height = h;
  blackHoleState.passScale = scale;
}

function bhSyncLens(frame) {
  var material = blackHoleState.material;
  if (!material) return;
  var u = material.uniforms;
  u.uCenter.value.set(frame.uv.u, frame.uv.v);
  u.uAspect.value = frame.aspect;
  u.uPlaneZ.value = frame.planeZ;
  u.uScale.value = frame.scale;
  u.uSpin.value = bhParam('spin');
  u.uCharge.value = bhParam('charge');
  u.uDeflect.value = bhParam('deflect');
  u.uShadowScale.value = bhParam('shadowScale');
  u.uSwirl.value = bhParam('swirl');
  u.uRing.value = bhParam('ringGlow');
  u.uStars.value = bhParam('skyStars');
  u.uBand.value = bhParam('skyBand');
  u.uLevel.value = blackHoleState.level;
}

// Runs between the camera modules and the lyric layout: the frustum knob has to be in place
// before lyricCameraLockFit measures the visible height, or the stage scales for one fov and
// renders at another.
function blackHoleApplyCamera(dt) {
  if (!blackHolePresetIsActive()) return false;
  var fov = bhClamp(bhParam('fovDeg'), 20, 120);
  if (typeof camera !== 'undefined' && camera && Math.abs((camera.fov || 0) - fov) > 1e-4) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  var energy = 0;
  if (typeof audioEnergy !== 'undefined') energy = Number(audioEnergy) || 0;
  else if (typeof bass !== 'undefined') energy = Number(bass) || 0;
  var ease = Math.min(1, Math.max(0.05, (Number(dt) || 0.016) * 6));
  blackHoleState.level += (bhClamp(energy, 0, 1) - blackHoleState.level) * ease;
  blackHoleFlight.time += Math.max(0, Number(dt) || 0);
  blackHoleState.frame = bhComputeFrame();
  return true;
}

// Returns false when the caller must render the plain way: no pass yet, or the hole has ended up
// behind the eye (the user can drag the camera past it), where the projection is undefined.
function renderBlackHoleFrame() {
  if (!blackHolePresetIsActive()) return false;
  if (!blackHoleState.rt && !bhBuildPass()) return false;
  var frame = blackHoleState.frame || bhComputeFrame();
  if (!frame || !frame.uv || !bhEnsureScratch()) {
    blackHoleState.fallbacks++;
    return false;
  }
  bhAlignPassSize();
  bhSyncLens(frame);
  var started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  try {
    renderer.setRenderTarget(blackHoleState.rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(blackHoleState.quadScene, blackHoleState.quadCamera);
  } catch (error) {
    blackHoleState.error = String((error && error.message) || error);
    renderer.setRenderTarget(null);
    blackHoleState.fallbacks++;
    return false;
  }
  var ended = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  blackHoleState.lastCostMs = ended - started;
  // The shader cannot be compiled anywhere but on a GPU, so the first frames are also the compile
  // test: three logs a broken program and simply skips the draw, which would leave the screen
  // showing the previous frame forever. Detect it once and hand the frame back to the plain path.
  var program = blackHoleState.material && blackHoleState.material.program;
  if (program && program.diagnostics && program.diagnostics.runnable === false) {
    blackHoleState.error = 'shader did not compile: ' + String(program.diagnostics.programLog || '').slice(0, 200);
    bhDisposePass();
    blackHoleState.fallbacks++;
    return false;
  }
  blackHoleState.draws++;
  blackHoleState.active = true;
  return true;
}

// Called from setPreset, like the other two takeover presets: the pass exists only while the
// preset is on, and leaving it has to give the GPU memory back rather than keep the target.
function applyBlackHolePresetNow(prev, next) {
  var on = Number(next) === BLACKHOLE_PRESET_INDEX;
  var was = Number(prev) === BLACKHOLE_PRESET_INDEX;
  if (on) {
    if (!blackHoleState.rt) bhBuildPass();
    blackHoleState.frame = bhComputeFrame();
  } else if (was) {
    bhDisposePass();
    blackHoleState.active = false;
  }
  if (on || was) {
    blackHoleFlight.time = 0;
    blackHoleFlight.units = 0;
    if (typeof applyVisualTakeoverNow === 'function') applyVisualTakeoverNow();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('blackhole-preset');
  }
  return on;
}

function blackHoleStatus() {
  var frame = blackHoleState.frame || (blackHolePresetIsActive() ? bhComputeFrame() : null);
  var radii = frame ? frame.radii : bhHorizonRadii(bhParam('spin'), bhParam('charge'));
  return {
    active: blackHolePresetIsActive(),
    built: !!blackHoleState.rt,
    costMs: Math.round(blackHoleState.lastCostMs * 1000) / 1000,
    draws: blackHoleState.draws,
    fallbacks: blackHoleState.fallbacks,
    level: Math.round(blackHoleState.level * 1000) / 1000,
    rt: blackHoleState.rt ? [blackHoleState.width, blackHoleState.height] : null,
    passScale: blackHoleState.passScale,
    fov: frame ? frame.fovDeg : null,
    planeZ: frame ? Math.round(frame.planeZ * 1000) / 1000 : null,
    uv: frame && frame.uv ? [Math.round(frame.uv.u * 1000) / 1000, Math.round(frame.uv.v * 1000) / 1000] : null,
    horizon: {
      a: Math.round(radii.a * 1000) / 1000,
      rp: Math.round(radii.rp * 1000) / 1000,
      rm: Math.round(radii.rm * 1000) / 1000,
      ergo: Math.round(radii.ergo * 1000) / 1000,
      naked: radii.naked
    },
    shadowUv: frame ? Math.round(frame.uvShadow * 10000) / 10000 : null,
    error: blackHoleState.error
  };
}

// A post pass refracts what is inside its render target. The ring and the PV layer take the
// lyric layer over because they draw text on a DOM canvas; that is not an option here - text
// outside the target could not be bent - so stageLyrics stays on and the flight code moves the
// app's own meshes instead.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'blackhole-pass',
    isActive: blackHolePresetIsActive,
    suppresses: {
      particles: false,
      bloom: false,
      float: false,
      backCover: false,
      starRiver: false,
      ripples: false,
      lyricsParticles: false,
      stageLyrics: false
    }
  });
}

// ---------------------------------------------------------------- the lyric flight
//
// Rows are not re-created here: the app's own row meshes are displaced. For each row the code
// keeps the offset it applied last frame, subtracts it to recover the position the app chose,
// computes a new offset and writes it back - so the app's own easing keeps working underneath,
// and a row handed back mid-flight returns exactly where the app expects it.
//
// Phase per row: enter (from the near left/right of the camera) -> hold (the app's own layout,
// untouched, so the sung line reads at the size and place the user set) -> swallow (the power law
// into the hole). Odd line indices come from the camera's left, even from the right.
var blackHoleFlight = { time: 0, units: 0, entering: 0, swallowing: 0, holding: 0 };

function bhSideForLineIndex(lineIndex) {
  var n = Math.round(Number(lineIndex));
  if (!isFinite(n)) return 1;
  return (Math.abs(n) % 2 === 1) ? -1 : 1;   // 奇左偶右
}

function bhSubVec(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function bhLerpVec(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function bhLenVec(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

// The displacement law for one row at one moment, in the parent's local space, relative to the
// position the app chose. Returns null for "leave this row to the app". No THREE and no scene
// access, so the flight is assertable as arithmetic.
function bhFlightOffset(hold, entry, hole, phase) {
  if (!phase) return null;
  var u = bhClamp(Number(phase.u) || 0, 0, 1);
  if (phase.stage === 'enter') {
    var k = 1 - Math.pow(1 - u, 3);
    return bhSubVec(bhLerpVec(entry, hold, k), hold);
  }
  if (phase.stage === 'swallow') {
    var fromHole = bhSubVec(hold, hole);
    var start = bhLenVec(fromHole);
    if (!(start > 1e-5)) return { x: 0, y: 0, z: 0 };
    var distance = bhFallDistance(start, u, bhClamp(Number(phase.curve) || 0.66, 0.05, 3));
    var along = distance / start;
    return { x: fromHole.x * (along - 1), y: fromHole.y * (along - 1), z: fromHole.z * (along - 1) };
  }
  return null;
}

// The hole, in a given parent's local space - the same point the lens is centred on, so the text
// flies at what the user sees rather than at a second copy of the geometry.
function bhHoleLocal(parent, frame, vecs) {
  if (!parent || !frame || !vecs) return { x: 0, y: 0, z: 0 };
  vecs.point.set(frame.world.x, frame.world.y, frame.world.z);
  parent.worldToLocal(vecs.point);
  return { x: vecs.point.x, y: vecs.point.y, z: vecs.point.z };
}

// One row's worth of things that must move together: the text mesh, its readability backing and
// its glow. Rows are read off the line group's own record, so a rebuild of the lyric layer needs
// no matching change here.
function bhCollectFlightRows() {
  var rows = [];
  if (typeof stageLyrics === 'undefined' || !stageLyrics) return rows;
  var hosts = [];
  if (stageLyrics.current) hosts.push({ group: stageLyrics.current, active: true });
  var outgoing = stageLyrics.outgoing || [];
  for (var i = 0; i < outgoing.length; i++) hosts.push({ group: outgoing[i], active: false });
  for (var h = 0; h < hosts.length; h++) {
    var group = hosts[h].group;
    var data = group.userData && group.userData.lyric;
    if (!data) continue;
    var groupLine = data.trackTargetLineIndex != null && isFinite(Number(data.trackTargetLineIndex))
      ? Number(data.trackTargetLineIndex)
      : Number(stageLyrics.currentIdx);
    if (Array.isArray(data.rowLayers) && data.rowLayers.length) {
      for (var r = 0; r < data.rowLayers.length; r++) {
        var row = data.rowLayers[r];
        if (!row || !row.mesh || !row.mesh.parent) continue;
        rows.push({
          mesh: row.mesh,
          mirrors: [row.readability, row.glow],
          lineIndex: row.lineIndex != null && isFinite(Number(row.lineIndex)) ? Number(row.lineIndex) : groupLine,
          isActive: !!row.isActive && hosts[h].active
        });
      }
      continue;
    }
    // The single-line build has no row bundle: the group itself is the unit, and its own children
    // (backing, glow) travel with it.
    if (!group.parent) continue;
    rows.push({ mesh: group, mirrors: [], lineIndex: groupLine, isActive: hosts[h].active });
  }
  return rows;
}

function bhCaptureCameraBasis() {
  var vecs = bhEnsureScratch();
  if (typeof camera === 'undefined' || !camera || !vecs) return null;
  camera.getWorldDirection(vecs.dir);
  vecs.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  vecs.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  blackHoleFlight.basis = {
    p: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    dir: { x: vecs.dir.x, y: vecs.dir.y, z: vecs.dir.z },
    right: { x: vecs.right.x, y: vecs.right.y, z: vecs.right.z },
    up: { x: vecs.up.x, y: vecs.up.y, z: vecs.up.z }
  };
  return blackHoleFlight.basis;
}

// Where a row appears: on a plane close to the camera, off the edge of the frame, on the side its
// line index asks for. Being near the camera is what makes it arrive huge - the shrinking is the
// projection doing it, not a fake scale curve.
function bhEntryWorld(lineIndex, frame) {
  var basis = blackHoleFlight.basis || bhCaptureCameraBasis();
  if (!basis || !frame) return null;
  var near = bhClamp(bhParam('startNear'), 0.4, 6);
  var spread = bhClamp(bhParam('sideSpread'), 1, 20);
  var planeH = Math.tan((frame.fovDeg * Math.PI / 180) * 0.5) * near;
  var lateral = bhSideForLineIndex(lineIndex) * spread * planeH * (frame.aspect || 1) * 0.5;
  var vertical = planeH * 0.06;
  return {
    x: basis.p.x + basis.dir.x * near + basis.right.x * lateral + basis.up.x * vertical,
    y: basis.p.y + basis.dir.y * near + basis.right.y * lateral + basis.up.y * vertical,
    z: basis.p.z + basis.dir.z * near + basis.right.z * lateral + basis.up.z * vertical
  };
}

// Called after updateStageLyrics3D (the app has by then chosen every row's position) and before
// the pass renders (so the displacement is inside the target the lens refracts).
function updateBlackHoleLyricFlight(dt) {
  if (!blackHolePresetIsActive()) return false;
  var frame = blackHoleState.frame || bhComputeFrame();
  if (!frame || !frame.uv) return false;
  if (typeof stageLyrics === 'undefined' || !stageLyrics || !stageLyrics.group) return false;
  var vecs = bhEnsureScratch();
  if (!vecs || !bhCaptureCameraBasis()) return false;
  stageLyrics.group.updateMatrixWorld(true);
  var time = blackHoleFlight.time;
  var flyIn = Math.max(0.05, bhParam('flyIn'));
  var swallowDur = Math.max(0.05, bhParam('swallow'));
  var curve = bhParam('fallCurve');
  var counts = { entering: 0, swallowing: 0, holding: 0 };
  var rows = bhCollectFlightRows();
  for (var i = 0; i < rows.length; i++) {
    var item = rows[i];
    var mesh = item.mesh;
    var parent = mesh.parent;
    var state = mesh.userData.bhFlight;
    if (!state) {
      state = mesh.userData.bhFlight = {
        bornAt: time,
        lineIndex: item.lineIndex,
        wasActive: !!item.isActive,
        exitAt: 0,
        disp: { x: 0, y: 0, z: 0 }
      };
      // A row that appears already being sung did not arrive on screen: start it at the hold.
      if (item.isActive) state.bornAt = time - flyIn;
    }
    if (!item.isActive && state.wasActive && !state.exitAt) state.exitAt = time;
    if (item.isActive) state.wasActive = true;
    // The app can hand a mesh back to service as a new sung line. Its old displacement would be
    // read as part of the new row's position, so a recycled row is handed back and re-enters.
    if (item.isActive && state.exitAt) {
      state.exitAt = 0;
      state.bornAt = time - flyIn;
      state.disp = { x: 0, y: 0, z: 0 };
      mesh.visible = true;
    }
    var prev = state.disp;
    var hold = { x: mesh.position.x - prev.x, y: mesh.position.y - prev.y, z: mesh.position.z - prev.z };
    var phase = null;
    if (time - state.bornAt < flyIn) {
      var entryWorld = bhEntryWorld(state.lineIndex, frame);
      if (entryWorld) {
        vecs.point.set(entryWorld.x, entryWorld.y, entryWorld.z);
        parent.worldToLocal(vecs.point);
        state.entry = { x: vecs.point.x, y: vecs.point.y, z: vecs.point.z };
        phase = { stage: 'enter', u: (time - state.bornAt) / flyIn };
      }
    } else if (state.exitAt) {
      phase = { stage: 'swallow', u: (time - state.exitAt) / swallowDur, curve: curve };
    }
    // The entry point only matters on the way in: a row that was already being sung when the
    // preset came up has no entry point, and that must not keep it out of the hole later.
    if (phase && phase.stage === 'enter' && !state.entry) phase = null;
    var offset = phase
      ? bhFlightOffset(hold, state.entry || hold, bhHoleLocal(parent, frame, vecs), phase)
      : null;
    var next = offset || { x: 0, y: 0, z: 0 };
    mesh.position.set(hold.x + next.x, hold.y + next.y, hold.z + next.z);
    // The text is drawn without a depth test, so the order decides what covers what: an arriving
    // row is nearer than the stage, a falling row is behind it.
    if (offset) mesh.renderOrder = phase.stage === 'enter' ? 45 : 41;
    var delta = { x: next.x - prev.x, y: next.y - prev.y, z: next.z - prev.z };
    for (var m = 0; m < item.mirrors.length; m++) {
      var mirror = item.mirrors[m];
      if (!mirror || !mirror.position) continue;
      mirror.position.x += delta.x;
      mirror.position.y += delta.y;
      mirror.position.z += delta.z;
      mirror.renderOrder = mesh.renderOrder - 0.04;
    }
    state.disp = next;
    if (offset) counts[phase.stage === 'enter' ? 'entering' : 'swallowing']++;
    else counts.holding++;
    if (phase && phase.stage === 'swallow' && phase.u >= 1 && bhFallDistance(1, 1, curve) <= 0) mesh.visible = false;
  }
  blackHoleFlight.units = rows.length;
  blackHoleFlight.entering = counts.entering;
  blackHoleFlight.swallowing = counts.swallowing;
  blackHoleFlight.holding = counts.holding;
  blackHoleState.frame = frame;
  return true;
}
