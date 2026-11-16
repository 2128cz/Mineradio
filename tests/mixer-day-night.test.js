'use strict';

// 预设 17「调音台」的昼夜模式。
//
// 参考着色器把反色元件的比例写死在 step(fract(grid.h.z*66.),.1)：约 10% 的面板格子反着上色
// （白底黑字变黑底白字）。这个比例现在由 uNightMix 决定，白天=0 保留参考的那 10%，黑夜=1 提到 90%。
// 判据不查源码形状：把 pcg3d 哈希和这条 step 独立抄写成 oracle，实测每个格子的归属，
// 检查反色比例真的随旋钮线性增长、而且格子归属不随镜头走带漂移（否则面板会一闪一闪地换颜色）。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '22-mixer-desk-preset.js'), 'utf8');

// ---------------------------------------------------------------- the oracle

const U32 = 4294967296;

function f32(x) { return Math.fround(x); }

function floatBitsToUint(x) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = x;
  return new Uint32Array(buf)[0];
}

// uvec3 pcg3d(uvec3 s){ s=s*1145141919u+1919810u; ... s^=s>>16; ... }
function pcg3d(s) {
  let x = (Math.imul(s[0], 1145141919) + 1919810) >>> 0;
  let y = (Math.imul(s[1], 1145141919) + 1919810) >>> 0;
  let z = (Math.imul(s[2], 1145141919) + 1919810) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  return [x, y, z];
}

// vec3 pcg3df(vec3 s){ return vec3(pcg3d(floatBitsToUint(s)))/float(0xffffffffu); }
function pcg3df(c) {
  const r = pcg3d([floatBitsToUint(f32(c[0])), floatBitsToUint(f32(c[1])), floatBitsToUint(f32(c[2]))]);
  return [f32(r[0]) / U32, f32(r[1]) / U32, f32(r[2]) / U32].map(f32);
}

// Grid dogrid(): r.c=(floor(ro/r.s)+.5)*r.s — the 2x2 cell centre the hash is taken from.
function cellCentre(ro, gridScale) {
  const s = [2 * gridScale, 2 * gridScale, 100];
  return [0, 1, 2].map((i) => (Math.floor(ro[i] / s[i]) + 0.5) * s[i]);
}

// The two literals the shader mixes between: float invThr=mix(.1,.9,uNightMix);
const mixLine = src.match(/float invThr=mix\(\s*([.\d]+)\s*,\s*([.\d]+)\s*,\s*uNightMix\s*\)/);
assert.ok(mixLine, 'the inversion threshold has to be a mix of a day anchor and a night anchor driven by uNightMix');
const DAY = Number(mixLine[1]);
const NIGHT = Number(mixLine[2]);

// step(fract(h.z*66.), invThr) — GLSL step(edge,x) is 1 when x >= edge, so the cell inverts
// when its hash lands at or below the threshold.
function thresholdFor(nightMix) { return f32(DAY + (NIGHT - DAY) * nightMix); }
function isInverted(cell, nightMix) {
  const h = pcg3df(cell);
  const scaled = f32(h[2] * 66);
  const frac = scaled - Math.floor(scaled);
  return frac <= thresholdFor(nightMix) ? 1 : 0;
}

function cellsInField(count, gridScale) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const gx = (i % 40) - 20;
    const gy = Math.floor(i / 40) - 12;
    out.push(cellCentre([gx * 2 * gridScale + 0.3, gy * 2 * gridScale - 0.7, 1.0], gridScale));
  }
  return out;
}

function invertedShare(cells, nightMix) {
  let n = 0;
  for (const c of cells) n += isInverted(c, nightMix);
  return n / cells.length;
}

const CELLS = cellsInField(4000, 1);

// ---------------------------------------------------------------- 1) the hash is a hash

{
  const fracs = CELLS.map((c) => {
    const scaled = f32(pcg3df(c)[2] * 66);
    return scaled - Math.floor(scaled);
  });
  assert.ok(fracs.every((v) => v >= 0 && v < 1), 'fract() has to stay inside [0,1)');
  const mean = fracs.reduce((a, b) => a + b, 0) / fracs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `the module hash has to spread evenly across cells (mean ${mean.toFixed(4)})`);
  const distinct = new Set(fracs.map((v) => v.toFixed(9))).size;
  assert.ok(distinct > fracs.length * 0.99, 'each cell needs its own draw, not a repeating pattern');
  // h.y picks the module type, h.z the palette; they must not be the same number.
  const h = pcg3df(CELLS[0]);
  assert.notEqual(h[1], h[2], 'the module type and the palette have to read different hash lanes');
}

// ---------------------------------------------------------------- 2) the knob moves the density

