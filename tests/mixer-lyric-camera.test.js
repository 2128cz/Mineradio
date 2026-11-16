'use strict';

// 预设 17「调音台」的歌词相机。
//
// 着色器的相机只存在于 GLSL 里：mainImage 用 orthbas(co-ct) 搭一组正交基，把屏幕坐标按 uCamFov
// 铺开、用 r2d 滚转，再加鼓点震动。歌词要贴在这张画面上，JS 侧就必须逐像素复刻同一台相机。
// 这里的判据不是源码形状：把 GLSL 那段独立抄写成 oracle，同一像素坐标经两种算法得到的世界点，
// 投影回来必须落在同一个位置。再检查台面姿态在斜视角下真的被压扁——旧实现只让文字在屏幕平面内
// 自转，法线永远与相机法线重合，那就是用户看到的"透视没对上"。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
// The r128 bundle is UMD and looks for a global shell before it falls back to module.exports.
global.self = global;
const THREE = require(path.join(root, 'public', 'vendor', 'three.r128.min.js'));
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '22-mixer-desk-preset.js'), 'utf8');

function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const end = src.indexOf('\n}\n', start) + 3;
  assert.ok(end > 2, 'missing the end of ' + name);
  return src.slice(start, end);
}

const PURE_FNS = ['mixerClamp01', 'mixerStepSmooth', 'mixerNormalize3', 'mixerCross3',
  'mixerOrthoBasis', 'mixerRot2', 'mixerScenePose', 'mixerApplyLyricCamera'].map(fn).join('\n');

const runPure = new Function('THREE', 'var mixerLyricScratch = {};\n' + PURE_FNS
  + '\nreturn { mixerScenePose, mixerApplyLyricCamera, mixerStepSmooth, mixerOrthoBasis };')(THREE);

// ---------------------------------------------------------------- the oracle
//
// A line-for-line restatement of mainImage's camera block, keeping GLSL's column-major matrices
// and its two different multiplication orders: `mat2 * vec2` rotates by +t, `vec2 * mat2` by -t.

function r2d(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [[c, s], [-s, c]]; // columns: col0 = (c,s), col1 = (-s,c)
}
function mat2TimesVec2(m, v) {
  // m[j] is column j: result_i = sum_j m[j][i] * v_j.
  return [m[0][0] * v[0] + m[1][0] * v[1], m[0][1] * v[0] + m[1][1] * v[1]];
}
function vec2TimesMat2(v, m) {
  // A row vector on the left: result_i = dot(v, column i), which is the transpose of the above.
  return [v[0] * m[0][0] + v[1] * m[0][1], v[0] * m[1][0] + v[1] * m[1][1]];
}
function orthbas(zRaw) {
  const len = Math.hypot(zRaw[0], zRaw[1], zRaw[2]);
  const z = [zRaw[0] / len, zRaw[1] / len, zRaw[2] / len];
  const up = Math.abs(z[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const x = (() => {
    const c = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    const n = Math.hypot(c[0], c[1], c[2]);
    return [c[0] / n, c[1] / n, c[2] / n];
  })();
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x, y, z]; // columns
}
function mat3TimesVec3(m, v) {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]
  ];
}
function glslSmoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// The world point the shader puts at uv, on the z=0 plane of its own basis (the ray origin).
function glslRayOrigin(t, k, uv) {
  let p = [uv[0] * 2 - 1, uv[1] * 2 - 1];
  p[0] *= k.aspect;
  const shk = k.beat * k.shake * 0.02;
  p = [p[0] + Math.sin(t * k.rate * 8.7) * shk, p[1] + Math.cos(t * k.rate * 7.3) * shk];
  p = mat2TimesVec2(r2d(Math.cos(t * k.rate * 5.3) * shk * 0.8), p);

  const canim = glslSmoothstep(-0.2, 0.2, Math.sin(t * k.anim));
  const co = [-6 + 6 * canim, -8 + 6 * canim, -40];
  const ct = [0, 0, -50];
  const cr = (0.5 - 0.5 * canim) * k.roll;
  co[0] += t * k.pan; co[1] += t * k.pan;
  ct[0] += t * k.pan; ct[1] += t * k.pan;
  const cb = orthbas([co[0] - ct[0], co[1] - ct[1], co[2] - ct[2]]);
  const local = vec2TimesMat2([k.fov * p[0], k.fov * p[1]], r2d(cr));
  return {
    point: [co[0] + local[0] * cb[0][0] + local[1] * cb[1][0],
      co[1] + local[0] * cb[0][1] + local[1] * cb[1][1],
      co[2] + local[0] * cb[0][2] + local[1] * cb[1][2]],
    canim, co, ct, cb
  };
}

