'use strict';

// Mineradio lyric lines -> JIZURA lyric text.
//
// JIZURA's grammar (verified against upstream src/08_planner.js:49-70 and README:111-118):
//   [mm:ss.xx]text      timestamp, possibly repeated on one line
//   text|note          the part after | becomes the small annotation layer
//   a/b                an explicit cut point inside the line
//   *word*             emphasis (bigger/impactful shots get picked)
//   trailing !         flash + shake
//   [间奏 N]           N seconds of instrumental, no lyric on screen
//   lines starting with # are comments; blank lines mean a part boundary
//
// Consequences this module has to survive: lyric text coming from a platform can itself
// contain "[00:12.00]" or "|" or "#", which would be *parsed as markup*. Anything that
// could change how a line is interpreted is neutralised. The output must also be a pure
// function of its input, because the archive cache key is a hash of this string.

var PV_INTERLUME_THRESHOLD_SEC = 4;
var PV_INTERLUME_MAX_SEC = 120;

function pvTimeTag(seconds) {
  var t = Math.max(0, Number(seconds) || 0);
  // Work in integer hundredths and carry once, from the bottom up. Carrying "seconds -= 100"
  // looks right and silently shifts every value above 1s forward by a minute.
  var total = Math.round(t * 100);
  var minutes = Math.floor(total / 6000);
  var rest = total - minutes * 6000;
  var sec = Math.floor(rest / 100);
  var cs = rest - sec * 100;
  return '[' + (minutes < 10 ? '0' : '') + minutes + ':' + (sec < 10 ? '0' : '') + sec + '.' + (cs < 10 ? '0' : '') + cs + ']';
}

// Full-width lookalikes keep the meaning a reader expects while no longer being markup.
function pvNeutraliseInlineMarkup(text) {
  return String(text == null ? '' : text)
    .replace(/\|/g, '\uFF5C')      // annotation separator -> full-width bar
    .replace(/\//g, '\u2215');     // cut separator        -> division sign
}

function pvSanitiseLead(text) {
  var value = String(text == null ? '' : text).trim();
  // A leading [ turns the line into a tag or timestamp; a leading # turns it into a comment.
  while (value.charAt(0) === '[' || value.charAt(0) === '#' || value.charAt(0) === '/') {
    value = (value.charAt(0) === '[' ? '\uFF3B' : value.charAt(0) === '#' ? '\uFF03' : '\u2215') + value.slice(1);
  }
  return value;
}

function pvCleanLyricText(text) {
  return pvNeutraliseInlineMarkup(pvSanitiseLead(text)).replace(/\s+/g, ' ').trim();
}

function pvLyricLineTimeSeconds(line, index, fallbackStep) {
  var candidates = [line.t, line.time, line.start, line.startTime];
  for (var i = 0; i < candidates.length; i++) {
    var value = candidates[i];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && value !== '') {
      var parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return index * fallbackStep;
}

function pvLineEndSeconds(line, startSeconds) {
  if (typeof line.duration === 'number' && Number.isFinite(line.duration) && line.duration > 0) {
    return Math.max(startSeconds + 0.2, startSeconds + line.duration);
  }
  var candidates = [line.visEnd, line.end];
  for (var i = 0; i < candidates.length; i++) {
    var value = candidates[i];
    if (typeof value === 'number' && Number.isFinite(value) && value > startSeconds) return value;
  }
  return startSeconds + 1.2;
}

// Main entry. Returns the JIZURA lyric string; callers hash the result for the cache key.
// Stats go into options.statsOut, because a string primitive cannot carry properties
// (assigning one under 'use strict' throws).
function formatLyricsForPv(lines, options) {
  var opts = options || {};
  var source = Array.isArray(lines) ? lines : [];
  var interludeThreshold = Number(opts.interludeThresholdSec) > 0 ? Number(opts.interludeThresholdSec) : PV_INTERLUME_THRESHOLD_SEC;
  var fallbackStep = Number(opts.fallbackStepSec) > 0 ? Number(opts.fallbackStepSec) : 3;
  var emitMeta = opts.emitMeta !== false;
  var rows = [];
  var stats = { droppedNoText: 0, clampedOutOfOrder: 0, interludes: 0, annotationLines: 0, lines: 0 };

  for (var index = 0; index < source.length; index++) {
    var line = source[index] || {};
    var main = pvCleanLyricText(line.text);
    var note = pvCleanLyricText(line.translation || line.note || '');
    // A line with only an annotation still has something worth showing; show it as the text
    // rather than emitting an empty main line, which JIZURA would drop anyway.
    if (!main && note) { main = note; note = ''; }
    if (!main) { stats.droppedNoText++; continue; }
    var start = pvLyricLineTimeSeconds(line, index, fallbackStep);
    rows.push({ start: start, end: pvLineEndSeconds(line, start), main: main, note: note });
  }

  var out = [];
  if (emitMeta) {
    var title = pvSanitiseLead(opts.title == null ? '' : String(opts.title)).replace(/[\r\n]+/g, ' ');
    var artist = pvSanitiseLead(opts.artist == null ? '' : String(opts.artist)).replace(/[\r\n]+/g, ' ');
    if (title) out.push('[ti:' + title + ']');
    if (artist) out.push('[ar:' + artist + ']');
  }

  var previousEnd = -1;
  for (var row = 0; row < rows.length; row++) {
    var item = rows[row];
    var startSeconds = item.start;
    if (previousEnd > startSeconds) {
      // Overlapping or unsorted input must not produce a backwards timestamp: nudge forward.
      startSeconds = previousEnd + 0.02;
      stats.clampedOutOfOrder++;
    }
    if (previousEnd >= 0 && startSeconds - previousEnd >= interludeThreshold) {
      var gapSeconds = Math.min(PV_INTERLUME_MAX_SEC, Math.round(startSeconds - previousEnd));
      if (gapSeconds >= 1) {
        out.push('[\u95F4\u594F ' + gapSeconds + ']');
        stats.interludes++;
      }
    }
    var text = item.main;
    if (item.note) {
      text += '|' + item.note;
      stats.annotationLines++;
    }
    out.push(pvTimeTag(startSeconds) + text);
    previousEnd = Math.max(item.end, startSeconds + 0.2);
  }

  var result = out.join('\n');
  stats.lines = rows.length;
  if (opts.statsOut && typeof opts.statsOut === 'object') Object.assign(opts.statsOut, stats);
  return result;
}

// FNV-1a 64-bit, hex. Not cryptographic: it only has to be stable for identical input and
// collide-proof across a handful of archives, and the store validates contents anyway.
function pvLyricHash(text) {
  var value = String(text == null ? '' : text);
  var h1 = 0x811c9dc5;
  var h2 = 0x01000193;
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    h1 ^= code & 0xFFFF;
    h1 = (h1 * 0x01000193) >>> 0;
    h2 ^= (code >>> 16) | (h1 & 0xFF);
    h2 = (h2 * 0x01000193) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}
