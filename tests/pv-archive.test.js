'use strict';

// Regression test for pv-archive.js. Every rejection rule gets its own targeted
// mutation, because a validator that only rejects one generic bad object proves nothing.
// Real-data arm: uses tmp/pv-spike/plan-page.json (the 31150-byte plan produced by the
// P0 spike) when present, and says so loudly when absent instead of silently passing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const pv = require('../pv-archive.js');

const ROOT = path.join(os.tmpdir(), 'mineradio-pv-archive-test');
const DATA = path.join(ROOT, 'pvs');

function okArchive(overrides) {
  const archive = Object.assign({
    pvSchema: pv.PV_SCHEMA,
    archiveKey: pv.canonicalArchiveKey({
      songKey: 'qishui:demo', lyricHash: 'abc123', lang: 'zh-Hans',
      aspect: '16:9', res: 1080, seed: 20260922, style: 'noir', srcFingerprint: 'deadbeef',
    }),
    jizura: { version: '0.9.0', planVersion: 2, srcFingerprint: 'deadbeef' },
    song: { key: 'qishui:demo', provider: 'qishui', title: 't', artist: 'a', duration: 38.29 },
    source: { lyricHash: 'abc123', lang: 'zh-Hans', withTranslation: true },
    recipe: { seed: 20260922, style: 'noir', aspect: '16:9', res: 1080 },
    align: { mineradioLyricOffsetMs: 0, jizuraTypesetLeadApplied: false },
    plan: {
      W: 1920, H: 1080, duration: 38.29, lang: 'zh-Hans',
      lines: [{ index: 0, text: '夜色把楼顶的灯拧成糖', start: 0.4, end: 4.2 }],
      cuts: [
        { text: '夜色把', lineText: '夜色把楼顶的灯拧成糖', line: 0, start: 0.4, end: 2.2, dur: 1.8,
          layout: 'columnsBig', enter: 'cursorSweep', exit: 'wipe', hold: 'still', inDur: 0.3, outDur: 0.25,
          stagger: 0.04, decor: [], params: { a: 1 }, scheme: 0, index: 0 },
        { text: '楼顶的灯拧成糖', lineText: '夜色把楼顶的灯拧成糖', line: 0, start: 2.2, end: 4.2, dur: 2.0,
          layout: 'ring', enter: 'blur', exit: 'cut', hold: 'pulse', inDur: 0.5, outDur: 0,
          stagger: 0.04, decor: [{ kind: 'rings' }], params: { b: 2 }, scheme: 1, index: 1 },
      ],
      events: [{ t: 0.4, type: 'chroma', amp: 1.98, dur: 0.25 }],
    },
  }, overrides || {});
  return archive;
}

function freshStore(policy) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  return pv.createPvArchiveStore(Object.assign({
    resolveDir: () => DATA,
    assertWritableRoot: () => DATA,
  }, policy || {}));
}

test('canonical key is stable and every header field changes it', () => {
  const base = { songKey: 's', lyricHash: 'l', lang: 'zh-Hans', aspect: '16:9', res: 1080, seed: 1, style: 'noir', srcFingerprint: 'f' };
  const first = pv.canonicalArchiveKey(base);
  assert.equal(first, pv.canonicalArchiveKey(Object.assign({}, base)));
  const keys = new Set([first]);
  Object.keys(base).forEach((field) => {
    const changed = Object.assign({}, base);
    changed[field] = changed[field] + 'X';
    keys.add(pv.canonicalArchiveKey(changed));
  });
  assert.equal(keys.size, 9, 'base plus one distinct key per field');
});

test('a well-formed archive validates', () => {
  const verdict = pv.validateArchive(okArchive());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.cuts, 2);
  assert.equal(verdict.events, 1);
});

// Each row mutates exactly one rule so a regression in that rule turns red alone.
const REJECTION_CASES = [
  ['PV_ARCHIVE_NOT_OBJECT', () => null],
  ['PV_SCHEMA_MISMATCH', () => okArchive({ pvSchema: 'mineradio-pv-v0' })],
  ['PV_ARCHIVE_MISSING_SONG_KEY', () => { const a = okArchive(); delete a.song.key; return a; }],
  ['PV_ARCHIVE_MISSING_LYRIC_HASH', () => { const a = okArchive(); delete a.source.lyricHash; return a; }],
  ['PV_ARCHIVE_MISSING_SRC_FINGERPRINT', () => { const a = okArchive(); delete a.jizura.srcFingerprint; return a; }],
  ['PV_ARCHIVE_TYPESET_LEAD_NOT_DISABLED', () => { const a = okArchive(); a.align.jizuraTypesetLeadApplied = true; return a; }],
  ['PV_ARCHIVE_MISSING_PLAN', () => { const a = okArchive(); delete a.plan; return a; }],
  ['PV_ARCHIVE_INLINE_FONT_TABLE', () => { const a = okArchive(); a.plan.fontTable = { gothic_black: {} }; return a; }],
  ['PV_PLAN_BAD_DURATION', () => { const a = okArchive(); a.plan.duration = 0; return a; }],
  ['PV_PLAN_BAD_SIZE', () => { const a = okArchive(); a.plan.W = 1; return a; }],
  ['PV_PLAN_NO_CUTS', () => { const a = okArchive(); a.plan.cuts = []; return a; }],
  ['PV_PLAN_TOO_MANY_CUTS', () => { const a = okArchive(); a.plan.cuts = new Array(4001).fill(a.plan.cuts[0]); return a; }],
  ['PV_CUT_MISSING_FIELD', () => { const a = okArchive(); delete a.plan.cuts[1].layout; return a; }],
  ['PV_CUT_BAD_TIME_RANGE', () => { const a = okArchive(); a.plan.cuts[1].end = a.plan.cuts[1].start; return a; }],
  ['PV_CUT_BAD_TEXT', () => { const a = okArchive(); a.plan.cuts[1].text = 7; return a; }],
  ['PV_CUT_TOO_MANY_DECOR', () => { const a = okArchive(); a.plan.cuts[1].decor = new Array(9).fill({ kind: 'rings' }); return a; }],
  ['PV_CUTS_NOT_SORTED', () => { const a = okArchive(); a.plan.cuts.reverse(); return a; }],
  ['PV_LINE_BAD_START', () => { const a = okArchive(); a.plan.lines[0].start = 'oops'; return a; }],
];

