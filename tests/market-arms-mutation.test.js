'use strict';

// 门臂自身的对照：每一条臂都必须在一次蓄意破坏上变红，否则它什么都没有证明。
// 全部在文本副本上做，仓库文件只读不写。

const fs = require('node:fs');
const path = require('node:path');
const arms = require('../scripts/market-arms.js');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PRESET = 'public/js/modules/02-visual/21-rhythm-market-preset.js';
const SERIES = 'js/modules/03-beat/07-market-series.js';
const TUNING = 'public/js/modules/07-fx/13-market-tuning.js';
const HTML = 'public/index.html';
const CONSOLE = 'public/js/modules/07-fx/09-console-workspace.js';

const loaderText = read('public/js/index-loader.js');
const start = loaderText.indexOf('const modulePaths = [');
const block = loaderText.slice(start, loaderText.indexOf('];', start));
const moduleTexts = [...block.matchAll(/'(js\/modules\/[^']+)'/g)].map((m) => ({
  rel: m[1],
  text: read('public/' + m[1])
}));

const base = {
  presetRel: '02-visual/21-rhythm-market-preset.js',
  presetText: read(PRESET),
  tuningText: read(TUNING),
  htmlText: read(HTML),
  consoleText: read(CONSOLE),
  moduleTexts
};

function run(over) {
  const fails = [];
  const fail = (m) => fails.push(m);
  const cfg = Object.assign({}, base, over || {});
  arms.checkSingleOwner(cfg.moduleTexts, fail);
  arms.checkKnobWiring({
    presetRel: cfg.presetRel, presetText: cfg.presetText, tuningText: cfg.tuningText,
    htmlText: cfg.htmlText, consoleText: cfg.consoleText, fail
  });
  return fails;
}

// expect: 0 for the shipped text, otherwise "must fail at least once".
const cases = [];
const add = (name, over, expect) => cases.push({ name, over, expect, fails: run(over) });

add('shipped text', null, 0);
add('a data declaration shadows a function from another module', {
  moduleTexts: moduleTexts.map((m) => (m.rel === SERIES ? { rel: m.rel, text: 'var marketCandleScratch = null;\n' + m.text } : m))
}, 1);
add('a knob loses its read point', {
  presetText: base.presetText.replace(/marketParam\('reboundTau'\)/g, '0.22')
}, 1);
add('a slider range drifts from the schema', {
  htmlText: base.htmlText.replace('id="fx-mkcamDist" type="range" min="2" max="40"', 'id="fx-mkcamDist" type="range" min="2" max="60"')
}, 1);
add('a knob loses its console row', {
  consoleText: base.consoleText.replace(/^\s*fxConsoleItem\('fx-mkfovDeg'.*\r?\n/m, '')
}, 1);
add('a rebuild kind the store does not dispatch', {
  presetText: base.presetText.replace(
    "iconSource: { def: 0, min: 0, max: 1, kind: 'count', rebuild: 'wall' }",
    "iconSource: { def: 0, min: 0, max: 1, kind: 'count', rebuild: 'wallpaper' }"
  )
}, 1);
add('a bool loses its switch binding', {
  htmlText: base.htmlText.replace('id="t-mkbeatSync" onclick="toggleMarketTuning(\'beatSync\')"', 'id="t-mkbeatSync"')
}, 1);
add('a bool is not painted back onto its switch', {
  tuningText: base.tuningText.replace(/document\.getElementById\('t-mk' \+ key\)/g, "document.getElementById('t-mk' + 'x')")
}, 1);

let bad = 0;
for (const c of cases) {
  const ok = c.expect === 0 ? c.fails.length === 0 : c.fails.length > 0;
  if (!ok) bad += 1;
  console.log((ok ? '[OK]  ' : '[RED] ') + c.name + ' -> ' + c.fails.length + ' failure(s)');
  if (c.expect === 0 && c.fails.length) c.fails.slice(0, 8).forEach((f) => console.log('        ' + f));
  if (c.expect > 0 && !c.fails.length) console.log('        the arm stayed green on a deliberate break');
}
console.log('');
console.log(`market-arms-mutation: ${cases.length - bad}/${cases.length} cases behaved`);
process.exitCode = bad ? 1 : 0;