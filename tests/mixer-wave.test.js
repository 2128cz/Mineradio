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
const SPEED_TAIL = constant('MIXER_WAVE_SPEED_TAIL');
const RETRIGGER = constant('MIXER_WAVE_RETRIGGER');
const FALLBACK_STEP = constant('MIXER_WAVE_FALLBACK_STEP');
const CREST = constant('MIXER_WAVE_CREST');
const REWIND_SPEED = constant('MIXER_WAVE_REWIND_SPEED');

const wave = new Function(
  'MIXER_WAVE_SPEED_TAIL', 'MIXER_WAVE_LEAD_BEATS', 'MIXER_WAVE_FALLBACK_STEP', 'MIXER_WAVE_CREST', 'MIXER_WAVE_RETRIGGER', 'MIXER_WAVE_REWIND_BEATS', 'MIXER_WAVE_REWIND_SPEED', 'MIXER_WAVE_REWIND_MIN_BEATS', 'MIXER_WAVE_RECOVER_SPEED', 'MIXER_WAVE_RECOVER_BEATS', 'MIXER_WAVE_DIP_TAIL', 'MIXER_WAVE_DIP_RISE',
  [
    fn('mixerClamp01'), fn('mixerWrapAngle'), fn('mixerWaveStep'), fn('mixerStepWave'),
    'return { wrap: mixerWrapAngle, step: mixerWaveStep, frame: mixerStepWave, clamp: mixerClamp01 };'
  ].join('\n')
)(SPEED_TAIL, constant('MIXER_WAVE_LEAD_BEATS'), FALLBACK_STEP, CREST, RETRIGGER, constant('MIXER_WAVE_REWIND_BEATS'), REWIND_SPEED, constant('MIXER_WAVE_REWIND_MIN_BEATS'), constant('MIXER_WAVE_RECOVER_SPEED'), constant('MIXER_WAVE_RECOVER_BEATS'), constant('MIXER_WAVE_DIP_TAIL'), constant('MIXER_WAVE_DIP_RISE'));

const DT = 1 / 60;
const fresh = () => ({
  phase: CREST, kick: 0, beatStep: 0, prevBeat: 0,
  phaseOffset: 0, freqKick: 0, kScale: 1, phaseShiftAmt: 0, freqShiftAmt: 0, speedShiftAmt: 0, beatClock: 0, rewind: 0, speed: 1, offset: 0, onsets: 0
});
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

// ---------------------------------------------------------------- 3) a kick compresses the wave, and hits stack

