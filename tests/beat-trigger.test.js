'use strict';

// 实时鼓点触发器的行为测试：长音不能一直驱动，必须按 BPM 网格点拍；稀疏鼓点靠上升沿，
// 掉到释放阈值以下才重新武装；密集鼓点不许乱跳。纯状态机，直接喂电平与时间。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const moduleText = fs.readFileSync(path.join(appRoot, 'public/js/modules/03-beat/07-beat-trigger.js'), 'utf8');
const sandbox = { console };
vm.runInNewContext(moduleText, sandbox);

const create = sandbox.beatTriggerCreate;
const step = sandbox.beatTriggerStep;
const reset = sandbox.beatTriggerReset;

assert.equal(typeof create, 'function');
assert.equal(typeof step, 'function');
assert.ok(sandbox.beatTriggerState, 'the main loop needs one shared latch state');

function feed(state, opts) {
  const dt = opts.dt == null ? 0.01 : opts.dt;
  const seconds = opts.seconds;
  const events = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const level = typeof opts.level === 'function' ? opts.level(state.time, i) : opts.level;
    const result = step(state, { level, bpm: opts.bpm, dt, strength: level });
    if (result.triggered) events.push(result);
  }
  return events;
}

// 1) 持续高电平：上升沿一次，之后按 BPM 点拍，而不是每帧都在驱动。
{
  const state = create();
  const events = feed(state, { level: 0.9, bpm: 120, seconds: 2.05 });
  assert.equal(events.length, 5, `a two second sine at 120 BPM must fire 5 times, got ${events.length}`);
  assert.equal(events[0].reason, 'edge', 'the first fire is the rising edge');
  assert.equal(events.filter(e => e.reason === 'grid').length, 4, 'the held level must be retriggered by the BPM grid');
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].time - events[i - 1].time;
    assert.ok(gap >= 0.27, `triggers must stay at least 55% of a beat apart, got ${gap}`);
  }
  assert.ok(Math.abs(events[events.length - 1].time - 2.0) < 0.02, 'the last grid beat sits on 2.0 s');
}

// 2) 掉到释放阈值以下就重新武装，下一次上升沿可以提前触发（不用等网格）。
{
  const state = create();
  assert.equal(state.armed, true);
  let events = feed(state, { level: 0.9, bpm: 60, seconds: 0.12 });
  assert.equal(events.length, 1);
  assert.equal(state.armed, false, 'a trigger disarms the latch until the level falls');
  events = feed(state, { level: 0.10, bpm: 60, seconds: 0.30 });
  assert.equal(events.length, 0, 'a low level must not trigger');
  assert.equal(state.armed, true, 'the falling edge re-arms the latch');
  events = feed(state, { level: 0.9, bpm: 60, seconds: 0.30 });
  assert.equal(events.length, 1, 'the next rising edge fires again');
  assert.equal(events[0].reason, 'edge');
  assert.ok(events[0].time > 0.5, 'the minimum gap still applies');
}

// 3) 密集鼓点（约 8 次/秒）被压到 BPM 节奏，不跟着每个边缘乱跳。
{
  const state = create();
  const events = feed(state, {
    bpm: 120,
    seconds: 2.0,
    level: t => (Math.floor(t / 0.06) % 2 === 0 ? 0.92 : 0.08)
  });
  assert.ok(events.length >= 4 && events.length <= 8, `dense kicks must settle on the tempo, got ${events.length} fires`);
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].time - events[i - 1].time;
    assert.ok(gap >= 0.27, `dense kicks must not thrash: ${gap} s apart`);
  }
}

// 4) BPM 变化会重排网格，不用等旧的格子走完。
{
  const state = create();
  feed(state, { level: 0.9, bpm: 120, seconds: 1.02 });
  const before = state.triggers;
  let changedAt = 0;
  let events = [];
  for (let i = 0; i < 80; i++) {
    const result = step(state, { level: 0.9, bpm: 180, dt: 0.01, strength: 0.9 });
    if (i === 0) changedAt = state.time;
    if (result.triggered) events.push(result);
  }
  assert.equal(state.bpm, 180);
  assert.ok(state.triggers > before);
  assert.ok(events[0].time - changedAt <= 0.35, 'the first 180 BPM beat arrives within one new interval');
}

// 5) 低于释放阈值的持续底噪永远不会触发。
{
  const state = create();
  const events = feed(state, { level: 0.3, bpm: 128, seconds: 2.0 });
  assert.equal(events.length, 0, 'sub-threshold noise must stay silent');
}

// 6) 重置清空武装/网格/计数，换曲或暂停后不会继承上一首的相位。
{
  const state = create();
  feed(state, { level: 0.9, bpm: 120, seconds: 1.0 });
  assert.ok(state.triggers > 0);
  reset(state);
  assert.equal(state.triggers, 0);
  assert.equal(state.armed, true);
  assert.equal(state.lastTriggerAt, -1);
  assert.equal(state.nextGridAt, state.interval);
  assert.equal(state.bpm, 120);
}

// 7) 接线：主循环用触发器喂 beatPulse / beatOnsetFlag，旧的连续 rtPulse 已经移除；
//    引擎重置时清触发器；模块由 loader 加进同一全局作用域。
const loopText = fs.readFileSync(path.join(appRoot, 'public/js/modules/11-main-loop.js'), 'utf8');
const runtimeText = fs.readFileSync(path.join(appRoot, 'public/js/modules/01-scene/02-beat-camera-runtime.js'), 'utf8');
const loaderText = fs.readFileSync(path.join(appRoot, 'public/js/index-loader.js'), 'utf8');
assert.match(loopText, /stepLiveBeatTrigger\(realtimeBeat, audioStepDt\)/);
assert.match(loopText, /beatOnsetFlag = true;\s*\n\s*beatPulse = Math\.max\(beatPulse, Math\.min\(dj \? 0\.42 : 0\.78, liveTrigger\.pulse\)\)/);
assert.ok(!/var rtPulse =/.test(loopText), 'the continuous rtPulse feed must be gone: a held kick used to keep it alive');
assert.ok(!/rtPulse > beatPulse \+ 0\.09/.test(loopText), 'the old magnitude gate must be gone');
assert.match(loopText, /typeof beatTriggerReset === 'function'\) beatTriggerReset\(beatTriggerState\)/);
assert.match(runtimeText, /typeof beatTriggerReset === 'function'\) beatTriggerReset\(beatTriggerState\)/);
assert.ok(loaderText.indexOf("'js/modules/03-beat/07-beat-trigger.js'") >= 0, 'the trigger module must be loaded');
assert.ok(loaderText.indexOf("'js/modules/03-beat/07-beat-trigger.js'") < loaderText.indexOf("'js/modules/11-main-loop.js'"),
  'the module must load before the main loop that calls it');

console.log('OK beat-trigger: edge latch + BPM grid, dense kicks settle on the tempo');