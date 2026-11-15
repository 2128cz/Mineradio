'use strict';

// 预设 18「彩虹猫小镇」(NYAN TOWN).
//
// This is a port of the Shadertoy shader "Fractal Cartoon" (formerly "DE edge detection") by Kali,
// including its Nyan Cat cameo code by mu6k (https://www.shadertoy.com/view/4dXGWH). The reference
// body is kept as written; the only changes are the uniforms that replace its literals, an opaque
// alpha for the post pass, and runtime toggles for the cat and its rainbow. The Shadertoy page was
// not reachable and carried no licence header; the licence is UNVERIFIED and the default Shadertoy
// licence (CC BY-NC-SA) is not compatible with this GPL build, so nothing containing this port may
// be distributed until the authors confirm terms. The Nyan Cat sprite is drawn in code here (the
// original texture could not be fetched); it is an approximation of the mu6k cameo art. See
// 23-nyan-town-preset.LICENSE.txt, NOTICE.md and docs/THIRD_PARTY_PORTS.md.

var NYAN_TOWN_PRESET_INDEX = 18;

// Defaults equal the reference literals, so leaving every knob alone reproduces the reference
// frame (tests/nyan-town-port.test.js pins this).
var NYAN_TOWN_TUNING_SCHEMA = {
  raySteps: { def: 150, min: 32, max: 220, kind: 'count', rebuild: 'live' },
  detail: { def: 0.001, min: 0.0002, max: 0.006, kind: 'unit', rebuild: 'live' },
  brightness: { def: 1.2, min: 0.2, max: 3, kind: 'ratio', rebuild: 'live' },
  gamma: { def: 1.4, min: 0.5, max: 3, kind: 'ratio', rebuild: 'live' },
  saturation: { def: 0.65, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  edgeGain: { def: 15, min: 0, max: 40, kind: 'ratio', rebuild: 'live' },
  waveAmp: { def: 0.15, min: 0, max: 0.6, kind: 'unit', rebuild: 'live' },
  sunSize: { def: 7, min: 1, max: 12, kind: 'unit', rebuild: 'live' },
  sunPump: { def: 5, min: 0, max: 10, kind: 'unit', rebuild: 'live' },
  sunBand: { def: 0.6, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  sunSpin: { def: 1.5, min: 0, max: 4, kind: 'ratio', rebuild: 'live' },
  fov: { def: 0.9, min: 0.2, max: 2, kind: 'unit', rebuild: 'live' },
  fovPump: { def: 0.7, min: 0, max: 1.5, kind: 'unit', rebuild: 'live' },
  camSpeed: { def: 1.5, min: 0, max: 4, kind: 'ratio', rebuild: 'live' },
  timeScale: { def: 0.5, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  catSpeed: { def: 3, min: 0.2, max: 8, kind: 'ratio', rebuild: 'live' },
  border: { def: 1, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  audioDrive: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  renderScale: { def: 0.8, min: 0.5, max: 1, kind: 'ratio', rebuild: 'pass' },
  catOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  rainbowOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' }
};

function nyanTownParam(key) {
  var store = (typeof nyanTownTuning !== 'undefined') ? nyanTownTuning : null;
  if (store && store[key] !== undefined && store[key] !== null) return store[key];
  var spec = NYAN_TOWN_TUNING_SCHEMA[key];
  return spec ? spec.def : 0;
}

function nyanTownPresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === NYAN_TOWN_PRESET_INDEX;
}

// ---------------------------------------------------------------- the ported fragment

var NYAN_TOWN_PORT_LINES = [
  "// GLSL3: three r128 does not provide gl_FragColor, and the driver writes it in main().",
  "out vec4 outColor;",
  "#define gl_FragColor outColor",
  "",
  "uniform float uTimeScale;",
  "uniform float uRaySteps;",
  "uniform float uDetail;",
  "uniform float uBrightness;",
  "uniform float uGamma;",
  "uniform float uSaturation;",
  "uniform float uEdgeGain;",
  "uniform float uWaveAmp;",
  "uniform float uSunSize;",
  "uniform float uSunPump;",
  "uniform float uSunBand;",
  "uniform float uSunSpin;",
  "uniform float uFov;",
  "uniform float uFovPump;",
  "uniform float uCamSpeed;",
  "uniform float uNyan;",
  "uniform float uRainbow;",
  "uniform float uNyanSpeed;",
  "uniform float uBorder;",
  "uniform float uAudioDrive;",
  "",
  "// \"Fractal Cartoon\" - former \"DE edge detection\" by Kali",
  "",
  "// There are no lights and no AO, only color by normals and dark edges.",
  "",
  "// update: Nyan Cat cameo, thanks to code from mu6k: https://www.shadertoy.com/view/4dXGWH",
  "",
  "",
  "//#define SHOWONLYEDGES",
  "#define NYAN ",
  "#define WAVES",
  "#define BORDER",
  "",
  "#define RAY_STEPS int(uRaySteps)",
  "",
  "#define BRIGHTNESS uBrightness",
  "#define GAMMA uGamma",
  "#define SATURATION uSaturation",
  "",
  "",
  "#define detail uDetail",
  "#define t (iTime*uTimeScale)",
  "",
  "",
  "const vec3 origin=vec3(-1.,.7,0.);",
  "float det=0.0;",
  "",
  "",
  "// 2D rotation function",
  "mat2 rot(float a) {",
  "\treturn mat2(cos(a),sin(a),-sin(a),cos(a));\t",
  "}",
  "",
  "// \"Amazing Surface\" fractal",
  "vec4 formula(vec4 p) {",
  "\t\tp.xz = abs(p.xz+1.)-abs(p.xz-1.)-p.xz;",
  "\t\tp.y-=.25;",
  "\t\tp.xy*=rot(radians(35.));",
  "\t\tp=p*2./clamp(dot(p.xyz,p.xyz),.2,1.);",
  "\treturn p;",
  "}",
  "",
  "// Distance function",
  "float de(vec3 pos) {",
  "#ifdef WAVES",
  "\tpos.y+=sin(pos.z-t*6.)*uWaveAmp; //waves!",
  "#endif",
  "\tfloat hid=0.;",
  "\tvec3 tpos=pos;",
  "\ttpos.z=abs(3.-mod(tpos.z,6.));",
  "\tvec4 p=vec4(tpos,1.);",
  "\tfor (int i=0; i<4; i++) {p=formula(p);}",
  "\tfloat fr=(length(max(vec2(0.),p.yz-1.5))-1.)/p.w;",
  "\tfloat ro=max(abs(pos.x+1.)-.3,pos.y-.35);",
  "\t\t  ro=max(ro,-max(abs(pos.x+1.)-.1,pos.y-.5));",
  "\tpos.z=abs(.25-mod(pos.z,.5));",
  "\t\t  ro=max(ro,-max(abs(pos.z)-.2,pos.y-.3));",
  "\t\t  ro=max(ro,-max(abs(pos.z)-.01,-pos.y+.32));",
  "\tfloat d=min(fr,ro);",
  "\treturn d;",
  "}",
  "",
  "",
  "// Camera path",
  "vec3 path(float ti) {",
  "\tti*=uCamSpeed;",
  "\tvec3  p=vec3(sin(ti),(1.-sin(ti*2.))*.5,-ti*5.)*.5;",
  "\treturn p;",
  "}",
  "",
  "// Calc normals, and here is edge detection, set to variable \"edge\"",
  "",
  "float edge=0.;",
  "vec3 normal(vec3 p) { ",
  "\tvec3 e = vec3(0.0,det*5.,0.0);",
  "",
  "\tfloat d1=de(p-e.yxx),d2=de(p+e.yxx);",
  "\tfloat d3=de(p-e.xyx),d4=de(p+e.xyx);",
  "\tfloat d5=de(p-e.xxy),d6=de(p+e.xxy);",
  "\tfloat d=de(p);",
  "\tedge=abs(d-0.5*(d2+d1))+abs(d-0.5*(d4+d3))+abs(d-0.5*(d6+d5));//edge finder",
  "\tedge=min(1.,pow(edge,.55)*uEdgeGain);",
  "\treturn normalize(vec3(d1-d2,d3-d4,d5-d6));",
  "}",
  "",
  "",
  "// Used Nyan Cat code by mu6k, with some mods",
  "",
  "vec4 rainbow(vec2 p)",
  "{",
  "\tfloat q = max(p.x,-0.1);",
  "\tfloat s = sin(p.x*7.0+t*70.0)*0.08;",
  "\tp.y+=s;",
  "\tp.y*=1.1;",
  "\t",
  "\tvec4 c;",
  "\tif (p.x>0.0) c=vec4(0,0,0,0); else",
  "\tif (0.0/6.0<p.y&&p.y<1.0/6.0) c= vec4(255,43,14,255)/255.0; else",
  "\tif (1.0/6.0<p.y&&p.y<2.0/6.0) c= vec4(255,168,6,255)/255.0; else",
  "\tif (2.0/6.0<p.y&&p.y<3.0/6.0) c= vec4(255,244,0,255)/255.0; else",
  "\tif (3.0/6.0<p.y&&p.y<4.0/6.0) c= vec4(51,234,5,255)/255.0; else",
  "\tif (4.0/6.0<p.y&&p.y<5.0/6.0) c= vec4(8,163,255,255)/255.0; else",
  "\tif (5.0/6.0<p.y&&p.y<6.0/6.0) c= vec4(122,85,255,255)/255.0; else",
  "\tif (abs(p.y)-.05<0.0001) c=vec4(0.,0.,0.,1.); else",
  "\tif (abs(p.y-1.)-.05<0.0001) c=vec4(0.,0.,0.,1.); else",
  "\t\tc=vec4(0,0,0,0);",
  "\tc.a*=.8-min(.8,abs(p.x*.08));",
  "\tc.xyz=mix(c.xyz,vec3(length(c.xyz)),.15);",
  "\treturn c;",
  "}",
  "",
  "vec4 nyan(vec2 p)",
  "{",
  "\tvec2 uv = p*vec2(0.4,1.0);",
  "\tfloat ns=uNyanSpeed;",
  "\tfloat nt = iTime*ns; nt-=mod(nt,240.0/256.0/6.0); nt = mod(nt,240.0/256.0);",
  "\tfloat ny = mod(iTime*ns,1.0); ny-=mod(ny,0.75); ny*=-0.05;",
  "\tvec4 color = texture(iChannel1,vec2(uv.x/3.0+210.0/256.0-nt+0.05,1.-.5+uv.y+ny));",
  "\tif (uv.x<-0.3) color.a = 0.0;",
  "\tif (uv.x>0.2) color.a=0.0;",
  "\tif (uv.y>.3) color.a=0.0;",
  "\tif (uv.y<-.3) color.a=0.0;",
  "\treturn color;",
  "}",
  "",
  "",
  "// Raymarching and 2D graphics",
  "",
  "vec3 raymarch(in vec3 from, in vec3 dir) ",
  "",
  "{",
  "\tedge=0.;",
  "\tvec3 p, norm;",
  "\tfloat d=100.;",
  "\tfloat totdist=0.;",
  "\tfor (int i=0; i<RAY_STEPS; i++) {",
  "\t\tif (d>det && totdist<25.0) {",
  "\t\t\tp=from+totdist*dir;",
  "\t\t\td=de(p);",
  "\t\t\tdet=detail*exp(.13*totdist);",
  "\t\t\ttotdist+=d; ",
  "\t\t}",
  "\t}",
  "\tvec3 col=vec3(0.);",
  "\tp-=(det-d)*dir;",
  "\tnorm=normal(p);",
  "#ifdef SHOWONLYEDGES",
  "\tcol=1.-vec3(edge); // show wireframe version",
  "#else",
  "\tcol=(1.-abs(norm))*max(0.,1.-edge*.8); // set normal as color with dark edges",
  "#endif\t\t",
  "\ttotdist=clamp(totdist,0.,26.);",
  "\tdir.y-=.02;",
  "\tfloat sunsize=uSunSize-max(0.,texture(iChannel0,vec2(uSunBand,.5)).x*uAudioDrive)*uSunPump; // responsive sun size",
  "\tfloat an=atan(dir.x,dir.y)+iTime*uSunSpin; // angle for drawing and rotating sun",
  "\tfloat s=pow(clamp(1.0-length(dir.xy)*sunsize-abs(.2-mod(an,.4)),0.,1.),.1); // sun",
  "\tfloat sb=pow(clamp(1.0-length(dir.xy)*(sunsize-.2)-abs(.2-mod(an,.4)),0.,1.),.1); // sun border",
  "\tfloat sg=pow(clamp(1.0-length(dir.xy)*(sunsize-4.5)-.5*abs(.2-mod(an,.4)),0.,1.),3.); // sun rays",
  "\tfloat y=mix(.45,1.2,pow(smoothstep(0.,1.,.75-dir.y),2.))*(1.-sb*.5); // gradient sky",
  "\t",
  "\t// set up background with sky and sun",
  "\tvec3 backg=vec3(0.5,0.,1.)*((1.-s)*(1.-sg)*y+(1.-sb)*sg*vec3(1.,.8,0.15)*3.);",
  "\t\t backg+=vec3(1.,.9,.1)*s;",
  "\t\t backg=max(backg,sg*vec3(1.,.9,.5));",
  "\t",
  "\tcol=mix(vec3(1.,.9,.3),col,exp(-.004*totdist*totdist));// distant fading to sun color",
  "\tif (totdist>25.) col=backg; // hit background",
  "\tcol=pow(col,vec3(GAMMA))*BRIGHTNESS;",
  "\tcol=mix(vec3(length(col)),col,SATURATION);",
  "#ifdef SHOWONLYEDGES",
  "\tcol=1.-vec3(length(col));",
  "#else",
  "\tcol*=vec3(1.,.9,.85);",
  "#ifdef NYAN",
  "\tif (uNyan>.5) {",
  "\tdir.yx*=rot(dir.x);",
  "\tvec2 ncatpos=(dir.xy+vec2(-3.+mod(-t,6.),-.27));",
  "\tif (uRainbow>.5) {",
  "\tvec4 rain=rainbow(ncatpos*10.+vec2(.8,.5));",
  "\tif (totdist>8.) col=mix(col,max(vec3(.2),rain.xyz),rain.a*.9);",
  "\t}",
  "\tvec4 ncat=nyan(ncatpos*5.);",
  "\tif (totdist>8.) col=mix(col,max(vec3(.2),ncat.xyz),ncat.a*.9);",
  "\t}",
  "#endif",
  "#endif",
  "\treturn col;",
  "}",
  "",
  "// get camera position",
  "vec3 move(inout vec3 dir) {",
  "\tvec3 go=path(t);",
  "\tvec3 adv=path(t+.7);",
  "\tfloat hd=de(adv);",
  "\tvec3 advec=normalize(adv-go);",
  "\tfloat an=adv.x-go.x; an*=min(1.,abs(adv.z-go.z))*sign(adv.z-go.z)*.7;",
  "\tdir.xy*=mat2(cos(an),sin(an),-sin(an),cos(an));",
  "    an=advec.y*1.7;",
  "\tdir.yz*=mat2(cos(an),sin(an),-sin(an),cos(an));",
  "\tan=atan(advec.x,advec.z);",
  "\tdir.xz*=mat2(cos(an),sin(an),-sin(an),cos(an));",
  "\treturn go;",
  "}",
  "",
  "void mainImage( out vec4 fragColor, in vec2 fragCoord )",
  "{",
  "\tvec2 uv = fragCoord.xy / iResolution.xy*2.-1.;",
  "\tvec2 oriuv=uv;",
  "\tuv.y*=iResolution.y/iResolution.x;",
  "\tvec2 mouse=(iMouse.xy/iResolution.xy-.5)*3.;",
  "\tif (iMouse.z<1.) mouse=vec2(0.,-0.05);",
  "\tfloat fov=uFov-max(0.,uFovPump-iTime*.3);",
  "\tvec3 dir=normalize(vec3(uv*fov,1.));",
  "\tdir.yz*=rot(mouse.y);",
  "\tdir.xz*=rot(mouse.x);",
  "\tvec3 from=origin+move(dir);",
  "\tvec3 color=raymarch(from,dir); ",
  "\t#ifdef BORDER",
  "\tcolor=mix(vec3(0.),color,pow(max(0.,.95-length(oriuv*oriuv*oriuv*vec2(1.05,1.1))),.3)*uBorder);",
  "\t#endif",
  "\tfragColor = vec4(color,1.);",
  "}",
];

var NYAN_TOWN_PORT_BODY = NYAN_TOWN_PORT_LINES.join('\n');

var NYAN_TOWN_BLIT_VS = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = vec4(position.xy, 0.999999, 1.0);',
  '}'
].join('\n');

// The reference already applies gamma, brightness, saturation and its own border; copy it as is.
var NYAN_TOWN_BLIT_FS = [
  'precision highp float;',
  'uniform sampler2D tDiffuse;',
  'varying vec2 vUv;',
  'void main() {',
  '  gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0);',
  '}'
].join('\n');

// ---------------------------------------------------------------- iChannel0: 64-bin spectrum

var NYAN_TOWN_BINS = 64;
var nyanTownLevelState = { level: new Float32Array(NYAN_TOWN_BINS) };

function nyanTownClamp01(value) {
  var n = Number(value);
  return !isFinite(n) ? 0 : Math.min(1, Math.max(0, n));
}

function nyanTownSpectrumIndex(bin) {
  var n = (typeof frequencyData !== 'undefined' && frequencyData && frequencyData.length) ? frequencyData.length : 0;
  if (!n) return 0;
  var t = Math.pow(n, Math.max(0, Math.min(1, bin / (NYAN_TOWN_BINS - 1))));
  return Math.min(n - 1, Math.max(0, Math.floor(t)));
}

function nyanTownBandValues(frame) {
  var out = new Float32Array(8);
  if (frame && (frame.sonicDetailed || frame.subBass !== undefined)) {
    out[0] = Number(frame.subBass) || 0;
    out[1] = Number(frame.bass) || 0;
    out[2] = Number(frame.lowMid) || 0;
    out[3] = Number(frame.mid) || 0;
    out[4] = Number(frame.highMid) || 0;
    out[5] = Number(frame.presence) || 0;
    out[6] = Number(frame.brilliance) || 0;
    out[7] = Number(frame.air) || 0;
    return out;
  }
  var bassNow = (typeof bass !== 'undefined' && isFinite(bass)) ? Number(bass) : 0;
  var midNow = (typeof mid !== 'undefined' && isFinite(mid)) ? Number(mid) : 0;
  var trebleNow = (typeof treble !== 'undefined' && isFinite(treble)) ? Number(treble) : 0;
  out[0] = bassNow * 0.9;
  out[1] = bassNow;
  out[2] = midNow * 0.7;
  out[3] = midNow;
  out[4] = midNow * 0.8;
  out[5] = trebleNow * 0.7;
  out[6] = trebleNow;
  out[7] = trebleNow * 0.8;
  return out;
}

function nyanTownFillSpectrum(frame, smooth) {
  var k = Math.max(0.06, 1 - Math.min(0.95, Math.max(0, Number(smooth) || 0)) * 0.85);
  var hasFft = typeof frequencyData !== 'undefined' && frequencyData && frequencyData.length > 4;
  var bands = hasFft ? null : nyanTownBandValues(frame);
  var level = nyanTownLevelState.level;
  for (var j = 0; j < NYAN_TOWN_BINS; j++) {
    var target = 0;
    if (hasFft) {
      target = frequencyData[nyanTownSpectrumIndex(j)] / 255;
    } else if (bands) {
      var t = j / (NYAN_TOWN_BINS - 1);
      var a = bands[Math.min(7, Math.floor(t * 8))];
      var b = bands[Math.min(7, Math.floor(t * 8) + 1)];
      target = (a + (b - a) * ((t * 8) % 1)) * (1 - t * 0.35);
    }
    level[j] += (nyanTownClamp01(target) - level[j]) * k;
  }
  return level;
}

function nyanTownWriteSpectrum(data, level) {
  for (var j = 0; j < NYAN_TOWN_BINS; j++) {
    var off = j * 4;
    data[off] = Math.round(level[j] * 255);
    data[off + 1] = Math.round(level[j] * 255);
    data[off + 2] = Math.round((j / (NYAN_TOWN_BINS - 1)) * 255);
    data[off + 3] = 255;
  }
}

// ---------------------------------------------------------------- iChannel1: Nyan Cat sprite sheet
//
// The reference samples a 240x24 strip of six 40x24 frames, tiled horizontally (240/256 of the
// texture width). The original image could not be fetched, so the strip is painted here with the
// same frame size and the classic silhouette (pop-tart body, grey head, wagging tail, animated
// legs). Keeping the exact frame size is what makes the reference's UV arithmetic land on one
// frame at a time.

var NYAN_TOWN_SPRITE_FRAME_W = 40;
var NYAN_TOWN_SPRITE_FRAME_H = 24;
var NYAN_TOWN_SPRITE_FRAMES = 6;
var NYAN_TOWN_SPRITE_TEXTURE_W = 256;

function nyanTownSpriteRect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function nyanTownPaintSpriteFrame(ctx, ox, frame) {
  var bob = frame % 2;
  var tail = [0, -1, 0, 1, 1, 0][frame];
  var ear = frame === 3 ? 1 : 0;
  // The art fills the 40 px frame edge to edge, like the reference sheet: the sampled window is
  // ~42.7 px, so a frame boundary always falls inside it. Full-bleed adjacent frames (which share
  // the same body/head positions) read as one cat across the seam instead of leaving a gap.
  nyanTownSpriteRect(ctx, ox + 0, 12 + tail, 6, 4, '#8e8e8e');
  nyanTownSpriteRect(ctx, ox + 0, 12 + tail, 2, 4, '#5f5f5f');
  nyanTownSpriteRect(ctx, ox + 5, 12 + tail, 1, 2, '#bdbdbd');
  nyanTownSpriteRect(ctx, ox + 8, 18, 3, 4 - bob, '#8e8e8e');
  nyanTownSpriteRect(ctx, ox + 8, 21 - bob, 3, 1, '#f0f0f0');
  nyanTownSpriteRect(ctx, ox + 15, 18, 3, 3 + bob, '#8e8e8e');
  nyanTownSpriteRect(ctx, ox + 15, 21, 3, 1, '#f0f0f0');
  nyanTownSpriteRect(ctx, ox + 5, 7, 15, 13, '#d9a070');
  nyanTownSpriteRect(ctx, ox + 6, 8, 13, 11, '#f19cb7');
  nyanTownSpriteRect(ctx, ox + 6, 8, 13, 1, '#f7bfd0');
  var sprinkles = [
    [7, 10, '#ff3b2b'], [10, 9, '#ffb000'], [13, 10, '#ffe600'], [16, 11, '#3fea2a'],
    [8, 13, '#18a8ff'], [12, 14, '#7a55ff'], [15, 15, '#ff3b2b'], [7, 16, '#ffe600'],
    [11, 17, '#ffb000'], [14, 17, '#3fea2a']
  ];
  for (var i = 0; i < sprinkles.length; i++) {
    nyanTownSpriteRect(ctx, ox + sprinkles[i][0], sprinkles[i][1], 1, 1, sprinkles[i][2]);
  }
  nyanTownSpriteRect(ctx, ox + 20, 5, 14, 13, '#2b2b2b');
  nyanTownSpriteRect(ctx, ox + 19, 8, 16, 7, '#2b2b2b');
  nyanTownSpriteRect(ctx, ox + 21, 4 - ear, 3, 2 + ear, '#2b2b2b');
  nyanTownSpriteRect(ctx, ox + 31, 4 - ear, 3, 2 + ear, '#2b2b2b');
  nyanTownSpriteRect(ctx, ox + 21, 6, 12, 11, '#9a9a9a');
  nyanTownSpriteRect(ctx, ox + 20, 9, 14, 5, '#9a9a9a');
  nyanTownSpriteRect(ctx, ox + 22, 5 - ear, 2, 1 + ear, '#9a9a9a');
  nyanTownSpriteRect(ctx, ox + 32, 5 - ear, 2, 1 + ear, '#9a9a9a');
  nyanTownSpriteRect(ctx, ox + 23, 8, 9, 7, '#f4f4f4');
  nyanTownSpriteRect(ctx, ox + 24, 7, 7, 9, '#f4f4f4');
  nyanTownSpriteRect(ctx, ox + 22, 5 - ear, 1, 1, '#f19cb7');
  nyanTownSpriteRect(ctx, ox + 33, 5 - ear, 1, 1, '#f19cb7');
  nyanTownSpriteRect(ctx, ox + 29, 9, 2, 3, '#111111');
  nyanTownSpriteRect(ctx, ox + 29, 9, 1, 1, '#ffffff');
  nyanTownSpriteRect(ctx, ox + 26, 13, 2, 1, '#f19cb7');
  nyanTownSpriteRect(ctx, ox + 34, 12, 1, 1, '#111111');
  nyanTownSpriteRect(ctx, ox + 34, 14, 1, 1, '#111111');
  nyanTownSpriteRect(ctx, ox + 18, 14, 2, 3, '#9a9a9a');
}

function nyanTownMakeSpriteCanvas() {
  var canvas = document.createElement('canvas');
  // 6 frames of 40 px inside a 256 px texture: the reference's 240/256 and 210/256 constants
  // assume this width, and the unused 16 px tail keeps the wrap clean.
  canvas.width = NYAN_TOWN_SPRITE_TEXTURE_W;
  canvas.height = NYAN_TOWN_SPRITE_FRAME_H;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (var i = 0; i < NYAN_TOWN_SPRITE_FRAMES; i++) {
    nyanTownPaintSpriteFrame(ctx, i * NYAN_TOWN_SPRITE_FRAME_W, i);
  }
  return canvas;
}

// ---------------------------------------------------------------- resources

var nyanTownState = {
  built: false, quadScene: null, quadCam: null, quad: null, mat: null,
  blitScene: null, blitCam: null, blitMat: null,
  rt: null, rtW: 0, rtH: 0, passScale: 0,
  levelData: null, levelTex: null,
  spriteCanvas: null, spriteTex: null,
  frames: 0, lastCostMs: 0, error: '',
  size: null
};

function nyanTownInitialUniforms() {
  return {
    iResolution: shadertoyUvUniforms(1, 1),
    iTime: { value: 0 },
    iFrame: { value: 0 },
    iMouse: { value: [0, 0, 0, 0] },
    iChannel0: { value: null },
    iChannel1: { value: null },
    uTimeScale: { value: 0.5 },
    uRaySteps: { value: 150 },
    uDetail: { value: 0.001 },
    uBrightness: { value: 1.2 },
    uGamma: { value: 1.4 },
    uSaturation: { value: 0.65 },
    uEdgeGain: { value: 15 },
    uWaveAmp: { value: 0.15 },
    uSunSize: { value: 7 },
    uSunPump: { value: 5 },
    uSunBand: { value: 0.6 },
    uSunSpin: { value: 1.5 },
    uFov: { value: 0.9 },
    uFovPump: { value: 0.7 },
    uCamSpeed: { value: 1.5 },
    uNyan: { value: 1 },
    uRainbow: { value: 1 },
    uNyanSpeed: { value: 3 },
    uBorder: { value: 1 },
    uAudioDrive: { value: 1 }
  };
}

function nyanTownBuildScene() {
  if (nyanTownState.built) return true;
  if (typeof THREE === 'undefined' || typeof renderer === 'undefined' || !renderer) return false;
  try {
    nyanTownState.size = new THREE.Vector2(1, 1);
    var levelData = new Uint8Array(NYAN_TOWN_BINS * 4);
    var levelTex = new THREE.DataTexture(levelData, NYAN_TOWN_BINS, 1,
      THREE.RGBAFormat, THREE.UnsignedByteType);
    levelTex.magFilter = THREE.LinearFilter;
    levelTex.minFilter = THREE.LinearFilter;
    levelTex.needsUpdate = true;

    var spriteCanvas = nyanTownMakeSpriteCanvas();
    var spriteTex = new THREE.CanvasTexture(spriteCanvas);
    spriteTex.wrapS = THREE.RepeatWrapping;
    spriteTex.wrapT = THREE.ClampToEdgeWrapping;
    spriteTex.magFilter = THREE.NearestFilter;
    spriteTex.minFilter = THREE.NearestFilter;
    spriteTex.generateMipmaps = false;
    spriteTex.needsUpdate = true;

    var uniforms = nyanTownInitialUniforms();
    uniforms.iChannel0.value = levelTex;
    uniforms.iChannel1.value = spriteTex;
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.999999, 1.0); }',
      fragmentShader: shadertoyFragment(NYAN_TOWN_PORT_BODY, { channels: 2 }),
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false
    });
    var quadScene = new THREE.Scene();
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    quadScene.add(quad);

    var blitMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: NYAN_TOWN_BLIT_VS,
      fragmentShader: NYAN_TOWN_BLIT_FS,
      depthTest: false,
      depthWrite: false
    });
    var blitScene = new THREE.Scene();
    var blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
    blitQuad.frustumCulled = false;
    blitScene.add(blitQuad);

    nyanTownState.levelData = levelData;
    nyanTownState.levelTex = levelTex;
    nyanTownState.spriteCanvas = spriteCanvas;
    nyanTownState.spriteTex = spriteTex;
    nyanTownState.mat = mat;
    nyanTownState.quadScene = quadScene;
    nyanTownState.quadCam = quadCam;
    nyanTownState.quad = quad;
    nyanTownState.blitMat = blitMat;
    nyanTownState.blitScene = blitScene;
    nyanTownState.blitCam = blitCam;
    nyanTownLevelState.level.fill(0);
    nyanTownWriteSpectrum(levelData, nyanTownLevelState.level);
    nyanTownState.built = true;
    return true;
  } catch (err) {
    nyanTownState.error = String(err && (err.message || err)).slice(0, 200);
    return false;
  }
}

