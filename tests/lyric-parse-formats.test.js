'use strict';

// The LRC parser has to accept every fraction separator the providers actually return. NetEase's
// lyric_new answers some songs with `[mm:ss:cc]` (a second colon) mixed with karaoke JSON lines.
// Only the dot form used to parse, so those songs came out as zero lines and every visual preset
// fell back to the "title - artist" placeholder - the song looked like it had no lyrics.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_FILE = path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');

function load() {
  const sandbox = {
    console, Math, Number, String, Array, Object, JSON, isFinite, isNaN,
    setTimeout: function () { return 0; }, clearTimeout: function () {},
    window: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_FILE, 'utf8'), sandbox, { filename: MODULE_FILE });
  return sandbox;
}

test('the standard dot form still parses', () => {
  const box = load();
  const lines = box.parseLyricText('[00:04.92]first\n[00:07.50]second');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].t, 4.92);
  assert.equal(lines[0].text, 'first');
  assert.equal(lines[1].t, 7.5);
});

test('the colon-separated centisecond form parses (NetEase lyric_new)', () => {
  const box = load();
  const lines = box.parseLyricText('[00:00:25]first\n[00:04:92]second\n[00:07:21]third');
  assert.equal(lines.length, 3, 'all three lines must survive: ' + JSON.stringify(lines));
  assert.equal(lines[0].t, 0.25);
  assert.equal(lines[1].t, 4.92);
  assert.equal(lines[2].t, 7.21);
  // JSON, not deepStrictEqual: an array built inside the vm has that realm's Array prototype.
  assert.equal(JSON.stringify(lines.map(function (l) { return l.text; })), '["first","second","third"]');
});

test('karaoke JSON metadata lines are ignored, not turned into lyrics', () => {
  const box = load();
  const text = [
    '{"t":0,"c":[{"tx":"作词: "},{"tx":"someone"}]}',
    '{"t":125,"c":[{"tx":"作曲: "},{"tx":"someone"}]}',
    '[00:00:25]the actual line',
    '[00:04:92]the next one'
  ].join('\n');
  const lines = box.parseLyricText(text);
  assert.equal(lines.length, 2, 'only the timed LRC lines are lyrics: ' + JSON.stringify(lines));
  assert.equal(lines[0].t, 0.25);
  assert.equal(lines[1].text, 'the next one');
});

test('durations come from the next line and stay sane', () => {
  const box = load();
  const lines = box.parseLyricText('[00:00:25]a\n[00:04:92]b\n[00:06:22]c');
  assert.ok(lines[0].duration > 4 && lines[0].duration < 5, 'first duration: ' + lines[0].duration);
  assert.ok(lines[2].duration >= 0.45, 'the last line must still have a duration');
});