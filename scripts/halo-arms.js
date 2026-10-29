'use strict';

// The arms that read the halo ring module's body back.
//
// They live in their own file so the mutation driver can call them on a mutated copy of
// the module: an arm that cannot be made to fail proves nothing, and the driver has to
// run the very same code the gate runs.

// Slices one function out of a module's text. Comments and strings are skipped, so a
// brace inside them does not move the depth.
function haloSliceFunction(text, name) {
  const head = 'function ' + name + '(';
  const start = text.indexOf(head);
  if (start < 0) return null;
  const open = text.indexOf('{', start + head.length);
  if (open < 0) return null;
  let i = open;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '{') { depth += 1; i += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) return text.slice(start, i);
      continue;
    }
    i += 1;
  }
  return null;
}

// The level gate.
//
// The beat map is a fixed timeline: it fires on the grid whatever the music is doing, so
// the ring used to shake over a silent passage and over a track that was not playing at
// all. The sound has to gate the motion, and the gate is the level itself.
//
// `fail(message)` is called with the reason the arm did not hold.
function checkHaloAudioArms(haloText, fail) {
  const readBandsFn = haloSliceFunction(haloText, 'haloReadAudioBands');
  const levelGateFn = haloSliceFunction(haloText, 'haloLevelGate');
  const renderFrameFn = haloSliceFunction(haloText, 'haloRenderFrame');
  if (!readBandsFn || !levelGateFn || !renderFrameFn) {
    fail('the halo audio functions could not be read back; the level gate guards below would be vacuous');
    return;
  }
  // A slice that stopped early would make the guards below vacuous, so each one has to
  // still carry the statement it is written about.
  for (const [slice, marker, name] of [
    [readBandsFn, 'a.level = (a.bands[0]', 'haloReadAudioBands'],
    [levelGateFn, "haloParam('levelGain')", 'haloLevelGate'],
    [renderFrameFn, 'var shake = haloParam', 'haloRenderFrame'],
  ]) {
    if (!slice.includes(marker)) {
      fail(`the read back body of ${name} is truncated; its guards would not see the whole function`);
    }
  }
  // The level has to be read before the ring moves: the gate needs the level of this
  // frame, not the one before it.
  const readAt = renderFrameFn.indexOf('haloReadAudioBands(t)');
  const shakeAt = renderFrameFn.indexOf('var shake = haloParam');
  if (readAt < 0 || shakeAt < 0 || readAt > shakeAt) {
    fail('the level has to be read before the ring moves: the gate needs the level of this frame');
  }
  if (!/var shake = haloParam\('shakePx'\) \* s\.ringPulse \* motion;/.test(renderFrameFn)) {
    fail('the shake must be scaled by the gate the sound allows, or the ring shakes in silence');
  }
  if (!/s\.pulse = 1 \+ haloParam\('pulseScale'\) \* s\.ringPulse \* motion;/.test(renderFrameFn)) {
    fail('the ring\'s pop must be scaled by the same gate');
  }
  // The gate answers whether there is sound at all. Read as a loudness, the eight-bin mean
  // the app reports for a normal track (~0.2) took most of every pop off before it was drawn.
  if (!/var motion = haloMotionGate\(\);/.test(renderFrameFn) ||
      !/return HALO_GATE_KEEP \+ \(1 - HALO_GATE_KEEP\) \* g;/.test(haloText)) {
    fail('the beat must be multiplied by a presence gate, not by the raw level');
  }
  if (!/haloAudio\.level/.test(levelGateFn)) {
    fail('the level gate must be built from the audio level');
  }
  // `var analyser` inside the reader shadows the app's global analyser for the whole
  // function, so `typeof analyser` was always 'undefined' and the fallback never read
  // anything: the level stayed at zero whenever the sonic monitor had no frame.
  if (/var analyser\s*=/.test(readBandsFn)) {
    fail('the analyser must not be shadowed by a local `var analyser`: the fallback would never read the level');
  }
  if (!/getByteFrequencyData/.test(readBandsFn)) {
    fail('the level fallback must read the analyser');
  }
}

