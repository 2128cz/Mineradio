'use strict';

// Static checks for 待机 (preset 20). The reference (Shadertoy wtcSzN) is a single Image pass:
// the bouncing DVD logo, the mirrored cell reflections, the wavefront bump, the inverted + lit
// wall and the dither. These tests pin the pieces that would silently change the picture.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const moduleText = fs.readFileSync(path.join(appRoot, 'public/js/modules/02-visual/25-dvd-standby-preset.js'), 'utf8');
const tuningText = fs.readFileSync(path.join(appRoot, 'public/js/modules/07-fx/18-dvd-standby-tuning.js'), 'utf8');
const sandbox = { console };
vm.runInNewContext(moduleText, sandbox);

assert.strictEqual(sandbox.DVD_PRESET_INDEX, 20, 'the preset index is 20 and is never renumbered');

const schema = sandbox.DVD_SCHEMA;
const keys = Object.keys(schema);
assert.ok(keys.length >= 19, 'the reference constants and the water/beat controls live in DVD_SCHEMA');
for (const key of keys) {
  const spec = schema[key];
  assert.ok(spec.def >= spec.min && spec.def <= spec.max, `${key} default must sit inside its range`);
  assert.ok(['bool', 'count', 'ratio', 'sec', 'unit'].includes(spec.kind), `${key} needs a known kind`);
}
assert.strictEqual(schema.speed.def, 1, 'the reference time is 1x');
assert.strictEqual(schema.angle.def, 45, 'the reference direction is 45 degrees on a 16:9 screen');
assert.strictEqual(schema.logoScale.def, 1, 'the reference logo scale is 1x');
assert.strictEqual(schema.reflections.def, 10, 'the history is ten hits by default so old ripples survive');
assert.strictEqual(schema.rippleRange.def, 1.5, 'the reference wavefront is hitDist * 1.5');
assert.strictEqual(schema.rippleFreq.def, 2, 'the reference ripple frequency is 2');
assert.strictEqual(schema.rippleLife.def, 12, 'ripples fade over 12 cell units, not the reference 3');
assert.strictEqual(schema.bump.def, 0.1, 'the reference bump factor is .1');
assert.strictEqual(schema.dither.def, 1, 'the reference dither is the 0.005 noise term at 1x');
assert.strictEqual(schema.gamma.def, 1.5, 'the reference gamma is pow(1/1.5)');
assert.strictEqual(schema.beatDash.def, 1, 'the beat dash is on by default');
assert.strictEqual(schema.dashBeats.def, 0.55, 'the dash lasts a little over half a beat');
assert.strictEqual(schema.dashPower.def, 3, 'the dash accelerates into the wall (exponent 3)');
assert.strictEqual(schema.heightDecay.def, 0.35, 'ripple relief fades with age');
assert.strictEqual(schema.refract.def, 0.5, 'the cover refraction starts at half strength');
assert.strictEqual(schema.coverBlur.def, 10, 'the blurred cover starts at 10 px');
assert.strictEqual(schema.beatPunch.def, 0.7, 'a live beat pulses the logo and its halo');
assert.strictEqual(schema.impactFlash.def, 0.8, 'a wall impact flashes the logo halo');