// ---------------------------------------------------------------- 1) pixel-for-pixel

const KNOB_SETS = [
  { name: 'defaults', pan: 0, anim: 1, roll: 0, fov: 4, shake: 0, rate: 1, beat: 0 },
  { name: 'rolled and shaking', pan: 0.7, anim: 1.3, roll: 1.8, fov: 6.5, shake: 1.4, rate: 2.3, beat: 0.8 },
  { name: 'tight frame', pan: 2, anim: 0.4, roll: 2.9, fov: 1.2, shake: 2, rate: 4, beat: 1 }
];
const UVS = [[0, 0], [1, 1], [0.5, 0.5], [0.13, 0.77], [0.999, 0.001]];
const ASPECT = 16 / 9;

{
  let worst = 0;
  for (const knobs of KNOB_SETS) {
    for (const t of [0, Math.PI / 2, 2.0, 3 * Math.PI / 2, 5.0, 9.37]) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 400);
      const pose = runPure.mixerScenePose(t, {
        camPan: knobs.pan, camAnim: knobs.anim, camRoll: knobs.roll, camFov: knobs.fov,
        camShake: knobs.shake, camShakeRate: knobs.rate, beat: knobs.beat, aspect: ASPECT
      });
      runPure.mixerApplyLyricCamera(cam, pose);
      cam.updateMatrixWorld(true);
      for (const uv of UVS) {
        const world = glslRayOrigin(t, { ...knobs, aspect: ASPECT }, uv).point;
        const ndc = new THREE.Vector3(world[0], world[1], world[2]).project(cam);
        worst = Math.max(worst, Math.abs(ndc.x - (uv[0] * 2 - 1)), Math.abs(ndc.y - (uv[1] * 2 - 1)));
      }
      assert.ok(pose.halfH === knobs.fov, 'the frame height is the camera knob itself');
      assert.ok(Math.abs(pose.halfW - knobs.fov * ASPECT) < 1e-12, 'and its width follows the aspect');
    }
  }
  assert.ok(worst < 1e-9, `the mirrored camera must agree with the shader per pixel (worst ${worst})`);
  console.log(`OK camera mirror: pixel-for-pixel with the GLSL across ${KNOB_SETS.length} knob sets, worst error ${worst.toExponential(1)}`);
}

// ---------------------------------------------------------------- 2) the view really swings

{
  const viewAxis = (t) => {
    const pose = runPure.mixerScenePose(t, {
      camPan: 0, camAnim: 1, camRoll: 0, camFov: 4, camShake: 0, camShakeRate: 1, beat: 0, aspect: ASPECT
    });
    return new THREE.Vector3(pose.normal[0], pose.normal[1], pose.normal[2]);
  };
  const oblique = viewAxis(3 * Math.PI / 2); // sin = -1 -> canim 0
  const front = viewAxis(Math.PI / 2);       // sin = +1 -> canim 1
  // The shader's own endpoints: (-6,-8,10) and (0,-2,10) normalised, dotted with world +z.
  assert.ok(Math.abs(oblique.z - 10 / Math.hypot(6, 8, 10)) < 1e-12, 'the oblique end is the 45 degree one');
  assert.ok(Math.abs(front.z - 10 / Math.hypot(0, 2, 10)) < 1e-12, 'the other end is nearly square on');
  const obliqueDeg = Math.acos(oblique.z) * 180 / Math.PI;
  const frontDeg = Math.acos(front.z) * 180 / Math.PI;
  assert.ok(obliqueDeg > 40 && obliqueDeg < 48, `the swing really reaches ~45 deg, got ${obliqueDeg.toFixed(2)}`);
  assert.ok(frontDeg < 15, `and flattens to a near top view, got ${frontDeg.toFixed(2)}`);
  console.log(`OK swing: ${frontDeg.toFixed(1)} deg (top view) to ${obliqueDeg.toFixed(1)} deg (oblique)`);
}

