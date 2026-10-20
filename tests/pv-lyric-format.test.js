'use strict';

// Acceptance for the lyric formatter. Success criteria were written before the code:
// deterministic output (the archive cache key is a hash of it), non-decreasing timestamps,
// no markup injection from platform lyric text, interludes only above a threshold, and a
// translation surviving as an annotation rather than being dropped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_FILE = path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '07-pv-lyric-format.js');

function load() {
  const sandbox = { console, Number, Math, Object, String, Array, JSON, isNaN, isFinite };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_FILE, 'utf8'), sandbox, { filename: MODULE_FILE });
  return sandbox;
}

const TIME_LINE = /^\[\d{2,3}:\d{2}\.\d{2}\]/;

test('output is deterministic and its hash tracks content', () => {
  const box = load();
  const lines = [
    { t: 0.4, text: '夜色把/楼顶的灯拧成糖', duration: 3.8, translation: 'night folds the roof lights' },
    { t: 4.2, text: '谁在广播里念我们的名字', duration: 4.0 },
    { t: 9.0, text: '写完就擦掉 不给人看', duration: 4.2, translation: 'write it then erase' },
  ];
  const first = box.formatLyricsForPv(lines, { title: '测试曲目', artist: '测试歌手' });
  const second = box.formatLyricsForPv(lines, { title: '测试曲目', artist: '测试歌手' });
  assert.equal(first, second, 'same input must produce byte-identical text');
  assert.equal(box.pvLyricHash(first), box.pvLyricHash(second));
  const mutated = box.formatLyricsForPv(lines.slice(0, 2), { title: '测试曲目', artist: '测试歌手' });
  assert.notEqual(box.pvLyricHash(mutated), box.pvLyricHash(first), 'content change must change the key');
  assert.equal(box.pvLyricHash(''), box.pvLyricHash(''), 'empty is stable too');
  assert.equal(typeof box.pvLyricHash(first), 'string');
  assert.match(box.pvLyricHash(first), /^[0-9a-f]{16}$/);
});

test('every lyric line carries a well-formed timestamp in ascending order', () => {
  const box = load();
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push({ t: i * 2.5, text: '行' + i, duration: 2.0 });
  const text = box.formatLyricsForPv(lines, { title: 't', artist: 'a' });
  const rows = text.split('\n').filter(row => TIME_LINE.test(row));
  assert.equal(rows.length, 12, 'one emitted line per input line');
  let previous = -1;
  rows.forEach((row, index) => {
    const match = /^\[(\d{2,3}):(\d{2})\.(\d{2})\]/.exec(row);
    const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 100;
    // The stamp must equal the input time, not merely be well-formed and ascending:
    // a broken carry passes both of those while shifting every line by a minute.
    assert.ok(Math.abs(seconds - lines[index].t) <= 0.01,
      'stamp ' + row.slice(0, 11) + ' should equal input time ' + lines[index].t);
    assert.ok(seconds >= previous, 'timestamps must not go backwards at ' + row);
    previous = seconds;
  });
});

test('minute rollover keeps a valid stamp instead of 59.100', () => {
  const box = load();
  const text = box.formatLyricsForPv([{ t: 59.996, text: '跨过一分钟', duration: 2 }], { emitMeta: false });
  assert.match(text, /^\[01:00\.00\]/);
  assert.doesNotMatch(text, /\.\d{3}\]/);
});

