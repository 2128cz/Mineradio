'use strict';

// Tuning for the Nyan town (preset 18), exposed as 动效 → 彩虹猫小镇 in the visual console.
//
// The knobs live in the preset module (02-visual/23-nyan-town-preset.js) as NYAN_TOWN_TUNING_SCHEMA,
// so the defaults have one home; this file is the store and the console bindings. It is not part
// of `fx`: these values only mean something while the town is on screen.

var NYAN_TOWN_TUNING_STORE_KEY = 'mineradio-nyan-town-tuning-v3';

function nyanTownTuningClamp(key, value) {
  var spec = NYAN_TOWN_TUNING_SCHEMA[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  return Math.min(spec.max, Math.max(spec.min, next));
}

var nyanTownTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(NYAN_TOWN_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(NYAN_TOWN_TUNING_SCHEMA).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : NYAN_TOWN_TUNING_SCHEMA[key].def;
    var next = nyanTownTuningClamp(key, raw);
    out[key] = next === null ? NYAN_TOWN_TUNING_SCHEMA[key].def : next;
  });
  return out;
})();

function nyanTownTuningSave() {
  try { window.localStorage.setItem(NYAN_TOWN_TUNING_STORE_KEY, JSON.stringify(nyanTownTuning)); } catch (_) {}
}

function nyanTownTuningFormat(key) {
  var spec = NYAN_TOWN_TUNING_SCHEMA[key];
  if (!spec) return '';
  var value = nyanTownTuning[key];
  if (spec.kind === 'bool') return value > 0 ? '开' : '关';
  if (spec.kind === 'count') return String(Math.round(value));
  if (spec.kind === 'unit') return (Math.round(value * 1000) / 1000) + 'u';
  if (spec.kind === 'sec') return (Math.round(value * 100) / 100) + 's';
  if (spec.kind === 'deg') return Math.round(value) + '°';
  return Math.round(value * 100) + '%';
}

function nyanTownTuningSyncInputs() {
  Object.keys(NYAN_TOWN_TUNING_SCHEMA).forEach(function (key) {
    var spec = NYAN_TOWN_TUNING_SCHEMA[key];
    if (spec.kind === 'bool') {
      var toggle = document.getElementById('t-nyan' + key);
      if (toggle && toggle.classList) toggle.classList.toggle('on', nyanTownTuning[key] > 0);
      return;
    }
    var input = document.getElementById('fx-nyan' + key);
    if (!input) return;
    input.value = String(nyanTownTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = nyanTownTuningFormat(key);
  });
}

// Every knob is a uniform read by the next frame; renderScale resizes the offscreen pass at once.
// With nothing playing the main loop parks, so a change has to wake it.
function nyanTownTuningApply(key) {
  if (typeof nyanTownPresetIsActive !== 'function' || !nyanTownPresetIsActive()) return true;
  var spec = NYAN_TOWN_TUNING_SCHEMA[key];
  if (spec && spec.rebuild === 'pass' && typeof nyanTownAlignPassSize === 'function') nyanTownAlignPassSize();
  if (typeof markRenderInteraction === 'function') markRenderInteraction('nyan-town-tuning');
  return true;
}

function setNyanTownTuning(key, value) {
  var spec = NYAN_TOWN_TUNING_SCHEMA[key];
  var next = nyanTownTuningClamp(key, value);
  if (!spec || next === null) return false;
  nyanTownTuning[key] = next;
  nyanTownTuningSave();
  nyanTownTuningSyncInputs();
  nyanTownTuningApply(key);
  return true;
}

function toggleNyanTownTuning(key) {
  var spec = NYAN_TOWN_TUNING_SCHEMA[key];
  if (!spec || spec.kind !== 'bool') return false;
  return setNyanTownTuning(key, nyanTownTuning[key] > 0 ? 0 : 1);
}

// One knob back to its own default, from the round button its row carries.
function resetNyanTownTuningValue(id, key, btn) {
  var spec = NYAN_TOWN_TUNING_SCHEMA[key];
  if (!spec) return false;
  if (!setNyanTownTuning(key, spec.def)) return false;
  if (typeof animateFxResetButton === 'function') animateFxResetButton(btn);
  if (typeof showToast === 'function') showToast('已恢复默认数值');
  return true;
}

function bindNyanTownTuningResetButtons() {
  if (typeof ensureFxSliderResetButton !== 'function') return;
  Object.keys(NYAN_TOWN_TUNING_SCHEMA).forEach(function (key) {
    if (NYAN_TOWN_TUNING_SCHEMA[key].kind === 'bool') return;
    ensureFxSliderResetButton('fx-nyan' + key, key, resetNyanTownTuningValue);
  });
}

function resetNyanTownTuning() {
  Object.keys(NYAN_TOWN_TUNING_SCHEMA).forEach(function (key) {
    nyanTownTuning[key] = NYAN_TOWN_TUNING_SCHEMA[key].def;
  });
  nyanTownTuningSave();
  nyanTownTuningSyncInputs();
  nyanTownTuningApply('renderScale');
  if (typeof showToast === 'function') showToast('彩虹猫小镇参数已恢复默认');
  return true;
}

function initNyanTownTuningControls() {
  nyanTownTuningSave();
  bindNyanTownTuningResetButtons();
  nyanTownTuningSyncInputs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNyanTownTuningControls);
else initNyanTownTuningControls();