// ---------------------------------------------------------------- the lyric transform

function lyricsCase(t, knobs, opts) {
  const o = opts || {};
  const face = o.face === undefined ? 0 : o.face;
  const fit = o.lockFitScale === undefined ? 1 : o.lockFitScale;
  const layoutScale = o.layoutScale === undefined ? 1 : o.layoutScale;
  const group = new THREE.Object3D();
  group.visible = true;
  // What the app's own layout leaves behind: the console's 歌词大小 times its perspective fit.
  group.scale.setScalar(layoutScale * fit);
  const scratch = {};
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 400);
  const mixerState = { built: true, lyricCam: cam, size: new THREE.Vector2(16, 9) };
  const paramTable = {
    camPan: knobs.pan, camAnim: knobs.anim, camRoll: knobs.roll, camFov: knobs.fov,
    camShake: knobs.shake, camShakeRate: knobs.rate, lyricFace: face
  };
  const step = new Function('THREE', 'mixerState', 'fx', 'stageLyrics', 'audio', 'beatPulse',
    'mixerParam', 'mixerPresetIsActive', 'mixerBuildScene', 'clampRange', 'mixerLyricScratch',
    PURE_FNS + '\n' + fn('updateMixerDeskLyrics') + '\nreturn updateMixerDeskLyrics;')(
    THREE, mixerState,
    o.fx || {},
    { group, lockFitScale: fit },
    { currentTime: t },
    knobs.beat,
    (key) => (paramTable[key] === undefined ? 0 : paramTable[key]),
    () => true, () => true, (v, a, b) => Math.max(a, Math.min(b, v)),
    scratch);
  assert.equal(step(0, true), true, 'the desk lyric step must run');
  // The renderer keeps a camera's world matrix fresh on every draw; the test has to do the same
  // before projecting anything through it.
  cam.updateMatrixWorld(true);
  return { group, cam, pose: runPure.mixerScenePose(t, {
    camPan: knobs.pan, camAnim: knobs.anim, camRoll: knobs.roll, camFov: knobs.fov,
    camShake: knobs.shake, camShakeRate: knobs.rate, beat: knobs.beat, aspect: 16 / 9
  }) };
}

// ---------------------------------------------------------------- 3) the desk plane, not the screen plane

const OBLIQUE = 3 * Math.PI / 2;
const FRONT = Math.PI / 2;
const FLAT = { pan: 0, anim: 1, roll: 0, fov: 4, shake: 0, rate: 1, beat: 0 };

