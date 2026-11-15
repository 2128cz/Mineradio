'use strict';

// Fidelity bench for preset 16: renders the reference shader (tests/fixtures/neon-fuji-reference.glsl)
// and the ported one (extracted from the shipped module) under the SAME uniforms, reads both back and
// reports the per-channel difference. A port that is faithful to the source should be identical up to
// floating-point noise; a port rewritten from memory will not be.
//
//   node_modules/electron/dist/electron.exe scripts/neon-fidelity-bench.js
//   ... --maxDiff=0.002 --maxPixel=0.01 --out=tmp/neon-fidelity.json
//   ... --mutate=sun   # deliberately break one composition step to prove the bench can fail
//
// Both limits matter: a mistake confined to a band (a swapped composition step) moves the mean by
// very little but changes those pixels a lot, so the worst channel difference is judged too.
//
// Read-only: hidden window, scratch dir under the OS temp, nothing in the app is touched.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_SIZES = [[640, 360], [1280, 720], [320, 180]];
const DEFAULT_TIMES = [0.7, 3.3, 7.1];
const DEFAULT_MAX_DIFF = 0.002;
const DEFAULT_MAX_PIXEL = 0.01;

function parseArgs(argv) {
  const get = (n) => {
    const hit = argv.find((a) => a.startsWith('--' + n + '='));
    return hit ? hit.slice(n.length + 3) : null;
  };
  const sizes = (get('sizes') || '').trim()
    ? get('sizes').split(',').map((s) => s.trim().split('x').map(Number))
    : DEFAULT_SIZES;
  const times = (get('times') || '').trim() ? get('times').split(',').map(Number) : DEFAULT_TIMES;
  return {
    sizes, times,
    maxDiff: Number(get('maxDiff') || DEFAULT_MAX_DIFF),
    maxPixel: Number(get('maxPixel') || DEFAULT_MAX_PIXEL),
    mutate: get('mutate'),
    out: get('out'),
    timing: argv.includes('--timing'),
    markdown: argv.includes('--markdown')
  };
}

