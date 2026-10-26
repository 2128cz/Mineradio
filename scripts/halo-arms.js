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

module.exports = { haloSliceFunction, checkHaloAudioArms };
