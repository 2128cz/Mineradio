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
  // Star brightness in the backdrop: the four-point field is what makes the sky read as space
  // rather than as a blurred picture, and it is the one term that was a constant.
  skyStars: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  cameraDrift: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  // A fast, three-axis jolt on top of the slow drift: the camera is caught in the hole's field. It
  // grows as the hole fills more of the frame and the music gets louder, and the beat speeds it up
  // rather than striking it - the shake never jumps, it just gets shaken harder.
  shock: { def: 0.8, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  shockRate: { def: 1, min: 0.3, max: 3, kind: 'ratio', rebuild: 'live' },
  shockAudio: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  // Shards inside the disc: how many lattice cells carry one. They ride the Keplerian flow and are
  // dimmed by the fog in front of them, so they are part of the disc rather than a screen overlay.
  debris: { def: 0.6, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  marchSteps: { def: 160, min: 24, max: 256, kind: 'count', rebuild: 'live' },
  // How much the lyric layer is bent by the same field it is drawn into; 0 keeps it straight.
  textLens: { def: 1, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  // A long lens: the narrower the fov, the flatter the perspective and the more the hole reads as
  // a distant object with mass rather than as something close and small.
  fovDeg: { def: 40, min: 24, max: 92, kind: 'deg', rebuild: 'live' },
  sideSpread: { def: 6.2, min: 2.5, max: 14, kind: 'unit', rebuild: 'lyric' },
  startNear: { def: 1.6, min: 0.7, max: 4, kind: 'unit', rebuild: 'lyric' },
  flyIn: { def: 0.75, min: 0.15, max: 2.5, kind: 'sec', rebuild: 'live' },
  // Seconds from leaving the front to crossing the horizon, for a line of average length: a real
  // inspiral takes a while, and the row is meant to be seen whirling in, not blinked away.
  swallow: { def: 9, min: 0.5, max: 30, kind: 'sec', rebuild: 'live' },
  fallCurve: { def: 0.5, min: 0.25, max: 1.6, kind: 'ratio', rebuild: 'live' },
  // The hard cap on how many lines can be alive at once. Every line keeps its own sign for its
  // whole inspiral, so a fast song needs more of them; this is also what bounds "how long after
  // leaving the front a line is still visible" (a line is dropped only when the window passes it).
  lyricRows: { def: 24, min: 9, max: 48, kind: 'count', rebuild: 'rows' },
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
  // A fraction of the camera-to-hole distance, not a length: the same world radius would hug the
  // hole when the camera is close and swallow the frame when it is far. 0.58 keeps the near half in
  // front of the eye and puts the far half 1.6x the distance away, which is the near/far spread the
  // signs need in order to read as small objects around something huge.
  lyricOrbit: { def: 0.72, min: 0.15, max: 0.78, kind: 'ratio', rebuild: 'live' },
  lyricOrbitRate: { def: 0.5, min: 0.05, max: 2, kind: 'ratio', rebuild: 'live' },
  // The size of a sign on screen, the steepness of the near/far fall-off, and the floor the far side
  // may not go below: the three numbers that used to be constants in the placement.
  lyricSize: { def: 1, min: 0.4, max: 2.5, kind: 'ratio', rebuild: 'live' },
  // 0 = the sign keeps one world size, so the camera distance does all the work (the most brutal
  // near/far); 2 = the front is normalised back to one screen size (flattest).
  lyricPerspective: { def: 2, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  lyricSpeck: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
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
// volume. The density is a four-octave fractal around the orbit (seamless in azimuth, band-limited
// by the ray's own step) and the shards are a lattice riding the Keplerian flow, looked up once per
// ray at its closest approach to the plane. The galaxy is sampled with a *bounded* screen-space bend
// plus a few taps of blur - a direction-based lookup squeezed the whole sky into vertical strips,
// which is what made the background look like a tube.
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
    'uniform vec3 uJolt;',
    'uniform float uSkyStars;',
    'uniform float uDebris;',
    'uniform float uLevel;',
    '',
    'float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    '',
    '// 3D value noise, quintic-smooth: the disc fog is sampled at the marched point, so the field has',
    '// to exist in the third dimension or every step along a ray reads the same cell (streaks instead',
    '// of wisps). The quintic weights keep the second derivative continuous, so a stack of octaves',
    '// does not show the lattice as a grid of kinks the way a cubic-smooth one does.',
    'float hash13(vec3 p3) {',
    '  p3 = fract(p3 * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'float noise3(vec3 x) {',
    '  vec3 i = floor(x);',
    '  vec3 f = fract(x);',
    '  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);',
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
    '',
    '// The cloud is a fractal sum around the orbit. The ring coordinate is a closed circle, so each',
    '// octave stays seamless where the azimuth wraps; every octave also turns the ring by its own',
    '// phase and shifts the radial coordinate, so no two octaves share a lattice and the sum cannot',
    '// read as one repeated cell. The first octave is the cloud\'s shape, each later one adds detail',
    '// at half the weight, and lod drops the fine octaves once the ray step is coarser than their',
    '// wavelength - that is what turns the radial moire back into fog instead of leaving it on screen.',
    'float discFbm(float flow, float ringR, float rad, float lod) {',
    '  float sum = 0.0;',
    '  float amp = 0.5;',
    '  float f = 1.0;',
    '  for (int i = 0; i < 4; i++) {',
    '    float keep = 1.0;',
    '    if (i == 2) keep = 1.0 - 0.55 * lod;',
    '    if (i == 3) keep = 1.0 - lod;',
    '    float a = flow + 1.73 * float(i) + 0.37;',
    '    vec2 ring = vec2(cos(a), sin(a)) * (ringR * f);',
    '    float rz = rad * f + 5.17 * float(i);',
    '    sum += amp * keep * noise3(vec3(ring, rz));',
    '    f *= 2.02;',
    '    amp *= 0.5;',
    '  }',
    '  return sum * 1.0667;',
    '}',
    '',
    '// Fragments in the disc. One sparse lattice cell is looked up at the marched point nearest the',
    '// disc plane, so a shard is a crisp speck rather than a dot the step size can walk over. The',
    '// lattice is keyed on the orbital phase - angle minus the local Keplerian rate times time - so a',
    '// shard sits still in the disc while the disc turns under it. Cells are square in arc length, so',
    '// a shard does not stretch with radius, and the silhouette is eased so it reads as a broken',
    '// shard rather than a round grain.',
    'float discFragment(vec3 p, float r, float rn, float amount) {',
    '  if (amount <= 0.001 || r <= 0.0) return 0.0;',
    '  float cells = max(8.0, floor(6.28318 * r / 0.20));',
    '  float phase = atan(p.z, p.x) - uSpin * 1.6 * iTime / pow(max(r, 0.42), 1.5);',
    '  float cu = phase * cells / 6.28318;',
    '  float cr = r / 0.20;',
    '  vec2 cell = vec2(floor(cu), floor(cr));',
    '  float h = hash13(vec3(cell, 0.37));',
    '  if (h > amount * 0.18) return 0.0;',
    '  float hx = hash13(vec3(cell, 1.7));',
    '  float hy = hash13(vec3(cell, 5.3));',
    '  float hz = hash13(vec3(cell, 9.1));',
    '  vec2 f = vec2(fract(cu), fract(cr));',
    '  float arc = 6.28318 * r / cells;',
    '  vec2 d = vec2((f.x - 0.5 - (hx - 0.5) * 0.30) * arc, (f.y - 0.5 - (hy - 0.5) * 0.30) * 0.20);',
    '  d.x /= 0.75 + hz * 0.35;',
    '  float size = 0.034 + 0.028 * hy;',
    '  float body = max(0.0, 1.0 - dot(d, d) / (size * size));',
    '  body *= body;',
    '  float lobes = 0.70 + 0.30 * sin(5.0 * atan(d.y, d.x + 1e-4) + hz * 6.28318);',
    '  return body * lobes * smoothstep(0.0, 0.10, rn) * (1.0 - smoothstep(0.90, 1.0, rn));',
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
    '  // The whole picture shakes: the sky, the disc and both text channels sample through this uv,',
    '  // so one offset moves them together instead of sliding the disc out of its own background.',
    '  vec2 uv = fragCoord.xy / iResolution.xy + uJolt.xy;',
    // A long lens with a slow, small drift: the frame breathes instead of sitting still, which is
  // most of what separates a plate of a huge thing from a screenshot of a shader.
  '  vec2 ndc = (uv - 0.5) * 2.0 * (1.0 + uDolly + uJolt.z) + uShake;',
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
    '  // The disc sample is offset along the step by this hash. A uniform march integrates the slab at',
    '  // the same fraction of every step, and that regularity is the banding that ran across the disc.',
    '  float jit = hash21(fragCoord + vec2(13.7, 5.1));',
    '  float bestSide = 1e9;',
    '  float bestR = 0.0;',
    '  float bestRn = 0.0;',
    '  float bestTransmit = 1.0;',
    '  vec3 bestPos = vec3(0.0);',
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
    '      vec3 sp = pos + vel * (dt * (jit - 0.5));',
    '      float sideJ = dot(sp, discN);',
    '      float rJ = max(0.0001, length(sp));',
    '      float vert = max(0.0, 1.0 - abs(sideJ) / halfThick);',
    '      float rn = clamp((rJ - uDiscInner) / max(0.001, uDiscOuter - uDiscInner), 0.0, 1.0);',
    '      float radial = smoothstep(0.0, 0.18, rn) * (1.0 - smoothstep(0.72, 1.0, rn));',
    '      float heat = pow(1.0 - rn, 1.7);',
    // The fog is a point field sampled at the marched position, turned with the flow. Keplerian
    // shear winds the filaments into a spiral over the first seconds and then eases off: an
    // unbounded shear would wind the field into radial moire over a song. The rigid term keeps the
    // pattern visibly turning once the shear has settled.
    '      float omega = uSpin * 0.55 / pow(max(rJ, 0.42), 1.5);',
    '      float wound = omega * iTime * 0.8;',
    '      float shear = 1.8 * wound / (1.0 + abs(wound));',
    '      float flow = atan(sp.z, sp.x) - shear - uSpin * 0.55 * iTime;',
    '      float radCoord = rJ * 3.0 + sideJ * 7.0;',
    '      float lod = smoothstep(0.015, 0.06, dt);',
    '      float warp = noise3(vec3(cos(flow), sin(flow), 0.0) * 0.62 + vec3(3.1, 7.7, radCoord * 0.62 + 1.3)) - 0.5;',
    '      float base = discFbm(flow + warp * 0.9, 2.6 * rJ, radCoord + warp * 0.6, lod);',
    '      float field = smoothstep(0.30, 0.62, base);',
    '      float fog = mix(1.0, 0.04 + 2.6 * field, clamp(uWisp, 0.0, 2.0) * 0.7);',
    '      vec2 tangent = normalize(vec2(-pos.z, pos.x));',
    '      vec2 motion = normalize(vec2(vel.x, vel.z));',
    // The ray runs away from the eye, so material moving *with* it is receding. The side the spin
    // sweeps towards the camera - the one whose material comes at us - is the bright one; getting
    // this sign wrong lights the receding side, which is the mirror image of what the eye expects
    // from the rotation it can see.
    '      float doppler = 1.0 - uSpin * 0.8 * dot(tangent, motion);',
    '      float density = vert * radial * fog;',
    '      vec3 tint = mix(vec3(1.0, 0.50, 0.18), vec3(1.0, 0.96, 0.88), heat);',
    '      emit += tint * (0.22 + 1.8 * heat) * max(0.10, doppler) * density * dt * uDiscGain * transmit;',
    '      transmit *= exp(-density * dt * 1.6 * (0.5 + uDiscGain));',
    '      if (abs(side) < bestSide) { bestSide = abs(side); bestR = rJ; bestRn = rn; bestTransmit = transmit; bestPos = sp; }',
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
    '  vec3 bg = (sampleSky(lensUv, uSoft) + starField(uv + bend, iTime) * 0.85 * uSkyStars) * skyMask;',
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
    '  // Shards inside the disc: one lookup where the ray came closest to the plane, dimmed by the fog',
    '  // it passed on the way in. They belong to the cloud instead of being painted over it.',
    '  if (bestR > uDiscInner && bestR < uDiscOuter) {',
    '    float shard = discFragment(bestPos, bestR, bestRn, uDebris);',
    '    float fheat = pow(1.0 - bestRn, 1.7);',
    '    vec3 ftint = mix(vec3(1.0, 0.54, 0.24), vec3(1.0, 0.94, 0.86), fheat);',
    '    color += ftint * shard * (0.9 + 1.8 * fheat) * bestTransmit * (0.45 + 0.55 * uDebris);',
    '  }',
  '',
  // Far rows have their own channel, outside the galaxy target: they must not take the radial blur
  // that softens the galaxy (a nearly edge-on row would read as a blob), and the fog must only veil
  // them, not swallow them whole. They are sampled at the *same* coordinate as the backdrop, so a
  // row that has gone behind the hole is dragged out to the rim exactly like the picture behind it -
  // the text appears on the lens arcs instead of being quietly squeezed a little and then hidden.
  // What is left of the fog is a veil, not a wall: a floor of visibility through the densest slab.
    '  vec4 farText = texture2D(iChannel2, lensUv);',
    '  float farFade = skyMask * mix(0.42, 1.0, transmit);',
    '  color = mix(color, farText.rgb, clamp(farText.a * farFade, 0.0, 1.0));',
  // Near rows are in front of the hole, so they are pasted straight over the picture: the lens
  // belongs to what is behind the hole, and that is the two channels above.
    '  vec4 text = texture2D(iChannel1, uv);',
    '  color = color * (1.0 - text.a) + text.rgb;',
    '  fragColor = vec4(color, 1.0);',
    '}'
  ].join('\n'),
  { channels: 3 }
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
  farRt: null,
  textQuads: 0,
  farQuads: 0,
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
  if (blackHoleState.farRt && blackHoleState.farRt.dispose) blackHoleState.farRt.dispose();
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
  blackHoleState.farRt = null;
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
    // Far rows are their own layer: the galaxy target is blurred radially, and a far row that went
    // through that blur came out as a smear instead of a row.
    var farRt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false
    });
    farRt.texture.wrapS = THREE.ClampToEdgeWrapping;
    farRt.texture.wrapT = THREE.ClampToEdgeWrapping;
    var material = new THREE.ShaderMaterial({
      vertexShader: BH_PASS_VS,
      fragmentShader: BH_PASS_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      uniforms: {
        iChannel0: { value: rt.texture },
        iChannel1: { value: textRt.texture },
        iChannel2: { value: farRt.texture },
        uTextLens: { value: 1 },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uSoft: { value: 3 },
        uShadowUv: { value: 0.3 },
        uShake: { value: new THREE.Vector2() },
        uDolly: { value: 0 },
        uJolt: { value: new THREE.Vector3() },
        uSkyStars: { value: 1 },
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
    blackHoleState.farRt = farRt;
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
  if (blackHoleState.farRt) blackHoleState.farRt.setSize(w, h);
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
  if (u.uSkyStars) u.uSkyStars.value = bhClamp(bhParam('skyStars'), 0, 3);
  if (u.uWisp) u.uWisp.value = bhClamp(bhParam('discWisp'), 0, 2);
  if (u.uShadowUv) u.uShadowUv.value = frame.uvShadow || 0.3;
  if (u.uDebris) u.uDebris.value = bhClamp(bhParam('debris'), 0, 1);
  var drift = bhCameraDrift(blackHoleFlight.time, bhClamp(bhParam('cameraDrift'), 0, 1));
  if (u.uShake) u.uShake.value.set(drift.x, drift.y);
  if (u.uDolly) u.uDolly.value = drift.dolly;
  // The jolt: three axes of fast wobble, harder the closer the hole is and the louder the music,
  // with the beat raising the rate rather than striking it.
  if (u.uJolt) {
    var joltEnergy = (typeof audioEnergy !== 'undefined') ? Number(audioEnergy) || 0 : 0;
    var joltHeat = (typeof beatPulse !== 'undefined') ? Number(beatPulse) || 0 : 0;
    var joltGain = bhShockGain(frame.uvShadow, joltEnergy, joltHeat, bhParam('shock'), bhParam('shockAudio'));
    var joltRate = bhClamp(bhParam('shockRate'), 0.3, 3) * (1 + joltHeat * 1.2);
    var jolt = bhShockJolt(blackHoleFlight.time, joltGain, joltRate);
    u.uJolt.value.set(jolt.x, jolt.y, jolt.z);
  }
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
  // The galaxy turns at a rate the knob sets, so it needs the frame time: passing zero (which the
  // render path used to) made 星系自转 a dial that did nothing.
  blackHoleState.frameDt = Math.max(0, Number(dt) || 0);
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
  bhPlaceGalaxy(frame, blackHoleState.frameDt || 0);
  var started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  var firstDraw = blackHoleState.draws === 0;
  var shaderErrors = [];
  var quads = blackHoleState.quadScene ? blackHoleState.quadScene.children : [];
  var screenQuad = quads[0];
  var lyrics = (typeof bhLyrics !== 'undefined' && bhLyrics && bhLyrics.layer) ? bhLyrics.layer : null;
  var galaxy = (typeof bhGalaxy !== 'undefined' && bhGalaxy && bhGalaxy.group) ? bhGalaxy.group : null;
  try {
    // 1. the world with no lyric rows in it: the galaxy is what the lens bends and the disc fog
    //    covers, and a row baked into that target would take the radial blur meant for the galaxy.
    if (lyrics) bhSetLyricSideVisibility('none');
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
    // 3. the far half, alone, as its own channel: it is composited with the disc's own fog instead
    //    of being baked into the galaxy, which is what buried it and what blurred it into a blob.
    renderer.setRenderTarget(blackHoleState.farRt);
    if (lyrics && bhSetLyricSideVisibility(false) > 0) {
      if (galaxy) galaxy.visible = false;
      renderer.render(scene, camera);
      if (galaxy) galaxy.visible = true;
      blackHoleState.farQuads++;
    } else {
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

// How close the hole is, read off how much of the frame its shadow takes: bigger on screen means
// the camera is deeper in the field, and that is what the jolt has to answer to.
function bhShockProximity(uvShadow) {
  return bhClamp(((Number(uvShadow) || 0) - 0.10) / 0.30, 0, 1);
}

// The jolt's amplitude in uv. Louder music shakes harder; the beat only feeds the same number.
function bhShockGain(uvShadow, energy, heat, amount, audio) {
  var loud = bhClamp(Number(amount) || 0, 0, 2) * bhShockProximity(uvShadow);
  var audioAmt = bhClamp(Number(audio) || 0, 0, 2);
  return loud * (1 + audioAmt * (bhClamp(Number(energy) || 0, 0, 1) * 0.6
    + bhClamp(Number(heat) || 0, 0, 1) * 0.8)) * 0.012;
}

// Three axes of fast, incommensurable wobble. The beat does not strike the camera: it raises the
// rate, so the same shake comes at you faster while the music is hot.
function bhShockJolt(time, gain, rate) {
  var t = Number(time) || 0;
  var f = Math.max(0.2, Number(rate) || 1) * 4.2;
  var g = Math.max(0, Number(gain) || 0);
  return {
    x: g * (Math.sin(t * f + 0.7) * 0.6 + Math.sin(t * f * 2.31 + 1.9) * 0.4),
    y: g * (Math.sin(t * f * 1.37 + 2.6) * 0.6 + Math.sin(t * f * 2.93 + 0.4) * 0.4),
    z: g * Math.sin(t * f * 1.71 + 4.1) * 0.55
  };
}

// How much of a row survives at a distance from the hole, in horizon radii. The row stays readable
// all the way across the shadow - it is composited after the pass, so the shadow cannot eat it -
// and is extinguished in the last third of a horizon radius, at the edge light cannot leave.
function bhSwallowAlpha(distance, horizonRadius) {
  if (!(horizonRadius > 1e-6)) return 1;
  return bhClamp((distance / horizonRadius - 1.02) / 0.30, 0, 1);
}

// A row's mass is its own length: the user asked for the line's gravity to differ with the line, so
// a long line falls faster than a short one. Bounded so neither end of a song is a stone or a
// balloon.
function bhLyricMass(item) {
  var text = String((item && item.text) || '');
  return bhClamp(0.85 + text.length / 18, 0.85, 1.9);
}

// One vertex of a row bent along the orbit: the row is an arc of the circle it stands on, so its
// curvature is the hole's radius at that moment. `localX` is the flat plane's x in [-0.5, 0.5] and
// the mesh's own x scale is `width`, so the returned (x, z) are local to that same scaled mesh.
function bhRowBend(localX, width, radius) {
  var w = Math.max(1e-4, Number(width) || 0);
  var r = Math.max(1e-3, Number(radius) || 0);
  var a = (Number(localX) || 0) * w / r;
  return { x: (r / w) * Math.sin(a), z: r * (Math.cos(a) - 1), angle: a };
}

// The width of a row's arc at a given radius. The row is spaghettified as it closes on the hole:
// the arc length grows with the fall while the glyphs keep their height, so the line smears into a
// long band. The limit is one full turn - at the horizon the band is closed round the hole instead
// of piling on itself for ever - which is the visual answer to "stretched to infinite length".
function bhLyricArcWidth(width, radius, orbit) {
  var w = Math.max(1e-4, Number(width) || 0);
  var r = Math.max(1e-4, Number(radius) || 0);
  var o = Math.max(r, Number(orbit) || r);
  var t = bhClamp(1 - r / o, 0, 1);
  var stretched = w * (1 + 2.2 * t * t * t);
  var ring = 6.28318 * r * 0.98;
  return Math.min(stretched, ring);
}

// Which side of the hole a row is on, as a 0..1 blend: 0 is the near half of the orbit, 1 the far
// half, and the band around the hole's own depth keeps both channels partly on. That band is what
// removes the pop when a row crosses behind the hole: it does not switch channels in one frame.
function bhLyricSideBlend(along, depth, band) {
  var d = Number(depth) || 0;
  var b = Math.max(1e-4, Number(band) || 0.3);
  return bhClamp((Number(along) - (d - b)) / (2 * b), 0, 1);
}

// How much of the sky's bend a row actually takes. A source behind the lens is deflected by
// D_ls / D_s: a row sitting 10% deeper than the hole is bent a tenth as much as the galaxy behind
// it, and the rows here are only 9-26% deeper. Bending them as if they were the sky - which is what
// the pass does to every pixel - made the near copy and the far copy disagree by a fifth of the
// screen height, and made the row jump by that much as it crossed the hole's own plane.
function bhLyricLensWeight(along, depth, distance) {
  var d = Math.max(1e-4, Number(distance) || 0);
  if (d <= (Number(depth) || 0)) return 0;
  return bhClamp((d - (Number(depth) || 0)) / d, 0, 1);
}

// The pass's own inverse bend as a scalar: a pixel at radius q is pulled towards the hole by
// min(deflect*0.65*rs^2/impact, 1.6*rs) * nearMask * textLens, with the impact parameter floored at
// the shadow. This is the number the picture is bent by, so the rows can be pre-warped by it.
function bhLyricLensPull(q, uvShadow, deflect, textLens) {
  var qlen = Math.max(1e-4, Number(q) || 0);
  var sh = Math.max(1e-4, Number(uvShadow) || 0);
  var impact = Math.max(qlen, sh * 0.98);
  var mag = Math.min((Number(deflect) || 0) * 0.65 * sh * sh / impact, sh * 1.6);
  var t = bhClamp((qlen - sh * 1.05) / (sh * 1.55), 0, 1);
  return mag * (1 - t * t * (3 - 2 * t)) * bhClamp(Number(textLens) || 0, 0, 1);
}

// A row's drift through the disc, in world units along the disc normal: two incommensurable sines
// with a phase of their own, and a deeper swing while it is falling. Pure, so the "rows must not
// bob in lockstep" can be checked as numbers instead of by eye.
function bhLyricBob(index, time, fallAmount, drift) {
  var phase = index * 1.73 + 0.37;
  var u = bhClamp(Number(fallAmount) || 0, 0, 1);
  var amp = (0.02 + bhClamp(Number(drift) || 0, 0, 2) * 0.12) * (1 + 0.9 * u);
  var t = Number(time) || 0;
  return (Math.sin(t * 0.83 + phase) * 0.55 + Math.sin(t * 1.67 + phase * 2.3) * 0.45) * amp;
}

// A row is one quad per glyph, rewritten every frame from the boxes the canvas recorded: that is
// what lets a single character drift without dragging its neighbours, while the arch is still bent
// around the hole.
function bhBuildGlyphGeometry(maxGlyphs) {
  var geometry = new THREE.BufferGeometry();
  var cap = Math.max(1, Math.round(Number(maxGlyphs) || 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 12), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(cap * 8), 2));
  var index = new Uint16Array(cap * 6);
  for (var q = 0; q < cap; q++) {
    var b = q * 4, o = q * 6;
    index[o] = b; index[o + 1] = b + 1; index[o + 2] = b + 2;
    index[o + 3] = b; index[o + 4] = b + 2; index[o + 5] = b + 3;
  }
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setDrawRange(0, 0);
  return geometry;
}

function bhHash01(n) {
  var x = Math.sin((Number(n) || 0) * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// A glyph's own drift, in the row's local units (the row is one unit wide and one tall). It is zero
// until the row falls and grows with the square of the fall: a line is unreadable if it comes apart
// while it is being sung, and it is the plunge that should scatter it into the disc.
function bhGlyphDrift(seed, index, progress, amount, time) {
  var p = bhClamp(Number(progress) || 0, 0, 1);
  var amp = bhClamp(Number(amount) || 0, 0, 1.5) * p * p * 0.22;
  if (amp <= 1e-6) return { x: 0, y: 0 };
  var t = (Number(time) || 0) * 0.9;
  var h1 = bhHash01((Number(seed) || 0) * 131 + index * 17);
  var h2 = bhHash01((Number(seed) || 0) * 71 + index * 41 + 7);
  return {
    x: Math.sin(t * 0.63 + h1 * 6.283) * amp * 0.5 + (h1 - 0.5) * amp,
    y: (Math.sin(t * 1.07 + h2 * 6.283) * 0.65 + Math.sin(t * 1.9 + h1 * 3.1) * 0.35) * amp
  };
}

function bhBendRowGlyphs(row, width, radius, amount, progress, time) {
  var geometry = row && row.mesh ? row.mesh.geometry : null;
  var glyphs = row && row.glyphs;
  var position = geometry && geometry.attributes ? geometry.attributes.position : null;
  var uv = geometry && geometry.attributes ? geometry.attributes.uv : null;
  if (!position || !uv || !glyphs || !glyphs.length) return 0;
  var win = Math.max(1, row.canvas && row.canvas.width ? row.canvas.width : 1);
  var hin = Math.max(1, row.canvas && row.canvas.height ? row.canvas.height : 1);
  var n = Math.min(glyphs.length, Math.floor(position.array.length / 12), Math.floor(uv.array.length / 8));
  var p = position.array, u = uv.array;
  var seed = row.itemIndex >= 0 ? row.itemIndex : 0;
  for (var i = 0; i < n; i++) {
    var g = glyphs[i];
    var d = bhGlyphDrift(seed, i, progress, amount, time);
    var cx = ((g.x0 + g.x1) * 0.5) / win - 0.5 + d.x;
    var cy = 0.5 - ((g.y0 + g.y1) * 0.5) / hin + d.y;
    var hw = Math.max(1e-5, (g.x1 - g.x0) * 0.5 / win);
    var hh = Math.max(1e-5, (g.y1 - g.y0) * 0.5 / hin);
    var left = bhRowBend(cx - hw, width, radius);
    var right = bhRowBend(cx + hw, width, radius);
    var v = i * 12;
    p[v] = left.x; p[v + 1] = cy + hh; p[v + 2] = left.z;
    p[v + 3] = right.x; p[v + 4] = cy + hh; p[v + 5] = right.z;
    p[v + 6] = right.x; p[v + 7] = cy - hh; p[v + 8] = right.z;
    p[v + 9] = left.x; p[v + 10] = cy - hh; p[v + 11] = left.z;
    var k = i * 8;
    var u0 = g.x0 / win, u1 = g.x1 / win;
    var vt = 1 - g.y0 / hin, vb = 1 - g.y1 / hin;
    u[k] = u0; u[k + 1] = vt;
    u[k + 2] = u1; u[k + 3] = vt;
    u[k + 4] = u1; u[k + 5] = vb;
    u[k + 6] = u0; u[k + 7] = vb;
  }
  position.needsUpdate = true;
  uv.needsUpdate = true;
  if (geometry.setDrawRange) geometry.setDrawRange(0, n * 6);
  return n;
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
  // The fall is a real inspiral, not a scripted swoop: the row is thrown sideways out of the front
  // and then winds round the hole at the Keplerian rate of wherever it is, so it lazier at the
  // outside and frantic as the radius closes. The heavier the line, the faster its fall.
  var mass = bhLyricMass(item);
  var span = Math.max(0.4, (Number(params.swallow) || 9) / mass);
  var tau = t - exitStart;
  if (tau >= span) return null;
  var u = bhClamp(tau / span, 0, 1);
  var curve = bhClamp(Number(params.curve) || 0.5, 0.05, 3);
  // Inside the black disk there is nothing to see, so the radius floors at the rim (the shadow's
  // edge, passed in as a fraction of the orbit). Without that floor it kept shrinking into the
  // centre, where "in front of" and "behind" the hole are the same thing and the near/far hand-over
  // flickered - but parking there for the last third read as "it stops, then blinks out". Now the
  // spiral runs the whole way in and lands on the rim exactly as the fall ends.
  var rim = bhClamp(Number(params.rim) || 0, 0, 1);
  // The inward part takes this share of the fall; the rest is the rim orbit. Two thirds of the
  // length spirals, the last third turns at the edge where it can still be seen.
  var RIM_RISE = 1;
  var uu = bhClamp(u / RIM_RISE, 0, 1);
  var rawRho = Math.pow(Math.max(0, 1 - uu), curve);
  var rho = Math.max(rim, rawRho);
  // dphi/dtau = rate / rho^1.5. The integral is closed form up to the rim, then linear along it.
  var expo = 1 - 1.5 * curve;
  var wound;
  if (rim > 1e-4) {
    var uuFloor = 1 - Math.pow(rim, 1 / curve);
    var v = Math.min(uu, uuFloor);
    var inward = Math.abs(expo) < 1e-3
      ? -Math.log(Math.max(1e-4, 1 - v))
      : (1 - Math.pow(Math.max(0, 1 - v), expo)) / expo;
    if (uu > uuFloor) inward += (uu - uuFloor) / Math.pow(rim, 1.5);
    wound = RIM_RISE * inward;
    if (u > RIM_RISE) wound += (u - RIM_RISE) / Math.pow(rim, 1.5);
  } else {
    wound = Math.abs(expo) < 1e-3
      ? -Math.log(Math.max(1e-4, 1 - u))
      : (1 - Math.pow(Math.max(0, 1 - u), expo)) / expo;
  }
  wound = Math.min(wound, 64);
  var kick = (function () {
    var x = bhClamp(tau / 0.35, 0, 1);
    return x * x * (3 - 2 * x);
  })();
  var turn = rate * span * wound * kick + (Number(params.wind) || 0) * u * kick;
  return {
    phase: 'fall',
    angle: frontAngle - turn,
    radius: rho,
    alpha: 1,
    fall: u,
    mass: mass,
    // Seconds of fall left: the placement fades on this, because the radius no longer reaches the
    // horizon (the rim is as close as a visible row can get).
    left: span * (1 - u),
    // Radians per second right now: the tests read this as the spin-up, and so could a caller that
    // wants to blur fast rows.
    spin: rate / Math.pow(Math.max(1e-3, rho), 1.5)
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

// Greedy wrap. A row is one sign, and a sign carrying a 40-character line cannot be fitted onto the
// screen at a readable height: the whole row is scaled down to the frame width, which turns it into
// a two-pixel strip and it disappears. Wrapping turns the line into a block; the number of lines
// rides along in lineScale, and the placement makes the sign taller by that much so each line keeps
// its size. Latin breaks at spaces, CJK breaks between characters.
function bhWrapText(ctx, text, maxWidth, maxLines) {
  var source = String(text || '');
  var out = [];
  var current = '';
  var limit = Math.max(1, Math.round(Number(maxLines) || 1));
  // A wrap that breaks at a space drops that space, so "we lost characters" is not the same as
  // "the line was cut off": comparing lengths and then indexing out[limit-1] threw on every frame
  // for any short line that wrapped (the row then froze the whole preset). Track the real cut.
  var truncated = false;
  for (var i = 0; i < source.length; i++) {
    var ch = source.charAt(i);
    var candidate = current + ch;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      var space = current.lastIndexOf(' ');
      if (space > 0 && ch !== ' ') {
        out.push(current.slice(0, space));
        current = current.slice(space + 1) + ch;
      } else {
        out.push(current);
        current = ch;
      }
      if (out.length >= limit) { current = ''; truncated = true; break; }
    } else {
      current = candidate;
    }
  }
  if (current && out.length < limit) out.push(current);
  if (!out.length) out.push('');
  if (truncated && out.length) {
    var lastIndex = Math.min(out.length, limit) - 1;
    var last = String(out[lastIndex] || '');
    while (last.length > 0 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    out[lastIndex] = last + '…';
  }
  return out;
}

// Rasterises one row onto its own canvas: the line and, under it, its translation. The canvas is
// sized to the measured text so the plane carries no empty margin that would shrink the letters.
function bhDrawRowCanvas(row, item, sung, palette, motion) {
  // The sign is displayed at roughly two to three times the layout typographic size (the plane's
  // height is a fraction of the view), so the canvas is rendered at that multiple. Drawing at the
  // layout size and letting the GPU magnify was exactly the blur.
  var superSample = 2.5;
  var fontPx = bhLyricFontPx() * superSample;
  var subPx = Math.round(fontPx * 0.62);
  var font = '700 ' + fontPx.toFixed(1) + 'px ' + (typeof HALO_FONT !== 'undefined' ? HALO_FONT : '"JetBrains Mono","Microsoft YaHei",monospace');
  var subFont = '400 ' + subPx.toFixed(1) + 'px ' + (typeof HALO_FONT !== 'undefined' ? HALO_FONT : 'monospace');
  var measure = row.ctx;
  var pad = Math.max(4, fontPx * 0.35);
  var mainH = fontPx * 1.35;
  var subH = subPx * 1.6;
  var maxWidth = Math.min(1900, Math.max(fontPx * 10, 900 * superSample));
  measure.font = font;
  var mainLines = bhWrapText(measure, item.text, maxWidth, 4);
  measure.font = subFont;
  var subLines = item.sub ? bhWrapText(measure, item.sub, maxWidth, 2) : [];
  var textWidth = 0;
  measure.font = font;
  for (var li = 0; li < mainLines.length; li++) {
    textWidth = Math.max(textWidth, measure.measureText(mainLines[li]).width || 0);
  }
  measure.font = subFont;
  for (var si = 0; si < subLines.length; si++) {
    textWidth = Math.max(textWidth, measure.measureText(subLines[si]).width || 0);
  }
  var canvasWidth = Math.max(fontPx * 4, Math.min(2048, Math.ceil(textWidth + pad * 2)));
  // The translation band is reserved on every row, so the glyphs occupy the same share of the
  // plane whether or not the line has a translation and the text does not change size line to line.
  var subBands = Math.max(1, subLines.length);
  var singleHeight = Math.ceil(mainH + subH + pad * 2);
  var canvasHeight = Math.ceil(mainLines.length * mainH + subBands * subH + pad * 2);
  row.lineScale = bhClamp(canvasHeight / singleHeight, 1, 2.8);
  row.textureScale = superSample;
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
  for (var mi = 0; mi < mainLines.length; mi++) {
    ctx.fillText(mainLines[mi], width / 2, pad + (mi + 0.5) * mainH);
  }
  if (subLines.length) {
    ctx.font = subFont;
    ctx.fillStyle = bhLyricCss(palette.context, alpha * 0.72);
    var subTop = pad + mainLines.length * mainH;
    for (var sj = 0; sj < subLines.length; sj++) {
      ctx.fillText(subLines[sj], width / 2, subTop + (sj + 0.5) * subH);
    }
  }
  // Every glyph's box on the canvas. The plane is rebuilt from these each frame, so one character
  // can drift without dragging its neighbours - a single quad per row can only move the whole line.
  ctx.font = font;
  var glyphs = [];
  for (var gm = 0; gm < mainLines.length; gm++) {
    bhLineGlyphBoxes(ctx, mainLines[gm], width / 2, pad + (gm + 0.5) * mainH, mainH, glyphs);
  }
  if (subLines.length) {
    ctx.font = subFont;
    for (var gs = 0; gs < subLines.length; gs++) {
      bhLineGlyphBoxes(ctx, subLines[gs], width / 2, subTop + (gs + 0.5) * subH, subH, glyphs);
    }
  }
  row.glyphs = glyphs.slice(0, BH_MAX_ROW_GLYPHS);
  row.glyphVersion = (row.glyphVersion || 0) + 1;
  row.sung = sung;
}

// Character boxes for one drawn line, in canvas pixels. Whitespace is dropped: a space has no glyph
// to move, and leaving it in would put a visible seam in the line's UVs.
function bhLineGlyphBoxes(ctx, line, centerX, centerY, lineH, out) {
  var text = String(line || '');
  var total = (ctx.measureText(text) && ctx.measureText(text).width) || 0;
  var x = centerX - total / 2;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    var adv = (ctx.measureText(ch) && ctx.measureText(ch).width) || 0;
    if (ch.trim()) out.push({ x0: x, x1: x + adv, y0: centerY - lineH / 2, y1: centerY + lineH / 2 });
    x += adv;
  }
  return out;
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
  // One quad per glyph, rewritten every frame: the arch and each character's own drift are both
  // written into this buffer, so nothing accumulates from one frame to the next.
  var geometry = bhBuildGlyphGeometry(BH_MAX_ROW_GLYPHS);
  var mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 60;
  // The far copy is the same sign, geometry and material included, drawn at the position that is
  // left over once the pass has bent it: the two channels need different transforms and nothing
  // else, so the second object carries the difference instead of a second texture.
  var farMesh = new THREE.Mesh(geometry, material);
  farMesh.frustumCulled = false;
  farMesh.renderOrder = 60;
  farMesh.visible = false;
  return {
    canvas: canvas, ctx: canvas.getContext('2d'), texture: texture, material: material,
    mesh: mesh, farMesh: farMesh, itemIndex: -1, sung: null, live: false, front: true
  };
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

// The row pool is sized by the lyricRows knob. Slots are cheap until used: each starts with a tiny
// canvas and only takes a real texture when a line lands on it, so a fast song can keep forty rows
// alive without forty full-size buffers sitting around.
var BH_MAX_LYRIC_ROWS = 48;
// One quad per glyph: four main lines plus two translation lines of a very long lyric still fit.
var BH_MAX_ROW_GLYPHS = 260;

function bhEnsureLyricRowCount(count) {
  if (typeof THREE === 'undefined' || !bhLyrics || !bhLyrics.layer) return 0;
  var want = Math.max(3, Math.min(BH_MAX_LYRIC_ROWS, Math.round(Number(count) || 9)));
  while (bhLyrics.rows.length < want) {
    var row = bhBuildLyricRow(64, 32);
    row.mesh.scale.set(1, 1, 1);
    row.mesh.visible = false;
    row.farMesh.scale.set(1, 1, 1);
    row.farMesh.visible = false;
    bhLyrics.layer.add(row.mesh);
    bhLyrics.layer.add(row.farMesh);
    bhLyrics.rows.push(row);
  }
  while (bhLyrics.rows.length > want) {
    var extra = bhLyrics.rows.pop();
    if (extra.mesh && extra.mesh.parent) extra.mesh.parent.remove(extra.mesh);
    if (extra.farMesh && extra.farMesh.parent) extra.farMesh.parent.remove(extra.farMesh);
    if (extra.texture && extra.texture.dispose) extra.texture.dispose();
    if (extra.material && extra.material.dispose) extra.material.dispose();
    if (extra.mesh && extra.mesh.geometry && extra.mesh.geometry.dispose) extra.mesh.geometry.dispose();
  }
  return bhLyrics.rows.length;
}

// Which lines can be alive at once, from the row count: the current line, two ahead (so the next
// one can already be easing in) and the rest behind, still falling. Pure, so the fast-song behaviour
// can be checked without a scene.
function bhLyricWindowRange(sung, itemCount, rowCount) {
  var n = Math.max(0, Math.round(Number(itemCount) || 0));
  var rows = Math.max(3, Math.round(Number(rowCount) || 3));
  if (!n) return { lo: 0, hi: -1 };
  var anchor = sung < 0 ? 0 : Math.round(Number(sung) || 0);
  var keep = Math.max(1, rows - 3);
  return { lo: sung < 0 ? 0 : Math.max(0, anchor - keep), hi: Math.min(n - 1, anchor + 2) };
}

function bhBuildLyrics() {
  if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene) return false;
  var items = bhLyricItems();
  var layer = new THREE.Group();
  layer.frustumCulled = false;
  var fontPx = bhLyricFontPx();
  scene.add(layer);
  bhLyrics.layer = layer;
  bhLyrics.rows = [];
  bhEnsureLyricRowCount(bhParam('lyricRows'));
  bhLyrics.items = items;
  bhLyrics.listKey = bhLyricListKey(items);
  bhLyrics.builtKey = bhLyrics.listKey + '|' + fontPx;
  return true;
}

function bhLyricParams() {
  return {
    orbit: bhClamp(bhParam('lyricOrbit'), 0.05, 0.8),
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
  var horizonWorld = Math.max(1e-4, Number(frame.horizonWorld) || 0.3);
  // The rim a row may not pass is the edge of the black disk (the shadow), not the horizon: inside
  // the shadow the row is either hidden or sitting on the centre where front/back has no meaning.
  var shadowWorld = Math.max(0, (Number(frame.uvShadow) || 0) * depth * tanHalf);
  var rimWorld = Math.max(horizonWorld * 1.02, shadowWorld * 0.98);
  // The knob is a fraction of the distance; it becomes a world radius here, where the distance is
  // known. The cap keeps the near half in front of the eye whatever the camera does.
  params.orbit = bhClamp(params.orbit * depth, 0.4, depth * 0.78);
  params.rim = bhClamp(rimWorld / Math.max(1e-4, params.orbit), 0.01, 1);
  var items = bhLyrics.items;
  var sung = bhLyrics.sung;
  var anchor = sung < 0 ? 0 : sung;
  // The window is the row pool: a fast song needs every slot to keep the older inspiral alive, so
  // the history is rows - 3 lines (the current one and two ahead take the rest).
  var range = bhLyricWindowRange(sung, items.length, bhLyrics.rows.length);
  var lo = range.lo;
  var hi = range.hi;
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
    // Every row has its own pair of incommensurable sines: one swings it a little along the orbit,
    // the other lifts and drops it through the disc. A queue of falls must not read as a rail.
    var phase = index * 1.73 + 0.37;
    var wobble = params.drift * (Math.sin(time * 0.6 + phase) * 0.035 + Math.sin(time * 1.7 + phase * 2.1) * 0.018);
    var angle = state.angle + wobble;
    var radius = params.orbit * state.radius;
    var point = bhOrbitPoint(basis, radius, angle);
    // Falling rows bob harder: they are bodies tumbling in the disc's volume, not stickers on a
    // ring, and the vertical motion is what makes the disc read as thick.
    var bob = bhLyricBob(index, time, state.phase === 'fall' ? state.fall : 0, params.drift);
    point.x += basis.n.x * bob;
    point.y += basis.n.y * bob;
    point.z += basis.n.z * bob;
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
    // The split is a blend near the hole's depth - but only well outside the strong-lens zone. At
    // the rim the row is as deep as the hole itself, and the two versions (flat vs lensed) are far
    // apart, so a blend there is a flickering double image; close in, the row simply stays in the
    // near channel at its true position.
    var sideBand = Math.max(0.15, params.height * depth * tanHalf * 1.2);
    var nearHole = radius <= shadowWorld * 1.8;
    row.sideBlend = nearHole ? 0 : bhLyricSideBlend(alongRow, depth, sideBand);
    row.nearAlpha = 1 - row.sideBlend;
    row.farAlpha = row.sideBlend;
    row.front = row.sideBlend < 0.5;
    row.mesh.renderOrder = 60;
    // Sized against the hole's own depth: the front of the orbit is closer to the eye, so it is
    // drawn bigger by the perspective, and a line on the far side is smaller and hazier.
    // A wrapped line is a taller sign, not four lines squeezed into the height of one.
    // The sign is sized against the distance it is seen at, not against the ring: a bigger orbit
    // puts the front of the ring closer to the eye, and the sign has to shrink with it or the near
    // half would fill the frame. Behind the hole the perspective then does the shrinking on its own.
    var frontShare = Math.pow(Math.max(0.15, (depth - params.orbit) / Math.max(1e-4, depth)),
      2 - bhClamp(bhParam('lyricPerspective'), 0, 2));
    var worldH = params.height * depth * tanHalf * frontShare * bhClamp(bhParam('lyricSize'), 0.4, 2.5)
      * (current ? 1.12 : 0.95) * (row.lineScale || 1);
    var rowAlong = Math.max(0.05, alongRow);
    // A speck, not a vanishing point: the far half shrinks by perspective until it is unreadable,
    // and that is the point - but it may not disappear while it is still turning.
    worldH = Math.max(worldH, 0.0008 * bhClamp(bhParam('lyricSpeck'), 0, 2) * 2 * rowAlong * tanHalf);
    var widthNdc = worldH * (row.widthRatio || 4) / (rowAlong * tanHalf * aspect);
    // The near side is allowed to overflow the frame: capping the sign at 86% of the screen is what
    // flattened the near/far difference - a near object should be too big for the frame.
    var fit = widthNdc > 1.45 ? 1.45 / widthNdc : 1;
    var worldW = worldH * (row.widthRatio || 4) * fit;
    var worldHH = worldH * fit;
    // The arch is the orbit itself: its radius of curvature is the row's distance to the hole, so at
    // the front it hugs the disc and, as it falls, it closes in with the hole. A short line is
    // stretched along the orbit until the arch is actually visible (a 40 cm line on a 2.4 m orbit
    // would otherwise be almost straight); the stretch is uniform, so the glyphs keep their shape.
    // The target uses the *orbit* radius, not the row's current one, so the line keeps one size from
  // the front all the way in; the curvature tightens and the tidal stretch takes over on the way.
    var arcTarget = params.orbit * 0.46;
    var grow = Math.max(1, arcTarget / Math.max(1e-4, worldW));
    worldW *= grow;
    worldHH *= grow;
    worldW = bhLyricArcWidth(worldW, radius, params.orbit);
    row.mesh.scale.set(worldW, worldHH, 1);
    // The arch, plus each glyph's own drift, which only opens up during the fall.
    bhBendRowGlyphs(row, worldW, radius, params.drift, state.phase === 'fall' ? state.fall : 0, time);
    // The far copy. The pass pulls every pixel of its channel inwards by `pull`, so the sign is
    // drawn that much inside its true position - less the share its own depth behind the hole pays
    // for. What is left on screen is the true position plus weight*pull: continuous with the near
    // copy where the row crosses the hole's plane (weight 0), and the sky's full wrap for a row deep
    // behind it. Bending it as if it were the sky is what put the two copies a fifth of a screen
    // apart.
    if (row.farMesh) {
      var camRight = (frame.camera && frame.camera.right) || { x: 1, y: 0, z: 0 };
      var camUp = (frame.camera && frame.camera.up) || { x: 0, y: 1, z: 0 };
      var toRowX = wx - camera.position.x, toRowY = wy - camera.position.y, toRowZ = wz - camera.position.z;
      var dist = Math.sqrt(toRowX * toRowX + toRowY * toRowY + toRowZ * toRowZ);
      var offRight = toRowX * camRight.x + toRowY * camRight.y + toRowZ * camRight.z;
      var offUp = toRowX * camUp.x + toRowY * camUp.y + toRowZ * camUp.z;
      var uvx = 0.5 + offRight / (2 * rowAlong * tanHalf * aspect);
      var uvy = 0.5 + offUp / (2 * rowAlong * tanHalf);
      var qx = (uvx - (frame.uv ? frame.uv.u : 0.5)) * aspect;
      var qy = uvy - (frame.uv ? frame.uv.v : 0.5);
      var qlen = Math.max(1e-4, Math.sqrt(qx * qx + qy * qy));
      var pull = bhLyricLensPull(qlen, frame.uvShadow,
        bhClamp(bhParam('deflect'), 0, 3), bhClamp(bhParam('textLens'), 0, 1));
      var weight = bhLyricLensWeight(alongRow, depth, dist);
      // Never carry the copy through the hole's own centre: the bend folds there (a pixel inside the
      // shadow reads the far side), and text appearing on the opposite arc would be a lie. Rows that
      // deep behind the hole are hidden by it, which is what they should do.
      var pre = Math.min((1 - weight) * pull, qlen * 0.9);
      var push = pre * 2 * rowAlong * tanHalf;
      row.lensWeight = weight;
      row.lensPull = pull;
      row.lensPreWarp = pre;
      var shiftRight = -(qx / qlen) * push * aspect;
      var shiftUp = -(qy / qlen) * push;
      row.farMesh.position.set(
        point.x + camRight.x * shiftRight + camUp.x * shiftUp,
        point.y + camRight.y * shiftRight + camUp.y * shiftUp,
        point.z + camRight.z * shiftRight + camUp.z * shiftUp);
      row.farMesh.quaternion.copy(row.mesh.quaternion);
      row.farMesh.scale.copy(row.mesh.scale);
    }
    row.mesh.visible = true;
    var opacity = current ? 1 : 0.72;
    if (state.phase === 'read') opacity = current ? 1 : 0.85;
    if (state.phase === 'approach') opacity = state.alpha * (current ? 1 : 0.9);
    // The rim is outside the horizon, so the old horizon fade never fires any more: the row fades on
    // the fall's own clock instead, over its last second or so at the rim. Keep the horizon fade as
    // a floor, for a rim that is very small.
    if (state.phase === 'fall') {
      // The row dissolves over the last third of its fall instead of being switched off in the last
      // breath: with a long spin-in that is the whole time it spends parked at the rim, and a fixed
      // 1.2 s there read as "it sits there, then blinks out". The horizon fade stays as a floor.
      var fadeWindow = Math.max(1.2, Math.max(0.1, params.swallow) * 0.34);
      var approach = bhClamp((Number(state.left) || 0) / fadeWindow, 0, 1);
      opacity = Math.min(bhSwallowAlpha(radius, horizonWorld), approach);
    }
    row.baseOpacity = opacity;
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
    if (!row || !row.mesh) continue;
    if (row.itemIndex < 0 || !row.live) {
      row.mesh.visible = false;
      if (row.farMesh) row.farMesh.visible = false;
      continue;
    }
    // Rows placed before the blend existed (and the tests' hand-made rows) fall back to the old
    // binary split.
    var nearAlpha = (row.nearAlpha === undefined || row.nearAlpha === null) ? (row.front ? 1 : 0) : row.nearAlpha;
    var farAlpha = (row.farAlpha === undefined || row.farAlpha === null) ? (row.front ? 0 : 1) : row.farAlpha;
    var base = (row.baseOpacity === undefined || row.baseOpacity === null)
      ? (row.material && row.material.opacity !== undefined ? row.material.opacity : 1)
      : row.baseOpacity;
    var visible = true;
    var alpha = 1;
    if (side === 'none') {
      visible = false;
    } else if (side === true) {
      alpha = nearAlpha;
      visible = nearAlpha > 0.001;
    } else if (side === false) {
      alpha = farAlpha;
      visible = farAlpha > 0.001;
    }
    // The near copy is the sign where the geometry puts it; the far copy is the pre-warped one the
    // pass bends back to the same place plus its own depth's share of the bend. The plain fallback
    // render has no bend at all, so it draws the near copy only.
    row.mesh.visible = visible && side !== false;
    if (row.farMesh) row.farMesh.visible = side === false && visible;
    if (row.material) row.material.opacity = base * alpha;
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
// The lyric path runs before the render and only this preset owns it, so anything that throws in
// here stops the picture for good (the app, the audio and every other preset are unaffected, which
// makes it look like "only the black hole froze"). A throw is reported once, counted, and the frame
// falls back to the preset without lyrics instead of dying.
function updateBlackHoleLyrics(dt) {
  if (!blackHolePresetIsActive()) return false;
  try {
    return bhUpdateBlackHoleLyrics(dt);
  } catch (error) {
    var message = String((error && error.message) || error);
    blackHoleState.lyricErrors = (blackHoleState.lyricErrors || 0) + 1;
    if (blackHoleState.lyricError !== message) {
      blackHoleState.lyricError = message;
      try { console.error('[BlackHole] lyric path threw, frame skipped:', message); } catch (e) {}
    }
    return false;
  }
}

function bhUpdateBlackHoleLyrics(dt) {
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
