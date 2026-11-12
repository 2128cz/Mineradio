'use strict';

// 节奏股市 / RHYTHM MARKET (preset 16)
//
// A stock candlestick chart whose every number comes from the song's own samples, drawn in
// front of a checkerboard wall of binarised marks. The chart only ever grows forward: a candle
// that has been drawn is never moved again, and the curve reaches its full shape only when the
// song ends. The camera follows the growing head with damping.
//
// Two clocks, on purpose. The DATA is a pure function of the samples (03-beat/07-market-series.js),
// so the candle a playhead belongs to is floor(t*sr/chunk) - a seek to the far end lands exactly
// where it should, the same guarantee the lyric presets give their rows. The DISPLAY is a second
// position that chases that one, and only the display is time-stretched: a drum hit drops its
// rate, holds it there, then lets it rebound exponentially and run over speed until the backlog
// of un-drawn candles is replayed. The camera damps against real dt and follows the displayed
// head, so it parks at the hit by itself - it does not need a clock of its own.
//
// The wall's marks are binarised colour channels of the song's own cover. No third-party logo is
// bundled: the question of whether real listed-company marks may be reproduced here was left
// open, and a preset that ships in a public fork cannot answer it by guessing.

var MARKET_PRESET_INDEX = 16;       // newest preset: MAX_VISUAL_PRESET_INDEX must equal this

