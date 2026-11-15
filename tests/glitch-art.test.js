'use strict';

// Static checks for 故障艺术 (preset 19). The reference page (Shadertoy lfscD7) was not reachable,
// so the port is component-based: the supplied presentation fragment is kept in Shadertoy shape
// (Vignette, bloom, texelFetch downsample, saturate/pow/lift), and the parts it names but does not
// define (the source, PCG, SeparableBlurUp) are implemented here. These tests pin the pieces that
// would silently change the picture.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const moduleText = fs.readFileSync(path.join(appRoot, 'public/js/modules/02-visual/24-glitch-art-preset.js'), 'utf8');
const tuningText = fs.readFileSync(path.join(appRoot, 'public/js/modules/07-fx/17-glitch-art-tuning.js'), 'utf8');
const sandbox = { console };
vm.runInNewContext(moduleText, sandbox);

assert.strictEqual(sandbox.GLITCH_PRESET_INDEX, 19, 'the preset index is 19 and is never renumbered');

// Every knob: a default inside its range, and the audio wiring knobs exist.
const schema = sandbox.GLITCH_SCHEMA;
const keys = Object.keys(schema);
assert.ok(keys.length >= 23, 'the component knobs have to all live in GLITCH_SCHEMA');
for (const key of keys) {
  const spec = schema[key];
  assert.ok(spec.def >= spec.min && spec.def <= spec.max, `${key} default must sit inside its range`);
  assert.ok(spec.kind === 'bool' || spec.kind === 'count' || spec.kind === 'ratio', `${key} needs a known kind`);
}
for (const key of ['audioDrive', 'audioGlitch', 'audioTear', 'audioBloom', 'beatPulse']) {
  assert.ok(schema[key], `audio wiring knob missing: ${key}`);
}
// The reference's own presentation constants are the defaults.
assert.strictEqual(schema.bloomStrength.def, 0.6, 'the composite adds the bloom at 0.6');
assert.strictEqual(schema.lift.def, 0.1, 'the reference lift is mix(0.1, 0.9)');
assert.strictEqual(schema.gamma.def, 0.8, 'the reference gamma is pow(0.8)');
assert.strictEqual(schema.vignetteStrength.def, 0.5, 'the vignette strength literal survives');
assert.strictEqual(schema.vignetteScale.def, 0.6, 'the vignette scale literal survives');
assert.strictEqual(schema.vignetteExponent.def, 3, 'the vignette exponent literal survives');
assert.strictEqual(schema.downsample.def, 3, 'kScreenDownsample has a concrete default');

// The presentation fragment keeps the supplied structure.
assert.match(moduleText, /float Vignette\(vec2 fragCoord\)/);
assert.match(moduleText, /pow\(dist \* uVigScale, uVigExponent\)/);
assert.match(moduleText, /texture2D\(iChannel1, \(cell \+ 0\.5\) \/ uLowRes\)\.xyz \* 0\.6/);
assert.match(moduleText, /pow\(rgb, vec3\(uGamma\)\)/);
assert.match(moduleText, /mix\(vec3\(uLift\), vec3\(1\.0 - uLift\), rgb\)/);
assert.match(moduleText, /if \(uBloomOn > 0\.5\)/);
// The separable bloom is its own pair of passes: a 13-tap 1D kernel driven by a direction uniform.
assert.match(moduleText, /for \(int i = -6; i <= 6; i\+\+\)/);
assert.match(moduleText, /uDir \* uTexel \* fi \* uRadius/);
assert.match(moduleText, /uniforms\.uDir\.value\.set\(1, 0\)/);
assert.match(moduleText, /uniforms\.uDir\.value\.set\(0, 1\)/);
// No spectrum sampler is declared (an unused sampler is an unbound sampler warning every frame).
assert.ok(moduleText.indexOf('uSpectrum') < 0, 'the source must not declare a sampler it never reads');
// The block layout is quantised so it reads as corrupted data, not white noise.
assert.match(moduleText, /float frameSeed = floor\(float\(iFrame\) \* 0\.1667\)/);
// The source is GLSL1, so the hash cannot use integer bit ops (PCG is replaced by a float hash).
assert.ok(moduleText.indexOf('uint ') < 0, 'the source must stay GLSL1: no uint/bit ops');

// Audio wiring: bands reach the source uniforms, the composite bloom reacts to bass.
assert.match(moduleText, /u\.uBass\.value = bands\[1\]/);
assert.match(moduleText, /u\.uMid\.value = bands\[3\]/);
assert.match(moduleText, /u\.uTreble\.value = bands\[6\]/);
assert.match(moduleText, /cu\.uBloomStrength\.value = glitchParam\('bloomStrength'\)/);

// Lifecycle: the preset is a takeover owner with the whole picture, and it disposes its targets.
assert.match(moduleText, /id: 'glitch-art'/);
for (const layer of ['particles', 'bloom', 'float', 'backCover', 'starRiver', 'ripples', 'lyricsParticles', 'stageLyrics']) {
  assert.ok(new RegExp(layer + ': true').test(moduleText), `the glitch preset must take ${layer} over`);
}
assert.match(moduleText, /function glitchDisposeScene\(/);
assert.match(moduleText, /function glitchRenderFrame\(/);
assert.match(moduleText, /function glitchUpdateLayer\(/);
assert.match(moduleText, /function applyGlitchArtPresetNow\(/);

// Store: the knobs are clamped on load and reset one row at a time.
assert.match(tuningText, /mineradio-glitch-art-tuning-v1/);
assert.match(tuningText, /function bindGlitchTuningResetButtons\(/);
assert.match(tuningText, /function resetGlitchTuningValue\(/);

console.log('OK glitch-art: ' + keys.length + ' knobs, reference presentation pinned');
