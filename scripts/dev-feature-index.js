'use strict';

// Feature index for Mineradio: reads the shipped sources and prints what is registered where, so
// the roadmap's tables can be checked against the code instead of being copied by hand.
//
//   node scripts/dev-feature-index.js              markdown to stdout + tmp/feature-index.md
//   node scripts/dev-feature-index.js --out=<p>    write somewhere else
//   node scripts/dev-feature-index.js --check      exit 1 when the registries disagree
//
// Read-only by design: it parses text and never loads the page or the app, so it is safe to run
// while the dev instance is playing. The only file it writes is the report (tmp/ by default).
//
// What --check enforces (the three drifts this project has actually hit):
//   1. preset cards / icons / display order / MAX_VISUAL_PRESET_INDEX must agree;
//   2. every 视觉控制台 item that names an element id must find that id in public/index.html;
//   3. every console group must sit under a tab that exists.
// Per-knob completeness (read point, min/max, reset button) stays where it belongs: quick-check.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

function read(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8');
}

function between(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker);
  if (a < 0) return '';
  const b = text.indexOf(endMarker, a + startMarker.length);
  return b < 0 ? text.slice(a) : text.slice(a, b);
}

// ---------------------------------------------------------------- the sources

const coreText = read('public', 'js', 'modules', '00-state', '00-core-stores.js');
const archiveText = read('public', 'js', 'modules', '07-fx', '00-preset-archive-data.js');
const consoleText = read('public', 'js', 'modules', '07-fx', '09-console-workspace.js');
const htmlText = read('public', 'index.html');
// server.js is large; it is read once here so the provider routes can be checked against it.
const serverText = read('server.js');

function parsePresets() {
  const meta = between(archiveText, 'var presetMeta = [', '\n];');
  const icons = between(archiveText, 'var presetIcons = [', '\n];');
  const order = (archiveText.match(/var presetDisplayOrder = \[([^\]]*)\]/) || [])[1] || '';
  const names = [...meta.matchAll(/^\s*\{\s*name:\s*'([^']*)'/gm)].map((m) => m[1]);
  const iconCount = (icons.match(/^\s*'<svg/gm) || []).length;
  const orderList = order.split(',').map((s) => Number(s.trim())).filter((n) => isFinite(n));
  const max = Number((coreText.match(/MAX_VISUAL_PRESET_INDEX = (\d+)/) || [])[1]);
  return { names, iconCount, orderList, max };
}

function parseConsole() {
  const tabs = [...between(consoleText, 'var FX_CONSOLE_TABS = [', '\n];')
    .matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'/g)]
    .map((m) => ({ key: m[1], label: m[2] }));
  const tabKeys = new Set(tabs.map((t) => t.key));

  const layout = between(consoleText, 'var FX_CONSOLE_LAYOUT = [', '\n];\n');
  const groups = [];
  let tab = '';
  let group = null;
  for (const line of layout.split(/\r?\n/)) {
    // A tab object owns `key:` at four-space indent (groups keep key and title on one line).
    const tabHit = /^ {4}key:\s*'([^']+)'\s*,?\s*$/.exec(line);
    if (tabHit) { tab = tabHit[1]; group = null; continue; }
    const groupHit = /key:\s*'([^']+)',\s*title:\s*'([^']+)'/.exec(line);
    if (groupHit) {
      const ownHit = /presets:\s*\[([^\]]*)\]/.exec(line);
      group = { tab, key: groupHit[1], title: groupHit[2], items: [], owns: ownHit ? ownHit[1].split(',').map((x) => x.trim()).filter(Boolean) : [] };
      groups.push(group);
      continue;
    }
    const itemHit = /fxConsoleItem\(/.exec(line);
    if (!itemHit || !group) continue;
    const idHit = /fxConsoleItem\(\s*'([^']+)'/.exec(line);
    const selHit = /fxConsoleItem\(\s*\{\s*selector:\s*'([^']+)'/.exec(line);
    const titleHit = /fxConsoleItem\([^,]+,\s*'([^']*)'/.exec(line);
    group.items.push({
      kind: idHit ? 'id' : (selHit ? 'selector' : 'other'),
      ref: idHit ? idHit[1] : (selHit ? selHit[1] : ''),
      title: titleHit ? titleHit[1] : ''
    });
  }
  return { tabs, tabKeys, groups };
}