// The knobs. The schema lives here so the defaults have exactly one home; the store and the
// console bindings are in 07-fx/13-market-tuning.js.
//
// rebuild: 'series' re-measures the song, 'chart' rewrites the candles that are already on
// screen, 'wall' re-bakes the backdrop, 'live' is read every frame.
var MARKET_TUNING_SCHEMA = {
  // ---- the measurement. chunkSamples is a power of two because the transform is radix-2; the
  // store snaps it so the slider, the read-out and the analysis all agree on one number.
  chunkSamples: { def: 4096, min: 512, max: 16384, kind: 'pow2', rebuild: 'series' },
  wickSlices: { def: 4, min: 1, max: 8, kind: 'count', rebuild: 'series' },
  minHz: { def: 40, min: 20, max: 400, kind: 'hz', rebuild: 'series' },
  maxHz: { def: 8000, min: 1000, max: 16000, kind: 'hz', rebuild: 'series' },
  // ---- Hz to world height. Logarithmic: 230 Hz and 1.2 kHz are 2.4 octaves apart, and a linear
  // map would crush every bass passage onto the floor.
  refHz: { def: 110, min: 20, max: 1000, kind: 'hz', rebuild: 'chart' },
  octaveUnits: { def: 1.1, min: 0.2, max: 4, kind: 'unit', rebuild: 'chart' },
  priceFloor: { def: 0, min: -8, max: 8, kind: 'unit', rebuild: 'chart' },
  // ---- the candles
  candleSpacing: { def: 0.42, min: 0.08, max: 2, kind: 'unit', rebuild: 'chart' },
  bodyWidth: { def: 0.26, min: 0.02, max: 1.5, kind: 'unit', rebuild: 'chart' },
  bodyDepth: { def: 0.26, min: 0.02, max: 1.5, kind: 'unit', rebuild: 'chart' },
  wickWidth: { def: 0.045, min: 0.005, max: 0.4, kind: 'unit', rebuild: 'chart' },
  minBody: { def: 0.03, min: 0, max: 0.5, kind: 'unit', rebuild: 'chart' },
  energyGain: { def: 0.6, min: 0, max: 2, kind: 'ratio', rebuild: 'chart' },
  curveOpacity: { def: 0.5, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  colorFlip: { def: 0, min: 0, max: 1, kind: 'bool', rebuild: 'chart' },
  // ---- the beat stretch. Only the display clock reads these.
  beatSync: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  hitSlow: { def: 0.14, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  hitHold: { def: 0.10, min: 0, max: 0.6, kind: 'sec', rebuild: 'live' },
  hitStrength: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  reboundTau: { def: 0.22, min: 0.02, max: 2, kind: 'sec', rebuild: 'live' },
  catchGain: { def: 0.35, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  maxRate: { def: 6, min: 1, max: 24, kind: 'ratio', rebuild: 'live' },
  seekSnap: { def: 6, min: 1, max: 200, kind: 'count', rebuild: 'live' },
  // ---- the camera. camDamp is a time constant against REAL dt, never the stretched clock.
  camDamp: { def: 0.42, min: 0.02, max: 3, kind: 'sec', rebuild: 'live' },
  camDist: { def: 9, min: 2, max: 40, kind: 'unit', rebuild: 'live' },
  camHeight: { def: 1.6, min: -6, max: 12, kind: 'unit', rebuild: 'live' },
  camLead: { def: 4, min: -20, max: 20, kind: 'unit', rebuild: 'live' },
  fovDeg: { def: 46, min: 20, max: 100, kind: 'deg', rebuild: 'live' },
  // ---- the wall
  wallCols: { def: 20, min: 4, max: 48, kind: 'count', rebuild: 'wall' },
  wallRows: { def: 10, min: 2, max: 32, kind: 'count', rebuild: 'wall' },
  wallDepth: { def: 26, min: 6, max: 120, kind: 'unit', rebuild: 'live' },
  wallParallax: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  wallOverscan: { def: 1.25, min: 1, max: 2, kind: 'ratio', rebuild: 'live' },
  wallBase: { def: 0.10, min: 0, max: 0.5, kind: 'ratio', rebuild: 'wall' },
  wallContrast: { def: 0.5, min: 0, max: 1, kind: 'ratio', rebuild: 'wall' },
  wallOpacity: { def: 0.92, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  iconPx: { def: 32, min: 8, max: 96, kind: 'px', rebuild: 'wall' },
  iconThreshold: { def: 0.5, min: 0.05, max: 0.95, kind: 'ratio', rebuild: 'wall' },
  iconSource: { def: 0, min: 0, max: 1, kind: 'count', rebuild: 'wall' }
};

function marketParam(key) {
  var store = (typeof marketTuning !== 'undefined') ? marketTuning : null;
  if (store && store[key] !== undefined && store[key] !== null) return store[key];
  var spec = MARKET_TUNING_SCHEMA[key];
  return spec ? spec.def : 0;
}

function marketClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

var marketState = {
  active: false, built: false, series: null, seriesKey: '', seriesSignature: '',
  capacity: 0, written: 0, shown: 0, rate: 1, slowUntil: 0, lastPlayhead: -1,
  energyRef: 0.05, group: null, bodies: null, wicks: null, curve: null,
  wall: null, wallTex: null, wallCanvas: null, icons: [], iconSource: '',
  hitList: [], hitIdx: 0, hitSource: '', hits: 0, snaps: 0, backlog: 0,
  lastCostMs: 0, frames: 0, error: '', coverKey: ''
};

// The user's own view offset, on top of the follow pose. The preset owns these rather than
// orbit.user*, so the app's own drag (which spins the cover particles) cannot fight the chart.
var marketCam = {
  yaw: 0, pitch: 0, zoom: 1, blend: 0, dragging: false, lastX: 0, lastY: 0,
  lookX: 0, lookY: 0, lookZ: 0, posX: 0, posY: 0, posZ: 0, primed: false
};

function marketPresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === MARKET_PRESET_INDEX;
}

function marketSongUrl() {
  if (typeof audio !== 'undefined' && audio) return audio.currentSrc || audio.src || '';
  return '';
}

function marketSongKey() {
  var song = (typeof playQueue !== 'undefined' && playQueue && typeof currentIdx !== 'undefined')
    ? playQueue[currentIdx] : null;
  if (song && (song.id !== undefined || song.name)) {
    return String(song.source || '') + ':' + String(song.id !== undefined ? song.id : song.name);
  }
  var url = marketSongUrl();
  return url ? 'url:' + url : '';
}

function marketSeriesOpts() {
  return {
    chunk: marketParam('chunkSamples'),
    slices: marketParam('wickSlices'),
    minHz: marketParam('minHz'),
    maxHz: marketParam('maxHz')
  };
}

// Hz on the chart's own axis. Read at draw time, so changing the mapping does not re-measure
// the song.
function marketPriceY(hz) {
  var ref = Math.max(1, marketParam('refHz'));
  var f = Math.max(1, Number(hz) || 0);
  return marketParam('priceFloor') + Math.log(f / ref) / Math.LN2 * marketParam('octaveUnits');
}

function marketCandleX(index) {
  return index * marketParam('candleSpacing');
}

// The curve height at a fractional candle position: the head glides between closes instead of
// stepping, which is what the camera is damping against.
function marketCurveY(at) {
  var s = marketState.series;
  if (!s || !s.count) return marketPriceY(marketParam('refHz'));
  var i = marketClamp(Math.floor(at), 0, s.count - 1);
  var j = Math.min(s.count - 1, i + 1);
  var f = marketClamp(at - i, 0, 1);
  var a = marketPriceY(s.close[i]);
  var b = marketPriceY(s.close[j]);
  return a + (b - a) * f;
}

// Ask for the current song's series. A knob that changes the measurement changes the signature,
// and the series module re-uses the PCM it already holds instead of fetching the song again.
function marketRequestSeries(force) {
  if (typeof marketEnsureSeries !== 'function') return;
  var key = marketSongKey();
  var url = marketSongUrl();
  if (!key || !url) return;
  var opts = marketSeriesOpts();
  var signature = [opts.chunk, opts.slices, opts.minHz, opts.maxHz].join('|');
  if (!force && marketState.seriesKey === key && marketState.seriesSignature === signature) return;
  if (!force && marketState.pendingKey === key && marketState.pendingSignature === signature) return;
  marketState.pendingKey = key;
  marketState.pendingSignature = signature;
  marketEnsureSeries(key, url, opts).then(function (series) {
    if (marketState.pendingKey !== key || marketState.pendingSignature !== signature) return;
    marketState.pendingKey = '';
    if (!series) return;
    // A song that changed under the analysis must not have its chart replaced by the old one.
    if (marketSongKey() !== key) return;
    marketAcceptSeries(series, key, signature);
  }).catch(function (err) {
    marketState.error = String(err && (err.message || err)).slice(0, 200);
  });
}

function marketAcceptSeries(series, key, signature) {
  marketState.series = series;
  marketState.seriesKey = key;
  marketState.seriesSignature = signature;
  var ref = 0;
  for (var i = 0; i < series.count; i++) if (series.energy[i] > ref) ref = series.energy[i];
  marketState.energyRef = Math.max(0.02, ref);
  marketState.error = '';
  marketBuildChart();
  marketSnapToPlayhead();
  if (typeof markRenderInteraction === 'function') markRenderInteraction('market-series');
}

// A seek, a new song, or the first series arriving: the display lands exactly on the candle the
// playhead belongs to. This is the determinism the lyric presets have, and it is why the chart
// can be scrubbed without replaying the whole song.
function marketSnapToPlayhead() {
  var s = marketState.series;
  if (!s) return;
  var at = marketPlayheadCandles();
  marketState.shown = at;
  marketState.rate = 1;
  marketState.slowUntil = 0;
  marketState.backlog = 0;
  marketState.written = 0;
  marketState.lastPlayhead = marketPlayheadSeconds();
  marketCam.primed = false;
  marketState.snaps++;
  marketSyncHitCursor();
}

function marketPlayheadSeconds() {
  if (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) return Math.max(0, audio.currentTime);
  return 0;
}

function marketPlayheadCandles() {
  var s = marketState.series;
  if (!s || !s.count) return 0;
  return marketClamp(marketPlayheadSeconds() * s.candlesPerSec, 0, s.count);
}

// ---------------------------------------------------------------- the wall's marks
//
// A mark is a binary mask: one bit per pixel, no greys. The cover gives three of them (one per
// colour channel, each cut at its own mean so a dark sleeve still produces a mark) in both
// polarities. With no cover - or with the built-in set chosen - the same mask pipeline is fed
// from vector marks instead, so the wall is never a blank plate.

function marketCoverCanvas() {
  if (typeof currentCoverPickerCanvas === 'function') {
    var c = currentCoverPickerCanvas();
    if (c && c.width > 1 && c.height > 1) return c;
  }
  return null;
}

function marketCoverAvailable() {
  if (!marketCoverCanvas()) return false;
  if (typeof uniforms !== 'undefined' && uniforms && uniforms.uHasCover) return uniforms.uHasCover.value > 0.5;
  return true;
}

function marketBuiltinIcons(px) {
  var out = [];
  var canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  var g = canvas.getContext('2d');
  var u = px / 16;
  var marks = [
    function () { g.fillRect(2*u, 8*u, 2.6*u, 6*u); g.fillRect(6.7*u, 4*u, 2.6*u, 10*u); g.fillRect(11.4*u, 6*u, 2.6*u, 8*u); },
    function () { g.beginPath(); g.moveTo(8*u, 2*u); g.lineTo(14*u, 9*u); g.lineTo(10.4*u, 9*u); g.lineTo(10.4*u, 14*u); g.lineTo(5.6*u, 14*u); g.lineTo(5.6*u, 9*u); g.lineTo(2*u, 9*u); g.closePath(); g.fill(); },
    function () { g.beginPath(); g.moveTo(8*u, 14*u); g.lineTo(2*u, 7*u); g.lineTo(5.6*u, 7*u); g.lineTo(5.6*u, 2*u); g.lineTo(10.4*u, 2*u); g.lineTo(10.4*u, 7*u); g.lineTo(14*u, 7*u); g.closePath(); g.fill(); },
    function () { g.beginPath(); g.arc(8*u, 8*u, 6*u, 0, Math.PI*2); g.arc(8*u, 8*u, 3.2*u, 0, Math.PI*2, true); g.fill(); },
    function () { g.beginPath(); g.moveTo(8*u, 2.4*u); g.lineTo(14*u, 13*u); g.lineTo(2*u, 13*u); g.closePath(); g.fill(); },
    function () { g.fillRect(7.2*u, 1.6*u, 1.6*u, 12.8*u); g.fillRect(4.4*u, 5*u, 7.2*u, 6*u); },
    function () { g.fillRect(6.6*u, 2*u, 2.8*u, 12*u); g.fillRect(2*u, 6.6*u, 12*u, 2.8*u); },
    function () { g.beginPath(); g.moveTo(1.6*u, 13*u); g.lineTo(5*u, 13*u); g.lineTo(5*u, 9*u); g.lineTo(9*u, 9*u); g.lineTo(9*u, 5*u); g.lineTo(14.4*u, 5*u); g.lineTo(14.4*u, 2.4*u); g.lineTo(11.6*u, 2.4*u); g.lineTo(11.6*u, 6.4*u); g.lineTo(7.6*u, 6.4*u); g.lineTo(7.6*u, 10.4*u); g.lineTo(1.6*u, 10.4*u); g.closePath(); g.fill(); }
  ];
  for (var m = 0; m < marks.length; m++) {
    g.clearRect(0, 0, px, px);
    g.fillStyle = '#fff';
    marks[m]();
    var data = g.getImageData(0, 0, px, px).data;
    var mask = new Uint8Array(px * px);
    var ink = 0;
    for (var i = 0; i < px * px; i++) { mask[i] = data[i*4+3] > 127 ? 1 : 0; ink += mask[i]; }
    if (ink > 0 && ink < px * px) out.push(mask);
  }
  return out;
}

function marketIconMasks() {
  var px = Math.max(4, Math.round(marketParam('iconPx')));
  var masks = [];
  var src = marketParam('iconSource') < 0.5 && marketCoverAvailable() ? marketCoverCanvas() : null;
  if (src) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = px; canvas.height = px;
      var g = canvas.getContext('2d');
      g.drawImage(src, 0, 0, px, px);
      var data = g.getImageData(0, 0, px, px).data;
      var level = marketParam('iconThreshold');
      for (var ch = 0; ch < 3; ch++) {
        var sum = 0;
        for (var i = 0; i < px * px; i++) sum += data[i*4+ch];
        var mean = sum / (px * px);
        // Cut at the channel's own mean, scaled by the knob: 0.5 is exactly half the pixels inked,
        // so the knob has the same meaning on a bright sleeve and on a dark one.
        var cut = marketClamp(mean * 2 * level, 1, 254);
        var above = new Uint8Array(px * px);
        var below = new Uint8Array(px * px);
        var ink = 0;
        for (var j = 0; j < px * px; j++) {
          var on = data[j*4+ch] > cut ? 1 : 0;
          above[j] = on; below[j] = 1 - on; ink += on;
        }
        // A channel that is all one tone carries no mark; keeping it would tile the wall with
        // solid squares instead of icons.
        if (ink > 0 && ink < px * px) { masks.push(above); masks.push(below); }
      }
    } catch (err) {
      masks = [];
    }
  }
  marketState.iconSource = masks.length ? 'cover' : 'builtin';
  if (!masks.length) masks = marketBuiltinIcons(px);
  marketState.icons = masks;
  marketState.iconPx = px;
  return masks;
}

// A stable per-song arrangement: the same song rebuilds to the same wall, a different song does
// not. Seeded from the key rather than Math.random so a knob drag never reshuffles the backdrop.
function marketRng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function marketSeed() {
  var key = marketState.seriesKey || marketSongKey() || 'market';
  var h = 2166136261;
  for (var i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function marketBakeWall() {
  if (typeof THREE === 'undefined') return;
  var cols = Math.max(1, Math.round(marketParam('wallCols')));
  var rows = Math.max(1, Math.round(marketParam('wallRows')));
  var masks = marketIconMasks();
  var px = marketState.iconPx;
  var cell = px * 2;                 // the mark occupies the middle half of its cell
  var base = marketParam('wallBase');
  var contrast = marketParam('wallContrast');
  var toneA = Math.round(255 * marketClamp(base * (1 + contrast), 0, 1));
  var toneB = Math.round(255 * marketClamp(base * (1 - contrast), 0, 1));
  var ink = Math.round(255 * marketClamp(base + contrast * 0.85, 0, 1));
  var tiles = masks.map(function (mask) {
    var tc = document.createElement('canvas');
    tc.width = px; tc.height = px;
    var tg = tc.getContext('2d');
    var img = tg.createImageData(px, px);
    for (var i = 0; i < px * px; i++) {
      if (!mask[i]) continue;
      img.data[i*4] = ink; img.data[i*4+1] = ink; img.data[i*4+2] = ink; img.data[i*4+3] = 255;
    }
    tg.putImageData(img, 0, 0);
    return tc;
  });
  var canvas = marketState.wallCanvas || document.createElement('canvas');
  canvas.width = cols * cell; canvas.height = rows * cell;
  var g = canvas.getContext('2d');
  var rnd = marketRng(marketSeed());
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var tone = (r + c) % 2 === 0 ? toneA : toneB;
      g.fillStyle = 'rgb(' + tone + ',' + tone + ',' + tone + ')';
      g.fillRect(c * cell, r * cell, cell, cell);
      if (!tiles.length) continue;
      var tile = tiles[Math.floor(rnd() * tiles.length) % tiles.length];
      var rot = Math.floor(rnd() * 4);
      var flip = rnd() < 0.5;
      g.save();
      g.translate(c * cell + cell / 2, r * cell + cell / 2);
      g.rotate(rot * Math.PI / 2);
      if (flip) g.scale(-1, 1);
      g.drawImage(tile, -px / 2, -px / 2, px, px);
      g.restore();
    }
  }
  marketState.wallCanvas = canvas;
  marketState.wallCells = { cols: cols, rows: rows, cell: cell };
  if (marketState.wallTex) {
    marketState.wallTex.image = canvas;
    marketState.wallTex.needsUpdate = true;
    return;
  }
  var tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  marketState.wallTex = tex;
}

// ---------------------------------------------------------------- the scene

// r128's colour fragment only multiplies vColor under USE_COLOR, so instanceColor alone is
// silently ignored: the material needs vertexColors AND the geometry needs a white colour
// attribute for the per-instance colour to reach the screen.
function marketWhiteVertexColors(geo) {
  var n = geo.attributes.position.count;
  var white = new Float32Array(n * 3);
  for (var i = 0; i < white.length; i++) white[i] = 1;
  geo.setAttribute('color', new THREE.BufferAttribute(white, 3));
}

function marketBuildScene() {
  if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene) return false;
  if (marketState.group) return true;
  var group = new THREE.Group();
  group.name = 'rhythm-market';
  marketState.group = group;
  scene.add(group);
  marketBakeWall();
  var wallMat = new THREE.MeshBasicMaterial({
    map: marketState.wallTex, transparent: true, opacity: marketParam('wallOpacity'),
    depthWrite: false, toneMapped: false, side: THREE.DoubleSide
  });
  var wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), wallMat);
  wall.frustumCulled = false;
  wall.renderOrder = -10;
  marketState.wall = wall;
  group.add(wall);
  marketState.wallDrift = 0;
  marketState.wallLastX = null;
  marketBuildChart();
  marketState.built = true;
  return true;
}

