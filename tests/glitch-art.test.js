'use strict';

// Static checks for 故障艺术 (preset 19). The reference (Shadertoy lfscD7) was supplied as Common +
// Buffer A + Buffer B + Image. Buffer A is ported verbatim with its #defines turned into uniforms;
// these tests pin the pieces that would silently change the picture, plus the audio wiring and the
// added logo/lyric layer.

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

const schema = sandbox.GLITCH_SCHEMA;
const keys = Object.keys(schema);
assert.ok(keys.length >= 33, 'all Buffer A / presentation / logo / audio knobs live in GLITCH_SCHEMA');
for (const key of keys) {
  const spec = schema[key];
  assert.ok(spec.def >= spec.min && spec.def <= spec.max, `${key} default must sit inside its range`);
  assert.ok(['bool', 'count', 'ratio', 'sec'].includes(spec.kind), `${key} needs a known kind`);
}
// The reference's own constants are the defaults.
assert.strictEqual(schema.downsample.def, 3, 'kScreenDownsample starts at 3');
assert.strictEqual(schema.antiAlias.def, 2, 'kAntiAlias starts at 2 (the reference is 5, too heavy live)');
assert.strictEqual(schema.turns.def, 7, 'kTurns is 7');
assert.strictEqual(schema.ripples.def, 5, 'kNumRipples is 5');
assert.strictEqual(schema.speed.def, 0.15, 'kSpeed is 0.15');
assert.strictEqual(schema.zoom.def, 0.35, 'kZoom is 0.35');
assert.strictEqual(schema.staticFrequency.def, 0.1, 'kStaticFrequency is 0.1');
assert.strictEqual(schema.vDisplace.def, 0.07, 'kVDisplaceFrequency is 0.07');
assert.strictEqual(schema.hDisplace.def, 0.25, 'kHDisplaceFrequency is 0.25');
assert.strictEqual(schema.quantisation.def, 5, 'kColourQuantisation is 5');
assert.strictEqual(schema.bloomStrength.def, 1, 'the composite adds the bloom at full weight');
assert.strictEqual(schema.lift.def, 0.1, 'the reference lift is mix(0.1, 0.9)');
assert.strictEqual(schema.gamma.def, 0.8, 'the reference gamma is pow(0.8)');
assert.strictEqual(schema.vignetteStrength.def, 0.5, 'the vignette strength literal survives');
assert.strictEqual(schema.vignetteScale.def, 0.6, 'the vignette scale literal survives');
assert.strictEqual(schema.vignetteExponent.def, 3, 'the vignette exponent literal survives');

