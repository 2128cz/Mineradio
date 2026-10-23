'use strict';

// The bench trades on options the vendored engine reads off the `opt` argument of
// J.Renderer.frame(). Nothing in the app enforces that those option names still exist, so a
// vendor bump that renames one would silently turn a quality tier into a no-op: same tier name,
// no savings, no failure. These guards pin each knob to the engine source it is supposed to
// switch off, and prove a rename is caught rather than ignored.

const assert = require('assert');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const bench = require('../scripts/pv-draw-bench.js');
const benchSource = fs.readFileSync(path.join(root, 'scripts', 'pv-draw-bench.js'), 'utf8');

const ENGINE = fs.readFileSync(path.join(root, 'vendor', 'jizura', 'jizura-engine.js'), 'utf8');

test('every bench knob is still the option the vendored engine reads', () => {
  assert.ok(bench.PV_ENGINE_KNOBS.length >= 5, 'the knob list shrank');
  const names = bench.PV_ENGINE_KNOBS.map((k) => k.name);
  assert.strictEqual(new Set(names).size, names.length, 'knob names must be unique');
  for (const knob of bench.PV_ENGINE_KNOBS) {
    assert.ok(knob.kills.length > 8, `${knob.name} must say what it switches off`);
    assert.ok(knob.pattern instanceof RegExp, `${knob.name} needs a pattern`);
    assert.ok(ENGINE.match(knob.pattern),
      `${knob.name}: the engine no longer reads opt.${knob.name} where the bench expects`);
  }
});

test('a renamed knob fails the guard instead of quietly doing nothing', () => {
  const first = bench.PV_ENGINE_KNOBS[0];
  const mutated = ENGINE.replace(first.pattern, 'this.filterOK && !opt.renamedAway');
  assert.ok(mutated !== ENGINE, 'the mutation did not apply');
  assert.ok(!mutated.match(first.pattern), 'guard must miss a renamed option');
});

test('every default phase maps to a runner, and composed tiers reuse known knobs', () => {
  const runners = benchSource.slice(benchSource.indexOf('const runners = {'), benchSource.indexOf('const pct ='));
  assert.ok(runners.length > 200, 'could not locate the runner table');
  for (const phase of bench.parseArgs([]).phases) {
    assert.ok(runners.includes(`\n    ${phase}: (`), `${phase} is a default phase but has no runner`);
  }
  const used = new Set();
  for (const phase of ['fastNoTrans', 'fastNoGhost', 'cheap']) {
    const hit = runners.match(new RegExp(`${phase}: \\(t\\) => renderer\\.frame\\(ctx, plan, t, \\{ scale,([^}]*)\\}\\)`));
    assert.ok(hit, `${phase} options are not parseable`);
    for (const part of hit[1].split(',')) {
      const name = part.trim().split(':')[0].trim();
      if (!name) continue;
      assert.ok(bench.PV_ENGINE_KNOBS.some((k) => k.name === name), `${phase} uses unknown knob ${name}`);
      used.add(name);
    }
  }
  assert.ok(used.has('fast') && used.has('noTrans') && used.has('noGhost'),
    'the composed tiers must reuse the single-option knobs');
});