// The arms that read the ring's cull and lyric geometry back out of the module.
//
// They live here, and not inline in the gate, so the mutation driver can run the very
// same code on a mutated copy of the module: an arm that cannot be made to fail is an
// arm that proves nothing.
function checkHaloCullArms(haloText, fail) {
  // The offline half-plane culling of the original does not hold for a centred ring: the
  // screen's own run along each ray has to be computed analytically, from the ring's
  // centre, and both ends of it matter.
  if (!/function haloVisibleSpan\(/.test(haloText) || !/function haloRayVisible\(/.test(haloText)) {
    fail('the ring must be culled against the screen\'s run along each ray, not a fixed half-plane');
  }
  if (/haloVisibleRadius/.test(haloText)) {
    fail('haloVisibleRadius is gone: a single end of the ray cannot tell a dead zone from a visible stretch');
  }
  // --- the defects the user hit in the ring on 2026-10-26 ---------------------------
  // (1) The ring turned too fast on every lyric change and ignored the 转环时长 knob.
  //     The tween used to be created only after the line it was aiming at had already
  //     started, so its duration was clamped by the time that was left (which was ~0)
  //     and every turn snapped instead of travelling.
  // (2) The lyrics shrank the longer the song played. The per-line fit was baked at
  //     build time against the line's own un-rotated angle: a later line points up-left,
  //     where there is almost no room, so it was scaled down once and stayed that way.
  //     The fit has to be taken when the line is drawn, on the angle it sits at then.
  // (3) The decorations and the lyrics were culled against the wrong point, and against
  //     only one end of the ray. The screen shows the stretch of a ray between where it
  //     enters the viewport and where it leaves it, both measured from the ring's centre.
  //     The centre is off screen in the default framing, so the first stretch of every
  //     ray is dead zone: measuring one end kept rows that start off screen (drawn with
  //     their first words already gone) and blocks of beams that are nowhere visible.
  // (4) Every line of the song was laid out on the ring, so a long song spread its words
  //     over the whole circle and several lines you were not singing read at once. The
  //     dial is a window now: lyricRows lines around the sung one, measured only for the
  //     lines that show, and clipped to that window's arc.
  const buildLyricFn = haloSliceFunction(haloText, 'haloBuildLyricRing');
  const lyricUpdateFn = haloSliceFunction(haloText, 'haloLyricUpdate');
  const drawLyricFn = haloSliceFunction(haloText, 'haloDrawLyricText');
  const spanFn = haloSliceFunction(haloText, 'haloVisibleSpan');
  const rayVisibleFn = haloSliceFunction(haloText, 'haloRayVisible');
  const wedgeVisibleFn = haloSliceFunction(haloText, 'haloWedgeVisible');
  const ticksFn = haloSliceFunction(haloText, 'haloRingTicks');
  if (!buildLyricFn || !lyricUpdateFn || !drawLyricFn || !spanFn || !rayVisibleFn || !wedgeVisibleFn || !ticksFn) {
    fail('the halo cull and lyric functions could not be read back; the guards below would be vacuous');
  }
  // A slice that stopped early would make the guards below vacuous, so each one has to
  // still carry the statement it is written about.
  for (const [slice, marker, name] of [
    [buildLyricFn, 'haloLyric.items.push(item)', 'haloBuildLyricRing'],
    [lyricUpdateFn, 'haloLyric.tween = {', 'haloLyricUpdate'],
    [drawLyricFn, 'ctx.fillText(item.text, jitterX, jitterY)', 'haloDrawLyricText'],
    [spanFn, 'return { enter: enter, exit: exit };', 'haloVisibleSpan'],
    [rayVisibleFn, 'span.enter <= r1', 'haloRayVisible'],
    [wedgeVisibleFn, 'haloRayVisible(a1', 'haloWedgeVisible'],
    [ticksFn, 'haloRayVisible(a, r0, r1, s.pulse)', 'haloRingTicks'],
  ]) {
    if (slice && !slice.includes(marker)) {
      fail(`the read back body of ${name} is truncated; its guards would not see the whole function`);
    }
  }
  // The ray must be measured from the ring's centre - where the camera transform puts it:
  // the framing knobs' position plus the user's own pan, plus the shake - and it must
  // report both ends of the run.
  if (spanFn) {
    if (!/var ox = s\.w \/ 2 - haloCam\.zoom \* haloPanTotalX\(\) \+ s\.shakeX;/.test(spanFn)) {
      fail('the visible run must be measured from the ring\'s centre on the screen, not from the world origin');
    }
    if (!/var oy = s\.h \/ 2 - haloCam\.zoom \* haloPanTotalY\(\) \+ s\.shakeY;/.test(spanFn)) {
      fail('the visible run must be measured from the ring\'s centre on the screen, not from the world origin');
    }
    if (/-z \* s\.cx - haloCam\.zoom \* haloPanTotalX\(\)/.test(spanFn)) {
      fail('the visible run must not be measured from the transform offset: that is the world origin, not the ring');
    }
    if (!/enter = Math\.max\(enter, Math\.min\(tx1, tx2\)\);/.test(spanFn) ||
        !/exit = Math\.min\(exit, Math\.max\(tx1, tx2\)\);/.test(spanFn)) {
      fail('the visible run needs both ends: where the ray enters the viewport and where it leaves');
    }
  }
  // A wedge is a block of lines over up to ~20deg: decided on its middle ray alone, the
  // whole block drops while part of it is still on screen.
  if (wedgeVisibleFn) {
    if (!/haloRayVisible\(a0, r0, s\.RMAX\) \|\| haloRayVisible\(mid, r0, s\.RMAX\) \|\| haloRayVisible\(a1, r0, s\.RMAX\)/.test(wedgeVisibleFn)) {
      fail('a wedge must be judged over its own angular span, not on its middle ray alone');
    }
  }
  // Each tick loop draws at its own radii; one shared threshold keeps the wrong set.
  if (ticksFn && !/function haloRingTicks\(stepRad, r0, r1, fn\)/.test(ticksFn)) {
    fail('the rim ticks must name the radii they draw at, so the cull judges the right band');
  }
  if (lyricUpdateFn) {
    if (!/var turn = haloTurnWindow\(items\[upcoming\]\.startAt\);/.test(lyricUpdateFn)) {
      fail('the turn has to ask the song how long it should take, rather than hard-coding the knob');
    }
    if (!/var dur = turn\.dur;/.test(lyricUpdateFn) || !/var turnStart = turn\.startAt;/.test(lyricUpdateFn)) {
      fail('the turn length and start both come from the same timing decision');
    }
    // A turn that takes over while the dial is still moving has to inherit its speed; the
    // value is continuous either way, so only the speed tells the two apart.
    if (!/haloLyric\.vel = \(haloLyric\.rot - haloLyric\.lastRot\) \/ elapsed;/.test(lyricUpdateFn)) {
      fail('the dial must know its own angular velocity, measured before anything moves it');
    }
    if (!/haloLyric\.rot = haloEaseJoin\(k, tw\.from, tw\.to, tw\.v0 \|\| 0, tw\.dur\);/.test(lyricUpdateFn)) {
      fail('the turn must be evaluated with the speed it inherited, not from rest');
    }
    if (!/tw\.v0 = haloLyric\.vel;/.test(lyricUpdateFn)) {
      fail('a re-aimed turn must carry the running speed into the new curve');
    }
    if (!/v0: haloLyric\.vel/.test(lyricUpdateFn)) {
      fail('a turn created while the dial is still moving must inherit that speed too');
    }
    // Every path that teleports the dial (a seek, a landing after the loop was parked, the
    // first line) must drop the speed: nothing glided there, so there is nothing to hand on.
    const jumps = (lyricUpdateFn.match(/haloLyric\.vel = 0;/g) || []).length;
    if (jumps < 4) {
      fail(`every path that moves the dial by jump must zero its speed; found ${jumps} of the 4 such paths`);
    }
    if (/Math\.min\([^)]*rotDur/.test(lyricUpdateFn) || /\bdur\s*=\s*Math\.min/.test(lyricUpdateFn)) {
      fail('the turn duration must not be clamped by the time left before the line: that is what made it snap');
    }
    if (!/if \(t >= items\[upcoming\]\.startAt\) \{/.test(lyricUpdateFn)) {
      fail('a line that is already due must be put on the mark at once');
    }
  }
  {
    const joinFn = haloSliceFunction(haloText, 'haloEaseJoin');
    if (!joinFn) {
      fail('haloEaseJoin could not be read back; the turn curve would be unchecked');
    }
    if (joinFn && !/v0 \* dur/.test(joinFn)) {
      fail('the inherited speed has to be scaled by the turn length, or the join is in the wrong units');
    }
    if (joinFn && !/if \(!v0\) return from \+ \(to - from\) \* haloEaseIO\(k\);/.test(joinFn)) {
      fail('with nothing to inherit, the turn must keep the ease-in-out curve it always used');
    }
  }
  // The turn timing: the beat grid when the app knows the tempo, the console's own knobs
  // when it does not - and the fallback has to say which one it reached, so a silent
  // fallback cannot pass as the beat-driven mode.
  const turnFn = haloSliceFunction(haloText, 'haloTurnWindow');
  const gridFn = haloSliceFunction(haloText, 'haloBeatGrid');
  if (!turnFn || !gridFn) {
    fail('the turn timing functions could not be read back; the guards below would be vacuous');
  }
  if (turnFn) {
    if (!/haloBeatGrid\(\)/.test(turnFn)) {
      fail('the ring turn must be timed off the song\'s beat grid');
    }
    if (!/Math\.floor\(\(startAt - grid\.step - grid\.origin\) \/ grid\.step\) \* grid\.step/.test(turnFn)) {
      fail('the turn must start on a beat, not one beat-length before the line wherever that falls');
    }
    if (!/dur:\s*Math\.max\(0\.05, haloParam\('rotDur'\)\)/.test(turnFn) ||
        !/startAt - Math\.max\(0, haloParam\('rotLead'\)\)/.test(turnFn)) {
      fail('with the knob off the turn must still be exactly the 转环时长 / 转环提前量 knobs');
    }
    if (!/source:/.test(turnFn)) {
      fail('the timing decision must report which producer set it');
    }
  }
  if (gridFn) {
    if (!/haloParam\('beatTurn'\)/.test(gridFn)) {
      fail('the beat-driven turn has to be a knob the user can turn off');
    }
    if (!/map\.gridStep/.test(gridFn) || !/rtBeat\.tempoGap/.test(gridFn)) {
      fail('the tempo has to be taken from the song\'s beat map and fall back to the realtime tracker, in that order');
    }
    if (!/list\[i\]\.t - list\[i - 1\]\.t/.test(gridFn)) {
      fail('a map with no grid step still carries beat times: their gap is the same fixed spacing');
    }
    if (!/haloState\.beat = \{ step: 0, origin: 0, source:/.test(gridFn)) {
      fail('when nothing knows the tempo, the reason has to be recorded, not left as a bare zero');
    }
  }
  if (!/turn: \{/.test(haloText) || !/beatSource: haloState\.beat\.source/.test(haloText)) {
    fail('the status probe must print what set the last turn\'s timing');
  }
  if (buildLyricFn) {
    if (!/textWidth: 0,/.test(buildLyricFn)) {
      fail('the ring must be built without measuring: only the lines inside the window get measured');
    }
    if (/measureText/.test(buildLyricFn)) {
      fail('no line width may be measured when the ring is built: a song has hundreds of lines and the dial shows a handful');
    }
    if (/\bscale:/.test(buildLyricFn)) {
      fail('the per-line scale must not be baked at build time: that is what made the lyrics shrink');
    }
  }
  // The window and its mask must be one number: the knob that says how many lines read
  // also says how wide the clipped arc is. At the shipped 0 the knob is a cap and the list
  // runs the whole way round, stopping at the point opposite the read mark - so a line is
  // born and dies behind the ring instead of popping into view at the side of the screen.
  {
    const windowFn = haloSliceFunction(haloText, 'haloLyricWindow');
    const arcFn = haloSliceFunction(haloText, 'haloLyricArcHalf');
    if (!windowFn || !arcFn) {
      fail('the lyric window and its arc could not be read back; the guards below would be vacuous');
    }
    if (windowFn && !/haloParam\('lyricRows'\)/.test(windowFn)) {
      fail('how many lyric lines read at once must be a knob');
    }
    if (windowFn && !/haloLyric\.current/.test(windowFn)) {
      fail('the lyric window must be centred on the line being sung');
    }
    if (windowFn && !/items\[anchor\][^\n]*\.angle/.test(windowFn)) {
      fail('the window must be measured from the sung line\'s own angle, not from the song\'s first line');
    }
    if (windowFn && !/while \(from > 0 && base - items\[from - 1\]\.angle < Math\.PI\) from--/.test(windowFn)) {
      fail('an uncapped dial must run back to the point opposite the read mark');
    }
    if (windowFn && !/while \(to < items\.length - 1 && items\[to \+ 1\]\.angle - base < Math\.PI\) to\+\+/.test(windowFn)) {
      fail('an uncapped dial must run forward to the point opposite the read mark');
    }
    if (windowFn && /if \(!\(rows > 0\)\)/.test(windowFn) === false) {
      fail('the knob must be a cap: 0 has to mean the whole circle, not no lines at all');
    }
    if (windowFn && /Math\.ceil\(rows \/ 2\)/.test(windowFn)) {
      fail('a capped window must keep the sung line inside it: rounding the half row the wrong way drops it at rows 1');
    }
    if (arcFn && !/items\[win\.from\]\.angle - win\.base/.test(arcFn)) {
      fail('the masked arc must be as wide as the window it clips');
    }
    if (arcFn && !/Math\.min\(Math\.PI,/.test(arcFn)) {
      fail('the masked arc must stop at the circle: the window ends meet at the point opposite the read mark');
    }
  }
  // The ring's pop takes the beat points the analysis thinned for the visuals, and the
  // detected hits only colour how hard a beat lands; the level gate decides how much of it
  // the music allows.
  {
    const eventsFn = haloSliceFunction(haloText, 'haloBeatMapEvents');
    const listFn = haloSliceFunction(haloText, 'haloBeatList');
    const hitFn = haloSliceFunction(haloText, 'haloBeatHit');
    if (!eventsFn || !listFn || !hitFn) {
      fail("the ring's beat events, their list and the hit handler could not be read back");
    }
    if (eventsFn && !/var list = haloBeatList\(currentBeatMap\.pulseBeats, false\)/.test(eventsFn)) {
      fail("the pop must take the analysis' own beat points, not the whole grid it laid over the song");
    }
    if (eventsFn && /cameraBeats \|\| currentBeatMap\.pulseBeats/.test(eventsFn)) {
      fail('the grid first is the dense metronome again: the beat points must be read before it');
    }
    if (eventsFn && !/haloAccentGridWithHits\(list, haloBeatList\(currentBeatMap\.hits, true\)\)/.test(eventsFn)) {
      fail('a grid beat with a detected drum under it must pop harder than one without');
    }
    if (eventsFn && !/haloBeatList\(currentBeatMap\.cameraBeats/.test(eventsFn)) {
      fail('a map without a thinned beat list still needs the grid as a fallback');
    }
    if (eventsFn && !/return haloThrottleBeats\(/.test(eventsFn)) {
      fail('a list of beats closer than the eye can separate must be thinned before it is scheduled');
    }
    const throttleFn = haloSliceFunction(haloText, 'haloThrottleBeats');
    if (!throttleFn) {
      fail('the pop-rate floor could not be read back');
    }
    if (throttleFn && !/if \(list\[i\]\.w > prev\.w\) out\[out\.length - 1\] = list\[i\];/.test(throttleFn)) {
      fail('crowded beats must keep the harder one, not whichever came first');
    }
    const scheduleFn = haloSliceFunction(haloText, 'haloScheduleBeats');
    if (scheduleFn && !/t - haloBeat\.lastOnsetAt >= HALO_BEAT_MIN_GAP/.test(scheduleFn)) {
      fail('the live onset detector needs the same floor: it is the one source that reads the level directly');
    }
    if (listFn && !/e\.camera === false/.test(listFn)) {
      fail('an entry the analysis did not judge drum-like is not a hit');
    }
    if (listFn && !/e\.grid === true/.test(listFn)) {
      fail('a synthesised grid point is not a hit');
    }
    if (hitFn && !/0\.15 \+ 0\.85 \* weight/.test(hitFn)) {
      fail("a hard hit must pop harder than a light one: the pulse comes from the hit's weight");
    }
    if (hitFn && !/var weight = haloClamp\(e\.weight, 0, 1\);\s*\n\s*haloState\.ringPulse/.test(hitFn)) {
      fail('the pop size must be the beat itself: a scheduled weight, not a number read that frame');
    }
    if (hitFn && /haloAudio\.kick/.test(hitFn)) {
      fail('the live envelope must not set the size: that made every pop the loudest the knob allows');
    }
    if (hitFn && !/haloState\.shakeDirX = /.test(hitFn)) {
      fail('the hit, not the playhead, decides which way the picture is thrown');
    }
  }
  // The outer beams: one spectrum bin per cluster (not one of eight bands), the level
  // multiplies the cluster's own length, and a beat lengthens every beam then falls back.
  {
    const beamFn = haloSliceFunction(haloText, 'haloBeamSpectrum');
    const updateFn = haloSliceFunction(haloText, 'haloUpdateStrands');
    const beatFn = haloSliceFunction(haloText, 'haloStrandBeat');
    const bandsFn = haloSliceFunction(haloText, 'haloReadAudioBands');
    if (!beamFn || !updateFn || !beatFn || !bandsFn) {
      fail('the beam spectrum, its update and the beat hook could not be read back');
    }
    if (beamFn && !/haloAudio\.spectrum/.test(beamFn)) {
      fail('the beams must read the per-bin spectrum, not the eight bands');
    }
    if (beamFn && !/haloNormAngle\(angle - haloReadAngle\(\)\)/.test(beamFn)) {
      fail('a cluster must read the bin its own angle points at');
    }
    if (updateFn && !/haloBeamSpectrum\(am\)/.test(updateFn)) {
      fail('every beam must read the spectrum at its own angle');
    }
    if (updateFn && !/s\.beamKick = Math\.max\(0, \(s\.beamKick \|\| 0\) \* Math\.exp\(-dt \* 2\.6\)\)/.test(updateFn)) {
      fail('the beat envelope on the beams must fall back by itself');
    }
    if (updateFn && !/wedge\.base \* \(0\.16 \+ 1\.32 \* wedge\.av\)/.test(updateFn)) {
      fail("the level must multiply the cluster's own length, not be added to an idle length");
    }
    if (updateFn && !/var cap = 1 \+ 0\.5 \* \(s\.beamKick/.test(updateFn)) {
      fail('the length ceiling must rise with the beat, or a loud passage cannot show one');
    }
    // One length model, not the old two: 'bounce' was the only snappy layer and everything
    // else crawled, which read as the beams easing themselves instead of playing the song.
    if (updateFn && /layer\.dyn === 'bounce'/.test(updateFn)) {
      fail('every beam layer must take its length from one model; only the drawing may still differ');
    }
    if (updateFn && !/var rise = 5 \+ 22 \* follow;[\s\S]{0,40}var fall = 1\.3 \+ 5\.7 \* follow;/.test(updateFn)) {
      fail("the beams' own easing must collapse as the follow knob goes up");
    }
    if (updateFn && !/var breath = \(1 - follow\) \* 0\.05/.test(updateFn)) {
      fail('the idle breathing must vanish at full follow');
    }
    // The outer ring is several element families, all driven by the same spectrum. A layer
    // that loses its kind is a family that quietly went back to being a ray.
    const makeFn = haloSliceFunction(haloText, 'haloMakeStrandLayer');
    const buildFn = haloSliceFunction(haloText, 'haloBuildStrands');
    const drawFn = haloSliceFunction(haloText, 'haloDrawStrands');
    if (!makeFn || !buildFn || !drawFn) {
      fail('the strand layers could not be read back');
    }
    if (makeFn && !/var family = kind \|\| 'ray';/.test(makeFn)) {
      fail('a strand layer must say which element family it draws');
    }
    if (buildFn && !/, 'bar'\)/.test(buildFn)) {
      fail('the wide bars are one of the ring\'s element families; the layer that carried them is gone');
    }
    if (buildFn && !/, 'fan'\)/.test(buildFn)) {
      fail('the bars assembled into a sector are one of the ring\'s element families');
    }
    if (drawFn && !/var flat = layer\.kind !== 'ray';/.test(drawFn)) {
      fail('the blocky families must be drawn at one length, not with the rays\' domed profile');
    }
    if (drawFn && !/if \(!collect \|\| flat\) continue;/.test(drawFn)) {
      fail('a bar or a sector is solid; only the rays carry a travelling tail');
    }
    if (drawFn && !/layer\.kind === 'fan'\s*\?/.test(drawFn)) {
      fail("a sector's width comes from the angular gap between its bars, or the bars do not merge");
    }
    const groupFn = haloSliceFunction(haloText, 'haloDrawStrandGroup');
    const frameFn = haloSliceFunction(haloText, 'haloDrawFrame');
    if (!groupFn || !frameFn) {
      fail('the strand drawing groups could not be read back');
    }
    if (frameFn && /haloDrawStrands\(ctx, haloStrandLayers\[/.test(frameFn)) {
      fail('the outer families are drawn by kind, not by the order they were built in');
    }
    if (groupFn && !/layer\.kind === 'ray' \? collect : null/.test(groupFn)) {
      fail('only the rays may hand over a travelling tail');
    }
    if (beatFn && !/s\.beamKick = Math\.min\(1\.2/.test(beatFn)) {
      fail("a beat must raise the beams' own envelope");
    }
    if (!/a\.spectrum = a\.buffer;/.test(bandsFn) || !/a\.spectrum = sonicAudioMonitorState\.raw/.test(bandsFn)) {
      fail("the per-bin spectrum must be filled from the monitor, with the halo's analyser as the fallback");
    }
  }
  // The sung row stands apart from the rest, and how a row arrives and leaves is the app's
  // lyric motion - the console's 歌词动画 profile - not a motion model of the ring's own.
  {
    const motionFn = haloSliceFunction(haloText, 'haloLyricMotion');
    const contextFn = haloSliceFunction(haloText, 'haloLyricContextSettings');
    const frameFn = haloSliceFunction(haloText, 'haloRenderFrame');
    if (!motionFn || !contextFn || !frameFn) {
      fail('the lyric motion, its context settings and the frame check could not be read back');
    }
    if (motionFn && !/lyricMotionProfile\(\)/.test(motionFn)) {
      fail("the rows must enter and leave with the app's own lyric motion profile");
    }
    if (contextFn && !/lyricContextOpacity/.test(contextFn)) {
      fail("how clear the neighbouring rows are must be the console's 上下句清晰 setting");
    }
    if (contextFn && !/lyricEdgeFade/.test(contextFn)) {
      fail("where the screen's edge takes a row away must be the console's 边缘渐隐 setting");
    }
    if (frameFn && !/haloLyricStep\(\) !== haloLyric\.builtStep/.test(frameFn)) {
      fail('a resized ring must lay its rows out again: the pitch is a pixel height over the radius');
    }
  }
  if (drawLyricFn) {
    if (!/var span = haloVisibleSpan\(center\);/.test(drawLyricFn)) {
      fail('the draw time fit must measure the screen\'s run on the ray the line actually sits on');
    }
    if (!/if \(span\.enter > drawnR \|\| span\.exit < drawnR\) continue;/.test(drawLyricFn)) {
      fail('a line must be drawn only when its own start is on screen: both ends of the run decides');
    }
    // The measure stays at the ring's rest scale, so a beat cannot reflow the rows or fade
    // them in and out; only the cull learns that the popped ring carries the line further.
    if (!/var drawnR = textR \* \(s\.pulse \|\| 1\);/.test(drawLyricFn)) {
      fail('the lyric layout must be measured at the ring\'s rest scale, never at the beat\'s');
    }
    // The dial is a window: the lines around the one being sung, not the whole song.
    if (!/var win = haloLyricWindow\(\);/.test(drawLyricFn)) {
      fail('the lyric dial must draw a window of lines, not every line of the song');
    }
    if (!/for \(var i = win\.from; i <= win\.to; i\+\+\)/.test(drawLyricFn)) {
      fail('the lyric loop must walk the window, so a long song cannot spread over the whole ring');
    }
    if (/for \(var i = 0; i < items\.length; i\+\+\)/.test(drawLyricFn)) {
      fail('the lyric loop must not walk every line of the song again');
    }
    if (!/haloLyricWidth\(item, ctx, size\)/.test(drawLyricFn)) {
      fail('a line width must be measured only for the lines that are drawn, with the size they are drawn at');
    }
    // The mask: a line that leaves the window has to be cut there, not reappear elsewhere.
    if (!/ctx\.clip\(\);/.test(drawLyricFn)) {
      fail('the lyric dial must be clipped to its window arc, so lines do not read on the far side of the ring');
    }
    if (!/haloLyricArcHalf\(win\)/.test(drawLyricFn)) {
      fail('the mask must be the window\'s arc: the same count that decides the lines decides the clip');
    }
    // One size for every row, always. The room a ray has is measured through the camera, so
    // a row that is scaled to fit it shrinks as the ring pulses to the beat - which is what
    // the user rejected: the font is set by the app's lyric size knob and nothing else.
    if (!/HALO_LYRIC_CONTEXT_SCALE/.test(drawLyricFn)) {
      fail('the rows around the sung one must sit at the context size, so the sung row reads above them');
    }
    if (!/var focusNear = haloClamp\(1 - near \//.test(drawLyricFn)) {
      fail('the size and the highlight must follow how close a row is to the read spot, continuously');
    }
    if (/0\.16 \+ 0\.5 \* focus/.test(drawLyricFn)) {
      fail("the context opacity must come from 上下句清晰, not from a constant of the ring's");
    }
    if (!/1 - leaving \* motion\.exit/.test(drawLyricFn)) {
      fail("the exit fade must use the app's lyric motion profile");
    }
    if (!/motion\.slide/.test(drawLyricFn)) {
      fail("a row arriving at the screen's edge must slide in by the profile's amount");
    }
    if (!/motion\.style === 'glitch'/.test(drawLyricFn)) {
      fail('the glitch effect must only run for the glitch style');
    }
    if (/var size = current \?/.test(drawLyricFn)) {
      fail('the lyric rows must not change size with the song position: that is what made the text look like it was breathing');
    }
    if (/\bsc\s*=|ctx\.scale\(/.test(drawLyricFn)) {
      fail('no lyric row may be scaled to fit its ray - not the sung one, not any other');
    }
    if (/var room\s*=|room\s*\/\s*drawnW|>\s*room\b/.test(drawLyricFn)) {
      fail('the lyric draw must not size text from the visible room: that number follows the ring\'s zoom and its beat pulse');
    }
  }
  // Nothing may take the lyric size from the ring's geometry. The knob the user moves is the
  // app's own 歌词字号; the radius decides where a row starts, never how big its glyphs are.
  {
    const fontFn = haloSliceFunction(haloText, 'haloLyricFontPx');
    if (!fontFn) {
      fail('haloLyricFontPx could not be read back; the lyric size guard below would be vacuous');
    }
    if (fontFn && /haloState\.(R|RO|band|RMAX|w|h)\b|s\.(R|RO|band|RMAX)\b/.test(fontFn)) {
      fail('the lyric font size must not come from the ring\'s size or the viewport: that is the adaptive text the user rejected');
    }
  }
  if (/HALO_LYRIC_MIN_SCALE/.test(haloText)) {
    fail('the lyric floor scale is gone: no row is squeezed to fit anything, so there is nothing to floor');
  }
  // The measured widths belong to the font they were taken with, so a font size change has
  // to rebuild the ring.
  if (!/haloLyricFontPx\(\) !== haloLyric\.builtFontPx/.test(haloText)) {
    fail('the lyric ring must be rebuilt when the app\'s lyric size knob moves');
  }
}

// The rotation the painted effects follow.
//
// When a lyric turn finishes, the dial re-anchors its line angles: it takes a whole step off
// every angle and adds it back to its own rotation, which cancels for a lyric line and does
// not for anything else. The user saw every effect on the ring slide with the turn and then
// jump back when it ended. So the effects read `decoRot` - the ring's rotation with those
// re-anchors taken out - and only the lyric dial reads the dial's own `ringRot`.
function checkHaloRotationArms(haloText, fail) {
  if (!/decoRot: 0,/.test(haloText)) {
    fail('the ring needs its own rotation field for the things painted on it');
  }
  const renderFn = haloSliceFunction(haloText, 'haloRenderFrame');
  if (!renderFn) {
    fail('haloRenderFrame could not be read back; the rotation guards below would be vacuous');
    return;
  }
  if (!renderFn.includes('s.ringRot = haloLyric.rot;') || !renderFn.includes('s.decoRot = s.ringRot - haloLyric.rebase;')) {
    fail('the ring has to derive its own rotation from the dial by taking the re-anchors back out');
  }
  // Every place that re-anchors the list has to remember that it did, or the effects follow
  // the bookkeeping. The shift lives in one helper now; what matters is that the helper
  // records it and that every path which moves the dial calls it.
  const anchorFn = haloSliceFunction(haloText, 'haloAnchorLyric');
  if (!anchorFn || !/haloLyric\.rebase \+= shift;/.test(anchorFn)) {
    fail('the re-anchor helper must add its shift to haloLyric.rebase, or the effects follow the bookkeeping');
  }
  if (!/haloLyric\.rebase \+= rebase;/.test(haloText)) {
    fail('a finished turn must still record its re-anchor');
  }
  const updateFn = haloSliceFunction(haloText, 'haloLyricUpdate');
  const calls = updateFn ? (updateFn.match(/haloAnchorLyric\(/g) || []).length : 0;
  if (calls < 4) {
    fail(`every path that moves the dial must re-anchor the list, found ${calls} of at least 4`);
  }
  const buildFn = haloSliceFunction(haloText, 'haloBuildLyricRing');
  if (buildFn && !buildFn.includes('haloLyric.rebase = 0;')) {
    fail('a rebuilt lyric dial must start its re-anchor total again');
  }
  // The effects follow the ring; only the lyric list follows the dial.
  const effectFns = ['haloDrawRing', 'haloDrawStrands', 'haloRingTicks', 'haloDrawFlyers',
    'haloSlotVisible', 'haloWedgeVisible', 'haloDrawComets', 'haloDrawHaze'];
  for (const name of effectFns) {
    const fn = haloSliceFunction(haloText, name);
    if (!fn) {
      fail(`${name} could not be read back; the rotation guard for it would be vacuous`);
      continue;
    }
    if (!/decoRot/.test(fn)) {
      fail(`${name} must place its elements with the ring's own rotation (decoRot), not the lyric dial's`);
    }
    if (/ringRot/.test(fn)) {
      fail(`${name} still reads the lyric dial's rotation: it would snap back when a turn ends`);
    }
  }
  const lyricFn = haloSliceFunction(haloText, 'haloDrawLyricText');
  if (lyricFn && !/item\.angle \+ s\.ringRot/.test(lyricFn)) {
    fail('the lyric line is placed in the dial\'s own frame: it must follow the dial, not the ring');
  }
  if (lyricFn && /s\.decoRot/.test(lyricFn)) {
    fail('the lyric dial must not take the re-anchors out: they are what puts each sung line on the mark');
  }
}

// The lyric carrier. Which one the camera asks for, where the radial line lives, how a
// line change turns the disc, and where the colours come from. Shape guards; the behaviour
// lives in tests/halo-radial-carrier.test.js.
function checkHaloRadialArms(haloText, fail) {
  const drawFn = haloSliceFunction(haloText, 'haloDrawLyricText');
  const regionFn = haloSliceFunction(haloText, 'haloViewRegion');
  const planFn = haloSliceFunction(haloText, 'haloRadialPlan');
  const arcFn = haloSliceFunction(haloText, 'haloDrawArcLine');
  const discFn = haloSliceFunction(haloText, 'haloDrawRadialDisc');
  const paletteFn = haloSliceFunction(haloText, 'haloLyricPalette');
  const updateFn = haloSliceFunction(haloText, 'haloLyricUpdate');
  if (!drawFn || !regionFn || !planFn || !arcFn || !discFn || !paletteFn || !updateFn) {
    fail('the lyric carrier functions could not be read back; the guards below would be vacuous');
    return;
  }
  // The colours are the app's own lyric colours, never a literal of the ring's own.
  if (!/lyricColorMode === 'custom'/.test(paletteFn)) {
    fail("the lyric colour must follow the app's custom/auto choice");
  }
  if (!/effectiveLyricPalette\(/.test(paletteFn)) {
    fail("the ring must paint with the app's lyric palette, not one of its own");
  }
  if (/rgba\(238,241,248|rgba\(226,230,240/.test(haloText)) {
    fail('the lyric rows must not go back to the hard-coded colour');
  }
  if (!/var region = haloViewRegion\(\);/.test(drawFn) || !/haloDrawRadialLyric\(ctx, region\)/.test(drawFn)) {
    fail('the draw must pick its carrier from what the camera shows');
  }
  if (!/if \(region !== 'side'\) \{/.test(drawFn)) {
    fail('only the side view may keep the axial list; every other region is the radial carrier');
  }
  // The whole-ring carrier puts the text outside the rim, so the fit test has to include
  // the ring the text rides on and the line's own height - not just the rim.
  if (!/haloParam\('textGap'\)/.test(regionFn) || !/haloLyricFontPx\(\)/.test(regionFn)) {
    fail('the whole-ring carrier must require the lyric ring and a line height to fit, or its text is painted into the screen edge');
  }
  if (!/if \(centred && fits\) return 'whole';/.test(regionFn)) {
    fail('the whole-ring carrier must be chosen only when the ring its text rides on fits too');
  }
  if (!/if \(haloParam\('axialLyric'\) > 0\) return 'side';/.test(regionFn)) {
    fail('the console switch must decide the carrier; the camera must not flip it back to the list');
  }
  if ((regionFn.match(/'side'/g) || []).length !== 1) {
    fail('the radial region logic must never return the axial list: the switch is the only way to it');
  }
  if (!/var inside = Math\.min\(attached, screenMax\);/.test(planFn)) {
    fail('an inside carrier must ride the ring radius and only give way to the screen');
  }
  if (!/return 'inside'/.test(regionFn)) {
    fail('a ring that is on screen but too big to fit its outside text must carry the text inside it');
  }
  if (!/haloNormAngle\(haloReadAngle\(\) \+ Math\.PI\)/.test(planFn)) {
    fail('the radial seam must be the point opposite the read mark, the same point the dial is born and cut at');
  }
  if (!/HALO_RADIAL_FAR_SCALE/.test(planFn)) {
    fail('the whole-ring carrier must read from further away: its size has to come from the far scale');
  }
  if (!/plan\.r0 = outer \+ gap;/.test(planFn) || !/plan\.r1 = outer \+ gap;/.test(planFn)) {
    fail('the two radial arcs must sit outside the rim, one line-height apart');
  }
  if (!/if \(off > winHalf\) break;/.test(arcFn)) {
    fail('a radial line longer than its window must be cut there, not allowed to wrap round the circle');
  }
  var clamps = (discFn.match(/Math\.min\(HALO_RADIAL_MAX_HALF/g) || []).length;
  if (clamps < 2) {
    fail(`both radial windows must be capped, or a long line wraps half the circle instead of being cut (found ${clamps} of 2)`);
  }
  if (!/if \(sung !== radial\.item\)/.test(updateFn)) {
    fail("a line change must start the disc's swing");
  }
  if (!/radial\.dur = Math\.max\(0\.12, haloTurnWindow/.test(updateFn)) {
    fail("the swing must last as long as the ring's turn, so both carriers move on one clock");
  }
}

module.exports = { haloSliceFunction, checkHaloAudioArms, checkHaloCullArms, checkHaloRotationArms, checkHaloRadialArms };
