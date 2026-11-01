const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 银河黑洞 (preset 15) runs here against a fake THREE, fake renderer and fake scene. The point is
// not to draw anything: it is to prove the geometry and the laws the shader and the flight share
// with the JS side, and that the pass really is a pass - scene into a target, one quad out - with
// a fallback when it cannot run.

const root = path.join(__dirname, '..');
const modulePath = process.env.BLACKHOLE_MODULE_PATH
  ? path.resolve(process.env.BLACKHOLE_MODULE_PATH)
  : path.join(root, 'public', 'js', 'modules', '02-visual', '19-galaxy-blackhole-preset.js');
const driverPath = process.env.SHADERTOY_DRIVER_PATH
  ? path.resolve(process.env.SHADERTOY_DRIVER_PATH)
  : path.join(root, 'public', 'js', 'modules', '02-visual', '20-shadertoy-driver.js');
const source = fs.readFileSync(modulePath, 'utf8');
// The fragment stage is built at load, so the Shadertoy driver has to be in the sandbox too.
const driverSource = fs.readFileSync(driverPath, 'utf8');
const loopPath = process.env.MAIN_LOOP_PATH
  ? path.resolve(process.env.MAIN_LOOP_PATH)
  : path.join(root, 'public', 'js', 'modules', '11-main-loop.js');
const loopText = fs.readFileSync(loopPath, 'utf8');

