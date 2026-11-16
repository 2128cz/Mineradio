'use strict';

// 预设 17「调音台」的缝隙圣光（这次是雾光柱，不是贴在台面上的遮罩）。
//
// 台面被一道共享的行进 sine 抬起（cellWave：振幅 × sin(波长 × (x+y) + 相位)，相位来自跟着歌曲 BPM
// 走的波时钟），相邻格子一高一低时缝隙才真的错台露出。
// 光长在那道缝上，而且只长在低的那一侧：高板把光压在缝里，低板才接得住漫出来的光柱——所以门控读的是
// 带符号的高度差（邻格减本格），齐平或本格更高时这一侧就是黑的。雾以格线为中心（宽度归 gapFog 管），
// 高度上从本格自己的台面（抬起后的那一个面）往上按 1/1.4 单位衰减，沿视线累积进 march.seam，
// 命中面即停止累积——所以前面的板子会挡住后面的缝，这是表面遮罩做不到的。
// 这里把这套算式独立抄写成 oracle，量四件事：旋钮归零逐位不变；光是有体积的（沿缝走比横穿缝累积得多、
// 被前面的面挡住就没了、亮的只有低的那一侧）；门控跟着同一道波浪走（整片台一个 2π 周期，半个周期后
// 所有高差反号——同一条缝的光要换到另一块板上，而不是原地变暗）；雾宽只加宽外圈、不动那条峰。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '22-mixer-desk-preset.js'), 'utf8');

// ---------------------------------------------------------------- the oracle

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// cellWave(): one shared sine, lifted by the amplitude and carried by the wave clock. `ph` below is
// that clock's phase in radians, not a time: the JS side turns the song's tempo into it.
const WAVE_AMP = 0.4;
const WAVE_K = (Math.PI * 2) / 12;
function bob(c, ph) {
  return WAVE_AMP * Math.sin(WAVE_K * (c[0] + c[1]) + ph);
}

// seamGates(): a cell's four sides, each open only where that neighbour rides ABOVE this plate.
// Signed on purpose: the light spills onto the lower plate, so the high side of a step stays dark.
function gates(cell, size, t, drv) {
  const w0 = bob(cell, t);
  const side = (nc) => smoothstep(0.02, 0.35, bob(nc, t) - w0);
  const level = 0.35 + 0.65 * drv;
  return [
    side([cell[0] + size[0], cell[1], cell[2]]),
    side([cell[0], cell[1] + size[1], cell[2]]),
    side([cell[0] - size[0], cell[1], cell[2]]),
    side([cell[0], cell[1] - size[1], cell[2]]),
  ].map((v) => v * level);
}

// seamDensity(): how much fog there is at a point, per axis. hs - |q| is the distance to the cell
// border, which is where the reference's .02 inset leaves the slot. The halo is a fraction of the
// panel so gridScale does not change the look; the bright line on the border is a fixed world width,
// because the slot the reference cuts is a fixed world width too. Height is measured from this
// plate's own lifted top (-bob), not from the mean plane, or a plate that rides high would be lit
// inside itself.
function densityAt(p, cell, size, fog, t) {
  const q = [p[0] - cell[0], p[1] - cell[1], p[2] - cell[2]];
  const hs = [size[0] * 0.5, size[1] * 0.5];
  const d = [Math.abs(hs[0] - Math.abs(q[0])), Math.abs(hs[1] - Math.abs(q[1]))];
  const w = Math.max(0.005, fog) * Math.min(hs[0], hs[1]) * 0.5;
  const col = Math.exp(-Math.max(q[2] + bob(cell, t), 0) * 1.4);
  return d.map((v) => (Math.exp(-(v * v) / (2 * w * w)) + 0.5 * Math.exp(-v * 50)) * col);
}

// The march's accumulator, transcribed: the shader takes four samples per march segment, which is the
// integral itself once the segments are short, so this reads it at high resolution instead. Each
// sample is weighed by the run length and by how far down the ray that segment already is. The ray
// range is explicit because a panel that stops the march stops the accumulation. The gates come in as
// a vector so a test can hold one side of the seam open on its own.
function accumulate(ro, dir, t0, t1, cell, size, g, fog, t) {
  const N = 2000;
  let seam = 0;
  let rl0 = t0;
  for (let i = 1; i <= N; i++) {
    const rl = t0 + ((t1 - t0) * i) / N;
    const p = [ro[0] + dir[0] * rl, ro[1] + dir[1] * rl, ro[2] + dir[2] * rl];
    const sd = densityAt(p, cell, size, fog, t);
    const sg = [Math.sign(p[0] - cell[0]), Math.sign(p[1] - cell[1])];
    const dens = sd[0] * (sg[0] > 0 ? g[0] : g[2]) + sd[1] * (sg[1] > 0 ? g[1] : g[3]);
    seam += dens * (rl - rl0) * Math.exp(-rl0 * 0.04);
    rl0 = rl;
  }
  return seam;
}

