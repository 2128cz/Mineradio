'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const prefetchSource = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '08-pv-prefetch.js'),
  'utf8',
);
const engineSource = fs.readFileSync(path.join(appRoot, 'vendor', 'jizura', 'jizura-engine.js'), 'utf8');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!declaration) return '';
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  if (bodyStart < 0) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  return '';
}

function loadPicker(windowSize) {
  const fn = namedFunctionSource(prefetchSource, 'pvAspectForViewport');
  assert.ok(fn, 'pvAspectForViewport() is missing from the prefetch module');
  const table = /var PV_ASPECT_RATIOS = \[[\s\S]*?\];/.exec(prefetchSource);
  assert.ok(table, 'the PV_ASPECT_RATIOS table is missing');
  const sandbox = { window: Object.assign({}, windowSize), Math };
  const loaded = vm.runInNewContext(
    `${table[0]}\n${fn}\n({ pick: pvAspectForViewport, table: PV_ASPECT_RATIOS })`,
    sandbox,
  );
  return { pick: loaded.pick, table: loaded.table, sandbox };
}

test('the viewport aspect picker lands each window shape on the layout the engine composes for it', () => {
  const { pick } = loadPicker({ innerWidth: 1920, innerHeight: 1080 });
  const cases = [
    [[2560, 1080], '21:9'],
    [[3440, 1440], '21:9'],
    [[1920, 1080], '16:9'],
    // 16:10 is nearer 16:9 than 4:3 on the log scale; a linear pick would drift it to 4:3.
    [[1920, 1200], '16:9'],
    [[1600, 900], '16:9'],
    [[1000, 800], '4:3'],
    [[900, 900], '1:1'],
    [[1080, 1350], '4:5'],
    [[900, 1200], '3:4'],
    [[720, 1280], '9:16'],
    [[1080, 1920], '9:16'],
  ];
  for (const [size, expected] of cases) {
    assert.equal(pick(size[0], size[1]), expected, `${size[0]}x${size[1]} should plan ${expected}`);
  }
});

test('an unusable viewport falls back to 16:9 instead of guessing from a zero ratio', () => {
  const { pick, sandbox } = loadPicker({ innerWidth: 0, innerHeight: 0 });
  assert.equal(pick(0, 0), '16:9');
  assert.equal(pick(), '16:9');
  assert.equal(pick(NaN, NaN), '16:9');
  // A window of 1x1 would read as ratio 1 and silently pick 1:1; it must stay on the default.
  sandbox.window = { innerWidth: 1, innerHeight: 1 };
  assert.equal(pick(), '16:9');
});

test('the table only offers aspects the vendored engine actually sizes and lays out', () => {
  const { table, pick } = loadPicker({ innerWidth: 1920, innerHeight: 1080 });
  const designSize = /J\.designSize = \(aspect\) => \{([\s\S]*?)\n\};/.exec(engineSource);
  assert.ok(designSize, 'J.designSize could not be found in the vendored engine');
  for (const entry of table) {
    const label = entry[0];
    if (label === '16:9') {
      // 16:9 is engineSource's fallback branch, so it is reached without a literal comparison.
      assert.match(designSize[1], /return \[1920, 1080\];/, 'the engine must keep 16:9 as its default size');
      continue;
    }
    assert.ok(designSize[1].includes(`aspect === '${label}'`),
      `the engine has no designSize branch for ${label}; a plan for it would silently be 16:9`);
  }
  // Every label must also be reachable, otherwise the table has a dead entry.
  for (const entry of table) {
    assert.equal(pick(Math.round(entry[1] * 900), 900), entry[0],
      `${entry[0]} must be picked when the window has exactly its ratio`);
  }
});

test('with the plan chosen for the window, covering never crops past the cap, so no bars appear', () => {
  const { pick } = loadPicker({ innerWidth: 1920, innerHeight: 1080 });
  // The cap lives in the render module; read it from there so the two cannot drift apart.
  const renderSource = fs.readFileSync(
    path.join(appRoot, 'public', 'js', 'modules', '02-visual', '17-pv-preset.js'),
    'utf8',
  );
  const cap = Number(/var PV_MAX_COVER_CROP = ([\d.]+);/.exec(renderSource)[1]);
  assert.ok(cap > 0, 'the render module must publish its cover crop cap');
  const designSize = vm.runInNewContext(`(${/J\.designSize = (\(aspect\) => \{[\s\S]*?\});/.exec(engineSource)[1]})`);
  assert.equal(designSize('16:9').join('x'), '1920x1080');

  const failures = [];
  for (let ratio = 0.5; ratio <= 2.5; ratio += 0.005) {
    const width = Math.round(ratio * 1000), height = 1000;
    const aspect = pick(width, height);
    const [W, H] = designSize(aspect);
    const cover = Math.max(width / W, height / H);
    const crop = Math.max(1 - width / (W * cover), 1 - height / (H * cover));
    if (crop > cap) failures.push({ ratio: Math.round(ratio * 100) / 100, aspect: aspect, crop: Math.round(crop * 1000) / 1000 });
  }
  // Any ratio that still needs bars must be named, not averaged away.
  assert.deepEqual(failures.slice(0, 6), [], `${failures.length} window shapes between 0.5 and 2.5 would still get bars`);
});

test('the recipe asks the viewport instead of hardcoding a shape', () => {
  assert.match(prefetchSource, /aspect: pvAspectForViewport\(\),/,
    'pvRecipeForSong must take the aspect from the viewport; a hardcoded 16:9 letterboxes every other window');
  // The archive key carries aspect (pv-archive.js REQUIRED_HEADER), so switching shape re-plans
  // rather than reusing a plan drawn for a different frame.
  const archiveSource = fs.readFileSync(path.join(appRoot, 'pv-archive.js'), 'utf8');
  assert.match(archiveSource, /REQUIRED_HEADER = \[[^\]]*'aspect'[^\]]*\]/,
    'the archive key must keep aspect, or a resized window would reuse a plan built for the old shape');
});