// Buffer A: the reference's structure survives.
for (const [pattern, why] of [
  [/vec2 Cartesian2DToHexagonalTiling\(/, 'the hexagonal tiling is the picture'],
  [/uvec4 PCGAdvance\(\)/, 'the PCG generator has to survive'],
  [/void PCGInitialise\(uint seed\)/, 'the per-frame seed has to survive'],
  [/uint HashOf\(uint i\)/, 'the FNV hash has to survive'],
  [/bool Interfere\(inout vec2 xy, inout vec3 tint, in vec2 res\)/, 'the interference pass has to survive'],
  [/float KickDrop\(/, 'the style blend kick has to survive'],
  [/vec3 SampleSpectrum\(float delta\)/, 'the spectral colour sampling has to survive'],
  [/float OrderedDither\(ivec2 p\)/, 'the ordered dither has to survive'],
  [/for\(int iterIdx = 0; iterIdx < kMaxIterations; \+\+iterIdx\)/, 'the ripple/invert iterations have to survive'],
  [/for\(int j = 0; j < kTurns; \+\+j\)/, 'the turns loop has to survive'],
  [/for\(int i = 0; i < kNumRipples; \+\+i\)/, 'the ripples loop has to survive'],
  [/xy \*= uScreenDownsample;/, 'Buffer A renders below screen resolution via kScreenDownsample'],
  [/glslVersion: THREE.GLSL3/, 'uint/bit ops and texelFetch require GLSL3'],
  [/new THREE\.DataTexture\(noiseData, 1024, 1024/, 'the reference blue-noise channel is replaced by a 1024 noise texture'],
]) {
  assert.ok(pattern.test(moduleText), why);
}
// The reference's #defines are uniforms now (not baked literals).
assert.match(moduleText, /int kMaxIterations = uIterations;/);
assert.match(moduleText, /int kTurns = uTurns;/);
assert.match(moduleText, /int kNumRipples = uRipples;/);
assert.match(moduleText, /float kScale = mix\(2\.6, 1\.1, expMorph\) \* uScale;/);
assert.match(moduleText, /frameHash < uStaticFreq/);

// Image pass: the supplied composite's constants.
assert.match(moduleText, /float Vignette\(vec2 fragCoord\)/);
assert.match(moduleText, /pow\(dist \* uVigScale, uVigExponent\)/);
assert.match(moduleText, /texture2D\(iChannel1, \(cell \+ 0\.5\) \/ uLowRes\)\.xyz \* 0\.6/);
assert.match(moduleText, /pow\(rgb, vec3\(uGamma\)\)/);
assert.match(moduleText, /mix\(vec3\(uLift\), vec3\(1\.0 - uLift\), rgb\)/);
// Bloom kernel from the reference's Common.
assert.match(moduleText, /glitchGaussian\(k, radius, texel, kBloomKernelShape, sigmaL, sigmaWeights\)/);
assert.match(moduleText, /vec3\(1\.5, 1\.0, 0\.7\)/);
assert.match(moduleText, /vec3\(0\.2\)/);

// Lyric/logo layer: canvas text glitched in screen space around the hexagon, one style phase.
for (const key of ['logoOn', 'logoSize', 'lyricOn', 'lyricGlitch', 'lyricSize', 'styleCycle']) {
  assert.ok(schema[key], 'the lyric/logo knob is missing: ' + key);
}
assert.match(moduleText, /uniform sampler2D uLyricMain;/);
assert.match(moduleText, /uniform sampler2D uLyricSub;/);
assert.match(moduleText, /vec4 lyricPlate\(vec2 uv, sampler2D tex, vec4 rect, float seed\)/);
assert.match(moduleText, /vec4 hexLogo\(vec2 uv\)/);
assert.match(moduleText, /uStyleSeed/);
assert.match(moduleText, /function glitchUpdateLyrics\(clock\)/);
assert.match(moduleText, /function glitchDrawPlate\(/);
assert.match(moduleText, /nyanTownLyricItems\(\)/);
assert.match(moduleText, /lyricLetterSpacingPx\(/);
assert.match(moduleText, /new THREE\.CanvasTexture\(mainCanvas\)/);

// Audio wiring: bands reach Buffer A's uniforms; the lyric glitch follows the high band.
assert.match(moduleText, /u\.uBass\.value = bands\[1\]/);
assert.match(moduleText, /u\.uTreble\.value = bands\[6\]/);
assert.match(moduleText, /u\.uBeat\.value = glitchClamp\(beat, 0, 1\) \* glitchParam\('beatPulse'\)/);
assert.match(moduleText, /uAudioGlitch\.value = glitchParam\('audioGlitch'\)/);
assert.match(moduleText, /uAudioTear\.value = glitchParam\('audioTear'\)/);
assert.match(moduleText, /cu\.uBloomStrength\.value = glitchParam\('bloomStrength'\)/);
assert.match(moduleText, /cu\.uLyricGlitch\.value = glitchParam\('lyricGlitch'\)/);

// Lifecycle: a takeover owner with the whole picture, and a full dispose.
assert.match(moduleText, /id: 'glitch-art'/);
for (const layer of ['particles', 'bloom', 'float', 'backCover', 'starRiver', 'ripples', 'lyricsParticles', 'stageLyrics']) {
  assert.ok(new RegExp(layer + ': true').test(moduleText), `the glitch preset must take ${layer} over`);
}
assert.match(moduleText, /function glitchDisposeScene\(/);
assert.match(moduleText, /if \(glitchState\.noiseTex\) glitchState\.noiseTex\.dispose\(\);/);
assert.match(moduleText, /function glitchRenderFrame\(/);
assert.match(moduleText, /function glitchUpdateLayer\(/);
assert.match(moduleText, /function applyGlitchArtPresetNow\(/);

// Store: the knobs are clamped on load and reset one row at a time.
assert.match(tuningText, /mineradio-glitch-art-tuning-v1/);
assert.match(tuningText, /function bindGlitchTuningResetButtons\(/);
assert.match(tuningText, /function resetGlitchTuningValue\(/);

console.log('OK glitch-art: ' + keys.length + ' knobs, reference Buffer A + Image pinned');