const SIZE = [2, 2, 100];
const T = 7.3;
const HS = SIZE[0] / 2;
const DEF = { glow: 1, fog: 0.22, drv: 0.5 };
const opts = (over) => Object.assign({}, DEF, over || {});
const EYE = [0, 0, -1];

// An eye ray the way the ported orthographic camera runs it: straight in from 10 units above the
// panel top. `stop` is how far the march gets to fly before something is hit and it breaks.
function eyeSeam(cell, t, o, over) {
  const p = Object.assign({ dx: HS, dy: 0, stop: 10, g: null }, over || {});
  const ro = [cell[0] + p.dx, cell[1] + p.dy, cell[2] + 10];
  return accumulate(ro, EYE, 0, p.stop, cell, SIZE, p.g || gates(cell, SIZE, t, o.drv), o.fog, t);
}

// The one line mainImage adds. The .4 is the fog's own emissivity: without it a fully open seam at
// the default knob lands at 0.74 of white and the crevice reads as a painted rim rather than a haze.
const emit = (seam, glow) => 1 - Math.exp(-seam * glow * 0.4);

// A cell with a genuinely staggered +x seam, so the shape tests have light to measure. The wave is
// diagonal and shared, so a cell's x and y steps are the same number: the search only has to put a
// plate on the steep part of the ridge.
function findOpenCell() {
  for (let k = 0; k < 900; k++) {
    const cell = [1 + 2 * k, 3 + 2 * (k % 17), 50];
    if (gates(cell, SIZE, T, 1)[0] > 0.95) return cell;
  }
  throw new Error('no staggered seam found; the wave would never open');
}
const OPEN = findOpenCell();
const atOpen = (o, over) => eyeSeam(OPEN, T, opts(o), over);

// The phase that puts one plate's +x gate inside its ramp. The plates sit on a 2-unit lattice, so at
// any one phase the gate can only take a discrete set of values; sweeping the phase is what fills the
// ramp in, and the level and period tests need a seam that moves instead of sitting saturated.
const MID = [5, 3, 50];
const MID_PHASE = (function () {
  for (let i = 0; i < 1440; i++) {
    const ph = (i * Math.PI) / 720;
    const g = gates(MID, SIZE, ph, 1)[0];
    if (g > 0.3 && g < 0.7) return ph;
  }
  throw new Error('no half-open seam found; the gate ramp would be unreadable');
})();
const atMid = (ph, o, over) => eyeSeam(MID, ph, opts(o), over);

// ---------------------------------------------------------------- 1) the knob at zero is nothing

{
  assert.equal(emit(atOpen({}), 0), 0, 'gapGlow=0 must contribute exactly nothing, pixel for pixel');
  assert.ok(atOpen({}) > 0, 'the column still accumulates with the knob down; only the output is gated');
  // A flush seam contributes nothing at any knob value, which is what makes the knob safe to leave on.
  const flush = gates(OPEN, SIZE, T, 1).map(() => 0);
  assert.equal(atOpen({ drv: 1 }, { g: flush }), 0, 'a field with no stagger has no light in it');
}

// ---------------------------------------------------------------- 2) the light has a body

