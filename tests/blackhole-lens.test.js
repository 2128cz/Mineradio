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
const source = fs.readFileSync(modulePath, 'utf8');
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
class V2 {
  constructor(x, y) { this.x = x || 0; this.y = y || 0; }
  set(x, y) { this.x = x; this.y = y; return this; }
}

function makeThree(record) {
  return {
    Vector3: V3,
    Vector2: V2,
    LinearFilter: 1,
    RGBAFormat: 2,
    UnsignedByteType: 3,
    ClampToEdgeWrapping: 4,
    WebGLRenderTarget: function (w, h) {
      this.width = w;
      this.height = h;
      this.texture = { wrapS: 0, wrapT: 0 };
      this.setSize = function (nw, nh) { this.width = nw; this.height = nh; record.rtSizes.push([nw, nh]); };
      this.dispose = function () { record.disposed.push('rt'); };
    },
    ShaderMaterial: function (opts) {
      this.uniforms = opts.uniforms;
      this.fragmentShader = opts.fragmentShader;
      this.vertexShader = opts.vertexShader;
      this.dispose = function () { record.disposed.push('material'); };
    },
    Scene: function () { this.children = []; this.add = function (o) { this.children.push(o); }; this.clear = function () { this.children = []; }; },
    OrthographicCamera: function () {},
    Mesh: function (geo, mat) { this.geometry = geo; this.material = mat; },
    PlaneGeometry: function () { this.dispose = function () { record.disposed.push('geometry'); }; }
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
  vm.runInContext(source, sandbox, { filename: modulePath });
  return sandbox;
}

// ------------------------------------------------------------------ the ported kernel
{
  const api = load();
  const r = api.bhKerrSchildRadius;

  // With no spin the Kerr-Schild radius is the plain Euclidean distance. This is the property the
  // port has to keep, and the branch the shader must not lose.
  for (const p of [[1, 0, 0], [0, 2, 0], [0.3, -0.4, 0.5], [0, 0, -3.7]]) {
    const expect = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    const got = r(p[0], p[1], p[2], 0);
    assert(Math.abs(got - expect) < 1e-9, `spin 0 must stay Euclidean: ${p} -> ${got} vs ${expect}`);
  }
  // On the spin axis inside the ring the radial coordinate has a closed form that the two
  // branches of the reference expression must both satisfy: for x = z = 0 it is exactly |y|.
  for (const y of [0.05, 0.2, 0.45]) {
    const got = r(0, y, 0, 0.5);
    assert(Math.abs(got - y) < 1e-9, `the axis radius must be |y| (${y} -> ${got})`);
  }
  // The b < 0 branch is an algebraic twin of the first one - in exact arithmetic they agree, and a
  // value test therefore CANNOT tell them apart. It exists for conditioning (b + det cancels when
  // b is very negative), which is why the arm for it is a shape arm, here and in the shader.
  assert(/b >= 0 \? 0\.5 \* \(b \+ det\) : \(2 \* a2 \* y2\) \/ Math\.max\(1e-20, det - b\)/.test(source),
    'the JS kernel must keep both branches of the reference expression');
  // Off the equator with the same footprint the radius is larger: that is the oblateness the
  // shadow inherits from the spin.
  const polar = r(0.1, 0.35, 0.1, 0.5);
  const equator = r(0.1, 0, 0.1, 0.5);
  assert(polar > equator, `the same footprint must read larger off the equator (${polar} vs ${equator})`);

  const h0 = api.bhHorizonRadii(0, 0);
  assert(Math.abs(h0.rp - 1) < 1e-9, `Schwarzschild horizon must be 2M with M = 0.5, got ${h0.rp}`);
  assert(Math.abs(h0.rm) < 1e-9, `Schwarzschild inner horizon must vanish, got ${h0.rm}`);
  assert(Math.abs(h0.ergo - h0.rp) < 1e-9, 'without spin the static limit must sit on the horizon');
  const fast = api.bhHorizonRadii(1, 0);
  assert(Math.abs(fast.rp - 0.5) < 1e-9 && Math.abs(fast.rm - 0.5) < 1e-9, 'spin 1 must be extremal (rp = rm = M)');
  const charged = api.bhHorizonRadii(0, 1);
  assert(Math.abs(charged.rp - 0.5) < 1e-9, 'charge 1 must be extremal too');
  const both = api.bhHorizonRadii(1, 1);
  assert(both.naked === true, 'a^2 + Q^2 > M^2 has no horizon: the reference reports a naked singularity');
  const spun = api.bhHorizonRadii(0.7, 0);
  assert(spun.ergo > spun.rp, `the ergosphere must reach past the horizon (${spun.ergo} vs ${spun.rp})`);
  console.log('kernel: r0(3.7)=3.700, rp(spin0)=1.000, rp(spin1)=0.500, ergo(spin0.7)='
    + spun.ergo.toFixed(3) + ' > rp=' + spun.rp.toFixed(3) + ', naked(spin1,charge1)=' + both.naked);

  // The screen plane's distance is the fov's, not a constant: that is what makes the 视锥 knob a
  // geometry change. Wider frustum -> the plane sits closer -> the same uv radius is a bigger
  // angular bend.
  const narrow = api.bhPlaneZ(35);
  const wide = api.bhPlaneZ(92);
  assert(wide < narrow, `a wider fov must bring the lens plane closer (${wide} vs ${narrow})`);

  // The projection has to agree with what the camera would do: dead centre stays at (0.5, 0.5),
  // and a point one half-height up lands exactly on the top edge.
  const camPos = { x: 0, y: 0, z: 6 };
  const dir = { x: 0, y: 0, z: -1 };
  const right = { x: 1, y: 0, z: 0 };
  const up = { x: 0, y: 1, z: 0 };
  const centred = api.bhProjectPoint({ x: 0, y: 0, z: 1 }, camPos, dir, right, up, Math.tan(29 * Math.PI / 180), 16 / 9);
  assert(Math.abs(centred.u - 0.5) < 1e-9 && Math.abs(centred.v - 0.5) < 1e-9, 'the axis must project to the centre');
  const tan = Math.tan(29 * Math.PI / 180);
  const edge = api.bhProjectPoint({ x: 0, y: tan * 5, z: 1 }, camPos, dir, right, up, tan, 16 / 9);
  assert(Math.abs(edge.v - 1) < 1e-9, `one half-height up at distance 5 must land on v = 1, got ${edge.v}`);
  const behind = api.bhProjectPoint({ x: 0, y: 0, z: 9 }, camPos, dir, right, up, tan, 16 / 9);
  assert(behind === null, 'a point behind the eye has no projection and must report null');

  // The plunge: starts at d0, ends at 0, and accelerates in the last stretch (the "欻").
  const d0 = 5;
  assert(Math.abs(api.bhFallDistance(d0, 0, 2 / 3) - d0) < 1e-9, 'the fall must start at the hold distance');
  assert(api.bhFallDistance(d0, 1, 2 / 3) < 1e-9, 'the fall must reach the hole');
  const early = d0 - api.bhFallDistance(d0, 0.5, 2 / 3);
  const late = api.bhFallDistance(d0, 0.9, 2 / 3) - api.bhFallDistance(d0, 1, 2 / 3);
  assert(early > 0, 'the row has to travel');
  const speedEarly = (d0 - api.bhFallDistance(d0, 0.1, 2 / 3)) / 0.1;
  const speedLate = (api.bhFallDistance(d0, 0.9, 2 / 3) - api.bhFallDistance(d0, 0.95, 2 / 3)) / 0.05;
  assert(speedLate > speedEarly * 1.5, `the plunge must accelerate into the hole (${speedEarly.toFixed(2)} -> ${speedLate.toFixed(2)})`);
  assert(late >= 0);
  console.log('plunge: d0=' + d0 + ' speed ' + speedEarly.toFixed(2) + ' -> ' + speedLate.toFixed(2) + ' at the end');
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

  const equatorial = shadow.rays[0].s;   // along the spin axis' perpendicular
  const polar = shadow.rays[2].s;        // along the spin axis
  assert(equatorial > polar * 1.01, `a spinning hole must be wider across its axis than along it (${equatorial} vs ${polar})`);
  const expectedRatio = Math.sqrt(cap * cap + a * a) / cap;
  assert(Math.abs(equatorial / polar - expectedRatio) < expectedRatio * 0.04,
    `the flattening must be the closed form sqrt(cap^2+a^2)/cap (${equatorial / polar} vs ${expectedRatio})`);

  const flat = load({ camera: camera, fx: { preset: 15 } });
  flat.blackHoleTuning = { spin: 0, charge: 0, mass: sandbox.bhParam('mass'), shadowScale: sandbox.bhParam('shadowScale') };
  const round = flat.bhSilhouette(8);
  const spread = Math.max.apply(null, round.rays.map(function (r) { return r.s; }))
    - Math.min.apply(null, round.rays.map(function (r) { return r.s; }));
  assert(spread < 1e-4, `spin 0 must give a perfect circle, spread ${spread}`);
  console.log('silhouette: cap=' + cap.toFixed(3) + ' a=' + a.toFixed(3) + ' planeZ=' + shadow.planeZ.toFixed(2)
    + ', s equatorial ' + equatorial.toFixed(3) + ' vs polar ' + polar.toFixed(3)
    + ' (ratio ' + (equatorial / polar).toFixed(4) + ', closed form ' + expectedRatio.toFixed(4) + ')'
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
      setRenderTarget(target) { record.setTarget.push(target ? 'rt' : null); },
      render(targetScene) { record.draws.push(targetScene === scene ? 'scene' : 'quad'); }
    }
  });
  sandbox.__record = record;

  assert(sandbox.blackHolePresetIsActive() === true, 'preset 15 must be the active one here');
  const ok = sandbox.renderBlackHoleFrame();
  assert(ok === true, 'the pass must run when the hole is in front of the camera');
  assert.deepStrictEqual(record.draws, ['scene', 'quad'], 'the scene goes in, one quad comes out');
  assert.deepStrictEqual(record.setTarget, ['rt', null], 'the target is entered and left again');
  const status = sandbox.blackHoleStatus();
  assert(status.rt && status.rt[0] > 0, 'the target must exist after the first frame');
  assert(status.uv && Math.abs(status.uv[0] - 0.5) < 0.2, 'the hole projects near the middle: ' + JSON.stringify(status.uv));
  assert(status.shadowUv > 0.02 && status.shadowUv < 0.6, 'the shadow radius must be a sane fraction of the half-height: ' + status.shadowUv);

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
  sandbox.applyBlackHolePresetNow(15, 14);
  assert(record.disposed.indexOf('rt') >= 0 && record.disposed.indexOf('material') >= 0,
    'disposing the pass must release the target and the material: ' + JSON.stringify(record.disposed));
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
  assert(/stageLyrics: false/.test(ownerBlock), 'stageLyrics must stay on: text outside the render target cannot be bent');
  assert(/particles: false/.test(ownerBlock), 'the scene stays on: it is what the lens bends');
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
  for (let step = 0; step < 6; step++) {
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

// ------------------------------------------------------------------ the shader carries the ported kernel
{
  const shader = source.slice(source.indexOf('var BH_PASS_FS'));
  assert(/float ksRadius\(float px, float py, float pz, float a\)/.test(shader), 'the fragment stage must carry the Kerr-Schild radius');
  assert(/b >= 0\.0 \? 0\.5 \* \(b \+ det\) : \(2\.0 \* a2 \* y2\) \/ max\(1e-20, det - b\)/.test(shader),
    'both branches of the reference expression must be there');
  assert(/float rp = 0\.5 \+ root/.test(shader) && /float a = 0\.5 \* uSpin/.test(shader) && /float q2 = 0\.25 \* uCharge/.test(shader),
    'the horizon algebra must keep the reference unit conventions');
  assert(/sqrt\(pow\(0\.5 \+ sqrt\(max\(0\.0, 0\.25 - q2\)\), 2\.0\) \+ a \* a\)/.test(shader), 'the outer static limit must be the reference formula');
  assert(/uDeflect \* horizon \* rp \* rp \/ b\)/.test(shader), 'the bend must be the ~1/b law in rp');
  assert(/uSwirl \* a \* rp \/ b \* horizon/.test(shader), 'frame dragging must be the azimuthal a*rp/b term');
  assert(/color \*= 1\.0 - swallowed/.test(shader), 'the horizon must swallow what falls in');
  assert(/ringColor \/ \(1\.0 \+ ringColor\)/.test(shader), "the reference's Reinhardt rolloff must be used on the ring");
  // Text does reach the shader: it comes in through the sampled target, so a pass that read the
  // screen instead would silently stop bending the lyrics.
  assert(/texture2D\(uSrc, srcUv\)/.test(shader), 'the scene must be sampled (and bent) through the target');
  // The measure the silhouette is written in must be the impact parameter, and it must be the
  // same measure bhImpactRadius solves with - the two copies drifting apart is how the shadow
  // disappeared in the first place, and no numeric test of the JS side can see it.
  assert(/vec3 impactPoint = vec3\(nq\.x, nq\.y, 0\.0\) \* \(pz \/ max\(denom, 1e-4\)\);/.test(shader),
    'the shader must build the impact point the way bhImpactRadius does');
  assert(/float rPlane = ksRadius\(impactPoint\.x, impactPoint\.y, 0\.0, a\);/.test(shader),
    'the silhouette must be a level set of the KS radius of the impact point');
  assert(!/ksRadius\(nq\.x, nq\.y, pz, a\)/.test(shader),
    'the KS radius of the point on the screen plane can never fall inside the horizon; it must not come back');
  console.log('shader: Kerr-Schild radius, rp/ergo algebra, 1/b bend, drag term, shadow and rolloff present');
}

console.log('[OK] The galactic black hole: ported kernel, a real scene->target->quad pass with a fallback, and knobs wired.');
