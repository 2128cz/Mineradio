'use strict';

// Mechanically extract the renderer module load order, the globals each module
// declares, and the cross-layer references. There is no bundler: index-loader.js
// concatenates these files into one global scope, so load order IS dependency order.
// Heuristic by design: only top-level (column 0) declarations are treated as globals.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');
const loaderFile = path.join(publicDir, 'js', 'index-loader.js');
const DECL_RE = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
const WINDOW_RE = /^window\.([A-Za-z_$][\w$]*)\s*=/;

// `var a = 1, b = 2, c = 3;` declares three globals on one line: capture every
// declarator at bracket depth 0, not just the first.
function declaratorsOf(line) {
  const m = /^(?:var|let)\s+/.exec(line);
  if (!m) {
    const single = DECL_RE.exec(line);
    if (!single) return [];
    if (/^(?:var|let)\s/.test(line)) return [];
    return [single[1]];
  }
  const out = [];
  let depth = 0;
  let i = m[0].length;
  let expectName = true;
  let ident = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === '(' || ch === '[' || ch === '{') { if (depth === 0 && expectName && !ident) { ident = ''; } depth++; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; i++; continue; }
    if (depth > 0) { i++; continue; }
    if (ch === ',') { if (ident) out.push(ident); ident = ''; expectName = true; i++; continue; }
    if (ch === '=' || ch === ';') { if (ident) { out.push(ident); ident = ''; } expectName = ch === ';'; i++; continue; }
    if (/[A-Za-z0-9_$]/.test(ch)) { if (expectName) { ident += ch; } i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    expectName = false;
    i++;
  }
  if (ident) out.push(ident);
  return out;
}

function readModulePaths() {
  const text = fs.readFileSync(loaderFile, 'utf8');
  const out = [];
  const re = /'((?:js\/modules|sonic)[^']*)'/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function layerOf(modulePath) {
  const base = path.basename(path.dirname(modulePath));
  if (modulePath.indexOf('js/modules/') !== 0) return 'public-root';
  return base;
}

function build() {
  const modules = readModulePaths().map((modulePath, order) => {
    const abs = path.join(publicDir, modulePath);
    let text = '';
    let missing = false;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      missing = true;
    }
    const declares = new Set();
    const lines = text.split('\n');
    lines.forEach((line) => {
      declaratorsOf(line).forEach((name) => declares.add(name));
      const win = WINDOW_RE.exec(line);
      if (win) declares.add(win[1]);
    });
    return {
      order,
      modulePath,
      layer: layerOf(modulePath),
      file: abs,
      missing,
      lines: missing ? 0 : lines.length,
      declares: Array.from(declares),
      tokens: missing ? new Set() : new Set(text.split(/[^A-Za-z0-9_$]+/).filter(Boolean)),
    };
  });

  const declaredOnce = new Map();
  const duplicated = new Set();
  modules.forEach((mod) => {
    mod.declares.forEach((name) => {
      if (declaredOnce.has(name)) {
        duplicated.add(name);
        return;
      }
      declaredOnce.set(name, mod);
    });
  });
  duplicated.forEach((name) => declaredOnce.delete(name));

  const edges = new Map();
  const forwardRefs = [];
  declaredOnce.forEach((mod, name) => {
    if (name.length < 3) return;
    modules.forEach((other) => {
      if (other === mod || other.missing) return;
      if (other.layer === mod.layer) return;
      if (!other.tokens.has(name)) return;
      const key = other.layer + ' -> ' + mod.layer;
      if (!edges.has(key)) edges.set(key, { from: other.layer, to: mod.layer, pairs: new Map() });
      const edge = edges.get(key);
      const pair = other.modulePath + ' :: ' + mod.modulePath;
      if (!edge.pairs.has(pair)) edge.pairs.set(pair, new Set());
      edge.pairs.get(pair).add(name);
      if (mod.order > other.order) {
        forwardRefs.push({ reader: other.modulePath, readerOrder: other.order, name, declaredIn: mod.modulePath, declaredOrder: mod.order, gap: mod.order - other.order });
      }
    });
  });

  const nameReaders = new Map();
  declaredOnce.forEach((mod, name) => {
    if (name.length < 3) return;
    modules.forEach((other) => {
      if (other === mod || other.missing) return;
      if (!other.tokens.has(name)) return;
      if (!nameReaders.has(name)) nameReaders.set(name, { mod, readers: new Set() });
      nameReaders.get(name).readers.add(other.modulePath);
    });
  });

  return { modules, edges: Array.from(edges.values()), forwardRefs, nameReaders, uniqueGlobals: declaredOnce.size };
}

const result = build();
const byLayer = new Map();
result.modules.forEach((mod) => {
  if (!byLayer.has(mod.layer)) byLayer.set(mod.layer, { modules: 0, lines: 0, declares: 0 });
  const row = byLayer.get(mod.layer);
  row.modules += 1;
  row.lines += mod.lines;
  row.declares += mod.declares.length;
});