{
  // 2a) It sits in the air above the panel, which a decal cannot.
  const low = densityAt([OPEN[0] + HS, OPEN[1], OPEN[2] + 0.2], OPEN, SIZE, 0.22, T)[0];
  const mid = densityAt([OPEN[0] + HS, OPEN[1], OPEN[2] + 1.9], OPEN, SIZE, 0.22, T)[0];
  const high = densityAt([OPEN[0] + HS, OPEN[1], OPEN[2] + 6], OPEN, SIZE, 0.22, T)[0];
  assert.ok(low > 1, `fog has to be thick right at the panel top (${low.toFixed(2)})`);
  assert.ok(mid > 0 && mid < low * 0.4, `the column thins as it rises (${low.toFixed(2)} -> ${mid.toFixed(2)})`);
  assert.ok(high < low * 0.001, `and is gone a few units up; the desk does not turn into a bank of mist (${high.toExponential(1)})`);

  // 2b) A ray that runs ALONG the column gathers more than one that cuts ACROSS it. That asymmetry is
  // the difference between a body of fog and a line drawn on a surface.
  const along = atOpen({ drv: 1 });
  const across = accumulate([OPEN[0] + HS - 0.45, OPEN[1], OPEN[2] + 0.02], [1, 0, 0], 0, 0.44,
    OPEN, SIZE, gates(OPEN, SIZE, T, 1), 0.22, T);
  assert.ok(along > across * 2, `down the seam has to beat crossing it (along ${along.toFixed(3)} vs across ${across.toFixed(3)})`);

  // 2c) Occlusion: the accumulation stops where the ray stops, so a panel in front of a seam hides it.
  // Losing the last 2 units of the flight loses almost the whole column.
  const full = atOpen({ drv: 1 });
  const blocked = atOpen({ drv: 1 }, { stop: 8 });
  assert.ok(blocked < full * 0.1, `a nearer panel has to hide the seam behind it (${blocked.toFixed(3)} of ${full.toFixed(3)})`);

  // 2d) The default has to land in the visible band, and the knob has to stay bounded.
  const lit = emit(along, DEF.glow);
  assert.ok(lit > 0.1 && lit < 0.95, `the default glow has to read on the desk (${lit.toFixed(3)})`);
  let prior = -1;
  for (const glow of [0.2, 0.7, 1, 2, 50]) {
    const v = emit(along, glow);
    assert.ok(v >= prior && v <= 1, 'the seam light only ever rises towards full white, whatever the knob says');
    prior = v;
  }
  assert.ok(emit(along, 2) < 0.95, `even at the top of the knob a loud seam keeps some headroom (${emit(along, 2).toFixed(3)})`);
}

// ---------------------------------------------------------------- 3) only the lower plate of a step is lit

{
  // The light spills out of the crevice onto whichever plate sits below it, so a border is open for
  // exactly one of its two cells. That is the property that separates this from the bevel highlight it
  // replaced: a symmetric gate lights both edges the same and the eye reads a drawn line.
  let lowHere = 0, lowThere = 0;
  for (let k = 0; k < 600; k++) {
    const cell = [1 + 2 * k, 3 + 2 * (k % 17), 50];
    const nb = [cell[0] + SIZE[0], cell[1], cell[2]];
    const here = gates(cell, SIZE, T, 1)[0];
    const there = gates(nb, SIZE, T, 1)[2];
    assert.ok(here === 0 || there === 0, 'a seam may only light from the side that sits below it');
    const dh = bob(nb, T) - bob(cell, T);
    if (Math.abs(dh) < 0.35) continue;
    if (dh > 0) {
      assert.ok(here > 0.9 && there === 0, 'the lower cell has to hold the whole column');
      lowHere++;
    } else {
      assert.ok(there > 0.9 && here === 0, 'and the neighbour has to hold it when it is the lower one');
      lowThere++;
    }
  }
  assert.ok(lowHere > 3 && lowThere > 3, `both plates have to get their turn below (here ${lowHere}, there ${lowThere})`);

  // The ray has to agree with the gate: a seam held open on one side puts light only on that side.
  const g = gates(OPEN, SIZE, T, 1);
  const plus = eyeSeam(OPEN, T, opts({ drv: 1 }), { dx: HS, g: [g[0], 0, 0, 0] });
  const minus = eyeSeam(OPEN, T, opts({ drv: 1 }), { dx: -HS, g: [0, 0, g[2], 0] });
  assert.ok(plus > 0.1, 'the open side has to shine');
  assert.equal(minus, 0, 'and the side whose neighbour sits lower stays dark');
}

// ---------------------------------------------------------------- 4) the gate is the reference's own wave