function marketDisposeChart() {
  var group = marketState.group;
  ['bodies', 'wicks', 'curve'].forEach(function (name) {
    var obj = marketState[name];
    if (!obj) return;
    if (group) group.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
    marketState[name] = null;
  });
  marketState.capacity = 0;
  marketState.written = 0;
}

function marketBuildChart() {
  if (!marketState.group || typeof THREE === 'undefined') return false;
  var s = marketState.series;
  var need = Math.max(64, s ? s.count : 0);
  if (marketState.bodies && marketState.capacity >= need) {
    marketState.written = 0;
    return true;
  }
  marketDisposeChart();
  var bodyGeo = new THREE.BoxGeometry(1, 1, 1);
  marketWhiteVertexColors(bodyGeo);
  var bodies = new THREE.InstancedMesh(bodyGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), need);
  var wickGeo = new THREE.BoxGeometry(1, 1, 1);
  marketWhiteVertexColors(wickGeo);
  var wicks = new THREE.InstancedMesh(wickGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), need);
  [bodies, wicks].forEach(function (mesh) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    marketState.group.add(mesh);
  });
  var curveGeo = new THREE.BufferGeometry();
  curveGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(need * 3), 3));
  curveGeo.setDrawRange(0, 0);
  var curve = new THREE.Line(curveGeo, new THREE.LineBasicMaterial({
    color: 0xbfd4e6, transparent: true, opacity: marketParam('curveOpacity'), toneMapped: false
  }));
  curve.frustumCulled = false;
  marketState.group.add(curve);
  marketState.bodies = bodies;
  marketState.wicks = wicks;
  marketState.curve = curve;
  marketState.capacity = need;
  marketState.written = 0;
  return true;
}

