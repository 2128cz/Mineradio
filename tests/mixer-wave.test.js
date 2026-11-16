'use strict';

// 预设 17「调音台」的台面波浪：一道共享的行进 sine，速度跟着歌的 BPM 走。
//
// 参考给每个格子一个随机相位（.4*sin(2*iTime+hash+...))，所以那不是一道波，是一片各自起伏的凸起。
// 现在整片台共用一道波：cellWave = 振幅 * sin(k*(x+y) + 相位)，波从世界原点 (0,0) 沿 x+y 滚进来。
// 相位不来自 iTime，而是 JS 里的波时钟：一个节拍恰好过一个波峰（角速度 2π/拍长），所以快歌的浪更急，
// 而波距由「波浪频率」旋钮管；鼓点到来时相位被就地改写回原点上的波峰，并把角速度乘上一个短促的倍数，
// 那一瞬浪是「冲」出去的，而不是匀速漂移。这里把 JS 的波时钟与着色器里的那道 sine 分开量：
// 同一条波前上的板子齐平、波峰确实朝 +x+y 走且一拍拍走一个波距、鼓点落在原点波峰上、暂停即冻结、
// 三个旋钮分别只动振幅/波长/相位。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '22-mixer-desk-preset.js'), 'utf8');

// ---------------------------------------------------------------- the harness

function fn(name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, `${name} has to live in the preset module`);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  throw new Error(`${name} is not brace-balanced`);
}

function constant(name) {
  const m = src.match(new RegExp('var ' + name + '\\s*=\\s*([^;]+);'));
  assert.ok(m, `var ${name} has to exist`);
  return Number(new Function('return (' + m[1] + ');')());
}

const BASE_UNITS = constant('MIXER_WAVE_BASE_UNITS');
const KICK_BOOST = constant('MIXER_WAVE_KICK_BOOST');
const KICK_TAIL = constant('MIXER_WAVE_KICK_TAIL');
const FALLBACK_STEP = constant('MIXER_WAVE_FALLBACK_STEP');
const CREST = constant('MIXER_WAVE_CREST');

const wave = new Function(
  'MIXER_WAVE_KICK_BOOST', 'MIXER_WAVE_KICK_TAIL', 'MIXER_WAVE_FALLBACK_STEP', 'MIXER_WAVE_CREST',
  [
    fn('mixerWrapAngle'), fn('mixerWaveStep'), fn('mixerStepWave'),
    'return { wrap: mixerWrapAngle, step: mixerWaveStep, frame: mixerStepWave };'
  ].join('\n')
)(KICK_BOOST, KICK_TAIL, FALLBACK_STEP, CREST);

const DT = 1 / 60;
const fresh = () => ({ phase: CREST, kick: 0, beatStep: 0, prevBeat: 0 });
const angleDiff = (a, b) => {
  const d = Math.abs(wave.wrap(a) - wave.wrap(b));
  return Math.min(d, Math.PI * 2 - d);
};

// The shader's plate lift, transcribed. `k` comes from the 频率 knob, the phase from the clock.
const lift = (c, phase, amp, k) => amp * Math.sin(k * (c[0] + c[1]) + phase);

// ---------------------------------------------------------------- 1) one wave, not a field of bumps

{
  // Every plate on a wavefront - same x+y, however far apart - rides at exactly the same height. The
  // random per-cell phase the port started from would break this by construction.
  const ph = 0.9, amp = 0.4, k = 1;
  for (const [x, y] of [[0, 0], [2, -2], [-6, 6], [10, -10], [12, -12]]) {
    assert.ok(Math.abs(lift([x, y, 50], ph, amp, k) - lift([0, 0, 50], ph, amp, k)) < 1e-12,
      'plates on the same wavefront have to ride at the same height');
  }
  // One step down the wave is one step of the sine, in both axes and symmetrically.
  const a = lift([2, 0, 50], ph, amp, k) - lift([0, 0, 50], ph, amp, k);
  const b = lift([0, 2, 50], ph, amp, k) - lift([0, 0, 50], ph, amp, k);
  assert.ok(Math.abs(a - b) < 1e-12, 'the wave is diagonal, so an x step and a y step lift a plate the same');
  assert.ok(Math.abs(lift([0, 0, 50], ph, 0, k)) < 1e-12, 'amplitude 0 has to be a flat desk');
}