// The picture: the reference's SDFs, cell walk, reflections and surface treatment survive.
for (const [pattern, why] of [
  [/float dvd_d\(vec2 p\)/, 'the DVD "d" glyph SDF has to survive'],
  [/float dvd_v\(vec2 p\)/, 'the DVD "v" glyph SDF has to survive'],
  [/float dvd_c\(vec2 p\)/, 'the DVD "c" glyph SDF has to survive'],
  [/float dvd\(vec2 p\)/, 'the three glyphs have to be combined into the logo'],
  [/vec2 calcHitPos\(vec2 move, vec2 dir, vec2 size\)/, 'the cell-boundary walk has to survive'],
  [/void flip\(inout vec2 pos\)/, 'the mirrored-tile flip has to survive'],
  [/void drawHit\(inout vec4 col, vec2 p, vec2 hitPos, float hitAge\)/, 'the wavefront hit has to survive'],
  [/void drawReflectedHit\(inout vec4 col, vec2 p, vec2 hitPos, float hitAge, vec2 screenSize\)/, 'the four mirrored hits have to survive'],
  [/uniform sampler2D uCover;/, 'the water surface has to sample the current cover'],
  [/uniform sampler2D uCoverBlur;/, 'the water surface needs a blurred cover'],
  [/uniform float uRefract;/, 'the normal has to drive a refraction strength'],
  [/texture\(uCover, clamp\(cuv \+ refr/, 'the flat surface has to be the cover, refracted by the height'],
  [/texture\(uCoverBlur, clamp\(cuv \+ refr \* 1\.25/, 'ripples have to sample the blurred cover'],
  [/smoothstep\(0\., \.15, slope\)/, 'the normal tilt mixes in the blurred cover'],
  [/for \(int i = 0; i < uReflections; i\+\+\)/, 'the hit loop has to be the knob, not a baked count'],
  [/float bf = uBump;/, 'the bump factor has to be the knob'],
  [/pow\(col\.rgb, vec3\(1\. \/ uGamma\)\)/, 'the reference gamma curve has to survive'],
  [/texture\(iChannel0, fragCoord \/ uNoiseRes\)/, 'the dither has to read the generated noise'],
  [/float blend = smoothstep\(uRippleLife, 0\., hitAge\);/, 'the ripple life has to be the knob, not the reference 3'],
  [/uniform float uHitAges\[16\];/, 'the shader needs one independent age per walk hit'],
  [/float hitAge = uHitAges\[i\];/, 'the ring age must come from the ripple clock, not the logo distance'],
  [/vec2 move = dir \* uTravel;/, 'the position has to come from the JS travel value so a beat can dash it'],
  [/fragColor = vec4\(col\.rgb, 1\.0\);/, 'the full-screen pass has to be opaque'],
  [/glslVersion: THREE\.GLSL3/, 'fwidth/texture need GLSL3'],
  [/new THREE\.DataTexture\(noiseData, noiseSize, noiseSize/, 'the reference noise channel is a generated 512 texture'],
]) {
  assert.ok(pattern.test(moduleText), why);
}
assert.ok(!/#ifdef DEBUG/.test(moduleText), 'the reference debug branches are not part of the port');
assert.ok(!/dir \* t \/ 1\.5/.test(moduleText), 'the reference time path must be replaced by the travel clock');
assert.match(moduleText, /vec2 baseDir = normalize\(vec2\(9\., 16\.\) \* screenSize\);/);
assert.match(moduleText, /vec2 dir = normalize\(mat2\(cos\(a\), -sin\(a\), sin\(a\), cos\(a\)\) \* baseDir\);/);
assert.match(moduleText, /float logoScale = \.1 \* uLogoScale;/);
assert.match(moduleText, /float wavefront = d - hitAge \* uRippleRange/);
assert.ok(!/distance\(hitPos, move\)/.test(moduleText), 'the ripple age must not be the distance the logo has travelled');
assert.match(moduleText, /dvdState\.rippleClock \+= step \* cellSpeed;/);
assert.match(moduleText, /dvdState\.rippleClock - dvdState\.hitBirths\[ai\]/);
assert.match(moduleText, /dvdState\.mat\.uniforms\.uHitAges\.value/);

assert.match(moduleText, /uniform float uBeat;/);
assert.match(moduleText, /uniform float uImpact;/);
assert.match(moduleText, /float logoPulse = 1\. \+ uBeat \* \.16;/);
assert.match(moduleText, /dvdState\.beatPulse = 1;/);
assert.match(moduleText, /dvdState\.impactPulse = 1;/);
assert.match(moduleText, /uBeat\.value = dvdState\.beatPulse \* dvdParam\('beatPunch'\)/);
assert.match(moduleText, /uImpact\.value = dvdState\.impactPulse \* dvdParam\('impactFlash'\)/);
assert.match(moduleText, /exp\(-hitAge \* uHeightDecay\)/);
assert.match(moduleText, /function dvdUpdateCoverTexture\(/);
assert.match(moduleText, /uniform vec3 uLightColor;/);
assert.match(moduleText, /float el = radians\(60\.\);/);
assert.match(moduleText, /float az = radians\(45\.\);/);
assert.match(moduleText, /uLightColor \* spe/);
assert.match(moduleText, /effectiveLyricPalette/);
assert.match(moduleText, /function dvdUpdateLightColor\(/);
assert.match(moduleText, /typeof coverTex !== 'undefined'/);
assert.match(moduleText, /ctx\.filter = 'blur\(' \+ blurPx/);
assert.match(moduleText, /u\.uCover\.value = cover;/);
assert.match(moduleText, /u\.uCoverBlur\.value = dvdState\.coverBlurTex;/);
// The beat must not re-time the background ripple pattern: its wavefront radius is hitAge-only,
// and neither uBeat nor uImpact may tint the wall/rings.
assert.ok(!/float wavefront = d - hitAge \* uRippleRange \* \(1\. \+ uBeat/.test(moduleText), 'the ripple wavefront may not be modulated by the beat');
assert.ok(!/col\.rgb \+= vec3\(\.8, \.9, 1\.\) \* pow\(blend, 4\.\) \* uImpact/.test(moduleText), 'the rings may not flash with the beat');
assert.ok(!/col\.rgb \+= uBeat \* vec3/.test(moduleText), 'the wall may not lift with the beat');
assert.ok(!/col\.rgb \+= uImpact \* vec3/.test(moduleText), 'the wall may not flash with the beat');

// Beat dash: live onset only (no map), and the next wall is solved from the live playable size.
assert.match(moduleText, /typeof beatOnsetFlag !== 'undefined' && beatOnsetFlag/);
assert.ok(!/currentBeatMap|cameraBeats|gridStep/.test(moduleText), 'the dash must not depend on a pre-analysed map');
assert.match(moduleText, /function dvdNextBoundaryTravel\(/);
assert.match(moduleText, /Math\.pow\(progress, dvdParam\('dashPower'\)\)/);
assert.match(moduleText, /gap \* dvdParam\('dashBeats'\)/);
assert.match(moduleText, /dvdState\.travel \+= step \* speed \/ 1\.5;/);
assert.match(moduleText, /Math\.abs\(dash\.sizeX - play\.x\)/);

// The boundary solver mirrors the shader: with a unit direction and size (4,2), the first wall
// is two travel units away; halving the playable width halves it. This is what keeps a beat dash
// landing on the edge after the logo/screen size changes.
{
  const step = sandbox.dvdNextBoundaryTravel;
  assert.equal(typeof step, 'function');
  const a = step(0, 1, 0, 4, 2);
  const b = step(0, 1, 0, 2, 2);
  assert.ok(Math.abs(a - 2) < 1e-9, `a 4-wide playable area puts the wall at travel 2 (got ${a})`);
  assert.ok(Math.abs(b - 1) < 1e-9, `a 2-wide playable area puts it at travel 1 (got ${b})`);
  const next = step(a, 1, 0, 4, 2);
  assert.ok(next > a + 1.9, 'the solver moves on to the next cell after a wall');
  const diagonal = step(0, Math.SQRT1_2, Math.SQRT1_2, 3.5, 2);
  assert.ok(diagonal > 0 && Math.abs(diagonal - 1.4142135623730951) < 1e-6,
    `the diagonal hits the y wall first on a 16:9 playable area (got ${diagonal})`);
}

// Lifecycle: a takeover owner with the whole picture, and a full dispose.
assert.match(moduleText, /id: 'dvd-standby'/);
for (const layer of ['particles', 'bloom', 'float', 'backCover', 'starRiver', 'ripples', 'lyricsParticles', 'stageLyrics']) {
  assert.ok(new RegExp(layer + ': true').test(moduleText), `the DVD preset must take ${layer} over`);
}
assert.match(moduleText, /function dvdDisposeScene\(/);
assert.match(moduleText, /if \(dvdState\.noiseTex\) dvdState\.noiseTex\.dispose\(\);/);
assert.match(moduleText, /function dvdRenderFrame\(/);
assert.match(moduleText, /function dvdUpdateLayer\(/);
assert.match(moduleText, /function applyDvdPresetNow\(/);

// Store: clamped on load, reset one row at a time.
assert.match(tuningText, /mineradio-dvd-standby-tuning-v2/);
assert.match(tuningText, /function bindDvdTuningResetButtons\(/);
assert.match(tuningText, /function resetDvdTuningValue\(/);

console.log('OK dvd-standby: ' + keys.length + ' knobs, reference DVD SDF + reflections + surface pinned');