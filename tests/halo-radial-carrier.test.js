const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The radial lyric carrier, driven through the shipped module: the camera is put in the
// six states the user described and the test reads back which carrier was chosen, where
// every glyph landed on the screen, how big it was and what colour it got.

const modulePath = process.env.HALO_MODULE_PATH
  ? path.resolve(process.env.HALO_MODULE_PATH)
  : path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-halo-ring-preset.js');
const source = fs.readFileSync(modulePath, 'utf8');

// A recording context that keeps the full transform, so a glyph's world position can be
// read back exactly as the module placed it (translate + rotate per glyph).
function matrixMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

function makeRecordingContext() {
  const glyphs = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const ctx = {
    glyphs,
    textAlign: '', textBaseline: '', strokeStyle: '',
    lineWidth: 1, globalAlpha: 1, filter: 'none', globalCompositeOperation: 'source-over',
    lineCap: '', lineJoin: '', shadowBlur: 0, shadowColor: '',
    fillStyle: '',
    save() { stack.push(m.slice()); },
    restore() { m = stack.pop() || [1, 0, 0, 1, 0, 0]; },
    translate(x, y) { m = matrixMul(m, [1, 0, 0, 1, x, y]); },
    rotate(a) { m = matrixMul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); },
    scale(x, y) { m = matrixMul(m, [x, 0, 0, y, 0, 0]); },
    setTransform() { m = [1, 0, 0, 1, 0, 0]; },
    transform() {},
    beginPath() {}, closePath() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, rect() {},
    arc() {}, clip() {},
    drawImage() {}, putImageData() {}, setLineDash() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, ellipse() {},
    measureText(text) { return { width: String(text).length * 12 }; },
    getImageData() { return { data: new Uint8ClampedArray(4) }; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return null; },
    fillText(text, x, y) {
      const fontPx = Number((/(\d+(?:\.\d+)?)px/.exec(this._font || '') || [])[1]);
      glyphs.push({
        text: text,
        x: m[0] * x + m[2] * y + m[4],
        y: m[1] * x + m[3] * y + m[5],
        fontPx: fontPx,
        fill: this.fillStyle
      });
    },
    strokeText() {}
  };
  Object.defineProperty(ctx, 'font', {
    get() { return ctx._font || ''; },
    set(v) { ctx._font = v; }
  });
  return ctx;
}

const drawContext = makeRecordingContext();
const canvas = { width: 1920, height: 1080, style: {}, getContext: () => drawContext };

// Each line starts with a glyph of its own, so the test can tell which disc a painted
// glyph belongs to while two of them are on the wheel at once.
const mark = (i) => String.fromCharCode(0x4e00 + i);
const lines = [];
for (let i = 0; i < 12; i++) lines.push({ t: i * 4, text: mark(i) + '月色落进窗台的那一夜' });
const translations = [];
for (let i = 0; i < 12; i++) translations.push({ text: 'the moon on the sill that night ' + i });