// Schema entry counts live with the defaults, which for the ported presets is the preset module
// (HALO_TUNING_SCHEMA / BH_TUNING_SCHEMA), not the store. Map every `<X>_TUNING_SCHEMA` found in
// the modules to its entry count, then let the store say which one it owns.
function parseSchemaCounts() {
  const counts = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/var\s+([A-Z_][A-Z0-9_]*_TUNING_SCHEMA)\s*=\s*\{/g)) {
        const block = between(text.slice(m.index), '{', '\n};');
        counts[m[1]] = (block.match(/^\s{2}[A-Za-z_]\w*:\s*\{\s*def:/gm) || []).length;
      }
    }
  };
  walk(path.join(root, 'public', 'js', 'modules'));
  return counts;
}

// Every `<X>_TUNING_SCHEMA` / `<X>_TUNING_FIELDS` block, as key -> kind. The kind is the only thing
// that decides which control shape a row must use, so this is the map the shape check needs.
function parseSchemaEntries() {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/var\s+([A-Z_][A-Z0-9_]*_TUNING_(?:SCHEMA|FIELDS))\s*=\s*\{/g)) {
        const block = between(text.slice(m.index), '{', '\n};');
        const entries = {};
        for (const e of block.matchAll(/^\s{2}([A-Za-z_]\w*):\s*\{[^}]*kind:\s*'([^']+)'/gm)) entries[e[1]] = e[2];
        out[m[1]] = entries;
      }
    }
  };
  walk(path.join(root, 'public', 'js', 'modules'));
  return out;
}

function parseTuningStores(schemaCounts, schemaEntries) {
  const dir = path.join(root, 'public', 'js', 'modules', '07-fx');
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!/-tuning\.js$/.test(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const key = (text.match(/'(mineradio-[a-z-]+-tuning-v\d+)'/) || [])[1] || '';
    // Inline schema first, then a named schema the store only reads.
    const inline = (between(text, '{', '\n};').match(/^\s{2}[A-Za-z_]\w*:\s*\{\s*def:/gm) || []).length;
    const named = (text.match(/\b([A-Z_][A-Z0-9_]*_TUNING_(?:SCHEMA|FIELDS))\b/) || [])[1] || '';
    const keys = inline || (named && schemaCounts[named]) || 0;
    const entries = named && schemaEntries[named] ? schemaEntries[named] : {};
    // The control ids are built as `getElementById('<prefix>' + key)`; the prefix is the shape's
    // only home, so read it from there instead of guessing from the preset name.
    const prefixes = [...text.matchAll(/getElementById\('([^']+)'\s*\+\s*key\)/g)].map((m) => m[1]);
    out.push({
      file: 'public/js/modules/07-fx/' + file,
      storage: key,
      keys,
      schema: named || 'inline',
      entries,
      numericPrefix: prefixes.find((p) => p.indexOf('fx-') === 0) || '',
      togglePrefix: prefixes.find((p) => p.indexOf('t-') === 0) || ''
    });
  }
  return out;
}

function parseProviders() {
  const table = parseSearchProviders();
  const searchOrder = table.map((p) => p.key);
  const loginUi = [...htmlText.matchAll(/id="login-provider-([a-z0-9]+)"/g)].map((m) => m[1]);
  const userUi = [...htmlText.matchAll(/id="user-provider-([a-z0-9]+)"/g)].map((m) => m[1]);
  return { table, searchOrder, loginUi: [...new Set(loginUi)], userUi: [...new Set(userUi)] };
}

// The one table the search derives its order, mode test and routes from. Keeping it in the index
// means a provider added there without a server route is visible immediately.
function parseSearchProviders() {
  const text = read('public', 'js', 'modules', '05-playback', '07-search.js');
  const block = between(text, 'var SEARCH_PROVIDERS = [', '\n];');
  return [...block.matchAll(/key:\s*'([^']+)',\s*url:\s*'([^']+)'/g)].map((m) => ({ key: m[1], url: m[2] }));
}

function parseHotkeys() {
  const block = between(coreText, 'var HOTKEY_ACTIONS = [', '\n];');
  return [...block.matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'[^}]*local:\s*'([^']+)'[^}]*global:\s*'([^']*)'/g)]
    .map((m) => ({ key: m[1], label: m[2], local: m[3], global: m[4] }));
}

// Every module the page loads, in load order. A listed path that does not exist is a 404 in the
// sync-XHR loader and the whole page dies, so this is worth checking from the outside.
function parseLoader() {
  const text = read('public', 'js', 'index-loader.js');
  const block = between(text, 'const modulePaths = [', '];');
  const paths = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const missing = paths.filter((p) => !fs.existsSync(path.join(root, 'public', p)));
  return { paths, missing };
}

// Controls that the app creates at runtime instead of declaring in index.html. They are found by
// scanning for the creator's own call sites rather than by keeping a list here: a hard-coded
// allowlist would go stale the moment someone adds a third one.
function parseRuntimeControls() {
  const ids = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/ensureFxRangeControl\(\s*'[^']*'\s*,\s*'([^']+)'/g)) ids.add(m[1]);
    }
  };
  walk(path.join(root, 'public', 'js', 'modules'));
  return ids;
}

