'use strict';

// The PV draw tier is the one place where preset 13 decides to buy frame time with effects, so it
// is tested against the real module source and the real normaliser: a tier that silently sends
// `{}` (or a knob the vendored engine ignores) looks identical to a working one on screen.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const presetSource = read('public/js/modules/02-visual/17-pv-preset.js');
const persistenceSource = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
const defaultsSource = read('public/js/modules/00-state/04-fx-defaults.js');
const { PV_ENGINE_KNOBS } = require('../scripts/pv-draw-bench.js');

// An object built inside the vm has the other realm's Object prototype, which deepStrictEqual
// treats as a different type; flattening it is what makes the comparison about the options.
const plain = (value) => JSON.parse(JSON.stringify(value));

function fragment(source, startMarker, endMarker, name) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${name} could not be located`);
  return source.slice(start, end);
}

function loadTier(pvDrawQuality) {
  const fxDefaults = vm.runInNewContext(
    `(function () {\n${fragment(defaultsSource, 'var fxDefaults = ', '\n};', 'fxDefaults')}\n};\nreturn fxDefaults;\n})()`,
    Object.create(null),
  );
  const script = [
    // fragment() stops before its end marker, so the normaliser's closing brace is added back.
    `${fragment(persistenceSource, 'function normalizePvDrawQuality(v) {', '\n}\n', 'normalizePvDrawQuality')}\n}\n`,
    fragment(presetSource, 'var PV_TIER_BUILDERS = {', '\nfunction pvPresetIsActive', 'PV tier'),
    '({ pvDrawTier: pvDrawTier, PV_TIER_BUILDERS: PV_TIER_BUILDERS, pvDrawOptions: function (scale) { return pvTierOptions(pvDrawTier(), scale); } })',
  ].join('\n');
  const sandbox = { fxDefaults, fx: { pvDrawQuality } };
  const api = vm.runInNewContext(script, sandbox);
  return { api, sandbox };
}

test('the default setting is 自动 and it draws the untouched 效果档 options', () => {
  const defaultsText = defaultsSource;
  assert.match(defaultsText, /pvDrawQuality: 'auto'/, 'first launch must not degrade the picture');
  const { api } = loadTier('auto');
  assert.strictEqual(api.pvDrawTier(), 'full', 'auto may only downgrade on measured pressure');
  assert.deepStrictEqual(plain(api.pvDrawOptions(1.5)), { scale: 1.5 });
});

test('效果档 and 性能档 send exactly the options the bench measured', () => {
  assert.deepStrictEqual(plain(loadTier('full').api.pvDrawOptions(2)), { scale: 2 });
  assert.deepStrictEqual(plain(loadTier('lean').api.pvDrawOptions(2)), { scale: 2, fast: true, noTrans: true });
  // Every knob a tier sends must be one the vendored engine is known to read.
  const known = new Set(['scale'].concat(PV_ENGINE_KNOBS.map((k) => k.name)));
  for (const tier of Object.keys(loadTier('full').api.PV_TIER_BUILDERS)) {
    for (const key of Object.keys(loadTier('full').api.PV_TIER_BUILDERS[tier](1))) {
      assert.ok(known.has(key), `tier ${tier} sends ${key}, which no bench knob nor the engine documents`);
    }
  }
});

test('an unknown or missing tier setting falls back to the default instead of throwing mid-frame', () => {
  for (const value of [undefined, null, '', 'cheap', 'FAST', 0, {}, 'lean ']) {
    const { api } = loadTier(value);
    assert.strictEqual(api.pvDrawTier(), 'full',
      `${JSON.stringify(value)} must fall back to the full picture, never invent a tier`);
  }
  assert.strictEqual(loadTier('lean ').api.pvDrawTier(), 'full', 'a padded value is not a tier');
  assert.strictEqual(loadTier('lean').api.pvDrawTier(), 'lean');
});

test('the tier is decided per frame, so switching mid-song needs no rebuild', () => {
  const { api, sandbox } = loadTier('full');
  assert.deepStrictEqual(plain(api.pvDrawOptions(1)), { scale: 1 });
  sandbox.fx.pvDrawQuality = 'lean';
  assert.deepStrictEqual(plain(api.pvDrawOptions(1)), { scale: 1, fast: true, noTrans: true });
  assert.strictEqual(api.pvDrawTier(), 'lean');
});

test('the draw call and the status surface both go through the tier', () => {
  assert.match(presetSource, /renderer\.frame\(ctx, plan, t, pvTierOptions\(tier, w \/ planW\)\)/,
    'the koma draw must use the resolved tier, not a literal option object');
  assert.match(presetSource, /pvPresetState\.tier = tier;/, 'the tier actually drawn must be recorded');
  assert.match(presetSource, /tierNow: pvDrawTier\(\)/, 'status must show what the next frame would draw');
  assert.match(presetSource, /tierSetting: typeof normalizePvDrawQuality/, 'status must show what the user picked');
  // The warm pass is offscreen glyph work; it must stay on its own cheap options.
  assert.match(presetSource, /renderer\.frame\(ctx, plan, t, \{ scale: scale, noGhost: true, noPost: true, noHud: true \}\)/);
});

test('the tier is wired through persistence, archives, panel and the console', () => {
  const html = read('public/index.html');
  assert.match(html, /id="pv-draw-quality-seg"/);
  for (const mode of ['auto', 'full', 'lean']) {
    assert.ok(html.includes(`data-pv-draw-quality="${mode}"`), `missing the ${mode} button`);
  }
  assert.match(persistenceSource, /pvDrawQuality: normalizePvDrawQuality\(raw\.pvDrawQuality\)/, 'load path');
  assert.match(persistenceSource, /pvDrawQuality: normalizePvDrawQuality\(fx\.pvDrawQuality\)/, 'save path');
  assert.match(persistenceSource, /pvDrawQuality: \['pvDrawQuality'\]/, 'touched-keys map');
  const archive = read('public/js/modules/07-fx/00-preset-archive-data.js');
  assert.match(archive, /'gestureSensitivity',\n\s*'pvDrawQuality'\n\];/, 'MR2 fields must stay append-only');
  assert.match(archive, /pvDrawQuality: normalizePvDrawQuality\(raw\.pvDrawQuality\)/, 'archive apply path');
  const panel = read('public/js/modules/07-fx/05-fx-panel-performance.js');
  assert.match(panel, /function setPvDrawQualityMode\(mode, silent\)/);
  assert.match(panel, /reason: 'pvDrawQuality'/);
  assert.match(panel, /#pv-draw-quality-seg \[data-pv-draw-quality\]/);
  const bindings = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
  assert.match(bindings, /#pv-draw-quality-seg \[data-pv-draw-quality\][\s\S]{0,160}setPvDrawQualityMode/);
  const workspace = read('public/js/modules/07-fx/09-console-workspace.js');
  assert.match(workspace, /fxConsoleItem\('pv-draw-quality-seg'/);
  const packaged = JSON.parse(read('public/default-user-fx-archive.json'));
  assert.strictEqual(packaged.snapshot.pvDrawQuality, 'auto', 'packaged first-launch archive must match the default');
});