test('platform lyric text cannot inject markup', () => {
  const box = load();
  const stats = {};
  const lines = [
    { t: 0, text: '[00:12.00]伪造时间戳', duration: 2 },
    { t: 3, text: '#这不是注释', duration: 2 },
    { t: 6, text: '主歌|已经有一个竖线|还有第二个', duration: 2, translation: 'real annotation' },
    { t: 9, text: '斜杠/切分在我这是正文', duration: 2 },
  ];
  const text = box.formatLyricsForPv(lines, { title: '歌名', emitMeta: true, statsOut: stats });
  const bodyLines = text.split('\n').filter(row => row.indexOf('[ti:') !== 0);
  bodyLines.forEach((row) => {
    assert.ok(TIME_LINE.test(row), 'every body line must start with a real timestamp: ' + row);
    const afterStamp = row.replace(TIME_LINE, '');
    assert.ok(afterStamp.charAt(0) !== '#', 'a line may not become a comment');
    assert.ok(afterStamp.charAt(0) !== '[', 'the content after our stamp may not open a tag: ' + row);
  });
  const injected = bodyLines.filter(row => /^\[\d{2}:\d{2}\.\d{2}\]\d{2}:\d{2}/.test(row));
  assert.equal(injected.length, 0, 'the fake timestamp line must have been neutralised');
  // Only the leading bracket is demoted; a bracket further inside cannot open a tag, so it
  // stays readable. Assert exactly that, not more.
  assert.ok(text.indexOf('\uFF3B00:12.00]') >= 0, 'leading bracket becomes full-width');
  assert.ok(text.indexOf('\uFF03这不是注释') >= 0, 'leading hash becomes full-width');
  // exactly one real separator, ours, on the line that supplied a translation
  const pipeLines = bodyLines.filter(row => row.indexOf('|') >= 0);
  assert.equal(pipeLines.length, 1, 'only our annotation separator survives as ASCII |');
  assert.equal((pipeLines[0].match(/\|/g) || []).length, 1);
  assert.ok(pipeLines[0].indexOf('\uFF5C') >= 0, 'source pipes demoted to full-width');
  assert.ok(text.indexOf('\u2215') >= 0, 'source slash demoted to the division sign');
  assert.equal(stats.droppedNoText, 0);
});

test('translation rides as an annotation, and fills in when the main line is empty', () => {
  const box = load();
  const stats = {};
  const text = box.formatLyricsForPv([
    { t: 0, text: '正文', duration: 2, translation: 'the note' },
    { t: 3, text: '   ', duration: 2, translation: 'only a translation' },
  ], { emitMeta: false, statsOut: stats });
  const rows = text.split('\n');
  assert.equal(rows[0], '[00:00.00]正文|the note');
  assert.equal(rows[1], '[00:03.00]only a translation', 'a translation-only line becomes the text, not an orphan annotation');
  assert.equal(stats.annotationLines, 1);
  assert.equal(stats.droppedNoText, 0);
});

test('interludes appear only across a real gap', () => {
  const box = load();
  const close = box.formatLyricsForPv([
    { t: 0, text: '第一句', duration: 2 },
    { t: 4, text: '第二句', duration: 2 },
  ], { emitMeta: false });
  assert.equal(close.indexOf('\u95F4\u594F'), -1, 'a 2s gap is not an interlude');

  const withGap = box.formatLyricsForPv([
    { t: 0, text: '第一句', duration: 2 },
    { t: 11.5, text: '第二句', duration: 2 },
  ], { emitMeta: false });
  const interludeRow = withGap.split('\n').find(row => row.indexOf('\u95F4\u594F') >= 0);
  assert.ok(interludeRow, 'a 9.5s gap must produce an interlude row');
  assert.match(interludeRow, /^\[\u95F4\u594F (9|10)\]$/, 'seconds should be the measured gap: ' + interludeRow);

  const forced = box.formatLyricsForPv([
    { t: 0, text: 'a', duration: 2 },
    { t: 5, text: 'b', duration: 2 },
  ], { emitMeta: false, interludeThresholdSec: 2 });
  assert.ok(forced.indexOf('\u95F4\u594F') >= 0, 'threshold is configurable');
});

