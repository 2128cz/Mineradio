'use strict';

// Tuning for the HALO ring (preset 14), exposed as 动效 → 环形数据流 in the visual console.
//
// The knobs themselves live in the preset module (02-visual/18-halo-ring-preset.js) as
// HALO_TUNING_SCHEMA, so the defaults have exactly one home; this file is the store and
// the console bindings.
//
// The store is deliberately not part of the generic `fx` object: the ring's knobs only
// mean something while the ring is on screen, and folding them into fx would push ring
// specific values into every saved preset archive.

var HALO_TUNING_STORE_KEY = 'mineradio-halo-tuning-v1';

function haloTuningClamp(key, value) {
  var spec = HALO_TUNING_SCHEMA[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  return Math.min(spec.max, Math.max(spec.min, next));
}

var haloTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(HALO_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(HALO_TUNING_SCHEMA).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : HALO_TUNING_SCHEMA[key].def;
    var next = haloTuningClamp(key, raw);
    out[key] = next === null ? HALO_TUNING_SCHEMA[key].def : next;
  });
  return out;
})();

function haloTuningSave() {
  try { window.localStorage.setItem(HALO_TUNING_STORE_KEY, JSON.stringify(haloTuning)); } catch (_) {}
}

function haloTuningFormat(key) {
  var spec = HALO_TUNING_SCHEMA[key];
  if (!spec) return '';
  var value = haloTuning[key];
  if (spec.kind === 'bool') return value > 0 ? '开' : '关';
  if (spec.kind === 'count') return String(Math.round(value));
  if (spec.kind === 'deg') return Math.round(value) + '°';
  if (spec.kind === 'px') return Math.round(value) + 'px';
  if (spec.kind === 'sec') return (Math.round(value * 100) / 100) + 's';
  return Math.round(value * 100) + '%';
}

function haloTuningSyncInputs() {
  Object.keys(HALO_TUNING_SCHEMA).forEach(function (key) {
    var spec = HALO_TUNING_SCHEMA[key];
    if (spec.kind === 'bool') {
      // A bool is one of the console's switches, not a slider: its state is the `on` class.
      var toggle = document.getElementById('t-halo' + key);
      if (toggle && toggle.classList) toggle.classList.toggle('on', haloTuning[key] > 0);
      return;
    }
    var input = document.getElementById('fx-halo' + key);
    if (!input) return;
    input.value = String(haloTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = haloTuningFormat(key);
  });
}

// A knob is either a rebuild of the baked stage, a rebuild of the lyric list, or a
// redraw only. The ring is not on screen most of the time: when it is not, the value is
// simply remembered and the ring is built with it the next time it comes up.
function haloTuningApply(key) {
  var spec = HALO_TUNING_SCHEMA[key];
  if (!spec) return false;
  var active = typeof haloPresetIsActive === 'function' && haloPresetIsActive();
  if (active && spec.rebuild === 'stage' && typeof haloRebuild === 'function') {
    try { haloRebuild(); } catch (_) {}
  } else if (active && spec.rebuild === 'lyric' && typeof haloBuildLyricRing === 'function') {
    try { haloBuildLyricRing(); } catch (_) {}
  }
  // With nothing playing the main loop parks, so the redraw has to be forced.
  if (active && typeof applyHaloPresetNow === 'function') {
    try { applyHaloPresetNow(); } catch (_) {}
  }
  return true;
}

function setHaloTuning(key, value) {
  var spec = HALO_TUNING_SCHEMA[key];
  var next = haloTuningClamp(key, value);
  if (!spec || next === null) return false;
  haloTuning[key] = next;
  haloTuningSave();
  haloTuningSyncInputs();
  haloTuningApply(key);
  return true;
}

// A bool knob is one of the console's switches, so it needs the flip rather than a value.
function toggleHaloTuning(key) {
  var spec = HALO_TUNING_SCHEMA[key];
  if (!spec || spec.kind !== 'bool') return false;
  return setHaloTuning(key, haloTuning[key] > 0 ? 0 : 1);
}

function resetHaloTuning() {
  Object.keys(HALO_TUNING_SCHEMA).forEach(function (key) {
    haloTuning[key] = HALO_TUNING_SCHEMA[key].def;
  });
  haloTuningSave();
  haloTuningSyncInputs();
  haloTuningApply('stage');
  if (typeof showToast === 'function') showToast('环形数据流参数已恢复默认');
  return true;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', haloTuningSyncInputs);
else haloTuningSyncInputs();
