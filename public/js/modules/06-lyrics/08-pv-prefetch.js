'use strict';

// PV archive prefetch (docs/PLAN_JIZURA_PV.md §4): when the existing queue lyric prefetch pulls
// an upcoming song's lyrics, this turns them into a JIZURA plan and asks the server to store it.
// The playback path then only has to read a plan at the moment a PV is shown.
//
// It rides the queue the app already walks (06-lyrics/00-lyrics-fetch-parse.js) instead of
// starting a second scheduler: that flow is already serial, already checks a token for staleness
// and already knows which songs have lyrics.
//
// Off by default. The persisted switch arrives with the visual preset (preset 13 in §8 P1);
// until then window.__mineradioPvPrefetchOverride drives it, which is also how the probe
// exercises both states.

var pvPrefetchEnabled = false;
var pvPrefetchInFlight = false;
var pvPrefetchAttempted = {};
var pvPrefetchAttemptCount = 0;
var pvPrefetchStats = { planned: 0, hits: 0, failed: 0, skipped: 0, notStored: 0, lastSongKey: '', lastReason: '', lastAt: 0 };

function pvPrefetchActive() {
  if (typeof window !== 'undefined' && window.__mineradioPvPrefetchOverride === true) return true;
  if (typeof window !== 'undefined' && window.__mineradioPvPrefetchOverride === false) return false;
  return pvPrefetchEnabled === true;
}

function setPvPrefetchEnabled(on) {
  pvPrefetchEnabled = !!on;
  if (!pvPrefetchEnabled) {
    pvPrefetchAttempted = {};
    pvPrefetchAttemptCount = 0;
  }
  return pvPrefetchEnabled;
}

function pvPrefetchState() {
  return {
    active: pvPrefetchActive(),
    inFlight: pvPrefetchInFlight,
    attempted: pvPrefetchAttemptCount,
    stats: Object.assign({}, pvPrefetchStats),
  };
}

// The song key is the same identity the lyric cache uses, so a plan and its lyrics can never
// disagree about which song they belong to.
function pvSongKeyFor(song) {
  if (typeof persistentLyricCacheKey === 'function') {
    var key = persistentLyricCacheKey(song);
    if (key) return String(key);
  }
  if (!song) return '';
  var parts = [song.provider || song.source || '', song.id || song.mid || song.songmid || song.hash || '', song.name || song.title || ''];
  var joined = parts.join('|').replace(/\|+$/, '');
  return joined.indexOf('|') >= 0 ? joined : '';
}

// Deterministic per song: a random seed would mean the same song plans differently every time
// and the archive would never be hit again. FNV-1a over the key, folded into JIZURA's seed range.
function pvSeedForSongKey(songKey) {
  var h = 2166136261;
  var text = String(songKey || 'pv');
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 900000000) + 1000;
}

// The user's lyric typesetting is Chinese (plus translations), with Japanese as the other case
// the engine has faces for. Anything else keeps the default rather than guessing per line.
function pvLangForLines(lines) {
  var han = 0, kana = 0, other = 0;
  var text = (lines || []).map(function (line) { return String(line && line.text || ''); }).join('');
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0x3040 && code <= 0x30ff) kana++;
    else if (code >= 0x4e00 && code <= 0x9fff) han++;
    else if (code > 0x2e80) other++;
  }
  if (kana > han) return 'ja';
  if (han > 0) return 'zh-Hans';
  return 'en';
}

function pvRecipeForSong(song, lang) {
  return {
    lang: lang,
    style: 'noir',
    seed: pvSeedForSongKey(pvSongKeyFor(song)),
    aspect: '16:9',
    res: 720,
    fps: 24,
    koma: 12,
    title: String((song && (song.name || song.title)) || ''),
    artist: String((song && (song.artist || song.artists || song.singer)) || ''),
  };
}

