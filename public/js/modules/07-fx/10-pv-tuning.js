'use strict';

// Live tuning for the lyric-PV layer, exposed as the 动效 → 歌词 PV group in the visual console.
//
// These four are read by JIZURA's frame() out of plan.fx on every drawing, so a change here takes
// effect without re-planning: the archive stays exactly as planned, only the drawing dials are
// overridden (frame() reads fx.texture for the bloom/grain/vignette pass and fx.motion/glitch/
// chroma per cut). Cut count, style, unify, aspect and koma are plan-time decisions - changing
// them means a different archive, so they are deliberately not offered here.
var PV_TUNING_STORE_KEY = 'mineradio-pv-tuning-v1';
var PV_TUNING_FIELDS = { motion: 0.7, glitch: 0.55, chroma: 0.7, texture: 0.6 };
var pvTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(PV_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(PV_TUNING_FIELDS).forEach(function (key) {
    var value = saved && isFinite(Number(saved[key])) ? Number(saved[key]) : PV_TUNING_FIELDS[key];
    out[key] = Math.min(1, Math.max(0, value));
  });
  return out;
})();

function pvTuningSave() {
  try { window.localStorage.setItem(PV_TUNING_STORE_KEY, JSON.stringify(pvTuning)); } catch (_) {}
}

function pvTuningSyncInputs() {
  Object.keys(PV_TUNING_FIELDS).forEach(function (key) {
    var input = document.getElementById('fx-pv' + key);
    if (!input) return;
    input.value = String(pvTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = Math.round(pvTuning[key] * 100) + '%';
  });
}

// Called after every plan load (17-pv-preset.js) and after every change here.
function applyPvTuningToPlan() {
  var plan = (typeof pvPresetState !== 'undefined' && pvPresetState) ? pvPresetState.plan : null;
  if (!plan || !plan.fx) return false;
  Object.keys(PV_TUNING_FIELDS).forEach(function (key) { plan.fx[key] = pvTuning[key]; });
  return true;
}

function setPvTuning(key, value) {
  if (!Object.prototype.hasOwnProperty.call(PV_TUNING_FIELDS, key)) return false;
  var next = Number(value);
  if (!isFinite(next)) return false;
  pvTuning[key] = Math.min(1, Math.max(0, next));
  pvTuningSave();
  pvTuningSyncInputs();
  applyPvTuningToPlan();
  // Draw once immediately: with nothing playing the main loop parks, so a change would otherwise
  // wait for the next wake-up (the same trap the preset switch hit).
  if (typeof applyPvPresetNow === 'function') { try { applyPvPresetNow(); } catch (_) {} }
  return true;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pvTuningSyncInputs);
else pvTuningSyncInputs();
