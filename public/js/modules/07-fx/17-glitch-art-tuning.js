'use strict';

// Tuning for 故障艺术 (preset 19), exposed as 动效 → 故障艺术 in the visual console.
// Defaults live in GLITCH_SCHEMA (02-visual/24-glitch-art-preset.js); this file is the store and
// the console bindings. Not part of `fx`: these values only mean something while the preset is on.

var GLITCH_ART_TUNING_STORE_KEY = 'mineradio-glitch-art-tuning-v1';

function glitchTuningClamp(key, value) {
  var spec = GLITCH_SCHEMA[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  return Math.min(spec.max, Math.max(spec.min, next));
}

var glitchArtTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(GLITCH_ART_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(GLITCH_SCHEMA).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : GLITCH_SCHEMA[key].def;
    var next = glitchTuningClamp(key, raw);
    out[key] = next === null ? GLITCH_SCHEMA[key].def : next;
  });
  return out;
})();

function glitchArtTuningSave() {
  try { window.localStorage.setItem(GLITCH_ART_TUNING_STORE_KEY, JSON.stringify(glitchArtTuning)); } catch (_) {}
}

function glitchArtTuningFormat(key) {
  var spec = GLITCH_SCHEMA[key];
  if (!spec) return '';
  var value = glitchArtTuning[key];
  if (spec.kind === 'bool') return value > 0 ? '开' : '关';
  if (spec.kind === 'count') return String(Math.round(value));
  return Math.round(value * 100) + '%';
}

function glitchArtTuningSyncInputs() {
  Object.keys(GLITCH_SCHEMA).forEach(function (key) {
    var spec = GLITCH_SCHEMA[key];
    if (spec.kind === 'bool') {
      var toggle = document.getElementById('t-glitch' + key);
      if (toggle && toggle.classList) toggle.classList.toggle('on', glitchArtTuning[key] > 0);
      return;
    }
    var input = document.getElementById('fx-glitch' + key);
    if (!input) return;
    input.value = String(glitchArtTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = glitchArtTuningFormat(key);
  });
}

function glitchArtTuningApply(key) {
  if (typeof glitchPresetIsActive !== 'function' || !glitchPresetIsActive()) return true;
  var spec = GLITCH_SCHEMA[key];
  if (spec && spec.rebuild === 'pass' && typeof glitchAlignPassSize === 'function') glitchAlignPassSize();
  if (typeof markRenderInteraction === 'function') markRenderInteraction('glitch-art-tuning');
  return true;
}

function setGlitchTuning(key, value) {
  var spec = GLITCH_SCHEMA[key];
  var next = glitchTuningClamp(key, value);
  if (!spec || next === null) return false;
  glitchArtTuning[key] = next;
  glitchArtTuningSave();
  glitchArtTuningSyncInputs();
  glitchArtTuningApply(key);
  return true;
}

function toggleGlitchTuning(key) {
  var spec = GLITCH_SCHEMA[key];
  if (!spec || spec.kind !== 'bool') return false;
  return setGlitchTuning(key, glitchArtTuning[key] > 0 ? 0 : 1);
}

function resetGlitchTuningValue(id, key, btn) {
  var spec = GLITCH_SCHEMA[key];
  if (!spec) return false;
  if (!setGlitchTuning(key, spec.def)) return false;
  if (typeof animateFxResetButton === 'function') animateFxResetButton(btn);
  if (typeof showToast === 'function') showToast('已恢复默认数值');
  return true;
}

function bindGlitchTuningResetButtons() {
  if (typeof ensureFxSliderResetButton !== 'function') return;
  Object.keys(GLITCH_SCHEMA).forEach(function (key) {
    if (GLITCH_SCHEMA[key].kind === 'bool') return;
    ensureFxSliderResetButton('fx-glitch' + key, key, resetGlitchTuningValue);
  });
}

function resetGlitchTuning() {
  Object.keys(GLITCH_SCHEMA).forEach(function (key) {
    glitchArtTuning[key] = GLITCH_SCHEMA[key].def;
  });
  glitchArtTuningSave();
  glitchArtTuningSyncInputs();
  glitchArtTuningApply('renderScale');
  if (typeof showToast === 'function') showToast('故障艺术参数已恢复默认');
  return true;
}

function initGlitchTuningControls() {
  glitchArtTuningSave();
  bindGlitchTuningResetButtons();
  glitchArtTuningSyncInputs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGlitchTuningControls);
else initGlitchTuningControls();
