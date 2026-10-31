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
    Mesh: function (geo, mat) { this.geometry = geo; this.material = mat; this.visible = true; this.frustumCulled = true; },
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

  // The disc is a volume sampled in 3D, not hashed cells in (angle, radius): the cell grain drew
  // stretched dots because every step along a ray read the same cell.
  for (const pattern of [/float hash13\(vec3/, /float noise3\(vec3/, /float fbm3\(vec3/]) {
    assert(pattern.test(source), 'the disc fog needs a 3D noise field: ' + pattern);
  }
  assert(/float base = fbm3\(q \* 2\.0\);/.test(source), 'the fog has to be sampled at the marched position');
  assert(/vec3 q = vec3\(cos\(flow\) \* r, sin\(flow\) \* r, side \* 4\.5\)/.test(source),
    'the sample has to carry the height inside the slab, or the ray reads one cell all the way through');
  assert(/float warp = noise3\(q \* 1\.1/.test(source), 'with a low-frequency warp for the filaments');
  assert(/float fog = mix\(1\.0, 0\.10 \+ 1\.9 \* field, clamp\(uWisp, 0\.0, 2\.0\) \* 0\.7\);/.test(source),
    'and the wisp amount has to reach the density');
  assert(/if \(u\.uWisp\) u\.uWisp\.value = bhClamp\(bhParam\('discWisp'\), 0, 2\);/.test(source),
    'the discWisp knob has to be written to the shader every frame');
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

  // The shader applies the drift to the ray, carries the debris pass, and builds the disc from a
  // 3D field sampled at the marched position.
  assert(/vec2 ndc = \(uv - 0\.5\) \* 2\.0 \* \(1\.0 \+ uDolly\) \+ uShake;/.test(source),
    'the drift and dolly have to reach the ray');
  assert(/vec4 nearDebris\(vec2 uv, float t, float amount\)/.test(source), 'the near debris pass must exist');
  assert(/float base = fbm3\(q \* 2\.0\);/.test(source), 'the near fog needs its 3D field');
  assert(/color = mix\(color, debris\.rgb, clamp\(debris\.a, 0\.0, 1\.0\)\)/.test(source),
    'and the debris has to be composited in front');
  console.log('epic: fov ' + sandbox.bhParam('fovDeg') + ' deg, drift ' + on.x.toFixed(5) + '/' + on.y.toFixed(5)
    + ' dolly ' + on.dolly.toFixed(5) + ' (bounded, slow), debris and fine filaments present');
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
  const frontRow = { itemIndex: 1, live: true, front: true, mesh: { visible: false } };
  const backRow = { itemIndex: 2, live: true, front: false, mesh: { visible: false } };
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
      setRenderTarget(target) { record.setTarget.push(target ? (target === sandbox.blackHoleState.textRt ? 'text-rt' : 'rt') : null); },
      render(targetScene) {
        record.draws.push(targetScene === scene ? 'scene' : 'quad');
        record.seen.push({ scene: targetScene === scene, front: frontRow.mesh.visible, back: backRow.mesh.visible, galaxy: galaxyGroup.visible, autoClear: this.autoClear });
      }
    }
  });
  sandbox.bhLyrics.layer = lyricsLayer;
  sandbox.bhLyrics.rows = [frontRow, backRow];
  sandbox.bhGalaxy.group = galaxyGroup;
  sandbox.blackHoleState.frame = sandbox.bhComputeFrame();
  assert(sandbox.renderBlackHoleFrame() === true, 'the frame must run');

  assert.deepStrictEqual(record.draws, ['scene', 'scene', 'quad'],
    'world, near rows, then one quad: ' + JSON.stringify(record.draws));
  assert.deepStrictEqual(record.setTarget, ['rt', 'text-rt', null], 'both targets then the screen: ' + JSON.stringify(record.setTarget));
  const [worldPass, textPass, quadPass] = record.seen;
  assert(worldPass.front === false && worldPass.back === true && worldPass.galaxy === true,
    'the first target is the galaxy plus the far rows, never the near ones');
  assert(textPass.front === true && textPass.back === false && textPass.galaxy === false,
    'the second is the near rows alone');
  assert(quadPass.scene === false && quadPass.autoClear === true, 'and the pass is one quad, clearing normally');
  assert(sandbox.blackHoleState.textQuads === 1, 'the text render is counted: ' + sandbox.blackHoleState.textQuads);
  assert(frontRow.mesh.visible === true && backRow.mesh.visible === true,
    'after the frame both halves are visible again for the fallback render');

  // The binding is the proof: the pass material reads the near rows as a channel, not as a texture
  // pasted over its output.
  const uniforms = sandbox.blackHoleState.material.uniforms;
  assert(uniforms.iChannel1 && uniforms.iChannel1.value === sandbox.blackHoleState.textRt.texture,
    'iChannel1 must be the near-row target');
  assert(uniforms.iChannel0 && uniforms.iChannel0.value === sandbox.blackHoleState.rt.texture,
    'iChannel0 must be the scene target');
  assert(uniforms.uTextLens, 'the near-field lens amount must reach the shader');
  // The far rows bend because the scene texture is sampled back through the bend near the hole;
  // the near rows are in front, so they are pasted straight over the picture.
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
  assert.deepStrictEqual(record.setTarget, ['rt', 'text-rt', null], 'but the target is still cleared for the channel');
  sandbox.bhLyrics.layer = lyricsLayer;
  console.log('channels: ' + record.draws.length + ' draws without text, world+front rows+quad with it; iChannel1 bound to the near rows');
}

