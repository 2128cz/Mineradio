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
  passScale: { def: 1, min: 0.5, max: 1, kind: 'ratio', rebuild: 'pass' },
  // The field is this preset's own galaxy, not the app's cover particles: density, size and the
  // branch count rebuild the buffer, brightness / spin / haze are read every frame.
  galaxyDensity: { def: 2600, min: 300, max: 6000, kind: 'count', rebuild: 'field' },
  galaxyRadius: { def: 4.4, min: 1.2, max: 12, kind: 'unit', rebuild: 'field' },
  galaxyPitch: { def: 1.35, min: 0.2, max: 4, kind: 'ratio', rebuild: 'field' },
  galaxyBranches: { def: 2, min: 1, max: 4, kind: 'count', rebuild: 'field' },
  galaxyArmWidth: { def: 0.16, min: 0.02, max: 0.5, kind: 'ratio', rebuild: 'field' },
  galaxySpin: { def: 0.55, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  galaxyGlow: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  nebulaAmount: { def: 0.7, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' }
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

// The lens' radial measure for one pixel: the perpendicular distance from the hole to the eye ray
// that passes through that pixel - the impact parameter - expressed as a Kerr-Schild radius, so
// the spin flattens the silhouette along the spin axis instead of leaving a circle.
//
// This is not the KS radius of the point on the screen plane. That one is always at least the
// plane's own distance from the hole (6.4 in the default units), which is larger than the horizon
// radius (1.16), so no pixel could ever be inside the shadow and the bend came out as a faint
// smear. Found with the live silhouette instrument, not in the unit test: the algebra was right
// and the geometry handed to it was wrong.
function bhImpactRadius(qx, qy, planeZ, spinA) {
  var denom = Math.sqrt(qx * qx + qy * qy + planeZ * planeZ);
  var along = planeZ / Math.max(1e-4, denom);
  return bhKerrSchildRadius(qx * along, qy * along, 0, spinA);
}

// Predicted shadow silhouette. Directions are unit vectors in the shader's own q space (x in
// half-widths, y in half-heights), so an isotropic kernel stays isotropic here and an oblate one
// shows up as equatorial > polar. s is the boundary in the kernel's normalized units; du/dv are
// the same boundary in viewport uv, which is what a pixel measurement can be compared against.
function bhSilhouette(stepAngles) {
  var radii = bhHorizonRadii(bhParam('spin'), bhParam('charge'));
  var uScale = bhClamp(bhParam('mass'), 0.005, 0.9) / BH_MASS_UNIT;
  var planeZ = bhPlaneZ((typeof camera !== 'undefined' && camera) ? camera.fov : 58) / uScale;
  var aspect = (typeof camera !== 'undefined' && camera && camera.aspect) ? camera.aspect : 1.78;
  var cap = radii.rp * bhClamp(bhParam('shadowScale'), 1, 2);
  var rays = [];
  var count = Math.max(1, Math.round(Number(stepAngles) || 8));
  for (var i = 0; i < count; i++) {
    var ang = i * Math.PI * 2 / count;
    var cx = Math.cos(ang), cy = Math.sin(ang);
    var lo = 0, hi = planeZ * 0.999;
    if (bhImpactRadius(cx * hi, cy * hi, planeZ, radii.a) < cap) {
      rays.push({ s: hi, du: hi * uScale * cx / aspect, dv: hi * uScale * cy, angle: ang });
      continue;
    }
    for (var it = 0; it < 48; it++) {
      var mid = (lo + hi) * 0.5;
      if (bhImpactRadius(cx * mid, cy * mid, planeZ, radii.a) < cap) lo = mid; else hi = mid;
    }
    var s = (lo + hi) * 0.5;
    rays.push({ s: s, du: s * uScale * cx / aspect, dv: s * uScale * cy, angle: ang });
  }
  return { cap: cap, radii: radii, planeZ: planeZ, aspect: aspect, uScale: uScale, rays: rays };
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
  // The impact parameter: the perpendicular distance from the hole to the eye ray through this
  // pixel, as a Kerr-Schild radius so the silhouette is flattened along the spin axis. This is
  // deliberately not ksRadius of the point on the screen plane - that measure never falls inside
  // the horizon at any pixel, and the shadow would silently never be drawn.
  float denom = sqrt(nq.x * nq.x + nq.y * nq.y + pz * pz);
  vec3 impactPoint = vec3(nq.x, nq.y, 0.0) * (pz / max(denom, 1e-4));
  float rPlane = ksRadius(impactPoint.x, impactPoint.y, 0.0, a);

  // Bend ~ rp*r / b (the 1/b of weak lensing), floored at the shadow's rim so nothing samples
  // from inside the horizon.
  float b = max(rPlane, cap * 0.92);
  vec2 dir = nq / max(length(nq), 1e-5);
  vec2 src = nq + dir * (uDeflect * horizon * rp * rp / b);

  // Frame dragging: the azimuthal half of the Lense-Thuring term, ~ a*rp/b.
  float drag = uSwirl * a * rp / b * horizon;
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
  // The field is built here rather than in the render path: a structural knob only changes a
  // string key, and rebuilding a buffer between two draws would hitch the frame it lands on.
  if (blackHoleState.frame) bhBuildGalaxy(false);
  return true;
}

// A shader that will not compile is the one failure of this preset that cannot be caught offline,
// and three does not throw for it: it writes a console.error and skips or garbles the draw. The
// first quad draw of the pass is therefore wrapped so the message is captured, reported in
// blackHoleStatus().error, and the frame handed back to the plain renderer.
function bhCaptureShaderErrors(action) {
  var captured = [];
  var original = console.error;
  if (typeof original !== 'function') { action(); return captured; }
  console.error = function () {
    captured.push(String((arguments && arguments[0]) || '').slice(0, 300));
    return original.apply(console, arguments);
  };
  try {
    action();
  } finally {
    console.error = original;
  }
  return captured.filter(function (line) { return /Shader Error|WebGLProgram|WebGL: /.test(line); });
}

// Returns false when the caller must render the plain way: no pass yet, or the hole has ended up
// behind the eye (the user can drag the camera past it), where the projection is undefined.
function renderBlackHoleFrame() {
  if (!blackHolePresetIsActive()) return false;
  if (!blackHoleState.rt && !bhBuildPass()) return false;
  var frame = blackHoleState.frame || bhComputeFrame();
  // The field is built here as well as in the camera pass: at startup the preset is restored
  // without going through setPreset, and with nothing playing the loop can be parked - the first
  // real frame must not be a frame without a galaxy.
  if (frame && frame.uv && !bhGalaxy.group) bhBuildGalaxy(true);
  if (!frame || !frame.uv || !bhEnsureScratch()) {
    blackHoleState.fallbacks++;
    return false;
  }
  bhAlignPassSize();
  bhSyncLens(frame);
  bhPlaceGalaxy(frame, 0);
  var started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  var firstDraw = blackHoleState.draws === 0;
  var shaderErrors = [];
  try {
    renderer.setRenderTarget(blackHoleState.rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    if (firstDraw) {
      shaderErrors = bhCaptureShaderErrors(function () {
        renderer.render(blackHoleState.quadScene, blackHoleState.quadCamera);
      });
    } else {
      renderer.render(blackHoleState.quadScene, blackHoleState.quadCamera);
    }
  } catch (error) {
    blackHoleState.error = String((error && error.message) || error);
    renderer.setRenderTarget(null);
    blackHoleState.fallbacks++;
    return false;
  }
  var ended = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  blackHoleState.lastCostMs = ended - started;
  if (shaderErrors.length) {
    blackHoleState.error = 'shader did not compile: ' + shaderErrors[0];
    bhDisposePass();
    blackHoleState.fallbacks++;
    return false;
  }
  // Older and newer three builds differ on whether the program object is reachable from the
  // material; check it when it is there and rely on the console capture when it is not.
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
    bhBuildGalaxy(true);
  } else if (was) {
    bhDisposeGalaxy();
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
    galaxy: bhGalaxyStatus(),
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
      // The cover particle field is what the other presets paint; this preset brings its own
      // galaxy, so those layers are taken over rather than left under the lens.
      particles: true,
      bloom: true,
      float: true,
      backCover: true,
      starRiver: true,
      ripples: true,
      lyricsParticles: true,
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

// ---------------------------------------------------------------- the galaxy
//
// The user's own cover-particle layers are suppressed while this preset is on (that is what the
// ring's "深海绽放" look was), so the field here is the preset's own: a barred spiral - a bar, two
// arms leaving its ends, and those arms branching into further segments outside a split radius.
//
// Two rules the rest of the file keeps:
//   - the pattern is deterministic and the *placement* is not: a segment's angle comes from the
//     model, the sample inside it comes from a seeded RNG, so the arms read as arms and not as a
//     lattice;
//   - the field is built around the hole's own world point (bhComputeFrame().world), and the lens
//     is centred on that point's projection. One source, so "the hole sits in the middle of the
//     galaxy" cannot drift out of alignment the way two independently-tracked centres would.
var BH_GALAXY_MODEL = {
  barLength: 0.26,      // the bar, in units of the field's outer radius
  split: 0.52,         // inside it: the bar plus two arms; outside: the arms branch
  barAngle: 0.0,
  branchStartSpread: 0.34,
  branchWind: 0.55
};

// The segments of the pattern, as a function of the knobs rather than of a random draw: inner
// arms exist from the bar ends outward, and each of them throws off `branches` further segments
// starting at staggered radii. Pure, so the two-arm-inside / multi-segment-outside claim is a
// testable statement and not a description of a picture.
function bhGalaxySegments(branches) {
  var count = Math.max(1, Math.round(Number(branches) || 2));
  var segments = [];
  for (var arm = 0; arm < 2; arm++) {
    var root = BH_GALAXY_MODEL.barAngle + arm * Math.PI;
    segments.push({ arm: arm, kind: 'inner', r0: BH_GALAXY_MODEL.barLength, r1: 1, root: root, offset: 0 });
    for (var b = 0; b < count; b++) {
      var start = BH_GALAXY_MODEL.split + (0.06 + 0.11 * b) + arm * 0.035;
      if (start >= 0.98) continue;
      segments.push({
        arm: arm,
        kind: 'branch',
        branch: b,
        // Branches fan away from the arm they came from and keep winding, so they read as
        // separate segments rather than as one wider arm.
        offset: (b + 1) * BH_GALAXY_MODEL.branchStartSpread * (arm === 0 ? 1 : -1),
        wind: BH_GALAXY_MODEL.branchWind * (b + 1) * (arm === 0 ? 1 : -1),
        r0: start,
        r1: Math.min(1, start + 0.30 + 0.09 * b),
        root: root
      });
    }
  }
  return segments;
}

// A seeded RNG: the field has to be reproducible, or every rebuild (a knob move, a resize) would
// shuffle the galaxy and the "pattern" claim could not be checked against anything.
function bhGalaxyRandom(seed) {
  var state = (Number(seed) || 1) % 2147483647;
  if (state <= 0) state += 2147483646;
  return function () {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// The arm angle at a radius: a logarithmic spiral (wind proportional to ln(r/rBar)), which is what
// keeps the pitch of the arms constant in the way real spirals do.
function bhGalaxyArmAngle(root, radius, pitch) {
  var inner = Math.max(1e-3, radius);
  return root + (Number(pitch) || 1.35) * Math.log(inner / Math.max(1e-3, BH_GALAXY_MODEL.barLength) + 1);
}

// Which segments are alive at a radius, and where they sit: the count is 2 inside the split and
// grows past it as the branches start.
function bhGalaxyArmOffsets(radius, params) {
  var pitch = params ? params.pitch : 1.35;
  var branches = params ? params.branches : 2;
  // Inside the bar radius the "arms" are the bar itself: two lobes at opposite ends.
  if (radius < BH_GALAXY_MODEL.barLength) {
    return [BH_GALAXY_MODEL.barAngle, BH_GALAXY_MODEL.barAngle + Math.PI];
  }
  var segments = bhGalaxySegments(branches);
  var out = [];
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (radius < seg.r0 || radius > seg.r1) continue;
    var angle = bhGalaxyArmAngle(seg.root, radius, pitch);
    if (seg.kind === 'branch') angle += seg.offset + seg.wind * (radius - seg.r0);
    out.push(angle);
  }
  return out;
}

// One particle: a segment is chosen by area, then the radius and the angular scatter come from the
// RNG. Thickness falls with radius (a disc that flares a little at the rim), colour warms inward.
function bhGalaxyPoint(index, rand, params) {
  var segments = bhGalaxySegments(params.branches);
  var total = 0;
  var weights = [];
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    var weight = Math.max(0.02, seg.r1 * seg.r1 - seg.r0 * seg.r0);
    weights.push(weight);
    total += weight;
  }
  var pick = rand() * total;
  var chosen = segments[segments.length - 1];
  for (var w = 0; w < segments.length; w++) {
    pick -= weights[w];
    if (pick <= 0) { chosen = segments[w]; break; }
  }
  var radius = Math.sqrt(chosen.r0 * chosen.r0 + rand() * rand() * Math.max(0, chosen.r1 * chosen.r1 - chosen.r0 * chosen.r0));
  radius = Math.min(1, Math.max(0.02, radius));
  var angle = bhGalaxyArmAngle(chosen.root, radius, params.pitch);
  if (chosen.kind === 'branch') angle += chosen.offset + chosen.wind * (radius - chosen.r0);
  // Arms are wider relative to their own length at the outside, and branches are looser than the
  // main arms - otherwise the whole field reads as two hard lines.
  var spread = params.armWidth * (0.45 + radius * 0.85) * (chosen.kind === 'branch' ? 1.45 : 1);
  var scatter = (rand() + rand() + rand() - 1.5) * spread;
  // A quarter of the field is inter-arm: halo stars and diffuse haze, so the arms sit in a
  // background instead of floating on black.
  if (rand() < 0.24) {
    radius = Math.pow(rand(), 0.6);
    angle += (rand() - 0.5) * Math.PI * 0.9;
    scatter = 0;
  }
  var z = (rand() - 0.5) * params.thickness * (1.35 - radius * 0.75) * (chosen.kind === 'branch' ? 1.5 : 1);
  var warmth = Math.max(0, Math.min(1, 1.15 - radius * 1.1));
  var bright = 0.35 + rand() * 0.65;
  if (rand() < 0.02) bright *= 3.1;   // a few HII knots, bright and pinkish
  return {
    radius: radius,
    angle: angle + scatter,
    z: z,
    size: (0.35 + Math.pow(rand(), 3) * 1.9) * (rand() < 0.04 ? 3.4 : 1),
    warmth: warmth,
    bright: bright,
    knot: radius,
    seed: rand()
  };
}

// ---------------------------------------------------------------- the galaxy, in the scene
//
// Built as THREE.Points whose positions are computed in the vertex shader from per-particle
// (radius, angle, height, size, colour). That is what buys differential rotation - inner turns
// faster, so the arms wind up slowly while the pattern holds - without touching the buffer every
// frame, and it keeps the field inside the render target the lens refracts.
var bhGalaxy = { group: null, bands: [], key: '', count: 0, hazeCount: 0, error: '' };

function bhGalaxyParams() {
  return {
    density: Math.round(bhClamp(bhParam('galaxyDensity'), 200, 6000)),
    radius: bhClamp(bhParam('galaxyRadius'), 0.6, 14),
    pitch: bhClamp(bhParam('galaxyPitch'), 0.2, 4),
    branches: Math.round(bhClamp(bhParam('galaxyBranches'), 1, 4)),
    armWidth: bhClamp(bhParam('galaxyArmWidth'), 0.02, 0.5),
    thickness: 0.075,
    spin: bhClamp(bhParam('galaxySpin'), 0, 3),
    glow: bhClamp(bhParam('galaxyGlow'), 0, 2.5),
    haze: bhClamp(bhParam('nebulaAmount'), 0, 1.5)
  };
}

// Warm core, blue-white arms, pinkish knots: the palette is the app's own lyric palette's
// neighbourhood rather than a second colour scheme invented here.
function bhGalaxyColour(point) {
  var warm = point.warmth;
  var red = 0.55 + warm * 0.45;
  var green = 0.45 + warm * 0.30 + (1 - warm) * 0.22;
  var blue = 0.42 + (1 - warm) * 0.58;
  if (point.knot > 0.35 && point.bright > 2) { red = 1.0; green = 0.45; blue = 0.72; }
  var gain = Math.min(3.2, point.bright);
  return [red * gain, green * gain, blue * gain];
}

// Two rings, two speeds: the inner band turns faster than the outer one, which is the cheap
// version of differential rotation (a real disc shears continuously; a PointsMaterial cannot, and
// a custom vertex shader for it turned into a silent "drawn but invisible" on this three build -
// the field has to be visible, so it uses the material the rest of the app already proves works).
var BH_GALAXY_BANDS = [
  { key: 'inner', rate: 1.0, maxRadius: 0.55 },
  { key: 'outer', rate: 0.55, maxRadius: 1.01 }
];

function bhGalaxyBandOf(point) {
  for (var i = 0; i < BH_GALAXY_BANDS.length; i++) {
    if (point.radius < BH_GALAXY_BANDS[i].maxRadius) return i;
  }
  return BH_GALAXY_BANDS.length - 1;
}

function bhGalaxyColours(point) {
  var warm = point.warmth;
  var red = 0.55 + warm * 0.45;
  var green = 0.45 + warm * 0.30 + (1 - warm) * 0.22;
  var blue = 0.42 + (1 - warm) * 0.58;
  if (point.knot > 0.35 && point.bright > 2) { red = 1.0; green = 0.45; blue = 0.72; }
  var gain = Math.min(3.2, point.bright) * 0.55;
  return [red * gain, green * gain, blue * gain];
}

// Positions are written once: the pattern is static in the band's own frame and the band turns.
// Haze is the same samples at a bigger size and a colder colour, so it tracks the arms exactly.
function bhGalaxyGeometry(points, params, haze) {
  var count = points.length;
  var position = new Float32Array(count * 3);
  var colour = new Float32Array(count * 3);
  for (var i = 0; i < count; i++) {
    var point = points[i];
    var radius = point.radius * params.radius;
    position[i * 3] = Math.cos(point.angle) * radius;
    position[i * 3 + 1] = Math.sin(point.angle) * radius;
    position[i * 3 + 2] = point.z * params.radius;
    var rgb = haze
      ? [0.30 + point.warmth * 0.24, 0.26 + point.warmth * 0.12, 0.46 + (1 - point.warmth) * 0.22]
      : bhGalaxyColours(point);
    colour[i * 3] = rgb[0];
    colour[i * 3 + 1] = rgb[1];
    colour[i * 3 + 2] = rgb[2];
  }
  var geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colour, 3));
  return geometry;
}

function bhGalaxyMaterial(params, haze) {
  var material = new THREE.PointsMaterial({
    size: params.radius * (haze ? 0.055 : 0.012),
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: haze ? bhClamp(params.haze, 0, 1.5) * 0.55 : bhClamp(params.glow, 0, 2.5)
  });
  material.userData.bhHaze = !!haze;
  return material;
}

function bhDisposeGalaxy() {
  if (bhGalaxy.group && bhGalaxy.group.parent) bhGalaxy.group.parent.remove(bhGalaxy.group);
  (bhGalaxy.bands || []).forEach(function (band) {
    [band.stars, band.haze].forEach(function (object) {
      if (!object) return;
      if (object.geometry && object.geometry.dispose) object.geometry.dispose();
      if (object.material && object.material.dispose) object.material.dispose();
    });
  });
  bhGalaxy.group = null;
  bhGalaxy.bands = [];
  bhGalaxy.key = '';
  bhGalaxy.count = 0;
  bhGalaxy.hazeCount = 0;
}

function bhBuildGalaxy(force) {
  if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene) return false;
  var params = bhGalaxyParams();
  var key = [params.density, params.radius, params.pitch, params.branches, params.armWidth].join(':');
  if (bhGalaxy.group && bhGalaxy.key === key && !force) {
    // Brightness and haze only move what the materials already read; the buffers stay.
    (bhGalaxy.bands || []).forEach(function (band) {
      if (band.stars) band.stars.material.opacity = bhClamp(params.glow, 0, 2.5);
      if (band.haze) band.haze.material.opacity = bhClamp(params.haze, 0, 1.5) * 0.55;
    });
    return true;
  }
  var rand = bhGalaxyRandom(20261030);
  var buckets = BH_GALAXY_BANDS.map(function () { return { points: [], haze: [] }; });
  for (var i = 0; i < params.density; i++) {
    var point = bhGalaxyPoint(i, rand, params);
    var bucket = buckets[bhGalaxyBandOf(point)];
    bucket.points.push(point);
    if (i % 6 === 0) bucket.haze.push(point);
  }
  try {
    bhDisposeGalaxy();
    var group = new THREE.Group();
    group.frustumCulled = false;
    var bands = [];
    buckets.forEach(function (bucket, index) {
      if (!bucket.points.length) return;
      var band = BH_GALAXY_BANDS[index];
      var stars = new THREE.Points(bhGalaxyGeometry(bucket.points, params, false), bhGalaxyMaterial(params, false));
      var haze = new THREE.Points(bhGalaxyGeometry(bucket.haze, params, true), bhGalaxyMaterial(params, true));
      stars.frustumCulled = false;
      haze.frustumCulled = false;
      stars.renderOrder = 6;
      haze.renderOrder = 5;
      group.add(haze);
      group.add(stars);
      bands.push({ key: band.key, rate: band.rate, stars: stars, haze: haze, rotation: 0 });
    });
    scene.add(group);
    bhGalaxy.group = group;
    bhGalaxy.bands = bands;
    bhGalaxy.key = key;
    bhGalaxy.count = params.density;
    bhGalaxy.hazeCount = buckets.reduce(function (sum, bucket) { return sum + bucket.haze.length; }, 0);
    return true;
  } catch (error) {
    bhGalaxy.error = String((error && error.message) || error);
    bhDisposeGalaxy();
    return false;
  }
}

// One centre for the whole preset: the field sits on the hole's own world point and faces the
// camera; the lens is centred on that point's projection, so the hole is in the middle of the
// galaxy by construction rather than by two numbes that happen to agree.
function bhPlaceGalaxy(frame, dt) {
  if (!bhGalaxy.group) return false;
  bhGalaxy.group.position.set(frame.world.x, frame.world.y, frame.world.z);
  if (typeof camera !== 'undefined' && camera) bhGalaxy.group.quaternion.copy(camera.quaternion);
  var params = bhGalaxyParams();
  var spin = bhClamp(params.spin, 0, 3);
  (bhGalaxy.bands || []).forEach(function (band) {
    // Bands carry their own angular speed, so the inner arms lap the outer ones.
    band.rotation -= (Number(dt) || 0) * spin * band.rate * 0.5;
    band.stars.rotation.z = band.rotation;
    band.haze.rotation.z = band.rotation;
  });
  return true;
}

function bhGalaxyStatus() {
  return {
    built: !!bhGalaxy.group,
    stars: bhGalaxy.count,
    haze: bhGalaxy.hazeCount,
    bands: (bhGalaxy.bands || []).length,
    key: bhGalaxy.key,
    armsInside: bhGalaxyArmOffsets(0.4, { pitch: bhParam('galaxyPitch'), branches: bhParam('galaxyBranches') }).length,
    armsOutside: bhGalaxyArmOffsets(0.95, { pitch: bhParam('galaxyPitch'), branches: bhParam('galaxyBranches') }).length,
    error: bhGalaxy.error || ''
  };
}
