'use strict';

// Tuning for the Japanese neon road (preset 16), exposed as 动效 → 日本霓虹 in the visual console.
//
// The knobs live in the preset module (02-visual/21-neon-fuji-preset.js) as NEON_TUNING_SCHEMA,
// so the defaults have exactly one home; this file is the store and the console bindings. The
// defaults are the reference shader's own literals - the pixel bench (scripts/neon-fidelity-bench.js)
// renders with exactly this parameter set, so a default here that drifts from the reference would
// show up there rather than in someone's eyes.

var NEON_TUNING_STORE_KEY = 'mineradio-neon-tuning-v2';
var NEON_TUNING_LEGACY_KEY = 'mineradio-neon-tuning-v1';

function neonTuningClamp(key, value) {
  var spec = NEON_TUNING_SCHEMA[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  return Math.min(spec.max, Math.max(spec.min, next));
}

// v1's carLead was "how long the approach is"; v2's is a signed arrival offset. Carry the old
// number over to carApproach so his tuning survives the change instead of being reinterpreted as
// "arrive 2.4 s early", and start the offset on the new readable-pass default.
function neonTuningMigrate(saved) {
  if (!saved || saved.__model === 2) return saved;
  var legacyLead = Number(saved.carLead);
  if (isFinite(legacyLead) && legacyLead > 0 && saved.carApproach === undefined) saved.carApproach = legacyLead;
  saved.carLead = NEON_TUNING_SCHEMA.carLead.def;
  saved.__model = 2;
  return saved;
}

var neonTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(NEON_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  if (!saved) {
    try { saved = JSON.parse(window.localStorage.getItem(NEON_TUNING_LEGACY_KEY) || 'null'); } catch (_) {}
  }
  saved = neonTuningMigrate(saved);
  Object.keys(NEON_TUNING_SCHEMA).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : NEON_TUNING_SCHEMA[key].def;
    var next = neonTuningClamp(key, raw);
    out[key] = next === null ? NEON_TUNING_SCHEMA[key].def : next;
  });
  return out;
})();

function neonTuningSave() {
  try { window.localStorage.setItem(NEON_TUNING_STORE_KEY, JSON.stringify(neonTuning)); } catch (_) {}
}

function neonTuningFormat(key) {
  var spec = NEON_TUNING_SCHEMA[key];
  if (!spec) return '';
  var value = neonTuning[key];
  if (spec.kind === 'bool') return value > 0 ? '开' : '关';
  if (spec.kind === 'count') return String(Math.round(value));
  if (spec.kind === 'deg') return Math.round(value) + '°';
  if (spec.kind === 'sec') return (Math.round(value * 100) / 100) + 's';
  if (spec.kind === 'unit') return (Math.round(value * 100) / 100) + 'u';
  return Math.round(value * 100) + '%';
}

function neonTuningSyncInputs() {
  Object.keys(NEON_TUNING_SCHEMA).forEach(function (key) {
    var spec = NEON_TUNING_SCHEMA[key];
    if (spec.kind === 'bool') {
      // A bool is one of the console's switches, not a slider: its state is the `on` class.
      var toggle = document.getElementById('t-neon' + key);
      if (toggle && toggle.classList) toggle.classList.toggle('on', neonTuning[key] > 0);
      return;
    }
    var input = document.getElementById('fx-neon' + key);
    if (!input) return;
    input.value = String(neonTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = neonTuningFormat(key);
  });
}

// Every knob here is a uniform read by the next frame, so there is nothing to rebuild - but with
// nothing playing the main loop parks, so the change has to wake it.
function neonTuningApply(key) {
  if (typeof neonPresetIsActive !== 'function' || !neonPresetIsActive()) return true;
  if (typeof markRenderInteraction === 'function') markRenderInteraction('neon-tuning');
  return true;
}

function setNeonTuning(key, value) {
  var spec = NEON_TUNING_SCHEMA[key];
  var next = neonTuningClamp(key, value);
  if (!spec || next === null) return false;
  neonTuning[key] = next;
  neonTuningSave();
  neonTuningSyncInputs();
  neonTuningApply(key);
  return true;
}

function toggleNeonTuning(key) {
  var spec = NEON_TUNING_SCHEMA[key];
  if (!spec || spec.kind !== 'bool') return false;
  return setNeonTuning(key, neonTuning[key] > 0 ? 0 : 1);
}

// One knob back to its own default, from the round button its row carries. The app's other
// sliders get that button from ensureFxSliderResetButton, which reads fxDefaults; these knobs
// live in their own store, so the row's button is wired to the schema default.
function resetNeonTuningValue(id, key, btn) {
  var spec = NEON_TUNING_SCHEMA[key];
  if (!spec) return false;
  var ok = setNeonTuning(key, spec.def);
  if (!ok) return false;
  if (typeof animateFxResetButton === 'function') animateFxResetButton(btn);
  if (typeof showToast === 'function') showToast('已恢复默认数值');
  return true;
}

function bindNeonTuningResetButtons() {
  if (typeof ensureFxSliderResetButton !== 'function') return;
  Object.keys(NEON_TUNING_SCHEMA).forEach(function (key) {
    // A switch resets by being flipped back, so only the sliders carry the round button.
    if (NEON_TUNING_SCHEMA[key].kind === 'bool') return;
    ensureFxSliderResetButton('fx-neon' + key, key, resetNeonTuningValue);
  });
}

function resetNeonTuning() {
  Object.keys(NEON_TUNING_SCHEMA).forEach(function (key) {
    neonTuning[key] = NEON_TUNING_SCHEMA[key].def;
  });
  neonTuningSave();
  neonTuningSyncInputs();
  neonTuningApply('battery');
  if (typeof showToast === 'function') showToast('日本霓虹参数已恢复默认');
  return true;
}

function initNeonTuningControls() {
  // Persist the migration once, so a v1 archive is not re-read (and re-migrated) every launch.
  neonTuningSave();
  bindNeonTuningResetButtons();
  neonTuningSyncInputs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNeonTuningControls);
else initNeonTuningControls();
