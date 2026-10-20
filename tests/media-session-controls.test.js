'use strict';

// The keyboard media keys are the one control surface this app never wired: Chromium
// delivers play/pause to the audible element by itself, but previous/next only reach a
// page that registered previoustrack/nexttrack handlers. These tests pin the handlers, the
// single-write-per-change metadata policy (the main loop calls the sync every frame,
// including the 1 Hz background tick), and the fact that a page without a media session
// must stay silent instead of throwing on every frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_FILE = path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '19-media-session.js');

function makeSong(index) {
  return {
    id: 'song-' + index,
    name: '曲目 ' + index,
    artist: '歌手A / 歌手B',
    album: '专辑 ' + index,
    duration: 200 + index,
  };
}

function load(options) {
  const opts = options || {};
  const calls = [];
  const session = {
    handlers: {},
    metadataWrites: 0,
    metadataValue: null,
    playbackState: '',
    positionState: null,
    setActionHandler(action, handler) {
      calls.push('set:' + action);
      session.handlers[action] = handler;
    },
    setPositionState(state) { session.positionState = state; },
  };
  Object.defineProperty(session, 'metadata', {
    get() { return session.metadataValue; },
    set(value) { session.metadataWrites++; session.metadataValue = value; },
  });

  const sandbox = {
    console, Math, Number, String, Array, Object, isFinite, JSON, URL,
    navigator: opts.noSession ? {} : { mediaSession: session },
    MediaMetadata: function (init) { Object.assign(this, init); },
    MediaPositionState: function (init) { Object.assign(this, init); },
    location: { href: 'http://127.0.0.1:3004/' },
    playing: opts.playing === undefined ? true : opts.playing,
    audio: { currentTime: 12, duration: 210, paused: opts.playing === false, playbackRate: 1 },
    playQueue: [makeSong(1)],
    currentIdx: 0,
    togglePlay() { calls.push('togglePlay'); },
    prevTrack(flag) { calls.push('prev:' + flag); },
    nextTrack(flag) { calls.push('next:' + flag); },
    currentCoverSong() { return sandbox.playQueue[sandbox.currentIdx]; },
    currentArtistNames(song) {
      return String((song && song.artist) || '').split(/\s*\/\s*/).filter(Boolean);
    },
    songCoverSrc(song, size) { return '/api/cover?id=' + song.id + '&s=' + size; },
    playbackDurationFromSong(song) { return Number(song && song.duration) || 0; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_FILE, 'utf8'), sandbox, { filename: MODULE_FILE });
  return { sandbox, session, calls };
}

test('registers the media keys Chromium would otherwise drop', () => {
  const box = load();
  box.sandbox.syncMediaSession();
  ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekto'].forEach((action) => {
    assert.equal(typeof box.session.handlers[action], 'function', action + ' handler must be registered');
  });
});

test('previous and next route to the queue, not to a seek', () => {
  const box = load();
  box.sandbox.syncMediaSession();
  box.session.handlers.nexttrack();
  box.session.handlers.previoustrack();
  assert.deepEqual(box.calls.slice(-2), ['next:true', 'prev:true'], 'user-initiated flag must be kept');
});

test('play and pause only fire togglePlay when the element disagrees', () => {
  const box = load({ playing: true });
  box.sandbox.syncMediaSession();
  box.session.handlers.play();
  assert.equal(box.calls.indexOf('togglePlay'), -1, 'already playing: play must be a no-op');
  box.session.handlers.pause();
  assert.equal(box.calls[box.calls.length - 1], 'togglePlay');

  const stopped = load({ playing: false });
  stopped.sandbox.syncMediaSession();
  stopped.session.handlers.play();
  assert.equal(stopped.calls[stopped.calls.length - 1], 'togglePlay');
  stopped.session.handlers.pause();
  assert.equal(stopped.calls.filter((c) => c === 'togglePlay').length, 1, 'already paused: pause must be a no-op');
});

test('metadata carries the artist list, absolute artwork and playback state', () => {
  const box = load();
  box.sandbox.syncMediaSession();
  const meta = box.session.metadataValue;
  assert.equal(meta.title, '曲目 1');
  assert.equal(meta.artist, '歌手A / 歌手B');
  assert.equal(meta.album, '专辑 1');
  assert.equal(meta.artwork.length, 3, 'three art sizes so the shell never upscales one');
  assert.match(meta.artwork[0].src, /^http:\/\/127\.0\.0\.1:3004\/api\/cover/, 'relative cover must be absolutized');
  assert.equal(box.session.playbackState, 'playing');
  assert.equal(box.session.positionState.duration, 201, 'the song duration wins over the element duration');
});

test('an unchanged frame never rewrites the session', () => {
  const box = load();
  box.sandbox.syncMediaSession();
  const writes = box.session.metadataWrites;
  box.sandbox.syncMediaSession();
  box.sandbox.syncMediaSession();
  assert.equal(box.session.metadataWrites, writes, 'per-frame sync must be free when nothing changed');
  assert.equal(box.calls.filter((c) => /^set:/.test(c)).length, 6, 'handlers bind once');
});

test('a track change and a pause each refresh exactly once', () => {
  const box = load();
  box.sandbox.syncMediaSession();
  box.sandbox.playQueue[0] = makeSong(2);
  box.sandbox.syncMediaSession();
  assert.equal(box.session.metadata.title, '曲目 2');
  assert.equal(box.session.metadataWrites, 2);
  box.sandbox.playing = false;
  box.sandbox.audio.paused = true;
  box.sandbox.syncMediaSession();
  assert.equal(box.session.playbackState, 'paused');
  assert.equal(box.session.metadataWrites, 3);
  box.sandbox.syncMediaSession();
  assert.equal(box.session.metadataWrites, 3, 'a pause that repeats must not churn');
});

test('seekto clamps into the element', () => {
  const box = load();
  box.sandbox.syncMediaSession();
  box.session.handlers.seekto({ seekTime: 90 });
  assert.equal(box.sandbox.audio.currentTime, 90);
  box.session.handlers.seekto({ seekTime: -5 });
  assert.equal(box.sandbox.audio.currentTime, 0);
  box.session.handlers.seekto({ seekTime: 5000 });
  assert.equal(box.sandbox.audio.currentTime, 210, 'must not seek past the duration');
  box.session.handlers.seekto({});
  assert.equal(box.sandbox.audio.currentTime, 210, 'a seek without a time is ignored');
});

test('a page without a media session stays silent', () => {
  const box = load({ noSession: true });
  assert.equal(box.sandbox.syncMediaSession(), undefined);
});