{
  const at = (ph) => atMid(ph, { drv: 0 });
  const a = at(MID_PHASE);
  assert.ok(a > 0, 'the sample seam has to be lit at all');
  // The wave is one sine, so the whole field repeats every 2*PI of its clock, and half a period
  // inverts every height at once.
  const full = at(MID_PHASE + Math.PI * 2);
  assert.ok(Math.abs(full - a) < a * 1e-9, `the field has to repeat on the wave's own period (${a.toFixed(6)} vs ${full.toFixed(6)})`);
  const moved = at(MID_PHASE + Math.PI / 3);
  assert.ok(Math.abs(moved - a) > a * 0.05, `a sixth of that has to move the ridge, or nothing is driving it (${a.toFixed(6)} vs ${moved.toFixed(6)})`);

  // Half a period on, every height has flipped sign, so every step has too. For a signed gate that
  // means the light crosses onto the other plate instead of fading and returning - which is the
  // observable difference from the symmetric gate this replaced.
  let across = 0;
  for (let k = 0; k < 400; k++) {
    const cell = [1 + 2 * k, 3 + 2 * (k % 13), 50];
    const nb = [cell[0] + SIZE[0], cell[1], cell[2]];
    const here = gates(cell, SIZE, T, 1)[0];
    const flips = gates(cell, SIZE, T + Math.PI, 1)[0];
    assert.ok(Math.abs(flips - gates(nb, SIZE, T, 1)[2]) < 1e-12, "half a period on, a border's light has to sit on the other plate");
    if (here > 0.5 && flips === 0) across++;
  }
  assert.ok(across > 3, `the wave has to hand seams over to the other side (${across} moved)`);

  // And the ridge travels: the cells sit on a lattice, so a moving wave cannot change how many seams
  // are open, only which ones - a pattern sliding across the desk rather than a field of lamps fading
  // up and down in place.
  const openSet = (ph) => {
    const out = [];
    for (let k = 0; k < 300; k++) {
      const c = [1 + 2 * k, 3 + 2 * (k % 7), 50];
      if (smoothstep(0.02, 0.35, bob([c[0] + 2, c[1], c[2]], ph) - bob(c, ph)) > 0.5) out.push(k);
    }
    return out;
  };
  const setA = openSet(T), setB = openSet(T + 0.7);
  assert.ok(setA.length > 60 && setA.length < 240, `lit sides have to be a share of the field, not all of it (open ${setA.length}/300)`);
  const kept = setA.filter((k) => setB.indexOf(k) >= 0).length;
  assert.ok(kept < setA.length * 0.9, `the ridge has to carry the glow to other seams as it travels (${kept}/${setA.length} stayed lit)`);
}

// ---------------------------------------------------------------- 5) fog width moves the halo, not the peak

{
  const peak = (fog) => densityAt([OPEN[0] + HS, OPEN[1], OPEN[2]], OPEN, SIZE, fog, T)[0];
  for (const fog of [0.03, 0.22, 0.6]) {
    assert.ok(Math.abs(peak(fog) - peak(0.22)) < 1e-12, 'the bright line on the border is not the fog and must stay put');
  }
  const far = (fog) => densityAt([OPEN[0] + HS - 0.3, OPEN[1], OPEN[2]], OPEN, SIZE, fog, T)[0];
  assert.ok(far(0.6) > far(0.03) * 5, `a wider fog knob has to spread the halo (${far(0.03).toExponential(1)} -> ${far(0.6).toExponential(1)})`);

  // The column still leaves the panel middle dark next to the seam, at any width the knob allows.
  const centre = densityAt([OPEN[0] + 0.4, OPEN[1] + 0.4, OPEN[2]], OPEN, SIZE, 0.6, T);
  assert.ok(centre[0] < peak(0.6) * 0.15 && centre[1] < peak(0.6) * 0.15, `even the widest fog has to fall off across the panel (${(centre[0] / peak(0.6)).toFixed(3)} of the seam)`);

  // Width is a shape control, not a gain: read a little way in from the seam and the wider setting
  // reaches further, while the seam itself keeps its peak either way.
  const inset = { dx: HS - 0.15 };
  const wideSeam = atOpen({ fog: 0.6, drv: 1 }, inset), thinSeam = atOpen({ fog: 0.03, drv: 1 }, inset);
  assert.ok(wideSeam > thinSeam * 3, `the wider setting spreads the light (${thinSeam.toFixed(3)} -> ${wideSeam.toFixed(3)})`);
  assert.ok(atOpen({ fog: 0.6, drv: 1 }) > wideSeam && atOpen({ fog: 0.03, drv: 1 }) > thinSeam,
    'and the line on the seam stays the brightest part of it');
}

// ---------------------------------------------------------------- 6) the level drives the pulse

{
  const silence = atOpen({ drv: 0 }), loud = atOpen({ drv: 1 });
  assert.ok(Math.abs(loud / silence - 1 / 0.35) < 1e-9, 'full level has to triple the seam against silence');
  assert.ok(silence > 0, 'silence keeps a floor of light, so the columns never blink out entirely');
  let prev = -1;
  for (const drv of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const v = atOpen({ drv });
    assert.ok(v > prev, 'the glow has to rise with the level');
    prev = v;
  }
}

// ---------------------------------------------------------------- 7) the wiring