const sandbox = {
  console, Math, JSON, Date, Array, Object, String, Number, Boolean, Error, isFinite, isNaN,
  parseFloat, parseInt, Set, Map, Uint8ClampedArray, Uint8Array,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  performance: { now: () => 0 },
  devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
  document: {
    getElementById: (id) => (id === 'halo-canvas' ? canvas : null),
    createElement: () => canvas,
    addEventListener() {}, body: { appendChild() {} }
  },
  // The app's own lyric colours, as the visual settings would carry them.
  fx: {
    lyricScale: 1,
    lyricColorMode: 'custom',
    lyricColor: '#7ec8d8',
    lyricHighlightMode: 'custom',
    lyricHighlightColor: '#fff0b8'
  },
  playQueue: [],
  currentIdx: 0,
  lyricsLines: lines,
  lyricsTranslationLines: translations
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

const VIEW_W = 1920;
const VIEW_H = 1080;
sandbox.haloLayoutStage(VIEW_W, VIEW_H);
sandbox.haloBuildLyricRing();
assert.strictEqual(sandbox.haloLyric.items.length, 12, 'the fixture song is on the ring');

// The ring's centre is centred when the pan takes back the framing offset.
const CENTRE_PAN = -sandbox.haloState.basePanX;

for (let t = 0; t <= 10; t += 1 / 60) sandbox.haloLyricUpdate(t);
const s = sandbox.haloState;
s.ringRot = sandbox.haloLyric.rot;
s.decoRot = s.ringRot - sandbox.haloLyric.rebase;

function camera(panX, panY, zoom) {
  sandbox.haloCam.panX = panX;
  sandbox.haloCam.panY = panY;
  sandbox.haloCam.zoom = zoom;
}

function draw() {
  drawContext.glyphs.length = 0;
  sandbox.haloDrawLyricText(drawContext);
  const region = sandbox.haloViewRegion();
  const plan = region === 'side' ? null : sandbox.haloRadialPlan(region);
  const glyphs = drawContext.glyphs.map((g) => {
    const p = sandbox.haloToScreen(g.x, g.y);
    return {
      text: g.text,
      fill: g.fill,
      fontPx: g.fontPx,
      angle: Math.atan2(g.y - s.cy, g.x - s.cx),
      sx: p.x,
      sy: p.y,
      inside: p.x >= 0 && p.x <= VIEW_W && p.y >= 0 && p.y <= VIEW_H
    };
  });
  return { region, plan, glyphs };
}

const baseFont = sandbox.haloLyricFontPx();
// `axial` is the console switch: on keeps the bent list whatever the camera shows, off is
// the radial carrier. The camera only picks where on the ring the radial line sits.
const cases = [
  { name: 'the side view the preset ships with', pan: [0, 0, 1], want: 'side', axial: 1 },
  // With the switch off, the same side view gets the straight line inside the ring - the
  // case where a bent line would stand on end, and the one that used to vanish.
  { name: 'radial on, side view: a straight line inside the ring', pan: [0, 0, 1], want: 'inline', axial: 0 },
  { name: 'centred and zoomed in, only the middle on screen', pan: [CENTRE_PAN, 0, 2.2], want: 'inside', axial: 0 },
  { name: 'centred, ring too big to fit', pan: [CENTRE_PAN, 0, 1.4], want: 'inside', axial: 0 },
  // The ring fits, but the ring its outside text would ride on does not: the text goes
  // inside instead of being painted into the screen edge.
  { name: 'centred, ring fits but not its outside text', pan: [CENTRE_PAN, 0, 0.7], want: 'inside', axial: 0 },
  { name: 'looking at the bottom of the ring', pan: [CENTRE_PAN, 600, 1.6], want: 'bottom', axial: 0 },
  { name: 'looking at the top of the ring', pan: [CENTRE_PAN, -600, 1.6], want: 'top', axial: 0 },
  { name: 'the whole ring on screen', pan: [CENTRE_PAN, 0, 0.55], want: 'whole', axial: 0 }
];

const readings = [];
for (const c of cases) {
  sandbox.haloTuning.axialLyric = c.axial;
  camera(c.pan[0], c.pan[1], c.pan[2]);
  const frame = draw();
  assert.strictEqual(frame.region, c.want,
    `${c.name}: the carrier must be ${c.want}, got ${frame.region}`);
  if (c.want === 'side') {
    // The axial list is the other carrier's business; here only that it is the one chosen.
    assert(frame.glyphs.length > 0, `${c.name}: the list must still be painted`);
    continue;
  }
  const plan = frame.plan;
  assert(frame.glyphs.length > 0, `${c.name}: the line must be painted`);
  // The user's requirement, in one line: whatever the camera shows, the text is visible.
  const off = frame.glyphs.filter((g) => !g.inside);
  assert.strictEqual(off.length, 0,
    `${c.name}: ${off.length} of ${frame.glyphs.length} glyphs are off the screen (first at ${off[0] && off[0].sx.toFixed(0)}, ${off[0] && off[0].sy.toFixed(0)})`);
  // Everything drawn inside the window: the mask cuts the rest, so a glyph outside it would
  // be invisible work at best and a wrapped line at worst.
  // The whole-ring carrier reads across two windows (top and bottom); the others one.
  const windows = plan.a1 === plan.a0 ? [plan.a0] : [plan.a0, plan.a1];
  for (const g of frame.glyphs) {
    const nearest = Math.min.apply(null, windows.map((w) => Math.abs(sandbox.haloNormAngle(g.angle - w))));
    assert(nearest <= sandbox.HALO_RADIAL_MAX_HALF + 1e-9,
      `${c.name}: a glyph at ${(g.angle * 180 / Math.PI).toFixed(0)}deg is outside the window around ${(plan.a0 * 180 / Math.PI).toFixed(0)}deg`);
  }
  const main = frame.glyphs.filter((g) => g.fontPx === plan.font || g.fontPx === baseFont * sandbox.HALO_RADIAL_FAR_SCALE);
  const sub = frame.glyphs.filter((g) => (g.fontPx || 0) < (plan.font * 0.9));
  assert(main.length > 0 && sub.length > 0, `${c.name}: the line and its translation must both be painted`);
  const meanY = (list) => list.reduce((sum, g) => sum + g.sy, 0) / list.length;
  // The original always reads above its translation, with a line's own height between
  // them: the two arcs must not be drawn on top of each other.
  assert(meanY(main) < meanY(sub),
    `${c.name}: the original must sit above the translation (${meanY(main).toFixed(0)} against ${meanY(sub).toFixed(0)})`);
  assert(meanY(sub) - meanY(main) >= plan.font * 0.7,
    `${c.name}: the two lines must be a line-height apart on screen (${(meanY(sub) - meanY(main)).toFixed(0)}px for a ${plan.font.toFixed(0)}px line)`);
  readings.push(`${c.want}: ${frame.glyphs.length} glyphs at ${plan.font.toFixed(1)}px, ` +
    `original y≈${meanY(main).toFixed(0)}, translation y≈${meanY(sub).toFixed(0)}`);
  if (c.want === 'whole') {
    assert(plan.font > baseFont * 1.4,
      `the whole-ring carrier must read from further away: ${plan.font}px against ${baseFont}px`);
    assert(meanY(main) < VIEW_H / 2 && meanY(sub) > VIEW_H / 2,
      'the whole-ring carrier puts the original over the top and the translation along the bottom');
    assert(Math.abs(plan.r0 - plan.r1) < 1e-9, 'the whole-ring carrier rides one outer circle');
    assert(plan.r0 > s.RO, `the whole-ring carrier is outside the rim (${plan.r0} against ${s.RO})`);
  }
  if (c.want === 'top') {
    assert(meanY(main) < VIEW_H / 2, 'a top view keeps the text in the upper half of the screen');
    assert(plan.r0 > plan.r1, 'a top view puts the original on the outer arc');
  }
  if (c.want === 'bottom') {
    assert(meanY(main) > VIEW_H / 2, 'a bottom view keeps the text in the lower half of the screen');
    assert(plan.r0 < plan.r1, 'a bottom view puts the original on the inner arc, which is the upper one there');
  }
  if (c.want === 'inline') {
    assert(Math.max(plan.r0, plan.r1) < s.R,
      `the straight inside line must sit inside the ring (${plan.r0.toFixed(0)} against ${s.R.toFixed(0)})`);
    assert(Math.abs(plan.r0 - (s.R - s.band * 1.1)) < 1e-6 || plan.r0 >= baseFont * 3,
      'and ride the ring inner edge unless the screen is closer');
  }
  if (c.want === 'inside') {
    assert(Math.max(plan.r0, plan.r1) < s.R, 'an inside carrier stays inside the ring');
    assert(plan.r0 >= baseFont * 3 - 1e-6,
      `an inside carrier must never collapse below a few line heights, got ${plan.r0.toFixed(0)}px`);
    // When the ring fits the view, the carrier rides the ring's own fraction of its radius:
    // moving the camera then carries it the way it carries everything else on the ring.
    if (c.pan[2] === 0.7) {
      assert(Math.abs(plan.r0 - s.R * 0.72) < 1e-6,
        `an inside carrier that fits must ride the ring (${plan.r0.toFixed(1)} against ${(s.R * 0.72).toFixed(1)})`);
    }
  }
}

console.log('  carriers: ' + readings.join(' | '));

// The console decides the carrier; the camera only decides where the radial line sits.
{
  sandbox.haloTuning.axialLyric = 1;
  for (const pan of [[0, 0, 1], [CENTRE_PAN, 0, 0.55], [CENTRE_PAN, 600, 1.6], [CENTRE_PAN, 0, 2.2]]) {
    camera(pan[0], pan[1], pan[2]);
    assert.strictEqual(sandbox.haloViewRegion(), 'side',
      'with 侧边轴向歌词 on, the list stays whatever the camera shows');
  }
  sandbox.haloTuning.axialLyric = 0;
  camera(0, 0, 1);
  assert.strictEqual(sandbox.haloViewRegion(), 'inline',
    'with the switch off, even the side view uses the radial carrier - never the list');
  sandbox.haloTuning.axialLyric = 1;
}

// The seam: where a line is born and dies. It is the point opposite the read mark, the same
// point the dial's rows are cut at, so the read-angle knob moves both carriers alike.
{
  camera(CENTRE_PAN, -600, 1.6);
  sandbox.haloTuning.readAngle = 0;
  assert(Math.abs(Math.abs(sandbox.haloRadialPlan('top').seam) - Math.PI) < 1e-9,
    'with the read mark at zero the seam is the point opposite it');
  sandbox.haloTuning.readAngle = 45;
  const seam = sandbox.haloRadialPlan('top').seam;
  assert(Math.abs(sandbox.haloNormAngle(seam - (Math.PI + Math.PI / 4))) < 1e-9,
    `the seam must follow the read-angle knob, got ${seam}`);
  sandbox.haloTuning.readAngle = 0;
}

// The swing is started by the clock, not by the test: a line change, as the update sees it,
// puts the disc at the start of its swing and lets it settle over one turn.
{
  sandbox.haloCam.panX = CENTRE_PAN;
  sandbox.haloCam.panY = -600;
  sandbox.haloCam.zoom = 1.6;
  // As a rebuilt list would leave it: row 0 on the disc, nothing swinging.
  sandbox.haloLyric.radial = { item: 0, prev: -1, phase: 1, startAt: 0, dur: 0.55 };
  sandbox.haloLyricUpdate(4);
  const radial = sandbox.haloLyric.radial;
  assert.strictEqual(radial.item, 1, `a line change must put the new line on the disc, got ${radial.item}`);
  assert(radial.phase < 0.05, `the swing must start at once, phase ${radial.phase}`);
  const dur = radial.dur;
  sandbox.haloLyricUpdate(4 + dur / 2);
  assert(Math.abs(radial.phase - 0.5) < 0.05, `the swing must be half done halfway through, phase ${radial.phase}`);
  sandbox.haloLyricUpdate(4 + dur + 0.01);
  assert(radial.phase >= 0.99, `the swing must settle when the turn would have, phase ${radial.phase}`);
  assert.strictEqual(radial.prev, 0, 'the line that was read must be the one swinging out');
}

// The disc: a line change swings the old line towards the seam and brings the new one in on
// the same wheel. Mid-swing both are painted, on opposite sides of where the line reads.
{
  sandbox.haloTuning.axialLyric = 0;
  camera(CENTRE_PAN, -600, 1.6);
  const cur = sandbox.haloLyric.current;
  sandbox.haloLyric.radial = { item: cur, prev: cur - 1, phase: 0.5, startAt: 0, dur: 1 };
  const mid = draw();
  const plan = mid.plan;
  const curHead = sandbox.haloLyric.items[cur].text[0];
  const prevHead = sandbox.haloLyric.items[cur - 1].text[0];
  const headOf = (frame, ch) => {
    const g = frame.glyphs.find((x) => x.text === ch);
    assert(g, `the head glyph of the line starting with "${ch}" must be painted`);
    return g.angle;
  };
  const layout = plan.a0;
  const spin = sandbox.haloNormAngle(plan.seam - layout);
  const dPrev = sandbox.haloNormAngle(headOf(mid, prevHead) - layout);
  const dCur = sandbox.haloNormAngle(headOf(mid, curHead) - layout);
  // The two lines are on one wheel: the outgoing has swung part of the way towards the
  // seam, the incoming is the same distance on the other side of the read spot.
  assert(Math.sign(dPrev) === Math.sign(spin) && Math.abs(dPrev) > Math.abs(spin) * 0.2,
    `the line being left must swing towards the seam (head ${(dPrev * 180 / Math.PI).toFixed(0)}deg from the read spot, seam ${(spin * 180 / Math.PI).toFixed(0)}deg away)`);
  assert(Math.sign(dCur) === -Math.sign(spin) && Math.abs(dCur) > Math.abs(spin) * 0.2,
    `the line arriving must come from the other side (head ${(dCur * 180 / Math.PI).toFixed(0)}deg from the read spot)`);
  sandbox.haloLyric.radial.phase = 1;
  const settled = draw();
  assert(settled.glyphs.length > 0, 'the settled disc must paint the line');
  assert(!settled.glyphs.some((g) => g.text === prevHead),
    'the line that left must be gone once the swing ends');
  const settledHead = headOf(settled, curHead);
  assert(Math.abs(sandbox.haloNormAngle(settledHead - layout)) < 0.3,
    `the settled line must sit on the read spot (head ${(sandbox.haloNormAngle(settledHead - layout) * 180 / Math.PI).toFixed(0)}deg off)`);
}

// The colour is the app's lyric colour, not one of the ring's own: a custom colour reaches
// the glyphs, and moving it moves them.
{
  sandbox.haloTuning.axialLyric = 0;
  camera(CENTRE_PAN, 0, 0.55);
  const before = draw();
  const mainFill = before.glyphs.find((g) => (g.fontPx || 0) >= before.plan.font * 0.9).fill;
  const subFill = before.glyphs.find((g) => (g.fontPx || 0) < before.plan.font * 0.9).fill;
  assert(/255,240,184/.test(mainFill),
    `the line must be painted in the app's highlight colour, got ${mainFill}`);
  assert(/126,200,216/.test(subFill),
    `the translation must be painted in the app's lyric colour, got ${subFill}`);
  sandbox.fx.lyricColor = '#123456';
  const after = draw();
  const moved = after.glyphs.find((g) => (g.fontPx || 0) < after.plan.font * 0.9).fill;
  assert(/18,52,86/.test(moved),
    `moving the app's lyric colour must move the ring's translation, got ${moved}`);
  sandbox.fx.lyricColor = '#7ec8d8';
}

// The axial carrier paints with the same palette: the row being sung is the highlight and
// the others the lyric colour.
{
  sandbox.haloTuning.axialLyric = 1;
  camera(0, 0, 1);
  const frame = draw();
  assert.strictEqual(frame.region, 'side', 'the shipped framing is the axial carrier');
  const fills = frame.glyphs.map((g) => g.fill);
  assert(fills.some((f) => /255,240,184/.test(f)), 'the sung row must use the highlight colour');
  assert(fills.some((f) => /126,200,216/.test(f)), 'the other rows must use the lyric colour');
}

// The camera reset: dragging and zooming are not knobs, so they get their own way back. The
// function is read out of the store module and run, rather than trusted by its shape.
{
  const tuningPath = process.env.HALO_TUNING_PATH
    ? path.resolve(process.env.HALO_TUNING_PATH)
    : path.join(__dirname, '..', 'public', 'js', 'modules', '07-fx', '11-halo-tuning.js');
  const tuningText = fs.readFileSync(tuningPath, 'utf8');
  const start = tuningText.indexOf('function resetHaloCamera(');
  assert(start > 0, 'the ring camera needs a reset of its own, separate from the knobs');
  const end = tuningText.indexOf('\n}', start) + 2;
  const context = { haloCam: { panX: 240, panY: -80, zoom: 1.7 }, showToast() {} };
  vm.createContext(context);
  vm.runInContext(tuningText.slice(start, end) + '\nthis.reset = resetHaloCamera;', context);
  context.reset();
  assert.strictEqual(context.haloCam.panX, 0, 'the reset must put the pan back horizontally');
  assert.strictEqual(context.haloCam.panY, 0, 'and vertically');
  assert.strictEqual(context.haloCam.zoom, 1, 'and the zoom');
}

console.log('[OK] The ring picks its lyric carrier from the camera, keeps the text on screen and paints it in the app\'s colours.');
