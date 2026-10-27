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
  if (!/var shake = haloParam\('shakePx'\) \* s\.ringPulse \* s\.levelGate;/.test(renderFrameFn)) {
    fail('the shake must be scaled by the level gate, or the ring shakes in silence');
  }
  if (!/s\.pulse = 1 \+ haloParam\('pulseScale'\) \* s\.ringPulse \* s\.levelGate;/.test(renderFrameFn)) {
    fail('the ring\'s pop must be scaled by the level gate too');
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
    [drawLyricFn, 'ctx.fillText(item.text, 0, 0)', 'haloDrawLyricText'],
    [spanFn, 'return { enter: enter, exit: exit };', 'haloVisibleSpan'],
    [rayVisibleFn, 'span.enter <= r1', 'haloRayVisible'],
    [wedgeVisibleFn, 'haloRayVisible(a1', 'haloWedgeVisible'],
    [ticksFn, 'haloRayVisible(a, r0, r1)', 'haloRingTicks'],
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
    if (!/var dur = Math\.max\(0\.05, haloParam\('rotDur'\)\);/.test(lyricUpdateFn)) {
      fail('the ring turn must last exactly the 转环时长 knob (rotDur)');
    }
    if (/Math\.min\([^)]*rotDur/.test(lyricUpdateFn)) {
      fail('the turn duration must not be clamped by the time left before the line: that is what made it snap');
    }
    for (const clamp of [/\bdur\s*=\s*Math\.min/, /Math\.min\([^)]*\bdur\b[^)]*\)/]) {
      if (clamp.test(lyricUpdateFn)) {
        fail('the turn duration must not be clamped by the time left before the line: that is what made it snap');
      }
    }
    if (!/var turnStart = items\[upcoming\]\.startAt - Math\.max\(0, haloParam\('rotLead'\)\);/.test(lyricUpdateFn)) {
      fail('the turn must start rotLead seconds before the line it is turning to');
    }
    if (!/if \(t >= items\[upcoming\]\.startAt\) \{/.test(lyricUpdateFn)) {
      fail('a line that is already due must be put on the mark at once');
    }
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
  // also says how wide the clipped arc is.
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
    if (arcFn && !/win\.rows/.test(arcFn)) {
      fail('the masked arc must be as wide as the window it clips');
    }
  }
  if (drawLyricFn) {
    if (!/var span = haloVisibleSpan\(center\);/.test(drawLyricFn)) {
      fail('the draw time fit must measure the screen\'s run on the ray the line actually sits on');
    }
    if (!/if \(span\.enter > textR \|\| span\.exit < textR\) continue;/.test(drawLyricFn)) {
      fail('a line must be drawn only when its own start is on screen: both ends of the run decide');
    }
    if (!/var room = span\.exit - textR;/.test(drawLyricFn)) {
      fail('the room a line gets is what the screen shows of its ray');
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
    if (!/haloLyricWidth\(item, ctx, fontPx\)/.test(drawLyricFn)) {
      fail('a line width must be measured only for the lines that are drawn');
    }
    // The mask: a line that leaves the window has to be cut there, not reappear elsewhere.
    if (!/ctx\.clip\(\);/.test(drawLyricFn)) {
      fail('the lyric dial must be clipped to its window arc, so lines do not read on the far side of the ring');
    }
    if (!/haloLyricArcHalf\(win\)/.test(drawLyricFn)) {
      fail('the mask must be the window\'s arc: the same count that decides the lines decides the clip');
    }
    // Every row keeps the size the app's lyric knob asks for. A row that is scaled to
    // fit its own ray is what made the lyrics look like they were breathing.
    if (!/var size = fontPx;/.test(drawLyricFn)) {
      fail('every lyric row must be drawn with the same size: the list must not have rows of different sizes');
    }
    if (/var size = current \?/.test(drawLyricFn)) {
      fail('the lyric rows must not change size with the song position: that is what made the text look like it was breathing');
    }
    if (!/var sc = 1;/.test(drawLyricFn)) {
      fail('the lyric rows must not be scaled to fit their ray');
    }
    if (!/if \(drawnW > room && current\) \{/.test(drawLyricFn)) {
      fail('only the sung row may be squeezed to fit its ray, and never below the floor');
    }
    if (!/sc = Math\.max\(HALO_LYRIC_MIN_SCALE, room \/ drawnW\);/.test(drawLyricFn)) {
      fail('the sung row must be squeezed to the floor, not scaled past it');
    }
  }
  if (!/HALO_LYRIC_MIN_SCALE = (0\.\d+);/.test(haloText)) {
    fail('a lyric line must never shrink below the floor');
  }
  // The measured widths belong to the font they were taken with, so a font size change has
  // to rebuild the ring.
  if (!/haloLyricFontPx\(\) !== haloLyric\.builtFontPx/.test(haloText)) {
    fail('the lyric ring must be rebuilt when the app\'s lyric size knob moves');
  }
}

module.exports = { haloSliceFunction, checkHaloAudioArms, checkHaloCullArms };