// ---------------------------------------------------------------- 2) the tempo sets the speed

{
  // One crest per beat: the clock turns one full turn per beat period, whatever the song. Stepped
  // with a fixed frame, so the expected phase is exact rather than approximately half a turn.
  for (const step of [0.4, 0.5, 0.75, 1.2]) {
    const w = fresh();
    const frames = 37;
    for (let i = 0; i < frames; i++) wave.step(w, DT, { step: step });
    const expected = CREST - (Math.PI * 2) * (frames * DT) / step;
    assert.ok(angleDiff(w.phase, expected) < 1e-9,
      `the clock has to turn at 2*PI per beat (step ${step}s, phase ${w.phase.toFixed(5)} vs ${wave.wrap(expected).toFixed(5)})`);
  }
  const slow = fresh(), fast = fresh();
  wave.step(slow, 0.1, { step: 1.2 });
  wave.step(fast, 0.1, { step: 0.4 });
  const slowTurn = angleDiff(slow.phase, CREST), fastTurn = angleDiff(fast.phase, CREST);
  assert.ok(fastTurn > slowTurn * 2.9, `a faster song has to turn the wave faster (${slowTurn.toFixed(3)} vs ${fastTurn.toFixed(3)})`);

  // A crest travels one wavelength per beat, so after one beat period the field is back where it
  // started - which is what makes the beat a whole number of crests rather than a drift.
  const lambda = 12, k = (Math.PI * 2) / lambda, step = 0.5;
  const beat = fresh();
  const frames = Math.round(step / DT);
  for (let i = 0; i < frames; i++) wave.step(beat, DT, { step: step });
  assert.ok(angleDiff(beat.phase, CREST) < 0.05,
    `one beat has to carry the wave a whole wavelength (phase ${beat.phase.toFixed(4)} vs ${CREST.toFixed(4)})`);
  assert.equal(src.indexOf('uCamPan*(c.x'), -1, 'the wave speed may not be borrowed from the camera pan');
}

// ---------------------------------------------------------------- 3) a kick launches the wave at the origin

{
  const w = fresh();
  w.phase = 2.2;                    // mid-cycle, so the snap is visible
  wave.step(w, DT, { step: 0.5, onset: true });
  assert.equal(w.kick, 1, 'a kick has to light the surge');
  assert.equal(w.phase, CREST, 'and land the phase on a crest, with no half-applied step');
  assert.ok(Math.abs(Math.sin(w.phase) - 1) < 1e-12, 'the origin plate has to sit at the top of the wave');

  // The surge is a rate change, not a jump: the first tenth of a second after the kick turns the
  // clock by more than the beat cadence alone would.
  const kick = fresh(), quiet = fresh();
  wave.step(kick, DT, { step: 0.5, onset: true });
  wave.step(quiet, DT, { step: 0.5 });
  const kickStart = kick.phase, quietStart = quiet.phase;
  for (let t = 0; t < 0.1; t += DT) { wave.step(kick, DT, { step: 0.5 }); wave.step(quiet, DT, { step: 0.5 }); }
  const kicked = angleDiff(kick.phase, kickStart), plain = angleDiff(quiet.phase, quietStart);
  assert.ok(kicked > plain * 1.8, `a kick has to speed the wave up once (${plain.toFixed(3)} -> ${kicked.toFixed(3)})`);

  // And it lets go: after a second the surge is spent, so the wave settles back onto the beat cadence.
  const rest = fresh();
  wave.step(rest, DT, { step: 0.5, onset: true });
  for (let t = 0; t < 1.2; t += DT) wave.step(rest, DT, { step: 0.5 });
  assert.ok(rest.kick < 0.01, `the surge has to decay (kick ${rest.kick.toFixed(4)})`);
  assert.ok(Math.abs(rest.kick - 0) < 1e-9 || rest.kick === 0 || rest.kick < 0.01, 'and stay gone');

  // A rising beat pulse counts as a kick; a decaying one does not.
  const f = fresh();
  f.prevBeat = 0.2;
  wave.frame(f, DT, { step: 0.5, beat: 0.55, playing: true });
  assert.equal(f.kick, 1, 'a rising beat pulse has to launch the wave');
  const g = fresh();
  g.prevBeat = 0.6;
  g.phase = 1.1;
  wave.frame(g, DT, { step: 0.5, beat: 0.5, playing: true });
  assert.ok(g.kick === 0, 'a pulse that is only decaying must not launch the wave');
  assert.ok(angleDiff(g.phase, 1.1 - (Math.PI * 2) * DT / 0.5) < 1e-9,
    'and the wave must keep its plain beat cadence, not jump');
}

