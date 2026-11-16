'use strict';

// 预设 17「调音台」的主题色面板配色。
//
// 规则：白天面板 = 当前歌曲的主题色（控制台「视觉主色」：封面取色，或自定义色），黑夜面板 = 它在色环
// 上 +120° 的那个色；两套只差在亮度上（亮 0.66 / 暗 0.16），饱和度封顶以免大面积纯色刺眼。这里把 app
// 自己的 rgbToHsl/hslToRgb/rgbToHexColor 原样切片进来跑 mixerThemePair，再用上面这套规则当判据。
// 另外量：uThemeMix 归零必须逐位退回参考的黑白灰、灰主题必须保持无色相、换色才重算一次。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const mixerSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '22-mixer-desk-preset.js'), 'utf8');
const helpersSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
const fontSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '05-lyrics-fonts-texture.js'), 'utf8');

// ---------------------------------------------------------------- the harness

function fn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, `${name} has to live in the source it is judged from`);
  let depth = 0;
  let i = src.indexOf('{', at);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  throw new Error(`${name} is not brace-balanced`);
}

function constant(name, fallback) {
  const m = mixerSrc.match(new RegExp('var ' + name + '\\s*=\\s*([^;]+);'));
  return m ? Number(new Function('return (' + m[1] + ');')()) : fallback;
}

const HUE_SHIFT = constant('MIXER_THEME_HUE_SHIFT', NaN);
const DAY_L = constant('MIXER_THEME_DAY_LIGHTNESS', NaN);
const NIGHT_L = constant('MIXER_THEME_NIGHT_LIGHTNESS', NaN);
const SAT_CAP = constant('MIXER_THEME_SATURATION_CAP', NaN);
const FALLBACK = (mixerSrc.match(/var MIXER_THEME_FALLBACK\s*=\s*'([^']+)'/) || [])[1];

const body = [
  fn(helpersSrc, 'rgbToHsl'),
  fn(helpersSrc, 'hslToRgb'),
  fn(helpersSrc, 'rgbToHexColor'),
  fn(helpersSrc, 'normalizeHexColor'),
  fn(fontSrc, 'hexToRgb'),
  fn(mixerSrc, 'mixerThemeHex'),
  fn(mixerSrc, 'mixerThemePair'),
  'return mixerThemePair;'
].join('\n');
const mixerThemePair = new Function(
  'MIXER_THEME_HUE_SHIFT', 'MIXER_THEME_SATURATION_CAP', 'MIXER_THEME_DAY_LIGHTNESS', 'MIXER_THEME_NIGHT_LIGHTNESS',
  body
)(HUE_SHIFT, SAT_CAP, DAY_L, NIGHT_L);