{
  // face = 0: the text lies on the console (world x-y plane, facing +z where the eye is).
  const a = lyricsCase(OBLIQUE, FLAT, { face: 0 });
  const b = lyricsCase(FRONT, FLAT, { face: 0 });
  const plateNormal = (c) => new THREE.Vector3(0, 0, 1).applyQuaternion(c.group.quaternion);
  const camNormal = (c) => new THREE.Vector3(c.pose.normal[0], c.pose.normal[1], c.pose.normal[2]);
  const angle = (u, v) => Math.acos(Math.min(1, Math.max(-1, u.dot(v)))) * 180 / Math.PI;

  assert.ok(a.group.quaternion.angleTo(new THREE.Quaternion()) < 1e-9, 'the flat plate keeps the console plane');
  // This is the bug: an in-plane spin keeps the text parallel to the screen, so the two normals
  // never part and the perspective never matches the console.
  assert.ok(angle(plateNormal(a), camNormal(a)) > 40, `the text must tilt away from the screen, got ${angle(plateNormal(a), camNormal(a)).toFixed(1)}`);
  assert.ok(angle(plateNormal(b), camNormal(b)) > 5, 'and it keeps tilting as the view squares up');
  assert.ok(angle(plateNormal(a), camNormal(a)) > angle(plateNormal(b), camNormal(b)) + 25,
    'the tilt must follow the swing, not stay put');

  // Foreshortening: a unit of text height lying on the desk is shorter on screen when the view is
  // oblique than when it looks down the desk.
  const screenHeight = (c) => {
    const p0 = c.group.position.clone().project(c.cam);
    const p1 = c.group.position.clone().add(new THREE.Vector3(0, 1, 0)).project(c.cam);
    return Math.abs(p1.y - p0.y);
  };
  const ho = screenHeight(a), hf = screenHeight(b);
  assert.ok(ho > 0 && ho < hf, `the oblique view must compress the desk, got ${ho.toFixed(4)} vs ${hf.toFixed(4)}`);
  assert.ok(ho > hf * 0.6, 'and only compress it, never flatten it away');
  console.log(`OK desk plane: tilt ${angle(plateNormal(a), camNormal(a)).toFixed(1)} deg, height ${ho.toFixed(3)} vs ${hf.toFixed(3)}`);
}

// ---------------------------------------------------------------- 4) the billboard limit

{
  const c = lyricsCase(OBLIQUE, FLAT, { face: 1 });
  const camQuat = new THREE.Quaternion(c.cam.quaternion.x, c.cam.quaternion.y, c.cam.quaternion.z, c.cam.quaternion.w);
  assert.ok(c.group.quaternion.angleTo(camQuat) < 1e-9, 'at 100% the text faces the mirrored camera');
  const p0 = c.group.position.clone().project(c.cam);
  const p1 = c.group.position.clone().add(new THREE.Vector3(c.pose.right[0], c.pose.right[1], c.pose.right[2])).project(c.cam);
  const span = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  assert.ok(Math.abs(span - 1 / (FLAT.fov * ASPECT)) < 1e-9, `one unit along the frame width, got ${span}`);
  assert.ok(Math.abs(Math.hypot(p0.x, p0.y)) < 1e-9, 'and it stays pinned to the screen centre through the shake');
}

// ---------------------------------------------------------------- 5) anchor and position knobs

{
  const c = lyricsCase(OBLIQUE, FLAT, { face: 0 });
  const centre = c.group.position.clone().project(c.cam);
  assert.ok(Math.abs(centre.x) < 1e-9 && Math.abs(centre.y) < 1e-9, 'with no offsets the text sits at the look-at point');

  // Lying on the desk, 歌词位置 slides the text across the surface, so the screen shift has to come
  // out of the console basis rather than the screen axes: check it against the oracle basis.
  const oracle = glslRayOrigin(OBLIQUE, { pan: 0, anim: 1, roll: 0, fov: 4, shake: 0, rate: 1, beat: 0, aspect: ASPECT }, [0.5, 0.5]);
  const cb = oracle.cb, co = oracle.co;
  const shifted = lyricsCase(OBLIQUE, FLAT, { face: 0, fx: { lyricOffsetX: 2, lyricOffsetY: 1 } });
  const W = shifted.group.position;
  assert.ok(Math.abs(W.x - 2) < 1e-12 && Math.abs(W.y - 1) < 1e-12 && Math.abs(W.z + 50) < 1e-12,
    'the offsets move the anchor inside the console plane');
  const along = (axis) => ((W.x - co[0]) * axis[0] + (W.y - co[1]) * axis[1] + (W.z - co[2]) * axis[2]);
  const expectX = along(cb[0]) / (4 * ASPECT), expectY = along(cb[1]) / 4;
  const ndc = W.clone().project(shifted.cam);
  assert.ok(Math.abs(ndc.x - expectX) < 1e-9 && Math.abs(ndc.y - expectY) < 1e-9,
    `the text lands where the console puts it, got ${ndc.x}/${expectX} ${ndc.y}/${expectY}`);
  assert.ok(ndc.x > 0 && ndc.y > 0, 'and both offsets still read as right and up');
}

