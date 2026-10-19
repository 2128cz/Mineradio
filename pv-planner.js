'use strict';

// Main-process planning bridge for the JIZURA PV route. The port decision puts planning in a
// hidden window rather than the renderer: one engine per install, off the playback thread.
//
// The engine needs a document (it builds canvases for glyph metrics at module scope), so it
// cannot run in the Node main process. It runs in a hidden window instead, which also keeps a
// second copy of the engine out of the renderer and keeps planning off the playback thread.
//
// The window loads the vendored single file (vendor/jizura/jizura-engine.js) whose bytes are
// hash-pinned by quick-check.js; the pin is re-checked here so a stale or edited copy fails
// loudly instead of producing archives nobody can reproduce.
//
// Disposing the hidden window is safe in the app (its main window keeps the window list
// non-empty); in a probe without a main window it trips Electron's default window-all-closed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 8000;
const ENGINE_RELATIVE_PATH = path.join('vendor', 'jizura', 'jizura-engine.js');
const MANIFEST_RELATIVE_PATH = path.join('vendor', 'jizura', 'engine-manifest.json');

// Project fields the planner accepts from a caller, and the defaults this app wants.
// typeset stays off: JIZURA's 0.2s lead would stack with Mineradio's per-song lyric offset
// (decision D), and unify matches the sample the reference plan was measured with.
const PROJECT_FIELDS = ['lyrics', 'lang', 'style', 'seed', 'aspect', 'res', 'fps', 'title', 'artist', 'mood', 'keyBg', 'extra', 'wa', 'horror', 'typo', 'kinetic'];
const PROJECT_DEFAULTS = { typeset: false, unify: true, koma: 12 };

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function readEngine(appRoot) {
  const enginePath = path.join(appRoot, ENGINE_RELATIVE_PATH);
  const manifestPath = path.join(appRoot, MANIFEST_RELATIVE_PATH);
  const bytes = fs.readFileSync(enginePath);
  let expected = null;
  try {
    expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).bundleSha1 || null;
  } catch (error) {
    expected = null;
  }
  return { enginePath, bytes, sha1: sha1(bytes), expected, pinned: expected !== null && sha1(bytes) === expected };
}

// The receiver lives in the hidden window. It takes and returns JSON strings so a big plan
// never has to survive structured cloning, and it validates its input because the payload
// originates in the renderer.
//
// It catches its own errors and returns {error, message} instead of throwing: Electron squashes
// a page exception into "Script failed to execute, this normally means an error was thrown"
// (measured), which loses both the named code and the real reason.
function receiverSource() {
  return [
    '(function () {',
    '  window.__pvPlan = function (payloadJson) {',
    '    try {',
    '      var payload = JSON.parse(payloadJson);',
    '      if (!payload || typeof payload.lyrics !== "string" || !payload.lyrics) {',
    '        return JSON.stringify({ error: "PV_BAD_PAYLOAD", message: "lyrics must be a non-empty string" });',
    '      }',
    '      var J = window.J;',
    '      if (!J || typeof J.plan !== "function" || typeof J.planForAE !== "function") {',
    '        return JSON.stringify({ error: "PV_ENGINE_NOT_READY", message: "window.J is incomplete" });',
    '      }',
    '      var project = J.defaultProject();',
    '      var fields = ' + JSON.stringify(PROJECT_FIELDS) + ';',
    '      for (var i = 0; i < fields.length; i++) {',
    '        if (payload[fields[i]] !== undefined) project[fields[i]] = payload[fields[i]];',
    '      }',
    '      var defaults = ' + JSON.stringify(PROJECT_DEFAULTS) + ';',
    '      project.typeset = payload.typeset === undefined ? defaults.typeset : !!payload.typeset;',
    '      project.unify = payload.unify === undefined ? defaults.unify : !!payload.unify;',
    '      project.fx = Object.assign({}, project.fx, { koma: Number(payload.koma) > 0 ? Number(payload.koma) : defaults.koma });',
    '      var started = performance.now();',
    '      var plan = J.plan(project, null);',
    '      var json = JSON.stringify(J.planForAE(plan, project));',
    '      return JSON.stringify({',
    '        json: json,',
    '        cuts: (plan.cuts || []).length,',
    '        duration: plan.duration,',
    '        W: plan.W, H: plan.H,',
    '        lang: plan.lang,',
    '        engineMs: Math.round((performance.now() - started) * 100)/100,',
    '        appVersion: (function () { try { return JSON.parse(json).appVersion; } catch (e) { return null; } })()',
    '      });',
    '    } catch (error) {',
    '      return JSON.stringify({ error: "PV_PLAN_FAILED", message: String((error && error.message) || error), stack: String((error && error.stack) || "").split("\\n").slice(0, 3).join(" | ") });',
    '    }',
    '  };',
    '  return true;',
    '})();'
  ].join('\n');
}