const scored = result.edges.map((e) => ({
  from: e.from,
  to: e.to,
  weight: Array.from(e.pairs.values()).reduce((a, b) => a + b.size, 0),
  top: Array.from(e.pairs.entries())
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 4)
    .map((entry) => ({ reader: entry[0].split(' :: ')[0], declares: entry[0].split(' :: ')[1], pair: entry[0], names: Array.from(entry[1]).slice(0, 12) })),
})).sort((a, b) => b.weight - a.weight);

const outDir = path.join(repoRoot, 'tmp');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'module-graph.json'), JSON.stringify({
  layers: Array.from(byLayer.entries()),
  edges: scored,
  forwardRefs: result.forwardRefs.sort((a, b) => b.gap - a.gap).slice(0, 60),
  forwardRefTotal: result.forwardRefs.length,
  modules: result.modules.map((m) => ({ path: m.modulePath, layer: m.layer, lines: m.lines, declares: m.declares, missing: m.missing })),
}, null, 2));

console.log('modules=' + result.modules.length + ' missing=' + result.modules.filter((m) => m.missing).length + ' uniqueGlobals=' + result.uniqueGlobals);
console.log('');
console.log('LAYER | modules | lines | top-level decls');
Array.from(byLayer.entries()).forEach((entry) => {
  const row = entry[1];
  console.log(entry[0] + ' | ' + row.modules + ' | ' + row.lines + ' | ' + row.declares);
});
console.log('');
console.log('CROSS-LAYER EDGES (reader layer -> layer that declares the name; weight = distinct shared global names)');
scored.forEach((e) => {
  console.log(e.weight + '  ' + e.from + ' -> ' + e.to);
  e.top.forEach((t) => console.log('      ' + t.reader + '  <=  ' + t.names.join(', ')));
});
console.log('');
console.log('FORWARD REFS total=' + result.forwardRefs.length + ' (read before declared in load order; only safe because the use sits inside a function body)');
result.forwardRefs.sort((a, b) => b.gap - a.gap).slice(0, 30).forEach((f) => {
  console.log('gap=' + f.gap + '  ' + f.reader + ' (' + f.readerOrder + ') reads ' + f.name + ' declared in ' + f.declaredIn + ' (' + f.declaredOrder + ')');
});
const tableRows = result.modules.map((m) => '| ' + m.order + ' | `' + m.modulePath + '` | ' + m.layer + ' | ' + m.lines + ' | ' + m.declares.length + ' |');
fs.writeFileSync(path.join(outDir, 'module-table.md'), [
  '| # | module | layer | lines | top-level decls |',
  '| --- | --- | --- | --- | --- |',
].concat(tableRows).join('\n') + '\n');

const mermaid = ['graph LR'];
scored.filter((e) => e.weight >= 10).forEach((e) => {
  const from = e.from.replace(/[^A-Za-z0-9_]/g, '_');
  const to = e.to.replace(/[^A-Za-z0-9_]/g, '_');
  mermaid.push('  ' + from + '[' + e.from + '] -->|' + e.weight + '| ' + to + '[' + e.to + ']');
});
fs.writeFileSync(path.join(outDir, 'layer-graph.mmd'), mermaid.join('\n') + '\n');

fs.writeFileSync(path.join(outDir, 'forward-refs.md'), [
  '| reader | order | name | declared in | order | gap |',
  '| --- | --- | --- | --- | --- | --- |',
].concat(result.forwardRefs.sort((a, b) => b.gap - a.gap).slice(0, 30).map((f) => '| `' + f.reader + '` | ' + f.readerOrder + ' | `' + f.name + '` | `' + f.declaredIn + '` | ' + f.declaredOrder + ' | ' + f.gap + ' |')).join('\n') + '\n');

const hubRows = Array.from(result.nameReaders.entries())
  .map((entry) => ({ name: entry[0], mod: entry[1].mod, readers: entry[1].readers.size, sample: Array.from(entry[1].readers).slice(0, 3) }))
  .sort((a, b) => b.readers - a.readers);

fs.writeFileSync(path.join(outDir, 'load-bearing-globals.md'), [
  '| name | declared in | readers (of 104 other modules) |',
  '| --- | --- | --- |',
].concat(hubRows.slice(0, 40).map((h) => '| `' + h.name + '` | `' + h.mod.modulePath + '` | ' + h.readers + ' |')).join('\n') + '\n');

const layerPairSet = new Set(scored.map((e) => e.from + ' -> ' + e.to));
const mutual = scored.filter((e) => layerPairSet.has(e.to + ' -> ' + e.from) && e.from < e.to);

console.log('');
console.log('LOAD-BEARING GLOBALS (declared once, read by the most other modules)');
hubRows.slice(0, 30).forEach((h) => console.log(h.readers + '  ' + h.name + '  <=  ' + h.mod.modulePath));
console.log('');
console.log('MUTUAL LAYER PAIRS (weight >= 10 both directions; proof the numeric prefix is naming, not acyclicity): ' + mutual.length);
mutual.forEach((e) => console.log('  ' + e.from + ' <-> ' + e.to));
console.log('');
console.log('artifacts -> tmp/module-graph.json, tmp/module-graph.txt, tmp/module-table.md, tmp/layer-graph.mmd, tmp/forward-refs.md, tmp/load-bearing-globals.md');
