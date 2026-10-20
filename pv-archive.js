'use strict';

// PV archive store: on-disk cache for JIZURA-derived lyric-video plans.
//
// Policy is deliberately injected rather than duplicated: server.js already owns the
// only cache-root policy in this app (beatCacheRootInfo / ensureBeatMapCacheDir, which
// refuses C: and reports a missing drive), so this module takes those as callbacks
// instead of writing a second rule that can drift.
//
// Archive shape is grounded in the measured plan JSON (tmp/pv-spike/plan-page.json,
// 31150 B for 22 cuts): the plan is stored as produced by J.planForAE minus fontTable,
// which is shared static data and costs 3186 B per archive when duplicated.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// v2: archives written before repairPlanTails hold the engine's short lyric windows, so bumping
// the schema invalidates them by key and every song re-plans with its tails stretched. The stale
// v1 files are ordinary LRU victims from here on (trim is mtime-based over the whole directory).
const PV_SCHEMA = 'mineradio-pv-v2';
const FONT_TABLE_FILE = 'font-table.json';
const MAX_ARCHIVE_BYTES = 6 * 1024 * 1024;
const MAX_KEY_CHARS = 400;
const REQUIRED_CUT_FIELDS = ['text', 'start', 'end', 'layout', 'enter', 'exit', 'hold'];
const REQUIRED_HEADER = ['songKey', 'lyricHash', 'lang', 'aspect', 'res', 'seed', 'style', 'srcFingerprint'];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function canonicalArchiveKey(input) {
  const parts = REQUIRED_HEADER.map((field) => {
    const value = input && input[field];
    if (value === undefined || value === null || value === '') return '-';
    return String(value);
  });
  return PV_SCHEMA + '|' + parts.join('|');
}