{
  // 移频 and 反推 are the motion: the clock winds back for a moment and the wavenumber shrinks, so
  // the crests retrace and the ridges bunch up under the hit.
  const w = fresh();
  wave.step(w, DT, { step: 0.5, onset: true });
  for (let t = 0; t < 0.15; t += DT) wave.step(w, DT, { step: 0.5 });
  assert.ok(w.freqKick > 0.8 && w.kScale < 0.98, `a kick has to compress the wavenumber (${w.kScale.toFixed(3)})`);

  // The tail outlasts a beat, so a second hit lands while the first is still open: dips stack and the
  // wave keeps being pushed outwards for as long as the drums continue.
  const one = fresh(), two = fresh();
  for (let t = 0; t < 0.5; t += DT) {
    const second = t > 0.29 && t < 0.31;
    wave.step(one, DT, { step: 0.5, onset: t === 0 });
    wave.step(two, DT, { step: 0.5, onset: t === 0 || second });
  }
  assert.ok(two.kScale < one.kScale - 0.01,
    `a second hit inside the tail has to deepen the dip (${one.kScale.toFixed(3)} vs ${two.kScale.toFixed(3)})`);

  // Nothing writes the phase directly - only the rate does - so the waveform cannot jump. Measured
  // without a rewind so the bound is the plain clock rate.
  const p0 = fresh();
  wave.step(p0, DT, { step: 0.5, onset: true, rewindBeats: 0 });
  let maxStep = 0, prev = p0.phase;
  for (let t = 0; t < 0.5; t += DT) {
    wave.step(p0, DT, { step: 0.5, rewindBeats: 0 });
    maxStep = Math.max(maxStep, angleDiff(p0.phase, prev));
    prev = p0.phase;
  }
  assert.ok(maxStep < (Math.PI * 2 / 0.5) * DT * 1.2, `no frame may jump (worst ${maxStep.toFixed(3)} rad)`);

  // 反推 is a real negative rate: right after a kick the clock runs backwards for a short burst, so
  // the crests retrace. The burst is spread over several frames instead of one snap, and with the
  // amount at 0 the clock keeps running forward.
  const back = fresh();
  wave.step(back, DT, { step: 0.5, onset: true });
  let backTotal = 0;
  for (let i = 0; i < 10 && back.rewind > 0; i++) {
    const at = back.phase;
    wave.step(back, DT, { step: 0.5 });
    let d = wave.wrap(back.phase - at);
    if (d > Math.PI) d -= Math.PI * 2;
    backTotal += d;
  }
  assert.ok(backTotal > 0.25, `a kick has to wind the clock backwards (${backTotal.toFixed(3)} rad)`);
  assert.ok(back.rewind <= 0, 'the burst is finite, not a permanent reversal');
  assert.ok(src.indexOf('MIXER_WAVE_REWIND_MIN_BEATS') >= 0, 'the retrace may not fit in a single frame');

  const forward = fresh();
  wave.step(forward, DT, { step: 0.5, onset: true, rewindBeats: 0 });
  const fwdAt = forward.phase;
  wave.step(forward, DT, { step: 0.5, rewindBeats: 0 });
  let fwdStep = wave.wrap(forward.phase - fwdAt);
  if (fwdStep > Math.PI) fwdStep -= Math.PI * 2;
  assert.ok(fwdStep < 0, 'with 反推 at 0 the clock must not reverse');

  // The phase reference at the world origin does not depend on k, so the frequency change is
  // aligned to the old one there without snapping a crest back (the old anchorOffset).
  assert.ok(/sin\(uWaveK\*\(c\.x\+c\.y\)\+uWavePhase\)/.test(src), 'the origin phase is the wave clock alone');
  assert.ok(src.indexOf('anchorOffset') === -1, 'no crest snap may erase the rewind');

  // A ghost inside the refractory window is dropped: 16ths under a beat cannot thump the dip.
  const ghost = fresh();
  wave.step(ghost, DT, { step: 0.5, onset: true });
  const f0 = ghost.freqKick;
  wave.step(ghost, DT, { step: 0.5, onset: true });
  assert.ok(ghost.freqKick < f0 + 1e-9, 'an onset inside the refractory window must not add another dip');

  // A rising beat pulse launches it; a decaying one does not.
  const f2 = fresh();
  f2.prevBeat = 0.2;
  wave.frame(f2, DT, { step: 0.5, beat: 0.55, playing: true });
  assert.ok(f2.freqKick > 0.8, 'a rising beat pulse has to dip the wavenumber');
  const g2 = fresh();
  g2.prevBeat = 0.6;
  wave.frame(g2, DT, { step: 0.5, beat: 0.5, playing: true });
  assert.equal(g2.freqKick, 0, 'a pulse that is only decaying must not dip it');
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

// ---------------------------------------------------------------- 5) the knobs each move one thing

{
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const consoleSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  assert.ok(/waveAmp:\s*\{\s*def:\s*0\.4,\s*min:\s*0,\s*max:\s*1\.2/.test(src), 'waveAmp runs 0..1.2 and defaults to the reference lift');
  assert.ok(/waveFreq:\s*\{\s*def:\s*1,\s*min:\s*0\.3,\s*max:\s*3/.test(src), 'waveFreq runs 0.3..3');
  assert.ok(/wavePhase:\s*\{\s*def:\s*0,\s*min:\s*0,\s*max:\s*1/.test(src), 'wavePhase is a share of a turn');
  // The beat response is not a knob any more: the drum's dip, its realignment and its lift are
  // worked out in code, so there is nothing for the listener to tune per song.
  assert.equal(src.indexOf("waveKickPhase:"), -1, 'the beat knobs must not come back as settings');
  assert.equal(src.indexOf("waveKickFreq:"), -1, 'the beat knobs must not come back as settings');
  assert.equal(src.indexOf("waveKickSpeed:"), -1, 'the old beat knobs must not come back');
  for (const [key, def, min, max] of [['waveRewind', '0.05', '0', '0.2'], ['waveRewindSpeed', '2.6', '0', '6'], ['waveRecover', '0.5', '0', '1'], ['waveRecoverBeats', '2.2', '0.5', '6']]) {
    assert.ok(new RegExp(key + ':\\s*\\{\\s*def:\\s*' + def.replace('.', '\\.')).test(src), key + ' has to be a tuning knob');
  }
  for (const [id, key] of [['fx-mixerwaveRewind', 'waveRewind'], ['fx-mixerwaveRewindSpeed', 'waveRewindSpeed'], ['fx-mixerwaveRecover', 'waveRecover'], ['fx-mixerwaveRecoverBeats', 'waveRecoverBeats']]) {
    assert.ok(html.indexOf('id="' + id + '"') > 0, id + ' needs a row in the 调音台 panel');
    assert.ok(html.indexOf("setMixerTuning('" + key + "'") > 0, id + ' has to write ' + key);
    assert.ok(consoleSrc.indexOf("fxConsoleItem('" + id + "'") > 0, id + ' needs a console entry');
  }
  assert.ok(/rewindBeats: mixerParam\('waveRewind'\)/.test(src) && /recoverBeats: mixerParam\('waveRecoverBeats'\)/.test(src),
    'the four beat-shape knobs have to reach the wave clock');
  assert.ok(/var MIXER_WAVE_REWIND_BEATS = 0\.05;/.test(src), 'a kick has to dip the wavenumber gently (5%), so the desk rolls instead of shuddering');
  assert.ok(src.indexOf("var kTarget = Math.max(0.25, 1 - w.freqKick * dipAmt);") >= 0, 'the drum has to compress the wavenumber: that is what moves every crest at once');
  assert.ok(src.indexOf("w.freqKick = Math.min(1.6, w.freqKick + 1);") >= 0, 'and the dips have to add up instead of restarting');
  assert.ok(src.indexOf("w.speed = recoverSpeed;") >= 0, 'the rate has to land below 1 and ease back, so kicks accumulate');

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
  assert.ok(/u\.uWaveK\.value\s*=\s*\(\(Math\.PI \* 2 \* waveFreq\)\s*\/\s*MIXER_WAVE_BASE_UNITS\)\s*\*\s*\(mixerState\.wave\.kScale \|\| 1\)/.test(src),
    'waveFreq has to become a wavenumber, times this frame\'s 移频 gain');
  assert.ok(/u\.uWavePhase\.value\s*=\s*mixerWrapAngle\(mixerState\.wave\.phase\s*\+\s*mixerState\.wave\.phaseOffset\s*\+\s*Math\.PI \* 2 \* mixerClamp01\(mixerParam\('wavePhase'\)\)\)/.test(src),
    'the shader phase has to be the clock plus the 移相 step plus the 相位 knob');

  // A reference to a constant that no longer exists throws every frame and the desk goes black, so
  // every MIXER_WAVE_* name the file uses is swept for a declaration - the rewind rewrite black-screened
  // exactly this way once.
  for (const name of [...new Set((src.match(/MIXER_WAVE_[A-Z_]+/g) || []))]) {
    assert.ok(new RegExp('var ' + name + '\\s*=').test(src), name + ' is used but never declared');
  }

  // The clock is stepped every frame from the song, and the beat pulse is what launches it.
  assert.ok(/mixerStepWave\(mixerState\.wave,\s*step,\s*\{[\s\S]{0,700}beat:\s*\(typeof beatPulse[\s\S]{0,200}onset:\s*\(typeof beatOnsetFlag/.test(src),
    'the desk frame has to advance the wave from the live beat');
  assert.ok(/playing:\s*!\(typeof audio !== 'undefined' && audio && audio\.paused\)/.test(src),
    'the wave has to freeze with the music');

  // The lift is rhythmic too: it rides the live level and stretches further on the drum, and the
  // beat move starts a hair early so its visible peak lands on the beat rather than behind it.
  assert.ok(/var waveLevel = mixerClamp01\(mixerState\.levelAvg \|\| 0\)/.test(src), 'the lift has to read the live level');
  assert.ok(/\(1 \+ mixerState\.wave\.kick \* MIXER_WAVE_AMP_KICK\)/.test(src), 'a kick has to stretch the lift further');
  assert.ok(constant('MIXER_WAVE_AMP_FLOOR') > 0.1 && constant('MIXER_WAVE_AMP_FLOOR') < 0.6, 'silence keeps a floor of height, not zero');
  assert.ok(constant('MIXER_WAVE_LEAD_BEATS') > 0 && constant('MIXER_WAVE_LEAD_BEATS') < 0.2, 'the beat move has a small lead');

  for (const [id, key, min, max] of [
    ['fx-mixerwaveAmp', 'waveAmp', '0', '1.2'],
    ['fx-mixerwaveFreq', 'waveFreq', '0.3', '3'],
    ['fx-mixerwavePhase', 'wavePhase', '0', '1']
  ]) {
    const at = html.indexOf('id="' + id + '"');
    assert.ok(at > 0, `${id} needs a row in the 调音台 panel`);
    const tag = html.slice(at, html.indexOf('>', at));
    assert.ok(tag.includes(`min="${min}"`) && tag.includes(`max="${max}"`), `${id} must run ${min}..${max}`);
    assert.ok(html.includes(`setMixerTuning('${key}', this.value)`), `${id} must write ${key}`);
    assert.ok(src.includes(`'${key}'`), `${key} has to be in the tuning schema`);
  }
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

  // And it actually resolves in that order, given the app's own globals.
  const beatStep = new Function('currentBeatMap', 'rtBeat', fn('mixerBeatStep') + '\nreturn mixerBeatStep;');
  const at = (map, rt) => beatStep(map, rt)();
  assert.equal(at({ gridStep: 0.5 }, { tempoGap: 0.9 }), 0.5, 'the beat map grid step wins');
  assert.equal(at({ beats: [{ time: 0 }, { time: 0.42 }, { time: 0.84 }, { time: 1.26 }, { time: 1.68 }] }, { tempoGap: 0.9 }), 0.42,
    'an older cache with no grid step has to fall back to the gaps between its own beats');
  assert.equal(at(null, { tempoGap: 0.75 }), 0.75, 'with no map at all the realtime tracker answers');
  assert.equal(at(null, null), 0, 'and with no tempo anywhere the answer is "unknown", not a guess');
  assert.equal(at({ gridStep: 0.05 }, { tempoGap: 9 }), 0, 'implausible periods are rejected at every rung');
}

// ---------------------------------------------------------------- 7) the four beat-shape knobs reach the clock

{
  // The panel writes waveRewind / waveRewindSpeed / waveRecover / waveRecoverBeats into the tuning
  // store; mixerStepWave has to carry them through to mixerWaveStep, or the rows move nothing.
  // (The old front door rebuilt its options object and silently dropped all four.)
  assert.ok(/rewindBeats: o\.rewindBeats, rewindSpeed: o\.rewindSpeed/.test(src), 'the front door must forward the rewind knobs');
  assert.ok(/recoverSpeed: o\.recoverSpeed, recoverBeats: o\.recoverBeats/.test(src), 'and the recovery knobs');
  assert.ok(src.indexOf('phaseShift: o.phaseShift, freqShift: o.freqShift') === -1, 'the dead shift options must not linger');

  const once = (opts) => {
    const w = fresh();
    wave.frame(w, DT, { step: 0.5, beat: 0.6, playing: true, ...opts });
    return w;
  };
  const flat = once({ rewindBeats: 0 });
  const dipped = once({ rewindBeats: 0.2 });
  assert.ok(dipped.kScale < flat.kScale - 0.05, `鼓点反推 has to change the wavenumber (${flat.kScale.toFixed(3)} vs ${dipped.kScale.toFixed(3)})`);

  const gentle = once({ rewindBeats: 0.2, rewindSpeed: 0 });
  const abrupt = once({ rewindBeats: 0.2, rewindSpeed: 6 });
  assert.ok(abrupt.kScale < gentle.kScale - 0.1, `反推速度 has to set how fast the dip arrives (${gentle.kScale.toFixed(3)} vs ${abrupt.kScale.toFixed(3)})`);

  const hard = once({ recoverSpeed: 0 });
  const soft = once({ recoverSpeed: 1 });
  assert.equal(hard.speed, 0, '恢复速度 0 has to land the clock at 0');
  assert.equal(soft.speed, 1, '恢复速度 1 has to keep it at full speed');

  const quick = once({ recoverBeats: 0.5 });
  const slow = once({ recoverBeats: 6 });
  for (let i = 0; i < 20; i++) {
    wave.frame(quick, DT, { step: 0.5, beat: 0, playing: true, recoverBeats: 0.5 });
    wave.frame(slow, DT, { step: 0.5, beat: 0, playing: true, recoverBeats: 6 });
  }
  assert.ok(quick.speed > slow.speed + 0.1, `恢复时长 has to set how long the rate takes to return (${quick.speed.toFixed(3)} vs ${slow.speed.toFixed(3)})`);
}

console.log(`OK mixer wave: one shared sine on the wavefront, one crest per beat (${(60 / 0.5).toFixed(0)} BPM -> ${(2 * Math.PI / 0.5).toFixed(2)} rad/s), a kick winds the clock back ${(constant('MIXER_WAVE_REWIND_BEATS') * 100).toFixed(0)}% and dips the wavenumber (separate tails), amp/freq/phase move one thing each`);