test('every rejection rule has its own red case', () => {
  REJECTION_CASES.forEach((entry) => {
    const verdict = pv.validateArchive(entry[1]());
    assert.equal(verdict.ok, false, entry[0] + ' must be rejected');
    assert.equal(verdict.error, entry[0], 'expected error code ' + entry[0] + ', got ' + verdict.error);
  });
});

test('unsorted cuts are rejected because J.cutAt binary-searches start times', () => {
  const a = okArchive();
  a.plan.cuts.reverse();                       // descending start times
  assert.equal(pv.validateArchive(a).error, 'PV_CUTS_NOT_SORTED');
});

test('write/read round-trip preserves the plan byte for byte', () => {
  const store = freshStore();
  const archive = okArchive();
  const written = store.write(archive);
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(written.cuts, 2);
  const readBack = store.read(archive.archiveKey);
  assert.equal(readBack.ok, true);
  assert.equal(JSON.stringify(readBack.archive.plan), JSON.stringify(archive.plan));
  assert.ok(readBack.archive.savedAt > 0);
  assert.ok(fs.existsSync(readBack.file));
  // The reported byte count has to describe the file that was written. It did not: savedAt was
  // stamped after the measurement, so every reported size was short by its own timestamp and the
  // pipeline e2e (statSync vs reported bytes) caught a 28,584 vs 28,7xx mismatch.
  assert.equal(written.bytes, fs.statSync(readBack.file).size, 'reported bytes must equal the file on disk');
  assert.equal(Buffer.byteLength(JSON.stringify(readBack.archive), 'utf8'), fs.statSync(readBack.file).size);
  // no .tmp litter left behind
  const litter = store.list().filter((e) => /\.tmp/.test(e.name));
  assert.deepEqual(litter, []);
});

test('has() and the not-found path behave for an unknown key', () => {
  const store = freshStore();
  assert.equal(store.has('mineradio-pv-v1|nope'), false);
  assert.equal(store.read('mineradio-pv-v1|nope').error, 'PV_ARCHIVE_NOT_FOUND');
});

test('a corrupt file is reported, never thrown', () => {
  const store = freshStore();
  const archive = okArchive();
  store.write(archive);
  const file = path.join(DATA, fs.readdirSync(DATA)[0]);
  fs.writeFileSync(file, '{"pvSchema": "mineradio-pv-v1", ');   // half-written JSON
  const readBack = store.read(archive.archiveKey);
  assert.equal(readBack.ok, false);
  assert.equal(readBack.error, 'PV_ARCHIVE_CORRUPT');
});

test('an archive over the byte cap is refused before touching the disk', () => {
  // A tiny injected cap exercises the same branch the 6 MB default guards; the default
  // is far above a real archive (~31 KB for 22 cuts) so it cannot be tripped cheaply.
  const store = freshStore({ maxArchiveBytes: 64 });
  const written = store.write(okArchive());
  assert.equal(written.ok, false);
  assert.equal(written.error, 'PV_ARCHIVE_TOO_LARGE');
  assert.ok(written.bytes > 64, 'the refused archive should really be over the injected cap');
  assert.equal(written.maxArchiveBytes, 64);
  assert.equal(store.list().length, 0, 'nothing may be written when the size cap trips');
});

test('the C-drive policy comes from the injected guard, not a second implementation', () => {
  const store = pv.createPvArchiveStore({
    resolveDir: () => DATA,
    assertWritableRoot: () => {
      const err = new Error('BEAT_CACHE_ON_C_DRIVE_DISABLED');
      err.code = 'BEAT_CACHE_ON_C_DRIVE_DISABLED';
      throw err;
    },
  });
  assert.throws(() => store.has('x'), /BEAT_CACHE_ON_C_DRIVE_DISABLED/);
  assert.throws(() => store.write(okArchive()), /BEAT_CACHE_ON_C_DRIVE_DISABLED/);
});

