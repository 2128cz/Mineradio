'use strict';

// PV archive prefetch: when the existing queue lyric prefetch pulls
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
// With the cache refused (the default until the cache-drive decision lands) a prefetch plans and
// then throws the plan away: 2.1MB of engine plus ~30ms per song for nothing. Remember the
// refusal, name it as a skip reason, and retry occasionally so turning the cache back on does
// not require a restart.
var pvPrefetchCacheBlockedAt = 0;
var pvPrefetchCacheBlockedReason = '';
var PV_PREFETCH_CACHE_RETRY_MS = 5 * 60 * 1000;

function pvPrefetchCacheUsable(now) {
  if (!pvPrefetchCacheBlockedAt) return true;
  if ((now || Date.now()) - pvPrefetchCacheBlockedAt >= PV_PREFETCH_CACHE_RETRY_MS) {
    pvPrefetchCacheBlockedAt = 0;
    pvPrefetchCacheBlockedReason = '';
    return true;
  }
  return false;
}

// The entry a settings change would use ("I pointed the cache at another drive"): forget a
// refusal instead of waiting out the retry window. Probes use it to start from a clean state.
function pvPrefetchResetCacheBlock() {
  pvPrefetchCacheBlockedAt = 0;
  pvPrefetchCacheBlockedReason = '';
  return true;
}

function pvPrefetchNoteStoreRefusal(reason) {
  pvPrefetchCacheBlockedAt = Date.now();
  pvPrefetchCacheBlockedReason = String(reason || 'not-stored');
}

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
    cacheWritable: pvPrefetchCacheUsable(),
    cacheBlockedReason: pvPrefetchCacheBlockedReason,
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

// The aspects the vendored engine composes a layout for (J.designSize). A window whose shape is
// far from 16:9 gets a plan built for its own shape: the engine then lays lines out for a tall
// or ultra-wide frame instead of shrinking a 16:9 composition into letterbox bars.
var PV_ASPECT_RATIOS = [
  ['21:9', 21 / 9], ['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1],
  ['4:5', 4 / 5], ['3:4', 3 / 4], ['9:16', 9 / 16]
];

// Nearest on the log scale, so 16:10 reads as 16:9 and 5:4 does not become 1:1 by rounding.
// The size arrives as arguments (falling back to the window) so a probe can walk the bands
// without resizing the app.
function pvAspectForViewport(width, height) {
  var w = Math.max(0, Number(width) || 0) || (typeof window !== 'undefined' ? Number(window.innerWidth) || 0 : 0);
  var h = Math.max(0, Number(height) || 0) || (typeof window !== 'undefined' ? Number(window.innerHeight) || 0 : 0);
  if (w < 2 || h < 2) return '16:9';
  var ratio = Math.log(w / h);
  var best = '16:9', gap = Infinity;
  for (var i = 0; i < PV_ASPECT_RATIOS.length; i++) {
    var d = Math.abs(ratio - Math.log(PV_ASPECT_RATIOS[i][1]));
    if (d < gap) { gap = d; best = PV_ASPECT_RATIOS[i][0]; }
  }
  return best;
}

function pvRecipeForSong(song, lang) {
  // Plan-level dials come from the console (07-fx/10-pv-tuning.js). density changes how many
  // shots a line is broken into and unify whether repeated lines reuse a layout, so both are
  // part of the archive identity; koma only changes the drawing clock.
  var dials = typeof pvTuningPlanParams === 'function' ? pvTuningPlanParams() : null;
  return {
    lang: lang,
    style: 'noir',
    seed: pvSeedForSongKey(pvSongKeyFor(song)),
    aspect: pvAspectForViewport(),
    res: 720,
    fps: 24,
    koma: dials && dials.koma > 0 ? dials.koma : 12,
    density: dials ? dials.density : undefined,
    unify: dials ? dials.unify : true,
    title: String((song && (song.name || song.title)) || ''),
    artist: String((song && (song.artist || song.artists || song.singer)) || ''),
  };
}

// The plan request is shared by the render layer (needs one now) and the prefetch (wants one
// later), so the payload shape lives in exactly one place.
function pvBuildPlanRequest(song, lines, translationLines, timingSource) {
  if (typeof formatLyricsForPv !== 'function' || typeof pvLyricHash !== 'function') return null;
  var songKey = pvSongKeyFor(song);
  if (!songKey || !Array.isArray(lines) || !lines.length) return null;
  var recipe = pvRecipeForSong(song, pvLangForLines(lines));
  // lineEnds is the repair channel: the lyric grammar can only carry a line's start, so the
  // ends this app already knows (and already clamps to 12 s in finalizeLyricLineDurations) go
  // alongside the text for the planner to stretch the shot list back onto them.
  var lineEnds = [];
  var lyrics = formatLyricsForPv(lines, { title: recipe.title, artist: recipe.artist, endsOut: lineEnds });
  return {
    songKey: songKey,
    body: {
      song: {
        key: songKey,
        provider: String((song && (song.provider || song.source)) || ''),
        title: recipe.title,
        artist: recipe.artist,
        duration: Number(song && song.duration) || 0,
      },
      lyricHash: pvLyricHash(lyrics),
      hasTranslation: !!(translationLines && translationLines.length),
      timingSource: timingSource || 'lrc-line',
      lyricOffsetMs: 0,   // the per-song offset is applied when drawing, never baked into the plan
      payload: Object.assign({ lyrics: lyrics, lineEnds: lineEnds }, recipe),
    },
  };
}

// The single place that talks to /api/pv/plan, and the single place that interprets a refusal:
// a cache problem arrives either as stored:false or as a route-level failure naming PV_CACHE_*,
// and both mean the next song would pay for a plan that gets thrown away for the same reason.
function pvPostPlan(request) {
  if (!request || typeof apiJson !== 'function') return Promise.resolve({ ok: false, reason: 'formatter-missing' });
  return apiJson('/api/pv/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
    timeoutMs: 30000,
  }).then(function (res) {
    if (res && res.ok) {
      if (res.stored === false) {
        pvPrefetchStats.notStored++;
        pvPrefetchNoteStoreRefusal(res.storeReason);
      }
      return {
        ok: true,
        hit: !!res.hit,
        stored: res.stored !== false,
        key: res.key,
        cuts: res.cuts,
        lyricFingerprint: res.lyricFingerprint,
        storeReason: res.storeReason || '',
      };
    }
    var reason = (res && res.reason) || 'route-refused';
    if (/^PV_CACHE_/.test(reason)) {
      pvPrefetchStats.notStored++;
      pvPrefetchNoteStoreRefusal(reason);
    }
    return { ok: false, stored: false, reason: reason };
  }).catch(function (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  });
}

