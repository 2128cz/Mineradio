'use strict';

// Read-only live probe for preset 17: selects it, reads mixerDeskStatus() twice, checks the frame
// counter, the panel/atlas counters and the shader error slot, then restores the preset that was
// active before. Nothing else is written.
//
//   node scripts/mixer-desk-probe.js --port=9222

const http = require('node:http');

function getJson(port, p) {
  return new Promise((res, rej) => {
    http.get({ hostname: '127.0.0.1', port, path: p, agent: false }, (r) => {
      let t = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { t += c; });
      r.on('end', () => { try { res(JSON.parse(t)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const portArg = (process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1];
  const port = Number(portArg || process.env.DEV_DEBUG_PORT || 9222);
  const targets = await getJson(port, '/json/list');
  const page = targets.find((t) => t.webSocketDebuggerUrl && /127\.0\.0\.1:\d+/.test(t.url || '') && t.type === 'page');
  if (!page) { console.log('mixer-probe: no page on port ' + port); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
    const s = pending.get(m.id);
    if (!s) return;
    pending.delete(m.id);
    m.error ? s.rej(new Error(JSON.stringify(m.error))) : s.res(m.result);
  };
  await new Promise((res) => { ws.onopen = res; });
  await send('Runtime.enable');
  const ev = async (expr) => {
    const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return out.exceptionDetails ? 'ERR ' + JSON.stringify(out.exceptionDetails).slice(0, 200) : out.result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await ev('(function(){ if (typeof dismissSplash === "function" && document.body.classList.contains("splash-active")) dismissSplash({ immediate: true }); return 1; })()');
  const previous = Number(await ev('Number(fx.preset)'));
  await ev('setPreset(17)');
  await wait(1200);
  const firstAt = Date.now();
  const first = JSON.parse(await ev('JSON.stringify(mixerDeskStatus())'));
  await wait(2000);
  const secondAt = Date.now();
  const second = JSON.parse(await ev('JSON.stringify(mixerDeskStatus())'));
  await ev('setPreset(' + previous + ')');
  ws.close();

  console.log(JSON.stringify(second, null, 2));
  let failed = 0;
  const check = (ok, label) => { console.log((ok ? '[OK] ' : '[FAIL] ') + label); if (!ok) failed++; };
  check(second.frames > first.frames, 'frames advance (' + first.frames + ' -> ' + second.frames + ')');
  check(second.error === '', 'no shader/status error (' + second.error + ')');
  check(second.built === true, 'the desk pass is built');
  check(second.panels > 0, 'the panel pool is live (' + second.panels + ')');
  check(second.atlasUploads > 0, 'the glyph atlas has been uploaded (' + second.atlasUploads + ')');
  const fps = Math.round(((second.frames - first.frames) / Math.max(1, secondAt - firstAt)) * 10000) / 10;
  console.log('[INFO] in-app fps ~' + fps + ' at ' + second.rt.join('x') + ' (renderScale ' + second.passScale + ')');
  check(second.carousel >= first.carousel, 'the carousel is monotone (' + first.carousel + ' -> ' + second.carousel + ')');
  check(errors.length <= 1, 'window exceptions stay at the known Electron one (' + errors.length + ')');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('mixer-probe failed: ' + err.message);
  process.exit(2);
});