test('the store refuses to be built without an injected root policy', () => {
  assert.throws(() => pv.createPvArchiveStore({ resolveDir: () => DATA }), /assertWritableRoot/);
  assert.throws(() => pv.createPvArchiveStore({ assertWritableRoot: () => DATA }), /resolveDir/);
});

test('trim is byte-budgeted, LRU by mtime, and never evicts a pinned key', () => {
  const store = freshStore();
  const keys = [];
  for (let i = 0; i < 3; i++) {
    const a = okArchive({ archiveKey: pv.canonicalArchiveKey({
      songKey: 'song' + i, lyricHash: 'lh' + i, lang: 'zh-Hans', aspect: '16:9',
      res: 1080, seed: i, style: 'noir', srcFingerprint: 'fp',
    }) });
    store.write(a);
    keys.push(a.archiveKey);
  }
  const files = store.list();
  assert.equal(files.length, 3);
  // deterministic ages: file 0 oldest, file 2 newest
  const byName = {};
  files.forEach((f) => { byName[f.name] = true; });
  const sorted = files.slice().sort((a, b) => a.mtimeMs - b.mtimeMs);
  sorted.forEach((f, idx) => {
    const when = new Date(Date.UTC(2026, 0, 10 + idx, 0, 0, 0));
    fs.utimesSync(path.join(DATA, f.name), when, when);
  });
  const bytesEach = files[0].bytes;
  // Budget fits one archive. The pinned file is the OLDEST, so this only passes if
  // pinning genuinely overrides LRU rather than happening to align with it.
  const pinnedKey = keys[0];
  const pinnedName = pv.archiveFileName(pinnedKey).file;
  const result = store.trim(bytesEach + 10, [pinnedKey]);
  assert.equal(result.ok, true);
  // sorted ascending by age: song0(pinned), song1, song2 -> LRU evicts song1 first
  assert.deepEqual(result.removed, [sorted[1].name]);
  assert.ok(result.keptBytes <= bytesEach + 10, 'kept ' + result.keptBytes);
  // The pinned file stays on disk, so an honest report must count it: a caller that
  // reads only keptBytes would believe the cache is nearly empty right after trimming.
  assert.ok(result.pinnedBytes >= bytesEach, 'pinnedBytes should include the pinned archive, got ' + result.pinnedBytes);
  assert.equal(result.bytesOnDisk, result.keptBytes + result.pinnedBytes);
  assert.ok(result.bytesOnDisk > result.keptBytes);
  assert.equal(store.has(pinnedKey), true, 'a pinned archive may never be evicted');
  assert.equal(store.has(keys[1]), false, 'the oldest unpinned archive should be gone');
  assert.equal(store.has(keys[2]), true, 'the newest archive should survive');
  assert.equal(store.list().length, 2);
});

test('font table is stored once and reported stale after an engine bump', () => {
  const store = freshStore();
  const saved = store.saveFontTable({ gothic_black: { family: 'Noto Sans SC', weight: 700 } }, 'fp-1');
  assert.equal(saved.ok, true);
  assert.equal(saved.bytes > 0, true);
  assert.equal(store.loadFontTable('fp-1').ok, true);
  assert.deepEqual(store.loadFontTable('fp-1').fontTable.gothic_black.family, 'Noto Sans SC');
  const stale = store.loadFontTable('fp-2');
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'PV_FONT_TABLE_STALE');
  assert.equal(store.saveFontTable(null, 'fp').error, 'PV_FONT_TABLE_EMPTY');
});

test('real spike artifact validates through the same rules', () => {
  const planFile = path.join(__dirname, '..', 'tmp', 'pv-spike', 'plan-page.json');
  if (!fs.existsSync(planFile)) {
    console.log('[SKIP] tmp/pv-spike/plan-page.json absent - run the P0 spike to produce it');
    return;
  }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const fontTableBytes = Buffer.byteLength(JSON.stringify(plan.fontTable || {}), 'utf8');
  delete plan.fontTable;
  const archive = okArchive({
    archiveKey: pv.canonicalArchiveKey({
      songKey: 'qishui:spike', lyricHash: 'spikelh', lang: 'zh-Hans', aspect: '16:9',
      res: 1080, seed: 20260922, style: 'noir', srcFingerprint: 'spikefp',
    }),
    plan,
  });
  const verdict = pv.validateArchive(archive);
  assert.equal(verdict.ok, true, 'real plan rejected: ' + JSON.stringify(verdict));
  assert.equal(verdict.cuts, plan.cuts.length);
  const store = freshStore();
  const written = store.write(archive);
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.ok(written.bytes > 20000, 'expected a tens-of-KB archive, got ' + written.bytes);
  assert.ok(fontTableBytes > 1000, 'fontTable should have been worth stripping: ' + fontTableBytes);
  const readBack = store.read(archive.archiveKey);
  assert.equal(readBack.ok, true, JSON.stringify(readBack));
  assert.equal(readBack.archive.plan.cuts.length, plan.cuts.length);
});