function createPvPlanner(options) {
  const opts = options || {};
  const appRoot = opts.appRoot || path.join(__dirname);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const BrowserWindow = opts.BrowserWindow || require('electron').BrowserWindow;
  const engine = opts.skipEnginePinCheck ? null : readEngine(appRoot);
  if (engine && !engine.pinned) {
    throw Object.assign(new Error('PV_ENGINE_PIN_MISMATCH'), { code: 'PV_ENGINE_PIN_MISMATCH', engineSha1: engine.sha1, expected: engine.expected });
  }

  const stats = {
    windowsCreated: 0,
    plans: 0,
    failures: 0,
    timeouts: 0,
    engineBytes: engine ? engine.bytes.length : null,
    engineSha1: engine ? engine.sha1 : null,
    lastPlanMs: null,
    lastEngineMs: null,
    lastError: null,
  };

  let win = null;
  let ready = null;
  let queue = Promise.resolve();

  function destroyWindow() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    ready = null;
  }

  function ensureReady() {
    if (ready) return ready;
    win = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The window is hidden; without this the engine's own timers would be throttled while
        // a plan is in flight, which is exactly the situation the spike's bench needed to avoid.
        backgroundThrottling: false,
      },
    });
    stats.windowsCreated += 1;
    ready = win.webContents.loadURL('about:blank')
      .then(() => win.webContents.executeJavaScript(engine ? engine.bytes.toString('utf8') : '', true))
      .then(() => win.webContents.executeJavaScript(receiverSource(), true))
      .then(() => win);
    ready.catch(() => { destroyWindow(); });
    return ready;
  }

  function callOnce(payloadJson) {
    return ensureReady().then((target) => {
      const script = 'window.__pvPlan(' + JSON.stringify(payloadJson) + ')';
      return target.webContents.executeJavaScript(script, true);
    });
  }

  function plan(payload) {
    const run = () => {
      const payloadJson = JSON.stringify(payload || {});
      const started = Date.now();
      let timer = null;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          stats.timeouts += 1;
          // A timed-out executeJavaScript may still settle later, so the window is dropped
          // rather than reused: the next call rebuilds it and nothing is left wedged.
          destroyWindow();
          reject(Object.assign(new Error('PV_PLAN_TIMEOUT'), { code: 'PV_PLAN_TIMEOUT', timeoutMs }));
        }, timeoutMs);
      });
      return Promise.race([callOnce(payloadJson), timeout]).then((text) => {
        clearTimeout(timer);
        const out = JSON.parse(text);
        if (out && out.error) {
          stats.failures += 1;
          stats.lastError = out.message || out.error;
          return Promise.reject(Object.assign(
            new Error(out.message || out.error),
            { code: out.error, engineStack: out.stack || null }
          ));
        }
        stats.plans += 1;
        stats.lastPlanMs = Date.now() - started;
        stats.lastEngineMs = out.engineMs;
        return out;
      }).catch((error) => {
        clearTimeout(timer);
        if (error && error.code) return Promise.reject(error);
        // Anything left here never reached the receiver at all (window gone, load failure).
        stats.failures += 1;
        const message = String((error && error.message) || error);
        stats.lastError = message;
        return Promise.reject(Object.assign(new Error('PV_PLAN_FAILED: ' + message), { code: 'PV_PLAN_FAILED' }));
      });
    };
    // Serialize: the hidden window answers one plan at a time, so a queue here keeps callers
    // from interleaving two executeJavaScript calls on the same page.
    const result = queue.then(run, run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    plan,
    dispose() { destroyWindow(); },
    isOpen() { return !!(win && !win.isDestroyed()); },
    stats() { return Object.assign({}, stats); },
  };
}

module.exports = { createPvPlanner, readEngine, ENGINE_RELATIVE_PATH, MANIFEST_RELATIVE_PATH, DEFAULT_TIMEOUT_MS };