// The two shaders: the fixture verbatim behind the Shadertoy preamble it expects, and the shipped
// module's own fragment text.
const PAGE_RUN = String.raw`async function (opts) {
  function compile(gl, frag, injectPrecision) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }');
    gl.compileShader(vs);
    const fsSh = gl.createShader(gl.FRAGMENT_SHADER);
    // The shipped fragment relies on THREE's ShaderMaterial prefix, which is where its
    // "precision highp float;" comes from; a bare GL context has to be told the same thing.
    gl.shaderSource(fsSh, injectPrecision ? 'precision highp float;\n' + frag : frag);
    gl.compileShader(fsSh);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fsSh);
    gl.bindAttribLocation(program, 0, 'p');
    gl.linkProgram(program);
    return {
      program,
      ok: gl.getProgramParameter(program, gl.LINK_STATUS) && gl.getShaderParameter(fsSh, gl.COMPILE_STATUS),
      log: String(gl.getShaderInfoLog(fsSh) || gl.getProgramInfoLog(program) || '').slice(0, 400)
    };
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    document.body.appendChild(c);
    const gl = c.getContext('webgl', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    return { canvas: c, gl };
  }

  // The reference's constants, passed to the port as its uniforms so both draw the same frame.
  const U = {
    uBattery: 1.0, uHorizon: -0.2, uRoadDepth: 3.0, uRoadSpread: 1.0, uGridScale: 0.01,
    uGridSpeed: 4.0, uGridDensity: 5.0, uGridBloom: 0.4, uSunX: 0.75, uSunY: 0.2,
    uSunRadius: 0.3, uSunStripes: 100, uSunBloom: 0.7, uFujiX: -0.75, uFujiY: 0.5,
    uFujiWidth: 1.75, uFujiBase: 0.2, uFujiHeight: 0.5, uSnowFreq: 20, uSnowSpeed: 2,
    uSnowAmp: 0.05, uSnowLevel: 0.2, uCloudOn: 1, uCloudSpeed: 0.1, uCloudWidth: 0.075,
    uFogGain: 1.0
  };
  const C = {
    uSkyColor: [0.0, 0.1, 0.2], uGridColor: [1.0, 0.5, 1.0], uSunColor: [1.0, 0.2, 1.0],
    uSunWarm: [1.0, 0.4, 0.1], uFujiDark: [0.0, 0.0, 0.25], uFujiBright: [1.0, 0.0, 0.5],
    uSnowColor: [1.0, 0.5, 1.0], uHorizonNear: [1.0, 0.12, 0.8], uHorizonFar: [0.0, 0.0, 0.2],
    uCloudColor: [0.0, 0.0, 0.2]
  };

  const results = [];
  for (const [w, h] of opts.sizes) {
    const a = makeCanvas(w, h);
    const b = makeCanvas(w, h);
    const pa = compile(a.gl, opts.refFrag, false);
    const pb = compile(b.gl, opts.portFrag, true);
    if (!pa.ok) return { ok: false, error: 'reference failed to compile: ' + pa.log };
    if (!pb.ok) return { ok: false, error: 'port failed to compile: ' + pb.log };
    for (const t of opts.times) {
      const draw = (ctx, prog, uniforms) => {
        const gl = ctx.gl;
        gl.viewport(0, 0, w, h);
        gl.useProgram(prog);
        gl.uniform3f(gl.getUniformLocation(prog, 'iResolution'), w, h, 1);
        gl.uniform1f(gl.getUniformLocation(prog, 'iTime'), t);
        gl.uniform4f(gl.getUniformLocation(prog, 'iMouse'), 0, 0, 0, 0);
        for (const [name, value] of Object.entries(uniforms)) {
          const loc = gl.getUniformLocation(prog, name);
          if (!loc) continue;
          if (Array.isArray(value)) gl.uniform3f(loc, value[0], value[1], value[2]);
          else gl.uniform1f(loc, value);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const ref = draw(a, pa.program, {});
      const port = draw(b, pb.program, Object.assign({}, U, C));
      let sum = 0, max = 0, worst = -1, n = 0;
      for (let i = 0; i < ref.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(ref[i + c] - port[i + c]) / 255;
          sum += d; n++;
          if (d > max) { max = d; worst = i / 4; }
        }
      }
      // An all-black reference would match an all-black port; the frame under test has to carry
      // the scene's structure (lit pixels, several distinct levels) for the diff to mean anything.
      let luma = 0, lit = 0, bright = 0, pixels = 0;
      const levels = new Set();
      for (let i = 0; i < ref.length; i += 4) {
        const lum = (ref[i] * 0.2126 + ref[i + 1] * 0.7152 + ref[i + 2] * 0.0722) / 255;
        luma += lum; pixels++;
        if (lum > 0.02) lit++;
        if (lum > 0.25) bright++;
        levels.add((ref[i] << 16) | (ref[i + 1] << 8) | ref[i + 2]);
      }
      results.push({
        size: w + 'x' + h, t: t,
        mean: Math.round((sum / n) * 100000) / 100000,
        max: Math.round(max * 10000) / 10000,
        worstPixel: worst,
        refLuma: Math.round((luma / pixels) * 10000) / 10000,
        refLit: Math.round((lit / pixels) * 10000) / 10000,
        refBright: Math.round((bright / pixels) * 10000) / 10000,
        refLevels: levels.size,
        refCenter: Array.from(ref.slice(((h >> 1) * w + (w >> 1)) * 4, ((h >> 1) * w + (w >> 1)) * 4 + 3)),
        portCenter: Array.from(port.slice(((h >> 1) * w + (w >> 1)) * 4, ((h >> 1) * w + (w >> 1)) * 4 + 3))
      });
    }
    a.canvas.remove();
    b.canvas.remove();
  }
  // Optional: how long one full frame of the port costs on this GPU. gl.finish() after every draw
  // keeps the timer on the GPU work itself instead of on command submission.
  let timing = null;
  if (opts.timing) {
    const tw = opts.timingSize[0], th = opts.timingSize[1];
    const c = makeCanvas(tw, th);
    const p = compile(c.gl, opts.portFrag, true);
    if (!p.ok) return { ok: false, error: 'port failed to compile (timing): ' + p.log };
    const gl = c.gl;
    gl.viewport(0, 0, tw, th);
    gl.useProgram(p.program);
    gl.uniform3f(gl.getUniformLocation(p.program, 'iResolution'), tw, th, 1);
    gl.uniform4f(gl.getUniformLocation(p.program, 'iMouse'), 0, 0, 0, 0);
    for (const [name, value] of Object.entries(Object.assign({}, U, C))) {
      const loc = gl.getUniformLocation(p.program, name);
      if (!loc) continue;
      if (Array.isArray(value)) gl.uniform3f(loc, value[0], value[1], value[2]);
      else gl.uniform1f(loc, value);
    }
    const timeLoc = gl.getUniformLocation(p.program, 'iTime');
    const samples = [];
    for (let f = 0; f < 90; f++) {
      gl.uniform1f(timeLoc, f * 0.016);
      const t0 = performance.now();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      const dt = performance.now() - t0;
      if (f >= 10) samples.push(dt);
    }
    samples.sort((a, b) => a - b);
    const pick = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
    timing = {
      size: tw + 'x' + th, frames: samples.length,
      median: Math.round(pick(0.5) * 100) / 100,
      p95: Math.round(pick(0.95) * 100) / 100
    };
    c.canvas.remove();
  }
  return { ok: true, results, timing };
}`;