// ---------------------------------------------------------------- 4) paused is frozen, and no tempo still moves

{
  const w = fresh();
  w.kick = 1;
  wave.frame(w, DT, { step: 0.5, beat: 0.6, playing: false });
  assert.equal(w.phase, CREST, 'a paused desk must not run its wave');
  assert.equal(w.kick, 1, 'and must not spend the surge either');

  // With no tempo at all the wave still runs, at the neutral cadence rather than standing still.
  const n = fresh();
  for (let t = 0; t < FALLBACK_STEP; t += DT) wave.step(n, DT, { step: 0 });
  assert.ok(angleDiff(n.phase, CREST) < 1e-2, 'an unknown tempo falls back to the neutral beat');
  assert.ok(FALLBACK_STEP > 0.3 && FALLBACK_STEP < 1, 'the fallback is a plain 100-ish BPM');
}

// ---------------------------------------------------------------- 5) the three knobs each move one thing

{
  assert.ok(/waveAmp:\s*\{\s*def:\s*0\.4,\s*min:\s*0,\s*max:\s*1\.2/.test(src), 'waveAmp runs 0..1.2 and defaults to the reference lift');
  assert.ok(/waveFreq:\s*\{\s*def:\s*1,\s*min:\s*0\.3,\s*max:\s*3/.test(src), 'waveFreq runs 0.3..3');
  assert.ok(/wavePhase:\s*\{\s*def:\s*0,\s*min:\s*0,\s*max:\s*1/.test(src), 'wavePhase is a share of a turn');

  // amplitude is a gain on the lift, k is the frequency, and the phase knob is an offset of one turn.
  const kAt = (freq) => (Math.PI * 2 * freq) / BASE_UNITS;
  assert.ok(kAt(2) > kAt(1) * 1.99 && kAt(0.5) < kAt(1) * 0.51, 'the frequency knob has to scale the wavenumber');
  assert.ok(Math.abs(kAt(1) * BASE_UNITS - Math.PI * 2) < 1e-12, '100% has to be one crest per BASE_UNITS world units');
  // The steepest step any plate can take: 2*amp*sin(k), reached on the wave's zero crossing.
  const maxStep = (freq) => {
    let best = 0;
    for (let i = 0; i < 90; i++) {
      const ph = (i * Math.PI) / 45;
      const d = Math.abs(lift([2, 0, 50], ph, 0.4, kAt(freq)) - lift([0, 0, 50], ph, 0.4, kAt(freq)));
      if (d > best) best = d;
    }
    return best;
  };
  assert.ok(maxStep(2) > maxStep(0.5) * 2.5, `a tighter wave has to make steeper steps (${maxStep(0.5).toFixed(3)} -> ${maxStep(2).toFixed(3)})`);
  // A phase of 0.5 turn inverts the field; a full turn is the same field.
  assert.ok(Math.abs(lift([0, 0, 50], 0, 0.4, 1) + lift([0, 0, 50], Math.PI, 0.4, 1)) < 1e-12,
    'half a turn of phase has to invert the wave');
  assert.ok(Math.abs(lift([3, 1, 50], 0, 0.4, 1) - lift([3, 1, 50], Math.PI * 2, 0.4, 1)) < 1e-12,
    'a whole turn of phase has to be the same wave');

  // Wiring: the uniforms exist, the shader reads them, and the knobs reach them.
  assert.ok(/"uniform float uWaveAmp;"/.test(src) && /"uniform float uWaveK;"/.test(src) && /"uniform float uWavePhase;"/.test(src),
    'the wave needs its three uniforms declared in the ported body');
  assert.ok(/u\.uWaveAmp\.value\s*=\s*Math\.max\(0,\s*mixerParam\('waveAmp'\)\)/.test(src), 'waveAmp has to reach the shader');
  assert.ok(/u\.uWaveK\.value\s*=\s*\(Math\.PI \* 2 \* waveFreq\)\s*\/\s*MIXER_WAVE_BASE_UNITS/.test(src), 'waveFreq has to become a wavenumber');
  assert.ok(/u\.uWavePhase\.value\s*=\s*mixerWrapAngle\(mixerState\.wave\.phase\s*\+\s*Math\.PI \* 2 \* mixerClamp01\(mixerParam\('wavePhase'\)\)\)/.test(src),
    'the shader phase has to be the wave clock plus the 相位 knob, one full turn per 100%');

  // The clock is stepped every frame from the song, and the beat pulse is what launches it.
  assert.ok(/mixerStepWave\(mixerState\.wave,\s*step,\s*\{[\s\S]{0,260}beat:\s*\(typeof beatPulse[\s\S]{0,120}onset:\s*\(typeof beatOnsetFlag/.test(src),
    'the desk frame has to advance the wave from the live beat');
  assert.ok(/playing:\s*!\(typeof audio !== 'undefined' && audio && audio\.paused\)/.test(src),
    'the wave has to freeze with the music');

  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  for (const [id, key, min, max] of [['fx-mixerwaveAmp', 'waveAmp', '0', '1.2'], ['fx-mixerwaveFreq', 'waveFreq', '0.3', '3'], ['fx-mixerwavePhase', 'wavePhase', '0', '1']]) {
    const at = html.indexOf('id="' + id + '"');
    assert.ok(at > 0, `${id} needs a row in the 调音台 panel`);
    const tag = html.slice(at, html.indexOf('>', at));
    assert.ok(tag.includes(`min="${min}"`) && tag.includes(`max="${max}"`), `${id} must run ${min}..${max}`);
    assert.ok(html.includes(`setMixerTuning('${key}', this.value)`), `${id} must write ${key}`);
    assert.ok(src.includes(`'${key}'`), `${key} has to be in the tuning schema`);
  }
  const consoleSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  for (const id of ['fx-mixerwaveAmp', 'fx-mixerwaveFreq', 'fx-mixerwavePhase']) {
    assert.ok(consoleSrc.includes(`fxConsoleItem('${id}'`), `${id} must be listed in the console 调音台 group`);
  }
}

// ---------------------------------------------------------------- 6) the tempo is the song's, in order

{
  // The ladder has to be the app's own: the map's grid step, then the gaps inside the map, then the
  // realtime tracker. A test that only checked the first rung would let a missing beat map stall the
  // wave on old caches and podcast maps.
  assert.ok(/Number\(map\.gridStep\)/.test(src), 'the beat map grid step has to be the first source');
  assert.ok(/gaps\.sort\(function \(x, y\) \{ return x - y; \}\)/.test(src), 'the fallback has to take the median gap of the map itself');
  assert.ok(/Number\(rtBeat\.tempoGap\)/.test(src), 'and the realtime tempo has to be the last resort');
  assert.ok(/step > 0\.15 && step <= 2/.test(src), 'a beat period outside 0.15..2 s is not a tempo');
}

console.log(`OK mixer wave: one shared sine on the wavefront, one crest per beat (${(60 / 0.5).toFixed(0)} BPM -> ${(2 * Math.PI / 0.5).toFixed(2)} rad/s), a kick lands on the origin crest and surges ${KICK_BOOST}x, amp/freq/phase move one thing each`);