function parsePresetConstants() {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/var\s+([A-Z_][A-Z0-9_]*_PRESET_INDEX)\s*=\s*(\d+)/g)) {
        if (m[1] === 'MAX_VISUAL_PRESET_INDEX') continue;
        out[m[1]] = Number(m[2]);
      }
    }
  };
  walk(path.join(root, 'public', 'js', 'modules'));
  return out;
}

// ---------------------------------------------------------------- the checks

function runChecks(model) {
  const problems = [];
  const presetCount = model.presets.names.length;
  if (model.presets.iconCount !== presetCount) {
    problems.push(`presetIcons has ${model.presets.iconCount} entries but presetMeta has ${presetCount}`);
  }
  if (model.presets.orderList.length !== presetCount) {
    problems.push(`presetDisplayOrder has ${model.presets.orderList.length} entries but presetMeta has ${presetCount}`);
  }
  if (model.presets.max + 1 !== presetCount) {
    problems.push(`MAX_VISUAL_PRESET_INDEX is ${model.presets.max} (${model.presets.max + 1} presets) but presetMeta has ${presetCount}`);
  }
  const missingOrder = [];
  for (let i = 0; i < presetCount; i++) if (model.presets.orderList.indexOf(i) < 0) missingOrder.push(i);
  if (missingOrder.length) problems.push(`presetDisplayOrder is missing preset index(es): ${missingOrder.join(', ')}`);

  for (const p of model.loader.missing) {
    problems.push(`index-loader.js lists '${p}', which does not exist under public/ (the sync loader would 404 and the page would not boot)`);
  }

  checkControlShapes(model, problems);

  // A provider in the search table without a route in server.js is the "searches nowhere" failure:
  // the mode appears in the UI and every request 404s.
  for (const p of model.providers.table) {
    if (serverText.indexOf("'" + p.url + "'") < 0) {
      problems.push(`search provider '${p.key}' posts to ${p.url}, which server.js does not handle`);
    }
  }
  if (!model.providers.table.length) {
    problems.push('the search provider table is empty or could not be read');
  }

  for (const group of model.console.groups) {
    for (const refName of group.owns) {
      const idx = model.presetConstants[refName];
      if (!isFinite(idx)) {
        problems.push(`console group '${group.key}' is owned by '${refName}', which is not a declared *_PRESET_INDEX`);
      } else if (idx < 0 || idx >= presetCount) {
        problems.push(`console group '${group.key}' is owned by ${refName}=${idx}, outside 0..${presetCount - 1}`);
      }
    }
  }
  const htmlIds = new Set([...model.htmlIds, ...model.runtimeIds]);
  for (const group of model.console.groups) {
    if (!model.console.tabKeys.has(group.tab)) {
      problems.push(`console group '${group.key}' sits under tab '${group.tab}', which is not in FX_CONSOLE_TABS`);
    }
    for (const item of group.items) {
      if (item.kind !== 'id') continue;
      if (!htmlIds.has(item.ref)) {
        problems.push(`console item '${item.title}' (${group.tab}/${group.key}) points at #${item.ref}, which is not an id in public/index.html`);
      }
    }
  }
  return problems;
}

