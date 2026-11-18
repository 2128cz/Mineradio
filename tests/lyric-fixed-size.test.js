'use strict';

// Every lyric surface has to render at the size the console asked for. The built-in row texture
// used to shrink the font (and squeeze the glyphs horizontally) until the line fit the canvas, so
// the same lyric changed size from line to line; the translation inherited the same fit. The
// presets had their own versions of the same move. This pins the policy: grow the canvas/plate,
// never the type.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const builtIn = read('public/js/modules/02-visual/10-lyrics-mask-textures.js');
const nyan = read('public/js/modules/02-visual/23-nyan-town-preset.js');
const glitch = read('public/js/modules/02-visual/24-glitch-art-preset.js');
const blackHole = read('public/js/modules/02-visual/19-galaxy-blackhole-preset.js');

// ---------------------------------------------------------------- built-in stage lyrics

assert.ok(!/minimumStepFont/.test(builtIn), 'the width/height font-shrink loop must stay deleted');
assert.ok(!/fitRatio\s*=/.test(builtIn), 'the built-in layout must not derive a font scale from the canvas');
assert.ok(/var fitScaleX = 1;/.test(builtIn), 'the built-in row must not squeeze glyphs horizontally either');
assert.ok(/var maxCanvasW = Math\.max\(baseCanvasW, Math\.min\(8192/.test(builtIn), 'a long line widens the canvas instead of the font shrinking');
assert.ok(/var fontSize = isFinite\(state\.lockedFontSize\)[^;]*: 128;/.test(builtIn), 'without an override the row keeps the authored 128 px size');

// ---------------------------------------------------------------- nyan town

assert.ok(!/1900\s*\/\s*mainWidth/.test(nyan), 'nyan town may not shrink a long line to fit one texture');
assert.ok(/Math\.min\(4096/.test(nyan), 'nyan town widens the plate canvas instead');

// ---------------------------------------------------------------- glitch art

assert.ok(!/size\s*\*=\s*limit\s*\/\s*width/.test(glitch), 'the glitch plate may not shrink the type to the canvas width');
assert.ok(/canvas\.width = nextWidth/.test(glitch), 'the glitch plate widens its texture for a long line');
assert.ok(/mainCanvas\.width \/ 1536/.test(glitch), 'and the plate rect follows the widened texture');

// ---------------------------------------------------------------- black hole

assert.ok(!/widthNdc > 1\.45/.test(blackHole), 'the black hole may not cap a wide sign back into the frame by shrinking it');

console.log('OK lyric fixed size: built-in row + nyan town + glitch art + black hole keep the authored type size');