// The render layer's entry: same request, but no prefetch switch and no per-song dedupe - this
// is the song being watched right now, so it needs the archive immediately.
function pvEnsurePlanNow(song, lines, translationLines, opts) {
  var request = pvBuildPlanRequest(song, lines, translationLines, 'lrc-line');
  if (!request) return Promise.resolve({ ok: false, reason: 'no-plan-payload' });
  // 重新生成: ask the route to drop the stored archive for this key before planning, so an
  // unchanged request means "build it again" rather than "hand me the cache".
  if (opts && opts.bust === true) request.body.payload.bust = true;
  return pvPostPlan(request);
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
    if (!pvPrefetchCacheUsable()) {
      pvPrefetchStats.skipped++;
      pvPrefetchStats.lastReason = 'cache-unwritable:' + (pvPrefetchCacheBlockedReason || 'unknown');
      return Promise.resolve({ ok: false, reason: 'cache-unwritable', storeReason: pvPrefetchCacheBlockedReason });
    }
    var request = pvBuildPlanRequest(song, state.lines, state.translationLines, state.timingSource);
    if (!request) {
      pvPrefetchStats.failed++;
      pvPrefetchStats.lastReason = 'formatter-missing';
      return Promise.resolve({ ok: false, reason: 'formatter-missing' });
    }
    pvPrefetchAttempted[songKey] = true;
    pvPrefetchAttemptCount++;
    pvPrefetchInFlight = true;
    pvPrefetchStats.lastSongKey = songKey;
    pvPrefetchStats.lastAt = Date.now();
    return pvPostPlan(request).then(function (res) {
      pvPrefetchInFlight = false;
      if (res.ok) {
        if (res.hit) pvPrefetchStats.hits++;
        else pvPrefetchStats.planned++;
        pvPrefetchStats.lastReason = res.stored === false ? ('not-stored:' + (res.storeReason || '')) : (res.hit ? 'hit' : 'planned');
        return res;
      }
      pvPrefetchStats.failed++;
      pvPrefetchStats.lastReason = res.reason || 'route-refused';
      return res;
    });
  } catch (error) {
    pvPrefetchInFlight = false;
    pvPrefetchStats.failed++;
    pvPrefetchStats.lastReason = String((error && error.message) || error);
    return Promise.resolve({ ok: false, reason: pvPrefetchStats.lastReason });
  }
}