function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function hslOf(hex) {
  const c = rgbOf(hex);
  return rgbToHslOf(c.r, c.g, c.b);
}
function rgbToHslOf(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}
function luma(hex) {
  const c = rgbOf(hex);
  return 0.2126 * c.r / 255 + 0.7152 * c.g / 255 + 0.0722 * c.b / 255;
}
function hueDist(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

const THEMES = ['#e4572e', '#2e86e4', '#86e42e', '#b32ee4', '#e4c82e', '#2ee4a6', '#7a1f1f', '#f0f0f0', '#9db8cf'];

assert.ok(isFinite(HUE_SHIFT) && isFinite(DAY_L) && isFinite(NIGHT_L) && isFinite(SAT_CAP),
  'the palette constants have to be numbers the judge can read');

// ---------------------------------------------------------------- 1) the two colours are 120° apart

{
  assert.ok(Math.abs(HUE_SHIFT - 1 / 3) < 1e-9, 'the second colour has to sit a third of the wheel away, i.e. 120 degrees');
  let checked = 0;
  for (const theme of THEMES) {
    const pair = mixerThemePair(theme);
    const from = hslOf(theme);
    const day = hslOf(pair.day);
    const night = hslOf(pair.night);
    if (from.s < 0.02) continue;
    checked++;
    const wantNight = (from.h + HUE_SHIFT) % 1;
    // The hue survives the lightness/saturation rewrite within quantisation, and never collides.
    assert.ok(hueDist(day.h, from.h) < 0.02, `${theme}: the day panel keeps the song hue`);
    assert.ok(hueDist(night.h, wantNight) < 0.02, `${theme}: the night panel is the day panel plus 120 degrees`);
    assert.ok(hueDist(day.h, night.h) > 0.1, `${theme}: the two colours have to read as different hues`);
  }
  assert.ok(checked >= 6, `the hue rule needs chromatic themes to judge (checked ${checked})`);
}

// ---------------------------------------------------------------- 2) the two colours differ in brightness

{
  assert.ok(DAY_L > 0.6 && NIGHT_L < 0.2, `day ${DAY_L} / night ${NIGHT_L}: the pair is separated by lightness, not by hue alone`);
  let minRatio = Infinity;
  for (const theme of THEMES) {
    const pair = mixerThemePair(theme);
    const d = hslOf(pair.day), n = hslOf(pair.night);
    assert.ok(Math.abs(d.l - DAY_L) < 0.02, `${theme}: the day panel is drawn at the day lightness`);
    assert.ok(Math.abs(n.l - NIGHT_L) < 0.02, `${theme}: the night panel is drawn at the night lightness`);
    const ratio = luma(pair.day) / Math.max(1e-6, luma(pair.night));
    minRatio = Math.min(minRatio, ratio);
  }
  // The ratio is measured as luma, so a blue day panel over a yellow-green night one lands lower than
  // the 0.66/0.16 lightness pair suggests; 2 is still an obvious step, and the desk never inverts.
  assert.ok(minRatio > 2, `the day panel has to be visibly brighter than the night one (worst ratio ${minRatio.toFixed(2)})`);
}

// ---------------------------------------------------------------- 3) saturation stays a paint, not a highlighter

{
  for (const theme of ['#ff0000', '#00ff00', '#0000ff', '#ff00ff']) {
    const pair = mixerThemePair(theme);
    assert.ok(hslOf(pair.day).s <= SAT_CAP + 0.02 && hslOf(pair.night).s <= SAT_CAP + 0.02,
      `${theme}: a full-saturation cover may not blow the cap on a wall-sized panel`);
  }
  assert.ok(SAT_CAP >= 0.2 && SAT_CAP <= 0.85, `the cap ${SAT_CAP} has to leave the panels readable`);

  // A grey cover has no hue to rotate: both ends stay achromatic, so the desk still looks like itself.
  for (const grey of ['#808080', '#f0f0f0', '#202020']) {
    const pair = mixerThemePair(grey);
    for (const hex of [pair.day, pair.night]) {
      const c = rgbOf(hex);
      assert.ok(Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 2, `${grey} has to produce a neutral ${hex}`);
    }
    assert.ok(luma(pair.day) > 0.6 && luma(pair.night) < 0.2, `${grey}: light plates, dark plates`);
  }
}

// ---------------------------------------------------------------- 4) the knob still lands on the reference greys

{
  // vec3 dayT=mix(c,uDayCol,uThemeMix); vec3 inkT=mix(vec3(.04),uNightCol,uThemeMix);
  // At uThemeMix=0 both mixes take their first argument, which is the reference's own literal.
  assert.ok(/vec3 dayT=mix\(c,uDayCol,uThemeMix\);/.test(mixerSrc), 'the light plate has to blend from the reference c');
  assert.ok(/vec3 inkT=mix\(vec3\(\.04\),uNightCol,uThemeMix\);/.test(mixerSrc), 'the dark plate has to blend from the reference .04');
  assert.ok(/vec3 c=\.9\+/.test(mixerSrc), 'the reference light literal has to stay as the zero end of the mix');
  assert.ok(/basecol=mix\(ink,plate,mtlp\)\*\(\.75\+\.5\*drv\);/.test(mixerSrc),
    'mtlp still picks plate vs engraving, so day/night stay legible at any theme');

  // The two themed tones trade places on an inverted cell and nowhere else, so the theme pair is the
  // only thing that decides what colour the desk wears.
  assert.ok(/vec3 plate=mix\(dayT,inkT,flip\);/.test(mixerSrc) && /vec3 ink=mix\(inkT,dayT,flip\);/.test(mixerSrc),
    'the plate tone and the engraving tone have to be one trade away from each other');
  const trade = mixerSrc.match(/vec3 plate=mix\((\w+),(\w+),flip\);/);
  assert.ok(trade && trade[1] === 'dayT' && trade[2] === 'inkT',
    'the un-flipped plate has to be the day colour, or 昼夜 0% would show the night scheme');
}

// ---------------------------------------------------------------- 5) one song, one calculation

{
  const colors = fn(mixerSrc, 'mixerThemeColors');
  assert.ok(/effectiveSkullVisualTint/.test(colors), 'the desk has to reuse the console 视觉主色, not invent its own cover sampler');
  assert.ok(/mixerState\.themeKey !== hex/.test(colors), 'the pair is only rebuilt when the song colour actually changed');
  assert.ok(/MIXER_THEME_FALLBACK/.test(colors), 'with nothing loaded the desk still needs a colour');
  assert.ok(/^#[0-9a-f]{6}$/.test(String(FALLBACK || '')), `the fallback has to be a hex colour (got ${FALLBACK})`);
  assert.ok(mixerSrc.includes('var theme = mixerThemeColors();') && /u\.uDayCol\.value\.copy\(theme\.themeDay\)/.test(mixerSrc)
    && /u\.uNightCol\.value\.copy\(theme\.themeNight\)/.test(mixerSrc), 'the pair has to reach both uniforms every frame');
}

// ---------------------------------------------------------------- 6) the wiring

{
  assert.ok(/"uniform vec3 uDayCol;"/.test(mixerSrc) && /"uniform vec3 uNightCol;"/.test(mixerSrc),
    'both colours have to be declared in the ported body');
  assert.ok(/"uniform float uThemeMix;"/.test(mixerSrc), 'the strength has to be declared too');
  assert.ok(/themeMix:\s*\{\s*def:\s*1,\s*min:\s*0,\s*max:\s*1/.test(mixerSrc),
    'themeMix defaults to 1: the desk is meant to wear the song colour');
  assert.ok(/uThemeMix:\s*\{\s*value:\s*1\s*\}/.test(mixerSrc), 'the material needs the strength in its initial block');
  assert.ok(/uDayCol:\s*\{\s*value:\s*new THREE\.Color\(mixerThemePair\(MIXER_THEME_FALLBACK\)\.day\)/.test(mixerSrc),
    'the initial colours have to come from the same rule, not from a second literal');
  assert.ok(/u\.uThemeMix\.value\s*=\s*mixerClamp01\(mixerParam\('themeMix'\)\)/.test(mixerSrc), 'the knob has to reach the shader clamped');

  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const at = html.indexOf('id="fx-mixerthemeMix"');
  assert.ok(at > 0, 'the strength needs a row in the 调音台 panel');
  const tag = html.slice(at, html.indexOf('>', at));
  assert.ok(tag.includes('min="0"') && tag.includes('max="1"'), 'the slider must run 0..1');
  assert.ok(html.includes("setMixerTuning('themeMix', this.value)"), 'the slider must write themeMix');

  const consoleSrc = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  assert.ok(consoleSrc.includes("fxConsoleItem('fx-mixerthemeMix'"), 'the knob must be listed in the console 调音台 group');
}

console.log(`OK mixer theme palette: song hue + 120°, luma ratio >2, cap ${SAT_CAP}, grey stays grey, 0 returns the reference`);
