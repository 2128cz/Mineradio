'use strict';

// Static port check for preset 18. The strongest statement this can make is "the shipped fragment
// is the stored reference text with exactly the documented substitutions": the test applies the
// same substitution list to tests/fixtures/nyan-town-reference.glsl and compares the result with
// NYAN_TOWN_PORT_LINES. Defaults are compared with the reference literals one by one.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const moduleText = fs.readFileSync(path.join(appRoot, 'public/js/modules/02-visual/23-nyan-town-preset.js'), 'utf8');
const fixture = fs.readFileSync(path.join(appRoot, 'tests/fixtures/nyan-town-reference.glsl'), 'utf8').replace(/\r\n/g, '\n');

const arrayText = (moduleText.match(/var NYAN_TOWN_PORT_LINES = \[[\s\S]*?\n\];/) || [])[0];
assert.ok(arrayText, 'NYAN_TOWN_PORT_LINES has to be a literal line table');
const lines = vm.runInNewContext(arrayText + '\nNYAN_TOWN_PORT_LINES;');
const body = lines.join('\n');

// Same list as tmp/build-nyan-port.js. If the port changes, both places have to change.
let expected = fixture;
function replaceOnce(needle, replacement, label) {
  const at = expected.indexOf(needle);
  assert.ok(at >= 0, 'fixture anchor missing: ' + label);
  assert.strictEqual(expected.indexOf(needle, at + 1), -1, 'fixture anchor not unique: ' + label);
  expected = expected.slice(0, at) + replacement + expected.slice(at + needle.length);
}
replaceOnce('#define RAY_STEPS 150', '#define RAY_STEPS int(uRaySteps)', 'ray steps');
replaceOnce('float det=0.0;', 'float det=0.0;\nfloat nyanDepth=1.0;', 'depth slot');
replaceOnce('#define BRIGHTNESS 1.2', '#define BRIGHTNESS uBrightness', 'brightness');
replaceOnce('#define GAMMA 1.4', '#define GAMMA uGamma', 'gamma');
replaceOnce('#define SATURATION .65', '#define SATURATION uSaturation', 'saturation');
replaceOnce('#define detail .001', '#define detail uDetail', 'detail');
replaceOnce('#define t iTime*.5', '#define t (iTime*uTimeScale)', 'time scale');
replaceOnce('pos.y+=sin(pos.z-t*6.)*.15; //waves!', 'pos.y+=sin(pos.z-t*6.)*uWaveAmp; //waves!', 'wave amplitude');
replaceOnce('edge=min(1.,pow(edge,.55)*15.);', 'edge=min(1.,pow(edge,.55)*uEdgeGain);', 'edge gain');
replaceOnce('float sunsize=7.-max(0.,texture(iChannel0,vec2(.6,.2)).x)*5.; // responsive sun size',
  'float sunsize=uSunSize-max(0.,texture(iChannel0,vec2(uSunBand,.5)).x*uAudioDrive)*uSunPump; // responsive sun size',
  'sun size and audio pump');
replaceOnce('float an=atan(dir.x,dir.y)+iTime*1.5; // angle for drawing and rotating sun',
  'float an=atan(dir.x,dir.y)+iTime*uSunSpin; // angle for drawing and rotating sun', 'sun spin');
replaceOnce('\tti*=1.5;', '\tti*=uCamSpeed;', 'camera path speed');
replaceOnce('\tfloat ns=3.0;', '\tfloat ns=uNyanSpeed;', 'nyan speed');
replaceOnce('\tfloat fov=.9-max(0.,.7-iTime*.3);', '\tfloat fov=uFov-max(0.,uFovPump-iTime*.3);', 'field of view');
replaceOnce('color=mix(vec3(0.),color,pow(max(0.,.95-length(oriuv*oriuv*oriuv*vec2(1.05,1.1))),.3));',
  'color=mix(vec3(0.),color,pow(max(0.,.95-length(oriuv*oriuv*oriuv*vec2(1.05,1.1))),.3)*uBorder);', 'border');
