const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Fast tempos through the app's own beat pipeline.
//
// The chain used to fold anything above ~143 BPM to half speed in its post-processing and
// above ~167 BPM in the beat tracker itself, so a 180 BPM song was mapped at 90 BPM with a
// period that drifted off the real beats. Three things are checked here: the tracker is
// given the interval a fast song needs, the app's own post-processing keeps that spacing,
// and the consumers that pace themselves off the beat follow the song instead of a fixed
// 0.5 s floor. The pure functions and the option strings are read out of the shipped files,
// and the tracker is the vendored library the worker loads, run on a synthetic click track.

const appRoot = path.join(__dirname, '..');
// A mutation run points these at rewritten copies; the shipped files are the default.
const pick = (envName, relPath) => (process.env[envName] ? path.resolve(process.env[envName]) : path.join(appRoot, relPath));
const workerPath = pick('BEAT_WORKER_PATH', 'public/js/modules/03-beat/00-tempo-worker-cache-prefetch.js');
const analyzerPath = pick('BEAT_ANALYZER_PATH', 'public/js/modules/03-beat/01-audio-beat-analysis.js');
const runtimePath = pick('BEAT_RUNTIME_PATH', 'public/js/modules/01-scene/02-beat-camera-runtime.js');
const cachePath = pick('BEAT_CACHE_PATH', 'public/js/modules/03-beat/03-local-beat-cache-modal.js');
const vendorPath = path.join(appRoot, 'public', 'vendor', 'music-tempo.min.js');

const workerText = fs.readFileSync(workerPath, 'utf8');
const analyzerText = fs.readFileSync(analyzerPath, 'utf8');
const runtimeText = fs.readFileSync(runtimePath, 'utf8');
const cacheText = fs.readFileSync(cachePath, 'utf8');

// ---------------------------------------------------------------- the post-processing
// The two functions are sliced out of the shipped file, not copied: the test would otherwise
// agree with itself while the app kept halving fast songs.
const sliceStart = workerText.indexOf('function medianGap');
const sliceEnd = workerText.indexOf('function estimateTempoPhaseOffset');
assert(sliceStart > 0 && sliceEnd > sliceStart, 'the beat post-processing must be readable from the shipped module');
const helperContext = {};
vm.createContext(helperContext);
vm.runInContext(
  workerText.slice(sliceStart, sliceEnd) + '\nthis.medianGap = medianGap; this.normalizeMusicTempoBeats = normalizeMusicTempoBeats;',
  helperContext
);
const normalize = helperContext.normalizeMusicTempoBeats;
const medianGap = helperContext.medianGap;
assert.strictEqual(typeof normalize, 'function', 'normalizeMusicTempoBeats must be callable');

