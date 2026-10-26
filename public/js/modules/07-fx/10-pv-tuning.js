'use strict';

// Tuning for the lyric-PV layer, exposed as 动效 → 歌词 PV in the visual console.
//
// Two tiers, because JIZURA decides them at different times:
//   live      motion / glitch / chroma / texture / koma  - frame() reads these out of plan.fx on
//             every drawing, so the layer just overrides them and redraws once
//   plan-time density / unify                            - they change the shots themselves (how
//             many cuts a line is broken into, whether repeated lines reuse a layout), so they
//             are part of the archive key and only take effect through 重新生成
var PV_TUNING_STORE_KEY = 'mineradio-pv-tuning-v1';
var PV_TUNING_FIELDS = {
  motion: { def: 0.7, min: 0, max: 1, kind: 'percent' },
  glitch: { def: 0.55, min: 0, max: 1, kind: 'percent' },
  chroma: { def: 0.7, min: 0, max: 1, kind: 'percent' },
  texture: { def: 0.6, min: 0, max: 1, kind: 'percent' },
  koma: { def: 12, min: 6, max: 24, kind: 'count' },
  density: { def: 0.55, min: 0.05, max: 0.95, kind: 'percent', plan: true },
  unify: { def: 1, min: 0, max: 1, kind: 'bool', plan: true }
};
var pvTuningPlanDirty = false;

function pvTuningClamp(key, value) {
  var spec = PV_TUNING_FIELDS[key];
  var next = Number(value);
  if (!spec || !isFinite(next)) return null;
  return Math.min(spec.max, Math.max(spec.min, next));
}

var pvTuning = (function () {
  var out = {};
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(PV_TUNING_STORE_KEY) || 'null'); } catch (_) {}
  Object.keys(PV_TUNING_FIELDS).forEach(function (key) {
    var raw = saved && saved[key] !== undefined ? saved[key] : PV_TUNING_FIELDS[key].def;
    out[key] = pvTuningClamp(key, raw);
    if (out[key] === null) out[key] = PV_TUNING_FIELDS[key].def;
  });
  return out;
})();

function pvTuningSave() {
  try { window.localStorage.setItem(PV_TUNING_STORE_KEY, JSON.stringify(pvTuning)); } catch (_) {}
}

function pvTuningFormat(key) {
  var spec = PV_TUNING_FIELDS[key];
  if (!spec) return '';
  if (spec.kind === 'bool') return pvTuning[key] >= 0.5 ? '开' : '关';
  if (spec.kind === 'count') return String(Math.round(pvTuning[key]));
  return Math.round(pvTuning[key] * 100) + '%';
}

function pvTuningSyncInputs() {
  Object.keys(PV_TUNING_FIELDS).forEach(function (key) {
    var spec = PV_TUNING_FIELDS[key];
    if (spec.kind === 'bool') {
      // the app's own switch block, not a slider: .fx-toggle carries its state in the .on class
      var toggle = document.getElementById('t-pv' + key);
      if (toggle) toggle.classList.toggle('on', pvTuning[key] >= 0.5);
      return;
    }
    var input = document.getElementById('fx-pv' + key);
    if (!input) return;
    input.value = String(pvTuning[key]);
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (output) output.textContent = pvTuningFormat(key);
  });
  var button = document.getElementById('fx-pvreplan');
  if (button) button.textContent = pvTuningPlanDirty ? '有改动 · 重新生成当前歌' : '重新生成当前歌';
}

function togglePvUnify() {
  return setPvTuning('unify', pvTuning.unify >= 0.5 ? 0 : 1);
}

// The plan-time pair, read by the recipe when a request is built (08-pv-prefetch.js).
function pvTuningPlanParams() {
  return {
    density: Math.round(pvTuning.density * 100) / 100,
    unify: pvTuning.unify >= 0.5,
    koma: Math.round(pvTuning.koma)
  };
}

// The drawing clock: the koma gate uses this instead of the fixed 12.
function pvTuningFps() {
  return Math.min(24, Math.max(6, Math.round(pvTuning.koma)));
}

// Called after every plan load (17-pv-preset.js) and after every live change here.
function applyPvTuningToPlan() {
  var plan = (typeof pvPresetState !== 'undefined' && pvPresetState) ? pvPresetState.plan : null;
  if (!plan || !plan.fx) return false;
  ['motion', 'glitch', 'chroma', 'texture', 'koma'].forEach(function (key) { plan.fx[key] = pvTuning[key]; });
  return true;
}

function pvTuningRedraw() {
  // With nothing playing the main loop parks, so a change would otherwise wait for the next wake-up.
  if (typeof applyPvPresetNow === 'function') { try { applyPvPresetNow(); } catch (_) {} }
}

function setPvTuning(key, value) {
  var spec = PV_TUNING_FIELDS[key];
  var next = pvTuningClamp(key, value);
  if (!spec || next === null) return false;
  pvTuning[key] = next;
  if (spec.plan) pvTuningPlanDirty = true;
  pvTuningSave();
  pvTuningSyncInputs();
  applyPvTuningToPlan();
  pvTuningRedraw();
  return true;
}

// 重新生成: re-plan the song on screen with the current dials. The route drops the stored archive
// for the key first (payload.bust), so this rebuilds even when no dial changed.
function pvTuningReplanClick(button) {
  if (typeof pvRebuildPlanForCurrentSong !== 'function') return Promise.resolve({ ok: false, reason: 'no-plan-client' });
  var label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '正在重新生成…'; }
  return pvRebuildPlanForCurrentSong().then(function (res) {
    if (res && res.ok) {
      pvTuningPlanDirty = false;
      if (typeof showToast === 'function') showToast('PV 已重新生成 · ' + (res.cuts || 0) + ' 个分镜');
    } else if (typeof showToast === 'function') {
      showToast('PV 重新生成失败：' + String((res && res.reason) || 'unknown'));
    }
    return res;
  }).catch(function (err) {
    if (typeof showToast === 'function') showToast('PV 重新生成失败：' + String((err && err.message) || err));
    return { ok: false, reason: String((err && err.message) || err) };
  }).finally(function () {
    if (button) { button.disabled = false; button.textContent = label || '重新生成当前歌'; }
    pvTuningSyncInputs();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pvTuningSyncInputs);
else pvTuningSyncInputs();
