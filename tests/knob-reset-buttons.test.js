const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { haloSliceFunction } = require('../scripts/halo-arms');

// Every console slider carries a small round button that puts that one slider back to its
// own default. The ring (preset 14) and the lyric PV layer keep their knobs in their own
// stores rather than in fx, so their rows need the button wired to their schema default.
//
// The shipped binding code runs here against a fake DOM with one row per knob, and the
// buttons are actually clicked. The rows are built from the schemas, so a knob that exists
// in the schema but is never bound, or a button that resets the whole store instead of its
// own field, fails this test.

const NL = String.fromCharCode(10);

function modulePath(envName, relative) {
  return process.env[envName] ? path.resolve(process.env[envName]) : path.join(__dirname, '..', relative);
}

const haloModulePath = modulePath('HALO_MODULE_PATH', 'public/js/modules/02-visual/18-halo-ring-preset.js');
const haloTuningPath = modulePath('HALO_TUNING_PATH', 'public/js/modules/07-fx/11-halo-tuning.js');
const pvTuningPath = modulePath('PV_TUNING_PATH', 'public/js/modules/07-fx/10-pv-tuning.js');
const bhModulePath = modulePath('BLACKHOLE_MODULE_PATH', 'public/js/modules/02-visual/19-galaxy-blackhole-preset.js');
const bhTuningPath = modulePath('BLACKHOLE_TUNING_PATH', 'public/js/modules/07-fx/12-blackhole-tuning.js');
const fxPanelPath = modulePath('FX_PANEL_PATH', 'public/js/modules/07-fx/05-fx-panel-performance.js');
const fxDefaultsPath = modulePath('FX_DEFAULTS_PATH', 'public/js/modules/00-state/04-fx-defaults.js');

function between(text, from, until, name) {
  const start = text.indexOf(from);
  const end = text.indexOf(until, start);
  assert.ok(start >= 0 && end > start, name + ' could not be located');
  return text.slice(start, end) + until;
}

function slice(text, name) {
  const body = haloSliceFunction(text, name);
  assert.ok(body, name + ' could not be sliced out of ' + path.basename(fxPanelPath));
  return body;
}

// The two stores' field tables are read straight out of the shipped files.
const haloModuleText = fs.readFileSync(haloModulePath, 'utf8');
const pvTuningText = fs.readFileSync(pvTuningPath, 'utf8');
const bhModuleText = fs.readFileSync(bhModulePath, 'utf8');
const bhTuningText = fs.readFileSync(bhTuningPath, 'utf8');
const haloTuningText = fs.readFileSync(haloTuningPath, 'utf8');
const fxPanelText = fs.readFileSync(fxPanelPath, 'utf8');
const schemaText = between(haloModuleText, 'var HALO_TUNING_SCHEMA = {', '};', 'HALO_TUNING_SCHEMA');
const pvFieldsText = between(pvTuningText, 'var PV_TUNING_FIELDS = {', '};', 'PV_TUNING_FIELDS');
const bhSchemaText = between(bhModuleText, 'var BH_TUNING_SCHEMA = {', '};', 'BH_TUNING_SCHEMA');
const defaultsText = between(fs.readFileSync(fxDefaultsPath, 'utf8'), 'var fxDefaults = {', '};', 'fxDefaults');
const panelText = [
  slice(fxPanelText, 'ensureFxSliderResetButton'),
  slice(fxPanelText, 'resetFxSliderValue'),
  slice(fxPanelText, 'isStageLyricRealtimeFxKey'),
  slice(fxPanelText, 'isDesktopLyricRealtimeFxKey'),
  slice(fxPanelText, 'syncLyricRealtimeFxChange')
].join(NL + NL);

// ---------------------------------------------------------------- the fake DOM