function nyanTownAlignPassSize() {
  if (typeof renderer === 'undefined' || !renderer || !nyanTownState.mat) return false;
  renderer.getDrawingBufferSize(nyanTownState.size);
  var scale = Math.min(1, Math.max(0.4, nyanTownParam('renderScale')));
  var w = Math.max(32, Math.round((nyanTownState.size.x || 1) * scale));
  var h = Math.max(32, Math.round((nyanTownState.size.y || 1) * scale));
  if (nyanTownState.rt && nyanTownState.rtW === w && nyanTownState.rtH === h && nyanTownState.passScale === scale) return true;
  if (!nyanTownState.rt) {
    nyanTownState.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
  } else {
    nyanTownState.rt.setSize(w, h);
  }
  nyanTownState.rtW = w;
  nyanTownState.rtH = h;
  nyanTownState.passScale = scale;
  nyanTownState.mat.uniforms.iResolution.value = shadertoyUvUniforms(w, h).value;
  nyanTownState.blitMat.uniforms.tDiffuse.value = nyanTownState.rt.texture;
  return true;
}

// ---------------------------------------------------------------- per-frame

function nyanTownUpdateLevels(frame, dt) {
  nyanTownFillSpectrum(frame, 0.6);
  nyanTownWriteSpectrum(nyanTownState.levelData, nyanTownLevelState.level);
  nyanTownState.levelTex.needsUpdate = true;
  return true;
}