// Called from the queue lyric prefetch with the parsed lyric state. Never throws: a PV is an
// extra, and a failure here must not disturb lyric loading or playback.
function pvPrefetchFromLyricState(song, state) {
  try {
    if (!pvPrefetchActive()) {
      pvPrefetchStats.skipped++;
      pvPrefetchStats.lastReason = 'disabled';
      return Promise.resolve({ ok: false, reason: 'disabled' });
    }
    if (pvPrefetchInFlight) {
      pvPrefetchStats.skipped++;
      pvPrefetchStats.lastReason = 'busy';
      return Promise.resolve({ ok: false, reason: 'busy' });
    }
    if (!state || !state.usableLyric || !Array.isArray(state.lines) || !state.lines.length) {
      pvPrefetchStats.skipped++;
      pvPrefetchStats.lastReason = 'no-lyrics';
      return Promise.resolve({ ok: false, reason: 'no-lyrics' });
    }
    // A fallback "lyric" is synthesised placeholder text, so a PV built from it would be a shot
    // list for words nobody sang. Skip it rather than cache something wrong.
    if (state.timingSource === 'fallback' || state.lines.some(function (line) { return line && line.fallback; })) {
      pvPrefetchStats.skipped++;
      pvPrefetchStats.lastReason = 'fallback-lyrics';
      return Promise.resolve({ ok: false, reason: 'fallback-lyrics' });
    }
    var songKey = pvSongKeyFor(song);
    if (!songKey) {
      pvPrefetchStats.skipped++;
      pvPrefetchStats.lastReason = 'no-song-key';
      return Promise.resolve({ ok: false, reason: 'no-song-key' });
    }
    if (pvPrefetchAttempted[songKey]) {
      pvPrefetchStats.skipped++;
      pvPrefetchStats.lastReason = 'already-attempted';
      return Promise.resolve({ ok: false, reason: 'already-attempted' });
    }
    if (typeof formatLyricsForPv !== 'function' || typeof pvLyricHash !== 'function' || typeof apiJson !== 'function') {
      pvPrefetchStats.failed++;
      pvPrefetchStats.lastReason = 'formatter-missing';
      return Promise.resolve({ ok: false, reason: 'formatter-missing' });
    }
    var recipe = pvRecipeForSong(song, pvLangForLines(state.lines));
    var lyrics = formatLyricsForPv(state.lines, { title: recipe.title, artist: recipe.artist });
    var body = {
      song: {
        key: songKey,
        provider: String((song && (song.provider || song.source)) || ''),
        title: recipe.title,
        artist: recipe.artist,
        duration: Number(song && song.duration) || 0,
      },
      lyricHash: pvLyricHash(lyrics),
      hasTranslation: !!(state.translationLines && state.translationLines.length),
      timingSource: state.timingSource || 'lrc',
      lyricOffsetMs: 0,   // the per-song offset is applied when drawing, never baked into the plan
      payload: Object.assign({ lyrics: lyrics }, recipe),
    };
    pvPrefetchAttempted[songKey] = true;
    pvPrefetchAttemptCount++;
    pvPrefetchInFlight = true;
    pvPrefetchStats.lastSongKey = songKey;
    pvPrefetchStats.lastAt = Date.now();
    return apiJson('/api/pv/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 30000,
    }).then(function (res) {
      pvPrefetchInFlight = false;
      if (res && res.ok) {
        if (res.hit) pvPrefetchStats.hits++;
        else pvPrefetchStats.planned++;
        if (res.stored === false) pvPrefetchStats.notStored++;
        pvPrefetchStats.lastReason = res.stored === false ? ('not-stored:' + (res.storeReason || '')) : (res.hit ? 'hit' : 'planned');
        return { ok: true, hit: !!res.hit, key: res.key, cuts: res.cuts, lyricFingerprint: res.lyricFingerprint };
      }
      pvPrefetchStats.failed++;
      pvPrefetchStats.lastReason = (res && res.reason) || 'route-refused';
      return { ok: false, reason: pvPrefetchStats.lastReason };
    }).catch(function (err) {
      pvPrefetchInFlight = false;
      pvPrefetchStats.failed++;
      pvPrefetchStats.lastReason = String((err && err.message) || err);
      return { ok: false, reason: pvPrefetchStats.lastReason };
    });
  } catch (error) {
    pvPrefetchInFlight = false;
    pvPrefetchStats.failed++;
    pvPrefetchStats.lastReason = String((error && error.message) || error);
    return Promise.resolve({ ok: false, reason: pvPrefetchStats.lastReason });
  }
}