function marketDisposeScene() {
  marketDisposeChart();
  if (marketState.wall) {
    if (marketState.group) marketState.group.remove(marketState.wall);
    if (marketState.wall.geometry) marketState.wall.geometry.dispose();
    if (marketState.wall.material) marketState.wall.material.dispose();
    marketState.wall = null;
  }
  if (marketState.wallTex) { marketState.wallTex.dispose(); marketState.wallTex = null; }
  marketState.wallCanvas = null;
  if (marketState.group) {
    if (typeof scene !== 'undefined' && scene) scene.remove(marketState.group);
    marketState.group = null;
  }
  marketState.built = false;
  marketState.icons = [];
}

// ---------------------------------------------------------------- the candles

var marketScratchMatrix = null;
var marketScratchColor = null;
var marketScratchQuat = null;
var marketScratchPos = null;
var marketScratchScale = null;

function marketCandleScratch() {
  if (!marketScratchMatrix && typeof THREE !== 'undefined') {
    marketScratchMatrix = new THREE.Matrix4();
    marketScratchColor = new THREE.Color();
    marketScratchQuat = new THREE.Quaternion();
    marketScratchPos = new THREE.Vector3();
    marketScratchScale = new THREE.Vector3();
  }
  return !!marketScratchMatrix;
}

