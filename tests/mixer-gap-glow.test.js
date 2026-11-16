'use strict';

// 预设 17「调音台」的缝隙圣光（贴在台面上的那套雾光，不是体积光柱）。
//
// 面板格子被参考的波浪抬起：p.z+=.4*sin(2*iTime+1.*fract(hash.z*28.)+.3*(c.x+c.y))，相邻格子一高一低
// 时缝隙才真的"错台露出"。这里把这套算式独立抄写成 oracle，量四件事：旋钮归零时画面必须逐位不变；
// 亮线只贴在边框上、朝格子中心单调衰减；门控来自参考自己的波浪（周期必须同为 2*iTime，齐平时不亮）；
// 雾宽只加宽外圈、不动那条细亮线。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '22-mixer-desk-preset.js'), 'utf8');

// ---------------------------------------------------------------- the oracle

const U32 = 4294967296;
const f32 = (x) => Math.fround(x);

function floatBitsToUint(x) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = x;
  return new Uint32Array(buf)[0];
}

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

function pcg3df(c) {
  const r = pcg3d([floatBitsToUint(f32(c[0])), floatBitsToUint(f32(c[1])), floatBitsToUint(f32(c[2]))]);
  return [f32(r[0]) / U32, f32(r[1]) / U32, f32(r[2]) / U32].map(f32);
}

const fract = (x) => x - Math.floor(x);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// map()'s plate lift, verbatim.
function bob(c, t) {
  const h = pcg3df(c);
  return 0.4 * Math.sin(2 * t + 1 * fract(h[2] * 28) + 0.3 * (c[0] + c[1]));
}

// The glow term, transcribed from the ported body.
function gapAt(gp, cell, size, t, { glow, fog, drv }) {
  const ghs = [size[0] / 2 - 0.02, size[1] / 2 - 0.02];
  const e = Math.abs(Math.min(ghs[0] - Math.abs(gp[0]), ghs[1] - Math.abs(gp[1])));
  const nearX = ghs[0] - Math.abs(gp[0]) < ghs[1] - Math.abs(gp[1]);
  const sg = [Math.sign(gp[0]), Math.sign(gp[1])];
  const nc = nearX
    ? [cell[0] + sg[0] * size[0], cell[1], cell[2]]
    : [cell[0], cell[1] + sg[1] * size[1], cell[2]];
  const gb = Math.abs(bob(cell, t) - bob(nc, t));
  const band = Math.exp(-e * 24) + 0.45 * Math.exp(-e * 3 / Math.max(0.03, fog));
  return glow * band * smoothstep(0.02, 0.35, gb) * (0.35 + 0.65 * drv);
}

const CELL = [1, 3, 50];
const SIZE = [2, 2, 100];
const T = 7.3;
const opts = (over) => Object.assign({ glow: 0.7, fog: 0.22, drv: 0.5 }, over);

// A seam that is actually staggered, so the gate is open for the decay tests.
function findStaggeredCell(axis) {
  for (let k = 0; k < 400; k++) {
    const cell = [1 + axis * 2 * k, 3 + (1 - axis) * 2 * k, 50];
    const gp = axis === 0 ? [SIZE[0] / 2 - 0.02, 0, 0] : [0, SIZE[1] / 2 - 0.02, 0];
    if (gapAt(gp, cell, SIZE, T, opts({ glow: 1, drv: 0 })) > 1e-4) return { cell, gp };
  }
  throw new Error('no staggered seam found; the wave gate would never open');
}

// ---------------------------------------------------------------- 1) knob at zero is the old picture

{
  const probes = [[0, 0, 0], [0.9, 0, 0], [1.48, 0, 0], [0, 1.48, 0], [0.4, 0.4, 0]];
  for (const gp of probes) {
    assert.equal(gapAt(gp, CELL, SIZE, T, opts({ glow: 0 })), 0,
      'gapGlow=0 must contribute exactly nothing, pixel for pixel');
  }
}

// ---------------------------------------------------------------- 2) it hugs the seam and dies inward