{
  assert.ok(/"uniform float uGapGlow;"/.test(src) && /"uniform float uGapFog;"/.test(src),
    'the ported body has to declare both fog uniforms');
  assert.ok(/gapGlow:\s*\{\s*def:\s*1,\s*min:\s*0,\s*max:\s*2/.test(src), 'gapGlow runs 0..2 and defaults on');
  assert.ok(/gapFog:\s*\{\s*def:\s*0\.22,\s*min:\s*0\.03,\s*max:\s*0\.6/.test(src), 'gapFog runs 0.03..0.6');
  assert.ok(/u\.uGapGlow\.value\s*=\s*Math\.max\(0,\s*mixerParam\('gapGlow'\)\)/.test(src), 'gapGlow has to reach the shader');
  assert.ok(/u\.uGapFog\.value\s*=\s*Math\.max\(0\.03,\s*mixerParam\('gapFog'\)\)/.test(src), 'gapFog has to reach the shader');

  // The gate reads the same wave that lifts the plate - one shared sine in the ported body, whose
  // amplitude and phase are uniforms (the wave's own clock is the BPM-driven phase, not iTime).
  assert.ok(/float cellWave\(vec3 c\)\{[\s\S]{0,80}uWaveAmp\*sin\(uWaveK\*\(c\.x\+c\.y\)\+uWavePhase\)/.test(src),
    'cellWave has to be the one shared sine, scaled by the amplitude and carried by the phase');
  assert.equal(src.indexOf('2.*iTime+1.*fract(h.z*28.)'), -1, "the per-cell random phase would break the wave's coherence");
  assert.ok(/p\.z\+=cellWave\(grid\.c\);/.test(src), 'map() has to lift each plate with that same wave');
  assert.ok(src.indexOf('float cellWave(vec3 c)') < src.indexOf('vec4 map(vec3 p,Grid grid)'),
    'cellWave has to be declared above map(), which calls it');

  // Signed, both of them: the gate must ask which side is higher, and the column must grow out of the
  // plate it lands on rather than out of the mean plane, or a lifted panel lights inside itself.
  assert.ok(/cellWave\(px\)-w0,/.test(src), 'the gate has to be a signed height difference');
  assert.equal(src.indexOf('abs(w0-cellWave('), -1, 'the symmetric gate is what made this read as a bevel');
  assert.ok(/exp\(-max\(q\.z\+top,0\.\)\*1\.4\)/.test(src), 'the column has to decay from the lifted top of its own plate');
  assert.ok(/float top=cellWave\(grid\.c\);/.test(src), 'and the march has to hand that height to the density');

  // The volume has to be carried out of the march, and only out of the eye ray.
  assert.ok(/"  float seam;"/.test(src), 'the march result has to have a slot for the accumulated column');
  assert.ok(/r\.seam=seam;/.test(src), 'and hand it back');
  assert.ok(/float dens=sd\.x\*\(sg\.x>\.0\?gates\.x:gates\.z\)\+sd\.y\*\(sg\.y>\.0\?gates\.y:gates\.w\);/.test(src),
    'each side of the cell has to light from its own neighbour');
  assert.ok(/float seg=\(rl-rl0\)\*\.25;/.test(src) && /seam\+=dens\*seg\*exp\(-rl0\*\.04\);/.test(src),
    'each march segment has to be integrated, not sampled once at its end');
  assert.equal((src.match(/domarch\(march\.rp,l,int\(uShadowSteps\),0\)/g) || []).length, 2,
    'both shadow rays have to skip the volume, or every lit panel reads as glow');
  assert.ok(/domarch\(ro,rd,int\(uSteps\),1\)/.test(src), 'the eye ray is the one that gathers the column');

  // Emissive, after the two lights, before the gamma line.
  const addAt = src.indexOf('col+=(1.-exp(-march.seam*uGapGlow*.4))');
  const lightAt = src.lastIndexOf('col+=shadow*dotnl*(diff+spec);');
  const gammaAt = src.indexOf('col=pow(col,vec3(.4545))');
  assert.ok(addAt > lightAt && addAt < gammaAt, 'the seam light has to be emissive, added after the lighting');

  // The decal it replaced must stay gone.
  for (const gone of ['float gap=0.;', 'vec2 gp=(march.rp-march.grid.c).xy;', 'exp(-ge*24.)', 'col+=gap*vec3(']) {
    assert.equal(src.indexOf(gone), -1, `"${gone}" was the surface mask; it must not come back`);
  }

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

const shown = emit(atOpen({}), DEF.glow);
console.log(`OK mixer seam volume: silent at 0 and when flush, runs along the seam, hidden by a nearer panel, lit on the lower plate only, handed from side to side by the wave, width moves only the halo; default reads ${shown.toFixed(2)}`);
