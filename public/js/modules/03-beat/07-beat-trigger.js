'use strict';

// 实时鼓点触发器：上升沿触发一次，必须掉到释放阈值以下才重新武装；同时按 BPM 网格
// 对持续高电平重新触发，所以一段长音不会把所有驱动元素一直点亮，而是按歌曲节奏点拍。
// 纯函数状态机，main loop 每帧喂入 low/profile 电平与 BPM，测试直接驱动。

var BEAT_TRIGGER_FALLBACK_BPM = 120;
var BEAT_TRIGGER_MIN_BPM = 40;
var BEAT_TRIGGER_MAX_BPM = 240;
var BEAT_TRIGGER_HIGH = 0.50;
var BEAT_TRIGGER_RELEASE = 0.34;
// 两次触发至少隔 BPM 间隔的 55%，挡住同一拍里的边缘重复与网格补拍。
var BEAT_TRIGGER_MIN_GAP_RATIO = 0.55;
// 网格即将到来时不再接受边缘，避免网格与边缘挤在一起。
var BEAT_TRIGGER_EDGE_WINDOW_RATIO = 0.30;
// BPM 跳变超过这个值就重排网格，防止缓慢漂移把网格一直往后推。
var BEAT_TRIGGER_BPM_SNAP = 2.5;

function beatTriggerCreate() {
  var interval = 60 / BEAT_TRIGGER_FALLBACK_BPM;
  return {
    time: 0,
    bpm: BEAT_TRIGGER_FALLBACK_BPM,
    interval: interval,
    armed: true,
    lastTriggerAt: -1,
    nextGridAt: interval,
    prevLevel: 0,
    level: 0,
    triggers: 0,
    gridTriggers: 0,
    edgeTriggers: 0,
    lastReason: ''
  };
}

function beatTriggerReset(state) {
  state = state || beatTriggerState;
  if (!state) return state;
  var fresh = beatTriggerCreate();
  for (var key in fresh) {
    if (Object.prototype.hasOwnProperty.call(fresh, key)) state[key] = fresh[key];
  }
  return state;
}

var beatTriggerState = beatTriggerCreate();

function beatTriggerClamp(value, min, max) {
  value = Number(value);
  if (!isFinite(value)) value = min;
  return Math.max(min, Math.min(max, value));
}

function beatTriggerStep(state, input) {
  state = state || beatTriggerState;
  input = input || {};
  var dt = beatTriggerClamp(input.dt == null ? 0.016 : input.dt, 0, 0.12);
  var high = beatTriggerClamp(input.high == null ? BEAT_TRIGGER_HIGH : input.high, 0.02, 0.98);
  var release = Math.min(high - 0.01, beatTriggerClamp(input.release == null ? BEAT_TRIGGER_RELEASE : input.release, 0, 0.97));
  var level = beatTriggerClamp(input.level, 0, 1);
  var strength = beatTriggerClamp(input.strength == null ? level : input.strength, 0, 1);
  var bpm = Number(input.bpm);
  if (!isFinite(bpm) || bpm <= 0) bpm = state.bpm;
  bpm = beatTriggerClamp(bpm, BEAT_TRIGGER_MIN_BPM, BEAT_TRIGGER_MAX_BPM);

  state.time += dt;
  state.prevLevel = state.level;
  state.level = level;

  if (Math.abs(bpm - state.bpm) >= BEAT_TRIGGER_BPM_SNAP) {
    state.bpm = bpm;
    state.interval = 60 / bpm;
    state.nextGridAt = state.time + state.interval;
  }
  var interval = state.interval;
  var minGap = interval * BEAT_TRIGGER_MIN_GAP_RATIO;
  var sinceTrigger = state.lastTriggerAt < 0 ? Infinity : state.time - state.lastTriggerAt;

  if (level < release) state.armed = true;

  var reason = '';
  if (state.time >= state.nextGridAt) {
    // 一帧最多走一格：卡顿后的长 dt 不能补放一串鼓点。
    state.nextGridAt += interval;
    if (state.nextGridAt <= state.time) state.nextGridAt = state.time + interval;
    if (level >= high && sinceTrigger >= minGap) reason = 'grid';
  }
  if (!reason && level >= high && state.armed && sinceTrigger >= minGap
    && state.nextGridAt - state.time > interval * BEAT_TRIGGER_EDGE_WINDOW_RATIO) {
    reason = 'edge';
  }

  if (!reason) {
    return {
      triggered: false,
      reason: '',
      level: level,
      strength: strength,
      bpm: state.bpm,
      interval: interval,
      time: state.time
    };
  }

  state.armed = false;
  state.lastTriggerAt = state.time;
  state.triggers++;
  if (reason === 'grid') state.gridTriggers++;
  else state.edgeTriggers++;
  state.lastReason = reason;
  return {
    triggered: true,
    reason: reason,
    level: level,
    strength: strength,
    pulse: beatTriggerClamp(0.30 + strength * 0.60, 0, 0.92),
    bpm: state.bpm,
    interval: interval,
    time: state.time
  };
}

// 实时引擎给出的 tempoGap 是最贴当前歌曲的 BPM；DJ 模式优先用它自己的锁。
function beatTriggerCurrentBpm() {
  if (typeof djMode !== 'undefined' && djMode && djMode.active && djMode.tempoGap > 0) {
    return 60 / djMode.tempoGap;
  }
  if (typeof rtBeat !== 'undefined' && rtBeat && rtBeat.tempoGap > 0) {
    return 60 / rtBeat.tempoGap;
  }
  return 0;
}

function beatTriggerLiveLevel(realtimeBeat) {
  if (!realtimeBeat) return 0;
  var low = Number(realtimeBeat.low);
  var score = Number(realtimeBeat.score);
  low = isFinite(low) ? low : 0;
  score = isFinite(score) ? score : 0;
  return beatTriggerClamp(Math.max(low, score * 0.85), 0, 1);
}

function stepLiveBeatTrigger(realtimeBeat, dt) {
  return beatTriggerStep(beatTriggerState, {
    level: beatTriggerLiveLevel(realtimeBeat),
    bpm: beatTriggerCurrentBpm(),
    dt: dt,
    strength: realtimeBeat && isFinite(realtimeBeat.strength) ? realtimeBeat.strength : beatTriggerLiveLevel(realtimeBeat)
  });
}