// 涨红跌绿 is the convention the chart is read in; colorFlip swaps it for the other one.
function marketCandleColor(up, energy) {
  var flip = marketParam('colorFlip') > 0.5;
  var red = up !== flip;
  var k = marketClamp(0.5 + marketParam('energyGain') * (energy / Math.max(0.001, marketState.energyRef)), 0.2, 1.8);
  if (red) marketScratchColor.setRGB(0.94 * k, 0.27 * k, 0.27 * k);
  else marketScratchColor.setRGB(0.16 * k, 0.78 * k, 0.45 * k);
  return marketScratchColor;
}

// grow 0..1 draws the candle out of its own opening price. A candle that is already history is
// always written at grow 1, and never written again - that is the "what is on screen stays put"
// rule, kept as a single counter rather than as a per-candle flag.
function marketWriteCandle(i, grow) {
  var s = marketState.series;
  var bodies = marketState.bodies, wicks = marketState.wicks, curve = marketState.curve;
  if (!s || !bodies || !wicks || i < 0 || i >= s.count || !marketCandleScratch()) return;
  var x = marketCandleX(i);
  var o = marketPriceY(s.open[i]);
  var c = marketPriceY(s.close[i]);
  var h = marketPriceY(s.high[i]);
  var l = marketPriceY(s.low[i]);
  var top = o + (Math.max(o, c) - o) * grow;
  var bot = o + (Math.min(o, c) - o) * grow;
  var wTop = o + (h - o) * grow;
  var wBot = o + (l - o) * grow;
  var bodyH = Math.max(marketParam('minBody') * grow, top - bot);
  var wickH = Math.max(0.0001, wTop - wBot);
  var depth = marketParam('bodyDepth');
  marketScratchQuat.set(0, 0, 0, 1);
  marketScratchPos.set(x, (top + bot) / 2, 0);
  marketScratchScale.set(marketParam('bodyWidth'), bodyH, depth);
  marketScratchMatrix.compose(marketScratchPos, marketScratchQuat, marketScratchScale);
  bodies.setMatrixAt(i, marketScratchMatrix);
  marketScratchPos.set(x, (wTop + wBot) / 2, 0);
  marketScratchScale.set(marketParam('wickWidth'), wickH, marketParam('wickWidth'));
  marketScratchMatrix.compose(marketScratchPos, marketScratchQuat, marketScratchScale);
  wicks.setMatrixAt(i, marketScratchMatrix);
  var up = s.close[i] >= s.open[i];
  bodies.setColorAt(i, marketCandleColor(up, s.energy[i]));
  wicks.setColorAt(i, marketCandleColor(up, s.energy[i] * 0.55));
  if (curve) {
    var arr = curve.geometry.attributes.position.array;
    arr[i*3] = x;
    arr[i*3+1] = o + (c - o) * grow;
    arr[i*3+2] = 0;
  }
}

// Only the slice that changed goes back to the GPU: a four-minute song is a few thousand
// instances, and re-uploading all of them every frame to move one candle is the whole cost.
function marketFlagRange(attr, fromItem, toItem, itemSize) {
  if (!attr || toItem < fromItem) return;
  attr.updateRange.offset = fromItem * itemSize;
  attr.updateRange.count = (toItem - fromItem + 1) * itemSize;
  attr.needsUpdate = true;
}

function marketUpdateInstances() {
  var s = marketState.series;
  var bodies = marketState.bodies, wicks = marketState.wicks, curve = marketState.curve;
  if (!s || !bodies || !wicks || !s.count) return;
  var shown = marketState.shown;
  var full = Math.min(s.count, Math.floor(shown));
  var head = Math.min(s.count - 1, full);
  var from = Math.min(marketState.written, full);
  for (var i = marketState.written; i < full; i++) marketWriteCandle(i, 1);
  marketState.written = Math.max(marketState.written, full);
  var growing = shown > full + 1e-6 && full < s.count;
  if (growing) marketWriteCandle(head, marketClamp(shown - head, 0, 1));
  var count = Math.min(s.count, full + (growing ? 1 : 0));
  bodies.count = count;
  wicks.count = count;
  var to = Math.max(from, growing ? head : full - 1);
  marketFlagRange(bodies.instanceMatrix, from, to, 16);
  marketFlagRange(wicks.instanceMatrix, from, to, 16);
  if (bodies.instanceColor) marketFlagRange(bodies.instanceColor, from, to, 3);
  if (wicks.instanceColor) marketFlagRange(wicks.instanceColor, from, to, 3);
  if (curve) {
    curve.geometry.setDrawRange(0, count);
    marketFlagRange(curve.geometry.attributes.position, from, to, 3);
    curve.material.opacity = marketParam('curveOpacity');
  }
  if (marketState.wall) marketState.wall.material.opacity = marketParam('wallOpacity');
}