// Three control shapes, one per parameter type. A tuning key whose control has another shape is
// how the panel drifts: a number without an <output>, a bool drawn as a slider, an enum without a
// segmented control. Only the tuning stores are checked here - the global fx panel predates the
// rule and is guarded per knob elsewhere.
const CONTROL_SHAPES = {
  number: { tag: 'type="range"', sibling: '<output', label: '数值滑条 + <output>' },
  bool: { tag: 'class="fx-toggle"', sibling: '', label: '开关 .fx-toggle' },
  enum: { tag: 'class="fx-seg"', sibling: '', label: '枚举 .fx-seg' }
};

function checkControlShapes(model, problems) {
  const html = model.htmlText;
  for (const st of model.stores) {
    const entries = st.entries || {};
    for (const key of Object.keys(entries)) {
      const kind = entries[key];
      const isBool = kind === 'bool';
      const prefix = isBool ? st.togglePrefix : st.numericPrefix;
      if (!prefix) continue;
      const id = prefix + key;
      const m = new RegExp('id="' + id + '"').exec(html);
      if (!m) {
        problems.push(`${st.storage}: '${key}' (${kind}) has no control #${id}`);
        continue;
      }
      // Judge the whole opening tag, not just what follows the id: class/type may come before it.
      const tagStart = html.lastIndexOf('<', m.index);
      const tagEnd = html.indexOf('>', m.index);
      const tag = html.slice(tagStart, tagEnd < 0 ? html.length : tagEnd + 1);
      const shape = CONTROL_SHAPES[isBool ? 'bool' : 'number'];
      if (tag.indexOf(shape.tag) < 0) {
        problems.push(`${st.storage}: '${key}' (${kind}) must be a ${shape.label} - #${id} is not`);
      }
      if (shape.sibling) {
        const lineEnd = html.indexOf('\n', m.index);
        const line = html.slice(tagStart, lineEnd < 0 ? html.length : lineEnd);
        if (line.indexOf(shape.sibling) < 0) {
          problems.push(`${st.storage}: '${key}' has a slider but no ${shape.sibling}> beside it, so its value is never shown`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- the report

function render(model) {
  const out = [];
  out.push('# Mineradio 功能索引（由 `scripts/dev-feature-index.js` 生成，勿手改）');
  out.push('');
  out.push('> 数字来自代码文本解析；结构说明与配方在 `docs/PROJECT_OUTLINE.md`。');
  out.push('');
  out.push('## 1. 视觉预设注册');
  out.push('');
  out.push(`共 **${model.presets.names.length}** 张（下标 0..${model.presets.names.length - 1}），` +
    `\`MAX_VISUAL_PRESET_INDEX = ${model.presets.max}\`，图标 ${model.presets.iconCount} 个，` +
    `显示顺序 ${model.presets.orderList.length} 项。`);
  out.push('');
  out.push('| 下标 | 卡片名 | 显示次序 |');
  out.push('| --- | --- | --- |');
  model.presets.names.forEach((name, i) => {
    out.push(`| ${i} | ${name} | ${model.presets.orderList.indexOf(i)} |`);
  });
  out.push('');
  out.push('## 2. 视觉控制台');  out.push('');
  out.push(`tab：${model.console.tabs.map((t) => `${t.label}(${t.key})`).join(' / ')}`);
  out.push('');
  out.push('| tab | 分组 | 行数 | 归属预设 | 控件 |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const g of model.console.groups) {
    const refs = g.items.map((it) => (it.kind === 'id' ? '#' + it.ref : it.ref)).join(', ');
    const owns = g.owns.length ? g.owns.map((n) => n).join(', ') : '全部';
    out.push(`| ${g.tab} | ${g.title} | ${g.items.length} | ${owns} | ${refs} |`);
  }
  out.push('');
  out.push('## 3. 面板控件（`public/index.html`）');
  out.push('');
  const fxIds = [...model.htmlIds].filter((id) => /^fx-/.test(id));
  const tIds = [...model.htmlIds].filter((id) => /^t-/.test(id));
  out.push(`\`fx-*\` ${fxIds.length} 个，\`t-*\` ${tIds.length} 个，HTML 里共 ${new Set(model.htmlIds).size} 个 id`
    + `（另有 ${model.runtimeIds.length} 个由脚本在运行期创建）。`);
  out.push('');
  out.push('## 4. 每预设旋钮 store');
  out.push('');
  out.push('| 文件 | localStorage key | 键数 | schema |');
  out.push('| --- | --- | --- | --- |');
  for (const st of model.stores) out.push(`| ${st.file} | ${st.storage || '—'} | ${st.keys} | ${st.schema} |`);
  out.push('');
  out.push('## 5. 播放源');
  out.push('');
  out.push(`搜索顺序：${model.providers.searchOrder.join(', ')}`);
  out.push('');
  out.push('| 播放源 | 搜索路由 | 登录 UI | 账号面板 |');
  out.push('| --- | --- | --- | --- |');
  for (const p of model.providers.table) {
    out.push(`| ${p.key} | ${p.url} | ${model.providers.loginUi.indexOf(p.key) >= 0 ? '有' : '—'} | ${model.providers.userUi.indexOf(p.key) >= 0 ? '有' : '—'} |`);
  }
  out.push('');
  out.push(`登录 UI：${model.providers.loginUi.join(', ') || '—'}　账号面板：${model.providers.userUi.join(', ') || '—'}`);
  out.push('');
  out.push('## 6. 快捷键');
  out.push('');
  out.push('| 动作 | 名称 | 本地 | 全局 |');
  out.push('| --- | --- | --- | --- |');
  for (const h of model.hotkeys) out.push(`| ${h.key} | ${h.label} | ${h.local} | ${h.global || '—'} |`);
  out.push('');
  out.push('## 7. 页面加载（`public/js/index-loader.js`）');
  out.push('');
  out.push(`modulePaths ${model.loader.paths.length} 条（拼成单个 script，顺序＝依赖顺序），缺失 ${model.loader.missing.length} 条。`);
  out.push('');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- main

function main(argv) {
  const check = argv.includes('--check');
  const outArg = (argv.find((a) => a.startsWith('--out=')) || '').slice(6);
  const schemaEntries = parseSchemaEntries();
  const model = {
    presets: parsePresets(),
    console: parseConsole(),
    stores: parseTuningStores(parseSchemaCounts(), schemaEntries),
    providers: parseProviders(),
    hotkeys: parseHotkeys(),
    loader: parseLoader(),
    presetConstants: parsePresetConstants(),
    htmlText,
    htmlIds: [...htmlText.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
    runtimeIds: [...parseRuntimeControls()]
  };
  const problems = runChecks(model);

  if (check) {
    if (problems.length) {
      console.log(`feature-index: ${problems.length} problem(s)`);
      for (const p of problems) console.log('  - ' + p);
      process.exitCode = 1;
    } else {
      console.log(`feature-index: OK (${model.presets.names.length} presets, ${model.console.groups.length} console groups, `
        + `${model.stores.length} tuning stores, ${model.providers.searchOrder.length} search providers)`);
      process.exitCode = 0;
    }
    return;
  }

  const markdown = render(model);
  const outPath = outArg ? path.resolve(root, outArg) : path.join(root, 'tmp', 'feature-index.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf8');
  process.stdout.write(markdown);
  console.log(`\nfeature-index -> ${rel(outPath)}`);
  if (problems.length) {
    console.log(`feature-index: ${problems.length} problem(s) (run --check for the verdict)`);
    for (const p of problems) console.log('  - ' + p);
  }
}

main(process.argv.slice(2));
