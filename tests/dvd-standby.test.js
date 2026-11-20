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
assert.ok(keys.length >= 10, 'the reference constants live in DVD_SCHEMA');
for (const key of keys) {
  const spec = schema[key];
  assert.ok(spec.def >= spec.min && spec.def <= spec.max, `${key} default must sit inside its range`);
  assert.ok(['bool', 'count', 'ratio', 'sec', 'unit'].includes(spec.kind), `${key} needs a known kind`);
}
assert.strictEqual(schema.speed.def, 1, 'the reference time is 1x');
assert.strictEqual(schema.angle.def, 45, 'the reference direction is 45 degrees on a 16:9 screen');
assert.strictEqual(schema.logoScale.def, 1, 'the reference logo scale is 1x');
assert.strictEqual(schema.reflections.def, 5, 'the reference loops over five cell hits');
assert.strictEqual(schema.rippleRange.def, 1.5, 'the reference wavefront is hitDist * 1.5');
assert.strictEqual(schema.rippleFreq.def, 2, 'the reference ripple frequency is 2');
assert.strictEqual(schema.bump.def, 0.1, 'the reference bump factor is .1');
assert.strictEqual(schema.dither.def, 1, 'the reference dither is the 0.005 noise term at 1x');
assert.strictEqual(schema.gamma.def, 1.5, 'the reference gamma is pow(1/1.5)');

// The picture: the reference's SDFs, cell walk, reflections and surface treatment survive.
for (const [pattern, why] of [
  [/float dvd_d\(vec2 p\)/, 'the DVD "d" glyph SDF has to survive'],
  [/float dvd_v\(vec2 p\)/, 'the DVD "v" glyph SDF has to survive'],
  [/float dvd_c\(vec2 p\)/, 'the DVD "c" glyph SDF has to survive'],
  [/float dvd\(vec2 p\)/, 'the three glyphs have to be combined into the logo'],
  [/vec2 calcHitPos\(vec2 move, vec2 dir, vec2 size\)/, 'the cell-boundary walk has to survive'],
  [/void flip\(inout vec2 pos\)/, 'the mirrored-tile flip has to survive'],
  [/void drawHit\(inout vec4 col, vec2 p, vec2 hitPos, float hitDist\)/, 'the wavefront hit has to survive'],
  [/void drawReflectedHit\(inout vec4 col, vec2 p, vec2 hitPos, float hitDist, vec2 screenSize\)/, 'the four mirrored hits have to survive'],
  [/vec3 spectrum\(float n\)/, 'the spectrum palette has to survive'],
  [/for \(int i = 0; i < uReflections; i\+\+\)/, 'the hit loop has to be the knob, not a baked count'],
  [/float bf = uBump;/, 'the bump factor has to be the knob'],
  [/pow\(col\.rgb, vec3\(1\. \/ uGamma\)\)/, 'the reference gamma curve has to survive'],
  [/texture\(iChannel0, fragCoord \/ uNoiseRes\)/, 'the dither has to read the generated noise'],
  [/fragColor = vec4\(col\.rgb, 1\.0\);/, 'the full-screen pass has to be opaque'],
  [/glslVersion: THREE\.GLSL3/, 'fwidth/texture need GLSL3'],
  [/new THREE\.DataTexture\(noiseData, noiseSize, noiseSize/, 'the reference noise channel is a generated 512 texture'],
]) {
  assert.ok(pattern.test(moduleText), why);
}
assert.ok(!/#ifdef DEBUG/.test(moduleText), 'the reference debug branches are not part of the port');
assert.match(moduleText, /vec2 baseDir = normalize\(vec2\(9\., 16\.\) \* screenSize\);/);
assert.match(moduleText, /vec2 dir = normalize\(mat2\(cos\(a\), -sin\(a\), sin\(a\), cos\(a\)\) \* baseDir\);/);
assert.match(moduleText, /float logoScale = \.1 \* uLogoScale;/);
assert.match(moduleText, /float wavefront = d - hitDist \* uRippleRange;/);

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
assert.match(tuningText, /mineradio-dvd-standby-tuning-v1/);
assert.match(tuningText, /function bindDvdTuningResetButtons\(/);
assert.match(tuningText, /function resetDvdTuningValue\(/);

console.log('OK dvd-standby: ' + keys.length + ' knobs, reference DVD SDF + reflections + surface pinned');