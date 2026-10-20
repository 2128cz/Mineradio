'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function createPreloadHarness() {
  const listeners = new Map();
  const sent = [];
  const exposed = {};
  const electronStub = {
    contextBridge: {
      exposeInMainWorld: (key, api) => { exposed[key] = api; },
    },
    ipcRenderer: {
      on(channel, listener) {
        if (!listeners.has(channel)) listeners.set(channel, []);
        listeners.get(channel).push(listener);
      },
      removeListener(channel, listener) {
        const list = listeners.get(channel) || [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      },
      send(channel, payload) { sent.push({ channel, payload }); },
      invoke: () => Promise.resolve({}),
      sendSync: () => ({}),
    },
    clipboard: { writeText() {} },
    webUtils: { getPathForFile: () => '' },
  };
  const sandbox = {
    require: (id) => {
      if (id === 'electron') return electronStub;
      throw new Error(`unexpected preload require: ${id}`);
    },
    console,
    Promise,
    Map,
    Set,
    Number,
    String,
    Math,
    Date,
    JSON,
    Object,
    Array,
    Error,
    window: { addEventListener() {} },
    document: {},
  };
  vm.runInNewContext(read('desktop/preload.js'), sandbox, { filename: 'desktop/preload.js' });
  const emitHotkey = (payload) => {
    (listeners.get('mineradio-global-hotkey') || []).slice().forEach((listener) => listener({}, payload));
  };
  const acks = () => sent.filter((row) => row.channel === 'mineradio-global-hotkey-ack').map((row) => row.payload);
  return { api: exposed.desktopWindow, emitHotkey, acks, sent };
}

test('acks a global hotkey even before the page binds a handler', () => {
  const h = createPreloadHarness();
  h.emitHotkey({ action: 'togglePlay', seq: 7 });
  assert.deepEqual(h.acks(), [{ seq: 7, listeners: 0 }]);
});

test('counts the bound hotkey handlers and drops them again on dispose', () => {
  const h = createPreloadHarness();
  let played = 0;
  const dispose = h.api.onGlobalHotkey(() => { played += 1; });
  h.emitHotkey({ action: 'togglePlay', seq: 8 });
  assert.equal(played, 1);
  assert.deepEqual(h.acks(), [{ seq: 8, listeners: 1 }]);
  dispose();
  h.emitHotkey({ action: 'togglePlay', seq: 9 });
  assert.equal(played, 1);
  assert.deepEqual(h.acks(), [{ seq: 8, listeners: 1 }, { seq: 9, listeners: 0 }]);
});

test('does not answer a hotkey that carries no sequence', () => {
  const h = createPreloadHarness();
  h.emitHotkey({ action: 'togglePlay' });
  assert.deepEqual(h.acks(), []);
});

test('main times out on an unacknowledged hotkey and records the window state', () => {
  const mainText = read('desktop/main.js');
  const block = mainText.slice(
    mainText.indexOf('const GLOBAL_HOTKEY_ACK_TIMEOUT_MS'),
    mainText.indexOf("function unregisterMineradioGlobalHotkeys")
  );
  assert(block.length > 100, 'the hotkey round trip block must exist in desktop/main.js');
  assert.match(block, /entry\.timer = setTimeout\(/);
  assert.match(block, /recordGlobalHotkeyFailure\(entry, 'no-ack', null\)/);
  assert.match(block, /mainWindow\.webContents\.send\('mineradio-global-hotkey', \{ action, seq \}\)/);
  assert.match(block, /ipcMain\.on\('mineradio-global-hotkey-ack'/);
  assert.match(block, /event\.sender\.id !== mainWindow\.webContents\.id/);
  assert.match(block, /writeStartupState\('global-hotkey-unanswered'/);
  ['action', 'seq', 'reason', 'waitedMs', 'listeners', 'minimized', 'visible', 'focused', 'registeredHotkeys']
    .forEach((field) => {
      assert(
        new RegExp(`(^|[({,\\s])${field}\\s*[:,}]`, 'm').test(block),
        `the record must carry ${field}`
      );
    });
});

test('backgrounding is disabled by default, not behind an opt-in', () => {
  const mainText = read('desktop/main.js');
  const block = mainText.slice(
    mainText.indexOf('const CHROMIUM_SAFE_PERFORMANCE_SWITCHES'),
    mainText.indexOf('const gotSingleInstanceLock')
  );
  assert.match(block, /if \(!MAIN_WINDOW_BACKGROUND_THROTTLING\) \{/);
  ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']
    .forEach((name) => assert.match(block, new RegExp(name), `${name} must stay in the default set`));
  assert.doesNotMatch(
    block,
    /'(disable-background-timer-throttling|disable-renderer-backgrounding|disable-backgrounding-occluded-windows)',\s*null,\s*'MINERADIO_KEEP_BACKGROUND_RENDERING'/,
    'the anti-backgrounding switches must not be opt-in again'
  );
});