// ------------------------------------------------------------------ fake THREE
class V3 {
  constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  applyQuaternion() { return this; }
  clone() { return new V3(this.x, this.y, this.z); }
}
class V4 {
  constructor(x, y, z, w) { this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = w || 0; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
}
class V2 {
  constructor(x, y) { this.x = x || 0; this.y = y || 0; }
  set(x, y) { this.x = x; this.y = y; return this; }
}

function makeThree(record) {
  return {
    Vector3: V3,
    Vector4: V4,
    Vector2: V2,
    LinearFilter: 1,
    DoubleSide: 2,
    RGBAFormat: 2,
    UnsignedByteType: 3,
    ClampToEdgeWrapping: 4,
    WebGLRenderTarget: function (w, h) {
      this.id = record.targetIds = (record.targetIds || 0) + 1;
      this.width = w;
      this.height = h;
      this.texture = { wrapS: 0, wrapT: 0 };
      this.setSize = function (nw, nh) { this.width = nw; this.height = nh; record.rtSizes.push([nw, nh]); };
      var self = this;
      this.dispose = function () { record.disposed.push('rt' + self.id); };
    },
    ShaderMaterial: function (opts) {
      this.uniforms = opts.uniforms;
      this.fragmentShader = opts.fragmentShader;
      this.vertexShader = opts.vertexShader;
      this.dispose = function () { record.disposed.push('material'); };
    },
    Scene: function () { this.children = []; this.add = function (o) { this.children.push(o); }; this.clear = function () { this.children = []; }; },
    OrthographicCamera: function () {},
    Mesh: function (geo, mat) {
      this.geometry = geo; this.material = mat; this.visible = true; this.frustumCulled = true;
      this.position = new V3();
      this.scale = new V3(1, 1, 1);
      this.quaternion = { copy: function (source) { this.copiedFrom = source; return this; } };
    },
    PlaneGeometry: function () { this.dispose = function () { record.disposed.push('geometry'); }; },
    Group: function () {
      this.children = [];
      this.position = new V3();
      this.quaternion = { copy: function (source) { this.copiedFrom = source; return this; } };
      this.rotation = { z: 0 };
      this.visible = true;
      this.add = function (o) { this.children.push(o); o.parent = this; };
      this.remove = function (o) { this.children = this.children.filter(function (c) { return c !== o; }); };
      this.updateMatrixWorld = function () {};
    },
    Points: function (geometry, material) {
      this.geometry = geometry;
      this.material = material;
      this.count = geometry ? geometry.pointCount : 0;
      this.rotation = { z: 0 };
    },
    BufferGeometry: function () {
      var self = this;
      this.attributes = {};
      this.pointCount = 0;
      this.setAttribute = function (name, attr) { self.attributes[name] = attr; if (name === 'position') self.pointCount = attr.count; };
      this.setIndex = function (index) { self.index = index; };
      this.setDrawRange = function (start, count) { self.drawRange = { start: start, count: count }; };
      this.dispose = function () { record.disposed.push('galaxy-geometry'); };
    },
    BufferAttribute: function (array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; },
    AdditiveBlending: 5,
    PointsMaterial: function (options) {
      options = options || {};
      this.size = options.size;
      this.sizeAttenuation = options.sizeAttenuation;
      this.vertexColors = options.vertexColors;
      this.opacity = options.opacity;
      this.transparent = options.transparent;
      this.userData = {};
      this.dispose = function () { record.disposed.push('galaxy-material'); };
    }
  };
}

function makeCamera(position, lookDir, fov, aspect) {
  return {
    position: new V3(position.x, position.y, position.z),
    quaternion: {},
    fov: fov,
    aspect: aspect,
    getWorldDirection(target) {
      target.x = lookDir.x; target.y = lookDir.y; target.z = lookDir.z;
      return target;
    },
    updateProjectionMatrix() {}
  };
}

function load(overrides) {
  const record = { draws: [], rtSizes: [], disposed: [], setTarget: [] };
  const sandbox = {
    console,
    THREE: makeThree(record),
    __record: record
  };
  Object.assign(sandbox, overrides || {});
  sandbox.window = sandbox.window || { devicePixelRatio: 1, localStorage: { getItem: () => null, setItem() {} } };
  sandbox.innerWidth = 1600;
  sandbox.innerHeight = 900;
  vm.createContext(sandbox);
  vm.runInContext(driverSource + String.fromCharCode(10) + source, sandbox, { filename: modulePath });
  return sandbox;
}

// ------------------------------------------ the backdrop is smeared *radially*, the stars sparkle
{
  const sandbox = load({ fx: { preset: 15 } });

  // The blur taps: symmetric around the sample point, a zero tap in the middle, and a radius in
  // pixels - this is the "one to five pixels" the user asked for, not an isotropic soft focus.
  // JSON, not deepStrictEqual: an array built inside the vm has that realm's Array prototype.
  assert.strictEqual(JSON.stringify(sandbox.bhRadialBlurOffsets(0)), '[0,0,0,0,0]', 'a zero radius is no blur at all');
  const taps = sandbox.bhRadialBlurOffsets(4);
  assert.strictEqual(JSON.stringify(taps), '[-4,-2,0,2,4]', 'five taps at a radius of four pixels: ' + JSON.stringify(taps));
  assert(taps[0] === -taps[4] && taps[1] === -taps[3], 'the taps must be symmetric');
  assert(sandbox.bhParam('softness') >= 1 && sandbox.bhParam('softness') <= 5,
    'the default blur has to stay in the one-to-five pixel range, got ' + sandbox.bhParam('softness'));

  // The shader: taps along the radial direction, a four-point glint on the stars, and no isotropic
  // soft-focus left behind (that is what made the backdrop look cheap).
  assert(/vec2 away = uv - uCenter;/.test(source), 'the blur direction has to come from the hole');
  assert(/vec2 o = dir \* \(float\(i\) \* 0\.5 \* blurPx\) \* texel;/.test(source),
    'the taps must be radial and scaled in pixels');
  assert(/float glint = exp\(-ad\.x \* 240\.0\) \* exp\(-ad\.y \* 22\.0\)/.test(source),
    'distant stars have to carry a four-point glint');
  assert(/starField\(uv \+ bend, iTime\)/.test(source), 'the stars have to be added to the backdrop');
  assert(!/texel\.x \* r \* 2\.4/.test(source), 'the old isotropic five-tap soft focus must be gone');
  // The subject stays sharp: everything that builds the disc and the ring is added after the blur.
  const blurAt = source.indexOf('sampleSky(lensUv, uSoft)');
  const discAt = source.indexOf('emit += tint');
  assert(discAt > 0 && blurAt > 0 && discAt < blurAt, 'the disc is built before the backdrop is sampled, unblurred');

  // The disc is a volume sampled in 3D, and its density is a fractal sum, not one hashed cell:
  // four octaves around the ring, each turned and shifted so no two share a lattice, each at half
  // the weight of the one before. The ring is a closed circle so the azimuth stays seamless.
  for (const pattern of [/float hash13\(vec3/, /float noise3\(vec3/, /float discFbm\(float flow, float ringR, float rad, float lod\)/]) {
    assert(pattern.test(source), 'the disc fog needs a 3D noise field: ' + pattern);
  }
  assert(/vec2 ring = vec2\(cos\(a\), sin\(a\)\) \* \(ringR \* f\);/.test(source),
    'each octave has to stay seamless where the azimuth wraps');
  assert(/float a = flow \+ 1\.73 \* float\(i\) \+ 0\.37;/.test(source),
    'every octave has to turn the ring by its own phase, or the octaves line up into a lattice');
  assert(/float rz = rad \* f \+ 5\.17 \* float\(i\);/.test(source),
    'and shift the radial coordinate by its own offset');
  assert(/sum \+= amp \* keep \* noise3\(vec3\(ring, rz\)\);/.test(source), 'the octaves have to be summed with weights');
  assert(/amp \*= 0\.5;/.test(source), 'each octave must carry half the weight of the one before it');
  assert(/if \(i == 3\) keep = 1\.0 - lod;/.test(source),
    'the finest octave has to be band-limited away once the ray step is coarser than its wavelength');
  assert(/float lod = smoothstep\(0\.015, 0\.06, dt\);/.test(source),
    'the band limit has to come from the step size, which is the aliasing scale');
  assert(/float warp = noise3\(vec3\(cos\(flow\), sin\(flow\), 0\.0\) \* 0\.62/.test(source),
    'with a low-frequency warp in the ring frame for the filaments');
  assert(/float base = discFbm\(flow \+ warp \* 0\.9, 2\.6 \* rJ, radCoord \+ warp \* 0\.6, lod\);/.test(source),
    'the ring scale has to follow the radius, or the features stretch into concentric arcs at the outside');
  assert(/float field = smoothstep\(0\.30, 0\.62, base\);/.test(source), 'the fog needs its contrast');
  assert(/float fog = mix\(1\.0, 0\.04 \+ 2\.6 \* field/.test(source),
    'the field has to be what the fog reads');
  assert(/float radCoord = rJ \* 3\.0 \+ sideJ \* 7\.0;/.test(source),
    'the sample has to carry the height inside the slab, or the ray reads one cell all the way through');
  assert(/vec3 sp = pos \+ vel \* \(dt \* \(jit - 0\.5\)\);/.test(source),
    'the slab sample has to be jittered along the step, or the integration lands on the same fractions every step');
  assert(/float jit = hash21\(fragCoord \+ vec2\(13\.7, 5\.1\)\);/.test(source), 'and that jitter has to be per pixel');
  assert(/float shear = 1\.8 \* wound \/ \(1\.0 \+ abs\(wound\)\);/.test(source),
    'the Keplerian shear has to be bounded: an unbounded one winds the field into radial moire over a song');
  // Doppler: the side whose material comes towards the eye is the bright one. The ray runs *away*
  // from the eye, so material moving with it is receding - the opposite sign lights the mirror image
  // of the rotation the eye can see.
  assert(/float doppler = 1\.0 - uSpin \* 0\.8 \* dot\(tangent, motion\);/.test(source),
    'the Doppler has to brighten the approaching side, not the receding one');
  {
    // The same arithmetic on the canonical geometry: camera in front of the disc looking at it, a
    // point on the right of the hole and one on the left, spin turned up.
    const dopplerAt = function (px, pz, vx, vz, spin) {
      const tl = Math.hypot(px, pz);
      const ml = Math.hypot(vx, vz);
      const tangent = { x: -pz / tl, z: px / tl };
      const motion = { x: vx / ml, z: vz / ml };
      return 1 - spin * 0.8 * (tangent.x * motion.x + tangent.z * motion.z);
    };
    const rightOfHole = dopplerAt(1, 0, 0, -1, 1);
    const leftOfHole = dopplerAt(-1, 0, 0, -1, 1);
    assert(rightOfHole > 1 && leftOfHole < 1,
      'at spin 1 the side the disc turns towards the camera has to be the bright one: '
      + rightOfHole.toFixed(3) + ' / ' + leftOfHole.toFixed(3));
    assert(Math.abs((rightOfHole - 1) + (leftOfHole - 1)) < 1e-12, 'and the two sides mirror each other');
    assert(Math.abs(dopplerAt(1, 0, 0, -1, -1) - leftOfHole) < 1e-12, 'flipping the spin flips the bright side');
  }
  assert(/float fog = mix\(1\.0, 0\.04 \+ 2\.6 \* field, clamp\(uWisp, 0\.0, 2\.0\) \* 0\.7\);/.test(source),
    'and the wisp amount has to reach the density');
  assert(/if \(u\.uWisp\) u\.uWisp\.value = bhClamp\(bhParam\('discWisp'\), 0, 2\);/.test(source),
    'the discWisp knob has to be written to the shader every frame');
  assert(!/float fbm3\(vec3/.test(source), 'the three-octave lattice fbm is not the field any more');
  assert(!/float grain = mix\(0\.25, 1\.75/.test(source), 'the old hashed-cell grain must be gone');
  console.log('backdrop: radial taps ' + JSON.stringify(taps) + ' at ' + sandbox.bhParam('softness') + 'px, four-point stars, no isotropic blur');
}

// ---------------------------------------- the weight of the shot: long lens, drift, debris
{
  const sandbox = load({ fx: { preset: 15 } });
  // A long lens is the framing: the default has to be narrower than the app's own 45 degrees.
  assert(sandbox.bhParam('fovDeg') < 48, 'the default fov must be a long lens, got ' + sandbox.bhParam('fovDeg'));

  // Drift: nothing when it is off, bounded when it is on, slow between frames, and never repeating
  // inside a song (two incommensurable sines per axis).
  const off = sandbox.bhCameraDrift(12.3, 0);
  assert(off.x === 0 && off.y === 0 && off.dolly === 0, 'drift 0 must be still');
  const on = sandbox.bhCameraDrift(12.3, 1);
  assert(Math.abs(on.x) <= 0.0024 + 1e-12 && Math.abs(on.y) <= 0.0021 + 1e-12 && Math.abs(on.dolly) <= 0.008 + 1e-12,
    'drift must stay bounded: ' + JSON.stringify(on));
  const next = sandbox.bhCameraDrift(12.316, 1);
  assert(Math.abs(next.x - on.x) < 0.0002 && Math.abs(next.dolly - on.dolly) < 0.001,
    'one frame of drift must be a slow change');
  let moved = false;
  for (let t = 0; t < 40; t += 0.37) {
    const a = sandbox.bhCameraDrift(t, 1);
    if (Math.abs(a.x - on.x) > 0.0004) { moved = true; break; }
  }
  assert(moved, 'the drift has to actually move over a song');

  // The shader applies the drift to the ray and puts the debris *inside* the disc: shards on a
  // lattice keyed on the orbital phase, looked up at the point of the march nearest the disc plane,
  // and dimmed by the fog the ray already crossed. Screen-space specks are not debris.
  assert(/vec2 ndc = \(uv - 0\.5\) \* 2\.0 \* \(1\.0 \+ uDolly \+ uJolt\.z\) \+ uShake;/.test(source),
    'the drift, the dolly and the jolt have to reach the ray');
  // The jolt offsets the uv that every channel samples through, so the hole, the disc, the sky and
  // both text channels shake together - the disc must not slide out of its own background.
  assert(/vec2 uv = fragCoord\.xy \/ iResolution\.xy \+ uJolt\.xy;/.test(source),
    'the jolt has to offset the uv every channel samples through');
  assert(/uniform vec3 uJolt;/.test(source), 'the jolt needs its own uniform');
  // The jolt answers to how much of the frame the hole takes, and to the music - the beat raises
  // the rate instead of striking the camera.
  assert(sandbox.bhShockProximity(0.10) === 0 && sandbox.bhShockProximity(0.40) === 1,
    'the jolt has to be off for a tiny hole and full for a big one');
  assert(sandbox.bhShockProximity(0.25) > 0 && sandbox.bhShockProximity(0.25) < 1, 'and ramp in between');
  assert(sandbox.bhShockGain(0.32, 1, 1, 0, 1) === 0, 'the knob at zero means no jolt');
  assert(sandbox.bhShockGain(0.32, 0, 0, 1, 1) === sandbox.bhShockGain(0.32, 0, 0, 1, 0),
    'with 抖动随节奏 at zero the music must not touch it');
  assert(sandbox.bhShockGain(0.32, 1, 1, 1, 1) > sandbox.bhShockGain(0.32, 0, 0, 1, 1),
    'but loud, beaty music has to shake harder');
  assert(sandbox.bhShockGain(0.38, 0.5, 0.5, 1, 1) > sandbox.bhShockGain(0.20, 0.5, 0.5, 1, 1),
    'and a hole that fills more of the frame has to shake harder');
  {
    const g = sandbox.bhShockGain(0.32, 1, 1, 1, 1);
    const slow = sandbox.bhShockJolt(1.0, g, 1);
    const fast = sandbox.bhShockJolt(1.0, g, 2.6);
    assert(Math.abs(slow.x) <= g + 1e-12 && Math.abs(slow.y) <= g + 1e-12
      && Math.abs(slow.z) <= g * 0.55 + 1e-12, 'every axis has to stay inside the gain');
    assert(Math.abs(slow.x) + Math.abs(slow.y) + Math.abs(slow.z) > 1e-6, 'and actually move');
    const crossings = function (rate) {
      let n = 0;
      let prev = sandbox.bhShockJolt(0, g, rate).x;
      for (let i = 1; i <= 200; i++) {
        const cur = sandbox.bhShockJolt(i * 0.01, g, rate).x;
        if ((cur > 0) !== (prev > 0)) n++;
        prev = cur;
      }
      return n;
    };
    assert(crossings(2.6) > crossings(1) * 1.8,
      'the beat has to come at the camera faster, not harder: ' + crossings(1) + ' -> ' + crossings(2.6));
    const still = sandbox.bhShockJolt(1.0, 0, 1);
    assert(still.x === 0 && still.y === 0 && still.z === 0, 'no gain means the frame is still');
  }
  // The beat has to reach the rate through the frame wiring, not only through the pure function.
  assert(/var joltRate = bhClamp\(bhParam\('shockRate'\), 0\.3, 3\) \* \(1 \+ joltHeat \* 1\.2\);/.test(source),
    'the frame has to hand the beat-driven rate to the jolt');
  assert(/u\.uJolt\.value\.set\(jolt\.x, jolt\.y, jolt\.z\);/.test(source), 'and write all three axes to the shader');
  assert(/float discFragment\(vec3 p, float r, float rn, float amount\)/.test(source),
    'the disc fragments must exist');
  assert(/float phase = atan\(p\.z, p\.x\) - uSpin \* 1\.6 \* iTime \/ pow\(max\(r, 0\.42\), 1\.5\);/.test(source),
    'a shard has to be fixed in the orbital frame, turning at the local Keplerian rate');
  assert(/float cells = max\(8\.0, floor\(6\.28318 \* r \/ 0\.20\)\);/.test(source),
    'the lattice has to be square in arc length, or a shard stretches with radius');
  assert(/if \(abs\(side\) < bestSide\) \{ bestSide = abs\(side\); bestR = rJ; bestRn = rn; bestTransmit = transmit; bestPos = sp; \}/.test(source),
    'the ray has to remember where it came closest to the disc plane');
  assert(/float shard = discFragment\(bestPos, bestR, bestRn, uDebris\);/.test(source),
    'the shards have to be looked up there with the debris knob');
  assert(/color \+= ftint \* shard \* \(0\.9 \+ 1\.8 \* fheat\) \* bestTransmit/.test(source),
    'and dimmed by the fog in front of them, which is what embeds them in the disc');
  assert(!/nearDebris\(/.test(source), 'the screen-space specks must be gone: the user asked for things inside the disc');
  console.log('epic: fov ' + sandbox.bhParam('fovDeg') + ' deg, drift ' + on.x.toFixed(5) + '/' + on.y.toFixed(5)
    + ' dolly ' + on.dolly.toFixed(5) + ' (bounded, slow), disc shards in the fog');
}

// ------------------------------------------------------- the marched Schwarzschild field
//
// The pass is a ray march now, so the numbers that matter are the ones a photon makes: the
// deflection law, the capture radius and the disc crossing. Each is checked against a closed form
// rather than against the shader's own constants.
{
  const api = load({ fx: { preset: 15 } });
  const march = api.bhMarchRay;

  // Weak field: a photon that misses by b is deflected by about 2/b horizon radii.
  const far = march({ x: -80, y: 30, z: 0 }, { x: 1, y: 0, z: 0 }, { steps: 4000 });
  const weak = Math.atan2(-far.dirOut.y, far.dirOut.x);
  assert(Math.abs(weak - 2 / 30) < (2 / 30) * 0.12, 'weak-field deflection must be ~2/b: ' + weak.toFixed(5));
  assert(far.captured === false, 'a photon that misses by 30 radii must escape');

  // Just inside the critical impact parameter the ray wraps around the hole instead of flying on.
  const wound = march({ x: -80, y: 2.5, z: 0 }, { x: 1, y: 0, z: 0 }, { steps: 4000 });
  assert(wound.captured === true || wound.dirOut.x < 0.9, 'a near-critical ray must wrap, not fly straight');

  // Inside 3*sqrt(3)/2 radii nothing escapes; outside it everything does.
  [0.4, 1.0, 1.6, 2.4].forEach(function (b) {
    const shot = march({ x: -80, y: b, z: 0 }, { x: 1, y: 0, z: 0 }, { steps: 4000 });
    assert(shot.captured === true, 'a photon with impact parameter ' + b + ' must be captured');
  });
  [4, 8, 20].forEach(function (b) {
    const shot = march({ x: -80, y: b, z: 0 }, { x: 1, y: 0, z: 0 }, { steps: 4000 });
    assert(shot.captured === false, 'a photon with impact parameter ' + b + ' must escape');
  });

  // The disc is a volume now: a ray that passes through the slab accumulates optical depth, a
  // zero-thickness slab accumulates none, and the depth grows with the thickness - that is what
  // makes it a fog the camera can be inside of instead of a sheet.
  const thin = march({ x: -30, y: 3.2, z: 0 }, { x: 0.97, y: -0.24, z: 0 }, { steps: 4000, discInner: 1.05, discOuter: 12, discThickness: 0.02 });
  const thick = march({ x: -30, y: 3.2, z: 0 }, { x: 0.97, y: -0.24, z: 0 }, { steps: 4000, discInner: 1.05, discOuter: 12, discThickness: 1.6 });
  assert(thin.discOptical >= 0 && thick.discOptical > thin.discOptical * 4,
    'a thicker slab must accumulate more: ' + thin.discOptical + ' vs ' + thick.discOptical);
  const outsideDisc = march({ x: -30, y: 3.2, z: 0 }, { x: 0.97, y: -0.24, z: 0 }, { steps: 4000, discInner: 1.05, discOuter: 2, discThickness: 1.6 });
  assert(outsideDisc.discOptical === 0, 'a ray that passes outside the disc radii must not accumulate: ' + outsideDisc.discOptical);
  // A camera sitting inside the slab sees it immediately, which is the case that used to be a
  // single crossing or nothing at all.
  const inside = march({ x: -8, y: 0.1, z: 0.1 }, { x: 1, y: 0.02, z: 0 }, { steps: 4000, discInner: 1.05, discOuter: 12, discThickness: 1.6 });
  assert(inside.discOptical > 0, 'a camera inside the disc must see it');

  // The fall the arc rows use when a line stops being sung: exponential-looking, and faster at the
  // end (the row covers more ground in its last tenth than in its first half).
  const fall = api.bhFallDistance;
  assert(Math.abs(fall(5, 0, 2 / 3) - 5) < 1e-9, 'the fall must start at the hold distance');
  assert(fall(5, 1, 2 / 3) < 1e-9, 'and end at the hole');
  // Speed is distance per unit of progress, so both windows have to be the same width.
  const earlySpeed = (fall(5, 0.5, 2 / 3) - fall(5, 0.55, 2 / 3)) / 0.05;
  const lateSpeed = (fall(5, 0.95, 2 / 3) - fall(5, 1, 2 / 3)) / 0.05;
  assert(lateSpeed > earlySpeed * 1.5,
    'the last stretch must be the fast one (' + earlySpeed.toFixed(2) + ' vs ' + lateSpeed.toFixed(2) + ' per unit)');

  // The silhouette the pixel instrument compares against is the critical impact parameter, and it
  // is a circle: the marched field is Schwarzschild, so there is no spin flattening to expect.
  const camera = makeCamera({ x: 0, y: 0.5, z: 6.6 }, { x: 0, y: 0, z: -1 }, 58, 16 / 9);
  const silhouette = load({ camera: camera, fx: { preset: 15 } }).bhSilhouette(8);
  const spread = Math.max.apply(null, silhouette.rays.map(function (r) { return r.s; }))
    - Math.min.apply(null, silhouette.rays.map(function (r) { return r.s; }));
  assert(spread < 1e-9, 'the marched shadow is a circle, spread ' + spread);
  assert(Math.abs(silhouette.cap - 2.598076) < 1e-6, 'and its radius is 3*sqrt(3)/2, got ' + silhouette.cap);
  console.log('march: deflection at b=30 ' + weak.toFixed(5) + ' (2/b ' + (2 / 30).toFixed(5) + ')'
    + ', captured for b<=2.4 / escaped for b>=4, disc optical ' + thin.discOptical.toFixed(3) + ' -> ' + thick.discOptical.toFixed(3)
    + ', shadow radius ' + silhouette.cap.toFixed(4) + ' horizon radii');
}

// ---------------------------------------- the lyric orbit is split front / back in the pass
//
// Rows on the near half of the orbit are between the eye and the hole: they go into their own
// target and are composited over the finished picture. Rows on the far half are behind the hole,
// so they go into the scene target, where the near-field lens bends them and the shadow hides them.
{
  const record = { draws: [], seen: [], rtSizes: [], disposed: [], setTarget: [] };
  const scene = { name: 'app-scene' };
  const lyricsLayer = { isLyrics: true, visible: true, children: [] };
  const galaxyGroup = { isGalaxy: true, visible: true, children: [], position: { set: function () {} }, quaternion: { copy: function () { return this; } } };
  const frontRow = { itemIndex: 1, live: true, front: true, mesh: { visible: false }, farMesh: { visible: true } };
  const backRow = { itemIndex: 2, live: true, front: false, mesh: { visible: true }, farMesh: { visible: true } };
  const sandbox = load({
    THREE: makeThree(record),
    camera: makeCamera({ x: 0, y: 0, z: 6.6 }, { x: 0, y: 0, z: -1 }, 58, 16 / 9),
    scene: scene,
    fx: { preset: 15 },
    renderer: {
      autoClear: true,
      drawingSize: { x: 1600, y: 900 },
      getDrawingBufferSize(target) { target.set(this.drawingSize.x, this.drawingSize.y); return target; },
      clear() {},
      setRenderTarget(target) {
        record.setTarget.push(target
          ? (target === sandbox.blackHoleState.textRt ? 'text-rt' : (target === sandbox.blackHoleState.farRt ? 'far-rt' : 'rt'))
          : null);
      },
      render(targetScene) {
        record.draws.push(targetScene === scene ? 'scene' : 'quad');
        record.seen.push({
          scene: targetScene === scene,
          front: frontRow.mesh.visible, back: backRow.mesh.visible,
          frontFar: frontRow.farMesh.visible, backFar: backRow.farMesh.visible,
          galaxy: galaxyGroup.visible, autoClear: this.autoClear
        });
      }
    }
  });
  sandbox.bhLyrics.layer = lyricsLayer;
  sandbox.bhLyrics.rows = [frontRow, backRow];
  sandbox.bhGalaxy.group = galaxyGroup;
  sandbox.blackHoleState.frame = sandbox.bhComputeFrame();
  assert(sandbox.renderBlackHoleFrame() === true, 'the frame must run');

  assert.deepStrictEqual(record.draws, ['scene', 'scene', 'scene', 'quad'],
    'world, near rows, far rows, then one quad: ' + JSON.stringify(record.draws));
  assert.deepStrictEqual(record.setTarget, ['rt', 'text-rt', 'far-rt', null],
    'three targets then the screen: ' + JSON.stringify(record.setTarget));
  const [worldPass, textPass, farPass, quadPass] = record.seen;
  assert(worldPass.front === false && worldPass.back === false && worldPass.galaxy === true
    && worldPass.frontFar === false && worldPass.backFar === false,
    'the first target is the galaxy alone: a row baked into it would take the galaxy blur');
  assert(textPass.front === true && textPass.back === false && textPass.galaxy === false
    && textPass.frontFar === false && textPass.backFar === false,
    'the second is the near copies alone, at their true positions');
  assert(farPass.front === false && farPass.back === false && farPass.galaxy === false
    && farPass.frontFar === false && farPass.backFar === true,
    'the third is the far copies alone, in their own channel');
  assert(quadPass.scene === false && quadPass.autoClear === true, 'and the pass is one quad, clearing normally');
  assert(sandbox.blackHoleState.textQuads === 1 && sandbox.blackHoleState.farQuads === 1,
    'both text renders are counted: ' + sandbox.blackHoleState.textQuads + '/' + sandbox.blackHoleState.farQuads);
  assert(frontRow.mesh.visible === true && backRow.mesh.visible === true
    && frontRow.farMesh.visible === false && backRow.farMesh.visible === false,
    'after the frame the fallback keeps one copy per row, or the plain render would draw the text twice');

  // The binding is the proof: the pass material reads the near rows as a channel, not as a texture
  // pasted over its output.
  const uniforms = sandbox.blackHoleState.material.uniforms;
  assert(uniforms.iChannel1 && uniforms.iChannel1.value === sandbox.blackHoleState.textRt.texture,
    'iChannel1 must be the near-row target');
  assert(uniforms.iChannel0 && uniforms.iChannel0.value === sandbox.blackHoleState.rt.texture,
    'iChannel0 must be the scene target');
  assert(uniforms.iChannel2 && uniforms.iChannel2.value === sandbox.blackHoleState.farRt.texture,
    'iChannel2 must be the far-row target');
  assert(uniforms.uTextLens, 'the near-field lens amount must reach the shader');
  // The far rows ride the backdrop's own coordinate: a line that has gone behind the hole has to
  // turn up on the lens arcs, at exactly the place the picture behind the hole turns up. Sampling it
  // through a second, gentler bend is what made it read as a light squeeze and then nothing.
  assert(/vec4 farText = texture2D\(iChannel2, lensUv\);/.test(source),
    'the far rows must be sampled through the same lensed coordinate as the backdrop');
  assert((source.match(/bend \* nearMask/g) || []).length === 1,
    'there must be one inverse-bend coordinate only, or the text and the picture can drift apart');
  // What the separate channel keeps is the fog veil and the shadow cut, not a weaker lens.
  assert(/float farFade = skyMask \* mix\(0\.42, 1\.0, transmit\);/.test(source),
    'the fog may veil the far rows but must not be allowed to erase them');
  assert(/color = mix\(color, farText\.rgb, clamp\(farText\.a \* farFade, 0\.0, 1\.0\)\);/.test(source),
    'and they have to be composited before the near rows');
  // The near rows are in front, so they are pasted straight over the picture.
  assert(/color = color \* \(1\.0 - text\.a\) \+ text\.rgb;/.test(source),
    'the near rows must be composited over the shadowed picture');
  assert(/float nearMask = 1\.0 - smoothstep\(uShadowUv \* 1\.05, uShadowUv \* 2\.6, qlen\);/.test(source),
    'the scene lens has to be local to the strong-field zone');
  assert(/vec2 lensUv = clamp\(uv - bend \* nearMask \* clamp\(uTextLens, 0\.0, 1\.0\), 0\.0, 1\.0\);/.test(source),
    'and sampled through the inverse of the bend, or content behind the hole cannot appear around the rim');
  assert(/sampleSky\(lensUv, uSoft\)/.test(source), 'the scene sample must use the lensed coordinate');
  assert(/texture2D\(iChannel1, uv\)/.test(source), 'the near rows are pasted at their own screen position');
  // Without a lyric layer the text target is cleared rather than left holding last frame.
  sandbox.bhLyrics.layer = null;
  record.draws.length = 0;
  record.setTarget.length = 0;
  sandbox.renderBlackHoleFrame();
  assert.deepStrictEqual(record.draws, ['scene', 'quad'], 'no text means no text pass');
  assert.deepStrictEqual(record.setTarget, ['rt', 'text-rt', 'far-rt', null],
    'but both text targets are still cleared for their channels');
  sandbox.bhLyrics.layer = lyricsLayer;
  console.log('channels: ' + record.draws.length + ' draws without text, world+front rows+quad with it; iChannel1 bound to the near rows');
}

// ---------------------------------------- swallowed by the row, not painted over by the hole
{
  const sandbox = load({ fx: { preset: 15 } });
  const insideHorizon = sandbox.bhSwallowAlpha(0.9, 1);
  const atHorizon = sandbox.bhSwallowAlpha(1.01, 1);
  const outside = sandbox.bhSwallowAlpha(1.5, 1);
  const middle = sandbox.bhSwallowAlpha(1.15, 1);
  const overTheShadow = sandbox.bhSwallowAlpha(2.0, 1);
  assert(outside === 1 && overTheShadow === 1,
    'a row still outside the horizon must be whole, even when it is over the shadow: ' + outside + '/' + overTheShadow);
  assert(atHorizon === 0 && insideHorizon === 0, 'at and inside the horizon the row is gone: ' + atHorizon + '/' + insideHorizon);
  assert(middle > 0 && middle < 1, 'a row right at the rim is fading, got ' + middle);
  // Walked from the outside in: getting closer must never make a row brighter.
  let last = 2;
  for (let d = 1.6; d >= 0.8; d -= 0.05) {
    const a = sandbox.bhSwallowAlpha(d, 1);
    assert(a <= last + 1e-12, 'the fade must be monotone on the way in');
    last = a;
  }
  console.log('swallow: 1.5r=' + outside + ', 2r over the shadow=' + overTheShadow
    + ', 1.15r=' + middle.toFixed(2) + ', 1.01r=' + atHorizon);
}

// -------------------------------------- the shadow has to be reachable on the screen it bends
//
// The first version of the lens took the Kerr-Schild radius of the point ON the screen plane.
// That measure is never smaller than the plane's own distance to the hole (6.44 at the defaults),
// so no pixel could fall inside the horizon (1.16): no shadow, almost no bend - and every kernel
// test above still passed, because the algebra was right and the geometry handed to it was wrong.
// These assertions are about the composed geometry, and they are what the live pixel instrument
// later agreed with.
{
  const camera = makeCamera({ x: 0, y: 0, z: 6.6 }, { x: 0, y: 0, z: -1 }, 58, 16 / 9);
  const sandbox = load({ camera: camera, fx: { preset: 15 } });
  const shadow = sandbox.bhSilhouette(8);
  const cap = shadow.cap;
  const a = shadow.radii.a;

  assert(shadow.rays.every(function (ray) { return ray.s > 0 && isFinite(ray.s); }),
    'the shadow boundary must exist in every direction: ' + JSON.stringify(shadow.rays.map(function (r) { return r.s; })));
  assert(shadow.rays.every(function (ray) { return ray.s < shadow.planeZ * 0.9; }),
    'and well inside the frustum, not at infinity: planeZ=' + shadow.planeZ);
  assert(shadow.rays.every(function (ray) { return Math.abs(ray.du) < 0.9 && Math.abs(ray.dv) < 0.9; }),
    'and the uv boundary must be on the screen: ' + JSON.stringify(shadow.rays));

  // The march is Schwarzschild, so the shadow is a circle whatever the spin dial says; the dial
  // only shapes how bright the disc's approaching side looks.
  const equatorial = shadow.rays[0].s;
  const polar = shadow.rays[2].s;
  assert(Math.abs(equatorial - polar) < 1e-9, `the marched shadow must be a circle (${equatorial} vs ${polar})`);
  assert(Math.abs(cap - 2.598076) < 1e-6, 'at the critical impact parameter, got ' + cap);

  const flat = load({ camera: camera, fx: { preset: 15 } });
  flat.blackHoleTuning = { spin: 0, charge: 0, mass: sandbox.bhParam('mass'), shadowScale: sandbox.bhParam('shadowScale') };
  const round = flat.bhSilhouette(8);
  const spread = Math.max.apply(null, round.rays.map(function (r) { return r.s; }))
    - Math.min.apply(null, round.rays.map(function (r) { return r.s; }));
  assert(spread < 1e-4, `spin 0 must give a perfect circle, spread ${spread}`);
  console.log('silhouette: cap=' + cap.toFixed(3) + ' at planeZ ' + shadow.planeZ.toFixed(2)
    + ', s east ' + equatorial.toFixed(3) + ' / north ' + polar.toFixed(3) + ' (a circle)'
    + ', uv radius across ' + shadow.rays[0].du.toFixed(3) + ' / along ' + shadow.rays[2].dv.toFixed(3)
    + ', spin 0 spread ' + spread.toExponential(1));
}

// ------------------------------------------------------------------ the pass is a pass
{
  const camera = makeCamera({ x: 0, y: 0, z: 6.6 }, { x: 0, y: 0, z: -1 }, 58, 16 / 9);
  const scene = { name: 'app-scene' };
  const record = { draws: [], rtSizes: [], disposed: [], setTarget: [] };
  const sandbox = load({
    THREE: makeThree(record),
    camera: camera,
    scene: scene,
    fx: { preset: 15 },
    renderer: {
      drawingSize: { x: 1600, y: 900 },
      getDrawingBufferSize(target) { target.set(this.drawingSize.x, this.drawingSize.y); return target; },
        clear() {},
      setRenderTarget(target) {
        record.setTarget.push(target
          ? (target === sandbox.blackHoleState.textRt ? 'text-rt' : (target === sandbox.blackHoleState.farRt ? 'far-rt' : 'rt'))
          : null);
      },
      render(targetScene) { record.draws.push(targetScene === scene ? 'scene' : 'quad'); }
    }
  });
  sandbox.__record = record;

  assert(sandbox.blackHolePresetIsActive() === true, 'preset 15 must be the active one here');
  const ok = sandbox.renderBlackHoleFrame();
  assert(ok === true, 'the pass must run when the hole is in front of the camera');
  assert.deepStrictEqual(record.draws, ['scene', 'quad'], 'the scene goes in, one quad comes out');
  assert.deepStrictEqual(record.setTarget, ['rt', 'text-rt', 'far-rt', null],
    'three targets, then the screen: ' + JSON.stringify(record.setTarget));
  const status = sandbox.blackHoleStatus();
  assert(status.rt && status.rt[0] > 0, 'the target must exist after the first frame');
  assert(status.uv && Math.abs(status.uv[0] - 0.5) < 0.2, 'the hole projects near the middle: ' + JSON.stringify(status.uv));
  assert(status.shadowUv > 0.02 && status.shadowUv < 0.8, 'the shadow radius must be a sane fraction of the half-height: ' + status.shadowUv);

  // The target follows the renderer, not the window.
  record.rtSizes.length = 0;
  sandbox.renderer.drawingSize = { x: 1200, y: 700 };
  sandbox.renderBlackHoleFrame();
  assert.deepStrictEqual(record.rtSizes[0], [1200, 700], 'a smaller drawing buffer must resize the target: ' + JSON.stringify(record.rtSizes));

  // passScale renders the lens at a fraction of that and the quad still covers the screen.
  sandbox.blackHoleTuning = { passScale: 0.5 };
  record.rtSizes.length = 0;
  sandbox.renderBlackHoleFrame();
  assert.deepStrictEqual(record.rtSizes[0], [600, 350], 'half-scale must halve the target: ' + JSON.stringify(record.rtSizes));
  delete sandbox.blackHoleTuning;

  // The hole rides with the camera, so the only way it loses its projection is a degenerate
  // camera basis - which is exactly the case a fallback has to survive.
  camera.getWorldDirection = function (target) { return target.set(0, 0, 0); };
  sandbox.blackHoleState.frame = null;
  const fellBack = sandbox.renderBlackHoleFrame();
  assert(fellBack === false, 'no projection must fall back instead of drawing garbage');
  assert(sandbox.blackHoleStatus().fallbacks >= 1, 'the fallback has to be visible in the status');

  // A shader that did not compile: three logs it and skips the draw, so the pass has to notice
  // and hand the frame back instead of leaving the previous picture on screen.
  // The degenerate camera above has to be put back first, or this frame never reaches the shader.
  camera.getWorldDirection = function (target) { return target.set(0, 0, -1); };
  sandbox.blackHoleState.frame = null;
  sandbox.fx.preset = 15;
  sandbox.renderBlackHoleFrame();
  assert(sandbox.blackHoleState.material, 'the pass must exist before the compile check');
  sandbox.blackHoleState.material.program = { diagnostics: { runnable: false, programLog: 'boom' } };
  const compileFallback = sandbox.renderBlackHoleFrame();
  assert(compileFallback === false, 'a shader that cannot compile must fall back to the plain render');
  assert(sandbox.blackHoleState.rt === null, 'the failed pass must be disposed instead of retried forever');
  assert(/shader did not compile/.test(sandbox.blackHoleStatus().error), 'the failure must be readable: ' + sandbox.blackHoleStatus().error);

  // The other way a shader can fail: three does not throw, it writes a console.error and moves
  // on. A sandbox console catches that, so a program that will not link is still a fallback.
  {
    const record2 = { draws: [], rtSizes: [], disposed: [], setTarget: [] };
    const noisy = [];
    let emit = function () {};
    const box = load({
      THREE: makeThree(record2),
      console: { log: function () {}, error: function (line) { noisy.push(String(line)); }, warn: function () {} },
      camera: makeCamera({ x: 0, y: 0, z: 6.6 }, { x: 0, y: 0, z: -1 }, 58, 16 / 9),
      scene: scene,
      fx: { preset: 15 },
      renderer: {
        drawingSize: { x: 1600, y: 900 },
        getDrawingBufferSize(target) { target.set(this.drawingSize.x, this.drawingSize.y); return target; },
        clear() {},
        setRenderTarget() {},
        // three reports a failed link through console.error rather than by throwing, so the fake
        // renderer has to raise it the same way, inside the page context.
        render(targetScene) { if (targetScene !== scene) emit(); }
      }
    });
    emit = function () { box.console.error('THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false'); };
    assert(box.renderBlackHoleFrame() === false, 'a console-reported shader error must fall back');
    assert(/shader did not compile/.test(box.blackHoleStatus().error), 'and say so in the status: ' + box.blackHoleStatus().error);
    assert(box.blackHoleState.rt === null, 'and release the pass it cannot use');
    assert(box.blackHoleStatus().draws === 0, 'a frame that did not survive the shader is not a draw');
  }

  // Not the selected preset: the pass must not even build.
  sandbox.fx.preset = 14;
  assert(sandbox.renderBlackHoleFrame() === false, 'another preset must not run the lens');

  // Leaving the preset gives the memory back.
  sandbox.fx.preset = 15;
  // The compile-guard check above disposed the pass on purpose, so build it again before the
  // leave test: otherwise there is nothing to dispose and the assertion would pass for free.
  sandbox.fx.preset = 15;
  sandbox.renderBlackHoleFrame();
  const rtId = sandbox.blackHoleState.rt ? sandbox.blackHoleState.rt.id : null;
  const textRtId = sandbox.blackHoleState.textRt ? sandbox.blackHoleState.textRt.id : null;
  const farRtId = sandbox.blackHoleState.farRt ? sandbox.blackHoleState.farRt.id : null;
  sandbox.applyBlackHolePresetNow(15, 14);
  assert(rtId !== null && record.disposed.indexOf('rt' + rtId) >= 0 && record.disposed.indexOf('material') >= 0,
    'disposing the pass must release the scene target and the material: ' + JSON.stringify(record.disposed));
  assert(textRtId !== null && record.disposed.indexOf('rt' + textRtId) >= 0,
    'and the text target too: ' + JSON.stringify(record.disposed));
  assert(farRtId !== null && record.disposed.indexOf('rt' + farRtId) >= 0,
    'and the far-row target: ' + JSON.stringify(record.disposed));
  assert(sandbox.blackHoleState.rt === null, 'the target must be gone after leaving');
  console.log('pass: scene->rt->quad, target follows the drawing buffer (' + status.rt.join('x') + '), fallback counted, memory released');
}

// ------------------------------------------------------------------ the index knob and the wiring
{
  // The knob schema lives in the module; the markup must offer exactly those ranges, one row each,
  // inside the .fx-slider rows the per-field reset button is appended to.
  const schema = vm.runInNewContext('(function () {' + source.slice(source.indexOf('var BH_TUNING_SCHEMA = {'), source.indexOf('};', source.indexOf('var BH_TUNING_SCHEMA = {')) + 2) + 'return BH_TUNING_SCHEMA;})()');
  const keys = Object.keys(schema);
  assert(keys.length >= 15, 'the hole needs its dials: ' + keys.length);
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  for (const key of keys) {
    const id = 'fx-bh' + key;
    assert(html.indexOf('id="' + id + '"') >= 0, 'index.html is missing the ' + id + ' row');
    const spec = schema[key];
    const at = html.indexOf('id="' + id + '"');
    const rowStart = html.lastIndexOf('class="fx-slider"', at);
    assert(rowStart >= 0 && html.slice(rowStart, at).indexOf('</div>') < 0, id + ' must sit inside its .fx-slider row');
    const input = html.slice(at, html.indexOf('>', at));
    assert(input.indexOf('min="' + spec.min + '"') >= 0, id + ' min must be ' + spec.min + ': ' + input);
    assert(input.indexOf('max="' + spec.max + '"') >= 0, id + ' max must be ' + spec.max);
    assert(html.indexOf("setBlackHoleTuning('" + key + "', this.value)") >= 0, id + " must call setBlackHoleTuning('" + key + "')");
  }
  const consoleText = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  assert(/key: 'blackhole'/.test(consoleText) && /title: '银河黑洞'/.test(consoleText), 'the console needs a 银河黑洞 group');
  for (const key of keys) assert(consoleText.indexOf("'" + 'fx-bh' + key + "'") >= 0, 'the console group is missing ' + key);
  console.log('knobs: ' + keys.length + ' rows match the schema, all registered in the console');

  // The lens bends text only if the text is inside its target: the takeover owner must leave
  // stageLyrics alone, and the loop must route the render through the pass with a fallback.
  const ownerBlock = source.slice(source.indexOf("registerVisualTakeoverOwner({"));
  // The app's straight rows are replaced by this preset's own orbiting rows, which are meshes in
  // the disc plane - suppressing the app's layer is what stops two copies of the text fighting.
  assert(/stageLyrics: true/.test(ownerBlock), "the app's straight lyric rows must be taken over by the orbit layer");
  assert(/function bhOrbitBasis\(/.test(source) && /function bhDrawRowCanvas\(/.test(source),
    'the rows have to be placed on the disc-plane orbit and rasterised');
  assert(/new THREE\.CanvasTexture\(canvas\)/.test(source) && /THREE\.MeshBasicMaterial\(/.test(source),
    'and uploaded as textures on planes, which is what lets the lens bend them');
  assert(/side: THREE\.DoubleSide/.test(source),
    'the panels must be two-sided: on the far half we see their back, and that is the view the lens bends');
  assert(/particles: true/.test(ownerBlock), "the app's cover-particle field belongs to the other presets; this one paints its own galaxy");
  assert(/renderBlackHoleFrame\(\)/.test(loopText), 'the main loop must route the render through the lens');
  assert(/if \(!lensFrameDone\) renderer\.render\(scene, camera\)/.test(loopText), 'and fall back to a plain render');
  const atCamera = loopText.indexOf('blackHoleApplyCamera(dt)');
  const atLayout = loopText.indexOf('updateStageLyrics3D(stageLyricsStepDt)');
  const atFlight = loopText.indexOf('updateBlackHoleLyricFlight(dt)');
  const atPass = loopText.indexOf('renderBlackHoleFrame()');
  const atFallback = loopText.indexOf('if (!lensFrameDone) renderer.render(scene, camera)');
  assert(atCamera > 0 && atLayout > 0 && atFlight > 0 && atPass > 0 && atFallback > 0, 'every hook must be present in the loop');
  assert(atCamera < atLayout, 'the fov knob must be written before the lyric layout measures it');
  assert(atLayout < atFlight, 'the flight must run after the app laid the rows out');
  assert(atFlight < atPass, 'the flight must be in the target the lens renders');
  const gridText = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '04-preset-grid-uniforms.js'), 'utf8');
  assert(/applyBlackHolePresetNow\(prev, p\)/.test(gridText), 'selecting the preset must build the pass');
}

// ------------------------------------------------ the field is a barred spiral, statistically
//
// "random arrangement, but the arrangement follows a rule" is only a claim if it can be counted.
// The arms come from bhGalaxyArmOffsets (the model), the samples from a seeded RNG, and the test
// measures how tightly the samples hug the arms - a lattice would hug them too well, and a
// uniform disc would not hug them at all.
{
  const sandbox = load({ fx: { preset: 15 } });
  const params = {
    pitch: sandbox.bhParam('galaxyPitch'),
    branches: sandbox.bhParam('galaxyBranches'),
    armWidth: sandbox.bhParam('galaxyArmWidth'),
    thickness: 0.075,
    radius: 1
  };

  const insideBar = sandbox.bhGalaxyArmOffsets(0.12, params);
  assert(insideBar.length === 2, 'the bar is two lobes, found ' + insideBar.length);
  const barFlip = ((insideBar[0] - insideBar[1]) % Math.PI + Math.PI) % Math.PI;
  assert(Math.min(barFlip, Math.PI - barFlip) < 1e-9,
    "the bar's two ends must be opposite each other, found " + insideBar.join(' / '));
  const innerArms = sandbox.bhGalaxyArmOffsets(0.38, params);
  const outerArms = sandbox.bhGalaxyArmOffsets(0.95, params);
  assert(innerArms.length === 2, 'two arms inside the split, found ' + innerArms.length);
  assert(outerArms.length > innerArms.length, 'outside the split there must be more segments than inside, found ' + outerArms.length);
  // Branch segments occupy their own radial bands, so the count varies with radius; what has to
  // hold is that past the split the two arms throw off further segments - counted as a maximum over
  // the outer field, because a single radius would only prove the bands happen to overlap there.
  let maxOuter = 0;
  const splitAt = (sandbox.BH_GALAXY_MODEL && sandbox.BH_GALAXY_MODEL.split) || 0.53;
  for (let sweep = splitAt + 0.01; sweep <= 1.0001; sweep += 0.01) {
    maxOuter = Math.max(maxOuter, sandbox.bhGalaxyArmOffsets(sweep, params).length);
  }
  assert(maxOuter >= 2 + 2 * params.branches,
    'the outer field must branch into ' + (2 + 2 * params.branches) + ' segments at its widest, got ' + maxOuter);

  // Log winding: the arm angle grows with ln(r/rBar), so the pitch is the same at every radius.
  const bar = 0.26;
  const wound = sandbox.bhGalaxyArmAngle(0, 0.9, params.pitch) - sandbox.bhGalaxyArmAngle(0, 0.45, params.pitch);
  const closed = params.pitch * Math.log((0.9 / bar + 1) / (0.45 / bar + 1));
  assert(Math.abs(wound - closed) < 1e-9, 'the winding must be the log spiral: ' + wound + ' vs ' + closed);
  assert(wound > 0, 'arms must wind further out, not unwind');

  const rand = sandbox.bhGalaxyRandom(20261030);
  const samples = [];
  for (let i = 0; i < 2400; i++) samples.push(sandbox.bhGalaxyPoint(i, rand, params));
  function hugInBand(lo, hi) {
    const offsets = [];
    for (let r = lo; r <= hi + 1e-9; r += 0.01) offsets.push({ r: r, arms: sandbox.bhGalaxyArmOffsets(r, params) });
    let inside = 0, counted = 0, halo = 0;
    samples.forEach(function (point) {
      if (point.radius < lo || point.radius > hi) return;
      counted++;
      let best = 9;
      let row = offsets[0];
      offsets.forEach(function (candidate) {
        if (Math.abs(candidate.r - point.radius) < Math.abs(row.r - point.radius)) row = candidate;
      });
      row.arms.forEach(function (arm) {
        let d = Math.abs(point.angle - arm) % (2 * Math.PI);
        d = Math.min(d, 2 * Math.PI - d) * point.radius;
        best = Math.min(best, d);
      });
      if (best < params.armWidth * 2.6 * point.radius) inside++;
      else halo++;
    });
    return { counted: counted, inside: inside, halo: halo };
  }
  const innerBand = hugInBand(0.34, 0.42);
  const outerBand = hugInBand(0.86, 0.96);
  assert(innerBand.counted > 40 && outerBand.counted > 40,
    'the bands must be sampled: ' + innerBand.counted + ' / ' + outerBand.counted);
  const innerFrac = innerBand.inside / innerBand.counted;
  const outerFrac = outerBand.inside / outerBand.counted;
  assert(innerFrac > 0.6, 'most of the inner band must sit on an arm, got ' + innerFrac.toFixed(2));
  assert(outerFrac > 0.6, 'most of the outer band must sit on a branch, got ' + outerFrac.toFixed(2));
  assert(innerBand.halo > 0 && outerBand.halo > 0, 'and some must be inter-arm haze, or it is a lattice not a galaxy');
  const distinct = new Set(samples.map(function (p) { return Math.round(p.radius * 120); })).size;
  assert(distinct > 100, 'the field must fill the disc radially, got ' + distinct + ' radial bins');
  const again = sandbox.bhGalaxyPoint(0, sandbox.bhGalaxyRandom(20261030), params);
  assert(Math.abs(again.radius - samples[0].radius) < 1e-12 && Math.abs(again.angle - samples[0].angle) < 1e-12,
    'the sampler must be reproducible from its seed');
  const other = sandbox.bhGalaxyPoint(0, sandbox.bhGalaxyRandom(7), params);
  assert(Math.abs(other.radius - samples[0].radius) > 1e-9, 'a different seed must place a different field');
  console.log('galaxy: bar lobes 2, arms inside ' + innerArms.length + ', segments outside ' + outerArms.length
    + ', band hug inner ' + (innerFrac * 100).toFixed(0) + '% / outer ' + (outerFrac * 100).toFixed(0) + '%'
    + ', inter-arm ' + (innerBand.halo + outerBand.halo) + ' of ' + (innerBand.counted + outerBand.counted)
    + ', radial bins ' + distinct);
}

// --------------------------------------------------------- one centre, and it is the hole's
{
  const scene = {
    children: [],
    add(object) { object.parent = this; this.children.push(object); },
    remove(object) { this.children = this.children.filter(function (c) { return c !== object; }); }
  };
  const camera = makeCamera({ x: 0, y: 0, z: 6.6 }, { x: 0, y: 0, z: -1 }, 58, 16 / 9);
  const record3 = { draws: [], rtSizes: [], disposed: [], setTarget: [] };
  const sandbox = load({
    THREE: makeThree(record3),
    camera: camera,
    scene: scene,
    fx: { preset: 15 },
    renderer: {
      drawingSize: { x: 1600, y: 900 },
      getDrawingBufferSize(target) { target.set(this.drawingSize.x, this.drawingSize.y); return target; },
        clear() {},
      getPixelRatio() { return 1; }
    }
  });
  assert(sandbox.bhBuildGalaxy(true) === true, 'the field must build');
  const group = scene.children[0];
  assert(!!group, 'the field must be added to the scene the lens renders');
  const frame = sandbox.bhComputeFrame();
  sandbox.bhPlaceGalaxy(frame, 0.016);
  const gap = Math.hypot(group.position.x - frame.world.x, group.position.y - frame.world.y, group.position.z - frame.world.z);
  assert(gap < 1e-9, 'the galaxy must be centred on the hole, gap ' + gap);
  assert(sandbox.blackHoleStatus().galaxy.stars === Math.round(sandbox.bhParam('galaxyDensity')),
    'the star count must be what the knob asks for: ' + JSON.stringify(sandbox.blackHoleStatus().galaxy));
  assert(sandbox.blackHoleStatus().galaxy.haze > 0, 'and the haze layer must exist');

  // A structural knob rebuilds; a brightness knob only moves a uniform.
  sandbox.blackHoleTuning = sandbox.blackHoleTuning || {};
  const before = scene.children[0];
  const countBefore = sandbox.blackHoleStatus().galaxy.stars;
  sandbox.blackHoleTuning.galaxyGlow = 2;
  sandbox.bhBuildGalaxy(false);
  assert(scene.children[0] === before, 'a brightness knob must not rebuild the buffer');
  assert(sandbox.blackHoleStatus().galaxy.stars === countBefore, 'nor change the count');
  sandbox.blackHoleTuning.galaxyDensity = 900;
  sandbox.bhBuildGalaxy(false);
  assert(sandbox.blackHoleStatus().galaxy.stars !== countBefore, 'a density knob must rebuild the buffer');
  assert(record3.disposed.indexOf('galaxy-geometry') >= 0, 'and the rebuild must dispose the old geometry');

  sandbox.applyBlackHolePresetNow(15, 14);
  assert(scene.children.length === 0, 'leaving the preset must take the field out of the scene');
  assert(record3.disposed.filter(function (name) { return name === 'galaxy-geometry'; }).length >= 2,
    'and dispose it: ' + JSON.stringify(record3.disposed));
}

// --------------------------- the rows orbit in the disc plane, split front / back by depth
//
// "From behind the hole, round the side, to the front where it can be read, then round and in" is
// a circle in the disc's plane. The orbit math is checked as geometry: in-plane, radius-preserving,
// front = nearest the camera; then the timing (approach, read at the front, fall while the radius
// drops on the same power law); then the placement flags each row front or back so the renderer
// knows which target it belongs to.
{
  const camera = makeCamera({ x: 0, y: 0, z: 6.6 }, { x: 0, y: 0, z: -1 }, 58, 16 / 9);
  const sandbox = load({ camera: camera, fx: { preset: 15 } });
  const frame = sandbox.bhComputeFrame();
  assert(frame && frame.world, 'the hole must be placed before the rows can orbit it');
  const dot = function (a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; };
  const len = function (a) { return Math.sqrt(dot(a, a)); };

  // The orbit plane is the disc's plane: e1 and e2 are unit, orthogonal, in the plane, and the
  // normal matches the shader's disc normal.
  const basis = sandbox.bhOrbitBasis(14);
  assert(Math.abs(len(basis.n) - 1) < 1e-9 && Math.abs(len(basis.e1) - 1) < 1e-9 && Math.abs(len(basis.e2) - 1) < 1e-9,
    'the orbit basis must be orthonormal');
  assert(Math.abs(dot(basis.n, basis.e1)) < 1e-9 && Math.abs(dot(basis.n, basis.e2)) < 1e-9 && Math.abs(dot(basis.e1, basis.e2)) < 1e-9,
    'the plane axes and the normal must be orthogonal');
  assert(Math.abs(basis.n.x - Math.sin(14 * Math.PI / 180)) < 1e-9 && Math.abs(basis.n.y - Math.cos(14 * Math.PI / 180)) < 1e-9,
    'the orbit tips with the accretion disc');
  const orbitR = 2.4;
  const samplePoint = sandbox.bhOrbitPoint(basis, orbitR, 0.7);
  assert(Math.abs(len(samplePoint) - orbitR) < 1e-9, 'a point on the orbit is at the orbit radius');
  assert(Math.abs(dot(samplePoint, basis.n)) < 1e-9, 'and lies in the disc plane');

  // The front is the point nearest the camera, whichever way the camera looks: a line stops there
  // to be read.
  const towardCamera = { x: camera.position.x - frame.world.x, y: camera.position.y - frame.world.y, z: camera.position.z - frame.world.z };
  const front = sandbox.bhOrbitFrontAngle(basis, towardCamera);
  const frontPoint = sandbox.bhOrbitPoint(basis, orbitR, front);
  let nearest = -Infinity;
  for (let i = 0; i < 64; i++) {
    const p = sandbox.bhOrbitPoint(basis, orbitR, i * Math.PI / 32);
    nearest = Math.max(nearest, dot(p, towardCamera));
  }
  assert(dot(frontPoint, towardCamera) >= nearest - 1e-9, 'the front angle must be the point nearest the eye');
  assert(frontPoint.z > orbitR * 0.99, 'which is the side of the circle towards the camera');

  // The panel is not billboarded: it faces outward from the hole, its up is the disc normal, so it
  // faces the eye at the front, is edge-on at the side and is seen from behind on the far half.
  // That turn is the rotation; the camera's perspective supplies the foreshortening.
  const panelFront = sandbox.bhOrbitPanel(basis, front);
  const panelSide = sandbox.bhOrbitPanel(basis, front + Math.PI / 2);
  const panelBack = sandbox.bhOrbitPanel(basis, front + Math.PI);
  assert(dot(panelFront.forward, towardCamera) / len(towardCamera) > 0.99,
    'at the front the panel faces the camera (within the disc tilt): '
    + (dot(panelFront.forward, towardCamera) / len(towardCamera)).toFixed(4));
  assert(Math.abs(dot(panelSide.forward, towardCamera) / len(towardCamera)) < 0.12,
    'at the side it is edge-on: ' + dot(panelSide.forward, towardCamera) / len(towardCamera));
  assert(dot(panelBack.forward, towardCamera) < 0, 'and on the far half it faces away from the eye');
  assert(Math.abs(len(panelFront.right) - 1) < 1e-9 && Math.abs(dot(panelFront.right, panelFront.up)) < 1e-9
    && Math.abs(dot(panelFront.right, panelFront.forward)) < 1e-9 && Math.abs(dot(panelFront.up, panelFront.forward)) < 1e-9,
    'the panel axes have to be orthonormal');
  // The quaternion the mesh gets must map the plane's local +z to that face and +y to the disc up.
  const rotate = function (q, v) {
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
      x: v.x + q.w * tx + (q.y * tz - q.z * ty),
      y: v.y + q.w * ty + (q.z * tx - q.x * tz),
      z: v.z + q.w * tz + (q.x * ty - q.y * tx)
    };
  };
  const qFront = sandbox.bhPanelQuaternion(panelFront);
  const mappedZ = rotate(qFront, { x: 0, y: 0, z: 1 });
  const mappedY = rotate(qFront, { x: 0, y: 1, z: 0 });
  assert(Math.abs(mappedZ.x - panelFront.forward.x) < 1e-6 && Math.abs(mappedZ.y - panelFront.forward.y) < 1e-6
    && Math.abs(mappedZ.z - panelFront.forward.z) < 1e-6, 'local +z must map to the outward face');
  assert(Math.abs(mappedY.x - panelFront.up.x) < 1e-6 && Math.abs(mappedY.y - panelFront.up.y) < 1e-6
    && Math.abs(mappedY.z - panelFront.up.z) < 1e-6, 'local +y must map to the disc normal');

  // Timing: wait, ease to the front, read, leave early enough for the next. The ease has zero
  // angular speed at both ends, so the line settles instead of stopping dead.
  const params = sandbox.bhLyricParams();
  // The knob is a fraction of the distance; the placement turns it into a world radius, so the arms
  // below work in world units the same way the shot does.
  params.orbit = Math.min(Math.max(params.orbit * frame.distance, 0.4), frame.distance * 0.62);
  const item = { startAt: 10, endAt: 13 };
  const waiting = sandbox.bhLyricOrbitState(item, 5, params, front, null);
  assert(waiting.phase === 'wait' && waiting.alpha === 0, 'a line waits off the front, invisible, until its turn');
  const approachBegin = 10 - params.flyIn;
  const frontOffset = sandbox.bhLyricOrbitState(item, approachBegin, params, front, null);
  const startLater = sandbox.bhLyricOrbitState(item, approachBegin + 0.05, params, front, null);
  const midEarlier = sandbox.bhLyricOrbitState(item, 10 - params.flyIn * 0.55, params, front, null);
  const midLater = sandbox.bhLyricOrbitState(item, 10 - params.flyIn * 0.50, params, front, null);
  const endEarlier = sandbox.bhLyricOrbitState(item, 10 - 0.05, params, front, null);
  const endAtFront = sandbox.bhLyricOrbitState(item, 10, params, front, null);
  assert(frontOffset.phase === 'approach' && endEarlier.phase === 'approach', 'the last stretch is the ease');
  assert(frontOffset.angle > midLater.angle && midLater.angle > endAtFront.angle, 'it only comes closer to the front');
  const startDelta = frontOffset.angle - startLater.angle;
  const midDelta = midEarlier.angle - midLater.angle;
  const endDelta = endEarlier.angle - endAtFront.angle;
  assert(midDelta > startDelta && midDelta > endDelta,
    'the ease must accelerate out of the wait and decelerate into the front: ' + startDelta.toFixed(4)
    + ' / ' + midDelta.toFixed(4) + ' / ' + endDelta.toFixed(4));
  const atStart = sandbox.bhLyricOrbitState(item, 10, params, front, null);
  assert(atStart.phase === 'read' && Math.abs(atStart.angle - front) < 1e-9, 'at its start the line rests at the front');
  const exitStart = sandbox.bhLyricExitStart(item, params);
  assert(exitStart < 13, 'it leaves before its nominal end so the next one is not pushing it: ' + exitStart);
  const beforeExit = sandbox.bhLyricOrbitState(item, exitStart - 0.05, params, front, null);
  assert(beforeExit.phase === 'read' && Math.abs(beforeExit.angle - front) < 1e-9, 'and is still at the front until then');
  assert(sandbox.bhLyricOrbitState(item, 12.9, params, front, null).phase === 'fall',
    'the exit starts before the nominal end, so the next one is not pushing it out');

  // The next line is gated: if the previous has not started leaving, it does not come to the front.
  const gatedWait = sandbox.bhLyricOrbitState(item, 10.9, params, front, 11.2);
  assert(gatedWait.phase === 'wait', 'a predecessor still on the front keeps the next line away');
  const gatedEase = sandbox.bhLyricOrbitState(item, 11.5, params, front, 11.2);
  assert(gatedEase.phase === 'approach', 'once the predecessor is leaving, the next one eases in');
  const gatedRead = sandbox.bhLyricOrbitState(item, 11.65, params, front, 11.2);
  assert(gatedRead.phase === 'read', 'and only then takes the front');

  // After the exit: thrown sideways, then an inspiral. The spin is Keplerian, so it has to rise as
  // the radius closes - that is the "whirling in" the user asked for - and the fall has to last long
  // enough to watch, not a blink.
  const mass = sandbox.bhLyricMass(item);
  const span = params.swallow / mass;
  assert(span > 6, 'a line has to take seconds to fall, not a few frames: ' + span);
  const fall = sandbox.bhLyricOrbitState(item, exitStart + 0.35, params, front, null);
  assert(fall.phase === 'fall' && fall.angle < front && fall.radius < 1, 'the fall keeps going the same way while it comes in');
  const later = sandbox.bhLyricOrbitState(item, exitStart + 0.9, params, front, null);
  assert(later.radius < fall.radius, 'the radius must only shrink: ' + fall.radius + ' -> ' + later.radius);
  assert(later.angle < fall.angle, 'and the angle keep advancing into the spiral');
  assert(later.spin > fall.spin, 'the row has to spin faster as it closes in: ' + fall.spin.toFixed(2) + ' -> ' + later.spin.toFixed(2));
  // Gravity is per line: a longer line is heavier and falls sooner.
  const light = sandbox.bhLyricMass({ text: '短' });
  const heavy = sandbox.bhLyricMass({ text: '这一句歌词明显要长得多' });
  assert(heavy > light, 'a longer line has to be the heavier one: ' + light + ' vs ' + heavy);
  const lightSpan = params.swallow / light;
  const heavySpan = params.swallow / heavy;
  assert(heavySpan < lightSpan, 'the heavier line has to fall faster: ' + heavySpan.toFixed(2) + ' vs ' + lightSpan.toFixed(2));
  // With a rim (the shadow's edge, passed per frame) the row has to stop there and keep turning;
  // going on into the centre is what made the middle of the hole flicker.
  const rimStateParams = Object.assign({}, params, { rim: 0.3 });
  let rimLast = null;
  for (let i = 1; i <= 60; i++) {
    const s = sandbox.bhLyricOrbitState(item, exitStart + span * i / 60, rimStateParams, front, null);
    if (!s) break;
    assert(s.radius >= 0.3 - 1e-9, 'the row may not pass the rim: ' + s.radius);
    rimLast = s;
  }
  assert(rimLast && Math.abs(rimLast.radius - 0.3) < 1e-9, 'by the end it sits on the rim: ' + (rimLast && rimLast.radius));
  assert(rimLast.left >= 0 && rimLast.left <= span / 60 + 1e-9, 'and the fall clock is nearly out: ' + rimLast.left);
  const rimA = sandbox.bhLyricOrbitState(item, exitStart + span * 0.9, rimStateParams, front, null);
  const rimB = sandbox.bhLyricOrbitState(item, exitStart + span * 0.96, rimStateParams, front, null);
  assert(rimB.angle < rimA.angle, 'it keeps turning while it orbits the rim');
  assert(sandbox.bhLyricOrbitState(item, exitStart + span + 0.01, params, front, null) === null,
    'once the fall is over the line is gone');
  const noWind = sandbox.bhLyricOrbitState(item, exitStart + 0.9, {
    rate: params.rate, wind: 0, curve: params.curve, swallow: params.swallow,
    flyIn: params.flyIn, exitLead: params.exitLead, gap: params.gap, waitAngle: params.waitAngle
  }, front, null);
  assert(noWind.angle > later.angle, 'wind 0 has to be the plain orbit, with no extra turn');
  assert(Math.abs(noWind.radius - later.radius) < 1e-9, 'the wind changes the turn, not the fall');

  // The fall is a spiral, not a radial drop: its arc is longer than the straight line from the
  // hold point to the hole.
  let path = 0;
  let prev = sandbox.bhOrbitPoint(basis, params.orbit, front);
  for (let i = 1; i <= 60; i++) {
    const t = exitStart + span * i / 60;
    const s = sandbox.bhLyricOrbitState(item, t, params, front, null);
    if (!s) break;
    const p = sandbox.bhOrbitPoint(basis, params.orbit * s.radius, s.angle);
    path += Math.sqrt((p.x - prev.x) * (p.x - prev.x) + (p.y - prev.y) * (p.y - prev.y) + (p.z - prev.z) * (p.z - prev.z));
    prev = p;
  }
  assert(path > params.orbit * 1.15, 'the inward path must be a spiral, not a radius: ' + path.toFixed(2) + ' against ' + params.orbit);

  // Placement: only one line is at the front at a time; a line leaves early and the next is still
  // off to the side while it goes; a falling line is flagged back once it crosses the hole.
  function fakeRow(index) {
    const ctx = {
      font: '', textAlign: '', textBaseline: '', fillStyle: '',
      measureText(text) { return { width: String(text).length * 10 }; },
      clearRect() {}, fillText() {}
    };
    return {
      itemIndex: index, live: true, front: true, sung: null, widthRatio: 4,
      canvas: { width: 512, height: 128, getContext() { return ctx; } },
      ctx: ctx,
      texture: { needsUpdate: false, dispose() {} },
      material: { opacity: 1, dispose() {} },
      mesh: {
        position: new V3(), scale: new V3(1, 1, 1),
        quaternion: { value: null, set(x, y, z, w) { this.value = [x, y, z, w]; return this; } },
        renderOrder: 0, visible: false, geometry: { dispose() {} }
      },
      farMesh: {
        position: new V3(), scale: new V3(1, 1, 1),
        quaternion: { copy() { return this; } },
        renderOrder: 0, visible: true, geometry: { dispose() {} }
      }
    };
  }
  // Short text on purpose: mass is text length, and this block is about the schedule, not gravity.
  const items = [
    { index: 0, text: 'l0', sub: '', startAt: 0, endAt: 6 },
    { index: 1, text: 'l1', sub: '', startAt: 6, endAt: 9 },
    { index: 2, text: 'l2', sub: '', startAt: 10, endAt: 13 },
    { index: 3, text: 'l3', sub: '', startAt: 14, endAt: 17 },
    { index: 4, text: 'l4', sub: '', startAt: 18, endAt: 21 }
  ];
  const rows = [fakeRow(0), fakeRow(1), fakeRow(2), fakeRow(3), fakeRow(4)];
  sandbox.bhLyrics.layer = { position: new V3(), quaternion: { copy() {} }, visible: true };
  sandbox.bhLyrics.rows = rows;
  sandbox.bhLyrics.items = items;
  sandbox.bhLyrics.sung = 2;
  sandbox.bhLyrics.now = 13.7;
  sandbox.bhLyrics.time = 0;
  sandbox.bhPlaceLyrics(frame, 0.016);

  // At 13.7 the sung line has left the front and is falling; the next one is easing in; the one
  // after is not in the air. The earlier lines are still in the disc: the inspiral is long on
  // purpose, so a row is not recycled the moment the next one arrives.
  assert(rows[0].live === true && rows[1].live === true && rows[2].live === true,
    'a falling line must still be in the disc while the next lines arrive');
  assert(rows[3].live === true && rows[3].front === true, 'the next line has eased in on the near half');
  assert(rows[3].mesh.position.z > 1.5, 'it is between the eye and the hole: z=' + rows[3].mesh.position.z);
  assert(rows[4].live === false && rows[4].mesh.visible === false, 'the line after next is not in the air yet');
  assert(rows[3].mesh.quaternion.value && Math.abs(Math.sqrt(
    rows[3].mesh.quaternion.value[0] ** 2 + rows[3].mesh.quaternion.value[1] ** 2
    + rows[3].mesh.quaternion.value[2] ** 2 + rows[3].mesh.quaternion.value[3] ** 2) - 1) < 1e-6,
    'the row gets a real rotation for its panel, not a camera copy');
  const placedQ = rows[3].mesh.quaternion.value;
  const placedFace = rotate({ x: placedQ[0], y: placedQ[1], z: placedQ[2], w: placedQ[3] }, { x: 0, y: 0, z: 1 });
  // The row also bobs through the disc, so the face is compared with the in-plane radial direction,
  // not with the raw position: the bob must be motion along the disc normal, not a tilt.
  const placedAt = rows[3].mesh.position;
  const normalOffset = placedAt.x * basis.n.x + placedAt.y * basis.n.y + placedAt.z * basis.n.z;
  const radial = {
    x: placedAt.x - basis.n.x * normalOffset,
    y: placedAt.y - basis.n.y * normalOffset,
    z: placedAt.z - basis.n.z * normalOffset
  };
  const placedLen = Math.hypot(radial.x, radial.y, radial.z);
  assert(Math.abs(placedFace.x - radial.x / placedLen) < 1e-6
    && Math.abs(placedFace.y - radial.y / placedLen) < 1e-6
    && Math.abs(placedFace.z - radial.z / placedLen) < 1e-6,
    'the placed panel face must point outward along its own radius');
  assert(Math.abs(normalOffset) > 1e-4, 'a row has to bob through the disc, got ' + normalOffset);
  const otherOffset = rows[2].mesh.position.x * basis.n.x + rows[2].mesh.position.y * basis.n.y
    + rows[2].mesh.position.z * basis.n.z;
  assert(Math.abs(normalOffset - otherOffset) > 1e-5, 'and the rows must not bob in lockstep');
  // Four lines are in the air at once and each is at its own radius: they must not stack on one ring.
  const liveRadii = rows.filter(function (r) { return r.live; })
    .map(function (r) { return Math.hypot(r.mesh.position.x, r.mesh.position.y, r.mesh.position.z); });
  let distinct = true;
  for (let i = 1; i < liveRadii.length; i++) if (Math.abs(liveRadii[i] - liveRadii[i - 1]) < 0.05) distinct = false;
  assert(distinct, 'the lines in the disc have to be at their own radii: '
    + liveRadii.map(function (d) { return d.toFixed(2); }).join(' / '));
  // Close to the hole the row stays in one channel: at the rim the flat and lensed versions are far
  // apart, and blending them is the flicker the user saw in the middle of the hole.
  const shadowWorldTest = (Number(frame.uvShadow) || 0) * frame.distance
    * (frame.camera && frame.camera.tanHalf ? frame.camera.tanHalf : 0.55);
  rows.filter(function (r) { return r.live; }).forEach(function (r) {
    const rad = Math.hypot(r.mesh.position.x, r.mesh.position.y, r.mesh.position.z);
    if (rad <= shadowWorldTest * 1.8) {
      assert(r.farAlpha === 0 && r.nearAlpha === 1,
        'a row at the rim must stay in the near channel, not blend a flat and a lensed copy: ' + r.farAlpha);
    }
  });
  assert(rows[2].sung === true && rows[3].sung === false, 'the line still being sung keeps the highlight');

  // ------------------------------------------- the far copy is bent by its own depth, not the sky's
  //
  // The pass pulls every pixel of the far channel towards the hole, so the sign is drawn that much
  // inside its true position - less the share its own depth behind the hole pays for. The eye then
  // sees the true position plus weight*bend: a row crossing the hole's plane does not jump, and the
  // two copies agree wherever the depth blend keeps both of them on.
  function projectQ(local) {
    const cam = frame.camera;
    const dx = frame.world.x + local.x - camera.position.x;
    const dy = frame.world.y + local.y - camera.position.y;
    const dz = frame.world.z + local.z - camera.position.z;
    const along = Math.max(0.05, dx * cam.fwd.x + dy * cam.fwd.y + dz * cam.fwd.z);
    const right = dx * cam.right.x + dy * cam.right.y + dz * cam.right.z;
    const up = dx * cam.up.x + dy * cam.up.y + dz * cam.up.z;
    const uvx = 0.5 + right / (2 * along * cam.tanHalf * frame.aspect);
    const uvy = 0.5 + up / (2 * along * cam.tanHalf);
    const qx = (uvx - frame.uv.u) * frame.aspect;
    const qy = uvy - frame.uv.v;
    return { qx: qx, qy: qy, du: uvx - frame.uv.u, dv: uvy - frame.uv.v, q: Math.hypot(qx, qy), along: along };
  }
  const deflectTest = sandbox.bhClamp(sandbox.bhParam('deflect'), 0, 3);
  const lensTest = sandbox.bhClamp(sandbox.bhParam('textLens'), 0, 1);
  let worstBlend = 0;
  let bentRows = 0;
  rows.filter(function (r) { return r.live; }).forEach(function (r) {
    const at = projectQ(r.mesh.position);
    const far = projectQ(r.farMesh.position);
    const pull = sandbox.bhLyricLensPull(at.q, frame.uvShadow, deflectTest, lensTest);
    const wanted = Math.min((1 - r.lensWeight) * pull, at.q * 0.9);
    assert(Math.abs(r.lensPreWarp - wanted) < 1e-9, 'the row must report the pre-warp it got');
    // The pass subtracts its bend from the uv, along the direction measured in the aspect-scaled
    // space, so the copy has to be moved the same way - anisotropy and all, or the two would not
    // cancel and the text would sit off the lensed image.
    assert(Math.abs((far.du - at.du) + wanted * (at.qx / at.q)) < 1e-6
      && Math.abs((far.dv - at.dv) + wanted * (at.qy / at.q)) < 1e-6,
      'the far copy must sit the pre-warp inside the near one, along the radius: '
      + (far.du - at.du).toFixed(5) + ',' + (far.dv - at.dv).toFixed(5) + ' against -' + wanted.toFixed(5));
    assert(Math.abs(at.along - far.along) < 1e-9, 'and the pre-warp must not move the row nearer or further');
    if (r.nearAlpha > 0.05 && r.farAlpha > 0.05) {
      // Where both copies are on, they may only be a fraction of a glyph apart - that is the ghost
      // the centre flicker was made of.
      worstBlend = Math.max(worstBlend, r.lensWeight);
      bentRows++;
    }
  });
  assert(bentRows === 0 || worstBlend < 0.5,
    'the depth blend must live where the weight is small: worst weight ' + worstBlend.toFixed(3) + ' over ' + bentRows + ' rows');
  // The weight is the lens-maker's ratio: a source at the hole's own plane is not bent at all, and
  // one far behind it approaches the sky's full bend.
  assert(sandbox.bhLyricLensWeight(6.6, 6.6, 6.6) === 0, 'a row at the hole plane takes no bend');
  assert(sandbox.bhLyricLensWeight(6.0, 6.6, 6.6) === 0, 'and a row in front of it takes none either');
  assert(Math.abs(sandbox.bhLyricLensWeight(7.0, 6.6, 7.0) - 0.4 / 7) < 1e-12, 'behind, it is D_ls/D_s');
  let rising = true;
  for (let d = 7; d <= 60; d += 5) {
    if (sandbox.bhLyricLensWeight(d, 6.6, d) <= sandbox.bhLyricLensWeight(d - 1, 6.6, d - 1)) rising = false;
  }
  assert(rising && sandbox.bhLyricLensWeight(60, 6.6, 60) > 0.88, 'and it rises towards the sky\'s full bend');
  // The pull must be the pass's own number, floored at the shadow and dead outside the strong zone.
  const sh = frame.uvShadow;
  assert(Math.abs(sandbox.bhLyricLensPull(sh * 1.05, sh, 1, 1) - 0.65 * sh / 1.05) < 1e-9,
    'at the rim of the shadow the pull is 0.65*rs/impact');
  assert(sandbox.bhLyricLensPull(sh * 3, sh, 1, 1) === 0, 'outside the strong-field zone nothing is pulled');
  assert(Math.abs(sandbox.bhLyricLensPull(sh * 0.2, sh, 1, 1) - sandbox.bhLyricLensPull(sh * 0.98, sh, 1, 1)) < 1e-12,
    'inside the shadow the impact parameter is floored, so the pull stops growing');
  assert(Math.abs(sandbox.bhLyricLensPull(sh, sh, 1, 0.5) - sandbox.bhLyricLensPull(sh, sh, 1, 1) * 0.5) < 1e-12,
    'and the near-field lens knob scales the same bend for the rows');

  // The split is exactly what the renderer uses to choose a target, and it follows each row's own
  // near/far flag rather than a fixed count.
  const near = rows.filter(function (r) { return r.live && r.nearAlpha > 0.001; }).length;
  const far = rows.filter(function (r) { return r.live && r.farAlpha > 0.001; }).length;
  const liveCount = rows.filter(function (r) { return r.live; }).length;
  assert(near >= 2, 'the approaching and falling lines are on the near half at this moment: ' + near);
  assert(sandbox.bhSetLyricSideVisibility(true) === near, 'near half: ' + near + ' rows');
  assert(sandbox.bhSetLyricSideVisibility(false) === far, 'far half: ' + far + ' rows');
  assert(sandbox.bhSetLyricSideVisibility(null) === liveCount, 'the fallback render gets every live row back');
  assert(sandbox.bhSetLyricSideVisibility(null) === liveCount
    && rows.every(function (r) { return !r.live || !r.farMesh.visible; }),
    'and the fallback must not also draw the far copy, or the plain render shows the text twice');
  assert(sandbox.bhSetLyricSideVisibility('none') === 0 && rows.every(function (r) { return !r.mesh.visible; }),
    'the scene target must not contain a lyric row at all: that is what the galaxy blur would smear');
  console.log('lens weight: ' + rows.filter(function (r) { return r.live; })
    .map(function (r) { return (r.lensWeight || 0).toFixed(3); }).join(' / ')
    + ', both-channel rows ' + bentRows + ', worst weight there ' + worstBlend.toFixed(3));
  // The near/far hand-over is a depth blend, not a one-frame switch: it is a pop otherwise.
  assert(Math.abs(sandbox.bhLyricSideBlend(6.6, 6.6, 0.3) - 0.5) < 1e-9, 'half way across the band is half and half');
  assert(sandbox.bhLyricSideBlend(6.2, 6.6, 0.3) === 0, 'well in front is the near channel');
  assert(sandbox.bhLyricSideBlend(7.0, 6.6, 0.3) === 1, 'well behind is the far channel');
  assert(/row\.sideBlend = nearHole \? 0 : bhLyricSideBlend\(alongRow, depth, sideBand\);/.test(source),
    'the placement has to write the blend, and force the near channel at the rim');
  rows.filter(function (r) { return r.live; }).forEach(function (r) {
    assert(Math.abs(r.nearAlpha + r.farAlpha - 1) < 1e-9,
      'the near/far alphas have to be complementary: ' + r.nearAlpha + '+' + r.farAlpha);
  });

  // The row is an arch of the orbit: its radius of curvature is its distance to the hole, so the
  // middle is tangent, the ends bend inward, and a closer row bends harder.
  const flat = sandbox.bhRowBend(0, 2, 2.4);
  assert(Math.abs(flat.x) < 1e-12 && Math.abs(flat.z) < 1e-12, 'the middle of the row is on its own tangent');
  const bend = sandbox.bhRowBend(0.5, 2, 2.4);
  const bendWorldX = bend.x * 2;   // the mesh's own x scale is the row's world width
  const bendWorldZ = bend.z;
  const circle = bendWorldX * bendWorldX + (bendWorldZ + 2.4) * (bendWorldZ + 2.4);
  assert(Math.abs(circle - 2.4 * 2.4) < 1e-9, 'the bent row has to lie on a circle of radius 2.4, got ' + circle);
  assert(bendWorldZ < 0, 'the ends bend towards the hole, not away: ' + bendWorldZ);
  assert(Math.abs(bendWorldX - 2.4 * Math.sin(1 / 2.4)) < 1e-9, 'the arc length has to be the row width');
  const tight = sandbox.bhRowBend(0.5, 2, 0.9);
  assert(tight.z < bend.z, 'a closer row has to bend harder: ' + tight.z.toFixed(3) + ' vs ' + bend.z.toFixed(3));
  // Tidal stretch: the line elongates along the orbit as it closes in, and the limit is one full
  // turn round the hole - stretched to "infinite" length is a closed ring, not a pile of turns.
  const arcRead = sandbox.bhLyricArcWidth(1.1, params.orbit, params.orbit);
  assert(Math.abs(arcRead - 1.1) < 1e-9, 'no stretch at the hold radius: ' + arcRead);
  const arcMid = sandbox.bhLyricArcWidth(1.1, 0.8, params.orbit);
  const arcDeep = sandbox.bhLyricArcWidth(1.1, 0.5, params.orbit);
  assert(arcDeep > arcMid && arcMid > arcRead, 'the arc has to grow as the row falls: '
    + arcRead.toFixed(2) + ' -> ' + arcMid.toFixed(2) + ' -> ' + arcDeep.toFixed(2));
  assert(arcMid / 0.8 > Math.PI / 2, 'by 0.8 the band has to wrap past a quarter turn: ' + (arcMid / 0.8).toFixed(2) + ' rad');
  for (const r of [0.3, 0.25, 0.2]) {
    const a = sandbox.bhLyricArcWidth(1.1, r, params.orbit);
    assert(a <= 6.28318 * r * 0.98 + 1e-9, 'the band may not wrap past one turn: ' + a);
  }
  assert(/worldW = bhLyricArcWidth\(worldW, radius, params\.orbit\);/.test(source),
    'the placement has to use the tidal width');
  // The rows are one quad per glyph, and both the arch and each glyph's drift are written into that
  // buffer every frame - never accumulated from the previous one.
  const glyphGeo = {
    attributes: {
      position: { array: new Float32Array(4 * 12), needsUpdate: false },
      uv: { array: new Float32Array(4 * 8), needsUpdate: false }
    },
    drawn: 0,
    setDrawRange(start, count) { this.drawn = count; }
  };
  const glyphRow = {
    canvas: { width: 200, height: 100 }, itemIndex: 3, mesh: { geometry: glyphGeo },
    glyphs: [{ x0: 0, x1: 100, y0: 0, y1: 100 }, { x0: 100, x1: 200, y0: 0, y1: 100 }]
  };
  const written = sandbox.bhBendRowGlyphs(glyphRow, 2, 2.4, 0, 0, 0);
  assert(written === 2 && glyphGeo.drawn === 12, 'each glyph has to be its own quad: ' + written + '/' + glyphGeo.drawn);
  const gp = glyphGeo.attributes.position.array;
  assert(Math.abs(gp[0] - (-(2.4 / 2) * Math.sin(1 / 2.4))) < 1e-6,
    'the left edge of the first glyph has to move onto the arch: ' + gp[0]);
  const gu = glyphGeo.attributes.uv.array;
  assert(Math.abs(gu[0]) < 1e-9 && Math.abs(gu[2] - 0.5) < 1e-9 && Math.abs(gu[1] - 1) < 1e-9,
    'and read its own slice of the row texture: ' + Array.prototype.slice.call(gu, 0, 4).join(','));
  // Drift: nothing at rest, one offset per glyph, and a wider scatter the deeper the fall.
  const driftRest = sandbox.bhGlyphDrift(3, 0, 0, 1, 10);
  assert(driftRest.x === 0 && driftRest.y === 0, 'a row that is only being read must not drift');
  const driftDeepA = sandbox.bhGlyphDrift(3, 0, 1, 1, 10);
  const driftDeepB = sandbox.bhGlyphDrift(3, 1, 1, 1, 10);
  assert(Math.hypot(driftDeepA.x - driftDeepB.x, driftDeepA.y - driftDeepB.y) > 0.01,
    'two glyphs must drift to different places, or it is the old whole-line bob: '
    + JSON.stringify(driftDeepA) + ' / ' + JSON.stringify(driftDeepB));
  const driftHalf = sandbox.bhGlyphDrift(3, 0, 0.5, 1, 10);
  assert(Math.hypot(driftHalf.x, driftHalf.y) < Math.hypot(driftDeepA.x, driftDeepA.y),
    'and the scatter has to open up with the fall: ' + Math.hypot(driftHalf.x, driftHalf.y).toFixed(3)
    + ' at half against ' + Math.hypot(driftDeepA.x, driftDeepA.y).toFixed(3) + ' at the end');
  assert(Math.hypot(driftDeepA.x, driftDeepA.y) < 0.24, 'but stay inside the row, not fly off it');
  assert(sandbox.bhGlyphDrift(3, 0, 1, 0, 10).x === 0, 'the knob at zero means no drift at all');
  // Through the writer, not just the function: two neighbouring glyphs have to come apart. With a
  // whole-line offset their touching edges would still be touching.
  glyphGeo.attributes.position.needsUpdate = false;
  sandbox.bhBendRowGlyphs(glyphRow, 2, 2.4, 1, 1, 10);
  const gp2 = glyphGeo.attributes.position.array;
  const gap = Math.abs(gp2[3] - gp2[12]);
  assert(Math.abs(gap) > 0.004,
    'the two glyphs have to drift apart, not move as one line: their facing edges are ' + gap.toFixed(4) + ' apart');
  assert(glyphGeo.attributes.position.needsUpdate === true, 'and the buffer has to be re-uploaded');
  assert(/var geometry = bhBuildGlyphGeometry\(BH_MAX_ROW_GLYPHS\);/.test(source),
    'the row has to be built as one quad per glyph, not as a single plane');
  // The placement has to use that writer with the row's own radius and the fall's progress.
  assert(/bhBendRowGlyphs\(row, worldW, radius, params\.drift, state\.phase === 'fall' \? state\.fall : 0, time\);/.test(source),
    'the placement has to bend each row to its own radius and drift its glyphs');
  assert(/function bhLyricWindowRange\(/.test(source) && /bhLyricWindowRange\(sung, items\.length, bhLyrics\.rows\.length\)/.test(source),
    'the window has to come from the row count, not a fixed six lines');
  // The row cap is the answer to "why do fast lyrics vanish before the 30 s inspiral": with 24 rows
  // a line stays for 21 lines of history; with the old 9 it was six.
  const wideWindow = sandbox.bhLyricWindowRange(10, 20, 24);
  const narrowWindow = sandbox.bhLyricWindowRange(10, 20, 9);
  assert(wideWindow.lo === 0 && wideWindow.hi === 12, '24 rows must reach 21 lines back: ' + JSON.stringify(wideWindow));
  assert(narrowWindow.lo === 4 && narrowWindow.hi === 12, '9 rows reach six lines back: ' + JSON.stringify(narrowWindow));
  assert(sandbox.bhLyricWindowRange(-1, 5, 9).lo === 0, 'before the song the window starts at the first line');
  assert(sandbox.bhLyricWindowRange(0, 0, 9).hi === -1, 'no lines means no window');
  assert(/lyricRows: \{ def: 24, min: 9, max: 48/.test(source), 'the row cap has to be a knob');
  assert(/bhEnsureLyricRowCount\(bhParam\('lyricRows'\)\)/.test(source),
    'the pool has to be built from the knob');
  // A long line is wrapped into a block instead of being fitted to the screen width, which made it
  // a two-pixel strip (and read as "the lyrics stopped showing").
  const measurer = { measureText: function (s) { return { width: String(s).length * 10 }; } };
  const wrapped = sandbox.bhWrapText(measurer, 'x'.repeat(50), 100, 4);
  assert(wrapped.length === 4, 'a 50-character line at 10px per character must wrap into four lines: ' + wrapped.length);
  assert(wrapped[wrapped.length - 1].slice(-1) === '…', 'and the tail has to be marked, not silently dropped');
  const shortWrap = sandbox.bhWrapText(measurer, 'short', 100, 4);
  assert(shortWrap.length === 1 && shortWrap[0] === 'short', 'a short line stays one line');
  const wrapCtx = {
    font: '', textAlign: '', textBaseline: '', fillStyle: '',
    measureText: function (s) { return { width: String(s).length * 10 }; },
    clearRect: function () {}, fillText: function () {}
  };
  const wrapRow = { canvas: { width: 8, height: 8, getContext: function () { return wrapCtx; } }, ctx: wrapCtx };
  sandbox.bhDrawRowCanvas(wrapRow, { text: 'x'.repeat(500), sub: '' }, false, sandbox.bhLyricPaletteState(), { floatAmp: 0.4, enter: 0.28 });
  assert(wrapRow.lineScale > 1.2, 'a wrapped row has to grow in height: ' + wrapRow.lineScale);
  assert(wrapRow.canvas.width <= 2048, 'and the canvas has to stay inside a texture: ' + wrapRow.canvas.width);
  // The sign is displayed 2-3x larger than the layout font, so it has to be rasterised above that
  // size; at the layout size the GPU magnifies it and everything reads blurry.
  assert(wrapRow.textureScale >= 2, 'the row canvas has to be supersampled: ' + wrapRow.textureScale);
  assert(wrapRow.canvas.height > 120, 'a supersampled single line is taller than the old 58px strip: ' + wrapRow.canvas.height);
  assert(/\* \(row\.lineScale \|\| 1\)/.test(source), 'the placement has to use the wrapped-row height');
  assert(/var arcTarget = params\.orbit \* 0\.46;/.test(source),
    'the arch has to be wide enough to see, not a 40 cm line on a 2.4 m orbit');
  // Rows drift through the disc out of step with each other, and falling rows swing harder.
  const bobA = sandbox.bhLyricBob(0, 5, 0, 0.25);
  const bobB = sandbox.bhLyricBob(1, 5, 0, 0.25);
  assert(Math.abs(bobA - bobB) > 1e-5, 'rows must not bob in lockstep: ' + bobA + ' vs ' + bobB);
  assert(Math.abs(bobA) <= 0.02 + 0.25 * 0.12 + 1e-9, 'an idle bob stays inside the disc: ' + bobA);
  assert(Math.abs(sandbox.bhLyricBob(0, 5, 1, 0.25)) <= (0.02 + 0.25 * 0.12) * 1.9 + 1e-9,
    'and even the falling swing is bounded');
  assert(/var BH_MAX_LYRIC_ROWS = 48;/.test(source), 'the pool has a hard ceiling');

  // While the previous line is still on the front, the next is not shown: the gap the user asked
  // for. Two tenths of a second later it starts to come in.
  rows.forEach(function (row) { row.itemIndex = -1; row.live = true; row.sung = null; });
  sandbox.bhLyrics.now = 13.2;
  sandbox.bhPlaceLyrics(frame, 0.016);
  assert(rows[2].live === true && rows[2].mesh.visible === true, 'the line that was sung is still falling');
  assert(rows[3].live === false && rows[3].mesh.visible === false, 'but the next one is not there yet');
  sandbox.bhLyrics.now = 13.4;
  sandbox.bhPlaceLyrics(frame, 0.016);
  assert(rows[3].live === true && rows[3].mesh.visible === true, 'and starts to come in once the front is free');

  // Advancing: the highlight moves, and the falling line keeps spiralling in - for seconds, not
  // frames. It stays readable all the way over the shadow (the text is composited after the pass)
  // and only goes at the horizon.
  sandbox.bhLyrics.sung = 3;
  sandbox.bhLyrics.now = 13.7;
  sandbox.bhPlaceLyrics(frame, 0.016);
  assert(rows[3].sung === true, 'the highlight moves to the new line');
  const fallingRow = rows[2];
  const distances = [];
  const opacities = [];
  for (let step = 0; step < 140; step++) {
    sandbox.bhLyrics.now += 0.08;
    sandbox.bhPlaceLyrics(frame, 0.08);
    if (fallingRow.itemIndex < 0) break;
    // In-plane radius: the row also bobs along the disc normal, and that perpendicular offset would
    // otherwise read as the row moving back out at the rim.
    const p = fallingRow.mesh.position;
    const nOff = p.x * basis.n.x + p.y * basis.n.y + p.z * basis.n.z;
    distances.push(Math.hypot(p.x - basis.n.x * nOff, p.y - basis.n.y * nOff, p.z - basis.n.z * nOff));
    opacities.push(fallingRow.material.opacity);
  }
  for (let i = 1; i < distances.length; i++) {
    assert(distances[i] <= distances[i - 1] + 1e-9,
      'the line must only ever get closer to the hole (' + distances.map(function (d) { return d.toFixed(2); }).join(' -> ') + ')');
  }
  assert(distances.length >= 20, 'the fall has to last seconds of frames, got ' + distances.length);
  // It stops at the rim - the visible edge of the black disk - instead of shrinking into the centre,
  // where front and back are the same thing and the near/far hand-over flickered.
  const shadowWorldWalk = (Number(frame.uvShadow) || 0) * frame.distance
    * (frame.camera && frame.camera.tanHalf ? frame.camera.tanHalf : 0.55);
  const rimWorldWalk = Math.max(frame.horizonWorld * 1.02, shadowWorldWalk * 0.98);
  assert(Math.abs(distances[distances.length - 1] - rimWorldWalk) < 0.15,
    'the row has to stop at the rim, not sink to the centre: ' + distances[distances.length - 1].toFixed(2)
    + ' vs ' + rimWorldWalk.toFixed(2));
  assert(distances[distances.length - 1] < distances[0] * 0.6, 'and reach it from the hold radius');
  // No parking at the rim: the spiral runs the whole way in and only creeps along the edge for the
  // last stretch the power law needs to reach the floor (it was a third of the fall before).
  const nearRim = distances.filter(function (d) { return d <= rimWorldWalk * 1.02; }).length;
  assert(nearRim <= distances.length * 0.15,
    'the rim may only be the last stretch of the fall, not a park: '
    + nearRim + ' of ' + distances.length + ' frames');
  // The dissolve has to be a fade, not a switch: it may only go down, it has to spend several
  // samples partly transparent, and no single frame may take a big bite out of it. The window is a
  // third of the fall, so a long spin-in spends its whole park at the rim dissolving instead of
  // sitting at full strength and blinking out.
  let fadeMonotone = true;
  let biggestStep = 0;
  let partialSamples = 0;
  for (let i = 0; i < opacities.length; i++) {
    if (i) {
      const step = opacities[i - 1] - opacities[i];
      if (step < -1e-9) fadeMonotone = false;
      biggestStep = Math.max(biggestStep, step);
    }
    if (opacities[i] > 0.05 && opacities[i] < 0.95) partialSamples++;
  }
  assert(fadeMonotone, 'the dissolve may only ever go down: '
    + opacities.map(function (o) { return o.toFixed(2); }).join(' '));
  assert(partialSamples >= 3, 'the row has to spend time partly transparent, not blink out: '
    + partialSamples + ' of ' + opacities.length + ' samples');
  assert(biggestStep < 0.25, 'and no single frame may take a big bite out of it: ' + biggestStep.toFixed(2));
  assert(opacities[opacities.length - 1] < 0.1,
    'and be all but gone by the time it is hidden: '
    + opacities.slice(-4).map(function (o) { return o.toFixed(2); }).join(' -> '));
  assert(fallingRow.mesh.visible === false && fallingRow.material.opacity === 0,
    'a swallowed row is hidden and fully transparent');

  // Somewhere around the crossing a row (outside the rim override) has to be in both channels with
  // complementary weights; otherwise the depth band is dead code and the crossing pops after all.
  let partial = null;
  for (let n = 0; n < 160 && !partial; n++) {
    sandbox.bhLyrics.now += 0.1;
    sandbox.bhPlaceLyrics(frame, 0.1);
    rows.forEach(function (r) {
      if (!partial && r.live && r.nearAlpha > 0.05 && r.farAlpha > 0.05) partial = r;
    });
  }
  assert(partial, 'a row crossing the hole depth has to be in both channels for a moment');
  assert(Math.abs(partial.nearAlpha + partial.farAlpha - 1) < 1e-9,
    'and the two weights have to add to one: ' + partial.nearAlpha + '+' + partial.farAlpha);
  // Where both copies are on they must nearly coincide: the pass bends the far one, the pre-warp has
  // already taken back all but `weight` of that bend, and the depth band is exactly where the row is
  // level with the hole, so the weight there is small. This is the ghost the centre flicker was.
  const pAt = projectQ(partial.mesh.position);
  const pPull = sandbox.bhLyricLensPull(pAt.q, frame.uvShadow, deflectTest, lensTest);
  const glyph = partial.mesh.scale.y / (2 * pAt.along * (frame.camera.tanHalf || 0.55));
  assert(partial.lensWeight < 0.5,
    'the crossing band must be where the row is barely bent: weight ' + partial.lensWeight.toFixed(3));
  assert(partial.lensWeight * pPull < 0.5 * glyph,
    'the two copies may not sit half a glyph apart while both are on: '
    + (partial.lensWeight * pPull).toFixed(5) + ' against a glyph of ' + glyph.toFixed(5));
  console.log('crossing: weight ' + partial.lensWeight.toFixed(3) + ', ghost '
    + (partial.lensWeight * pPull / glyph).toFixed(3) + ' glyph heights');
  console.log('orbit: radius ' + params.orbit + ', rate ' + params.rate + ' rad/s, wind ' + params.wind
    + '; front ' + front.toFixed(2) + ', spiral ' + path.toFixed(2) + ' vs radius ' + params.orbit
    + ', exit at ' + exitStart + ', span ' + span.toFixed(2) + 's, fall '
    + distances[0].toFixed(2) + ' -> ' + distances[distances.length - 1].toFixed(2));
  sandbox.bhLyrics.layer = null;

  // One owner for the text: the row flight runs on its own, and stands down the moment the orbit
  // layer exists. Asserted as an A/B so "it returned false anyway" cannot pass for the guard.
  sandbox.stageLyrics = { group: { updateMatrixWorld: function () {}, children: [] }, current: null, outgoing: [] };
  sandbox.bhLyrics.layer = null;
  const flightAlone = sandbox.updateBlackHoleLyricFlight(0.016);
  sandbox.bhLyrics.layer = { fake: true };
  const flightWithLayer = sandbox.updateBlackHoleLyricFlight(0.016);
  sandbox.bhLyrics.layer = null;
  assert(flightAlone === true, 'without the orbit layer the row flight must still run');
  assert(flightWithLayer === false, 'the orbit layer must take the text over from the row flight');
}

// ------------------------------------------------------------------ the lyric flight
//
// A parent at identity, so local space is world space and the numbers below are the ones the
// rows would have. Odd line indices must appear left of the camera axis, even ones right; the
// sung row sits where the app put it; once the line is over it converges on the hole.
{
  function makeRow(lineIndex, active) {
    const mesh = {
      position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      scale: { x: 1 },
      visible: true,
      renderOrder: 42,
      userData: {}
    };
    mesh.parent = { worldToLocal(v) { return v; } };
    return { mesh: mesh, readability: null, glow: null, lineIndex: lineIndex, isActive: active };
  }
  function makeStage(rows, currentIdx) {
    return {
      currentIdx: currentIdx,
      group: { updateMatrixWorld() {} },
      current: { userData: { lyric: { rowLayers: rows.map(function (r) { return r; }), trackTargetLineIndex: currentIdx } } },
      outgoing: []
    };
  }

  const oddRow = makeRow(1, false);
  const evenRow = makeRow(2, false);
  const camera = makeCamera({ x: 0, y: 0, z: 6.6 }, { x: 0, y: 0, z: -1 }, 58, 16 / 9);
  const sandbox = load({
    camera: camera,
    fx: { preset: 15 },
    stageLyrics: makeStage([oddRow, evenRow], 0)
  });
  sandbox.blackHoleApplyCamera(0.016);
  const frame = sandbox.blackHoleState.frame;
  assert(frame && frame.world, 'the hole must be placed before the rows can fly to it');

  sandbox.updateBlackHoleLyricFlight(0.016);
  const odd = oddRow.mesh.position;
  const even = evenRow.mesh.position;
  const axisX = camera.position.x;
  assert(odd.x < axisX - 1, 'line 1 is odd and must come from the camera left, got x=' + odd.x.toFixed(2));
  assert(even.x > axisX + 1, 'line 2 is even and must come from the camera right, got x=' + even.x.toFixed(2));
  // Both start on the near plane: close to the camera, which is what makes them arrive huge, and
  // outside the frame sideways, so they fly in rather than fade in.
  const forward = (camera.position.z - odd.z);
  const lateral = Math.abs(odd.x - camera.position.x);
  const planeH = Math.tan((camera.fov * Math.PI / 180) * 0.5) * sandbox.bhParam('startNear');
  assert(Math.abs(forward - sandbox.bhParam('startNear')) < 0.05,
    'the entry point must sit startNear in front of the eye, got ' + forward.toFixed(2));
  assert(lateral > planeH * camera.aspect,
    'the entry point must start off the side of the frame, got ' + lateral.toFixed(2) + ' against ' + (planeH * camera.aspect).toFixed(2));
  console.log('flight: line 1 starts at x=' + odd.x.toFixed(2) + ', line 2 at x=' + even.x.toFixed(2)
    + ' (' + forward.toFixed(2) + 'u ahead, ' + lateral.toFixed(2) + 'u off-axis, frame half-width '
    + (planeH * camera.aspect).toFixed(2) + ')');

  // A sung row is left exactly where the app put it.
  const sungRow = makeRow(7, true);
  sungRow.mesh.position.set(0.4, -0.2, 0.05);
  sandbox.stageLyrics = makeStage([sungRow], 7);
  sandbox.updateBlackHoleLyricFlight(0.016);
  assert(Math.abs(sungRow.mesh.position.x - 0.4) < 1e-6 && Math.abs(sungRow.mesh.position.y + 0.2) < 1e-6,
    'the sung line must not be displaced: ' + JSON.stringify(sungRow.mesh.position));

  // The line ends: from that frame on the row converges on the hole, and hides once it is in.
  const holdAtExit = { x: sungRow.mesh.position.x, y: sungRow.mesh.position.y, z: sungRow.mesh.position.z };
  const swallowed = [];
  sungRow.isActive = false;
  // The fallback flight reads the same swallow knob, so it also takes seconds now: walk it out.
  for (let step = 0; step < 90; step++) {
    sandbox.blackHoleApplyCamera(0.12);
    sandbox.updateBlackHoleLyricFlight(0.12);
    swallowed.push(Math.hypot(
      sungRow.mesh.position.x - frame.world.x,
      sungRow.mesh.position.y - frame.world.y,
      sungRow.mesh.position.z - frame.world.z
    ));
  }
  assert(swallowed[0] > 0, 'the fall must start somewhere');
  for (let i = 1; i < swallowed.length; i++) {
    assert(swallowed[i] <= swallowed[i - 1] + 1e-9, `the row must only ever get closer to the hole (${swallowed.join(' -> ')})`);
  }
  assert(swallowed[swallowed.length - 1] < swallowed[0] * 0.2,
    'the row must be swallowed by the end: ' + swallowed.map(function (d) { return d.toFixed(2); }).join(' -> '));
  assert(sungRow.mesh.visible === false, 'a swallowed row is hidden');
  console.log('swallow: distance to the hole ' + swallowed.map(function (d) { return d.toFixed(2); }).join(' -> ')
    + ' (hold was ' + Math.hypot(holdAtExit.x - frame.world.x, holdAtExit.y - frame.world.y, holdAtExit.z - frame.world.z).toFixed(2) + ')');
}

// ------------------------------------------------------------- the shader is a photon march
{
  const shader = source.slice(source.indexOf('var BH_PASS_FS'));
  assert(/shadertoyFragment\(/.test(source), 'the pass must be written against the Shadertoy driver');
  assert(/-1\.5 \* h2 \* pos \/ \(r2 \* r2 \* r\)/.test(shader), 'the march must integrate the Schwarzschild acceleration');
  assert(/if \(r2 < 1\.0\) \{ captured = true; break; \}/.test(shader), 'a ray inside the horizon must be captured');
  assert(/Math.abs\(side\) < halfThick/.test(shader) || /abs\(side\) < halfThick/.test(shader), 'the disc must be a volume, not a plane crossing');
  // The backdrop bends radially and monotonically. Sampling the marched direction folded the
  // screen texture once per quadrant (rays that wrap over the top come out the other side), which
  // read as four separate swirls in the frame.
  assert(/vec3 sampleSky\(vec2 uv, float blurPx\)/.test(shader), 'the near-field galaxy must be sampled without the bend');
  assert(!/sampleSky\(uv, bend/.test(shader), 'passing the far-field bend into the galaxy lookup stretched the frame edges');
  assert(/return \(sum \/ 5\.0\) \* edge;/.test(shader), 'the border fade has to actually multiply the galaxy sample');
  assert(/float impact = max\(qlen, uShadowUv \* 0\.98\);/.test(shader), 'the impact parameter is floored at the shadow');
  assert(/float bendMag = uDeflect \* 0\.65 \* uShadowUv \* uShadowUv \/ impact;/.test(shader), 'the bend must fall off as rs^2/b');
  assert(/\* skyMask;/.test(shader), 'the sky has to be masked out inside the shadow');
  assert(!/lensedUv - uv/.test(shader), 'the direction-difference fold must not come back');
  assert(/uDiscInner/.test(shader) && /uDiscTilt/.test(shader), 'the disc has to be in the shader and tiltable');
  // The driver itself: a Shadertoy body is wrapped with its own main().
  const driver = fs.readFileSync(driverPath, 'utf8');
  assert(/function shadertoyFragment\(/.test(driver) && /mainImage\(fragColor, gl_FragCoord\.xy\)/.test(driver),
    'the driver must call mainImage with pixel coordinates');
  assert(/uniform vec3 iResolution/.test(driver) && /uniform sampler2D iChannel/.test(driver),
    'the driver must provide the Shadertoy uniforms');
  console.log('shader: Schwarzschild march, disc crossing, lensed background sample, Shadertoy driver');
}

console.log('[OK] The galactic black hole: ported kernel, a real scene->target->quad pass with a fallback, and knobs wired.');