// ---------------------------------------------------------------- 6) the layout's size survives

{
  const c = lyricsCase(OBLIQUE, FLAT, { face: 0, lockFitScale: 0.5, layoutScale: 0.7 });
  // The layout wrote 0.7 * 0.5; the perspective fit means nothing to an orthographic frame, so the
  // desk keeps the console's own 歌词大小 and drops the fit.
  assert.ok(Math.abs(c.group.scale.x - 0.7) < 1e-9, `the fit scale must be stripped, got ${c.group.scale.x}`);
  const plain = lyricsCase(OBLIQUE, FLAT, { face: 0, lockFitScale: 1, layoutScale: 1.3 });
  assert.ok(Math.abs(plain.group.scale.x - 1.3) < 1e-9, 'and with no fit the size is untouched');
}

// ---------------------------------------------------------------- 7) the beat shake rides the camera

{
  const knocked = lyricsCase(2.0, { pan: 0, anim: 1, roll: 0, fov: 4, shake: 2, rate: 2.3, beat: 1 }, { face: 1 });
  const still = lyricsCase(2.0, { pan: 0, anim: 1, roll: 0, fov: 4, shake: 0, rate: 2.3, beat: 1 }, { face: 1 });
  const centre = knocked.group.position.clone().project(knocked.cam);
  const maxShift = 1 * 2 * 0.02; // beat * camShake * .02 in shader units
  assert.ok(Math.hypot(centre.x, centre.y) < maxShift / 4 * 2 + 1e-9,
    `a face-the-camera plate stays centred, got ${Math.hypot(centre.x, centre.y)}`);
  const moved = new THREE.Vector3().fromArray(knocked.pose.pos).sub(new THREE.Vector3().fromArray(still.pose.pos));
  assert.ok(moved.length() > 1e-3, 'the shaken camera must actually move');
  assert.ok(moved.length() < 4 * maxShift * 1.5, 'and only by its own shake amplitude');
  const desk = lyricsCase(2.0, { pan: 0, anim: 1, roll: 0, fov: 4, shake: 2, rate: 2.3, beat: 1 }, { face: 0 });
  const deskCentre = desk.group.position.clone().project(desk.cam);
  assert.ok(Math.hypot(deskCentre.x, deskCentre.y) > 1e-4, 'text glued to the desk shakes across the screen with the camera');
}

// ---------------------------------------------------------------- 8) the knob is wired

{
  assert.ok(/lyricFace:\s*\{\s*def:\s*0,\s*min:\s*0,\s*max:\s*1/.test(src), 'the desk needs a lyricFace knob, flat on the console by default');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="fx-mixerlyricFace"'), 'with a slider');
  assert.ok(html.includes("setMixerTuning('lyricFace', this.value)"), 'bound to the desk store');
  const consoleText = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  assert.ok(consoleText.includes("fxConsoleItem('fx-mixerlyricFace'"), 'and listed in the console');
  // The old in-plane spin is gone, and the overlay no longer rides the app's perspective camera.
  assert.ok(!/setFromAxisAngle\(sc\.fwd/.test(src), 'no more rotation about the screen axis');
  assert.ok(!/sc\.basePos\.copy\(group\.position\)/.test(src), 'no more re-basing the layout output');
  assert.ok(/renderer\.render\(mixerState\.lyricScene, cam\)/.test(src) && /var cam = mixerState\.lyricCam/.test(src),
    'the lyric overlay is drawn through the mirrored camera');
}

console.log('OK mixer lyric camera: mirrors the shader camera, tilts with the console, keeps the layout knobs');
