'use strict';

// 预设 17 的歌词屏与走带：一句歌词被拆成连续的分组，组 g 在 start_g 到达读位；走带是单调连续的，
// 组在走带空间里固定、随时间向镜头移动。这些是纯函数，直接从模块里取出来跑。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '22-mixer-desk-preset.js'), 'utf8');

function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const end = src.indexOf('\n}\n', start) + 3;
  return src.slice(start, end);
}

const defaults = {};
for (const m of src.matchAll(/(\w+):\s*\{\s*def:\s*(-?[\d.]+),\s*min:\s*-?[\d.]+,\s*max:\s*-?[\d.]+/g)) {
  defaults[m[1]] = Number(m[2]);
}

const run = new Function('MIXER_PLACEHOLDER',
  fn('mixerClamp01') + '\n' + fn('mixerSmooth') + '\n' + fn('mixerLineText') + '\n'
  + fn('mixerLineClock') + '\n' + fn('mixerLineDuration') + '\n' + fn('mixerSplitGroups') + '\n'
  + fn('mixerGroupPlan') + '\n' + fn('mixerCarouselAt') + '\n' + fn('mixerPanelZ') + '\n'
  + fn('mixerPanelLift') + '\n' + fn('mixerPanelAlpha')
  + '\nreturn { mixerSplitGroups, mixerGroupPlan, mixerCarouselAt, mixerPanelZ, mixerPanelLift, mixerPanelAlpha };'
)(JSON.parse(src.match(/var MIXER_PLACEHOLDER = (\[[^\]]*\]);/)[1].replace(/'/g, '"')));

const opts = {
  charsPerPanel: defaults.charsPerPanel,
  maxGroupsPerLine: defaults.maxGroupsPerLine,
  panelMinGap: defaults.panelMinGap
};

// 1) splitting and plan shape
{
  assert.deepEqual(run.mixerSplitGroups('夜空中最亮的星', 2), ['夜空', '中最', '亮的', '星']);
  const long = '一二三四五六七八九十'.repeat(4); // 40 chars
  const plan = run.mixerGroupPlan([{ t: 10, duration: 4, text: long }],
    { charsPerPanel: 2, maxGroupsPerLine: 14, panelMinGap: 0.38 });
  assert.ok(plan.length <= 14, 'a dense line must widen its groups, not outrun the desk');
  assert.equal(plan[0].text.length, 3, 'wide groups are 3 chars for a 40-char line');
  assert.ok(plan.length <= 14, 'and still fit the per-line cap');
}
{
  const lines = [
    { t: 10, duration: 4, text: '夜空中最亮的星' },
    { t: 15, duration: 3, text: '请指引我靠近你' }
  ];
  const plan = run.mixerGroupPlan(lines, opts);
  assert.equal(plan[0].start, 10, 'the first group starts on the line timestamp');
  assert.equal(plan[0].text, '夜空');
  for (let i = 0; i < plan.length; i++) {
    assert.ok(plan[i].end >= plan[i].start, 'a group cannot end before it starts');
    assert.ok(plan[i].end - plan[i].start >= defaults.panelMinGap - 1e-9, 'every group lives at least panelMinGap');
    if (i) assert.ok(plan[i].start >= plan[i - 1].end - 1e-9, 'groups must not overlap');
  }
}

// 2) the carousel: monotone, arrives at each group on its start, continuous through gaps
{
  const plan = run.mixerGroupPlan([
    { t: 0, duration: 2, text: '一二三四' },
    { t: 10, duration: 2, text: '五六七八' }
  ], opts);
  let last = -1;
  let prev = -1;
  for (let t = 0; t <= 13; t += 0.05) {
    const c = run.mixerCarouselAt(plan, t, defaults.panelGlide);
    assert.ok(c >= last - 1e-9, 'the carousel never runs backwards');
    if (prev >= 0) assert.ok(c - prev < 0.2, 'the carousel stays continuous through a long gap');
    last = c;
    prev = c;
  }
  for (let g = 0; g < plan.length; g++) {
    assert.ok(Math.abs(run.mixerCarouselAt(plan, plan[g].start, defaults.panelGlide) - g) < 1e-6,
      'group ' + g + ' must reach the reading position on its start');
  }
  assert.ok(Math.abs(run.mixerCarouselAt(plan, 13, defaults.panelGlide) - plan.length) < 0.2,
    'after the last group the carousel settles at the end of the plan');
  assert.equal(run.mixerCarouselAt([], 5, 0.5), 0, 'an empty plan has no carousel');
}

// 3) panel placement and the look of the hand-over
{
  const pitch = defaults.bayPitch;
  const zRead = 0.15;
  assert.equal(run.mixerPanelZ(4, 4, pitch, zRead), zRead, 'a panel reaches the reading position when the carousel equals its group');
  assert.ok(run.mixerPanelZ(5, 4, pitch, zRead) < run.mixerPanelZ(4, 4, pitch, zRead), 'groups ahead sit further away');
  assert.equal(run.mixerPanelLift(0), 1, 'the panel is fully up at the reading position');
  assert.equal(run.mixerPanelLift(1.5), 0, 'and down once it is far away');
  assert.ok(run.mixerPanelLift(0.5) > run.mixerPanelLift(1.0), 'the lift rises as its turn comes');
  assert.equal(run.mixerPanelAlpha(0, defaults.panelAhead, defaults.panelBehind), 1);
  assert.equal(run.mixerPanelAlpha(defaults.panelAhead + 1, defaults.panelAhead, defaults.panelBehind), 0);
  assert.equal(run.mixerPanelAlpha(-(defaults.panelBehind + 1), defaults.panelAhead, defaults.panelBehind), 0);
}

// 4) the pool invariant the gate also pins
{
  const aheadMax = 5;
  const behindMax = 2;
  assert.ok(1 + aheadMax + behindMax <= 8, 'the panel pool must fit MIXER_PANELS');
  assert.equal(defaults.panelAhead <= 5, true);
  assert.equal(defaults.panelBehind <= 2, true);
}

console.log('OK mixer-schedule: ' + run.mixerGroupPlan([{ t: 10, duration: 4, text: '夜空中最亮的星' }], opts).length
  + ' panels for an 8-char line, carousel monotone and continuous, pool <= 8');
