'use strict';

// Tuning for DVD待机 (preset 20), exposed as 动效 → DVD待机 in the visual console.
// Defaults live in DVD_SCHEMA (02-visual/25-dvd-standby-preset.js); this file is the store and the
// console bindings. These values only mean something while the preset is on.

var DVD_STANDBY_TUNING_STORE_KEY = 'mineradio-dvd-standby-tuning-v2';

function dvdTuningClamp(key, value) {
  var spec = DVD_SCHEMA[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  return Math.min(spec.max, Math.max(spec.min, next));
}

var dvdStandbyTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(DVD_STANDBY_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(DVD_SCHEMA).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : DVD_SCHEMA[key].def;
    var next = dvdTuningClamp(key, raw);
    out[key] = next === null ? DVD_SCHEMA[key].def : next;
  });
  return out;
})();

function dvdStandbyTuningSave() {
  try { window.localStorage.setItem(DVD_STANDBY_TUNING_STORE_KEY, JSON.stringify(dvdStandbyTuning)); } catch (_) {}
}

function dvdStandbyTuningFormat(key) {
  var spec = DVD_SCHEMA[key];
  if (!spec) return '';
  var value = dvdStandbyTuning[key];
  if (spec.kind === 'bool') return value > 0 ? '开' : '关';
  if (spec.kind === 'count') return String(Math.round(value));
  if (spec.kind === 'sec') return Math.round(value * 10) / 10 + 's';
  if (key === 'angle') return Math.round(value) + '°';
  if (key === 'gamma' || key === 'bump' || key === 'dashPower') return String(Math.round(value * 100) / 100);
  if (key === 'rippleLife') return String(Math.round(value));
  if (key === 'coverBlur') return Math.round(value) + 'px';
  return Math.round(value * 100) + '%';
}

function dvdStandbyTuningSyncInputs() {
  Object.keys(DVD_SCHEMA).forEach(function (key) {
    var spec = DVD_SCHEMA[key];
    if (spec.kind === 'bool') {
      var toggle = document.getElementById('t-dvd' + key);
      if (toggle && toggle.classList) toggle.classList.toggle('on', dvdStandbyTuning[key] > 0);
      return;
    }
    var input = document.getElementById('fx-dvd' + key);
    if (!input) return;
    input.value = String(dvdStandbyTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = dvdStandbyTuningFormat(key);
  });
}

function dvdStandbyTuningApply() {
  if (typeof dvdPresetIsActive !== 'function' || !dvdPresetIsActive()) return true;
  if (typeof markRenderInteraction === 'function') markRenderInteraction('dvd-standby-tuning');
  return true;
}

function setDvdTuning(key, value) {
  var spec = DVD_SCHEMA[key];
  var next = dvdTuningClamp(key, value);
  if (!spec || next === null) return false;
  dvdStandbyTuning[key] = next;
  dvdStandbyTuningSave();
  dvdStandbyTuningSyncInputs();
  dvdStandbyTuningApply();
  return true;
}

function resetDvdTuningValue(id, key, btn) {
  var spec = DVD_SCHEMA[key];
  if (!spec) return false;
  if (!setDvdTuning(key, spec.def)) return false;
  if (typeof animateFxResetButton === 'function') animateFxResetButton(btn);
  if (typeof showToast === 'function') showToast('已恢复默认数值');
  return true;
}

function toggleDvdTuning(key) {
  var spec = DVD_SCHEMA[key];
  if (!spec || spec.kind !== 'bool') return false;
  return setDvdTuning(key, dvdStandbyTuning[key] > 0 ? 0 : 1);
}

function bindDvdTuningResetButtons() {
  if (typeof ensureFxSliderResetButton !== 'function') return;
  Object.keys(DVD_SCHEMA).forEach(function (key) {
    if (DVD_SCHEMA[key].kind === 'bool') return;
    ensureFxSliderResetButton('fx-dvd' + key, key, resetDvdTuningValue);
  });
}

function resetDvdTuning() {
  Object.keys(DVD_SCHEMA).forEach(function (key) {
    dvdStandbyTuning[key] = DVD_SCHEMA[key].def;
  });
  dvdStandbyTuningSave();
  dvdStandbyTuningSyncInputs();
  dvdStandbyTuningApply();
  if (typeof showToast === 'function') showToast('DVD待机参数已恢复默认');
  return true;
}

function initDvdTuningControls() {
  dvdStandbyTuningSave();
  bindDvdTuningResetButtons();
  dvdStandbyTuningSyncInputs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDvdTuningControls);
else initDvdTuningControls();