function makeDom() {
  const byId = new Map();

  function matches(node, selector) {
    if (selector.charAt(0) === '.') return (' ' + node.className + ' ').indexOf(' ' + selector.slice(1) + ' ') >= 0;
    return node.tagName === selector;
  }

  function descendants(node, out) {
    node.children.forEach(function (child) { out.push(child); descendants(child, out); });
    return out;
  }

  function el(tag, id) {
    const node = {
      tagName: tag,
      id: id || '',
      className: '',
      children: [],
      parentNode: null,
      handlers: {},
      value: '',
      textContent: '',
      innerHTML: '',
      attrs: {},
      type: '',
      setAttribute(name, value) { node.attrs[name] = value; },
      getAttribute(name) { return node.attrs[name]; },
      appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
      addEventListener(name, fn) { (node.handlers[name] = node.handlers[name] || []).push(fn); },
      matches(selector) { return matches(node, selector); },
      closest(selector) {
        let walk = node;
        while (walk) { if (matches(walk, selector)) return walk; walk = walk.parentNode; }
        return null;
      },
      querySelector(selector) {
        const found = descendants(node, []).filter(function (one) { return matches(one, selector); });
        return found.length ? found[0] : null;
      }
    };
    Object.defineProperty(node, 'parentElement', { get: function () { return node.parentNode; } });
    Object.defineProperty(node, 'classList', {
      get: function () {
        return {
          toggle(name, on) {
            const has = (' ' + node.className + ' ').indexOf(' ' + name + ' ') >= 0;
            const next = on === undefined ? !has : !!on;
            node.className = (node.className + ' ' + name).trim().split(' ').filter(function (one, i, all) {
              return one && all.indexOf(one) === i;
            }).join(' ');
            if (!next && has) node.className = node.className.split(' ').filter(function (one) { return one !== name; }).join(' ');
            return next;
          },
          contains(name) { return (' ' + node.className + ' ').indexOf(' ' + name + ' ') >= 0; }
        };
      }
    });
    if (node.id) byId.set(node.id, node);
    return node;
  }

  // One row per knob, in the shape index.html uses: a .fx-slider div holding label, input, output.
  function sliderRow(id) {
    const row = el('div', '');
    row.className = 'fx-slider';
    row.appendChild(el('label', ''));
    row.appendChild(el('input', id));
    row.appendChild(el('output', ''));
    return row;
  }

  function toggleRow(id) {
    const row = el('div', '');
    row.className = 'fx-toggle-row';
    row.appendChild(el('div', id));
    return row;
  }

  return {
    el,
    byId,
    sliderRow,
    toggleRow,
    resetButtons(node) { return descendants(node, []).filter(function (one) { return matches(one, '.fx-reset-one'); }); },
    click(node) {
      const event = { preventDefault() {}, stopPropagation() {} };
      (node.handlers.click || []).forEach(function (fn) { fn(event); });
    },
    document: {
      readyState: 'complete',
      getElementById: function (id) { return byId.get(id) || null; },
      createElement: function (tag) { return el(tag, ''); },
      addEventListener() {}
    }
  };
}

const dom = makeDom();
const store = new Map();
const toasts = [];
let animated = 0;
let ranged = 0;

// Which knobs exist is read out of the two field tables before anything is bound, so the rows
// below are the schema's own list rather than a copy of it the test could fall behind.
const schema = vm.runInNewContext('(function () {' + schemaText + 'return HALO_TUNING_SCHEMA;})()');
const pvFields = vm.runInNewContext('(function () {' + pvFieldsText + 'return PV_TUNING_FIELDS;})()');
const bhSchema = vm.runInNewContext('(function () {' + bhSchemaText + 'return BH_TUNING_SCHEMA;})()');
const fxDefaults = vm.runInNewContext('(function () {' + defaultsText + 'return fxDefaults;})()');
const haloKeys = Object.keys(schema).filter(function (key) { return schema[key].kind !== 'bool'; });
const haloBools = Object.keys(schema).filter(function (key) { return schema[key].kind === 'bool'; });
const pvKeys = Object.keys(pvFields).filter(function (key) { return pvFields[key].kind !== 'bool'; });
const bhKeys = Object.keys(bhSchema).filter(function (key) { return bhSchema[key].kind !== 'bool'; });

