const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The ring's rows show the translation the app's own lyric pipeline attached to that line
// (attachLyricTranslations matches the two lists by time). Pairing lyricsTranslationLines[i]
// with lyricsLines[i] is a different thing: a song whose translation list has holes shifts
// every translation after the first hole onto the wrong original.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

const seededMath = Object.create(Math);
let seed = 20261027;
seededMath.random = function () {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const drawContext = {
  font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
  globalAlpha: 1, lineWidth: 1, lineCap: '',
  save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {},
  beginPath() {}, closePath() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, rect() {},
  arc() {}, clip() {}, quadraticCurveTo() {}, bezierCurveTo() {}, ellipse() {},
  fillText() {}, strokeText() {}, drawImage() {}, putImageData() {},
  measureText: (text) => ({ width: String(text).length * 12 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} })
};
const canvas = { width: 1920, height: 1080, style: {}, getContext: () => drawContext };

const sandbox = {
  console, Math: seededMath, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
  parseFloat, parseInt, Set, Map, Uint8ClampedArray, Uint8Array,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  performance: { now: () => 0 },
  devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
  audioCtx: { sampleRate: 44100 },
  document: {
    getElementById: (id) => (id === 'halo-canvas' ? canvas : null),
    createElement: () => canvas,
    addEventListener() {}, body: { appendChild() {} }
  },
  fx: { lyricScale: 1 },
  playQueue: [], currentIdx: -1,
  lyricsLines: [], lyricsTranslationLines: []
};
sandbox.window = {
  addEventListener() {}, removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {} },
  devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
  document: sandbox.document
};
sandbox.self = sandbox.window;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: modulePath });

const tuning = {};
for (const key of Object.keys(sandbox.HALO_TUNING_SCHEMA)) tuning[key] = sandbox.HALO_TUNING_SCHEMA[key].def;
sandbox.haloTuning = tuning;
sandbox.haloLayoutStage(1920, 1080);

function build(lines, translations) {
  sandbox.lyricsLines = lines;
  sandbox.lyricsTranslationLines = translations || [];
  sandbox.haloBuildLyricRing();
  return sandbox.haloLyric.items;
}

// ------------------------------------- a hole in the translation list stays a hole
{
  // The song has three lines and only two translations: the second line has none. The lists
  // are not the same length, so index pairing puts 译文丙 on the second line and nothing on
  // the third.
  const items = build([
    { t: 1, text: 'first line', translation: '译文甲' },
    { t: 5, text: 'second line' },
    { t: 9, text: 'third line', translation: '译文丙' }
  ], [
    { t: 1, text: '译文甲' },
    { t: 9, text: '译文丙' }
  ]);
  assert.strictEqual(items.length, 3, 'all three lines are on the ring');
  assert.strictEqual(items[0].sub, '译文甲', 'the first line keeps its own translation');
  assert.strictEqual(items[1].sub, '', `a line with no translation must stay empty, got "${items[1].sub}"`);
  assert.strictEqual(items[2].sub, '译文丙', `the third line keeps its own translation, got "${items[2].sub}"`);
  console.log(`  hole: ${items.map((it) => it.sub || '∅').join(' / ')}`);
}

// ------------------------------- skipping an empty line must not shift the pairing
{
  // The ring drops empty rows, so the row index is not the line index. Pairing by the line's
  // position in its own list is at least consistent - pairing by the dropped rows is not.
  const items = build([
    { t: 0, text: '' },
    { t: 2, text: 'second line', translation: '译文乙' },
    { t: 4, text: '' },
    { t: 6, text: 'fourth line', translation: '译文丁' }
  ], [
    { t: 2, text: '译文乙' },
    { t: 6, text: '译文丁' }
  ]);
  assert.strictEqual(items.length, 2, 'two non-empty rows');
  assert.strictEqual(items[0].sub, '译文乙', `the first row keeps its translation, got "${items[0].sub}"`);
  assert.strictEqual(items[1].sub, '译文丁', `the second row keeps its translation, got "${items[1].sub}"`);
}

// ------------------------- the rows are rebuilt when the text does not line up
{
  // A translation can arrive after the lines (the NetEase fallback). The dial re-renders on
  // its signature, so the signature has to notice a translation that landed late.
  sandbox.lyricsLines = [{ t: 1, text: 'a line' }, { t: 4, text: 'another line' }];
  sandbox.lyricsTranslationLines = [];
  sandbox.haloBuildLyricRing();
  const before = sandbox.haloLyricSignature();
  sandbox.lyricsLines[1].translation = '后来的译文';
  const after = sandbox.haloLyricSignature();
  assert.notStrictEqual(after, before,
    'a translation that arrives after the lines must change the build key, or the row keeps its hole');
  sandbox.haloBuildLyricRing();
  assert.strictEqual(sandbox.haloLyric.items[1].sub, '后来的译文', 'the rebuilt row shows the late translation');
  // A correction that keeps the count the same is new evidence too: the key has to hash the
  // translations, not just how many there are.
  const sameCount = sandbox.haloLyricSignature();
  sandbox.lyricsLines[1].translation = '改过的译文';
  assert.notStrictEqual(sandbox.haloLyricSignature(), sameCount,
    'changed translation text must change the build key even when the count is the same');
  // The refresh happens in place: rebuilding the dial would put it back on the read mark and
  // snap the turn in the middle of the song.
  sandbox.haloLyric.rot = 1.234;
  sandbox.haloSyncLyrics();
  assert.strictEqual(sandbox.haloLyric.items[1].sub, '改过的译文',
    `the row must take the late translation without a rebuild, got "${sandbox.haloLyric.items[1].sub}"`);
  assert.strictEqual(sandbox.haloLyric.rot, 1.234,
    'refreshing a translation must not reset the dial onto the read mark');
  console.log('  late: a translation that lands after the lines reaches the row');
}

console.log('[OK] The ring pairs each line with the translation the app attached to it by time.');