// ---------------------------------------- swallowed by the row, not painted over by the hole
{
  const sandbox = load({ fx: { preset: 15 } });
  const centre = sandbox.bhSwallowAlpha(0.1, 1);
  const outside = sandbox.bhSwallowAlpha(1.4, 1);
  const middle = sandbox.bhSwallowAlpha(0.35, 1);
  const deep = sandbox.bhSwallowAlpha(0.6, 1);
  assert(outside === 1, 'a row outside the rim must be whole, got ' + outside);
  assert(centre === 0, 'a row at the centre must be gone, got ' + centre);
  assert(middle > 0 && middle < 1, 'a row partway in is fading, got ' + middle);
  assert(deep === 1, 'a row over the hole but not yet at the centre must stay readable, got ' + deep);
  // Walked from the outside in: getting closer must never make a row brighter.
  let last = 2;
  for (let d = 1.5; d >= 0; d -= 0.05) {
    const a = sandbox.bhSwallowAlpha(d, 1);
    assert(a <= last + 1e-12, 'the fade must be monotone on the way in');
    last = a;
  }
  console.log('swallow: fade 1.4r=' + outside + ', 0.6r=' + deep + ', 0.35r=' + middle.toFixed(2) + ', 0.1r=' + centre);
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
      setRenderTarget(target) { record.setTarget.push(target ? (target === sandbox.blackHoleState.textRt ? 'text-rt' : 'rt') : null); },
      render(targetScene) { record.draws.push(targetScene === scene ? 'scene' : 'quad'); }
    }
  });
  sandbox.__record = record;

  assert(sandbox.blackHolePresetIsActive() === true, 'preset 15 must be the active one here');
  const ok = sandbox.renderBlackHoleFrame();
  assert(ok === true, 'the pass must run when the hole is in front of the camera');
  assert.deepStrictEqual(record.draws, ['scene', 'quad'], 'the scene goes in, one quad comes out');
  assert.deepStrictEqual(record.setTarget, ['rt', 'text-rt', null], 'both targets, then the screen: ' + JSON.stringify(record.setTarget));
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
  sandbox.applyBlackHolePresetNow(15, 14);
  assert(rtId !== null && record.disposed.indexOf('rt' + rtId) >= 0 && record.disposed.indexOf('material') >= 0,
    'disposing the pass must release the scene target and the material: ' + JSON.stringify(record.disposed));
  assert(textRtId !== null && record.disposed.indexOf('rt' + textRtId) >= 0,
    'and the text target too: ' + JSON.stringify(record.disposed));
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

  // Timing: approach, read, fall. `now` is the audio clock, so the line is at the front exactly
  // while it is being sung.
  const params = sandbox.bhLyricParams();
  const item = { startAt: 10, endAt: 13 };
  const before = sandbox.bhLyricOrbitState(item, 8, params, front);
  assert(before && before.phase === 'approach' && before.angle > front && before.radius === 1,
    'before its first word a line is still coming round, at the hold radius');
  const atStart = sandbox.bhLyricOrbitState(item, 10, params, front);
  const during = sandbox.bhLyricOrbitState(item, 12, params, front);
  assert(atStart.phase === 'read' && Math.abs(atStart.angle - front) < 1e-9, 'at its start the line is at the front');
  assert(during.phase === 'read' && Math.abs(during.angle - front) < 1e-9, 'and waits there while it is sung');
  // Approaching: the angle only ever decreases towards the front.
  let approachAngle = Infinity;
  for (let t = 5; t <= 10; t += 0.5) {
    const s = sandbox.bhLyricOrbitState(item, t, params, front);
    assert(s.angle <= approachAngle + 1e-9, 'the approach must only get closer to the front');
    approachAngle = s.angle;
  }

  // After the line: the same direction round the circle, plus the wind, while the radius falls.
  const fall = sandbox.bhLyricOrbitState(item, 13.5, params, front);
  assert(fall.phase === 'fall' && fall.angle < front && fall.radius < 1, 'the fall keeps going the same way while it comes in');
  const later = sandbox.bhLyricOrbitState(item, 14.2, params, front);
  assert(later.radius < fall.radius, 'the radius must only shrink: ' + fall.radius + ' -> ' + later.radius);
  assert(later.angle < fall.angle, 'and the angle keep advancing into the spiral');
  assert(sandbox.bhLyricOrbitState(item, 13 + params.swallow + 0.01, params, front) === null,
    'once the fall is over the line is gone');
  const noWind = sandbox.bhLyricOrbitState(item, 14.2, { rate: params.rate, wind: 0, curve: params.curve, swallow: params.swallow }, front);
  assert(noWind.angle > later.angle, 'wind 0 has to be the plain orbit, with no extra turn');
  assert(Math.abs(noWind.radius - later.radius) < 1e-9, 'the wind changes the turn, not the fall');

  // The fall is a spiral, not a radial drop: its arc is longer than the straight line from the
  // hold point to the hole.
  let path = 0;
  let prev = sandbox.bhOrbitPoint(basis, params.orbit * 1, front);
  for (let i = 1; i <= 60; i++) {
    const t = 13 + params.swallow * i / 60;
    const s = sandbox.bhLyricOrbitState(item, t, params, front);
    if (!s) break;
    const p = sandbox.bhOrbitPoint(basis, params.orbit * s.radius, s.angle);
    path += Math.sqrt((p.x - prev.x) * (p.x - prev.x) + (p.y - prev.y) * (p.y - prev.y) + (p.z - prev.z) * (p.z - prev.z));
    prev = p;
  }
  assert(path > params.orbit * 1.15, 'the inward path must be a spiral, not a radius: ' + path.toFixed(2) + ' against ' + params.orbit);

  // Placement: a line that is being sung sits at the front and is flagged front (it will be
  // composited over the picture); a line still on the far half is flagged back (it belongs in the
  // scene, where the lens and the disc fog own it).
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
        position: new V3(), scale: new V3(1, 1, 1), quaternion: { copied: null, copy(q) { this.copied = q; return this; } },
        renderOrder: 0, visible: false, geometry: { dispose() {} }
      }
    };
  }
  const items = [
    { index: 0, text: 'line 0', sub: '', startAt: 0, endAt: 6 },
    { index: 1, text: 'line 1', sub: '', startAt: 6, endAt: 9 },
    { index: 2, text: 'line 2', sub: '', startAt: 10, endAt: 13 },
    { index: 3, text: 'line 3', sub: '', startAt: 14, endAt: 17 },
    { index: 4, text: 'line 4', sub: '', startAt: 18, endAt: 21 }
  ];
  const rows = [fakeRow(0), fakeRow(1), fakeRow(2), fakeRow(3), fakeRow(4)];
  sandbox.bhLyrics.layer = { position: new V3(), quaternion: { copy() {} }, visible: true };
  sandbox.bhLyrics.rows = rows;
  sandbox.bhLyrics.items = items;
  sandbox.bhLyrics.sung = 2;
  sandbox.bhLyrics.now = 12;
  sandbox.bhLyrics.time = 0;
  sandbox.bhPlaceLyrics(frame, 0.016);

  assert(rows[2].mesh.position.z > 1.5, 'the sung line is on the near side of the hole: z=' + rows[2].mesh.position.z);
  assert(rows[2].front === true, 'and flagged front');
  assert(rows[2].sung === true, 'and rasterised in the highlight colour');
  assert(rows[3].front === true && rows[4].front === false,
    'the next line is still on the near half, the one after it is behind the hole');
  assert(rows[3].mesh.position.z < rows[2].mesh.position.z, 'the near half runs towards the hole as the lines queue');
  assert(rows[4].mesh.position.z < 0, 'the far line is behind the hole plane: z=' + rows[4].mesh.position.z);
  assert(rows[2].mesh.quaternion.copied === camera.quaternion, 'every row faces the camera wherever it is on the circle');
  assert(rows[2].mesh.scale.x > rows[3].mesh.scale.x, 'the sung line is drawn a little larger than the queue');
  assert(rows[0].itemIndex === -1 && rows[1].itemIndex === -1, 'lines whose fall is over are dropped');
  // The split is exactly what the renderer uses to choose a target.
  assert(sandbox.bhSetLyricSideVisibility(true) === 2, 'front half: the sung line and the next one');
  assert(rows[2].mesh.visible === true && rows[3].mesh.visible === true && rows[4].mesh.visible === false,
    'and the far row is hidden for the near pass');
  assert(sandbox.bhSetLyricSideVisibility(false) === 1 && rows[4].mesh.visible === true,
    'back half: only the far row');
  assert(sandbox.bhSetLyricSideVisibility(null) === 3, 'the fallback render gets all live rows back');

  // Advancing: the highlight moves, and the line that was sung spirals in and goes out.
  sandbox.bhLyrics.sung = 3;
  sandbox.bhLyrics.now = 14.05;
  sandbox.bhPlaceLyrics(frame, 0.016);
  assert(rows[3].sung === true && rows[2].sung === false, 'the highlight moves to the new line');
  const fallingRow = rows[2];
  const distances = [];
  const opacities = [];
  for (let step = 0; step < 14; step++) {
    sandbox.bhLyrics.now += 0.1;
    sandbox.bhPlaceLyrics(frame, 0.1);
    if (fallingRow.itemIndex < 0) break;
    distances.push(Math.hypot(fallingRow.mesh.position.x, fallingRow.mesh.position.y, fallingRow.mesh.position.z));
    opacities.push(fallingRow.material.opacity);
  }
  for (let i = 1; i < distances.length; i++) {
    assert(distances[i] <= distances[i - 1] + 1e-9,
      'the sung line must only ever get closer to the hole (' + distances.map(function (d) { return d.toFixed(2); }).join(' -> ') + ')');
  }
  assert(distances.length >= 3 && distances[distances.length - 1] < distances[0] * 0.4,
    'and be swallowed by the end: ' + distances.map(function (d) { return d.toFixed(2); }).join(' -> '));
  assert(opacities[opacities.length - 1] < 0.9,
    'and fade as it crosses the shadow radius, not stay opaque until the frame it disappears: '
    + opacities.map(function (o) { return o.toFixed(2); }).join(' -> '));
  assert(fallingRow.mesh.visible === false && fallingRow.material.opacity === 0,
    'a swallowed row is hidden and fully transparent');
  console.log('orbit: radius ' + params.orbit + ', rate ' + params.rate + ' rad/s, wind ' + params.wind
    + '; front ' + front.toFixed(2) + ', spiral ' + path.toFixed(2) + ' vs radius ' + params.orbit
    + '; fall ' + distances.map(function (d) { return d.toFixed(2); }).join(' -> '));
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
  for (let step = 0; step < 18; step++) {
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