function nyanTownFeedUniforms() {
  if (!nyanTownState.mat) return;
  var u = nyanTownState.mat.uniforms;
  u.uTimeScale.value = Math.max(0, nyanTownParam('timeScale'));
  u.uRaySteps.value = Math.max(8, Math.min(220, nyanTownParam('raySteps')));
  u.uDetail.value = Math.max(0.0001, nyanTownParam('detail'));
  u.uBrightness.value = Math.max(0, nyanTownParam('brightness'));
  u.uGamma.value = Math.max(0.2, nyanTownParam('gamma'));
  u.uSaturation.value = Math.max(0, Math.min(2, nyanTownParam('saturation')));
  u.uEdgeGain.value = Math.max(0, nyanTownParam('edgeGain'));
  u.uWaveAmp.value = Math.max(0, nyanTownParam('waveAmp'));
  u.uSunSize.value = Math.max(0.5, nyanTownParam('sunSize'));
  u.uSunPump.value = Math.max(0, nyanTownParam('sunPump'));
  u.uSunBand.value = Math.max(0, Math.min(1, nyanTownParam('sunBand')));
  u.uSunSpin.value = Math.max(0, nyanTownParam('sunSpin'));
  u.uFov.value = Math.max(0.05, nyanTownParam('fov'));
  u.uFovPump.value = Math.max(0, nyanTownParam('fovPump'));
  u.uCamSpeed.value = Math.max(0, nyanTownParam('camSpeed'));
  u.uNyan.value = nyanTownParam('catOn') > 0 ? 1 : 0;
  u.uRainbow.value = nyanTownParam('rainbowOn') > 0 ? 1 : 0;
  u.uNyanSpeed.value = Math.max(0.01, nyanTownParam('catSpeed'));
  u.uBorder.value = Math.max(0, Math.min(1, nyanTownParam('border')));
  u.uAudioDrive.value = Math.max(0, nyanTownParam('audioDrive'));
}