replaceOnce('if (totdist>25.) col=backg; // hit background', 'if (totdist>25.) col=backg; // hit background\n\tnyanDepth=clamp(totdist/25.,0.,1.); // 0 near .. 1 far, for the lyric depth test', 'depth export');
replaceOnce([
  '#ifdef NYAN',
  '\tdir.yx*=rot(dir.x);',
  '\tvec2 ncatpos=(dir.xy+vec2(-3.+mod(-t,6.),-.27));',
  '\tvec4 ncat=nyan(ncatpos*5.);',
  '\tvec4 rain=rainbow(ncatpos*10.+vec2(.8,.5));',
  '\tif (totdist>8.) col=mix(col,max(vec3(.2),rain.xyz),rain.a*.9);',
  '\tif (totdist>8.) col=mix(col,max(vec3(.2),ncat.xyz),ncat.a*.9);',
  '#endif'
].join('\n'), [
  '#ifdef NYAN',
  '\tif (uNyan>.5) {',
  '\tdir.yx*=rot(dir.x);',
  '\tvec2 ncatpos=(dir.xy+vec2(-3.+mod(-t,6.),-.27));',
  '\tif (uRainbow>.5) {',
  '\tvec4 rain=rainbow(ncatpos*10.+vec2(.8,.5));',
  '\tif (totdist>8.) col=mix(col,max(vec3(.2),rain.xyz),rain.a*.9);',
  '\t}',
  '\tvec4 ncat=nyan(ncatpos*5.);',
  '\tif (totdist>8.) col=mix(col,max(vec3(.2),ncat.xyz),ncat.a*.9);',
  '\t}',
  '#endif'
].join('\n'), 'nyan block toggles');

replaceOnce('	fragColor = vec4(color,1.);', '	fragColor = vec4(color,nyanDepth);', 'depth in alpha');
const preamble = [
  '// GLSL3: three r128 does not provide gl_FragColor, and the driver writes it in main().',
  'out vec4 outColor;',
  '#define gl_FragColor outColor',
  '',
  'uniform float uTimeScale;',
  'uniform float uRaySteps;',
  'uniform float uDetail;',
  'uniform float uBrightness;',
  'uniform float uGamma;',
  'uniform float uSaturation;',
  'uniform float uEdgeGain;',
  'uniform float uWaveAmp;',
  'uniform float uSunSize;',
  'uniform float uSunPump;',
  'uniform float uSunBand;',
  'uniform float uSunSpin;',
  'uniform float uFov;',
  'uniform float uFovPump;',
  'uniform float uCamSpeed;',
  'uniform float uNyan;',
  'uniform float uRainbow;',
  'uniform float uNyanSpeed;',
  'uniform float uBorder;',
  'uniform float uAudioDrive;',
  ''
].join('\n');
expected = preamble + '\n' + expected;

assert.strictEqual(body, expected.replace(/\n$/, ''),
  'the shipped fragment must be the reference text with only the documented substitutions');

// The reference's building blocks, in the same order (order is part of the picture).
const order = ['vec4 formula(', 'float de(', 'vec3 normal(', 'vec4 rainbow(', 'vec4 nyan(',
  'vec3 raymarch(', 'vec3 move(', 'void mainImage('];
const positions = order.map((needle) => {
  const at = body.indexOf(needle);
  assert.ok(at >= 0, 'the reference function is missing: ' + needle);
  return at;
});
for (let i = 1; i < positions.length; i++) {
  assert.ok(positions[i - 1] < positions[i], 'reference functions are out of order at ' + order[i]);
}
// Rainbow is mixed before the cat, exactly as in the reference.
assert.ok(body.indexOf('vec4 rain=rainbow(') < body.indexOf('vec4 ncat=nyan('),
  'the rainbow has to be sampled before the cat');

