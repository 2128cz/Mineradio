'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('visual performance controls are visible and persisted without reordering old MR2 fields', () => {
  const html = read('public/index.html');
  const defaults = read('public/js/modules/00-state/04-fx-defaults.js');
  const archive = read('public/js/modules/07-fx/00-preset-archive-data.js');
  const consoleLayout = read('public/js/modules/07-fx/09-console-workspace.js');
  const bindings = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
  const keys = [
    'lyricLiveViewportFit',
    'lyricContextHighQuality',
    'lyricBackdropAdapt',
    'coverBackdropAdapt',
  ];

  for (const key of keys) {
    assert.match(html, new RegExp(`id="t-${key}"`));
    assert.match(archive, new RegExp(`'${key}'`));
    assert.match(consoleLayout, new RegExp(`t-${key}`));
    assert.match(bindings, new RegExp(`reason: key`));
  }
  // Everything else on this panel starts on; the viewport fit is the one control that starts off,
  // because it is what scales a long lyric line down to the screen width. It has to stay switchable
  // and archived, and an archive that never carried the field must restore the new default.
  for (const key of keys.slice(1)) {
    assert.match(defaults, new RegExp(`${key}: true`));
    assert.match(archive, new RegExp(`${key}: raw\\.${key} !== false`));
  }
  assert.match(defaults, /lyricLiveViewportFit: false/);
  assert.match(archive, /lyricLiveViewportFit: raw\.lyricLiveViewportFit === true/);

  const oldTail = archive.indexOf("'lyricTextureClarity'");
  for (const key of keys) assert.ok(archive.indexOf(`'${key}'`) > oldTail, `${key} must stay append-only in MR2`);
});

test('disabled controls bypass the expensive lyric and particle paths', () => {
  const lyric = read('public/js/modules/02-visual/12-lyrics-row-layers.js');
  const uniforms = read('public/js/modules/07-fx/04-preset-grid-uniforms.js');
  const particles = read('public/js/modules/02-visual/00-pointer-cover-particles.js');

  assert.match(lyric, /fx\.lyricLiveViewportFit !== false\)\) \{\s*baseScale \*= lyricRowLiveViewportScale/);
  assert.match(lyric, /contextHighQualityEnabled \|\| isActive \|\| currentTranslation/);
  assert.match(lyric, /fx\.lyricBackdropAdapt !== false/);
  assert.match(uniforms, /fx\.coverBackdropAdapt !== false[\s\S]*?: 0;/);
  assert.ok((particles.match(/if \(backdropAdapt > 0\.001\)/g) || []).length >= 2);
});