function updateNyanTownLayer(now, dt, sonicFrame) {
  if (!nyanTownPresetIsActive()) return false;
  var startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  if (!nyanTownState.built && !nyanTownBuildScene()) return false;
  var step = Math.max(0, Math.min(0.12, Number(dt) || 0));
  nyanTownUpdateLevels(sonicFrame, step);
  nyanTownFeedUniforms();
  nyanTownState.frames++;
  nyanTownState.lastCostMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - startedAt;
  void now;
  return true;
}

function renderNyanTownFrame() {
  if (!nyanTownPresetIsActive()) return false;
  if (typeof renderer === 'undefined' || !renderer) return false;
  if (!nyanTownState.built && !nyanTownBuildScene()) return false;
  if (!nyanTownAlignPassSize()) return false;
  // The reference's whole scene is time-driven; use the song clock so pausing the music freezes
  // the town (the sun still follows the spectrum, which is silent when paused).
  var clock = (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) ? Number(audio.currentTime) : 0;
  nyanTownState.mat.uniforms.iTime.value = clock;
  nyanTownState.mat.uniforms.iFrame.value = nyanTownState.frames | 0;
  try {
    renderer.setRenderTarget(nyanTownState.rt);
    renderer.render(nyanTownState.quadScene, nyanTownState.quadCam);
    renderer.setRenderTarget(null);
    renderer.render(nyanTownState.blitScene, nyanTownState.blitCam);
  } catch (err) {
    try { renderer.setRenderTarget(null); } catch (ignored) { /* already off-target */ }
    nyanTownState.error = String((err && (err.message || err)) || err).slice(0, 200);
    return false;
  }
  return true;
}

