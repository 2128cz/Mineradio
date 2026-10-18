'use strict';

// Visual takeover mask: one place that answers "which scene layers does the current
// visual preset own?", instead of each new preset appending more conditions to the
// four `particles.visible = !skull && !workshop && ...` lines in the main loop.
//
// Contract that makes this refactor safe: with no takeover owner registered, every
// flag must equal the historical expression exactly. tests/visual-takeover-mask.test.js
// proves that over preset 0..MAX and the bloom/star-river toggles.
//
// A layer marked suppressed is also skipped in the main loop rather than merely hidden,
// per docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md ("关闭状态必须绕过计算而非置 0").

var VISUAL_TAKEOVER_LAYERS = [
  'particles', 'bloom', 'float', 'backCover',
  'starRiver', 'ripples', 'lyricsParticles', 'stageLyrics'
];

var visualTakeoverOwners = [];

// The renderer's frame loop parks itself when nothing is playing (verified live: with no
// track loaded, __mineradioRenderPerf.lastRenderAt never advances). Visibility flags that
// only get written inside a frame would therefore sit stale exactly when a takeover owner
// registers - the old lyric layer would keep showing until the first frame arrives. The
// scene side registers an applier here so an ownership change lands immediately.
var visualTakeoverApplier = null;

function setVisualTakeoverApplier(applier) {
  visualTakeoverApplier = typeof applier === 'function' ? applier : null;
}

function applyVisualTakeoverNow() {
  if (!visualTakeoverApplier) return false;
  var currentFx = (typeof fx === 'undefined') ? null : fx;
  try {
    visualTakeoverApplier(computeVisualTakeoverMask(currentFx));
  } catch (error) {
    return false;
  }
  return true;
}

function registerVisualTakeoverOwner(owner) {
  var applyNow = function () { applyVisualTakeoverNow(); };
  if (!owner || typeof owner.isActive !== 'function') return function () {};
  var id = String(owner.id || 'anonymous');
  for (var i = 0; i < visualTakeoverOwners.length; i++) {
    if (visualTakeoverOwners[i].id === id) {
      visualTakeoverOwners[i] = owner;
      owner.id = id;
      applyNow();
      return function () { unregisterVisualTakeoverOwner(id); };
    }
  }
  owner.id = id;
  visualTakeoverOwners.push(owner);
  applyNow();
  return function () { unregisterVisualTakeoverOwner(id); };
}

function unregisterVisualTakeoverOwner(id) {
  var key = String(id || '');
  var changed = false;
  for (var i = visualTakeoverOwners.length - 1; i >= 0; i--) {
    if (visualTakeoverOwners[i].id === key) {
      visualTakeoverOwners.splice(i, 1);
      changed = true;
    }
  }
  if (changed) applyVisualTakeoverNow();
}

function visualTakeoverOwnerIds() {
  return visualTakeoverOwners.map(function (owner) { return owner.id; });
}

function ownerAsksFor(owner, layer) {
  if (typeof owner.suppresses === 'function') return !!owner.suppresses(layer);
  return !!(owner.suppresses && owner.suppresses[layer]);
}

function computeVisualTakeoverMask(fx) {
  // Strict equality on purpose: the pre-refactor main loop compared fx.preset with ===
  // against SKULL_PRESET_INDEX, and coercing here would silently change who owns the
  // scene when a preset ever arrives as a string (archive/localStorage path).
  var skull = !!(fx && typeof SKULL_PRESET_INDEX !== 'undefined' && fx.preset === SKULL_PRESET_INDEX);
  var workshop = !!(typeof MineradioSonicWorkshop !== 'undefined' && MineradioSonicWorkshop
    && typeof MineradioSonicWorkshop.isActive === 'function' && MineradioSonicWorkshop.isActive(fx));
  // Star-river-muted presets borrow the particle system for the ring, so muting the
  // river also hides those particles today; that coupling stays in the mask.
  var presetUsesStarRiverParticles = !!(fx && (Number(fx.preset) === 5
    || (typeof SONIC_PRESET_INDEX !== 'undefined' && Number(fx.preset) === SONIC_PRESET_INDEX)));
  var starRiverMuted = presetUsesStarRiverParticles && fx.backgroundStarRiver === false;

  var suppress = {
    particles: !!(skull || workshop || starRiverMuted),
    bloom: !!(skull || workshop || starRiverMuted),
    float: !!(skull || workshop),
    backCover: !!(skull || workshop),
    starRiver: false,
    ripples: false,
    lyricsParticles: false,
    stageLyrics: false
  };

  var activeOwners = [];
  for (var i = 0; i < visualTakeoverOwners.length; i++) {
    var owner = visualTakeoverOwners[i];
    var claimed = false;
    try {
      claimed = !!owner.isActive(fx);
    } catch (error) {
      claimed = false;
    }
    if (!claimed) continue;
    activeOwners.push(owner.id);
    for (var layerIndex = 0; layerIndex < VISUAL_TAKEOVER_LAYERS.length; layerIndex++) {
      var layer = VISUAL_TAKEOVER_LAYERS[layerIndex];
      if (ownerAsksFor(owner, layer)) suppress[layer] = true;
    }
  }

  return {
    skull: skull,
    workshop: workshop,
    starRiverMuted: starRiverMuted,
    owners: activeOwners,
    suppress: suppress
  };
}