test('the bench never writes into the app: only into its own temp scratch', () => {
  assert.match(benchSource, /path\.join\(os\.tmpdir\(\), 'mineradio-pv-draw-bench'\)/);
  assert.ok(!/fs\.writeFileSync\(path\.join\(appRoot/.test(benchSource), 'bench must not write into the repo');
  assert.ok(!/requestSingleInstanceLock/.test(benchSource), 'bench must not claim the app instance lock');
});

test('the bench starts when electron runs it, where require.main is not the entry module', () => {
  // require.main.filename is 'electron' in an Electron main process, so a `require.main === module`
  // guard alone leaves the bench as an app that opens no window and never exits.
  assert.match(benchSource, /path\.resolve\(process\.argv\[1\]\) === path\.resolve\(__filename\)/);
  assert.match(benchSource, /if \(invokedDirectly \|\| require\.main === module\)/);
  assert.match(benchSource, /app\.exit\(/);
});

test('resolveCacheDir follows --cache, then MINERADIO_PV_CACHE_DIR, then the app cache', () => {
  const tmp = path.join(os.tmpdir(), 'pv-bench-cache-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  const appdata = path.join(tmp, 'Roaming');
  const previousAppdata = process.env.APPDATA;
  const previousEnv = process.env.MINERADIO_PV_CACHE_DIR;
  try {
    process.env.APPDATA = appdata;
    delete process.env.MINERADIO_PV_CACHE_DIR;

    const explicit = path.join(tmp, 'explicit');
    fs.mkdirSync(explicit);
    assert.strictEqual(bench.resolveCacheDir(explicit), explicit, 'an existing --cache wins');

    const fromEnv = path.join(tmp, 'from-env');
    fs.mkdirSync(fromEnv);
    process.env.MINERADIO_PV_CACHE_DIR = fromEnv;
    assert.strictEqual(bench.resolveCacheDir(path.join(tmp, 'missing')), fromEnv,
      'a missing --cache falls through to the environment');

    process.env.MINERADIO_PV_CACHE_DIR = path.join(tmp, 'missing-env');
    const userDataCache = path.join(appdata, 'Mineradio', 'cache', 'pvs');
    fs.mkdirSync(userDataCache, { recursive: true });
    assert.strictEqual(bench.resolveCacheDir(), userDataCache, 'falls back to the userData cache');

    fs.rmSync(userDataCache, { recursive: true, force: true });
    assert.throws(() => bench.resolveCacheDir(), (err) => err.code === 'PV_BENCH_NO_CACHE',
      'a machine with no PV cache must fail by name, not draw an empty table');
  } finally {
    if (previousAppdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppdata;
    if (previousEnv === undefined) delete process.env.MINERADIO_PV_CACHE_DIR; else process.env.MINERADIO_PV_CACHE_DIR = previousEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseArgs turns the CLI into boxes, dprs and phases', () => {
  const args = bench.parseArgs([
    '--plan=a.json', '--sizes=2160x1620,960x720', '--dprs=1,1.5',
    '--phases=full,fastNoTrans', '--samples=40', '--limit=3',
  ]);
  assert.strictEqual(args.plan, 'a.json');
  assert.deepStrictEqual(args.sizes, [[2160, 1620], [960, 720]]);
  assert.deepStrictEqual(args.dprs, [1, 1.5]);
  assert.deepStrictEqual(args.phases, ['full', 'fastNoTrans']);
  assert.strictEqual(args.samples, 40);
  assert.strictEqual(args.limit, 3);
  assert.strictEqual(args.markdown, false);
  const dflt = bench.parseArgs([]);
  assert.deepStrictEqual(dflt.sizes, [[1280, 720], [1920, 1080]]);
  assert.strictEqual(dflt.samples, 120);
});

test('toMarkdown renders one comparable table per sweep', () => {
  const md = bench.toMarkdown([{
    ok: true,
    label: 'archive.json',
    box: { cssW: 1920, cssH: 1080, dpr: 1, canvasW: 1920, canvasH: 1440, pixels: 2764800, warmH: 240, bleedW: 240, bleedH: 135 },
    plan: { cuts: 312, lines: 100, events: 708, duration: 329.31, design: '1440x1080' },
    results: {
      full: { n: 120, mean: 9.11, p50: 8.2, p95: 20.3, p99: 30.1, max: 60.2, overFrame: 12, overKoma: 0, transitionMean: 14.8, plainMean: 7.6 },
      fastNoTrans: { n: 120, mean: 1.97, p50: 1.8, p95: 6.0, p99: 9.4, max: 13.1, overFrame: 0, overKoma: 0, transitionMean: 3.1, plainMean: 1.7 },
      broken: { error: 'UNKNOWN_PHASE' },
    },
  }, { ok: false, label: 'bad.json', error: 'NO_PLAN' }]);
  assert.match(md, /### archive\.json — 1920x1080 @ dpr 1/);
  assert.match(md, /312 镜头 \/ 100 行 \/ 708 事件/);
  assert.match(md, /^\| full \| 9\.11 \|.+\| 12\/120 \|.+\| — \|$/m);
  assert.match(md, /^\| fastNoTrans \| 1\.97 \|.+\| 0\/120 \|.+\| \d+% \|$/m);
  assert.match(md, /\| broken \| UNKNOWN_PHASE \|/);
  assert.match(md, /bad\.json: NO_PLAN/);
});