{
  assert.equal(DAY, 0.1, 'day mode has to keep the reference density (step(...,.1))');
  assert.ok(NIGHT > 0.5, 'night mode has to raise the inverted count, not lower it');

  const measured = [];
  for (const m of [0, 0.25, 0.5, 0.75, 1]) {
    const want = DAY + (NIGHT - DAY) * m;
    const got = invertedShare(CELLS, m);
    assert.ok(Math.abs(got - want) < 0.03,
      `nightMix ${m} must invert ${Math.round(want * 100)}% of the modules, measured ${Math.round(got * 100)}%`);
    measured.push(got);
  }
  for (let i = 1; i < measured.length; i++) {
    assert.ok(measured[i] > measured[i - 1], 'the inverted count has to grow with the knob, monotonically');
  }
  assert.ok(measured[4] / measured[0] > 7,
    `night mode must clearly more than day mode (ratio ${(measured[4] / measured[0]).toFixed(2)})`);
}

// ---------------------------------------------------------------- 3) a module keeps its palette

{
  // The camera pans (co.xy += iTime*uCamPan), so the same cell is entered from many origins.
  // The palette is hashed from the world cell centre, so the decision must never move.
  for (const nightMix of [0, 0.5, 1]) {
    for (const c of CELLS.slice(0, 400)) {
      const base = isInverted(c, nightMix);
      for (const [dx, dy] of [[0, 0], [0.9, 0.4], [-0.85, -0.2], [0.1, 0.99]]) {
        const again = isInverted(cellCentre([c[0] + dx, c[1] + dy, 1.0], 1), nightMix);
        assert.equal(again, base, 'a module may not change palette while the desk scrolls past the camera');
      }
    }
  }
  // gridScale rescales the field but must keep the density, which is what makes it a mode
  // rather than a zoom: same knob value, same share of inverted modules.
  for (const scale of [0.5, 1, 2.4]) {
    const got = invertedShare(cellsInField(1500, scale), 1);
    assert.ok(Math.abs(got - NIGHT) < 0.05, `night density must survive gridScale ${scale} (got ${got.toFixed(3)})`);
  }
}

// ---------------------------------------------------------------- 4) inverted means black/white swapped

{
  // basecol=mix(vec3(.04),c,mtlp)*(.75+.5*drv) with c=.9; mtlp is the panel face (1) or the
  // engraving (0), and the inversion is mtlp -> 1-mtlp.
  const drive = 0.5;
  const gain = f32(0.75 + 0.5 * drive);
  function plateLuma(mtlp, inverted) {
    const flipped = inverted ? 1 - mtlp : mtlp;
    return 0.04 + (0.9 - 0.04) * flipped;
  }
  const lightPlate = plateLuma(1, 0) * gain;
  const darkPlate = plateLuma(1, 1) * gain;
  const lightEngrave = plateLuma(0, 1) * gain;
  assert.ok(lightPlate > 0.5, 'a day module plate is a light surface');
  assert.ok(darkPlate < 0.1, 'an inverted plate is a black surface');
  assert.ok(lightEngrave > 0.5, 'the printing on an inverted plate turns white, so contrast survives');
  assert.ok(Math.abs(lightPlate - darkPlate) > 0.4 && Math.abs(lightEngrave - darkPlate) > 0.4,
    'both palettes have to keep a wide black/white step');

  // Share of the desk that reads dark, straight from the measured densities.
  const darkDay = invertedShare(CELLS, 0);
  const darkNight = invertedShare(CELLS, 1);
  assert.ok(darkNight > darkDay * 6, 'night mode is mostly black modules');
}

// ---------------------------------------------------------------- 5) the wiring

{
  const schema = src.match(/nightMix:\s*\{\s*def:\s*([\d.]+),\s*min:\s*([\d.]+),\s*max:\s*([\d.]+)/);
  assert.ok(schema, 'the desk needs a nightMix knob');
  assert.deepEqual([Number(schema[1]), Number(schema[2]), Number(schema[3])], [0, 0, 1],
    'nightMix runs 0..1 and defaults to day, so the desk looks like the reference until asked');

  assert.ok(/"uniform float uNightMix;"/.test(src), 'the ported body has to declare the uniform');
  assert.ok(!/step\(fract\(march\.grid\.h\.z\*66\.\),\s*\.1\)/.test(src),
    'the reference literal may not stay behind next to the knob, or the knob would be decoration');

  assert.ok(/uNightMix:\s*\{\s*value:\s*0\s*\}/.test(src), 'the material needs the uniform in its initial block');
  assert.ok(/u\.uNightMix\.value\s*=\s*mixerClamp01\(mixerParam\('nightMix'\)\)/.test(src),
    'the knob has to reach the shader clamped to 0..1');

  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const at = html.indexOf('id="fx-mixernightMix"');
  assert.ok(at > 0, 'the knob needs a row in the 调音台 panel');
  const inputTag = html.slice(at, html.indexOf('>', at));
  assert.ok(inputTag.includes('min="0"') && inputTag.includes('max="1"'), 'the slider must run 0..1');
  assert.ok(html.includes("setMixerTuning('nightMix', this.value)"), 'the slider must write the knob');

  const consoleSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  assert.ok(consoleSrc.includes("fxConsoleItem('fx-mixernightMix'"), 'the knob must be listed in the console 调音台 group');
}

console.log(`OK mixer day/night: ${DAY * 100}% -> ${NIGHT * 100}% inverted modules, fixed per cell, contrast kept`);