{
  const { cell, gp } = findStaggeredCell(0);
  const atSeam = gapAt(gp, cell, SIZE, T, opts({}));
  assert.ok(atSeam > 0, 'a staggered seam has to glow');
  let prev = atSeam;
  for (let x = gp[0] - 0.05; x >= 0.05; x -= 0.05) {
    const v = gapAt([x, gp[1], 0], cell, SIZE, T, opts({}));
    assert.ok(v < prev, 'the fog has to thin out as it leaves the seam for the plate centre');
    prev = v;
  }
  const centre = gapAt([0, 0, 0], cell, SIZE, T, opts({}));
  assert.ok(centre < atSeam * 0.01, `the plate middle stays dark (centre ${centre.toExponential(2)} of seam ${atSeam.toFixed(3)})`);
  // The crevice itself is the brightest thing on the desk: the thin core sits at e=0.
  const core = gapAt([SIZE[0] / 2 - 0.02, 0, 0], cell, SIZE, T, opts({}));
  const justInside = gapAt([SIZE[0] / 2 - 0.06, 0, 0], cell, SIZE, T, opts({}));
  assert.ok(core > justInside * 2, 'the bright line is the seam, the wide band is only its fog');
}

// ---------------------------------------------------------------- 3) the gate is the reference's own wave

{
  const { cell } = findStaggeredCell(0);
  const gp = [SIZE[0] / 2 - 0.02, 0, 0];
  // Same wave, so the period is the reference's 2*iTime, not something invented here.
  const a = gapAt(gp, cell, SIZE, T, opts({ glow: 1, drv: 0 }));
  const b = gapAt(gp, cell, SIZE, T + Math.PI, opts({ glow: 1, drv: 0 }));
  assert.ok(Math.abs(a - b) < 1e-9, 'the seam fog has to breathe on the plates\' own period');
  const half = gapAt(gp, cell, SIZE, T + Math.PI / 2, opts({ glow: 1, drv: 0 }));
  assert.notEqual(half, a, 'a quarter period has to move the stagger, or the wave is not driving it');

  // Level plates never glow: the gate is the difference of the reference wave against itself.
  const own = bob(cell, T);
  assert.equal(smoothstep(0.02, 0.35, Math.abs(own - own)), 0, 'a flush seam shows no light');

  // And the wave opens and shuts different seams over time, which is the whole point of
  // borrowing it: the lit seams have to travel with the stagger.
  const openShare = (t) => {
    let n = 0;
    for (let k = 0; k < 300; k++) {
      const c = [1 + 2 * k, 3 + 2 * (k % 7), 50];
      if (smoothstep(0.02, 0.35, Math.abs(bob(c, t) - bob([c[0] + 2, c[1], c[2]], t))) > 0.5) n++;
    }
    return n / 300;
  };
  const shareA = openShare(T), shareB = openShare(T + 0.7);
  assert.ok(shareA > 0.1 && shareA < 0.9, `staggered seams have to be a minority of the field (open ${shareA.toFixed(2)})`);
  assert.ok(Math.abs(shareA - shareB) > 0.02, 'the wave has to move which seams are lit, not just their brightness');
}

// ---------------------------------------------------------------- 4) the neighbour lookup picks the right side

{
  const { cell } = findStaggeredCell(0);
  const gx = [SIZE[0] / 2 - 0.02, 0.1, 0];
  const gy = [0.1, SIZE[1] / 2 - 0.02, 0];
  const xNeighbour = bob([cell[0] + SIZE[0], cell[1], cell[2]], T);
  const yNeighbour = bob([cell[0], cell[1] + SIZE[1], cell[2]], T);
  const own = bob(cell, T);
  const gateX = smoothstep(0.02, 0.35, Math.abs(own - xNeighbour));
  const gateY = smoothstep(0.02, 0.35, Math.abs(own - yNeighbour));
  const measuredX = gapAt(gx, cell, SIZE, T, opts({ glow: 1, drv: 1 })) / 1.45;
  const measuredY = gapAt(gy, cell, SIZE, T, opts({ glow: 1, drv: 1 })) / 1.45;
  assert.ok(Math.abs(measuredX - gateX) < 1e-9, 'a point by the x border has to be gated by the x neighbour');
  assert.ok(Math.abs(measuredY - gateY) < 1e-9, 'a point by the y border has to be gated by the y neighbour');
}

// ---------------------------------------------------------------- 5) fog width only widens the halo

{
  const { cell } = findStaggeredCell(0);
  const gp = [SIZE[0] / 2 - 0.02, 0, 0];
  const at = (d, fog) => gapAt([gp[0] - d, 0, 0], cell, SIZE, T, opts({ glow: 1, fog }));
  const thin = at(0.3, 0.03), wide = at(0.3, 0.6);
  assert.ok(wide > thin * 3, `a wider fog knob has to spread the halo (0.03 -> ${thin.toExponential(1)}, 0.6 -> ${wide.toExponential(1)})`);
  // The core line is the fixed exp(-e*24) term, so it must not move with the width knob.
  for (const fog of [0.03, 0.22, 0.6]) {
    const v = at(0, fog);
    assert.ok(Math.abs(v - at(0, 0.22)) < 1e-12, 'the thin seam line is not the fog and must stay put');
  }
  // And the halo still ends well before the plate centre, at any width the knob allows.
  // (0.56 is a quarter of the way from the seam to the middle of a 2x2 module, same side,
  // so the gate is the same one and only the band is being compared.)
  assert.ok(at(0.56, 0.6) < at(0, 0.6) * 0.02, 'even the widest fog may not wash over the whole module');
}