// ---------------------------------------------------------------- the beat
//
// The stall rides the song's beat points, the list the analysis thinned for the visuals: the same
// choice the ring makes, and for the same reason. The hits it actually heard cannot carry the
// timing because whole sections have none - a song's intro would run at constant speed - so they
// are a fallback, not the first choice. With no map yet the app's own onset flag drives it, so
// the stretch works from the first second of a song.

function marketHitList() {
  if (typeof currentBeatMap === 'undefined' || !currentBeatMap) return null;
  // Timing comes from the grid the analysis laid over the song, the same choice the ring makes:
  // `hits` only lists the points where it actually heard a drum, and whole sections have none
  // (this song's first 44s), which would leave the chart running at constant speed there.
  // cameraBeats is every slot of the bar including the ones written off as not a drum, so it is
  // the fallback rather than the first choice.
  var lists = [currentBeatMap.pulseBeats, currentBeatMap.cameraBeats, currentBeatMap.hits, currentBeatMap.beats];
  for (var k = 0; k < lists.length; k++) {
    var list = lists[k];
    if (!list || !list.length) continue;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var t = typeof e === 'number' ? e : (e && e.time);
      if (!isFinite(t)) continue;
      var strength = typeof e === 'number' ? 1 : (e && (e.strength != null ? e.strength : e.impact));
      out.push({ time: t, strength: isFinite(strength) ? strength : 1 });
    }
    if (out.length) {
      out.sort(function (a, b) { return a.time - b.time; });
      return out;
    }
  }
  return null;
}

function marketSyncHitCursor() {
  var list = marketHitList();
  marketState.hitList = list || [];
  marketState.hitSource = list ? 'map' : 'live';
  var t = marketPlayheadSeconds();
  var idx = 0;
  while (idx < marketState.hitList.length && marketState.hitList[idx].time <= t) idx++;
  marketState.hitIdx = idx;
}

function marketRefreshHits() {
  var list = marketHitList();
  var source = list ? 'map' : 'live';
  if (source !== marketState.hitSource || (list && list.length !== marketState.hitList.length)) {
    marketSyncHitCursor();
  }
}

function marketConsumeHit(nowSec) {
  if (marketState.hitSource === 'live') {
    var flag = typeof beatOnsetFlag !== 'undefined' && beatOnsetFlag;
    if (flag && nowSec - (marketState.lastLiveHit || -10) >= 0.18) {
      marketState.lastLiveHit = nowSec;
      return Math.max(marketParam('hitStrength'), 0.6);
    }
    return 0;
  }
  var list = marketState.hitList;
  var t = marketPlayheadSeconds();
  var best = 0;
  while (marketState.hitIdx < list.length && list[marketState.hitIdx].time <= t) {
    var e = list[marketState.hitIdx++];
    if (e.strength >= marketParam('hitStrength')) best = Math.max(best, e.strength);
  }
  return best;
}

// ---------------------------------------------------------------- the display clock
//
// This is the only place the stretch lives. The data position (target) is the playhead, always;
// the displayed position chases it at a rate the drum hits pull down and the backlog pushes up.
function marketStepClock(dt, nowSec) {
  var s = marketState.series;
  if (!s || !s.count) return;
  var target = marketPlayheadCandles();
  var prev = marketState.shown;
  if (target < prev - 1e-6 || target - prev > marketParam('seekSnap')) {
    marketState.shown = target;
    marketState.rate = 1;
    marketState.slowUntil = 0;
    marketState.written = 0;
    marketState.backlog = 0;
    marketState.snaps++;
    marketCam.primed = false;
    marketSyncHitCursor();
    return;
  }
  if (marketParam('beatSync') > 0.5 && marketConsumeHit(nowSec) > 0) {
    marketState.rate = marketParam('hitSlow');
    marketState.slowUntil = nowSec + marketParam('hitHold');
    marketState.hits++;
  }
  var backlog = Math.max(0, target - marketState.shown);
  marketState.backlog = backlog;
  if (nowSec < marketState.slowUntil) {
    marketState.rate = marketParam('hitSlow');
  } else {
    var goal = Math.min(marketParam('maxRate'), 1 + marketParam('catchGain') * backlog);
    var k = 1 - Math.exp(-dt / Math.max(0.005, marketParam('reboundTau')));
    marketState.rate += (goal - marketState.rate) * k;
  }
  var next = marketState.shown + marketState.rate * s.candlesPerSec * dt;
  marketState.shown = marketClamp(next, prev, target);
}

// ---------------------------------------------------------------- the backdrop placement

function marketPlaceWall() {
  var wall = marketState.wall;
  if (!wall || typeof camera === 'undefined' || !camera) return;
  var depth = Math.max(1, marketParam('wallDepth'));
  if (!marketCandleScratch()) return;
  var dir = marketScratchPos;
  camera.getWorldDirection(dir);
  var t = Math.abs(dir.z) > 1e-4 ? (depth - camera.position.z) / dir.z : depth;
  if (!(t > 0.5)) t = depth;
  var cx = camera.position.x + dir.x * t;
  var cy = camera.position.y + dir.y * t;
  var over = marketParam('wallOverscan');
  var h = 2 * Math.tan(camera.fov * Math.PI / 360) * t * over;
  var aspect = camera.aspect || ((typeof renderer !== 'undefined' && renderer && renderer.domElement)
    ? renderer.domElement.clientWidth / Math.max(1, renderer.domElement.clientHeight) : 1.777);
  var w = Math.max(0.001, h * aspect);
  wall.position.set(cx, cy, depth);
  wall.scale.set(w, h, 1);
  var tex = marketState.wallTex;
  if (!tex) return;
  // The plane spans w world units, so a texture offset of cx/w nails the pattern to world X.
  // The drift term cancels part of that anchoring: parallax 1 is a wall fixed in the world,
  // 0 is a wall glued to the lens, and the cell size stays wallCols across the view either way.
  var parallax = marketParam('wallParallax');
  if (marketState.wallLastX === null || marketState.wallLastX === undefined) {
    marketState.wallDrift = 0;
  } else {
    marketState.wallDrift -= (1 - parallax) * (cx - marketState.wallLastX) / w;
  }
  marketState.wallLastX = cx;
  tex.offset.set(cx / w + (marketState.wallDrift || 0), cy / h);
}

