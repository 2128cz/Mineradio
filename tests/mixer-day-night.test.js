'use strict';

// 预设 17「调音台」的昼夜与随机配色。
//
// 参考着色器把反色元件的比例写死在 step(fract(grid.h.z*66.),.1)：约 10% 的面板格子反着上色
// （白底黑字变黑底白字）。现在这件事拆成两个旋钮：
//   昼夜模式 uNightMix —— 反色格子的**比例**，0 就是一格都不反（整墙白天），1 就是全反（整墙黑夜）；
//   随机配色 uInvShare —— 每个格子自己的随机偏移量，决定这条边界有多"毛"，由用户决定。
// 两者都只决定 flip，flip 只把面板色与刻字色对调，所以每一格永远是高对比的一对，中间档不会糊成灰。
// 判据不查源码形状：把 pcg3d 哈希和这条 step 独立抄写成 oracle，实测每个格子的归属。

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

// float jit=(h.x*2.-1.)*uInvShare;  float flip=step(fract(h.z*66.), uNightMix+jit);
// GLSL step(edge,x) is 1 when x >= edge, so the cell inverts when its draw lands at or below the threshold.
function draws(cell) {
  const h = pcg3df(cell);
  const scaled = f32(h[2] * 66);
  return { a: scaled - Math.floor(scaled), j: h[0] };
}

