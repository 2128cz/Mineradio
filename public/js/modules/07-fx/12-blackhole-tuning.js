'use strict';

// Tuning for the galactic black hole (preset 15), exposed as 动效 → 银河黑洞 in the visual
// console.
//
// The knobs live in the preset module (02-visual/19-galaxy-blackhole-preset.js) as
// BH_TUNING_SCHEMA, so the defaults have exactly one home; this file is the store and the
// console bindings. Like the ring's and the PV layer's, the store is deliberately not part of
// `fx`: the hole's knobs only mean something while the hole is on screen, and folding them into
// fx would push them into every saved visual archive.

var BLACKHOLE_TUNING_STORE_KEY = 'mineradio-blackhole-tuning-v1';

function bhTuningClamp(key, value) {
  var spec = BH_TUNING_SCHEMA[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  return Math.min(spec.max, Math.max(spec.min, next));
}

var blackHoleTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(BLACKHOLE_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(BH_TUNING_SCHEMA).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : BH_TUNING_SCHEMA[key].def;
    var next = bhTuningClamp(key, raw);
    out[key] = next === null ? BH_TUNING_SCHEMA[key].def : next;
  });
  return out;
})();

function bhTuningSave() {
  try { window.localStorage.setItem(BLACKHOLE_TUNING_STORE_KEY, JSON.stringify(blackHoleTuning)); } catch (_) {}
}

function bhTuningFormat(key) {
  var spec = BH_TUNING_SCHEMA[key];
  if (!spec) return '';
  var value = blackHoleTuning[key];
  if (spec.kind === 'bool') return value > 0 ? '开' : '关';
  if (spec.kind === 'deg') return Math.round(value) + '°';
  if (spec.kind === 'sec') return (Math.round(value * 100) / 100) + 's';
  if (spec.kind === 'px') return Math.round(value) + 'px';
  // World-unit knobs are distances in the scene's own scale, not percentages of anything.
  if (spec.kind === 'unit') return (Math.round(value * 100) / 100) + 'u';
  if (spec.kind === 'count') return String(Math.round(value));
  return Math.round(value * 100) + '%';
}

function bhTuningSyncInputs() {
  Object.keys(BH_TUNING_SCHEMA).forEach(function (key) {
    var spec = BH_TUNING_SCHEMA[key];
    if (spec.kind === 'bool') {
      var toggle = document.getElementById('t-bh' + key);
      if (toggle && toggle.classList) toggle.classList.toggle('on', blackHoleTuning[key] > 0);
      return;
    }
    var input = document.getElementById('fx-bh' + key);
    if (!input) return;
    input.value = String(blackHoleTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = bhTuningFormat(key);
  });
}

// 'pass' resizes the render target, 'lyric' re-lays the flight, 'live' is read every frame. With
// nothing playing the main loop parks, so a knob change has to wake it rather than wait.
function bhTuningApply(key) {
  if (typeof blackHolePresetIsActive !== 'function' || !blackHolePresetIsActive()) return true;
  var spec = BH_TUNING_SCHEMA[key];
  if (!spec) return false;
  if (spec.rebuild === 'pass' && typeof bhAlignPassSize === 'function') bhAlignPassSize();
  // 'field' is a structural change to the galaxy: the buffer is rebuilt here rather than waiting
  // for the frame loop, so a knob drag does not leave the old star count on screen for a frame.
  if (spec.rebuild === 'field' && typeof bhBuildGalaxy === 'function') bhBuildGalaxy(false);
  if (spec.rebuild === 'lyric' && typeof blackHoleFlight !== 'undefined') blackHoleFlight.time = 0;
  if (typeof markRenderInteraction === 'function') markRenderInteraction('blackhole-tuning');
  return true;
}

function setBlackHoleTuning(key, value) {
  var spec = BH_TUNING_SCHEMA[key];
  var next = bhTuningClamp(key, value);
  if (!spec || next === null) return false;
  blackHoleTuning[key] = next;
  bhTuningSave();
  bhTuningSyncInputs();
  bhTuningApply(key);
  return true;
}

function toggleBlackHoleTuning(key) {
  var spec = BH_TUNING_SCHEMA[key];
  if (!spec || spec.kind !== 'bool') return false;
  return setBlackHoleTuning(key, blackHoleTuning[key] > 0 ? 0 : 1);
}

// One knob back to its own default, from the round button its row carries. The app's other
// sliders get that button from ensureFxSliderResetButton, which reads fxDefaults; these knobs
// live in their own store, so the row's button is wired to the schema default.
function resetBlackHoleTuningValue(id, key, btn) {
  var spec = BH_TUNING_SCHEMA[key];
  if (!spec) return false;
  var ok = setBlackHoleTuning(key, spec.def);
  if (!ok) return false;
  if (typeof animateFxResetButton === 'function') animateFxResetButton(btn);
  if (typeof showToast === 'function') showToast('已恢复默认数值');
  return true;
}

function bindBlackHoleTuningResetButtons() {
  if (typeof ensureFxSliderResetButton !== 'function') return;
  Object.keys(BH_TUNING_SCHEMA).forEach(function (key) {
    // A switch resets by being flipped back, so only the sliders carry the round button.
    if (BH_TUNING_SCHEMA[key].kind === 'bool') return;
    ensureFxSliderResetButton('fx-bh' + key, key, resetBlackHoleTuningValue);
  });
}

function resetBlackHoleTuning() {
  Object.keys(BH_TUNING_SCHEMA).forEach(function (key) {
    blackHoleTuning[key] = BH_TUNING_SCHEMA[key].def;
  });
  bhTuningSave();
  bhTuningSyncInputs();
  bhTuningApply('pass');
  if (typeof showToast === 'function') showToast('银河黑洞参数已恢复默认');
  return true;
}

function initBlackHoleTuningControls() {
  bindBlackHoleTuningResetButtons();
  bhTuningSyncInputs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBlackHoleTuningControls);
else initBlackHoleTuningControls();
