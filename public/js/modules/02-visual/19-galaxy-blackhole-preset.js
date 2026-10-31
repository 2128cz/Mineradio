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
  // World units: the hole is a scene point, so these are positions in the scene and the horizon
  // radius is a length, not a fraction of the viewport.
  holeX: { def: 0.0, min: -8, max: 8, kind: 'unit', rebuild: 'live' },
  holeY: { def: -0.35, min: -6, max: 6, kind: 'unit', rebuild: 'live' },
  holeDepth: { def: 0, min: -8, max: 8, kind: 'unit', rebuild: 'live' },
  mass: { def: 0.30, min: 0.02, max: 6, kind: 'unit', rebuild: 'live' },
  spin: { def: 0.7, min: -1, max: 1, kind: 'ratio', rebuild: 'live' },
  charge: { def: 0, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  deflect: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  shadowScale: { def: 1, min: 0.5, max: 1.6, kind: 'ratio', rebuild: 'live' },
  swirl: { def: 1, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  ringGlow: { def: 0.45, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  // The accretion disc is horizontal (a small tilt only, so it is seen slightly from above), and its
  // radii are world lengths like every other size in this preset.
  discInner: { def: 0.45, min: 0.02, max: 12, kind: 'unit', rebuild: 'live' },
  discOuter: { def: 1.70, min: 0.05, max: 24, kind: 'unit', rebuild: 'live' },
  discTilt: { def: 14, min: -60, max: 60, kind: 'deg', rebuild: 'live' },
  discGain: { def: 0.85, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  // The disc is a volume of this world thickness: the camera can be inside it and still see it.
  discThickness: { def: 0.12, min: 0.01, max: 6, kind: 'unit', rebuild: 'live' },
  // How much the disc's density field is wispy rather than a smooth glow: 0 is a uniform slab,
  // 1 is the default filament field, above that the voids get deeper and the filaments sharper.
  discWisp: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  // One softness for the whole backdrop: the galaxy, the streaks and the glow move together.
  // Radial blur of the star field, in pixels: a little is depth, a lot is a smeared plate.
  softness: { def: 3, min: 0, max: 6, kind: 'px', rebuild: 'live' },
  cameraDrift: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  debris: { def: 0.6, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  marchSteps: { def: 160, min: 24, max: 256, kind: 'count', rebuild: 'live' },
  // How much the lyric layer is bent by the same field it is drawn into; 0 keeps it straight.
  textLens: { def: 1, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  skyStars: { def: 0.35, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  skyBand: { def: 0.12, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  // A long lens: the narrower the fov, the flatter the perspective and the more the hole reads as
  // a distant object with mass rather than as something close and small.
  fovDeg: { def: 40, min: 24, max: 92, kind: 'deg', rebuild: 'live' },
  sideSpread: { def: 6.2, min: 2.5, max: 14, kind: 'unit', rebuild: 'lyric' },
  startNear: { def: 1.6, min: 0.7, max: 4, kind: 'unit', rebuild: 'lyric' },
  flyIn: { def: 0.75, min: 0.15, max: 2.5, kind: 'sec', rebuild: 'live' },
  swallow: { def: 1.4, min: 0.2, max: 3, kind: 'sec', rebuild: 'live' },
  fallCurve: { def: 0.5, min: 0.25, max: 1.6, kind: 'ratio', rebuild: 'live' },
  passScale: { def: 1, min: 0.5, max: 1, kind: 'ratio', rebuild: 'pass' },
  // The field is this preset's own galaxy, not the app's cover particles: density, size and the
  // branch count rebuild the buffer, brightness / spin / haze are read every frame.
  galaxyDensity: { def: 12000, min: 1000, max: 40000, kind: 'count', rebuild: 'field' },
  // Wider than the frame on purpose: a galaxy whose whole disc sat inside the lens's strong-bend
  // annulus would be drawn as that annulus (only a ring), so the outer arms have to live outside it.
  galaxyRadius: { def: 5.5, min: 0.8, max: 20, kind: 'unit', rebuild: 'field' },
  galaxyPitch: { def: 1.35, min: 0.2, max: 4, kind: 'ratio', rebuild: 'field' },
  galaxyBranches: { def: 2, min: 1, max: 4, kind: 'count', rebuild: 'field' },
  galaxyArmWidth: { def: 0.16, min: 0.02, max: 0.5, kind: 'ratio', rebuild: 'field' },
  galaxySpin: { def: 0.55, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  galaxyGlow: { def: 0.7, min: 0, max: 2.5, kind: 'ratio', rebuild: 'live' },
  nebulaAmount: { def: 0.7, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  // The lyrics orbit inside the accretion disc's plane, so "where they are" is a world circle, not
  // a screen offset: lyricOrbit is its radius in scene units, lyricOrbitRate how fast a line comes
  // round (radians per second), lyricWind how many extra radians it turns while falling in.
  lyricOrbit: { def: 2.4, min: 0.4, max: 12, kind: 'unit', rebuild: 'live' },
  lyricOrbitRate: { def: 0.5, min: 0.05, max: 2, kind: 'ratio', rebuild: 'live' },
  lyricWind: { def: 5.0, min: 0, max: 8, kind: 'ratio', rebuild: 'live' },
  lyricDrift: { def: 0.25, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' }
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

// Predicted shadow silhouette for the marched pass: a circle of 3*sqrt(3)/2 horizon radii, which is
// the critical impact parameter of the Schwarzschild field the march integrates. Directions are unit
// vectors in q space (x in half-widths, y in half-heights) so a pixel measurement can walk the same
// rays; `s` is in horizon radii and du/dv are the same boundary in viewport uv.
function bhSilhouette(stepAngles) {
  var frame = bhComputeFrame();
  if (!frame) return null;
  var aspects = frame.aspect || 1.78;
  var uScale = frame.scale;
  var cap = 2.598076 * bhClamp(bhParam('shadowScale'), 0.5, 1.6);
  var rays = [];
  var count = Math.max(1, Math.round(Number(stepAngles) || 8));
  for (var i = 0; i < count; i++) {
    var ang = i * Math.PI * 2 / count;
    var cx = Math.cos(ang), cy = Math.sin(ang);
    rays.push({ s: cap, du: cap * uScale * cx / aspects, dv: cap * uScale * cy, angle: ang });
  }
  return { cap: cap, radii: frame.radii, planeZ: frame.planeZ, aspect: aspects, uScale: uScale, rays: rays };
}

// The same integration as the shader, in JS: a photon in the Schwarzschild field feels
// a = -1.5 h^2 r / |r|^5. Kept here so the deflection and the capture test can be checked as
// arithmetic instead of by eye.
function bhMarchRay(origin, dir, options) {
  options = options || {};
  var steps = Math.max(4, Math.round(Number(options.steps) || 110));
  var deflect = options.deflect === undefined ? 1 : Number(options.deflect);
  var inner = Number(options.discInner) || 2.2;
  var outer = Number(options.discOuter) || 7.5;
  var thickness = options.discThickness === undefined ? 0.9 : Number(options.discThickness);
  var tilt = Number(options.discTilt) || 0.14;
  var n = { x: Math.sin(tilt), y: Math.cos(tilt), z: 0 };
  var pos = { x: origin.x, y: origin.y, z: origin.z };
  var vel = { x: dir.x, y: dir.y, z: dir.z };
  var cross = {
    x: pos.y * vel.z - pos.z * vel.y,
    y: pos.z * vel.x - pos.x * vel.z,
    z: pos.x * vel.y - pos.y * vel.x
  };
  var h2 = cross.x * cross.x + cross.y * cross.y + cross.z * cross.z;
  var captured = false;
  var optical = 0;
  var used = 0;
  var halfThick = Math.max(0.002, thickness * 0.5);
  for (var i = 0; i < steps; i++) {
    used = i + 1;
    var r2 = pos.x * pos.x + pos.y * pos.y + pos.z * pos.z;
    if (r2 < 1) { captured = true; break; }
    if (r2 > 3600 && pos.x * vel.x + pos.y * vel.y + pos.z * vel.z > 0) break;
    var r = Math.sqrt(r2);
    var dt = Math.min(0.38, Math.max(0.008, 0.05 * r)) * deflect;
    var k = -1.5 * h2 / (r2 * r2 * r) * dt;
    vel.x += pos.x * k; vel.y += pos.y * k; vel.z += pos.z * k;
    // The disc is a slab: every step that is inside it contributes, which is what gives the fog
    // its thickness in the shader. The twin records the same optical depth.
    var side = pos.x * n.x + pos.y * n.y + pos.z * n.z;
    if (Math.abs(side) < halfThick && r > inner && r < outer) {
      var vert = 1 - Math.abs(side) / halfThick;
      var rn = Math.min(1, Math.max(0, (r - inner) / Math.max(0.001, outer - inner)));
      optical += vert * rn * (1 - rn) * dt;
    }
    pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
  }
  var len = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z) || 1;
  return { captured: captured, discOptical: optical, steps: used, dirOut: { x: vel.x / len, y: vel.y / len, z: vel.z / len } };
}

// ---------------------------------------------------------------- the hole on screen
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
// The hole is a point in the scene, not a point glued in front of the camera: dragging or zooming
// the camera has to move it and change its size the way it does for every other element. The knobs
// are therefore world units, and the lens geometry (how wide the shadow is in uv) is derived from
// the distance to that point every frame - so walking away shrinks the hole, walking around it moves
// it across the screen.
function bhComputeFrame() {
  var frame = bhGatherFrame();
  var vecs = bhEnsureScratch();
  if (!frame || !vecs) return null;
  vecs.point.set(
    bhClamp(bhParam('holeX'), -20, 20),
    bhClamp(bhParam('holeY'), -20, 20),
    -bhClamp(bhParam('holeDepth'), -20, 20)
  );
  var world = { x: vecs.point.x, y: vecs.point.y, z: vecs.point.z };
  var projected = bhProjectPoint(world, frame.position, frame.dir, frame.right, frame.up, frame.tanHalfFov, frame.aspect);
  if (!projected) return null;
  var radii = bhHorizonRadii(bhParam('spin'), bhParam('charge'));
  // mass is the outer horizon's radius in world units. Its angular radius in half-height units is
  // r / (distance * tan(fov/2)), and one normalized (M = 0.5) unit is that divided by rp - the same
  // algebra the reference uses, now measured on the scene's own scale instead of the viewport's.
  var horizonWorld = bhClamp(bhParam('mass'), 0.02, 20);
  var angularHorizon = horizonWorld / Math.max(1e-4, projected.distance * frame.tanHalfFov);
  var scale = angularHorizon / Math.max(1e-4, radii.rp);
  return {
    world: world,
    uv: projected,
    distance: projected.distance,
    planeZ: (1 / Math.max(1e-4, frame.tanHalfFov)) / Math.max(1e-4, scale),
    fovDeg: frame.fovDeg,
    aspect: frame.aspect || 1,
    radii: radii,
    scale: scale,
    horizonWorld: horizonWorld,
    camera: { fwd: frame.dir, right: frame.right, up: frame.up, tanHalf: frame.tanHalfFov },
    uvHorizon: angularHorizon,
    // A Schwarzschild shadow is a circle of radius 3*sqrt(3)/2 horizon radii - the critical impact
    // parameter - whatever the spin or charge dials say, because the march integrates the
    // Schwarzschild field.
    uvShadow: 2.598076 * angularHorizon * bhClamp(bhParam('shadowScale'), 0.5, 1.6)
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

// Volumetric version of the pass. The disc is no longer a plane the ray crosses: every step that
// finds itself inside a slab of thickness uDiscThick around the disc plane adds emission and eats
// some transparency, so the disc has depth, the camera can be inside it, and the grain lives in the
// volume. The galaxy is sampled with a *bounded* screen-space bend plus a few taps of blur - a
// direction-based lookup squeezed the whole sky into vertical strips, which is what made the
// background look like a tube.
var BH_PASS_FS = shadertoyFragment(
  [
    'uniform float uTextLens;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uCamFwd;',
    'uniform vec3 uCamRight;',
    'uniform vec3 uCamUp;',
    'uniform float uTanHalf;',
    'uniform float uAspect;',
    'uniform vec2 uCenter;',
    'uniform vec3 uHole;',
    'uniform float uRs;',
    'uniform float uSteps;',
    'uniform float uDeflect;',
    'uniform float uDiscInner;',
    'uniform float uDiscOuter;',
    'uniform float uDiscThick;',
    'uniform float uWisp;',
    'uniform float uDiscTilt;',
    'uniform float uDiscGain;',
    'uniform float uSpin;',
    'uniform float uRing;',
    'uniform float uSoft;',
    'uniform float uShadowUv;',
    'uniform vec2 uShake;',
    'uniform float uDolly;',
    'uniform float uDebris;',
    'uniform float uLevel;',
    '',
    'float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    '',
    '// 3D value noise: the disc fog is sampled at the marched point, so the field has to exist in the',
    '// third dimension or every step along a ray reads the same cell (streaks instead of wisps).',
    'float hash13(vec3 p3) {',
    '  p3 = fract(p3 * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'float noise3(vec3 x) {',
    '  vec3 i = floor(x);',
    '  vec3 f = fract(x);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float n000 = hash13(i);',
    '  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));',
    '  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));',
    '  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));',
    '  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));',
    '  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));',
    '  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));',
    '  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));',
    '  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),',
    '             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);',
    '}',
    'float fbm3(vec3 p) {',
    '  float sum = 0.0;',
    '  float amp = 0.55;',
    '  for (int i = 0; i < 3; i++) {',
    '    sum += amp * noise3(p);',
    '    p = p * 2.07 + vec3(7.3, 1.9, 4.7);',
    '    amp *= 0.5;',
    '  }',
    '  return sum;',
    '}',
    '',
    '// Near debris: sparse specks drifting across the frame, dark bodies with a lit rim on the side',
    '// that faces the disc. They are the reference the eye needs: without something small and close,',
    '// a black hole has no size.',
    'vec4 nearDebris(vec2 uv, float t, float amount) {',
    '  if (amount <= 0.001) return vec4(0.0);',
    '  vec4 outColor = vec4(0.0);',
    '  for (int layer = 0; layer < 2; layer++) {',
    '    float fl = float(layer);',
    '    float scale = mix(6.0, 13.0, fl);',
    '    vec2 drift = vec2(t * (0.011 + 0.007 * fl), -t * (0.005 + 0.004 * fl));',
    '    vec2 p = uv * vec2(iResolution.x / max(1.0, iResolution.y), 1.0) * scale + drift;',
    '    vec2 cell = floor(p);',
    '    float h = hash21(cell + fl * 37.0);',
    '    if (h < 0.90) continue;',
    '    vec2 centre = (vec2(hash21(cell + 1.7), hash21(cell + 4.3)) - 0.5) * 0.55;',
    '    float d = length(fract(p) - 0.5 - centre);',
    '    float size = 0.05 + 0.11 * hash21(cell + 9.1);',
    '    float core = smoothstep(size, size * 0.5, d);',
    '    float rim = max(0.0, smoothstep(size * 1.12, size * 0.78, d) - core);',
    '    vec3 col = vec3(0.015, 0.017, 0.022) + rim * vec3(1.0, 0.62, 0.34);',
    '    float alpha = (core * 0.92 + rim * 0.75) * amount * (0.55 + 0.45 * hash21(cell + 21.0));',
    '    outColor = mix(outColor, vec4(col, alpha), clamp(alpha, 0.0, 1.0));',
    '  }',
    '  return outColor;',
    '}',
    '',
    '// The particle galaxy lives at the hole\'s own depth, so the far-field bend does not apply to it:',
    '// displacing near-field content by tens of pixels is what stretched the frame edges into radial',
    '// streaks. It is sampled where it was drawn, blurred along the radius, and faded at the border so',
    '// the render target\'s edge is never read.',
    'vec3 sampleSky(vec2 uv, float blurPx) {',
    '  vec2 away = uv - uCenter;',
    '  float len = length(away);',
    '  vec2 dir = len > 1e-5 ? away / len : vec2(1.0, 0.0);',
    '  vec2 texel = 1.0 / max(iResolution.xy, vec2(1.0));',
    '  vec3 sum = vec3(0.0);',
    '  for (int i = -2; i <= 2; i++) {',
    '    vec2 o = dir * (float(i) * 0.5 * blurPx) * texel;',
    '    sum += texture2D(iChannel0, clamp(uv + o, 0.02, 0.98)).rgb;',
    '  }',
    '  float edge = smoothstep(0.0, 0.07, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));',
    '  return (sum / 5.0) * edge;',
    '}',
    '',
    '// Distant stars as particles would be drawn: a core plus a four-point glint, twinkling slowly.',
    '// Analytic, so they cost one hash each and stay crisp inside the radial blur that smears the',
    '// galaxy behind them.',
    'vec3 starField(vec2 uv, float t) {',
    '  vec3 col = vec3(0.0);',
    '  for (int layer = 0; layer < 2; layer++) {',
    '    float fl = float(layer);',
    '    float scale = mix(80.0, 160.0, fl);',
    '    vec2 p = uv * vec2(iResolution.x / max(1.0, iResolution.y), 1.0) * scale;',
    '    vec2 cell = floor(p);',
    '    float h = hash21(cell + fl * 13.0);',
    '    if (h < 0.984) continue;',
    '    vec2 centre = (vec2(hash21(cell + 2.3), hash21(cell + 8.1)) - 0.5) * 0.6;',
    '    vec2 d = fract(p) - 0.5 - centre;',
    '    vec2 ad = abs(d);',
    '    float core = exp(-dot(d, d) * 900.0);',
    '    float glint = exp(-ad.x * 240.0) * exp(-ad.y * 22.0)',
    '                + exp(-ad.y * 240.0) * exp(-ad.x * 22.0);',
    '    float twinkle = 0.5 + 0.5 * sin(t * (1.1 + h * 2.6) + h * 31.0);',
    '    col += (vec3(0.86, 0.91, 1.0) * core + vec3(0.62, 0.76, 1.0) * glint * 0.30)',
    '         * (0.45 + 0.75 * hash21(cell + 5.0)) * (0.35 + 0.65 * twinkle);',
    '  }',
    '  return col;',
    '}',
    '',
    'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
    '  vec2 uv = fragCoord.xy / iResolution.xy;',
    // A long lens with a slow, small drift: the frame breathes instead of sitting still, which is
  // most of what separates a plate of a huge thing from a screenshot of a shader.
  '  vec2 ndc = (uv - 0.5) * 2.0 * (1.0 + uDolly) + uShake;',
    '  vec3 dir = normalize(uCamFwd + uCamRight * ndc.x * uTanHalf * uAspect + uCamUp * ndc.y * uTanHalf);',
    '',
    '  vec3 pos = (uCamPos - uHole) / max(0.0001, uRs);',
    '  vec3 vel = dir;',
    '  float h2 = dot(cross(pos, vel), cross(pos, vel));',
    '  vec3 discN = normalize(vec3(sin(uDiscTilt), cos(uDiscTilt), 0.0));',
    '  bool captured = false;',
    '  vec3 emit = vec3(0.0);',
    '  float transmit = 1.0;',
    '  float lastR = length(pos);',
    '  int steps = int(uSteps);',
    '  for (int i = 0; i < 256; i++) {',
    '    if (i >= steps) break;',
    '    float r2 = dot(pos, pos);',
    '    if (r2 < 1.0) { captured = true; break; }',
    '    if (r2 > 3600.0 && dot(pos, vel) > 0.0) break;',
    '    float r = sqrt(r2);',
    '    lastR = r;',
    // Quadratic: tiny steps near the hole (a linear step left the photon ring polygonal), coarse
    '    float dt = clamp(0.02 * r * r, 0.004, 0.30) * uDeflect;',
    '    vec3 force = -1.5 * h2 * pos / (r2 * r2 * r);',
    '    vel += force * dt;',
    '',
    '    // The disc as a volume: every step inside the slab contributes, so its thickness is real and',
    '    // a camera that cuts through it sees the fog rather than an infinitely thin sheet.',
    '    float side = dot(pos, discN);',
    '    float halfThick = max(0.002, uDiscThick * 0.5);',
    '    if (abs(side) < halfThick && r > uDiscInner && r < uDiscOuter) {',
    '      float vert = 1.0 - abs(side) / halfThick;',
    '      float rn = clamp((r - uDiscInner) / max(0.001, uDiscOuter - uDiscInner), 0.0, 1.0);',
    '      float radial = smoothstep(0.0, 0.18, rn) * (1.0 - smoothstep(0.72, 1.0, rn));',
    '      float heat = pow(1.0 - rn, 1.7);',
    // The fog is a point field sampled at the marched position, turned with the flow: a ray cuts
    // through filaments instead of dragging one hashed cell along itself, which is what made the
    // old grain read as stretched dots.
    '      float flow = atan(pos.z, pos.x) - uSpin * iTime * 0.55 / (0.6 + r);',
    '      vec3 q = vec3(cos(flow) * r, sin(flow) * r, side * 4.5) + vec3(0.0, 0.0, iTime * 0.04);',
    '      float base = fbm3(q * 2.0);',
    '      float warp = noise3(q * 1.1 + vec3(3.1, 7.7, 1.3));',
    '      float field = smoothstep(0.34, 0.84, base + (warp - 0.5) * 0.38);',
    '      field *= 0.30 + 1.15 * (1.0 - abs(2.0 * base - 1.0));',
    '      float fog = mix(1.0, 0.10 + 1.9 * field, clamp(uWisp, 0.0, 2.0) * 0.7);',
    '      vec2 tangent = normalize(vec2(-pos.z, pos.x));',
    '      vec2 motion = normalize(vec2(vel.x, vel.z));',
    '      float doppler = 1.0 + uSpin * 0.8 * dot(tangent, motion);',
    '      float density = vert * radial * fog;',
    '      vec3 tint = mix(vec3(1.0, 0.50, 0.18), vec3(1.0, 0.96, 0.88), heat);',
    '      emit += tint * (0.22 + 1.8 * heat) * max(0.10, doppler) * density * dt * uDiscGain * transmit;',
    '      transmit *= exp(-density * dt * 1.6 * (0.5 + uDiscGain));',
    '    }',
    '    pos += vel * dt;',
    '  }',
    '',
    '  // The backdrop bends along the radius only: a monotone pull towards the hole that grows as the',
    '  // ring is approached. Sampling the marched direction instead folded the screen texture once per',
    '  // quadrant - rays that wrap over the top come out on the other side - and the frame read as four',
    '  // separate swirls. The march still owns the disc, the shadow and the photon ring; this law owns',
    '  // the sky, where all that is needed is that the stars lean towards the hole.',
    '  vec2 qv = (uv - uCenter) * vec2(uAspect, 1.0);',
    '  float qlen = max(length(qv), 1e-4);',
    '  // Bend ~ rs^2 / impact parameter, with the impact parameter floored at the shadow, so the pull',
    '  // grows towards the rim and stops there instead of dragging the whole texture around the centre.',
    '  float impact = max(qlen, uShadowUv * 0.98);',
    '  float bendMag = uDeflect * 0.65 * uShadowUv * uShadowUv / impact;',
    '  vec2 bend = (qv / qlen) * min(bendMag, uShadowUv * 1.6);',
    '  // Inside the shadow nothing behind the hole is seen at all: the disc and the ring are added by',
    '  // the march, but the sky has to go black or the hole has no hole in it.',
    '  float skyMask = smoothstep(uShadowUv * 0.98, uShadowUv * 1.06, qlen);',
    // The scene near the hole is sampled back through the bend: a pixel a little outside the shadow
    // carries light from closer to the centre, which is how a line behind the hole turns up as an
    // arc hugging the rim instead of vanishing behind it. Only the strong-lens zone is remapped, so
    // the frame edges keep their content and the old edge stretch cannot come back.
    '  float nearMask = 1.0 - smoothstep(uShadowUv * 1.05, uShadowUv * 2.6, qlen);',
    '  vec2 lensUv = clamp(uv - bend * nearMask * clamp(uTextLens, 0.0, 1.0), 0.0, 1.0);',
    // Only the stars are at infinity, so only they take the bend.
    '  vec3 bg = (sampleSky(lensUv, uSoft) + starField(uv + bend, iTime) * 0.85) * skyMask;',
    '',
    '  float rFinal = lastR;',
    '  vec3 color = bg * transmit + emit;',
    '',
    '  // Photon ring and a faint halo: the pressure of the thing comes from the ring being crisp',
    '  // against a soft field, and from the frame darkening towards its corners.',
    '  float rim = exp(-pow((rFinal - 1.32) / 0.11, 2.0));',
    '  color += uRing * rim * vec3(1.0, 0.87, 0.64) * (0.6 + 0.4 * uLevel);',
    '  float dUv = length((uv - uCenter) * vec2(uAspect, 1.0));',
    '  color += uRing * 0.05 * vec3(0.45, 0.62, 0.95) * exp(-pow((dUv - 0.34) / 0.22, 2.0));',
    '  color *= 1.0 - 0.28 * smoothstep(0.42, 1.05, dUv);',
    '',
    '  vec4 debris = nearDebris(uv, iTime, uDebris);',
  '  color = mix(color, debris.rgb, clamp(debris.a, 0.0, 1.0));',
  '',
  // The near rows are in front of the hole, so they are pasted straight over the picture: the lens
  // belongs to what is behind the hole, and that is the scene channel above.
    '  vec4 text = texture2D(iChannel1, uv);',
    '  color = color * (1.0 - text.a) + text.rgb;',
    '  fragColor = vec4(color, 1.0);',
    '}'
  ].join('\n'),
  { channels: 2 }
);

// The text is composited over the finished picture, so the hole can never paint over it: the
// shadow exists in the scene pass, and by the time these pixels are drawn the lens has already
// finished. What is left of the lens for the text is the bend itself - no shadow, no ring, no sky -
// so a line crossing the rim is stretched along it instead of being eaten by it. Being swallowed is
// the row's own doing: it shrinks into the centre and fades out at the shadow radius.


// ---------------------------------------------------------------- the pass
//
// One render target plus one fullscreen quad. Nothing else in the app renders to a target
// today (the scene goes straight to screen), so this owns the whole of it: it is built when the
// preset is selected, resized against the renderer's own drawing buffer every frame, and
// disposed when the preset is left, so a user who never selects it pays nothing for it.
var blackHoleState = {
  active: false,
  rt: null,
  textRt: null,
  textQuads: 0,
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
  if (blackHoleState.textRt && blackHoleState.textRt.dispose) blackHoleState.textRt.dispose();
  if (blackHoleState.material && blackHoleState.material.dispose) blackHoleState.material.dispose();
  if (blackHoleState.quadScene) {
    for (var i = 0; i < blackHoleState.quadScene.children.length; i++) {
      var child = blackHoleState.quadScene.children[i];
      if (child.geometry && child.geometry.dispose) child.geometry.dispose();
    }
    blackHoleState.quadScene.clear();
  }
  blackHoleState.rt = null;
  blackHoleState.textRt = null;
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
    var textRt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false
    });
    textRt.texture.wrapS = THREE.ClampToEdgeWrapping;
    textRt.texture.wrapT = THREE.ClampToEdgeWrapping;
    var material = new THREE.ShaderMaterial({
      vertexShader: BH_PASS_VS,
      fragmentShader: BH_PASS_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      uniforms: {
        iChannel0: { value: rt.texture },
        iChannel1: { value: textRt.texture },
        uTextLens: { value: 1 },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uSoft: { value: 3 },
        uShadowUv: { value: 0.3 },
        uShake: { value: new THREE.Vector2() },
        uDolly: { value: 0 },
        uDebris: { value: 0.6 },
        iResolution: { value: new THREE.Vector3(w, h, 1) },
        iTime: bhSharedTimeUniform(),
        iFrame: { value: 0 },
        iMouse: { value: new THREE.Vector4() },
        uCamPos: { value: new THREE.Vector3() },
        uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uTanHalf: { value: 0.55 },
        uAspect: { value: 1.78 },
        uHole: { value: new THREE.Vector3() },
        uRs: { value: 1 },
        uSteps: { value: 110 },
        uDeflect: { value: 1 },
        uDiscInner: { value: 2.2 },
        uDiscOuter: { value: 4.2 },
        uDiscThick: { value: 0.9 },
        uWisp: { value: 1 },
        uDiscTilt: { value: 0.24 },
        uDiscGain: { value: 1.1 },
        uSpin: { value: 0.7 },
        uRing: { value: 0.45 },
        uLevel: { value: 0 }
      }
    });
    var quadScene = new THREE.Scene();
    var quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    quadScene.add(quad);
    blackHoleState.rt = rt;
    blackHoleState.textRt = textRt;
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
  if (blackHoleState.textRt) blackHoleState.textRt.setSize(w, h);
  blackHoleState.width = w;
  blackHoleState.height = h;
  blackHoleState.passScale = scale;
}

function bhSyncLens(frame) {
  var material = blackHoleState.material;
  if (!material || !frame) return;
  var u = material.uniforms;
  var rs = Math.max(0.0001, frame.horizonWorld || 1);
  u.uHole.value.set(frame.world.x, frame.world.y, frame.world.z);
  u.uRs.value = rs;
  if (typeof camera !== 'undefined' && camera && camera.position) {
    u.uCamPos.value.set(camera.position.x, camera.position.y, camera.position.z);
  }
  if (frame.camera) {
    u.uCamFwd.value.set(frame.camera.fwd.x, frame.camera.fwd.y, frame.camera.fwd.z);
    u.uCamRight.value.set(frame.camera.right.x, frame.camera.right.y, frame.camera.right.z);
    u.uCamUp.value.set(frame.camera.up.x, frame.camera.up.y, frame.camera.up.z);
    u.uTanHalf.value = frame.camera.tanHalf || 0.55;
  }
  u.uAspect.value = frame.aspect || 1.78;
  u.uSteps.value = bhClamp(bhParam('marchSteps'), 16, 256);
  u.uDeflect.value = bhClamp(bhParam('deflect'), 0, 3);
  // Disc radii arrive in world units and are used in horizon radii, like everything inside the march.
  u.uDiscInner.value = Math.max(1.02, bhClamp(bhParam('discInner'), 0.2, 40) / rs);
  u.uDiscOuter.value = Math.max(u.uDiscInner.value + 0.2, bhClamp(bhParam('discOuter'), 0.5, 60) / rs);
  if (u.uDiscThick) u.uDiscThick.value = Math.max(0.01, bhClamp(bhParam('discThickness'), 0.02, 8) / rs);
  if (u.uSoft) u.uSoft.value = bhClamp(bhParam('softness'), 0, 6);
  if (u.uWisp) u.uWisp.value = bhClamp(bhParam('discWisp'), 0, 2);
  if (u.uShadowUv) u.uShadowUv.value = frame.uvShadow || 0.3;
  if (u.uDebris) u.uDebris.value = bhClamp(bhParam('debris'), 0, 1);
  var drift = bhCameraDrift(blackHoleFlight.time, bhClamp(bhParam('cameraDrift'), 0, 1));
  if (u.uShake) u.uShake.value.set(drift.x, drift.y);
  if (u.uDolly) u.uDolly.value = drift.dolly;
  if (u.uCenter) u.uCenter.value.set(frame.uv ? frame.uv.u : 0.5, frame.uv ? frame.uv.v : 0.5);
  u.uDiscTilt.value = bhClamp(bhParam('discTilt'), -60, 60) * Math.PI / 180;
  u.uDiscGain.value = bhClamp(bhParam('discGain'), 0, 3);
  u.uSpin.value = bhClamp(bhParam('spin'), -1, 1);
  u.uRing.value = bhClamp(bhParam('ringGlow'), 0, 2);
  u.uLevel.value = blackHoleState.level;
  if (u.uTextLens) u.uTextLens.value = bhClamp(bhParam('textLens'), 0, 1.5);
  if (u.iResolution) u.iResolution.value.set(blackHoleState.width || 1, blackHoleState.height || 1, 1);
  if (u.iFrame) u.iFrame.value = (u.iFrame.value + 1) % 100000;
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
  var quads = blackHoleState.quadScene ? blackHoleState.quadScene.children : [];
  var screenQuad = quads[0];
  var lyrics = (typeof bhLyrics !== 'undefined' && bhLyrics && bhLyrics.layer) ? bhLyrics.layer : null;
  var galaxy = (typeof bhGalaxy !== 'undefined' && bhGalaxy && bhGalaxy.group) ? bhGalaxy.group : null;
  try {
    // 1. the world: the galaxy and the rows on the far half of the orbit. Those rows are behind the
    //    hole, so they belong to the scene the lens gets to bend and the disc fog gets to cover.
    if (lyrics) bhSetLyricSideVisibility(false);
    renderer.setRenderTarget(blackHoleState.rt);
    renderer.render(scene, camera);
    // 2. the near half of the orbit, alone, from the same camera: these rows are between the eye
    //    and the hole, so they are composited in front of the finished picture as iChannel1.
    renderer.setRenderTarget(blackHoleState.textRt);
    if (lyrics && bhSetLyricSideVisibility(true) > 0) {
      if (galaxy) galaxy.visible = false;
      renderer.render(scene, camera);
      if (galaxy) galaxy.visible = true;
      blackHoleState.textQuads++;
    } else {
      // Nothing to draw: clear it, or the pass would sample last frame's text.
      renderer.clear();
    }
    if (lyrics) bhSetLyricSideVisibility(null);
    renderer.setRenderTarget(null);
    if (screenQuad) screenQuad.visible = true;
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
    if (lyrics) bhSetLyricSideVisibility(null);
    if (galaxy) galaxy.visible = true;
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
    bhBuildLyrics();
  } else if (was) {
    bhDisposeLyrics();
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
    lyrics: bhLyricStatus(),
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
      // The straight lyric rows are replaced by this preset's own arc rows, which are meshes in
      // the render target - so the app's layer is taken over rather than left underneath.
      stageLyrics: true
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
  // The arc layer is the owner of the text while it is up; only one of the two may move meshes.
  if (bhLyrics.layer) return false;
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
  var segments = [
    // The bulge and the bar are part of the picture the model promises, so they are part of the
    // sampled field: without them the arms started at 0.26 and the middle of the galaxy was empty.
    { arm: 0, kind: 'core', r0: 0.01, r1: 0.09, root: 0, offset: 0, weight: 0.07 },
    { arm: 0, kind: 'bar', r0: 0.02, r1: BH_GALAXY_MODEL.barLength, root: BH_GALAXY_MODEL.barAngle, offset: 0, weight: 0.14 },
    { arm: 1, kind: 'bar', r0: 0.02, r1: BH_GALAXY_MODEL.barLength, root: BH_GALAXY_MODEL.barAngle + Math.PI, offset: 0, weight: 0.14 }
  ];
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
    var weight = seg.weight || Math.max(0.02, seg.r1 * seg.r1 - seg.r0 * seg.r0);
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
  if (chosen.kind === 'bar') {
    // A bar is straight: its thickness is a length, not an angle, so the angular scatter has to
    // shrink as the radius grows or the bar would fan out into a wedge.
    angle = chosen.root + (rand() - 0.5) * 0.10 / Math.max(0.04, radius);
    radius = chosen.r0 + rand() * (chosen.r1 - chosen.r0);
  } else if (chosen.kind === 'core') {
    radius = Math.pow(rand(), 1.8) * chosen.r1;
    angle = rand() * Math.PI * 2;
  }
  // Arms are wider relative to their own length at the outside, and branches are looser than the
  // main arms - otherwise the whole field reads as two hard lines.
  var spread = params.armWidth * (0.45 + radius * 0.85) * (chosen.kind === 'branch' ? 1.45 : 1);
  var scatter = (rand() + rand() + rand() - 1.5) * spread;
  // A quarter of the field is inter-arm: halo stars and diffuse haze, so the arms sit in a
  // background instead of floating on black.
  if (chosen.kind !== 'bar' && chosen.kind !== 'core' && rand() < 0.10) {
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
    density: Math.round(bhClamp(bhParam('galaxyDensity'), 200, 40000)),
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
  var gain = Math.min(3.2, point.bright) * 0.55 * (0.45 + 0.55 * (1 - point.radius * 0.55));
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

var bhGalaxySprite = null;
function bhGalaxySpriteTexture() {
  if (bhGalaxySprite || typeof document === 'undefined') return bhGalaxySprite;
  var size = 64;
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  var gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  var texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  bhGalaxySprite = texture;
  return texture;
}

function bhGalaxyMaterial(params, haze) {
  var material = new THREE.PointsMaterial({
    map: bhGalaxySpriteTexture(),
    alphaTest: 0.02,
    size: params.radius * (haze ? 0.075 : 0.030),
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


// ---------------------------------------------------------------- the lyric orbit
//
// The rows are objects on a circle in the accretion disc's own plane, not a screen-space layer.
// A line comes round from behind the hole, waits at the point nearest the camera so it can be
// read, then keeps going the same way while it spirals in; the rows on the far half are behind
// the hole, so the lens picks their light up and the disc fog passes over them. The timing and
// palette plumbing is still the app's (lyricsLines + getActiveLyricTimingOffsetSeconds, the
// translation attached to the line, haloLyricPalette / lyricMotionProfile).
var bhLyrics = {
  layer: null,
  rows: [],
  items: [],
  listKey: '',
  sung: -1,
  time: 0,
  now: 0,
  builtKey: ''
};

function bhLyricTranslationOf(line) {
  if (!line) return '';
  if (typeof haloLyricTranslationOf === 'function') return haloLyricTranslationOf(line);
  if (typeof normalizeLyricTranslationText === 'function') return normalizeLyricTranslationText(line.translation);
  return String(line.translation || '').trim();
}

function bhLyricFontPx() {
  var scale = 1;
  if (typeof fx !== 'undefined' && fx && isFinite(Number(fx.lyricScale))) scale = Number(fx.lyricScale);
  return Math.max(11, Math.min(44, 19 * bhClamp(scale, 0.35, 1.65)));
}

// The lines, with the app's own timing offset folded in, so a row's start is the moment it is
// sung rather than the moment the file says.
function bhLyricItems() {
  var lines = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
  var offset = 0;
  if (typeof getActiveLyricTimingOffsetSeconds === 'function') offset = getActiveLyricTimingOffsetSeconds();
  var items = [];
  for (var i = 0; i < lines.length; i++) {
    var text = String((lines[i] && lines[i].text) || '').trim();
    if (!text) continue;
    items.push({
      index: i,
      text: text,
      sub: bhLyricTranslationOf(lines[i]),
      startAt: Number(lines[i].t) + offset
    });
  }
  for (var k = 0; k < items.length; k++) {
    items[k].endAt = k + 1 < items.length ? items[k + 1].startAt : items[k].startAt + 6;
  }
  return items;
}

function bhLyricListKey(items) {
  var song = '';
  if (typeof haloCurrentSong === 'function') {
    var current = haloCurrentSong();
    song = String((current && (current.id || current.name || current.title)) || '');
  }
  return song + '|' + items.length + '|' + (items.length ? items[0].text : '');
}

// Which line is being sung at t: the last one whose start has passed.
function bhLyricSungIndex(items, t) {
  if (!items || !items.length) return -1;
  var found = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].startAt <= t) found = i; else break;
  }
  return found;
}

// The radial blur's five taps, as offsets in the direction away from the hole (pixels). Mirrored
// here so the test can check the shape instead of reading the GLSL: symmetric, a zero tap in the
// middle, and nothing at all when the radius is zero.
function bhRadialBlurOffsets(blurPx) {
  var px = bhClamp(Number(blurPx) || 0, 0, 12);
  var out = [];
  // || 0 keeps a zero radius from producing -0, which deep equality treats as a different number.
  for (var i = -2; i <= 2; i++) out.push((i * 0.5 * px) || 0);
  return out;
}

// Slow camera drift, as an offset in ndc plus a small dolly. Two incommensurable sines per axis, so
// it never repeats inside a song, and it is bounded by the amplitude: a shake that is allowed to
// grow reads as a broken camera, not as weight.
function bhCameraDrift(time, amount) {
  var amp = bhClamp(Number(amount) || 0, 0, 1);
  var t = Number(time) || 0;
  return {
    x: amp * (Math.sin(t * 0.43) * 0.0016 + Math.sin(t * 1.13 + 1.7) * 0.0008),
    y: amp * (Math.sin(t * 0.61 + 0.4) * 0.0014 + Math.sin(t * 1.71 + 2.3) * 0.0007),
    dolly: amp * (Math.sin(t * 0.23 + 1.1) * 0.006 + Math.sin(t * 0.77 + 0.2) * 0.002)
  };
}

// How much of a row survives at a distance from the hole, in the hole's own shadow radius: it stays
// whole outside, and is gone by the time it reaches the rim. This is what "gradually swallowed"
// means now that the shadow does not paint over the text.
function bhSwallowAlpha(distance, shadowRadius) {
  if (!(shadowRadius > 1e-6)) return 1;
  // Whole until 0.55 of the shadow radius and gone by 0.15: a row on its way in stays readable
  // *over* the hole, which is the whole point of compositing it after the shadow, and only the
  // last part of the fall - where it is down to a few pixels - is what fades out.
  return bhClamp((distance / shadowRadius - 0.15) / 0.4, 0, 1);
}

var BH_ORBIT_FRONT = -Math.PI / 2;

// The orbit is a circle inside the accretion disc's plane, so it tips with the disc. e1 and e2 are
// the plane's own axes and n is its normal, in the same world axes the shader marches in. The
// front of the circle is the point nearest the camera, which is where a line stops to be read.
function bhOrbitBasis(tiltDeg) {
  var t = bhClamp(Number(tiltDeg) || 0, -60, 60) * Math.PI / 180;
  return {
    n: { x: Math.sin(t), y: Math.cos(t), z: 0 },
    e1: { x: Math.cos(t), y: -Math.sin(t), z: 0 },
    e2: { x: 0, y: 0, z: -1 }
  };
}

function bhOrbitFrontAngle(basis, towardCamera) {
  var a = towardCamera.x * basis.e1.x + towardCamera.y * basis.e1.y + towardCamera.z * basis.e1.z;
  var b = towardCamera.x * basis.e2.x + towardCamera.y * basis.e2.y + towardCamera.z * basis.e2.z;
  return Math.atan2(b, a);
}

function bhOrbitPoint(basis, radius, angle) {
  var c = Math.cos(angle);
  var s = Math.sin(angle);
  return {
    x: (basis.e1.x * c + basis.e2.x * s) * radius,
    y: (basis.e1.y * c + basis.e2.y * s) * radius,
    z: (basis.e1.z * c + basis.e2.z * s) * radius
  };
}

// The panel a row is painted on is a sign standing on the orbit: its face is the outward radial
// direction (so it is turned away from the hole and towards the eye only near the front), and its
// up is the disc normal. It is not billboarded - that is what makes it swing round and foreshorten
// as it comes past instead of sliding across the screen like a subtitle.
function bhOrbitPanel(basis, angle) {
  var c = Math.cos(angle);
  var s = Math.sin(angle);
  var forward = {
    x: basis.e1.x * c + basis.e2.x * s,
    y: basis.e1.y * c + basis.e2.y * s,
    z: basis.e1.z * c + basis.e2.z * s
  };
  var up = basis.n;
  // right = up x forward; forward lies in the plane whose normal is up, so all three are unit and
  // orthogonal and (right, up, forward) is a rotation.
  var right = {
    x: up.y * forward.z - up.z * forward.y,
    y: up.z * forward.x - up.x * forward.z,
    z: up.x * forward.y - up.y * forward.x
  };
  return { right: right, up: up, forward: forward };
}

// Rotation whose local x/y/z are right/up/forward. Written out so the maths can be tested without
// a THREE.Matrix4 (the panel orientation is the thing the eye judges, so it should not be opaque).
function bhPanelQuaternion(panel) {
  var r = panel.right;
  var u = panel.up;
  var f = panel.forward;
  var m00 = r.x, m01 = u.x, m02 = f.x;
  var m10 = r.y, m11 = u.y, m12 = f.y;
  var m20 = r.z, m21 = u.z, m22 = f.z;
  var trace = m00 + m11 + m22;
  var q = { x: 0, y: 0, z: 0, w: 1 };
  if (trace > 0) {
    var s0 = Math.sqrt(trace + 1.0) * 2;
    q.w = 0.25 * s0;
    q.x = (m21 - m12) / s0;
    q.y = (m02 - m20) / s0;
    q.z = (m10 - m01) / s0;
  } else if (m00 > m11 && m00 > m22) {
    var s1 = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    q.w = (m21 - m12) / s1;
    q.x = 0.25 * s1;
    q.y = (m01 + m10) / s1;
    q.z = (m02 + m20) / s1;
  } else if (m11 > m22) {
    var s2 = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    q.w = (m02 - m20) / s2;
    q.x = (m01 + m10) / s2;
    q.y = 0.25 * s2;
    q.z = (m12 + m21) / s2;
  } else {
    var s3 = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    q.w = (m10 - m01) / s3;
    q.x = (m02 + m20) / s3;
    q.y = (m12 + m21) / s3;
    q.z = 0.25 * s3;
  }
  return q;
}

// When a line starts to leave the front. It leaves a little before its nominal end so the next one
// is not still pushing it out of the way; the exit only ever starts after the line has existed.
function bhLyricExitStart(item, params) {
  var start = Number(item && item.startAt) || 0;
  var end = Number(item && item.endAt) || start;
  var exitLead = Math.max(0.1, Number(params.exitLead) || 0.45);
  return Math.max(start + 0.2, end - exitLead);
}

// Where a line is at `now`. The schedule is what keeps the hand-over unhurried:
// - it waits off to the side (invisible) until its turn,
// - eases to the front and comes to rest there - zero angular speed at both ends of the ease,
// - stays for as long as it is sung,
// - leaves from the front while the next one only starts easing in after it has begun to go, so
//   the two are never both at the front. If the previous line has not begun to leave, the next
//   one does not start its approach at all (its arrival is pushed back with it).
// After the exit the radius falls on the free-fall law and the turn accelerates into the spiral.
function bhLyricOrbitState(item, now, params, frontAngle, prevExitStart) {
  var t = Number(now) || 0;
  var start = Number(item && item.startAt) || 0;
  var end = Number(item && item.endAt) || start;
  var rate = Math.max(0.001, Number(params.rate) || 0.5);
  var flyIn = Math.max(0.2, Number(params.flyIn) || 0.75);
  var waitAngle = Math.max(0.2, Number(params.waitAngle) || 0.65);
  var gap = Math.max(0, Number(params.gap) || 0.2);
  var exitStart = bhLyricExitStart(item, params);
  var prev = (prevExitStart === null || prevExitStart === undefined || !isFinite(Number(prevExitStart)))
    ? -Infinity : Number(prevExitStart);
  var arriveAt = Math.max(start, prev + gap + 0.2);
  var approachBegin = Math.max(arriveAt - flyIn, prev + gap);
  if (arriveAt - approachBegin < 0.2) arriveAt = approachBegin + 0.2;
  // A line that had to wait so long that its reading window is gone still gets a moment on screen.
  exitStart = Math.max(exitStart, arriveAt + 0.15);
  if (t < approachBegin) {
    return { phase: 'wait', angle: frontAngle + waitAngle, radius: 1, alpha: 0, fall: 0 };
  }
  if (t < arriveAt) {
    var ease = bhClamp((t - approachBegin) / Math.max(0.05, arriveAt - approachBegin), 0, 1);
    var smooth = ease * ease * (3 - 2 * ease);
    return {
      phase: 'approach',
      angle: frontAngle + waitAngle * (1 - smooth),
      radius: 1,
      alpha: bhClamp(ease / 0.35, 0, 1),
      fall: 0
    };
  }
  if (t <= exitStart) {
    return { phase: 'read', angle: frontAngle, radius: 1, alpha: 1, fall: 0 };
  }
  var u = bhClamp((t - exitStart) / Math.max(0.1, Number(params.swallow) || 1.4), 0, 1);
  if (u >= 1) return null;
  var curve = bhClamp(Number(params.curve) || 0.66, 0.05, 3);
  var turn = (Number(params.wind) || 0) + rate * Math.max(0.1, Number(params.swallow) || 1.4);
  return {
    phase: 'fall',
    // u^1.6 starts at zero angular speed, so the exit does not snap away from the front.
    angle: frontAngle - turn * Math.pow(u, 1.6),
    radius: Math.pow(Math.max(0, 1 - u), curve),
    alpha: 1,
    fall: u
  };
}

function bhLyricPaletteState() {
  if (typeof haloLyricPalette === 'function') {
    var palette = haloLyricPalette();
    return {
      primary: palette.primary || '#9db8cf',
      highlight: palette.highlight || palette.primary || '#fff0b8',
      context: palette.secondary || palette.primary || '#7f8fa3',
      signature: [palette.primary, palette.highlight, palette.secondary].join(',')
    };
  }
  return { primary: '#9db8cf', highlight: '#fff0b8', context: '#7f8fa3', signature: 'default' };
}

function bhLyricMotionState() {
  if (typeof lyricMotionProfile === 'function') {
    try { return lyricMotionProfile(); } catch (_) {}
  }
  return { floatAmp: 0.4, enter: 0.28 };
}

// Rasterises one row onto its own canvas: the line and, under it, its translation. The text is
// straight in the viewer's frame - the rows hang beside the hole, so an arc would only make them
// harder to read - and the canvas is sized to the measured text so the plane carries no empty
// margin that would shrink the letters.
function bhDrawRowCanvas(row, item, sung, palette, motion) {
  var fontPx = bhLyricFontPx();
  var subPx = Math.round(fontPx * 0.62);
  var font = '700 ' + fontPx.toFixed(1) + 'px ' + (typeof HALO_FONT !== 'undefined' ? HALO_FONT : '"JetBrains Mono","Microsoft YaHei",monospace');
  var subFont = '400 ' + subPx.toFixed(1) + 'px ' + (typeof HALO_FONT !== 'undefined' ? HALO_FONT : 'monospace');
  // Measure first, then size the canvas to the text: a plane that carries a mostly empty texture
  // puts the letters about a pixel tall on screen.
  var measure = row.ctx;
  measure.font = font;
  var mainWidth = Math.max(fontPx * 2, measure.measureText(item.text).width || 0);
  measure.font = subFont;
  var subWidth = item.sub ? Math.max(0, measure.measureText(item.sub).width || 0) : 0;
  var pad = Math.max(4, fontPx * 0.35);
  var canvasWidth = Math.max(fontPx * 4, Math.min(2048, Math.ceil(Math.max(mainWidth, subWidth) + pad * 2)));
  // The translation band is reserved on every row, so the glyphs occupy the same share of the
  // plane whether or not the line has a translation and the text does not change size line to line.
  var mainH = fontPx * 1.35;
  var subH = subPx * 1.6;
  var canvasHeight = Math.ceil(mainH + subH + pad * 2);
  if (row.canvas.width !== canvasWidth || row.canvas.height !== canvasHeight) {
    row.canvas.width = canvasWidth;
    row.canvas.height = canvasHeight;
  }
  var ctx = row.canvas.getContext('2d');
  row.ctx = ctx;
  row.widthRatio = canvasWidth / canvasHeight;
  var width = canvasWidth;
  ctx.clearRect(0, 0, width, canvasHeight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  var colour = sung ? palette.highlight : palette.primary;
  var alpha = sung ? 1 : 0.72;
  ctx.font = font;
  ctx.fillStyle = bhLyricCss(colour, alpha);
  ctx.fillText(item.text, width / 2, pad + mainH / 2);
  if (item.sub) {
    ctx.font = subFont;
    ctx.fillStyle = bhLyricCss(palette.context, alpha * 0.72);
    ctx.fillText(item.sub, width / 2, pad + mainH + subH / 2);
  }
  row.sung = sung;
}

function bhLyricCss(colour, alpha) {
  if (typeof haloRgba === 'function') return haloRgba(colour, alpha);
  return colour;
}

function bhBuildLyricRow(width, height) {
  var canvas = document.createElement('canvas');
  canvas.width = Math.max(64, Math.round(width));
  canvas.height = Math.max(32, Math.round(height));
  var texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  var material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // The panel is a physical sign: on the far half we are looking at its back, and that is the
    // view the lens smears around the rim. A single-sided plane would be culled and vanish.
    side: THREE.DoubleSide,
    opacity: 1
  });
  var mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 60;
  return { canvas: canvas, ctx: canvas.getContext('2d'), texture: texture, material: material, mesh: mesh, itemIndex: -1, sung: null, live: false, front: true };
}

function bhDisposeLyrics() {
  if (bhLyrics.layer && bhLyrics.layer.parent) bhLyrics.layer.parent.remove(bhLyrics.layer);
  (bhLyrics.rows || []).forEach(function (row) {
    if (row.texture && row.texture.dispose) row.texture.dispose();
    if (row.material && row.material.dispose) row.material.dispose();
    if (row.mesh && row.mesh.geometry && row.mesh.geometry.dispose) row.mesh.geometry.dispose();
  });
  bhLyrics.layer = null;
  bhLyrics.rows = [];
  bhLyrics.items = [];
  bhLyrics.listKey = '';
  bhLyrics.builtKey = '';
  bhLyrics.sung = -1;
  bhLyrics.now = 0;
}

function bhBuildLyrics() {
  if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene) return false;
  var items = bhLyricItems();
  var layer = new THREE.Group();
  layer.frustumCulled = false;
  var rows = [];
  var fontPx = bhLyricFontPx();
  var worldHeight = fontPx * 0.045;
  for (var i = 0; i < 5; i++) {
    var row = bhBuildLyricRow(1024, 256);
    row.mesh.scale.set(worldHeight * (row.widthRatio || 4), worldHeight, 1);
    row.mesh.visible = false;
    layer.add(row.mesh);
    rows.push(row);
  }
  scene.add(layer);
  bhLyrics.layer = layer;
  bhLyrics.rows = rows;
  bhLyrics.items = items;
  bhLyrics.listKey = bhLyricListKey(items);
  bhLyrics.builtKey = bhLyrics.listKey + '|' + fontPx;
  return true;
}

function bhLyricParams() {
  return {
    orbit: bhClamp(bhParam('lyricOrbit'), 0.3, 20),
    rate: bhClamp(bhParam('lyricOrbitRate'), 0.05, 2),
    wind: bhClamp(bhParam('lyricWind'), 0, 8),
    curve: bhClamp(bhParam('fallCurve'), 0.05, 3),
    swallow: Math.max(0.1, bhParam('swallow')),
    drift: bhClamp(bhParam('lyricDrift'), 0, 1.5),
    flyIn: Math.max(0.2, bhParam('flyIn')),
    // Where a line waits before its turn, how early it leaves the front, and the pause between the
    // previous leaving and the next starting its ease.
    waitAngle: 0.65,
    exitLead: 0.3,
    gap: 0.2,
    // The plane's height as a fraction of the visible half-height at the hole's depth. A row at
    // the front of the orbit is nearer the eye, so the perspective makes it larger - that is the
    // same near/far enlargement the rest of the scene gets, not a separate scale animation.
    height: bhClamp(bhLyricFontPx() * 0.008, 0.03, 0.4)
  };
}

// The rows orbit inside the disc plane: a line comes round from behind, waits at the point
// nearest the camera while it is sung, then keeps going the same way while it spirals in. Rows on
// the near half are composited in front of the picture; rows on the far half are part of the
// scene target, so the lens bends them and the disc fog passes over them.
function bhPlaceLyrics(frame, dt) {
  if (!bhLyrics.layer) return false;
  if (typeof camera === 'undefined' || !camera || !camera.position) return false;
  var params = bhLyricParams();
  bhLyrics.time += Math.max(0, Number(dt) || 0);
  var time = bhLyrics.time;
  var now = isFinite(Number(bhLyrics.now)) ? Number(bhLyrics.now) : time;
  var motion = bhLyricMotionState();
  bhLyrics.layer.position.set(frame.world.x, frame.world.y, frame.world.z);
  var basis = bhOrbitBasis(bhParam('discTilt'));
  var front = bhOrbitFrontAngle(basis, {
    x: camera.position.x - frame.world.x,
    y: camera.position.y - frame.world.y,
    z: camera.position.z - frame.world.z
  });
  var tanHalf = (frame.camera && frame.camera.tanHalf) || 0.55;
  var aspect = Math.max(0.2, Number(frame.aspect) || 1.78);
  var fwd = (frame.camera && frame.camera.fwd) || { x: 0, y: 0, z: -1 };
  var depth = Math.max(0.1, Number(frame.distance) || 1);
  var shadowWorld = Math.max(1e-4, (Number(frame.uvShadow) || 0.3) * depth * tanHalf);
  var items = bhLyrics.items;
  var sung = bhLyrics.sung;
  var anchor = sung < 0 ? 0 : sung;
  var lo = sung < 0 ? 0 : Math.max(0, sung - 2);
  var hi = Math.min(items.length - 1, anchor + 2);
  var rows = bhLyrics.rows;
  var held = {};
  for (var b = 0; b < rows.length; b++) {
    var bound = rows[b];
    if (bound.itemIndex >= lo && bound.itemIndex <= hi && bound.itemIndex >= 0 && !held[bound.itemIndex]) {
      held[bound.itemIndex] = bound;
    } else {
      bound.itemIndex = -1;
      bound.live = false;
      bound.mesh.visible = false;
    }
  }
  // A line keeps its own row while it is in the window, so advancing the song lets the row keep
  // orbiting instead of jumping to a new slot.
  for (var idx = lo; idx <= hi; idx++) {
    if (held[idx] || !items.length) continue;
    var free = null;
    for (var f = 0; f < rows.length; f++) if (rows[f].itemIndex < 0) { free = rows[f]; break; }
    if (!free) continue;
    free.itemIndex = idx;
    free.live = true;
    free.sung = null;
    bhDrawRowCanvas(free, items[idx], idx === sung, bhLyricPaletteState(), motion);
    free.texture.needsUpdate = true;
  }
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.itemIndex < 0) continue;
    var index = row.itemIndex;
    var current = index === sung;
    // The row keeps its line, so the canvas has to be redrawn when that line becomes (or stops
    // being) the one being sung: otherwise the highlight stays on whichever line it was drawn for.
    if (row.sung !== current) {
      bhDrawRowCanvas(row, items[index], current, bhLyricPaletteState(), motion);
      row.texture.needsUpdate = true;
    }
    var state = bhLyricOrbitState(
      items[index],
      now,
      params,
      front,
      index > 0 && items[index - 1] ? bhLyricExitStart(items[index - 1], params) : null
    );
    if (!state) {
      row.live = false;
      row.itemIndex = -1;
      row.mesh.visible = false;
      row.material.opacity = 0;
      continue;
    }
    if (state.phase === 'wait') {
      // Not its turn yet: the row is on the ring but not shown, so two lines cannot be in the air
      // at once. Keeping its itemIndex means it carries on rather than being rebuilt.
      row.live = false;
      row.mesh.visible = false;
      row.material.opacity = 0;
      continue;
    }
    row.live = true;
    var wobble = Math.sin(time * 0.6 + index * 0.9) * params.drift * 0.02;
    var angle = state.angle + wobble;
    var radius = params.orbit * state.radius;
    var point = bhOrbitPoint(basis, radius, angle);
    row.mesh.position.set(point.x, point.y, point.z);
    // The panel is not billboarded: it faces outward from the hole and stands on the disc, so it
    // swings round as it comes past and only faces the eye near the front. The perspective of
    // that turn is the foreshortening the eye reads as rotation on the ring.
    var panel = bhOrbitPanel(basis, angle);
    var quat = bhPanelQuaternion(panel);
    row.mesh.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    var wx = frame.world.x + point.x;
    var wy = frame.world.y + point.y;
    var wz = frame.world.z + point.z;
    var alongRow = (wx - camera.position.x) * fwd.x + (wy - camera.position.y) * fwd.y + (wz - camera.position.z) * fwd.z;
    // Near side of the orbit: it is between the eye and the hole, so it belongs in front of the
    // picture. Far side: it is behind the hole's shadow and the lens, so it belongs in the scene.
    row.front = alongRow < depth;
    row.mesh.renderOrder = 60;
    // Sized against the hole's own depth: the front of the orbit is closer to the eye, so it is
    // drawn bigger by the perspective, and a line on the far side is smaller and hazier.
    var worldH = params.height * depth * tanHalf * (current ? 1.12 : 0.95);
    var rowAlong = Math.max(0.05, alongRow);
    var widthNdc = worldH * (row.widthRatio || 4) / (rowAlong * tanHalf * aspect);
    var fit = widthNdc > 0.86 ? 0.86 / widthNdc : 1;
    row.mesh.scale.set(worldH * (row.widthRatio || 4) * fit, worldH * fit, 1);
    row.mesh.visible = true;
    var opacity = current ? 1 : 0.72;
    if (state.phase === 'read') opacity = current ? 1 : 0.85;
    if (state.phase === 'approach') opacity = state.alpha * (current ? 1 : 0.9);
    if (state.phase === 'fall') opacity = bhSwallowAlpha(radius, shadowWorld);
    row.material.opacity = opacity;
  }
  return true;
}

// Which half of the orbit the renderer is drawing right now: the near rows (composited in front of
// the picture) or the far rows (part of the scene the lens bends). null puts every live row back,
// which is what the plain fallback render needs.
function bhSetLyricSideVisibility(side) {
  var rows = (typeof bhLyrics !== 'undefined' && bhLyrics && bhLyrics.rows) ? bhLyrics.rows : [];
  var shown = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || !row.mesh || row.itemIndex < 0 || !row.live) {
      if (row && row.mesh) row.mesh.visible = false;
      continue;
    }
    var visible = side === null || side === undefined ? true : (!!side === !!row.front);
    row.mesh.visible = visible;
    if (visible) shown++;
  }
  return shown;
}

function bhLyricStatus() {
  var frontRows = 0;
  var backRows = 0;
  for (var i = 0; i < bhLyrics.rows.length; i++) {
    var row = bhLyrics.rows[i];
    if (row.itemIndex < 0 || !row.live) continue;
    if (row.front) frontRows++; else backRows++;
  }
  return {
    built: !!bhLyrics.layer,
    rows: bhLyrics.rows.length,
    items: bhLyrics.items.length,
    sung: bhLyrics.sung,
    orbit: Math.round(bhParam('lyricOrbit') * 100) / 100,
    rate: Math.round(bhParam('lyricOrbitRate') * 100) / 100,
    front: frontRows,
    back: backRows,
    text: bhLyrics.sung >= 0 && bhLyrics.items[bhLyrics.sung] ? bhLyrics.items[bhLyrics.sung].text.slice(0, 20) : ''
  };
}

// The arc layer owns the text while it exists; the app's own row flight only runs when it does not,
// so there is exactly one thing moving lyric meshes at a time.
function updateBlackHoleLyrics(dt) {
  if (!blackHolePresetIsActive()) return false;
  var frame = blackHoleState.frame || bhComputeFrame();
  if (!frame || !frame.uv) return false;
  if (!bhLyrics.layer) {
    if (!bhBuildLyrics()) return false;
  }
  var items = bhLyricItems();
  var key = bhLyricListKey(items);
  if (key !== bhLyrics.listKey) {
    bhLyrics.items = items;
    bhLyrics.listKey = key;
    bhLyrics.builtKey = key + '|' + bhLyricFontPx();
    for (var i = 0; i < bhLyrics.rows.length; i++) bhLyrics.rows[i].itemIndex = -1;
  }
  var t = 0;
  if (typeof audio !== 'undefined' && audio && isFinite(Number(audio.currentTime))) t = Number(audio.currentTime);
  bhLyrics.now = t;
  bhLyrics.sung = bhLyricSungIndex(bhLyrics.items, t);
  return bhPlaceLyrics(frame, dt);
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