function archiveFileName(key) {
  const raw = String(key || '').trim();
  if (!raw || raw.length > MAX_KEY_CHARS) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const label = String(raw.split('|')[1] || 'pv')
    .replace(/[^a-z0-9_.-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'pv';
  return { key: raw, hash, label, file: label + '-' + hash + '.json' };
}

// validateArchive returns { ok, error } and never throws on shape problems: the caller
// is a cache, and a corrupt entry must be reported, not turned into a 500.
function validateArchive(archive) {
  if (!archive || typeof archive !== 'object') return { ok: false, error: 'PV_ARCHIVE_NOT_OBJECT' };
  if (archive.pvSchema !== PV_SCHEMA) return { ok: false, error: 'PV_SCHEMA_MISMATCH' };
  if (!archive.song || !archive.song.key) return { ok: false, error: 'PV_ARCHIVE_MISSING_SONG_KEY' };
  if (!archive.source || !archive.source.lyricHash) return { ok: false, error: 'PV_ARCHIVE_MISSING_LYRIC_HASH' };
  if (!archive.jizura || !archive.jizura.srcFingerprint) return { ok: false, error: 'PV_ARCHIVE_MISSING_SRC_FINGERPRINT' };
  if (!archive.align || archive.align.jizuraTypesetLeadApplied !== false) {
    // 决定 D: the 0.2 s typeset lead belongs to Mineradio's per-song lyric offset, so an
    // archive that recorded it as applied would double-shift every line.
    return { ok: false, error: 'PV_ARCHIVE_TYPESET_LEAD_NOT_DISABLED' };
  }
  const plan = archive.plan;
  if (!plan || typeof plan !== 'object') return { ok: false, error: 'PV_ARCHIVE_MISSING_PLAN' };
  if (plan.fontTable) return { ok: false, error: 'PV_ARCHIVE_INLINE_FONT_TABLE' };
  if (!isFiniteNumber(plan.duration) || plan.duration <= 0) return { ok: false, error: 'PV_PLAN_BAD_DURATION' };
  if (!isFiniteNumber(plan.W) || !isFiniteNumber(plan.H) || plan.W < 2 || plan.H < 2) {
    return { ok: false, error: 'PV_PLAN_BAD_SIZE' };
  }
  if (!Array.isArray(plan.cuts) || plan.cuts.length === 0) return { ok: false, error: 'PV_PLAN_NO_CUTS' };
  if (plan.cuts.length > 4000) return { ok: false, error: 'PV_PLAN_TOO_MANY_CUTS' };
  for (let i = 0; i < plan.cuts.length; i++) {
    const cut = plan.cuts[i];
    if (!cut || typeof cut !== 'object') return { ok: false, error: 'PV_CUT_NOT_OBJECT', index: i };
    for (const field of REQUIRED_CUT_FIELDS) {
      if (!(field in cut)) return { ok: false, error: 'PV_CUT_MISSING_FIELD', index: i, field };
    }
    if (!isFiniteNumber(cut.start) || !isFiniteNumber(cut.end) || cut.end <= cut.start) {
      return { ok: false, error: 'PV_CUT_BAD_TIME_RANGE', index: i };
    }
    if (typeof cut.text !== 'string') return { ok: false, error: 'PV_CUT_BAD_TEXT', index: i };
    if (Array.isArray(cut.decor) && cut.decor.length > 8) {
      return { ok: false, error: 'PV_CUT_TOO_MANY_DECOR', index: i };
    }
  }
  // Cuts are consumed by a binary search over start times (J.cutAt), so an unsorted
  // archive is not merely ugly: it silently resolves to the wrong shot.
  for (let i = 1; i < plan.cuts.length; i++) {
    if (plan.cuts[i].start < plan.cuts[i - 1].start) {
      return { ok: false, error: 'PV_CUTS_NOT_SORTED', index: i };
    }
  }
  if (Array.isArray(plan.lines) && plan.lines.some((line) => !isFiniteNumber(line.start))) {
    return { ok: false, error: 'PV_LINE_BAD_START' };
  }
  return { ok: true, cuts: plan.cuts.length, lines: (plan.lines || []).length, events: (plan.events || []).length };
}

function createPvArchiveStore(options) {
  const opts = options || {};
  const resolveDir = opts.resolveDir;
  const assertWritableRoot = opts.assertWritableRoot;
  const now = opts.now || (() => Date.now());
  // The cap is policy, not a constant: measured archives are ~31 KB for 22 cuts (~190 KB
  // for a 4 minute song), while the 4000-cut ceiling allows a multi-hour mix to reach
  // several MB. Callers may tighten it; tests must be able to prove the branch fires.
  const maxArchiveBytes = Number(opts.maxArchiveBytes) > 0 ? Number(opts.maxArchiveBytes) : MAX_ARCHIVE_BYTES;
  if (typeof resolveDir !== 'function') throw new Error('PV_STORE_REQUIRES_resolveDir');
  if (typeof assertWritableRoot !== 'function') throw new Error('PV_STORE_REQUIRES_assertWritableRoot');

  function dir() {
    const info = assertWritableRoot();          // throws BEAT_CACHE_ON_C_DRIVE_DISABLED / _UNAVAILABLE
    const target = path.resolve(resolveDir(info));
    fs.mkdirSync(target, { recursive: true });
    return target;
  }

  function pathFor(key) {
    const named = archiveFileName(key);
    if (!named) return null;
    return { named, file: path.join(dir(), named.file) };
  }

  function read(key) {
    const located = pathFor(key);
    if (!located) return { ok: false, error: 'PV_KEY_INVALID' };
    if (!fs.existsSync(located.file)) return { ok: false, error: 'PV_ARCHIVE_NOT_FOUND' };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(located.file, 'utf8'));
    } catch (e) {
      return { ok: false, error: 'PV_ARCHIVE_CORRUPT', detail: String(e && e.message || e), file: located.file };
    }
    const verdict = validateArchive(parsed);
    if (!verdict.ok) return Object.assign({ ok: false, file: located.file }, verdict);
    return Object.assign({ ok: true, file: located.file, archive: parsed }, verdict);
  }

  function has(key) {
    const located = pathFor(key);
    return !!(located && fs.existsSync(located.file));
  }

  function write(archive) {
    if (!archive || !archive.archiveKey) return { ok: false, error: 'PV_WRITE_REQUIRES_ARCHIVE_KEY' };
    const verdict = validateArchive(archive);
    if (!verdict.ok) return Object.assign({ ok: false, bytes: Buffer.byteLength(JSON.stringify(archive), 'utf8') }, verdict);
    // savedAt must be stamped BEFORE the size is measured: reporting a byte count that excludes
    // it made the route's number disagree with the file it had just written (caught by the
    // pipeline e2e, which compares the reported size with statSync on the file).
    archive.savedAt = now();
    const bytes = Buffer.byteLength(JSON.stringify(archive), 'utf8');
    if (bytes > maxArchiveBytes) return { ok: false, error: 'PV_ARCHIVE_TOO_LARGE', bytes, maxArchiveBytes };
    const located = pathFor(archive.archiveKey);
    if (!located) return { ok: false, error: 'PV_KEY_INVALID' };
    // .tmp then rename, same as writeBeatMapCache: a reader must never see a half file.
    const tmp = located.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(archive));
    fs.renameSync(tmp, located.file);
    return Object.assign({ ok: true, file: located.file, bytes, key: archive.archiveKey }, verdict);
  }

  // LRU by file mtime, byte-budget based, never evicting keys the caller pins
  // (the playing track plus the look-ahead window).
  function trim(maxBytes, pinKeys) {
    const pinned = new Set(Array.isArray(pinKeys) ? pinKeys.filter(Boolean).map((k) => {
      const named = archiveFileName(k);
      return named ? named.file : '';
    }) : []);
    const target = dir();
    const entries = fs.readdirSync(target)
      .filter((name) => /\.json$/.test(name) && name !== FONT_TABLE_FILE && !pinned.has(name))
      .map((name) => {
        let stat = null;
        try { stat = fs.statSync(path.join(target, name)); } catch (e) { stat = null; }
        return stat && stat.isFile() ? { name, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = entries.reduce((a, e) => a + e.bytes, 0);
    // Pinned archives are excluded from eviction but must still be counted: reporting
    // only the evictable remainder would tell a memory-governance caller the disk is
    // nearly empty right after it declined to trim.
    let pinnedBytes = 0;
    pinned.forEach((name) => {
      try {
        const st = fs.statSync(path.join(target, name));
        if (st.isFile()) pinnedBytes += st.size;
      } catch (e) { /* a pinned file that vanished is simply not counted */ }
    });
    const removed = [];
    while (total > maxBytes && entries.length) {
      const victim = entries.pop();
      try {
        fs.unlinkSync(path.join(target, victim.name));
        total -= victim.bytes;
        removed.push(victim.name);
      } catch (e) {
        total -= victim.bytes;   // unreadable entry: drop it from the budget and keep going
      }
    }
    return { ok: true, budgetBytes: maxBytes, keptBytes: total, pinnedBytes, bytesOnDisk: total + pinnedBytes, removed };
  }

  // The font table is static per engine build, so it lives once instead of per archive
  // (measured: 3186 B of every 31150 B archive).
  function saveFontTable(fontTable, fingerprint) {
    if (!fontTable || typeof fontTable !== 'object') return { ok: false, error: 'PV_FONT_TABLE_EMPTY' };
    const file = path.join(dir(), FONT_TABLE_FILE);
    const payload = { pvSchema: PV_SCHEMA, srcFingerprint: String(fingerprint || ''), fontTable, savedAt: now() };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
    return { ok: true, file, bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8') };
  }

  function loadFontTable(fingerprint) {
    const file = path.join(dir(), FONT_TABLE_FILE);
    if (!fs.existsSync(file)) return { ok: false, error: 'PV_FONT_TABLE_NOT_FOUND' };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      return { ok: false, error: 'PV_FONT_TABLE_CORRUPT' };
    }
    if (fingerprint && parsed.srcFingerprint && parsed.srcFingerprint !== fingerprint) {
      return { ok: false, error: 'PV_FONT_TABLE_STALE', have: parsed.srcFingerprint, want: fingerprint };
    }
    return { ok: true, fontTable: parsed.fontTable, srcFingerprint: parsed.srcFingerprint };
  }

  function list() {
    const target = dir();
    return fs.readdirSync(target).filter((name) => /\.json$/.test(name)).map((name) => {
      let stat = null;
      try { stat = fs.statSync(path.join(target, name)); } catch (e) { return null; }
      return stat && stat.isFile() ? { name, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
    }).filter(Boolean);
  }

  return {
    PV_SCHEMA,
    canonicalArchiveKey,
    archiveFileName,
    validateArchive,
    read,
    has,
    write,
    trim,
    list,
    saveFontTable,
    loadFontTable,
  };
}

module.exports = {
  PV_SCHEMA,
  FONT_TABLE_FILE,
  MAX_ARCHIVE_BYTES,
  canonicalArchiveKey,
  archiveFileName,
  validateArchive,
  createPvArchiveStore,
};
