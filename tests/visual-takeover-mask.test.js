'use strict';

// Acceptance criterion for the takeover-mask refactor, pinned BEFORE the refactor shipped:
// with no owner registered, every layer flag must equal the expressions that used to live
// inline in 11-main-loop.js. If this passes, the refactor cannot change what any of the shipped
// presets looks like. The preset range is read from MAX_VISUAL_PRESET_INDEX rather than pinned
// here, so a new preset is covered by this sweep the day it lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_FILE = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '16-visual-takeover.js');
const CORE_FILE = path.join(__dirname, '..', 'public', 'js', 'modules', '00-state', '00-core-stores.js');
const MAX_PRESET = Number((fs.readFileSync(CORE_FILE, 'utf8').match(/MAX_VISUAL_PRESET_INDEX = (\d+)/) || [])[1]);
assert(Number.isInteger(MAX_PRESET) && MAX_PRESET >= 14, `MAX_VISUAL_PRESET_INDEX could not be read (found ${MAX_PRESET})`);

function load(sandboxOverrides) {
  const sandbox = Object.assign({
    SKULL_PRESET_INDEX: 6,
    SONIC_PRESET_INDEX: 7,
    MineradioSonicWorkshop: { isActive: function (fx) { return !!fx && Number(fx.preset) === 8; } },
    console,
  }, sandboxOverrides || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_FILE, 'utf8'), sandbox, { filename: MODULE_FILE });
  return sandbox;
}

// Verbatim transcription of the pre-refactor lines 625-632.
function legacyFlags(fx, workshopActive) {
  const skull = !!(fx && fx.preset === 6);
  const workshop = !!workshopActive;
  const usesStarRiver = !!(fx && (Number(fx.preset) === 5 || Number(fx.preset) === 7));
  const starRiverMuted = usesStarRiver && fx.backgroundStarRiver === false;
  return {
    particles: !!(skull || workshop || starRiverMuted),
    bloom: !!(skull || workshop || starRiverMuted),
    float: !!(skull || workshop),
    backCover: !!(skull || workshop),
    starRiver: false,
    ripples: false,
    lyricsParticles: false,
    stageLyrics: false
  };
}

// The mask is built inside a vm realm, so its object/array prototypes differ from this
// realm's. deepEqual compares prototypes, which would fail regardless of values: compare
// primitives field by field instead, which also pinpoints the offending layer.
const LAYERS = ['particles', 'bloom', 'float', 'backCover', 'starRiver', 'ripples', 'lyricsParticles', 'stageLyrics'];

function assertSuppress(actual, expected, label) {
  LAYERS.forEach((layer) => {
    assert.equal(actual[layer], expected[layer], label + ' layer ' + layer);
  });
}

function assertOwners(actual, expected, label) {
  const list = Array.from(actual || []);
  assert.equal(list.length, expected.length, label + ' owner count');
  expected.forEach((id, index) => assert.equal(list[index], id, label + ' owner ' + index));
}

test('no owner registered: mask equals the inline expressions for every preset and toggle', () => {
  const box = load();
  let compared = 0;
  for (let preset = 0; preset <= MAX_PRESET; preset++) {
    [undefined, true, false].forEach((starRiverToggle) => {
      [true, false].forEach((bloomOn) => {
        [0.0, 0.5].forEach((bloomStrength) => {
          const fx = { preset, backgroundStarRiver: starRiverToggle, bloom: bloomOn, bloomStrength };
          const mask = box.computeVisualTakeoverMask(fx);
          assertSuppress(mask.suppress, legacyFlags(fx, preset === 8), 'preset ' + preset + ' star ' + String(starRiverToggle));
          assert.equal(mask.skull, preset === 6);
          assert.equal(mask.workshop, preset === 8);
          assertOwners(mask.owners, [], 'preset ' + preset);
          compared++;
        });
      });
    });
  }
  assert.ok(compared >= 13 * 3 * 2 * 2, 'expected a wide matrix, compared ' + compared);
});

test('string preset does not gain ownership it did not have before', () => {
  const box = load();
  const mask = box.computeVisualTakeoverMask({ preset: '6', backgroundStarRiver: true });
  assert.equal(mask.skull, false, 'legacy used strict ===, so "6" was never the skull preset');
  assert.equal(mask.suppress.particles, false);
});

test('an owner can claim lyric layers without disturbing the layers it did not ask for', () => {
  const box = load();
  const unregister = box.registerVisualTakeoverOwner({
    id: 'pv',
    isActive: function (fx) { return !!fx && Number(fx.preset) === 13; },
    suppresses: { stageLyrics: true, lyricsParticles: true },
  });

  const offPreset = box.computeVisualTakeoverMask({ preset: 0, backgroundStarRiver: true });
  assert.equal(offPreset.suppress.stageLyrics, false, 'owner inactive on other presets');
  assertOwners(offPreset.owners, [], 'preset 0');

  const onPreset = box.computeVisualTakeoverMask({ preset: 13, backgroundStarRiver: true });
  assert.equal(onPreset.suppress.stageLyrics, true);
  assert.equal(onPreset.suppress.lyricsParticles, true);
  assert.equal(onPreset.suppress.float, false, 'float was never claimed and must stay as before');
  assert.equal(onPreset.suppress.starRiver, false);
  assertOwners(onPreset.owners, ['pv'], 'preset 13');

  unregister();
  assert.equal(box.computeVisualTakeoverMask({ preset: 13 }).suppress.stageLyrics, false, 'after unregister nothing is suppressed');
  assertOwners(box.visualTakeoverOwnerIds(), [], 'after unregister');
});

