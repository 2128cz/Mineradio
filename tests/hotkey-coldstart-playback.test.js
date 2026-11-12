'use strict';

// The machine has booted, nobody has opened the window, and the last playback snapshot is
// either missing (a fresh start) or a local file that cannot be re-imported. Pressing the
// global play hotkey then fell into `if (!audio) return` and did nothing at all - the user
// had to click into the interface first. These tests pin the bootstrap: with nothing to
// resume, the play key builds the queue from the daily recommendations and plays item 0,
// an unlogged page says so instead of failing silently, and a restorable queue still wins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_DIR = path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback');
const SNAPSHOT_SRC = fs.readFileSync(path.join(MODULE_DIR, '09-queue-snapshot-autoplay.js'), 'utf8');
const CONTROLS_SRC = fs.readFileSync(path.join(MODULE_DIR, '14-player-controls.js'), 'utf8');

function makeSong(index) {
  return { id: 'rec-' + index, name: '推荐 ' + index, artist: '歌手' + index, duration: 180 + index };
}

function load(options) {
  const opts = options || {};
  const calls = [];
  const toasts = [];

  let releaseHomeIdle = null;
  const homeIdleGate = opts.pendingHomeIdle
    ? new Promise((resolve) => { releaseHomeIdle = resolve; })
    : Promise.resolve();

  const sandbox = {
    console, Math, JSON, Object, Array, String, Number, Boolean, Error, Promise, Set, Map,
    isFinite, isNaN, parseInt, parseFloat, Date,
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (t) => clearTimeout(t),
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    playQueue: opts.queue || [],
    currentIdx: opts.idx === undefined ? (opts.queue && opts.queue.length ? 0 : -1) : opts.idx,
    currentLocalSong: opts.localSong || null,
    restoredLastPlaybackSnapshot: opts.restored || null,
    pendingPlaybackResumeAt: 0,
    startupRestoreHomePending: !!opts.homePending,
    miniQueueOpen: false,
    playing: opts.playing === true,
    audio: opts.audio === undefined ? null : opts.audio,
    homeDiscoverState: { loaded: false, songs: [], loading: false },
    hasAnyPlatformLogin: () => opts.logged !== false,
    waitForHomeDiscoverIdle: () => homeIdleGate,
    loadHomeDiscover: async function () {
      calls.push('loadHomeDiscover');
      sandbox.homeDiscoverState.loaded = true;
      sandbox.homeDiscoverState.songs = (opts.recSongs === undefined ? [makeSong(1), makeSong(2)] : opts.recSongs).map((s) => Object.assign({}, s));
    },
    cloneSong: (song) => Object.assign({}, song),
    safeRenderQueuePanel: (reason) => calls.push('render:' + reason),
    safeShelfRebuild: (reason) => calls.push('shelf:' + reason),
    forcePlaybackControlsInteractive: () => calls.push('interactive'),
    playQueueAt: async function (idx, o) {
      calls.push('playQueueAt:' + idx + ':' + (o && o.manual ? 'manual' : 'auto'));
      if (opts.playQueueAtOk === false) return false;
      sandbox.audio = { src: 'mock://track-' + idx, paused: false, ended: false };
      sandbox.currentIdx = idx;
      return true;
    },
    playbackMediaMatchesCurrentQueueItem: () => true,
    showToast: (msg) => toasts.push(msg),
    hideLoading: () => {},
    fadeOutAndPauseAudio: async () => { calls.push('fadeOutPause'); sandbox.audio.paused = true; },
    updateListenStatsTick: () => {},
    scheduleControlsHide: () => {},
    syncPlaybackStateFromAudioEvent: () => {},
    safePlaybackStep: (name, fn) => fn(),
    prevTrack: () => calls.push('prev'),
    nextTrack: () => calls.push('next'),
    trackSwitchToken: 0,
    playToggleBusy: false,
    playMode: 'loop',
    document: {
      getElementById: (id) => (id === 'play-icon' ? { innerHTML: '' } : null),
      body: {
        classList: {
          contains: (name) => opts.splashActive === true && name === 'splash-active'
        }
      }
    },
    dismissSplash: (o) => calls.push('dismissSplash:' + ((o && o.reason) || ''))
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SNAPSHOT_SRC, sandbox, { filename: '09-queue-snapshot-autoplay.js' });
  vm.runInContext(CONTROLS_SRC, sandbox, { filename: '14-player-controls.js' });
  return {
    sandbox, calls, toasts,
    release() { if (releaseHomeIdle) releaseHomeIdle(); }
  };
}