// ---------------------------------------------------------------- the frame entry

function updateStockMarket(now, dt) {
  if (!marketPresetIsActive()) return;
  var startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  if (!marketState.built) marketBuildScene();
  marketState.active = true;
  marketRequestSeries(false);
  var cover = marketCoverCanvas();
  if (marketState.coverRef !== cover) {
    marketState.coverRef = cover;
    if (marketState.built) marketBakeWall();
  }
  marketRefreshHits();
  marketStepClock(Math.max(0, Math.min(0.1, dt || 0)), (now || 0) / 1000);
  marketUpdateInstances();
  marketPlaceWall();
  marketState.lastCostMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - startedAt;
  marketState.frames++;
}

// ---------------------------------------------------------------- the camera
//
// Written after the loop's own camera writers, the way the skull preset does it: the app keeps
// its orbit, free camera and cinema code, and this pose is blended on top of whatever they left.
// The damping runs on REAL dt. The stretched clock belongs to the chart alone, so the camera
// parks at a drum hit because the head it follows stopped moving - it has no clock of its own.

var marketCamGoalPos = null;
var marketCamGoalLook = null;
var marketCamMixedLook = null;

function marketCameraScratch() {
  if (marketCamGoalPos) return true;
  if (typeof THREE === 'undefined') return false;
  marketCamGoalPos = new THREE.Vector3();
  marketCamGoalLook = new THREE.Vector3();
  marketCamMixedLook = new THREE.Vector3();
  return true;
}

// The follow pose before damping. The growing head is the look target; camLead slides it ahead
// of the lens so the un-drawn future is on screen, camHeight lifts the eye off the price axis,
// camDist backs it off along -Z (the wall is at +Z, so this is the side the chart is seen from).
function marketCameraGoal(pos, look) {
  var at = marketState.shown;
  look.set(marketCandleX(at), marketCurveY(at), 0);
  var yaw = marketCam.yaw;
  var pitch = marketClamp(marketCam.pitch, -1.35, 1.35);
  var zoom = marketClamp(marketCam.zoom, 0.25, 4);
  var dist = marketParam('camDist') * zoom;
  var lead = marketParam('camLead');
  var height = marketParam('camHeight') * zoom;
  var cy = Math.cos(yaw), sy = Math.sin(yaw);
  var ox = lead * cy - dist * sy;
  var oz = -lead * sy - dist * cy;
  var cp = Math.cos(pitch), sp = Math.sin(pitch);
  pos.set(look.x + ox, look.y + height * cp - oz * sp, look.z + height * sp + oz * cp);
}

function applyStockCameraPose(dt) {
  if (typeof camera === 'undefined' || !camera) return;
  // The free camera is the user's explicit takeover; a preset must not fight it.
  if (typeof freeCamera !== 'undefined' && freeCamera
    && (freeCamera.active || freeCamera.locked || freeCamera.resetTween)) return;
  var active = marketPresetIsActive();
  var step = Math.max(0, Number(dt) || 0);
  marketCam.blend += ((active ? 1 : 0) - marketCam.blend) * Math.min(1, step * (active ? 4.8 : 7.2));
  if (marketCam.blend < 0.002) {
    if (!active) marketCam.blend = 0;
    return;
  }
  if (!marketCameraScratch()) return;
  marketCameraGoal(marketCamGoalPos, marketCamGoalLook);
  // primed=false is the snap path (new song, seek, first series): land exactly, do not glide
  // across the whole chart from wherever the last song left the eye.
  var k = marketCam.primed ? 1 - Math.exp(-step / Math.max(0.005, marketParam('camDamp'))) : 1;
  marketCam.posX += (marketCamGoalPos.x - marketCam.posX) * k;
  marketCam.posY += (marketCamGoalPos.y - marketCam.posY) * k;
  marketCam.posZ += (marketCamGoalPos.z - marketCam.posZ) * k;
  marketCam.lookX += (marketCamGoalLook.x - marketCam.lookX) * k;
  marketCam.lookY += (marketCamGoalLook.y - marketCam.lookY) * k;
  marketCam.lookZ += (marketCamGoalLook.z - marketCam.lookZ) * k;
  marketCam.primed = true;
  marketCamGoalPos.set(marketCam.posX, marketCam.posY, marketCam.posZ);
  marketCamGoalLook.set(marketCam.lookX, marketCam.lookY, marketCam.lookZ);
  camera.position.lerp(marketCamGoalPos, marketCam.blend);
  if (typeof orbit !== 'undefined' && orbit && orbit.lookAt) {
    marketCamMixedLook.set(orbit.lookAt.x, orbit.lookAt.y, orbit.lookAt.z);
  } else {
    camera.getWorldDirection(marketCamMixedLook).multiplyScalar(10).add(camera.position);
  }
  marketCamMixedLook.lerp(marketCamGoalLook, marketCam.blend);
  camera.lookAt(marketCamMixedLook);
  camera.fov += (marketParam('fovDeg') - camera.fov) * marketCam.blend;
  camera.updateProjectionMatrix();
}

function resetMarketCamera() {
  marketCam.yaw = 0;
  marketCam.pitch = 0;
  marketCam.zoom = 1;
  marketCam.primed = false;
  if (typeof markRenderInteraction === 'function') markRenderInteraction('market-camera-reset');
}

// ---------------------------------------------------------------- the user's view
//
// The chart is drawn into the WebGL canvas, so the app's own canvas handlers still fire - they
// spin the cover particles (suppressed here) and change orbit.userRadius (overwritten by the
// pose above). These handlers add the view the preset actually shows, on the window, and leave
// the app's controls alone. Same arrangement as the ring preset.