haloKeys.forEach(function (key) { dom.sliderRow('fx-halo' + key); });
haloBools.forEach(function (key) { dom.toggleRow('t-halo' + key); });
pvKeys.forEach(function (key) { dom.sliderRow('fx-pv' + key); });
bhKeys.forEach(function (key) { dom.sliderRow('fx-bh' + key); });
dom.toggleRow('t-pvunify');
// A bool knob is a switch, so its slider id does not exist in the app. Build the row anyway:
// then the thing that keeps a reset button off a switch is the binder's own skip, and a binder
// that dropped it is caught here instead of quietly finding no element.
const pvBools = Object.keys(pvFields).filter(function (key) { return pvFields[key].kind === 'bool'; });
haloBools.forEach(function (key) { dom.sliderRow('fx-halo' + key); });
pvBools.forEach(function (key) { dom.sliderRow('fx-pv' + key); });
dom.sliderRow('fx-intensity');
dom.sliderRow('fx-ghost');

const sandbox = {
  console,
  document: dom.document,
  window: {
    localStorage: {
      getItem: function (key) { return store.has(key) ? store.get(key) : null; },
      setItem: function (key, value) { store.set(key, value); }
    }
  },
  fx: { intensity: 0.2 },
  setRange: function (id, value) {
    const node = dom.byId.get(id);
    if (node) node.value = String(value);
    ranged += 1;
  },
  syncFxUniforms() {},
  saveLyricLayout() {},
  showToast: function (message) { toasts.push(message); },
  animateFxResetButton: function () { animated += 1; },
  shelfManager: null
};

// The rows are already in the DOM when the modules run, so a button can only appear through
// the modules' own init path: a binder nobody calls leaves its rows bare and fails here.
const api = vm.runInNewContext(
  [schemaText, bhSchemaText, defaultsText, panelText, pvTuningText, bhTuningText, haloTuningText].join(NL + NL)
    + NL + ';({ setHaloTuning: setHaloTuning, setPvTuning: setPvTuning, haloTuning: haloTuning, pvTuning: pvTuning,'
    + ' haloTuningFormat: haloTuningFormat, pvTuningFormat: pvTuningFormat,'
    + ' ensureFxSliderResetButton: ensureFxSliderResetButton, setBlackHoleTuning: setBlackHoleTuning, blackHoleTuning: blackHoleTuning })',
  sandbox
);

function rowOf(id) { return dom.byId.get(id).parentNode; }
function buttonsOf(id) { return dom.resetButtons(rowOf(id)); }
function offDefault(spec) { return spec.def === spec.max ? spec.min : spec.max; }
function storedValue(storeKey, key) {
  const raw = store.get(storeKey);
  return raw ? JSON.parse(raw)[key] : undefined;
}

const sliderGroups = [
  { keys: haloKeys, specs: schema, prefix: 'fx-halo', store: 'mineradio-halo-tuning-v1', storeKey: 'haloTuning', label: 'ring knobs' },
  { keys: pvKeys, specs: pvFields, prefix: 'fx-pv', store: 'mineradio-pv-tuning-v1', storeKey: 'pvTuning', label: 'PV dials' },
  { keys: bhKeys, specs: bhSchema, prefix: 'fx-bh', store: 'mineradio-blackhole-tuning-v1', storeKey: 'blackHoleTuning', label: 'black hole dials' }
];
const sliderRows = sliderGroups.reduce(function (sum, group) { return sum + group.keys.length; }, 0);

console.log('rows: ' + (sliderRows + haloBools.length + pvBools.length + 2)
  + ' slider-shaped rows (' + sliderGroups.map(function (group) { return group.keys.length + ' ' + group.label; }).join(', ')
  + ', fx-intensity, fx-ghost), ' + (haloBools.length + 1) + ' switches');

// -------------------------------------------------- every slider row carries exactly one button
{
  const bare = [];
  sliderGroups.forEach(function (group) {
    group.keys.forEach(function (key) {
      if (buttonsOf(group.prefix + key).length !== 1) bare.push(group.prefix + key);
    });
  });
  assert.deepStrictEqual(bare, [], 'these knob rows must carry exactly one .fx-reset-one: ' + bare.join(', '));
  console.log('slider rows with one reset button: ' + sliderRows + '/' + sliderRows);
}