// ---------------------------------------------------------------- 6) the level drives the pulse

{
  const { cell } = findStaggeredCell(0);
  const gp = [SIZE[0] / 2 - 0.02, 0, 0];
  const silence = gapAt(gp, cell, SIZE, T, opts({ glow: 1, drv: 0 }));
  const loud = gapAt(gp, cell, SIZE, T, opts({ glow: 1, drv: 1 }));
  assert.ok(Math.abs(loud / silence - 1 / 0.35) < 1e-9, 'full level has to triple the seam against silence');
  assert.ok(silence > 0, 'silence keeps a floor of light, so the fog never blinks out entirely');
  let prev = -1;
  for (const drv of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const v = gapAt(gp, cell, SIZE, T, opts({ glow: 1, drv }));
    assert.ok(v > prev, 'the glow has to rise with the level');
    prev = v;
  }
}

// ---------------------------------------------------------------- 7) the wiring

{
  assert.ok(/"uniform float uGapGlow;"/.test(src) && /"uniform float uGapFog;"/.test(src),
    'the ported body has to declare both fog uniforms');
  assert.ok(/gapGlow:\s*\{\s*def:\s*0\.7,\s*min:\s*0,\s*max:\s*2/.test(src), 'gapGlow runs 0..2 and defaults on');
  assert.ok(/gapFog:\s*\{\s*def:\s*0\.22,\s*min:\s*0\.03,\s*max:\s*0\.6/.test(src), 'gapFog runs 0.03..0.6');
  assert.ok(/uGapGlow:\s*\{\s*value:\s*0\.7\s*\}/.test(src) && /uGapFog:\s*\{\s*value:\s*0\.22\s*\}/.test(src),
    'the material needs both uniforms in its initial block');
  assert.ok(/u\.uGapGlow\.value\s*=\s*Math\.max\(0,\s*mixerParam\('gapGlow'\)\)/.test(src), 'gapGlow has to reach the shader');
  assert.ok(/u\.uGapFog\.value\s*=\s*Math\.max\(0\.03,\s*mixerParam\('gapFog'\)\)/.test(src), 'gapFog has to reach the shader');

  // Emissive, added after the two lights and before the gamma line: the fog must not be shaded away.
  const addAt = src.indexOf('col+=gap*vec3(');
  const lightAt = src.lastIndexOf('col+=shadow*dotnl*(diff+spec);');
  const gammaAt = src.indexOf('col=pow(col,vec3(.4545))');
  assert.ok(addAt > lightAt && addAt < gammaAt, 'the seam light has to be emissive, added after the lighting');
  assert.ok(src.indexOf('float gap=0.;') < src.indexOf('if(mtl==0.){'), 'gap has to default to nothing for the other materials');
  assert.ok(/gap=uGapGlow\*\(exp\(-ge\*24\.\)\+\.45\*exp\(-ge\/max\(\.03,uGapFog\)\*3\.\)\)/.test(src),
    'the two-band shape the oracle measures is the one in the shader');

  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  for (const [id, key, min, max] of [['fx-mixergapGlow', 'gapGlow', '0', '2'], ['fx-mixergapFog', 'gapFog', '0.03', '0.6']]) {
    const at = html.indexOf('id="' + id + '"');
    assert.ok(at > 0, `${id} needs a row in the 调音台 panel`);
    const tag = html.slice(at, html.indexOf('>', at));
    assert.ok(tag.includes(`min="${min}"`) && tag.includes(`max="${max}"`), `${id} must run ${min}..${max}`);
    assert.ok(html.includes(`setMixerTuning('${key}', this.value)`), `${id} must write ${key}`);
  }
  const consoleSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  assert.ok(consoleSrc.includes("fxConsoleItem('fx-mixergapGlow'") && consoleSrc.includes("fxConsoleItem('fx-mixergapFog'"),
    'both knobs must be listed in the console 调音台 group');
}

console.log('OK mixer gap fog: silent at 0, hugs the seam, gated by the reference wave, width moves only the halo');