test('owner can decide suppression per layer with a function', () => {
  const box = load();
  box.registerVisualTakeoverOwner({
    id: 'fn-owner',
    isActive: () => true,
    suppresses: (layer) => layer === 'ripples',
  });
  const mask = box.computeVisualTakeoverMask({ preset: 2 });
  assert.equal(mask.suppress.ripples, true);
  assert.equal(mask.suppress.stageLyrics, false);
});

test('registering the same id replaces the owner instead of stacking duplicates', () => {
  const box = load();
  box.registerVisualTakeoverOwner({ id: 'pv', isActive: () => true, suppresses: { stageLyrics: true } });
  box.registerVisualTakeoverOwner({ id: 'pv', isActive: () => true, suppresses: { ripples: true } });
  assertOwners(box.visualTakeoverOwnerIds(), ['pv'], 'after two registrations of the same id');
  const mask = box.computeVisualTakeoverMask({ preset: 13 });
  assert.equal(mask.suppress.ripples, true);
  assert.equal(mask.suppress.stageLyrics, false, 'the second registration replaced the first, it did not merge');
});

test('a throwing isActive must not suppress anything or break the frame', () => {
  const box = load();
  box.registerVisualTakeoverOwner({
    id: 'broken',
    isActive: function () { throw new Error('owner exploded'); },
    suppresses: { stageLyrics: true, particles: true },
  });
  const mask = box.computeVisualTakeoverMask({ preset: 1, backgroundStarRiver: true });
  assert.equal(mask.suppress.stageLyrics, false);
  assert.equal(mask.suppress.particles, false);
  assertOwners(mask.owners, [], 'broken owner');
});

test('a missing workshop global degrades to no workshop instead of throwing', () => {
  const box = load({ MineradioSonicWorkshop: undefined });
  const mask = box.computeVisualTakeoverMask({ preset: 8, backgroundStarRiver: true });
  assert.equal(mask.workshop, false);
  assert.equal(mask.suppress.particles, false);
});

test('an ownership change applies immediately, without waiting for a rendered frame', () => {
  const box = load();
  const calls = [];
  box.setVisualTakeoverApplier(function (mask) { calls.push(mask.owners.slice()); });

  const unregister = box.registerVisualTakeoverOwner({
    id: 'pv', isActive: () => true, suppresses: { stageLyrics: true }
  });
  assert.equal(calls.length, 1, 'register must apply at once (the render loop can be parked)');
  assert.deepEqual(Array.from(calls[0]), ['pv']);

  unregister();
  assert.equal(calls.length, 2, 'unregister must restore at once too');
  assert.deepEqual(Array.from(calls[1]), []);
});

test('without an applier, registration still works and reports nothing applied', () => {
  const box = load();
  assert.equal(box.applyVisualTakeoverNow(), false);
  const unregister = box.registerVisualTakeoverOwner({ id: 'x', isActive: () => true, suppresses: { ripples: true } });
  assert.equal(box.computeVisualTakeoverMask({ preset: 3 }).suppress.ripples, true);
  unregister();
});

test('a broken applier must not escape into the caller that registered an owner', () => {
  const box = load();
  box.setVisualTakeoverApplier(function () { throw new Error('scene not ready'); });
  const unregister = box.registerVisualTakeoverOwner({ id: 'safe', isActive: () => true, suppresses: { stageLyrics: true } });
  assert.equal(box.applyVisualTakeoverNow(), false);
  unregister();
});

test('main loop consumes the mask, registers the applier, and keeps the gate identifiers', () => {
  const mainLoop = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '11-main-loop.js'), 'utf8');
  assert.match(mainLoop, /var takeoverMask = computeVisualTakeoverMask\(fx\);/);
  assert.match(mainLoop, /var workshopPresetActive = takeoverMask\.workshop;/);
  assert.match(mainLoop, /applyVisualTakeover\(takeoverMask\);/);
  assert.match(mainLoop, /function applyVisualTakeover\(mask\) \{[\s\S]{0,600}stageLyrics\.group\.visible = !mask\.suppress\.stageLyrics/);
  assert.match(mainLoop, /setVisualTakeoverApplier\(applyVisualTakeover\)/);
  // suppressed layers must be skipped outright, not zeroed after running
  assert.match(mainLoop, /if \(stageLyricsStepDt > 0 && !takeoverMask\.suppress\.stageLyrics\) updateStageLyrics3D/);
  assert.match(mainLoop, /if \(lyricsParticleStepDt > 0 && !takeoverMask\.suppress\.lyricsParticles\) tickLyricsParticles/);
  assert.doesNotMatch(mainLoop, /presetStarRiverMuted/, 'the star-river coupling moved into the mask');
});

test('the mask module keeps the star-river/preset coupling the gate depends on', () => {
  const source = fs.readFileSync(MODULE_FILE, 'utf8');
  assert.match(source, /presetUsesStarRiverParticles[\s\S]{0,200}SONIC_PRESET_INDEX/);
  assert.match(source, /fx\.backgroundStarRiver === false/);
});

test('the new module is actually loaded by the renderer', () => {
  const loader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'index-loader.js'), 'utf8');
  assert.match(loader, /'js\/modules\/02-visual\/16-visual-takeover\.js'/);
});