// ---------------------------------------- a switch has no button: its default is one flip away
{
  const grown = []
    .concat(haloBools.map(function (key) { return 't-halo' + key; }))
    .concat(['t-pvunify'])
    .concat(haloBools.map(function (key) { return 'fx-halo' + key; }))
    .concat(pvBools.map(function (key) { return 'fx-pv' + key; }))
    .filter(function (id) { return buttonsOf(id).length > 0; });
  assert.deepStrictEqual(grown, [], 'a bool knob must not be given a slider reset: ' + grown.join(', '));
  console.log('bool rows kept bare: ' + (haloBools.length * 2 + pvBools.length * 2 + 1) + ' checked');
}

// ---------------------------------------- one button moves one ring knob back to its own default
{
  let restored = 0;
  haloKeys.forEach(function (key, index) {
    const spec = schema[key];
    const id = 'fx-halo' + key;
    const moved = offDefault(spec);
    api.setHaloTuning(key, moved);
    assert.strictEqual(api.haloTuning[key], moved, 'the knob must accept a drag before the button is tested');
    // Leave a second knob dragged: a button that reset the whole store would otherwise look
    // correct, because every other knob is already sitting on its default.
    const neighbour = haloKeys[(index + 1) % haloKeys.length];
    const neighbourId = 'fx-halo' + neighbour;
    const neighbourMoved = offDefault(schema[neighbour]);
    if (neighbour !== key) api.setHaloTuning(neighbour, neighbourMoved);
    const before = Object.assign({}, api.haloTuning);
    const toastCount = toasts.length;
    const animCount = animated;
    dom.click(buttonsOf(id)[0]);
    assert.strictEqual(api.haloTuning[key], spec.def,
      key + ': its own button must put it on the schema default (' + spec.def + '), found ' + api.haloTuning[key]);
    const changed = Object.keys(api.haloTuning).filter(function (one) { return api.haloTuning[one] !== before[one]; });
    assert.deepStrictEqual(changed, [key], key + ': one button must move one knob, moved ' + changed.join(', '));
    if (neighbour !== key) {
      assert.strictEqual(api.haloTuning[neighbour], neighbourMoved,
        key + ': its button must leave the neighbour ' + neighbour + ' where the user put it');
      assert.strictEqual(dom.byId.get(neighbourId).value, String(neighbourMoved),
        key + ": the neighbour's slider must keep showing its own dragged value");
    }
    assert.strictEqual(dom.byId.get(id).value, String(spec.def), key + ': the slider must be written back');
    assert.strictEqual(rowOf(id).querySelector('output').textContent, api.haloTuningFormat(key),
      key + ': the read-out must be refreshed with the knob');
    assert.strictEqual(storedValue('mineradio-halo-tuning-v1', key), spec.def, key + ': the reset must persist');
    assert.ok(animated > animCount, key + ': the button must give its own spin');
    assert.deepStrictEqual(toasts.slice(toastCount), ['已恢复默认数值'], key + ': one toast per reset');
    restored += 1;
  });
  console.log('ring knobs restored by their own button: ' + restored + '/' + haloKeys.length
    + ' (each with one neighbour left dragged)');
}

// ------------------------------------------ the same for the PV dials, against their own default
{
  let restored = 0;
  pvKeys.forEach(function (key, index) {
    const spec = pvFields[key];
    const id = 'fx-pv' + key;
    const moved = offDefault(spec);
    api.setPvTuning(key, moved);
    const neighbour = pvKeys[(index + 1) % pvKeys.length];
    const neighbourMoved = offDefault(pvFields[neighbour]);
    if (neighbour !== key) api.setPvTuning(neighbour, neighbourMoved);
    const before = Object.assign({}, api.pvTuning);
    dom.click(buttonsOf(id)[0]);
    assert.strictEqual(api.pvTuning[key], spec.def, key + ': its own button must put it back on ' + spec.def);
    const changed = Object.keys(api.pvTuning).filter(function (one) { return api.pvTuning[one] !== before[one]; });
    assert.deepStrictEqual(changed, [key], key + ': one button must move one dial, moved ' + changed.join(', '));
    if (neighbour !== key) {
      assert.strictEqual(api.pvTuning[neighbour], neighbourMoved,
        key + ': its button must leave the neighbour ' + neighbour + ' where the user put it');
    }
    assert.strictEqual(storedValue('mineradio-pv-tuning-v1', key), spec.def, key + ': the reset must persist');
    restored += 1;
  });
  console.log('PV dials restored by their own button: ' + restored + '/' + pvKeys.length
    + ' (each with one neighbour left dragged)');
}

