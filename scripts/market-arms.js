'use strict';

// The arms for the rhythm market that need the SHIPPED text handed in, so a mutation driver can
// run them on a broken copy of a file instead of on the repository. An arm that cannot be made to
// fail is an arm that proves nothing, and the shipped files must not be edited to find that out.
//
// Every arm takes a `fail(message)` callback and returns nothing; a clean run calls it zero times.

// Top-level declarations of one module. The loader concatenates every module into ONE script, so
// this is the bundle's only namespace: a data declaration in a later module silently overwrites a
// function declared earlier, and the call site then throws "X is not a function" every frame.
// The scan is deliberately line-anchored (column 0 only) - it cannot see a declaration split
// across lines, which is a missed report, never a false one.
function declarations(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^\s/.test(line)) continue;
    let m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (m) { out.push({ name: m[1], kind: 'function' }); continue; }
    m = /^class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) { out.push({ name: m[1], kind: 'class' }); continue; }
    m = /^(var|let|const)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (!m) continue;
    out.push({ name: m[2], kind: m[1] });
    const rest = line.slice(m[0].length);
    const more = /,\s*([A-Za-z_$][\w$]*)\s*=/g;
    let mm;
    while ((mm = more.exec(rest))) out.push({ name: mm[1], kind: m[1] });
  }
  return out;
}

// One name, one module. Two modules declaring the same top-level name is the shape that cost a
// whole debugging session 634 uncaught TypeErrors per second while every static check stayed
// green: `var marketScratch` in 03-beat/07 silently replaced `function marketScratch` in
// 02-visual/21, because 03-beat loads after 02-visual.
function checkSingleOwner(moduleTexts, fail) {
  const owner = new Map();
  for (const { rel, text } of moduleTexts) {
    for (const d of declarations(text)) {
      if (!owner.has(d.name)) owner.set(d.name, []);
      owner.get(d.name).push({ rel, kind: d.kind });
    }
  }
  let collisions = 0;
  for (const [name, list] of owner) {
    const rels = [...new Set(list.map((x) => x.rel))];
    if (rels.length < 2) continue;
    collisions += 1;
    fail(`the top-level name ${name} is declared by ${rels.length} modules (${list.map((x) => x.kind + ' in ' + x.rel).join(', ')}). `
      + 'The loader concatenates every module into one script, so the later declaration wins and the earlier one is gone');
  }
  return collisions;
}

// The knob schema, one entry per line. rebuild is always present, so a missing rebuild is caught
// by the count rather than silently defaulted.
function parseMarketSchema(text) {
  const schema = new Map();
  const re = /^\s*(\w+):\s*\{\s*def:\s*(-?[\d.]+),\s*min:\s*(-?[\d.]+),\s*max:\s*(-?[\d.]+),\s*kind:\s*'(\w+)',\s*rebuild:\s*'(\w+)'\s*\}/gm;
  let m;
  while ((m = re.exec(String(text || '')))) {
    schema.set(m[1], { def: Number(m[2]), min: Number(m[3]), max: Number(m[4]), kind: m[5], rebuild: m[6] });
  }
  return schema;
}

const REBUILD_KINDS = ['series', 'chart', 'wall', 'live'];

// Every knob needs four things that can disagree with each other: the schema entry, a read point
// in the module that draws, an element in index.html that writes it, and a row in the console
// group that finds that element. This arm checks all four, plus that the store dispatches the
// rebuild kind - a knob whose rebuild kind the store does not know moves the slider and changes
// nothing on screen, which is the exact defect the user reported on the black hole.
function checkKnobWiring({ presetRel, presetText, tuningText, htmlText, consoleText, fail }) {
  const schema = parseMarketSchema(presetText);
  if (schema.size < 30) {
    fail(`the market knob schema in ${presetRel} must be complete (found ${schema.size} knobs, expected at least 30)`);
    return schema;
  }
  let bools = 0;
  for (const [key, spec] of schema) {
    if (REBUILD_KINDS.indexOf(spec.rebuild) < 0) {
      fail(`the market knob ${key} declares rebuild '${spec.rebuild}', which is not one of ${REBUILD_KINDS.join('/')}`);
    }
    if (!tuningText.includes(`'${spec.rebuild}'`)) {
      fail(`the market knob store never dispatches rebuild '${spec.rebuild}' (${key} would only take effect on a preset switch)`);
    }
    // A knob with no read point is a console row that writes a value nothing consumes.
    if (!presetText.includes(`marketParam('${key}')`) && !presetText.includes(`MARKET_TUNING_SCHEMA.${key}`) && !presetText.includes(`MARKET_TUNING_SCHEMA['${key}']`)) {
      fail(`the market knob ${key} has no read point in ${presetRel}: the console writes a value nothing consumes`);
    }
    if (spec.kind === 'bool') {
      bools += 1;
      const toggleId = 't-mk' + key;
      const toggle = new RegExp('class="fx-toggle" id="' + toggleId + '"[^>]*onclick="toggleMarketTuning\\(\'' + key + '\'\\)"');
      if (!toggle.test(htmlText)) {
        fail(`the bool knob ${key} has no .fx-toggle (${toggleId} calling toggleMarketTuning('${key}')) in index.html`);
      }
      if (!tuningText.includes(`document.getElementById('t-mk' + key)`)) {
        fail(`the market knob store must write a bool's state back into its switch, or the console and the chart disagree after a load (${key})`);
      }
      if (!tuningText.includes('function toggleMarketTuning(')) {
        fail('the market bool knobs need their own setter: a slider writes a value, a switch has to flip one');
      }
      if (!consoleText.includes(`fxConsoleItem('${toggleId}'`)) {
        fail(`the bool knob ${key} must be listed in the console's 节奏股市 group as ${toggleId}`);
      }
      continue;
    }
    const id = 'fx-mk' + key;
    const slider = new RegExp('id="' + id + '"[^>]*min="(-?[\\d.]+)"[^>]*max="(-?[\\d.]+)"').exec(htmlText);
    if (!slider) {
      fail(`the market knob ${key} has no slider (${id}) in index.html`);
      continue;
    }
    if (Number(slider[1]) !== spec.min || Number(slider[2]) !== spec.max) {
      fail(`the slider ${id} must run from ${spec.min} to ${spec.max} (found ${slider[1]}..${slider[2]})`);
    }
    if (!htmlText.includes(`setMarketTuning('${key}', this.value)`)) {
      fail(`the slider ${id} must call setMarketTuning('${key}')`);
    }
    // The per-knob reset is appended to the row, so a slider outside a .fx-slider row has no row
    // to carry its button.
    const at = htmlText.indexOf('id="' + id + '"');
    const rowStart = htmlText.lastIndexOf('class="fx-slider"', at);
    if (rowStart < 0 || htmlText.slice(rowStart, at).indexOf('</div>') >= 0) {
      fail(`the slider ${id} must sit inside its .fx-slider row, or it carries no reset button`);
    }
    if (!consoleText.includes(`fxConsoleItem('${id}'`)) {
      fail(`the knob ${key} must be listed in the console's 节奏股市 group`);
    }
  }
  const controls = (htmlText.match(/id="fx-mk[A-Za-z]+"/g) || []).length
    + (htmlText.match(/id="t-mk[A-Za-z]+"/g) || []).length;
  if (controls !== schema.size) {
    fail(`the market controls in index.html (${controls}: ${schema.size - bools} sliders + ${bools} switches) must match the knob schema (${schema.size})`);
  }
  return schema;
}

module.exports = { declarations, checkSingleOwner, parseMarketSchema, checkKnobWiring, REBUILD_KINDS };
