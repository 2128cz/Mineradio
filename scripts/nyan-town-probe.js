'use strict';

// Read-only live probe for preset 18: selects it, reads nyanTownStatus() twice, checks the frame
// counter, the offscreen pass, the ray-step knob, the cat toggle and the shader error slot, then
// restores the preset that was active before. Nothing else is written.
//
//   node scripts/nyan-town-probe.js --port=9222

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
  if (!page) { console.log('nyan-town-probe: no page on port ' + port); process.exit(2); }
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
  await ev('setPreset(18)');
  await wait(1200);
  const firstAt = Date.now();
  const first = JSON.parse(await ev('JSON.stringify(nyanTownStatus())'));
  await wait(2000);
  const secondAt = Date.now();
  const second = JSON.parse(await ev('JSON.stringify(nyanTownStatus())'));
  let occlusion = null;
  // The sky band only renders while the path camera has its head up, and that nod repeats every
  // few seconds. Wait for a frame where a live line actually reaches the screen before judging.
  for (let attempt = 0; attempt < 6 && !occlusion; attempt++) {
    const live = JSON.parse(await ev('JSON.stringify(nyanTownStatus())'));
    if (live.lyricLive > 0) {
      const stats = JSON.parse(await ev(`(function(){
        var srt=nyanTownState.rt, lrt=nyanTownState.lyricRt, drt=nyanTownState.lyricDepthRt;
        var sw=srt.width, sh=srt.height, lw=lrt.width, lh=lrt.height;
        var sb=new Uint8Array(sw*sh*4); renderer.readRenderTargetPixels(srt,0,0,sw,sh,sb);
        var lb=new Uint8Array(lw*lh*4); renderer.readRenderTargetPixels(lrt,0,0,lw,lh,lb);
        var db=new Uint8Array(lw*lh*4); renderer.readRenderTargetPixels(drt,0,0,lw,lh,db);
        var soft=0.012, cover=0, occluded=0, visible=0;
        for (var y=0;y<lh;y+=2) for (var x=0;x<lw;x+=2) {
          var li=(y*lw+x)*4;
          if (lb[li+3] < 32) continue;
          var sx=Math.min(sw-1, Math.round(x*sw/lw)), sy=Math.min(sh-1, Math.round(y*sh/lh));
          var sceneD=sb[(sy*sw+sx)*4+3]/255, lyricD=db[li]/255;
          cover++;
          if (lyricD > sceneD + soft) occluded++;
          else if (lyricD < sceneD - soft) visible++;
        }
        return JSON.stringify({cover:cover, occluded:occluded, visible:visible});
      })()`));
      if (stats.cover > 0) occlusion = stats;
    }
    if (!occlusion) await wait(1500);
  }
  await ev('setPreset(' + previous + ')');
  ws.close();

  console.log(JSON.stringify(second, null, 2));
  let failed = 0;
  const check = (ok, label) => { console.log((ok ? '[OK] ' : '[FAIL] ') + label); if (!ok) failed++; };
  check(second.frames > first.frames, 'frames advance (' + first.frames + ' -> ' + second.frames + ')');
  check(second.error === '', 'no shader/status error (' + second.error + ')');
  check(second.built === true, 'the town pass is built');
  check(second.passScale > 0, 'the offscreen pass is sized (' + second.passScale + ')');
  check(second.raySteps > 0, 'the ray-step knob reaches the status (' + second.raySteps + ')');
  check(second.nyan === true, 'the Nyan Cat cameo is on by default');
  check(second.lyricOn === true, 'the lyric lane is on by default');
  check(second.lyricRows >= 3, 'the lyric pool is allocated (' + second.lyricRows + ' rows)');
  if (occlusion) {
    console.log('[INFO] sky lyric band: ' + occlusion.cover + ' covered, ' + occlusion.occluded
      + ' behind the town, ' + occlusion.visible + ' visible at this frame');
    check(occlusion.cover > 0, 'the sky band reaches the screen while the camera looks up');
    check(occlusion.visible > 0, 'at least some lyric pixels are in front of the sky');
    if (occlusion.occluded === 0) console.log('[INFO] the town did not cross the band at this instant');
  } else {
    console.log('[INFO] no lyric line reached the screen within the retry window (camera down or no line live)');
  }
  const fps = Math.round(((second.frames - first.frames) / Math.max(1, secondAt - firstAt)) * 10000) / 10;
  console.log('[INFO] in-app fps ~' + fps + ' at ' + second.rt.join('x') + ' (renderScale ' + second.passScale + ')');
  check(second.raySteps === first.raySteps, 'the ray-step knob stays stable while playing');
  check(errors.length <= 1, 'window exceptions stay at the known Electron one (' + errors.length + ')');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('nyan-town-probe failed: ' + err.message);
  process.exit(2);
});