// Knob defaults equal the reference literals.
const schemaText = (moduleText.match(/var NYAN_TOWN_TUNING_SCHEMA = \{[\s\S]*?\n\};/) || [])[0];
assert.ok(schemaText, 'NYAN_TOWN_TUNING_SCHEMA is missing');
const schema = vm.runInNewContext('(function () {' + schemaText + '\nreturn NYAN_TOWN_TUNING_SCHEMA;})()');
const literals = {
  raySteps: 150, detail: 0.001, brightness: 1.2, gamma: 1.4, saturation: 0.65, edgeGain: 15,
  waveAmp: 0.15, sunSize: 7, sunPump: 5, sunBand: 0.6, sunSpin: 1.5, fov: 0.9, fovPump: 0.7,
  camSpeed: 1.5, timeScale: 0.5, catSpeed: 3, border: 1, audioDrive: 1, renderScale: 0.8
};
for (const [key, value] of Object.entries(literals)) {
  assert.ok(schema[key], 'missing knob: ' + key);
  assert.strictEqual(schema[key].def, value, key + ' default must equal the reference literal');
}
assert.strictEqual(schema.catOn.def, 1, 'the cat cameo is on in the reference');
assert.strictEqual(schema.rainbowOn.def, 1, 'the rainbow is on in the reference');

// Sprite strip: six 40x24 frames, so 240/256 of the texture width is one cycle.
assert.match(moduleText, /NYAN_TOWN_SPRITE_FRAME_W = 40/);
assert.match(moduleText, /NYAN_TOWN_SPRITE_FRAME_H = 24/);
assert.match(moduleText, /NYAN_TOWN_SPRITE_FRAMES = 6/);
assert.match(moduleText, /NYAN_TOWN_SPRITE_TEXTURE_W = 256/);
assert.match(moduleText, /spriteTex\.wrapS = THREE\.RepeatWrapping/);
assert.match(moduleText, /spriteTex\.magFilter = THREE\.NearestFilter/);
assert.match(moduleText, /shadertoyFragment\(NYAN_TOWN_PORT_BODY, \{ channels: 2 \}\)/);

// The sprite has to live inside the band the reference actually samples. CanvasTexture flips Y, so
// the visible rows for y = 0.5 + uv.y + ny (uv.y in [-.3,.3], ny in [-.0375,0]) on a 24 px sheet
// are rows 5..19. Anything above or below is cut by the alpha window — that is exactly how the
// ears and the feet disappeared once.
const sandbox = { console };
vm.runInNewContext(moduleText, sandbox);
const rects = [];
const fakeCtx = {
  fillStyle: '',
  fillRect(x, y, w, h) { rects.push({ x: x, y: y, w: w, h: h }); }
};
for (let frame = 0; frame < 6; frame++) {
  sandbox.nyanTownPaintSpriteFrame(fakeCtx, frame * 40, frame);
}
assert.ok(rects.length > 40, 'the sprite painter has to draw the whole cat, not a placeholder');
for (const r of rects) {
  assert.ok(r.x >= 0 && r.x + r.w <= 240, `sprite art leaves the 6x40 strip: x ${r.x}..${r.x + r.w}`);
  assert.ok(r.y >= 5 && r.y + r.h <= 20,
    `sprite rows ${r.y}..${r.y + r.h - 1} leave the reference's sampled band 5..19; the alpha window clips them`);
}
assert.ok(rects.some((r) => r.y === 5), 'the ears have to sit at row 5, inside the sampled band');
assert.ok(rects.some((r) => r.y + r.h === 20), 'the feet have to end at row 19, inside the sampled band');

// The scene's alpha is the march hit distance (RGB untouched), and the composite is a depth test.
assert.match(body, /float nyanDepth=1\.0;/);
assert.match(body, /nyanDepth=clamp\(totdist\/25\.,0\.,1\.\);/);
assert.match(body, /fragColor = vec4\(color,nyanDepth\);/);
assert.match(moduleText, /smoothstep\(scene\.a - soft, scene\.a \+ soft, lyricDepth\)/);
assert.match(moduleText, /uniform float uLyricOn;/);

// Pure sky-flight math: the plate keeps its distance and slides in azimuth (a danmaku strip in
// the sky), fades at both edges, and the sides alternate. Elevation is a true world angle.
const flightOpts = { elevation: 30, spread: 1, roll: 10, distance: 14, laneShift: 0 };
const start = sandbox.nyanTownLyricFlight({ index: 2 }, 0, false, flightOpts);
const middle = sandbox.nyanTownLyricFlight({ index: 2 }, 0.5, false, flightOpts);
const end = sandbox.nyanTownLyricFlight({ index: 2 }, 1, false, flightOpts);
assert.ok(Math.abs(start.distance - 14) < 1e-9 && Math.abs(end.distance - 14) < 1e-9,
  'the plate has to keep its distance: it slides across the sky, it does not rush past the eye');
