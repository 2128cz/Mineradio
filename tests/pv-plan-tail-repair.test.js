'use strict';

// Acceptance for the PV lyric-tail repair (repairPlanTails in pv-planner.js).
//
// The defect it exists for: JIZURA caps a lyric line's on-screen time by character count
// (vendor/jizura/jizura-engine.js:2995) and packs the line's shots into that window, so a line
// sung longer than chars*0.5+1.2 loses its tail - the shots run out, then background or a static
// title card until the next line. Sweep of the local archive cache before the fix: 271 lines with
// at least 0.3 s of dead tail (~780 s over 109 songs); after: 56, and every one of those 56 is a
// line the platform only timed to 12 s, which is the intended limit.
//
// What these tests pin down is therefore not "the tail grew" but the four invariants the growth
// must not break: the line still cannot eat the next line's time, a tail card cannot be erased or
// emptied (cut count and cut.index must survive, because the transition pass reads
// plan.cuts[cut.index - 1]), the shot order must stay sorted for J.cutAt's binary search, and a
// line must be repaired whole or not at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const { repairPlanTails } = require('../pv-planner');

// A two-line plan in the shape the renderer consumes: one short line whose shots end early, and
// the next line starting where the first one is allowed to reach.
function fixture(options) {
  const opts = options || {};
  const tailCard = opts.tailCard !== false;
  const cuts = [
    { index: 0, line: 0, layout: 'thirds', text: '夜色', start: 0, end: 1.8, dur: 1.8, inDur: 0.34, hold: 'stretchPulse' },
    { index: 1, line: 0, layout: 'stack', text: '把楼顶的灯', start: 1.8, end: 3.7, dur: 1.9, inDur: 0.28, hold: 'drift' },
  ];
  if (tailCard) {
    cuts.push({ index: 2, line: 0, layout: 'interlude', text: '测试曲目', start: 3.7, end: 16, dur: 12.3, inDur: 0.3, hold: 'still' });
  }
  cuts.push({ index: cuts.length, line: 1, layout: 'thirds', text: '谁在广播里', start: 16, end: 20.4, dur: 4.4, inDur: 0.3, hold: 'still' });
  return {
    duration: 30,
    lines: [
      { index: 0, start: 0, end: opts.lineEnd != null ? opts.lineEnd : 16, visEnd: opts.visEnd != null ? opts.visEnd : 3.7, text: '夜色把楼顶的灯', interlude: false },
      { index: 1, start: 16, end: 20.4, visEnd: 20.4, text: '谁在广播里念我们的名字', interlude: false },
    ],
    cuts,
  };
}

function shapeOf(plan) {
  return plan.cuts.map((cut) => ({ index: cut.index, line: cut.line, layout: cut.layout, text: cut.text, inDur: cut.inDur, hold: cut.hold, start: cut.start, end: cut.end, dur: cut.dur }));
}

function assertCoherent(plan, label) {
  const lines = plan.lines;
  for (let i = 1; i < plan.cuts.length; i++) {
    assert.ok(plan.cuts[i].start >= plan.cuts[i - 1].start, `${label}: cuts unsorted at ${i}`);
  }
  for (const cut of plan.cuts) {
    assert.ok(cut.end - cut.start >= 0.22 - 1e-6, `${label}: cut ${cut.index} collapsed below the engine floor`);
    assert.ok(Math.abs(cut.dur - (cut.end - cut.start)) < 1e-3, `${label}: cut ${cut.index} dur no longer matches its bounds`);
    const line = lines[cut.line];
    if (!line) continue;   // the opening title shot carries line: -1
    assert.ok(cut.start >= line.start - 1e-6, `${label}: cut ${cut.index} starts before its line`);
    assert.ok(cut.end <= line.end + 1e-6, `${label}: cut ${cut.index} runs past its line end`);
  }
}

test('a line whose shots end early is stretched onto the end the caller knows', () => {
  const plan = fixture();
  const report = repairPlanTails(plan, [12]);
  assert.equal(report.repairedLines, 1);
  assert.equal(report.stretchedCuts, 2);
  assertCoherent(plan, 'stretched');

  const [first, second, card] = plan.cuts;
  assert.equal(second.end, 12, 'the last shot of the line must reach the real end');
  assert.equal(card.start, 12, 'the tail card slides to where the lyric stops, it is not deleted');
  assert.equal(card.end, 16, 'the card stays anchored to the next line start');
  assert.ok(first.start === 0, 'the line still begins on its own timestamp');
  assert.equal(second.start, first.end, 'adjacent shots abut exactly, as the engine builds them');
  assert.equal(plan.lines[0].visEnd, 12, 'the plan must not keep advertising the old window');
});