// Beats up to a little before the end: the post-processing drops anything within 50 ms of
// the track's end, which would otherwise look like a lost beat.
function series(bpm, seconds, from) {
  const step = 60 / bpm;
  const out = [];
  for (let t = from || 0.3; t < seconds - 0.2; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

// The tracker writes the interval it locked onto into the map. At every tempo the density
// must survive: the map keeps one beat per beat, not one per two.
{
  const readings = [];
  for (const bpm of [70, 100, 120, 150, 160, 175, 180, 200]) {
    const times = series(bpm, 40);
    const out = normalize(times, 40, bpm);
    const gap = medianGap(out, 0.05, 2);
    const want = 60 / bpm;
    assert.strictEqual(out.length, times.length,
      `${bpm} BPM: every beat must survive, ${times.length} in and ${out.length} out`);
    assert(Math.abs(gap - want) < 1e-3,
      `${bpm} BPM: the map spacing must be the song's beat (${want.toFixed(3)}s), got ${gap.toFixed(3)}s`);
    readings.push(`${bpm}->${gap.toFixed(3)}s`);
  }
  // A caller that cannot say what tempo it locked onto still must not halve the list.
  const noTempo = normalize(series(180, 40), 40, 0);
  assert.strictEqual(noTempo.length, series(180, 40).length,
    'without a tempo the median spacing is the only evidence, and it must not be doubled');
  console.log('  tempo kept: ' + readings.join(', ') + `; no tempo: ${noTempo.length}/${series(180, 40).length}`);
}

// What the rule is still for: the same beat detected twice is one beat.
{
  const times = series(70, 30);
  const doubled = [];
  for (let i = 0; i < times.length; i++) {
    doubled.push(times[i]);
    if (i % 3 === 1) doubled.push(Math.round((times[i] + 0.02) * 1000) / 1000);
  }
  const out = normalize(doubled, 30, 70);
  assert.strictEqual(out.length, times.length,
    `a beat detected twice must be one beat (${times.length} real, ${doubled.length} detected, ${out.length} kept)`);
  const fast = series(180, 30);
  const fastDup = [];
  for (let i = 0; i < fast.length; i++) {
    fastDup.push(fast[i]);
    if (i % 4 === 2) fastDup.push(Math.round((fast[i] + 0.015) * 1000) / 1000);
  }
  assert.strictEqual(normalize(fastDup, 30, 180).length, fast.length,
    'and the same at a fast tempo, where the duplicate sits closer than the old 0.44 s rule');
  console.log(`  duplicates removed: 70 BPM ${doubled.length - out.length}, fast ${fastDup.length - fast.length}`);
}

// ---------------------------------------------------------------- the shipped settings
// The tracker's interval: 0.22 s is 273 BPM, 1.2 s is 50 BPM.
{
  const options = {};
  for (const [key, name] of [['minBeatInterval', 'minBeatInterval'], ['maxBeatInterval', 'maxBeatInterval'], ['timeStep', 'timeStep'], ['bufferSize', 'bufferSize']]) {
    const m = new RegExp(name + ':(\\d+(?:\\.\\d+)?)').exec(workerText);
    assert(m, `the worker must pass ${name} to the tracker`);
    options[key] = Number(m[1]);
  }
  assert(options.minBeatInterval <= 0.25,
    `the tracker must be allowed a beat faster than 240 BPM, got minBeatInterval ${options.minBeatInterval}`);
  assert(options.maxBeatInterval >= 1.1,
    `and a beat slower than 55 BPM, got maxBeatInterval ${options.maxBeatInterval}`);
  options.hopSize = Math.max(128, Math.round(44100 * 0.010));
  options.expiryTime = 8;

  assert(/normalizeMusicTempoBeats\(musicTempoResult\.beats \|\| \[\], buffer\.duration, Number\(musicTempoResult\.tempo\) \|\| 0\)/.test(analyzerText),
    'the analysis must hand the tracker\'s own tempo to the post-processing');
  assert(/medianGap\(musicTempoBeats, 0\.22, 1\.20\)/.test(analyzerText),
    'the map\'s spacing must count fast gaps, not only 0.36 s and up');
  assert(/gridStep >= 0\.22 && gridStep <= 1\.20/.test(analyzerText),
    'the metronomic grid must be synthesised for fast songs too');
  assert(/gap >= 0\.20 && gap <= 1\.20/.test(analyzerText),
    'the gap histogram the grid is built from must count fast gaps');

  assert(/expectedGap >= \(dj \? 0\.32 : 0\.24\)/.test(runtimeText),
    'the realtime tempo lock must reach 250 BPM');
  assert(/while \(gap < \(dj \? 0\.32 : 0\.24\)\) gap \*= 2\.0;/.test(runtimeText),
    'the realtime tracker must not fold a 180 BPM interval to half speed');
  assert(/Math\.max\(dj \? 0\.255 : 0\.220, Math\.min\(dj \? 0\.430 : 0\.460/.test(runtimeText),
    'the realtime hit floor must sit under a 180 BPM beat');
  assert(/Math\.min\(beatCam\.minInterval, Math\.max\(0\.22, step \* 0\.86\)\)/.test(runtimeText),
    'the camera\'s pace must follow the song\'s spacing instead of a fixed 0.5 s');

  assert(/LOCAL_BEAT_MAP_VERSION = 3/.test(cacheText),
    'cached maps analysed by the half-tempo pipeline must be invalidated');
  assert(/if \(stored\.v !== LOCAL_BEAT_MAP_VERSION\) return null;/.test(cacheText),
    'a stale map must be dropped so the song is analysed again');
  console.log(`  tracker options from the module: ${JSON.stringify(options)}`);
}

// ------------------------------------------------- the tracker itself, on a click track
{
  const libContext = { self: {}, window: {}, console };
  libContext.globalThis = libContext;
  vm.createContext(libContext);
  vm.runInContext(fs.readFileSync(vendorPath, 'utf8'), libContext, { filename: vendorPath });
  const MusicTempo = libContext.self.MusicTempo || libContext.window.MusicTempo || libContext.MusicTempo;
  assert(MusicTempo, 'the vendored beat tracker must load');

  const SR = 44100;
  function clickTrack(bpm, seconds) {
    const n = Math.round(SR * seconds);
    // A plain Array: the library checks `instanceof Float32Array`, which a typed array from
    // this realm fails inside the library's own context.
    const out = new Array(n).fill(0);
    const period = 60 / bpm;
    let seed = 1234567;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k * period < seconds - 0.2; k++) {
      const at = Math.round((0.3 + k * period) * SR);
      const len = Math.round(SR * 0.14);
      for (let i = 0; i < len && at + i < n; i++) {
        const t = i / SR;
        const env = Math.exp(-t * 34);
        const tone = Math.sin(2 * Math.PI * 58 * t) * 0.8 + Math.sin(2 * Math.PI * 116 * t) * 0.18;
        const click = i < 40 ? (rand() * 2 - 1) * 0.5 : 0;
        out[at + i] += (tone + click) * env;
      }
    }
    return out;
  }

  const shipped = {};
  for (const name of ['minBeatInterval', 'maxBeatInterval', 'timeStep', 'bufferSize']) {
    shipped[name] = Number(new RegExp(name + ':(\\d+(?:\\.\\d+)?)').exec(workerText)[1]);
  }
  shipped.hopSize = Math.max(128, Math.round(SR * 0.010));
  shipped.expiryTime = 8;

  // Slow songs are checked as well: widening the interval must not let the tracker lock onto
  // double tempo (70 BPM read as 140) any more than it may halve a fast one.
  const readings = [];
  for (const bpm of [70, 100, 150, 180]) {
    const seconds = 16;
    const mt = new MusicTempo(clickTrack(bpm, seconds), shipped);
    const raw = (mt.beats || []).slice();
    const kept = normalize(raw, seconds, Number(mt.tempo) || 0);
    const gap = medianGap(kept, 0.05, 2);
    const want = 60 / bpm;
    assert(Math.abs(Number(mt.tempo) - bpm) / bpm < 0.03,
      `${bpm} BPM: the tracker must lock onto the song's own tempo, reported ${mt.tempo}`);
    assert(Math.abs(gap - want) / want < 0.03,
      `${bpm} BPM: the map spacing must be ${want.toFixed(3)}s, got ${gap.toFixed(3)}s (${kept.length} beats in ${seconds}s)`);
    readings.push(`${bpm} BPM -> tracker ${Number(mt.tempo).toFixed(1)}, map step ${gap.toFixed(3)}s, ${kept.length} beats`);
  }
  console.log('  ' + readings.join(' | '));
}

console.log('[OK] Fast tempos survive the beat pipeline: the tracker is given the interval, the map keeps it, and the consumers follow the song.');