function prepare(appRoot) {
  const dir = path.join(os.tmpdir(), 'mineradio-neon-fidelity');
  fs.mkdirSync(dir, { recursive: true });
  const moduleSrc = fs.readFileSync(
    path.join(appRoot, 'public', 'js', 'modules', '02-visual', '21-neon-fuji-preset.js'), 'utf8');
  const fixture = fs.readFileSync(path.join(appRoot, 'tests', 'fixtures', 'neon-fuji-reference.glsl'), 'utf8');
  const preamble = 'precision highp float;\nuniform vec3 iResolution;\nuniform float iTime;\nuniform vec4 iMouse;\n';
  // The fixture stops at mainImage, as the site's editor does; the bench supplies the entry point.
  const wrapper = '\nvoid main() { vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy); gl_FragColor = c; }\n';
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
    + '<script>window.__moduleSrc = ' + JSON.stringify(moduleSrc) + ';'
    + 'window.__refSrc = ' + JSON.stringify(preamble + fixture + wrapper) + ';'
    + '(new Function(window.__moduleSrc + "\\n;window.__neonFrag = NEON_SCENE_FS;"))();'
    + '</script></body></html>';
  fs.writeFileSync(path.join(dir, 'bench.html'), html, 'utf8');
  return { dir, page: path.join(dir, 'bench.html') };
}