test('the next line is never eaten, however large the reported end is', () => {
  const plan = fixture();
  repairPlanTails(plan, [9999]);
  assertCoherent(plan, 'oversized end');
  assert.equal(plan.cuts[2].end, 16);
  assert.equal(plan.cuts[3].start, 16, 'the following line starts exactly where it did');
  assert.ok(plan.cuts[2].start <= 16 - 0.22, 'the card keeps the engine floor instead of vanishing');
});

test('a real plan whose card sits on the floor is repaired whole, not half', () => {
  // The regression the pre-flight exists for: measured bounds from lyrics-v1-0ad84418e2baa583,
  // line 44. target lands 0.22 s below the card end, and 238.35 - 238.13 is 0.21999999999999886 in
  // binary seconds, so a per-cut test rejected the card while the three shots before it had
  // already moved past it - leaving plan.cuts unsorted, which validateArchive rejects outright.
  const plan = {
    duration: 246,
    lines: [
      { index: 44, start: 226.73, end: 238.35, visEnd: 230.42999999999998, text: '愛を叶えて', interlude: false },
      { index: 45, start: 238.35, end: 243.1, visEnd: 243.1, text: 'いちめんのひかりに', interlude: false },
    ],
    cuts: [
      { index: 0, line: 44, layout: 'curtain', start: 226.73, end: 227.7296247654784, dur: 0.9996247654784, inDur: 0.3 },
      { index: 1, line: 44, layout: 'kanjiFocus', start: 227.7296247654784, end: 229.00692307692304, dur: 1.27729831144464, inDur: 0.3 },
      { index: 2, line: 44, layout: 'kanjiFocus', start: 229.00692307692304, end: 230.42999999999998, dur: 1.4230769230769, inDur: 0.3 },
      { index: 3, line: 44, layout: 'interlude', start: 230.42999999999998, end: 238.35, dur: 7.92, inDur: 0.3 },
      { index: 4, line: 45, layout: 'curtain', start: 238.35, end: 243.1, dur: 4.75, inDur: 0.3 },
    ],
  };
  const report = repairPlanTails(plan, [238.35, 243.1]);
  assert.equal(report.repairedLines, 1);
  assert.equal(report.movedTailCards, 1, 'the card moved with its line instead of being left behind');
  assertCoherent(plan, 'card on the floor');
  assert.equal(plan.cuts[4].start, 238.35, 'the following line is untouched');
});

test('a small gain is left alone and nothing is rewritten', () => {
  const plan = fixture({ visEnd: 3.6, lineEnd: 3.8 });
  const before = shapeOf(plan);
  const report = repairPlanTails(plan, [3.8]);
  assert.equal(report.repairedLines, 0);
  assert.deepEqual(shapeOf(plan), before, 'under the threshold the plan must be byte-identical');
});

test('choreography fields survive; only the bounds move', () => {
  const plan = fixture();
  const before = shapeOf(plan);
  repairPlanTails(plan, [12]);
  assert.equal(plan.cuts.length, before.length, 'repairing must not add or drop a shot');
  plan.cuts.forEach((cut, i) => {
    assert.equal(cut.index, before[i].index, 'cut.index must keep matching the array position');
    assert.equal(cut.layout, before[i].layout);
    assert.equal(cut.text, before[i].text);
    assert.equal(cut.hold, before[i].hold);
    assert.equal(cut.inDur, before[i].inDur, 'a line still enters at its own timestamp');
  });
});

test('a second pass is a no-op', () => {
  const plan = fixture();
  repairPlanTails(plan, [12]);
  const once = shapeOf(plan);
  const report = repairPlanTails(plan, [12]);
  assert.equal(report.repairedLines, 0);
  assert.deepEqual(shapeOf(plan), once);
});

test('without reported ends the engine line end is used, and the card still gets its floor', () => {
  const plan = fixture();
  const report = repairPlanTails(plan, null);
  assert.equal(report.repairedLines, 1);
  assertCoherent(plan, 'no lineEnds');
  assert.equal(plan.cuts[2].end, 16);
});

test('a line with no shots of its own is skipped, not planned from scratch', () => {
  const plan = fixture({ tailCard: false });
  plan.cuts = plan.cuts.filter((cut) => cut.line !== 0);
  const report = repairPlanTails(plan, [12]);
  assert.equal(report.repairedLines, 0);
  assert.ok(report.skippedLines >= 1);
});

test('malformed plans return a report instead of throwing', () => {
  assert.deepEqual(repairPlanTails(null, [1]).repairedLines, 0);
  assert.deepEqual(repairPlanTails({ lines: [], cuts: [] }, null).repairedLines, 0);
  const broken = fixture();
  broken.lines[0].visEnd = broken.lines[0].start;   // the division the guard protects
  const report = repairPlanTails(broken, [12]);
  assert.equal(report.repairedLines, 0);
  assert.equal(report.skippedLines, 2);
});