var marketPointerBound = false;

function marketBindPointer() {
  if (marketPointerBound || typeof window === 'undefined') return;
  marketPointerBound = true;
  window.addEventListener('pointerdown', marketOnPointerDown, true);
  window.addEventListener('pointermove', marketOnPointerMove, true);
  window.addEventListener('pointerup', marketOnPointerUp, true);
  window.addEventListener('pointercancel', marketOnPointerUp, true);
  window.addEventListener('wheel', marketOnWheel, { passive: true });
}

function marketPointerOverUi(ev) {
  return typeof isPointerOverUi === 'function' && isPointerOverUi(ev);
}

function marketOnPointerDown(ev) {
  if (!marketPresetIsActive() || marketPointerOverUi(ev)) return;
  if (typeof ev.button === 'number' && ev.button !== 0) return;
  marketCam.dragging = true;
  marketCam.lastX = ev.clientX;
  marketCam.lastY = ev.clientY;
}

function marketOnPointerMove(ev) {
  if (!marketCam.dragging) return;
  var dx = ev.clientX - marketCam.lastX;
  var dy = ev.clientY - marketCam.lastY;
  marketCam.lastX = ev.clientX;
  marketCam.lastY = ev.clientY;
  marketCam.yaw = marketClamp(marketCam.yaw - dx * 0.005, -Math.PI, Math.PI);
  marketCam.pitch = marketClamp(marketCam.pitch + dy * 0.004, -1.35, 1.35);
  if (typeof markRenderInteraction === 'function') markRenderInteraction('market-drag', 900);
}

function marketOnPointerUp() {
  marketCam.dragging = false;
}

function marketOnWheel(ev) {
  if (!marketPresetIsActive() || marketPointerOverUi(ev)) return;
  marketCam.zoom = marketClamp(marketCam.zoom * (ev.deltaY > 0 ? 1.08 : 0.92), 0.25, 4);
  if (typeof markRenderInteraction === 'function') markRenderInteraction('market-wheel', 900);
}

// ---------------------------------------------------------------- preset lifecycle

// Called from setPreset like the other takeover presets. Leaving has to give the GPU memory back
// rather than keep a wall texture and two instance buffers alive for a preset nobody is watching.
// The analysed series stays cached (it is a few hundred KB); the decoded PCM does not - that one
// is tens of MB and the series module can re-decode if the measurement knobs change.
function applyMarketPresetNow(prev, next) {
  var on = Number(next) === MARKET_PRESET_INDEX;
  var was = Number(prev) === MARKET_PRESET_INDEX;
  if (on) {
    marketBindPointer();
    marketBuildScene();
    if (marketState.series) marketSnapToPlayhead();
    else marketRequestSeries(true);
  } else if (was) {
    marketDisposeScene();
    marketState.active = false;
    marketState.coverRef = null;
    marketCam.primed = false;
    marketCam.dragging = false;
    if (typeof marketReleaseSeries === 'function') marketReleaseSeries();
  }
  if (on || was) {
    if (typeof applyVisualTakeoverNow === 'function') applyVisualTakeoverNow();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('market-preset');
  }
  return on;
}

function marketStatus() {
  var s = marketState.series;
  return {
    active: marketPresetIsActive(),
    built: marketState.built,
    costMs: Math.round(marketState.lastCostMs * 1000) / 1000,
    frames: marketState.frames,
    error: marketState.error,
    songKey: marketState.seriesKey,
    signature: marketState.seriesSignature,
    candles: s ? s.count : 0,
    duration: s ? Math.round(s.duration * 1000) / 1000 : 0,
    candlesPerSec: s ? Math.round(s.candlesPerSec * 1000) / 1000 : 0,
    capacity: marketState.capacity,
    written: marketState.written,
    shown: Math.round(marketState.shown * 1000) / 1000,
    target: Math.round(marketPlayheadCandles() * 1000) / 1000,
    rate: Math.round(marketState.rate * 1000) / 1000,
    backlog: Math.round(marketState.backlog * 1000) / 1000,
    hits: marketState.hits,
    snaps: marketState.snaps,
    hitSource: marketState.hitSource,
    camera: {
      blend: Math.round(marketCam.blend * 1000) / 1000,
      yaw: Math.round(marketCam.yaw * 1000) / 1000,
      pitch: Math.round(marketCam.pitch * 1000) / 1000,
      zoom: Math.round(marketCam.zoom * 1000) / 1000,
      pos: [Math.round(marketCam.posX * 100) / 100, Math.round(marketCam.posY * 100) / 100, Math.round(marketCam.posZ * 100) / 100],
      fov: (typeof camera !== 'undefined' && camera) ? Math.round(camera.fov * 100) / 100 : null
    },
    wall: {
      cells: marketState.wallCells || 0,
      iconPx: marketState.iconPx || 0,
      iconSource: marketState.iconSource,
      drift: Math.round((marketState.wallDrift || 0) * 1000) / 1000,
      size: marketState.wall ? [Math.round(marketState.wall.scale.x * 100) / 100, Math.round(marketState.wall.scale.y * 100) / 100] : null
    },
    series: (typeof marketSeriesStatus === 'function') ? marketSeriesStatus() : null
  };
}

// The chart is the whole picture here: the cover field, its bloom, the floating layer, the back
// cover, the star river, the ripples and both lyric layers are taken over rather than left
// underneath a wall that is meant to be the backdrop.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'market-layer',
    isActive: marketPresetIsActive,
    suppresses: {
      particles: true,
      bloom: true,
      float: true,
      backCover: true,
      starRiver: true,
      ripples: true,
      lyricsParticles: true,
      stageLyrics: true
    }
  });
}

marketBindPointer();