function mutatePort(frag, kind) {
  // Note: "col = mix(vec3(0), col, sunVal)" and "col * sunVal" are algebraically the same, so that
  // rewrite would pass no matter how wrong the port is. These two mutants move real pixels.
  if (kind === 'sun') {
    // Shifting the sun's lookup scales the disc and its stripes away from where the reference puts them.
    return frag.replace('float sunVal = sun(sunUV, battery);', 'float sunVal = sun(sunUV * 1.35, battery);');
  }
  if (kind === 'order') {
    // The battery desaturation runs before the fog in the reference; swapping the two lines is the
    // kind of "close enough" rewrite that looks fine in a screenshot and is wrong in the numbers.
    return frag.replace(
      '  col += fog * fog * fog * uFogGain;\n  col = mix(vec3(col.r, col.r, col.r) * 0.5, col, battery * 0.7);',
      '  col = mix(vec3(col.r, col.r, col.r) * 0.5, col, battery * 0.7);\n  col += fog * fog * fog * uFogGain;');
  }
  return frag;
}

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv);
  const scratch = prepare(appRoot);
  const { app, BrowserWindow } = require('electron');
  app.commandLine.appendSwitch('use-angle', 'd3d11');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: false, backgroundThrottling: false } });
  await win.loadFile(scratch.page);
  const portFrag = await win.webContents.executeJavaScript('window.__neonFrag');
  if (!portFrag) {
    console.log('neon-fidelity: the module did not expose NEON_SCENE_FS');
    app.exit(1);
    return;
  }
  const mutated = args.mutate ? mutatePort(portFrag, args.mutate) : portFrag;
  if (args.mutate && mutated === portFrag) {
    console.log('neon-fidelity: --mutate=' + args.mutate + ' did not change the shader');
    app.exit(1);
    return;
  }
  const res = await win.webContents.executeJavaScript(
    '(' + PAGE_RUN + ')(' + JSON.stringify({
      sizes: args.sizes, times: args.times,
      timing: args.timing, timingSize: [1280, 720],
      refFrag: await win.webContents.executeJavaScript('window.__refSrc'),
      portFrag: mutated
    }) + ')', true);
  if (!res || !res.ok) {
    console.log('neon-fidelity: ' + ((res && res.error) || 'failed'));
    app.exit(1);
    return;
  }
  let worstMean = 0;
  let worstMax = 0;
  let thin = null;
  for (const r of res.results) {
    worstMean = Math.max(worstMean, r.mean);
    worstMax = Math.max(worstMax, r.max);
    if (r.refBright < 0.01 || r.refLevels < 64) thin = thin || r;
    console.log(r.size + ' t=' + r.t + '  mean=' + r.mean + '  max=' + r.max
      + '  ref luma=' + r.refLuma + ' lit=' + r.refLit + ' bright=' + r.refBright + ' levels=' + r.refLevels
      + '  centre ref=' + r.refCenter.join(',') + ' port=' + r.portCenter.join(','));
  }
  // A flat/empty reference frame would make any port "match"; refuse to judge on one.
  if (thin) {
    console.log('neon-fidelity: reference frame at ' + thin.size + ' t=' + thin.t
      + ' is too thin to judge (bright=' + thin.refBright + ', levels=' + thin.refLevels + ')');
    fs.writeFileSync(args.out ? path.resolve(appRoot, args.out) : path.join(scratch.dir, 'result.json'),
      JSON.stringify({ mutate: args.mutate || null, maxDiff: args.maxDiff, worstMean, worstMax, thin: true, results: res.results }, null, 2), 'utf8');
    win.destroy();
    app.exit(1);
    return;
  }
  if (res.timing) {
    console.log('neon-fidelity: one frame at ' + res.timing.size + '  median=' + res.timing.median
      + 'ms  p95=' + res.timing.p95 + 'ms  (' + res.timing.frames + ' frames, gl.finish per draw)');
  }
  const pass = worstMean <= args.maxDiff && worstMax <= args.maxPixel;
  console.log('neon-fidelity: worst mean ' + worstMean + ' (limit ' + args.maxDiff
    + '), worst pixel ' + worstMax + ' (limit ' + args.maxPixel + ')');
  const out = args.out ? path.resolve(appRoot, args.out) : path.join(scratch.dir, 'result.json');
  fs.writeFileSync(out, JSON.stringify({ mutate: args.mutate || null, maxDiff: args.maxDiff, maxPixel: args.maxPixel, worstMean, worstMax, timing: res.timing || null, results: res.results }, null, 2), 'utf8');
  console.log('neon-fidelity: ' + (pass ? 'PASS' : 'FAIL') + ' -> ' + out);
  win.destroy();
  app.exit(pass ? 0 : 1);
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) {
  main().catch((err) => {
    console.log('neon-fidelity failed: ' + String((err && err.stack) || err));
    process.exitCode = 1;
  });
}