function flipFor(cell, nightMix, invShare) {
  const { a, j } = draws(cell);
  return a <= f32(nightMix + (j * 2 - 1) * invShare) ? 1 : 0;
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

function flippedShare(cells, nightMix, invShare) {
  let n = 0;
  for (const c of cells) n += flipFor(c, nightMix, invShare);
  return n / cells.length;
}

const CELLS = cellsInField(4000, 1);

// The two tones the desk swaps between. These are the reference's own literals, which the shader
// keeps as the uThemeMix=0 end — the greyscale the port falls back to.
const PLATE_L = Number(src.match(/vec3 c=([.\d]+)\+\.0\*sin/)[1]);
const INK_L = Number(src.match(/vec3 inkT=mix\(\s*vec3\(\s*([.\d]+)\s*\)/)[1]);

// The black/white step the reference draws at half drive, which every cell keeps whichever way it is flipped.
const STEP = (PLATE_L - INK_L) * f32(0.75 + 0.5 * 0.5);

// ---------------------------------------------------------------- 1) the hash is a hash

{
  const fracs = CELLS.map((c) => draws(c).a);
  assert.ok(fracs.every((v) => v >= 0 && v < 1), 'fract() has to stay inside [0,1)');
  const mean = fracs.reduce((a, b) => a + b, 0) / fracs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `the module hash has to spread evenly across cells (mean ${mean.toFixed(4)})`);
  const distinct = new Set(fracs.map((v) => v.toFixed(9))).size;
  assert.ok(distinct > fracs.length * 0.99, 'each cell needs its own draw, not a repeating pattern');
  // h.x feeds the jitter and h.z the share; they must not be the same number.
  const h = pcg3df(CELLS[0]);
  assert.notEqual(h[0], h[2], 'the jitter and the share have to read different hash lanes');
}

// ---------------------------------------------------------------- 2) 昼夜 sweeps the whole desk

{
  // The endpoints are what the knob is for: 0 leaves no inverted cell, 1 inverts every one.
  assert.equal(flippedShare(CELLS, 0, 0), 0, '昼夜 0% 必须一格都不反，整墙就是白天的配色');
  assert.ok(flippedShare(CELLS, 1, 0) > 0.995, '昼夜 100% 必须把每一格都反过来');
  // The reference's own density stays reachable at 0.1 with no randomness.
  const ref = flippedShare(CELLS, 0.1, 0);
  assert.ok(Math.abs(ref - 0.1) < 0.02, `昼夜 0.1 就是参考写死的那 10%（实测 ${(ref * 100).toFixed(1)}%）`);

  const measured = [];
  for (const m of [0, 0.25, 0.5, 0.75, 1]) {
    const got = flippedShare(CELLS, m, 0);
    assert.ok(Math.abs(got - m) < 0.03,
      `昼夜 ${m} 要反 ${Math.round(m * 100)}% 的格子，实测 ${Math.round(got * 100)}%`);
    measured.push(got);
  }
  for (let i = 1; i < measured.length; i++) {
    assert.ok(measured[i] > measured[i - 1], '反色格子的数量要随旋钮单调增长');
  }
}

// ---------------------------------------------------------------- 3) 随机配色只毛化边界

{
  // The jitter is symmetric, so the share is unchanged; what changes is which cells sit on the
  // far side of the boundary — and only those close enough to it to be coin-flipped.
  for (const share of [0.2, 0.5]) {
    const crisp = flippedShare(CELLS, share, 0);
    for (const invShare of [0.1, 0.4]) {
      const jittered = flippedShare(CELLS, share, invShare);
      assert.ok(Math.abs(jittered - crisp) < 0.04,
        `随机 ${invShare} 不该改变整体比例（${(crisp * 100).toFixed(1)}% → ${(jittered * 100).toFixed(1)}%）`);
    }
    // A cell further from the boundary than the whole jitter band cannot change its mind,
    // and a cell inside it must be able to — otherwise the knob is decoration.
    let farChanged = 0, inside = 0, insideChanged = 0;
    for (const c of CELLS) {
      const { a } = draws(c);
      const before = flipFor(c, share, 0);
      const after = flipFor(c, share, 0.4);
      if (Math.abs(a - share) > 0.4) { if (before !== after) farChanged++; }
      else { inside++; if (before !== after) insideChanged++; }
    }
    assert.equal(farChanged, 0, '离边界比整个抖动带还远的格子一格都不许变');
    assert.ok(inside > CELLS.length * 0.3, `随机 0.4 要在边界两侧留出足够宽的毛边（只有 ${(inside / CELLS.length * 100).toFixed(0)}%）`);
    // A uniformly-drawn jitter covers half the band, so the expected reshuffle rate is (0.4-|d|)/0.8
    // averaged over |d| in [0,0.4] = 25%; anything much below that means the knob barely reaches.
    assert.ok(insideChanged > inside * 0.15,
      `毛边里的格子要真的被随机重排，而不是仍然按边界一刀切（只动了 ${(insideChanged / inside * 100).toFixed(0)}%）`);
  }
}

// ---------------------------------------------------------------- 4) 归属不随镜头漂移

{
  // The camera pans (co.xy += iTime*uCamPan), so the same cell is entered from many origins.
  // Both draws come from the world cell centre, so neither decision may move.
  for (const [nightMix, invShare] of [[0, 0], [0.5, 0.4], [1, 1]]) {
    for (const c of CELLS.slice(0, 400)) {
      const base = flipFor(c, nightMix, invShare);
      for (const [dx, dy] of [[0, 0], [0.9, 0.4], [-0.85, -0.2], [0.1, 0.99]]) {
        const again = flipFor(cellCentre([c[0] + dx, c[1] + dy, 1.0], 1), nightMix, invShare);
        assert.equal(again, base, '镜头走带时格子不许换配色');
      }
    }
  }
  // gridScale rescales the field but keeps the share, which is what makes 昼夜 a mode and not a zoom.
  for (const scale of [0.5, 1, 2.4]) {
    const got = flippedShare(cellsInField(1500, scale), 0.6, 0);
    assert.ok(Math.abs(got - 0.6) < 0.04, `反色比例要扛得住 gridScale ${scale}（实测 ${got.toFixed(3)}）`);
  }
}

// ---------------------------------------------------------------- 5) flip 只是对调，对比度不塌

{
  // basecol=mix(ink,plate,mtlp) with plate=mix(dayT,inkT,flip), ink=mix(inkT,dayT,flip).
  // A flip therefore trades the two tones; the step between them is |dayT-inkT| either way, so no
  // knob value can put the desk in the low-contrast middle a plain cross-fade would pass through.
  const gain = f32(0.75 + 0.5 * 0.5);
  for (const flip of [0, 1]) {
    const plate = (flip ? INK_L : PLATE_L) * gain;
    const ink = (flip ? PLATE_L : INK_L) * gain;
    assert.ok(Math.abs(Math.abs(plate - ink) - STEP) < 1e-6, '一格面板与刻字的差在任何归属下都一模一样');
    assert.ok(Math.max(plate, ink) > 0.5 && Math.min(plate, ink) < 0.15, '总有一边是亮面、另一边是暗面');
    assert.equal(plate > ink, flip === 0, '反色就是把亮的那一边换到刻字上');
  }
  assert.ok(STEP > 0.4, `黑白差要留得住（实测 ${STEP.toFixed(3)}）`);
  // 白天整墙亮面，黑夜整墙暗面 — measured, not asserted from the literals.
  const brightShare = (nightMix, invShare) => CELLS.filter((c) => flipFor(c, nightMix, invShare) === 0).length / CELLS.length;
  assert.ok(brightShare(0, 0) > 0.995, '昼夜 0% 时整墙都是白天的亮面板');
  assert.ok(brightShare(1, 0) < 0.005, '昼夜 100% 时整墙都是黑夜的暗面板');
}

// ---------------------------------------------------------------- 6) the wiring

{
  for (const [key, def] of [['nightMix', 0], ['invShare', 0]]) {
    const schema = src.match(new RegExp(key + ':\\s*\\{\\s*def:\\s*([\\d.]+),\\s*min:\\s*([\\d.]+),\\s*max:\\s*([\\d.]+)'));
    assert.ok(schema, `the desk needs a ${key} knob`);
    assert.deepEqual([Number(schema[1]), Number(schema[2]), Number(schema[3])], [def, 0, 1],
      `${key} runs 0..1 and defaults to ${def}, so the desk is one clean scheme until asked`);
    assert.ok(new RegExp(`"uniform float u${key[0].toUpperCase()}${key.slice(1)};"`).test(src),
      `the ported body has to declare u${key}`);
    assert.ok(new RegExp(`u${key[0].toUpperCase()}${key.slice(1)}:\\s*\\{\\s*value:\\s*0\\s*\\}`).test(src),
      `the material needs u${key} in its initial block`);
    assert.ok(new RegExp(`u\\.u${key[0].toUpperCase()}${key.slice(1)}\\.value\\s*=\\s*mixerClamp01\\(mixerParam\\('${key}'\\)\\)`).test(src),
      `the ${key} knob has to reach the shader clamped to 0..1`);
  }

  // The old knob did double duty; the reference literal may not stay behind next to either.
  assert.ok(!/float invThr=mix\(\.1,\.9,uNightMix\);/.test(src),
    'uNightMix may not still be scaled to a 10%..90% band, or 0 would not mean day and 1 would not mean night');
  assert.ok(!/mtlp=mix\(mtlp,1\.-mtlp,/.test(src),
    'the polarity flip has to live in the two tones trading places, not in rewriting mtlp');
  assert.ok(/float flip=step\(fract\(march\.grid\.h\.z\*66\.\),uNightMix\+jit\);/.test(src),
    'the share has to be drawn per cell from that threshold');
  assert.ok(/vec3 plate=mix\(dayT,inkT,flip\);/.test(src) && /vec3 ink=mix\(inkT,dayT,flip\);/.test(src),
    'a flip has to trade the plate and the engraving tone, nothing else');

  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const consoleSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  for (const key of ['nightMix', 'invShare']) {
    const at = html.indexOf('id="fx-mixer' + key + '"');
    assert.ok(at > 0, `the ${key} knob needs a row in the 调音台 panel`);
    const inputTag = html.slice(at, html.indexOf('>', at));
    assert.ok(inputTag.includes('min="0"') && inputTag.includes('max="1"'), `the ${key} slider must run 0..1`);
    assert.ok(html.includes(`setMixerTuning('${key}', this.value)`), `the ${key} slider must write the knob`);
    assert.ok(consoleSrc.includes(`fxConsoleItem('fx-mixer${key}'`), `the ${key} knob must be listed in the console 调音台 group`);
  }
}

console.log(`OK mixer day/night: 昼夜 0→100% 反色（参考的 10% 在 0.1）, 随机配色只毛化边界, 黑白差 ${STEP.toFixed(2)} 不塌`);
