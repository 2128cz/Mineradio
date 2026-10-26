'use strict';

// Pool around the PV planner's hidden window.
//
// The planner holds a whole renderer process with the vendored engine in it, which only earns its
// cost while PVs are actually being planned. So this pool creates it on first use (an app that
// never opens a PV must not pay for it) and hands the window back on the app's existing
// background/minimize memory path.
//
// Both rules come from docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md: reclaim is only allowed on the
// idle / background / minimized paths, never as a forced teardown during foreground playback, and
// an aggressive path has to say what it did in the log instead of just doing it.
//
// dispose() mid-plan would reject that caller's pending executeJavaScript, so the busy signal is
// a hard no. It is injected because server.js owns the request de-dup map, where two callers
// sharing one plan are still one plan.
//
// Counters are cumulative over the life of the process, not per instance: a release must not turn
// the pipeline blind about how many windows it has spawned or how many plans it has run.

const path = require('node:path');

const COUNTER_FIELDS = ['windowsCreated', 'plans', 'failures', 'timeouts'];
const LATEST_FIELDS = ['lastPlanMs', 'lastEngineMs', 'lastError', 'engineBytes', 'engineSha1'];
// A minimize releases the window, and the queue's prefetch of the next songs takes it back within
// seconds. Releasing mid-prefetch is not idle, so a backgrounded app gets one quiet period to
// finish planning before the window is taken back.
const PV_IDLE_RELEASE_MS = 45000;

function isPlainFunction(value) {
  return typeof value === 'function';
}

function createPvPlannerPool(options) {
  const opts = options || {};
  const appRoot = opts.appRoot || path.join(__dirname);
  const createPlanner = opts.createPlanner || ((createOptions) => require('./pv-planner').createPvPlanner(createOptions));
  const isBusy = isPlainFunction(opts.isBusy) ? opts.isBusy : () => false;
  const log = isPlainFunction(opts.log) ? opts.log : (line) => console.log(line);
  const idleReleaseMs = Number(opts.idleReleaseMs) > 0 ? Number(opts.idleReleaseMs) : PV_IDLE_RELEASE_MS;

  let instance = null;
  let failure = null;
  let background = false;
  let reclaimTimer = null;
  // Cumulative across every instance this process has had, including the ones already released.
  const totals = {
    windowsCreated: 0,
    plans: 0,
    failures: 0,
    timeouts: 0,
    lastPlanMs: null,
    lastEngineMs: null,
    lastError: null,
    engineBytes: null,
    engineSha1: null,
    releases: 0,
    refusedWhileBusy: 0,
    lastReleaseReason: '',
    lastReleaseAt: 0,
  };

  function mergeClosed(stats) {
    if (!stats) return;
    for (const field of COUNTER_FIELDS) totals[field] += Number(stats[field]) || 0;
    for (const field of LATEST_FIELDS) {
      if (stats[field] !== null && stats[field] !== undefined) totals[field] = stats[field];
    }
  }

  function cancelReclaim() {
    if (reclaimTimer) {
      clearTimeout(reclaimTimer);
      reclaimTimer = null;
    }
  }

  // One-shot, and only ever armed while the main process says the app is out of the way. A plan
  // lands here through get(), so every rebuild re-arms the same quiet period; the timer is unref'd
  // because a pending reclaim must not be what keeps the app alive.
  function scheduleReclaim() {
    if (!background || !instance || reclaimTimer) return;
    reclaimTimer = setTimeout(() => {
      reclaimTimer = null;
      idleRelease('background-quiet');
    }, idleReleaseMs);
    if (isPlainFunction(reclaimTimer.unref)) reclaimTimer.unref();
  }

  function liveStats() {
    const current = instance && isPlainFunction(instance.stats) ? instance.stats() : null;
    const out = Object.assign({}, totals);
    if (current) {
      // The live instance counts only its own work, so the reading has to be the closed total
      // plus what this instance has done since — not the instance's numbers overwriting them.
      for (const field of COUNTER_FIELDS) out[field] = totals[field] + (Number(current[field]) || 0);
      for (const field of LATEST_FIELDS) {
        if (current[field] !== null && current[field] !== undefined) out[field] = current[field];
      }
    }
    out.open = !!(instance && isPlainFunction(instance.isOpen) && instance.isOpen());
    return out;
  }

  function get() {
    if (instance) {
      if (background) scheduleReclaim();
      return instance;
    }
    if (failure) throw failure;
    try {
      instance = createPlanner({ appRoot });
    } catch (error) {
      // A pin mismatch must stay a named failure, not a re-read attempt on every request.
      failure = error;
      throw error;
    }
    // A window taken for one plan is only worth its cost until planning goes quiet again.
    if (background) scheduleReclaim();
    return instance;
  }

  function closePlanner(reason) {
    const why = String(reason || 'manual');
    const windowWasOpen = !!(instance && isPlainFunction(instance.isOpen) && instance.isOpen());
    if (instance) {
      if (isPlainFunction(instance.stats)) mergeClosed(instance.stats());
      instance.dispose();
    }
    instance = null;
    failure = null;
    totals.releases += 1;
    totals.lastReleaseReason = why;
    totals.lastReleaseAt = Date.now();
    log(`[PvPlanner] window released (${why}); open before: ${windowWasOpen}, plans so far: ${totals.plans}`);
    return { ok: true, released: true, reason: why, windowWasOpen, stats: liveStats() };
  }

  function idleRelease(reason) {
    const why = String(reason || 'idle');
    if (!instance) return { ok: true, released: false, reason: 'not-open', windowWasOpen: false, stats: liveStats() };
    const busy = Number(isBusy()) || 0;
    if (busy > 0) {
      totals.refusedWhileBusy += 1;
      log(`[PvPlanner] idle release (${why}) refused: ${busy} plan(s) in flight`);
      // Re-armed after the wait so the quiet period is measured from the plan that refused it, not
      // from the moment the app was backgrounded — otherwise one long queue never releases anything.
      if (background) scheduleReclaim();
      return { ok: true, released: false, reason: 'plan-in-flight', busy, windowWasOpen: true, stats: liveStats() };
    }
    cancelReclaim();
    return closePlanner(why);
  }

  return {
    get,
    release: closePlanner,
    idleRelease,
    // The pool cannot see the window; desktop/main.js, which owns it, pushes this on every state
    // change. Backgrounding alone arms nothing - there may be no window to give back.
    setBackground(inBackground) {
      background = !!inBackground;
      if (!background) {
        cancelReclaim();
        return { ok: true, background: false, reclaimArmed: false };
      }
      scheduleReclaim();
      return { ok: true, background: true, reclaimArmed: !!reclaimTimer };
    },
    isOpen: () => !!(instance && isPlainFunction(instance.isOpen) && instance.isOpen()),
    stats: () => Object.assign(liveStats(), { background, reclaimArmed: !!reclaimTimer, idleReleaseMs }),
  };
}

module.exports = { createPvPlannerPool };