assert.ok(start.azimuth > middle.azimuth && middle.azimuth > end.azimuth, 'even lines sweep right to left');
assert.ok(start.alpha < 0.01 && middle.alpha > 0.99 && end.alpha < 0.01, 'the plate fades in and out');
assert.ok(middle.side === 1, 'even lines enter from one side');
assert.ok(sandbox.nyanTownLyricFlight({ index: 3 }, 0.5, false, flightOpts).side === -1, 'odd lines enter from the other side');
const currentFlight = sandbox.nyanTownLyricFlight({ index: 2 }, 0.5, true, flightOpts);
assert.ok(Math.abs(currentFlight.elevation * 180 / Math.PI - 30) < 3, 'the plate sits around the sky elevation');
const currentStart = sandbox.nyanTownLyricFlight({ index: 2 }, 0, true, flightOpts);
assert.ok(Math.abs(currentStart.azimuth) < Math.abs(start.azimuth), 'the current line sweeps a narrower, readable arc');
const laneFlight = sandbox.nyanTownLyricFlight({ index: 2 }, 0.5, true, { ...flightOpts, laneShift: 4 });
assert.ok(Math.abs((laneFlight.elevation - currentFlight.elevation) * 180 / Math.PI - 4) < 1e-6,
  'split chunks take separate lanes in the sky (degrees)');

// The replicated town camera: same eye on path(), same bank, and the reference's fov conversion.
const pose = sandbox.nyanTownScenePose(0, 10, { camSpeed: 1.5, aspect: 1.78, fov: 0.9, fovPump: 0.7 });
assert.ok(Math.abs(pose.pos[0] + 1) < 1e-9 && Math.abs(pose.pos[1] - 0.95) < 1e-9 && Math.abs(pose.pos[2]) < 1e-9,
  'the pose starts at the reference origin (origin + path(0))');
const fwdLen = Math.sqrt(pose.forward.reduce((s, v) => s + v * v, 0));
assert.ok(Math.abs(fwdLen - 1) < 1e-6, 'the camera basis stays orthonormal');
assert.ok(pose.forward[2] < -0.8, 'the town camera looks down the corridor');
assert.ok(Math.abs(pose.up[0]) > 0.05, 'the path camera banks, and the lyric camera has to bank with it');
const shaderFovDeg = 2 * Math.atan(0.9 / 1.78) * 180 / Math.PI;
assert.ok(Math.abs(pose.fovDeg - shaderFovDeg) < 1e-6, 'the reference fov is a half-width tangent: convert through the aspect');
const intro = sandbox.nyanTownScenePose(0, 0, { camSpeed: 1.5, aspect: 1.78, fov: 0.9, fovPump: 0.7 });
assert.ok(intro.fovDeg < pose.fovDeg, 'the reference zooms out: iTime drives the intro fov, not the song clock');

// Sky placement: the band lives in the camera's own frame, so its vertical angle is measured from
// the view axis and it rides with the camera instead of staying behind in the world.
const el = 18 * Math.PI / 180;
const sky = sandbox.nyanTownSkyPoint(pose, 0, el, 14);
for (let i = 0; i < 3; i++) {
  const expected = pose.pos[i] + (pose.forward[i] * Math.cos(el) + pose.up[i] * Math.sin(el)) * 14;
  assert.ok(Math.abs(sky[i] - expected) < 1e-9, 'azimuth 0 has to sit on the view axis, raised by the elevation');
}
const sidePoint = sandbox.nyanTownSkyPoint(pose, Math.PI / 2, 0, 14);
for (let i = 0; i < 3; i++) {
  assert.ok(Math.abs(sidePoint[i] - (pose.pos[i] + pose.right[i] * 14)) < 1e-9, 'azimuth 90 sits on the camera right axis');
}
const poseLater = sandbox.nyanTownScenePose(3.0, 10, { camSpeed: 1.5, aspect: 1.78, fov: 0.9, fovPump: 0.7 });
function bandAngles(p) {
  const s = sandbox.nyanTownSkyPoint(p, 0, el, 14);
  const d = [0, 1, 2].map((i) => (s[i] - p.pos[i]) / 14);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { alongForward: dot(d, p.forward), alongUp: dot(d, p.up) };
}
for (const p of [pose, poseLater]) {
  const band = bandAngles(p);
  assert.ok(Math.abs(band.alongForward - Math.cos(el)) < 1e-9 && Math.abs(band.alongUp - Math.sin(el)) < 1e-9,
    'the band has to keep its angle above the view axis at every camera pose (it follows the camera)');
}