test('endsOut lines up with the rows the engine will turn into lines', () => {
  // The repair channel is index-addressed: plan.lines[i] is re-timed with lineEnds[i], so an
  // off-by-one here silently re-times the wrong sentence. The two ways the emitted text and the
  // engine's line list differ must both be handled - [ti:]/[ar:] rows are skipped by the parser
  // (jizura-engine.js:2704) while a [间奏 N] row becomes a line of its own (:2711).
  const box = load();
  const ends = [];
  const text = box.formatLyricsForPv([
    { t: 0, text: '第一句', duration: 2 },
    { t: 2, text: '第二句', duration: 3 },
    { t: 8, text: '第三句', duration: 2.5 },
  ], { title: '歌名', artist: '歌手', endsOut: ends });

  const rows = text.split('\n');
  assert.equal(rows[0], '[ti:歌名]');
  assert.equal(rows[1], '[ar:歌手]');
  assert.equal(ends.length, rows.length - 2, 'meta rows must not take an index');
  const timed = rows.slice(2);
  const starts = timed.map((row) => {
    const m = /^\[(\d{2,3}):(\d{2})\.(\d{2})\]/.exec(row);
    return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
  });
  // A 3 s gap between lines 2 and 3 stays under the interlude threshold, so this fixture has no
  // marker row at all: three text rows, three ends, meta rows taking no index.
  assert.deepEqual(ends, [2, 5, 10.5]);
  ends.forEach((end, i) => {
    assert.ok(end > starts[i], `line ${i} must end after it starts`);
    if (i + 1 < ends.length) assert.ok(end <= starts[i + 1] + 1e-6, `line ${i} must not eat line ${i + 1}`);
  });

  const withMarker = box.formatLyricsForPv([
    { t: 0, text: '第一句', duration: 2 },
    { t: 12, text: '第二句', duration: 2 },
  ], { emitMeta: false, endsOut: ends });
  const markerRows = withMarker.split('\n');
  assert.equal(markerRows[0], '[00:00.00]第一句');
  assert.match(markerRows[1], /^\[间奏 (9|10)\]$/, 'the marker rides between the two lines: ' + markerRows[1]);
  assert.equal(ends.length, 3, 'an interlude row is a line too, so it takes an index');
  assert.equal(ends[0], 2, 'the sung line ends on its own duration');
  assert.equal(ends[1], 12, 'the interlude line ends where the next line starts');
  assert.equal(ends[2], 14);

  const cleared = box.formatLyricsForPv([], { emitMeta: false, endsOut: ends });
  assert.equal(cleared, '');
  assert.equal(ends.length, 0, 'a reused array must be reset, not appended to');
});

test('out-of-order input is clamped forward, never emitted backwards', () => {
  const box = load();
  const stats = {};
  const text = box.formatLyricsForPv([
    { t: 10, text: '先', duration: 2 },
    { t: 3, text: '后到', duration: 2 },
  ], { emitMeta: false, statsOut: stats });
  const stamps = text.split('\n').map(row => /^\[(\d{2,3}):(\d{2})\.(\d{2})\]/.exec(row)).map(m => Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100);
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] > stamps[0], 'second line must land after the first');
  assert.equal(stats.clampedOutOfOrder, 1);
});

test('junk input is dropped and counted, not thrown on', () => {
  const box = load();
  const stats = {};
  const text = box.formatLyricsForPv([
    null,
    { t: NaN, text: '' },
    { t: 1, text: '' },
    { t: 2, text: '   ' },
    { t: 'not-a-number', text: '字符串时间', duration: 2 },
  ], { emitMeta: false, statsOut: stats });
  assert.equal(stats.droppedNoText, 4, 'null, NaN-time, empty and whitespace-only lines are all dropped');
  assert.equal(text.split('\n').length, 1, 'only the one real line survives');
  assert.ok(text.indexOf('字符串时间') >= 0);
  assert.ok(TIME_LINE.test(text), 'the bad time falls back to an index-derived stamp');
  assert.ok(text.indexOf('[ti:') === -1, 'emitMeta false suppresses the header');
});

test('empty input yields an empty document rather than throwing', () => {
  const box = load();
  assert.equal(box.formatLyricsForPv([], { emitMeta: false }), '');
  assert.equal(box.formatLyricsForPv(undefined, { emitMeta: false }), '');
  const withMeta = box.formatLyricsForPv(null, { title: '只有标题', artist: '' });
  assert.equal(withMeta, '[ti:只有标题]');
});

test('a 400-line album-side formats in a frame budget', () => {
  const box = load();
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push({ t: i * 1.7, text: '第' + i + '句歌词', duration: 1.5, translation: i % 3 === 0 ? 'note ' + i : '' });
  const started = Date.now();
  const text = box.formatLyricsForPv(lines, { title: 'long', artist: 'x' });
  const elapsed = Date.now() - started;
  assert.equal(text.split('\n').filter(row => TIME_LINE.test(row)).length, 400);
  assert.ok(elapsed < 120, 'formatting should stay far below a second, took ' + elapsed + 'ms');
  assert.ok(pvLyricHashLengthIsShort(text));
  function pvLyricHashLengthIsShort(value) { return box.pvLyricHash(value).length === 16; }
});

test('the formatter is registered in the loader, or it is dead code', () => {
  const loader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'index-loader.js'), 'utf8');
  assert.match(loader, /'js\/modules\/06-lyrics\/07-pv-lyric-format\.js'/);
});