function nyanTownDisposeScene() {
  if (nyanTownState.levelTex) nyanTownState.levelTex.dispose();
  if (nyanTownState.spriteTex) nyanTownState.spriteTex.dispose();
  if (nyanTownState.mat) nyanTownState.mat.dispose();
  if (nyanTownState.blitMat) nyanTownState.blitMat.dispose();
  if (nyanTownState.quad && nyanTownState.quad.geometry) nyanTownState.quad.geometry.dispose();
  if (nyanTownState.blitScene && nyanTownState.blitScene.children[0] && nyanTownState.blitScene.children[0].geometry) {
    nyanTownState.blitScene.children[0].geometry.dispose();
  }
  if (nyanTownState.rt) nyanTownState.rt.dispose();
  if (nyanTownState.quadScene) nyanTownState.quadScene.clear();
  if (nyanTownState.blitScene) nyanTownState.blitScene.clear();
  nyanTownState.built = false;
  nyanTownState.quadScene = null;
  nyanTownState.quadCam = null;
  nyanTownState.quad = null;
  nyanTownState.mat = null;
  nyanTownState.blitScene = null;
  nyanTownState.blitCam = null;
  nyanTownState.blitMat = null;
  nyanTownState.rt = null;
  nyanTownState.rtW = 0;
  nyanTownState.rtH = 0;
  nyanTownState.passScale = 0;
  nyanTownState.levelData = null;
  nyanTownState.levelTex = null;
  nyanTownState.spriteCanvas = null;
  nyanTownState.spriteTex = null;
  nyanTownState.frames = 0;
  nyanTownState.lastCostMs = 0;
  nyanTownState.error = '';
}

function nyanTownStatus() {
  return {
    active: nyanTownPresetIsActive(), built: nyanTownState.built,
    frames: nyanTownState.frames, costMs: Math.round(nyanTownState.lastCostMs * 100) / 100,
    error: nyanTownState.error,
    passScale: nyanTownState.passScale, rt: [nyanTownState.rtW, nyanTownState.rtH],
    raySteps: nyanTownParam('raySteps'),
    nyan: nyanTownParam('catOn') > 0
  };
}

function applyNyanTownPresetNow(prev, next) {
  var on = Number(next) === NYAN_TOWN_PRESET_INDEX;
  var was = Number(prev) === NYAN_TOWN_PRESET_INDEX;
  if (on) {
    nyanTownBuildScene();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('nyan-town-preset');
  } else if (was) {
    nyanTownDisposeScene();
  }
  return on;
}

// The reference has no lyrics; the town is the whole picture.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'nyan-town',
    isActive: nyanTownPresetIsActive,
    suppresses: {
      particles: true, bloom: true, float: true, backCover: true,
      starRiver: true, ripples: true, lyricsParticles: true, stageLyrics: true
    }
  });
}