// ------------------------------------ the black hole's dials, same contract, its own store
{
  let restored = 0;
  bhKeys.forEach(function (key, index) {
    const spec = bhSchema[key];
    const id = 'fx-bh' + key;
    const moved = offDefault(spec);
    api.setBlackHoleTuning(key, moved);
    const neighbour = bhKeys[(index + 1) % bhKeys.length];
    const neighbourMoved = offDefault(bhSchema[neighbour]);
    if (neighbour !== key) api.setBlackHoleTuning(neighbour, neighbourMoved);
    const before = Object.assign({}, api.blackHoleTuning);
    dom.click(buttonsOf(id)[0]);
    assert.strictEqual(api.blackHoleTuning[key], spec.def, key + ': its own button must put it back on ' + spec.def);
    const changed = Object.keys(api.blackHoleTuning).filter(function (one) { return api.blackHoleTuning[one] !== before[one]; });
    assert.deepStrictEqual(changed, [key], key + ': one button must move one dial, moved ' + changed.join(', '));
    if (neighbour !== key) {
      assert.strictEqual(api.blackHoleTuning[neighbour], neighbourMoved,
        key + ': its button must leave the neighbour ' + neighbour + ' where the user put it');
    }
    assert.strictEqual(storedValue('mineradio-blackhole-tuning-v1', key), spec.def, key + ': the reset must persist');
    restored += 1;
  });
  console.log('black hole dials restored by their own button: ' + restored + '/' + bhKeys.length);
}

// --------------------------- the app's own sliders still reset through fxDefaults (two arguments)
{
  api.ensureFxSliderResetButton('fx-intensity', 'intensity');
  assert.strictEqual(buttonsOf('fx-intensity').length, 1,
    'the shared helper must still bind a button when no store is handed to it');
  sandbox.fx.intensity = 0.2;
  const ringBefore = Object.assign({}, api.haloTuning);
  const animCount = animated;
  dom.click(buttonsOf('fx-intensity')[0]);
  assert.strictEqual(sandbox.fx.intensity, fxDefaults.intensity,
    'a slider without a store must fall back to fxDefaults (' + fxDefaults.intensity + ')');
  assert.strictEqual(animated - animCount, 1, 'the generic reset spins its own button once');
  assert.strictEqual(ranged, 1, 'the generic reset writes its slider through setRange');
  assert.deepStrictEqual(Object.assign({}, api.haloTuning), ringBefore,
    'the generic reset must not reach into the ring store');
}

// ----------------------------------- a key with no recorded default gets no value written at all
{
  const before = toasts.length;
  api.ensureFxSliderResetButton('fx-ghost', 'ghostKey');
  assert.strictEqual(buttonsOf('fx-ghost').length, 1, 'a slider gets its button whether or not the key is known');
  dom.click(buttonsOf('fx-ghost')[0]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sandbox.fx, 'ghostKey'), false,
    'resetting a key with no default must not invent one');
  assert.strictEqual(toasts.length, before, 'and must not claim it restored anything');
}

// ------------------------------------------- binding a row twice must not double it or swap it out
{
  api.ensureFxSliderResetButton('fx-haloradiusK', 'radiusK');
  assert.strictEqual(buttonsOf('fx-haloradiusK').length, 1, 'a row carries one button however often it is bound');
  api.setHaloTuning('radiusK', offDefault(schema.radiusK));
  dom.click(buttonsOf('fx-haloradiusK')[0]);
  assert.strictEqual(api.haloTuning.radiusK, schema.radiusK.def,
    'the button that was already there must keep resetting the knob, not a fx key');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sandbox.fx, 'radiusK'), false,
    'a rebound ring row must not start writing into fx');
}

console.log('[OK] Every ring and PV slider row carries its own reset, and it restores that one field.');