// Style: every knob of the app's lyric console that the plates can honour has to be read here,
// and a plate is one line — no wrap, no paragraph.
assert.match(moduleText, /function nyanTownLyricConsoleScale\(/);
assert.match(moduleText, /lyricFontCss\(/);
assert.match(moduleText, /lyricLetterSpacingPx\(/);
assert.match(moduleText, /lyricFontWeightValue\(/);
assert.ok(moduleText.indexOf('nyanTownLyricWrapText') < 0, 'plates are single-line: wrapping would turn a danmaku strip into a paragraph');
assert.match(moduleText, /nyanTownApplyLyricCamera\(pose\)/);
assert.match(moduleText, /uDepth\.value = nyanTownClamp\(flight\.distance \/ 25/);

const sampleItems = [{ index: 0, startAt: 0 }, { index: 1, startAt: 5 }, { index: 2, startAt: 10 }];
assert.strictEqual(sandbox.nyanTownLyricSungIndex(sampleItems, -1), -1);
assert.strictEqual(sandbox.nyanTownLyricSungIndex(sampleItems, 6), 1);
assert.strictEqual(sandbox.nyanTownLyricSungIndex(sampleItems, 99), 2);

// The split knob: 0 keeps one plate, a size cuts Latin/CJK into a stream of plates.
assert.strictEqual(sandbox.nyanTownSplitLyricText('abcdefghij', 4).join('|'), 'abcd|efgh|ij');
assert.strictEqual(sandbox.nyanTownSplitLyricText('あいうえおかきくけこ', 4).join('|'), 'あいうえ|おかきく|けこ');
assert.strictEqual(sandbox.nyanTownSplitLyricText('abc', 0).join('|'), 'abc');
assert.strictEqual(sandbox.nyanTownSplitLyricText('abcd', 4).join('|'), 'abcd');
const wholePlates = sandbox.nyanTownLyricPlateList([
  { index: 0, text: 'aa', sub: '', startAt: 0, endAt: 5 },
  { index: 1, text: 'bb', sub: '', startAt: 5, endAt: 10 }
], 0, 0);
assert.strictEqual(wholePlates.map((p) => p.key).join('|'), '0:w|1:w');
const splitPlates = sandbox.nyanTownLyricPlateList([
  { index: 0, text: 'abcdefgh', sub: '', startAt: 0, endAt: 5 },
  { index: 1, text: 'ijklmnop', sub: '', startAt: 5, endAt: 10 }
], 0, 4);
assert.strictEqual(splitPlates.filter((p) => p.itemIndex === 0).map((p) => p.key).join('|'), '0:0|0:1');
assert.strictEqual(splitPlates.filter((p) => p.itemIndex === 0)[1].sub, '', 'only the first chunk carries the translation');
assert.ok(splitPlates.filter((p) => p.itemIndex === 0).every((p) => p.index === splitPlates[0].index), 'chunks of one line enter from the same side');
assert.strictEqual(splitPlates.filter((p) => p.itemIndex === 0).map((p) => p.laneSlot).join('|'), '0.5|-0.5', 'two chunks take opposite lanes, the first on top');
assert.strictEqual(splitPlates.filter((p) => p.itemIndex === 0)[1].startAt - splitPlates.filter((p) => p.itemIndex === 0)[0].startAt, 0.32, 'chunks are staggered in time');
const longPlates = sandbox.nyanTownLyricPlateList([{ index: 0, text: 'abcdefgh', sub: '', startAt: 0, endAt: 5 }], 0, 2);
assert.strictEqual(longPlates.map((p) => p.laneSlot).join('|'), '1|0|-1|1', 'lane slots cycle top to bottom over three bands');

console.log('OK nyan-town-port: ' + lines.length + ' reference lines, ' + Object.keys(schema).length + ' knobs, defaults pinned');
