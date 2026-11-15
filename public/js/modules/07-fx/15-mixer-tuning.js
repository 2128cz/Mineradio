'use strict';

// Tuning for the mixing desk (preset 17), exposed as 动效 → 调音台 in the visual console.
//
// The knobs live in the preset module (02-visual/22-mixer-desk-preset.js) as MIXER_TUNING_SCHEMA,
// so the defaults have one home; this file is the store and the console bindings. It is not part
// of `fx`: these values only mean something while the desk is on screen.

var MIXER_TUNING_STORE_KEY = 'mineradio-mixer-tuning-v2';

function mixerTuningClamp(key, value) {
  var spec = MIXER_TUNING_SCHEMA[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  return Math.min(spec.max, Math.max(spec.min, next));
}

var mixerTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(MIXER_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(MIXER_TUNING_SCHEMA).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : MIXER_TUNING_SCHEMA[key].def;
    var next = mixerTuningClamp(key, raw);
    out[key] = next === null ? MIXER_TUNING_SCHEMA[key].def : next;
  });
  return out;
})();

function mixerTuningSave() {
  try { window.localStorage.setItem(MIXER_TUNING_STORE_KEY, JSON.stringify(mixerTuning)); } catch (_) {}
}

function mixerTuningFormat(key) {
  var spec = MIXER_TUNING_SCHEMA[key];
  if (!spec) return '';
  var value = mixerTuning[key];
  if (spec.kind === 'bool') return value > 0 ? '开' : '关';
  if (spec.kind === 'count') return String(Math.round(value));
  if (spec.kind === 'deg') return Math.round(value) + '°';
  if (spec.kind === 'sec') return (Math.round(value * 100) / 100) + 's';
  if (spec.kind === 'unit') return (Math.round(value * 100) / 100) + 'u';
  return Math.round(value * 100) + '%';
}

function mixerTuningSyncInputs() {
  Object.keys(MIXER_TUNING_SCHEMA).forEach(function (key) {
    var spec = MIXER_TUNING_SCHEMA[key];
    if (spec.kind === 'bool') {
      var toggle = document.getElementById('t-mixer' + key);
      if (toggle && toggle.classList) toggle.classList.toggle('on', mixerTuning[key] > 0);
      return;
    }
    var input = document.getElementById('fx-mixer' + key);
    if (!input) return;
    input.value = String(mixerTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = mixerTuningFormat(key);
  });
}

// Every knob is a uniform read by the next frame; renderScale resizes the offscreen pass at once.
// With nothing playing the main loop parks, so a change has to wake it.
function mixerTuningApply(key) {
  if (typeof mixerPresetIsActive !== 'function' || !mixerPresetIsActive()) return true;
  var spec = MIXER_TUNING_SCHEMA[key];
  if (spec && spec.rebuild === 'pass' && typeof mixerAlignPassSize === 'function') mixerAlignPassSize();
  if (typeof markRenderInteraction === 'function') markRenderInteraction('mixer-tuning');
  return true;
}

function setMixerTuning(key, value) {
  var spec = MIXER_TUNING_SCHEMA[key];
  var next = mixerTuningClamp(key, value);
  if (!spec || next === null) return false;
  mixerTuning[key] = next;
  mixerTuningSave();
  mixerTuningSyncInputs();
  mixerTuningApply(key);
  return true;
}

function toggleMixerTuning(key) {
  var spec = MIXER_TUNING_SCHEMA[key];
  if (!spec || spec.kind !== 'bool') return false;
  return setMixerTuning(key, mixerTuning[key] > 0 ? 0 : 1);
}

// One knob back to its own default, from the round button its row carries.
function resetMixerTuningValue(id, key, btn) {
  var spec = MIXER_TUNING_SCHEMA[key];
  if (!spec) return false;
  if (!setMixerTuning(key, spec.def)) return false;
  if (typeof animateFxResetButton === 'function') animateFxResetButton(btn);
  if (typeof showToast === 'function') showToast('已恢复默认数值');
  return true;
}

function bindMixerTuningResetButtons() {
  if (typeof ensureFxSliderResetButton !== 'function') return;
  Object.keys(MIXER_TUNING_SCHEMA).forEach(function (key) {
    if (MIXER_TUNING_SCHEMA[key].kind === 'bool') return;
    ensureFxSliderResetButton('fx-mixer' + key, key, resetMixerTuningValue);
  });
}

function resetMixerTuning() {
  Object.keys(MIXER_TUNING_SCHEMA).forEach(function (key) {
    mixerTuning[key] = MIXER_TUNING_SCHEMA[key].def;
  });
  mixerTuningSave();
  mixerTuningSyncInputs();
  mixerTuningApply('renderScale');
  if (typeof showToast === 'function') showToast('调音台参数已恢复默认');
  return true;
}

function initMixerTuningControls() {
  mixerTuningSave();
  bindMixerTuningResetButtons();
  mixerTuningSyncInputs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMixerTuningControls);
else initMixerTuningControls();
