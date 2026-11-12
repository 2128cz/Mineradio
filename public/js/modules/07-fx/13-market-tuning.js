'use strict';

// Tuning for 节奏股市 / RHYTHM MARKET (preset 16), exposed as 动效 → 节奏股市 in the visual console.
//
// The knobs live in the preset module (02-visual/21-rhythm-market-preset.js) as
// MARKET_TUNING_SCHEMA, so the defaults have exactly one home; this file is the store and the
// console bindings. Like the ring's, the PV layer's and the hole's, the store is deliberately not
// part of `fx`: these knobs only mean something while the chart is on screen, and folding them
// into fx would push them into every saved visual archive.

var MARKET_TUNING_STORE_KEY = 'mineradio-market-tuning-v1';

function marketTuningClamp(key, value) {
  var spec = MARKET_TUNING_SCHEMA[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  // The transform is radix-2, so the chunk has to be a power of two. Snapping here means the
  // slider, its read-out and the analysis all agree on one number instead of the store holding
  // 5000 while the FFT silently rounds it.
  if (spec.kind === 'pow2') next = Math.pow(2, Math.round(Math.log(next) / Math.LN2));
  return Math.min(spec.max, Math.max(spec.min, next));
}

var marketTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(MARKET_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(MARKET_TUNING_SCHEMA).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : MARKET_TUNING_SCHEMA[key].def;
    var next = marketTuningClamp(key, raw);
    out[key] = next === null ? MARKET_TUNING_SCHEMA[key].def : next;
  });
  return out;
})();

function marketTuningSave() {
  try { window.localStorage.setItem(MARKET_TUNING_STORE_KEY, JSON.stringify(marketTuning)); } catch (_) {}
}

function marketTuningFormat(key) {
  var spec = MARKET_TUNING_SCHEMA[key];
  if (!spec) return '';
  var value = marketTuning[key];
  if (key === 'iconSource') return value > 0.5 ? '内置图形' : '封面通道';
  if (spec.kind === 'bool') return value > 0 ? '开' : '关';
  if (spec.kind === 'deg') return Math.round(value) + '°';
  if (spec.kind === 'sec') return (Math.round(value * 100) / 100) + 's';
  if (spec.kind === 'px') return Math.round(value) + 'px';
  if (spec.kind === 'hz') return Math.round(value) + 'Hz';
  // 0 is not a frequency here, it is "this song's own midline".
  if (spec.kind === 'autoHz') return value > 0 ? (Math.round(value) + 'Hz') : '自动';
  if (spec.kind === 'pow2') return String(Math.round(value));
  // World-unit knobs are distances in the scene's own scale, not percentages of anything.
  if (spec.kind === 'unit') return (Math.round(value * 100) / 100) + 'u';
  if (spec.kind === 'count') return String(Math.round(value));
  return Math.round(value * 100) + '%';
}

function marketTuningSyncInputs() {
  Object.keys(MARKET_TUNING_SCHEMA).forEach(function (key) {
    var spec = MARKET_TUNING_SCHEMA[key];
    if (spec.kind === 'bool') {
      var toggle = document.getElementById('t-mk' + key);
      if (toggle && toggle.classList) toggle.classList.toggle('on', marketTuning[key] > 0);
      return;
    }
    var input = document.getElementById('fx-mk' + key);
    if (!input) return;
    input.value = String(marketTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = marketTuningFormat(key);
  });
}

// 'series' re-measures the song (the signature changes, so the request is not a no-op), 'chart'
// rewrites the candles already on screen, 'wall' re-bakes the backdrop, 'live' is read every
// frame. With nothing playing the main loop parks, so a knob change has to wake it rather than wait.
function marketTuningApply(key) {
  if (typeof marketPresetIsActive !== 'function' || !marketPresetIsActive()) return true;
  var spec = MARKET_TUNING_SCHEMA[key];
  if (!spec) return false;
  if (spec.rebuild === 'series' && typeof marketRequestSeries === 'function') marketRequestSeries(false);
  if (spec.rebuild === 'chart') {
    // Written candles are immutable by design, so a knob that changes their shape has to reset
    // the write cursor - otherwise the new geometry would only apply to candles not yet drawn.
    if (typeof marketBuildChart === 'function') marketBuildChart();
    if (typeof marketUpdateInstances === 'function') marketUpdateInstances();
  }
  if (spec.rebuild === 'wall' && typeof marketBakeWall === 'function') marketBakeWall();
  if (typeof markRenderInteraction === 'function') markRenderInteraction('market-tuning');
  return true;
}

function setMarketTuning(key, value) {
  var spec = MARKET_TUNING_SCHEMA[key];
  var next = marketTuningClamp(key, value);
  if (!spec || next === null) return false;
  marketTuning[key] = next;
  marketTuningSave();
  marketTuningSyncInputs();
  marketTuningApply(key);
  return true;
}

function toggleMarketTuning(key) {
  var spec = MARKET_TUNING_SCHEMA[key];
  if (!spec || spec.kind !== 'bool') return false;
  return setMarketTuning(key, marketTuning[key] > 0 ? 0 : 1);
}

// One knob back to its own default, from the round button its row carries. The app's other
// sliders get that button from ensureFxSliderResetButton, which reads fxDefaults; these knobs
// live in their own store, so the row's button is wired to the schema default.
function resetMarketTuningValue(id, key, btn) {
  var spec = MARKET_TUNING_SCHEMA[key];
  if (!spec) return false;
  var ok = setMarketTuning(key, spec.def);
  if (!ok) return false;
  if (typeof animateFxResetButton === 'function') animateFxResetButton(btn);
  if (typeof showToast === 'function') showToast('已恢复默认数值');
  return true;
}

function bindMarketTuningResetButtons() {
  if (typeof ensureFxSliderResetButton !== 'function') return;
  Object.keys(MARKET_TUNING_SCHEMA).forEach(function (key) {
    // A switch resets by being flipped back, so only the sliders carry the round button.
    if (MARKET_TUNING_SCHEMA[key].kind === 'bool') return;
    ensureFxSliderResetButton('fx-mk' + key, key, resetMarketTuningValue);
  });
}

function resetMarketTuning() {
  Object.keys(MARKET_TUNING_SCHEMA).forEach(function (key) {
    marketTuning[key] = MARKET_TUNING_SCHEMA[key].def;
  });
  marketTuningSave();
  marketTuningSyncInputs();
  // One pass per rebuild kind, not one per key: re-measuring the song 4 times for 4 series knobs
  // would decode it 4 times.
  ['series', 'chart', 'wall'].forEach(function (kind) {
    var key = Object.keys(MARKET_TUNING_SCHEMA).filter(function (k) {
      return MARKET_TUNING_SCHEMA[k].rebuild === kind;
    })[0];
    if (key) marketTuningApply(key);
  });
  if (typeof showToast === 'function') showToast('节奏股市参数已恢复默认');
  return true;
}

function initMarketTuningControls() {
  bindMarketTuningResetButtons();
  marketTuningSyncInputs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMarketTuningControls);
else initMarketTuningControls();