test('cold start with an empty queue: the play key builds the recommendation queue and plays item 0', async () => {
  const box = load({ queue: [], idx: -1 });
  const ok = await box.sandbox.togglePlay();
  assert.equal(ok, undefined);
  assert.equal(box.calls.includes('loadHomeDiscover'), true, 'the recommendations must be loaded');
  assert.equal(box.calls.includes('playQueueAt:0:manual'), true, 'item 0 must be played, counted as a user request');
  assert.equal(box.sandbox.playQueue.length, 2, 'the recommendation list becomes the queue');
  assert.equal(box.sandbox.currentIdx, 0);
  assert.equal(box.sandbox.startupRestoreHomePending, false, 'the boot home placeholder must be dismissed');
  assert.deepEqual(box.toasts, [], 'a successful bootstrap must not nag');
});

test('cold start without a login: the key says so instead of dying silently', async () => {
  const box = load({ queue: [], idx: -1, logged: false, audio: { src: '', paused: true, ended: false } });
  await box.sandbox.togglePlay();
  assert.equal(box.calls.includes('loadHomeDiscover'), false, 'nothing to fetch without an account');
  assert.equal(box.calls.some((c) => c.startsWith('playQueueAt')), false);
  assert.equal(box.toasts.length, 1);
  assert.match(box.toasts[0], /登录/);
});

test('last track was an unavailable local file: fall back to the recommendations and announce it', async () => {
  const box = load({ queue: [], idx: -1, localSong: { localKey: 'k1', localMissing: true } });
  await box.sandbox.togglePlay();
  assert.equal(box.calls.includes('playQueueAt:0:manual'), true);
  assert.equal(box.toasts.length, 1, 'the source switch must be announced once');
  assert.match(box.toasts[0], /本地文件/);
  assert.match(box.toasts[0], /每日推荐/);
});

test('a restorable queue still wins over the bootstrap', async () => {
  const box = load({ queue: [makeSong(9)], idx: 0, restored: { current: makeSong(9) } });
  await box.sandbox.togglePlay();
  assert.equal(box.calls.includes('playQueueAt:0:manual'), true, 'the restored song is the one to play');
  assert.equal(box.calls.includes('loadHomeDiscover'), false, 'no recommendation fetch when a song can be resumed');
});

test('while audio is playing, the same key pauses and never bootstraps', async () => {
  const box = load({
    queue: [makeSong(1)], idx: 0, playing: true,
    audio: { src: 'mock://track-0', paused: false, ended: false, __mineradioQueueItemKey: 'song:rec-1' }
  });
  await box.sandbox.togglePlay();
  assert.equal(box.calls.includes('fadeOutPause'), true);
  assert.equal(box.calls.includes('loadHomeDiscover'), false, 'a pause press must not rebuild the queue');
});

test('the bootstrap is single-flight while the home list is still loading', async () => {
  const box = load({ queue: [], idx: -1, pendingHomeIdle: true });
  const first = box.sandbox.tryHotkeyBootstrapPlayback();
  const second = await box.sandbox.tryHotkeyBootstrapPlayback();
  assert.equal(second, false, 'a second press while the first runs must decline, not double-load');
  box.release();
  assert.equal(await first, true, 'the first press still completes');
});

test('logged in but the recommendation list came back empty: decline quietly for now', async () => {
  const box = load({ queue: [], idx: -1, recSongs: [], audio: { src: '', paused: true, ended: false } });
  await box.sandbox.togglePlay();
  assert.equal(box.calls.includes('loadHomeDiscover'), true);
  assert.equal(box.calls.some((c) => c.startsWith('playQueueAt')), false, 'nothing to queue');
});

test('a play key on the splash screen enters the app instead of starting music behind it', async () => {
  const box = load({ queue: [], idx: -1, splashActive: true });
  await box.sandbox.togglePlay();
  assert.equal(box.calls.includes('dismissSplash:play-key'), true, 'the splash must be dismissed by the play key');
  assert.equal(box.calls.includes('playQueueAt:0:manual'), true, 'and playback must start in the same press');
  const dismissAt = box.calls.indexOf('dismissSplash:play-key');
  const playAt = box.calls.indexOf('playQueueAt:0:manual');
  assert.equal(dismissAt < playAt, true, 'enter first, then play');
});

test('a pause key on the splash screen never dismisses it', async () => {
  const box = load({
    queue: [makeSong(1)], idx: 0, playing: true, splashActive: true,
    audio: { src: 'mock://track-0', paused: false, ended: false, __mineradioQueueItemKey: 'song:rec-1' }
  });
  await box.sandbox.togglePlay();
  assert.equal(box.calls.includes('fadeOutPause'), true);
  assert.equal(box.calls.some((c) => c.startsWith('dismissSplash')), false, 'pausing must not reveal the app');
});
