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
  rainbowOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  // ---- the lyric lane: lines fly through the town and are depth-tested against the march
  lyricOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  lyricRows: { def: 10, min: 3, max: 16, kind: 'count', rebuild: 'live' },
  lyricSize: { def: 1, min: 0.4, max: 2, kind: 'ratio', rebuild: 'live' },
  lyricSpeed: { def: 1, min: 0.4, max: 2.5, kind: 'ratio', rebuild: 'live' },
  lyricLead: { def: 4.5, min: 0, max: 8, kind: 'sec', rebuild: 'live' },
  lyricDepthNear: { def: 4, min: 1.5, max: 12, kind: 'unit', rebuild: 'live' },
  lyricDepthFar: { def: 20, min: 8, max: 32, kind: 'unit', rebuild: 'live' },
  lyricSpread: { def: 1, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  lyricRoll: { def: 10, min: 0, max: 40, kind: 'deg', rebuild: 'live' },
  lyricOpacity: { def: 1, min: 0.2, max: 1, kind: 'ratio', rebuild: 'live' },
  lyricOcclusion: { def: 0.012, min: 0, max: 0.05, kind: 'unit', rebuild: 'live' }
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
  "float nyanDepth=1.0;",
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
  "\tnyanDepth=clamp(totdist/25.,0.,1.); // 0 near .. 1 far, for the lyric depth test",
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
  "\tfragColor = vec4(color,nyanDepth);",
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

// The scene pass already applied gamma, brightness, saturation and the border. The last pass is a
// depth-aware composite: the scene's alpha carries the march hit distance, the lyric pass carries
// premultiplied text plus a depth plane, and a lyric pixel only survives where it is in front of the
// town. The same border mask keeps text out of the rounded black corners.
var NYAN_TOWN_BLIT_FS = [
  'precision highp float;',
  'uniform sampler2D tScene;',
  'uniform sampler2D tLyric;',
  'uniform sampler2D tLyricDepth;',
  'uniform float uOcclusion;',
  'uniform float uLyricOn;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec4 scene = texture2D(tScene, vUv);',
  '  vec4 lyric = texture2D(tLyric, vUv);',
  '  float lyricDepth = texture2D(tLyricDepth, vUv).r;',
  '  vec2 oriuv = vUv * 2.0 - 1.0;',
  '  float border = pow(max(0.0, 0.95 - length(oriuv * oriuv * oriuv * vec2(1.05, 1.1))), 0.3);',
  '  float soft = max(0.0005, uOcclusion);',
  '  float visible = 1.0 - smoothstep(scene.a - soft, scene.a + soft, lyricDepth);',
  '  float m = visible * border * uLyricOn;',
  '  float a = lyric.a * m;',
  '  vec3 rgb = scene.rgb * (1.0 - a) + lyric.rgb * m;',
  '  gl_FragColor = vec4(rgb, 1.0);',
  '}'
].join('\n');

var NYAN_TOWN_DEPTH_VS = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

var NYAN_TOWN_DEPTH_FS = [
  'precision highp float;',
  'uniform float uDepth;',
  'varying vec2 vUv;',
  'void main() {',
  '  gl_FragColor = vec4(uDepth, uDepth, uDepth, 1.0);',
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
  // The reference's alpha window only samples y = 0.5 + uv.y + ny with uv.y in [-.3,.3] and
  // ny in [-.0375,0], i.e. canvas rows 5..19 of the 24 px sheet (CanvasTexture flips Y). The whole
  // cat — ears and feet included — has to stay inside that band or the cutoffs eat them.
  nyanTownSpriteRect(ctx, ox + 0, 12 + tail, 6, 4, '#8e8e8e');
  nyanTownSpriteRect(ctx, ox + 0, 12 + tail, 2, 4, '#5f5f5f');
  nyanTownSpriteRect(ctx, ox + 5, 12 + tail, 1, 2, '#bdbdbd');
  nyanTownSpriteRect(ctx, ox + 8, 17, 3, 3 - bob, '#8e8e8e');
  nyanTownSpriteRect(ctx, ox + 8, 19 - bob, 3, 1, '#f0f0f0');
  nyanTownSpriteRect(ctx, ox + 15, 17, 3, 2 + bob, '#8e8e8e');
  nyanTownSpriteRect(ctx, ox + 15, 18 + bob, 3, 1, '#f0f0f0');
  nyanTownSpriteRect(ctx, ox + 5, 7, 15, 11, '#d9a070');
  nyanTownSpriteRect(ctx, ox + 6, 8, 13, 9, '#f19cb7');
  nyanTownSpriteRect(ctx, ox + 6, 8, 13, 1, '#f7bfd0');
  var sprinkles = [
    [7, 10, '#ff3b2b'], [10, 9, '#ffb000'], [13, 10, '#ffe600'], [16, 11, '#3fea2a'],
    [8, 13, '#18a8ff'], [12, 13, '#7a55ff'], [15, 14, '#ff3b2b'], [7, 15, '#ffe600'],
    [11, 16, '#ffb000'], [14, 16, '#3fea2a']
  ];
  for (var i = 0; i < sprinkles.length; i++) {
    nyanTownSpriteRect(ctx, ox + sprinkles[i][0], sprinkles[i][1], 1, 1, sprinkles[i][2]);
  }
  nyanTownSpriteRect(ctx, ox + 20, 6, 14, 12, '#2b2b2b');
  nyanTownSpriteRect(ctx, ox + 19, 9, 16, 5, '#2b2b2b');
  nyanTownSpriteRect(ctx, ox + 21 - ear, 5, 3, 2, '#2b2b2b');
  nyanTownSpriteRect(ctx, ox + 31 + ear, 5, 3, 2, '#2b2b2b');
  nyanTownSpriteRect(ctx, ox + 21, 7, 12, 10, '#9a9a9a');
  nyanTownSpriteRect(ctx, ox + 20, 9, 14, 5, '#9a9a9a');
  nyanTownSpriteRect(ctx, ox + 22 - ear, 5, 2, 1, '#9a9a9a');
  nyanTownSpriteRect(ctx, ox + 32 + ear, 5, 2, 1, '#9a9a9a');
  nyanTownSpriteRect(ctx, ox + 23, 8, 9, 7, '#f4f4f4');
  nyanTownSpriteRect(ctx, ox + 24, 7, 7, 9, '#f4f4f4');
  nyanTownSpriteRect(ctx, ox + 22 - ear, 5, 1, 1, '#f19cb7');
  nyanTownSpriteRect(ctx, ox + 33 + ear, 5, 1, 1, '#f19cb7');
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

// ---------------------------------------------------------------- the lyric lane
//
// Lines are camera-facing plates in a private scene: they fly from the far end of the town toward
// the eye, cross the screen on alternating sides and roll a little. The scene pass carries its hit
// distance in alpha, the lane carries one normalized depth per plate, and the final composite only
// keeps a text pixel where the text is in front of the town. That is what makes an arch cut a line
// in half instead of the line floating over everything.

function nyanTownClamp(value, lo, hi) {
  var n = Number(value);
  if (!isFinite(n)) n = lo;
  return Math.min(hi, Math.max(lo, n));
}

function nyanTownLyricTranslationOf(line) {
  if (!line) return '';
  if (typeof haloLyricTranslationOf === 'function') return haloLyricTranslationOf(line);
  if (typeof normalizeLyricTranslationText === 'function') return normalizeLyricTranslationText(line.translation);
  return String(line.translation || '').trim();
}

function nyanTownLyricItems() {
  var lines = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
  var offset = 0;
  if (typeof getActiveLyricTimingOffsetSeconds === 'function') offset = Number(getActiveLyricTimingOffsetSeconds()) || 0;
  var items = [];
  for (var i = 0; i < lines.length; i++) {
    var text = String((lines[i] && lines[i].text) || '').trim();
    if (!text) continue;
    items.push({
      index: i,
      text: text,
      sub: nyanTownLyricTranslationOf(lines[i]),
      startAt: Number(lines[i].t) + offset,
      endAt: 0
    });
  }
  for (var k = 0; k < items.length; k++) {
    items[k].endAt = k + 1 < items.length ? items[k + 1].startAt : items[k].startAt + 6;
  }
  return items;
}

function nyanTownLyricSongKey() {
  if (typeof haloCurrentSong === 'function') {
    try {
      var current = haloCurrentSong();
      return String((current && (current.id || current.name || current.title)) || '');
    } catch (_) {}
  }
  if (typeof currentTrack !== 'undefined' && currentTrack) {
    return String(currentTrack.id || currentTrack.name || currentTrack.title || '');
  }
  return '';
}

function nyanTownLyricListKey(items) {
  return nyanTownLyricSongKey() + '|' + items.length + '|' + (items.length ? items[0].text : '');
}

function nyanTownLyricDuration(item, speed) {
  var span = Math.max(0.1, Number(item && item.endAt) - Number(item && item.startAt));
  return nyanTownClamp((span + 1.8) * 2.2 / Math.max(0.2, Number(speed) || 1), 2.5, 16);
}

function nyanTownLyricSungIndex(items, t) {
  if (!items || !items.length) return -1;
  var found = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].startAt <= t) found = i; else break;
  }
  return found;
}

function nyanTownLyricFontStack() {
  if (typeof lyricFontStackForKey === 'function' && typeof fx !== 'undefined' && fx) {
    try {
      var stack = String(lyricFontStackForKey(fx.lyricFont) || '').trim();
      if (stack) return stack;
    } catch (_) {}
  }
  return '"JetBrains Mono","Microsoft YaHei",monospace';
}

function nyanTownLyricRasterPx() {
  var clarity = 1;
  if (typeof lyricTextureClarityScale === 'function') {
    clarity = Number(lyricTextureClarityScale()) || 1;
  } else if (typeof fx !== 'undefined' && fx && isFinite(Number(fx.lyricTextureClarity))) {
    clarity = Number(fx.lyricTextureClarity);
  }
  return Math.round(54 + 18 * nyanTownClamp(clarity, 1, 4));
}

function nyanTownLyricTranslationShown() {
  if (typeof lyricTranslationLayoutActive === 'function') {
    try { return !!lyricTranslationLayoutActive(); } catch (_) {}
  }
  return typeof fx !== 'undefined' && fx && String(fx.lyricTranslationMode || 'off') !== 'off';
}

function nyanTownLyricTranslationScale() {
  if (typeof lyricTranslationScaleValue === 'function') {
    try { return nyanTownClamp(lyricTranslationScaleValue(), 0.4, 1.1); } catch (_) {}
  }
  return 0.65;
}

function nyanTownLyricTranslationOpacity() {
  if (typeof lyricTranslationOpacityValue === 'function') {
    try { return nyanTownClamp(lyricTranslationOpacityValue(), 0.2, 1); } catch (_) {}
  }
  return 0.86;
}

function nyanTownLyricLineHeight() {
  if (typeof lyricLineHeightFactor === 'function') {
    try { return nyanTownClamp(lyricLineHeightFactor(), 0.72, 1.8); } catch (_) {}
  }
  return 1;
}

function nyanTownLyricPalette() {
  var pal = (typeof effectiveLyricPalette === 'function') ? effectiveLyricPalette(null) : null;
  pal = pal || {};
  var primary = pal.primary || '#d6f8ff';
  var highlight = pal.highlight || '#eef7ff';
  var context = pal.secondary || '#9cffdf';
  var glow = pal.glowColor || pal.glow || context;
  return {
    primary: primary, highlight: highlight, context: context, glow: glow,
    signature: [primary, highlight, context, glow].join(',')
  };
}

function nyanTownLyricStyleKey() {
  var pal = nyanTownLyricPalette();
  return [nyanTownLyricFontStack(), nyanTownLyricRasterPx(), nyanTownLyricTranslationShown() ? 1 : 0,
    nyanTownLyricTranslationScale().toFixed(2), nyanTownLyricTranslationOpacity().toFixed(2),
    nyanTownLyricLineHeight().toFixed(2), pal.signature].join('|');
}

// Greedy wrap, same policy as the rest of the lyric surfaces: Latin at spaces, CJK between glyphs.
function nyanTownLyricWrapText(ctx, text, maxWidth, maxLines) {
  var source = String(text || '');
  var out = [];
  var current = '';
  var limit = Math.max(1, Math.round(Number(maxLines) || 1));
  var truncated = false;
  for (var i = 0; i < source.length; i++) {
    var ch = source.charAt(i);
    var candidate = current + ch;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      var space = current.lastIndexOf(' ');
      if (space > 0 && ch !== ' ') {
        out.push(current.slice(0, space));
        current = current.slice(space + 1) + ch;
      } else {
        out.push(current);
        current = ch;
      }
      if (out.length >= limit) { current = ''; truncated = true; break; }
    } else {
      current = candidate;
    }
  }
  if (current && out.length < limit) out.push(current);
  if (!out.length) out.push('');
  if (truncated && out.length) {
    var lastIndex = out.length - 1;
    var last = String(out[lastIndex] || '');
    while (last.length > 0 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    out[lastIndex] = last + '…';
  }
  return out;
}

function nyanTownLyricRowCount() {
  if (!nyanTownState.lyricScene || !nyanTownState.lyricGeometry) return 0;
  var want = Math.round(nyanTownParam('lyricRows'));
  want = nyanTownClamp(want, 3, 16);
  while (nyanTownState.lyricRows.length < want) {
    var row = nyanTownMakeLyricRow();
    nyanTownState.lyricScene.add(row.mesh);
    nyanTownState.lyricDepthScene.add(row.depthMesh);
    nyanTownState.lyricRows.push(row);
  }
  while (nyanTownState.lyricRows.length > want) {
    var extra = nyanTownState.lyricRows.pop();
    nyanTownDisposeLyricRow(extra);
  }
  return nyanTownState.lyricRows.length;
}

function nyanTownMakeLyricRow() {
  var canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  var ctx = canvas.getContext('2d');
  var texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  var material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false
  });
  var mesh = new THREE.Mesh(nyanTownState.lyricGeometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  var depthMat = new THREE.ShaderMaterial({
    uniforms: { uDepth: { value: 1 } },
    vertexShader: NYAN_TOWN_DEPTH_VS,
    fragmentShader: NYAN_TOWN_DEPTH_FS,
    depthTest: false,
    depthWrite: false
  });
  var depthMesh = new THREE.Mesh(nyanTownState.lyricGeometry, depthMat);
  depthMesh.frustumCulled = false;
  depthMesh.visible = false;
  return {
    canvas: canvas, ctx: ctx, texture: texture, material: material, mesh: mesh,
    depthMat: depthMat, depthMesh: depthMesh,
    itemIndex: -1, drawKey: '', needsDraw: false, widthRatio: 1
  };
}

function nyanTownDisposeLyricRow(row) {
  if (!row) return;
  if (row.mesh && row.mesh.parent) row.mesh.parent.remove(row.mesh);
  if (row.depthMesh && row.depthMesh.parent) row.depthMesh.parent.remove(row.depthMesh);
  if (row.texture && row.texture.dispose) row.texture.dispose();
  if (row.material && row.material.dispose) row.material.dispose();
  if (row.depthMat && row.depthMat.dispose) row.depthMat.dispose();
}

function nyanTownDrawLyricRow(row, item, current, palette, styleKey) {
  var raster = nyanTownLyricRasterPx();
  var stack = nyanTownLyricFontStack();
  var font = '700 ' + raster.toFixed(1) + 'px ' + stack;
  var subPx = Math.max(10, Math.round(raster * nyanTownLyricTranslationScale()));
  var subFont = '400 ' + subPx.toFixed(1) + 'px ' + stack;
  var pad = Math.max(4, raster * 0.22);
  var mainH = raster * 1.2 * nyanTownLyricLineHeight();
  var subH = subPx * 1.55;
  var gap = raster * 0.18;
  var maxWidth = 1100;
  var measure = row.ctx;
  measure.font = font;
  var mainLines = nyanTownLyricWrapText(measure, item.text, maxWidth, 3);
  measure.font = subFont;
  var subText = nyanTownLyricTranslationShown() ? String(item.sub || '') : '';
  var subLines = subText ? nyanTownLyricWrapText(measure, subText, maxWidth, 2) : [];
  var textWidth = 0;
  measure.font = font;
  for (var mi = 0; mi < mainLines.length; mi++) {
    textWidth = Math.max(textWidth, measure.measureText(mainLines[mi]).width || 0);
  }
  measure.font = subFont;
  for (var si = 0; si < subLines.length; si++) {
    textWidth = Math.max(textWidth, measure.measureText(subLines[si]).width || 0);
  }
  var canvasWidth = Math.max(raster * 3, Math.min(2048, Math.ceil(textWidth + pad * 2)));
  var canvasHeight = Math.ceil(pad * 2 + mainLines.length * mainH + (subLines.length ? gap + subLines.length * subH : 0));
  if (row.canvas.width !== canvasWidth || row.canvas.height !== canvasHeight) {
    row.canvas.width = canvasWidth;
    row.canvas.height = canvasHeight;
    row.ctx = row.canvas.getContext('2d');
  }
  var ctx = row.ctx;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  var colour = current ? palette.highlight : palette.primary;
  var alpha = current ? 1 : 0.82;
  var coreY = pad + mainH * 0.5;
  // Two passes: a wide glow first, then the crisp core. Both share the same box.
  function fillLines() {
    // A dark stroke first: the town's sky and sun are bright, and a pale glyph with no outline
    // disappears into them. The stroke is baked into the plate so it costs nothing per frame.
    ctx.strokeStyle = 'rgba(6, 10, 16, 0.55)';
    ctx.lineWidth = Math.max(1, raster * 0.055);
    ctx.lineJoin = 'round';
    ctx.fillStyle = colour;
    for (var st = 0; st < mainLines.length; st++) {
      ctx.strokeText(mainLines[st], canvasWidth / 2, pad + (st + 0.5) * mainH);
    }
    for (var m = 0; m < mainLines.length; m++) {
      ctx.fillText(mainLines[m], canvasWidth / 2, pad + (m + 0.5) * mainH);
    }
    if (subLines.length) {
      ctx.font = subFont;
      ctx.fillStyle = palette.context;
      ctx.globalAlpha = alpha * nyanTownLyricTranslationOpacity();
      var subTop = pad + mainLines.length * mainH + gap;
      for (var s = 0; s < subLines.length; s++) {
        ctx.fillText(subLines[s], canvasWidth / 2, subTop + (s + 0.5) * subH);
      }
      ctx.globalAlpha = alpha;
      ctx.font = font;
      ctx.fillStyle = colour;
    }
  }
  ctx.globalAlpha = alpha;
  ctx.save();
  ctx.shadowColor = palette.glow;
  ctx.shadowBlur = raster * 0.26;
  fillLines();
  ctx.restore();
  ctx.globalAlpha = alpha;
  fillLines();
  ctx.globalAlpha = 1;
  row.widthRatio = canvasWidth / Math.max(1, canvasHeight);
  row.texture.needsUpdate = true;
  row.drawKey = [item.text, item.sub, styleKey, current ? 1 : 0].join('|');
  row.needsDraw = false;
  void coreY;
}

// Pure flight math, so the timing can be checked without a camera: p runs 0 (spawn, far) to 1
// (nearest point, fading out). The depth is exponential so the approach slows down near the eye.
function nyanTownLyricFlight(item, p, isCurrent, opts) {
  var near = Math.max(1, Number(opts.near) || 4);
  var far = Math.max(near + 1, Number(opts.far) || 20);
  var spread = nyanTownClamp(opts.spread === undefined ? 1 : opts.spread, 0, 1.5);
  var rollDeg = nyanTownClamp(opts.roll === undefined ? 10 : opts.roll, 0, 40);
  var fov = Math.max(0.2, Number(opts.fov) || 45) * Math.PI / 180;
  var aspect = Math.max(0.2, Number(opts.aspect) || 1.78);
  var idx = Math.max(0, Math.round(Number(item && item.index) || 0));
  var t = nyanTownClamp(p, 0, 1);
  var depth = near * Math.pow(far / near, 1 - t);
  var halfH = Math.tan(fov * 0.5) * depth;
  var halfW = halfH * aspect;
  var side = (idx % 2 === 0) ? 1 : -1;
  var lane = (((idx * 37) % 100) / 100 - 0.5) * 0.55 * spread;
  if (isCurrent) lane *= 0.25;
  // The sung line crosses the centre early enough to be read while it is bright; the others
  // sweep the full width and leave the readable moment to the current line.
  var x0 = side * (isCurrent ? 1.0 : 1.18);
  var x1 = isCurrent ? -side * 1.1 : -side * 0.32;
  var x = (x0 + (x1 - x0) * t) * halfW + Math.sin(t * 6.283 + idx) * 0.02 * halfW;
  var y = lane * halfH + Math.sin(t * 5.1 + idx * 0.7) * 0.015 * halfH;
  var roll = side * (1 - t) * (rollDeg * Math.PI / 180) + Math.sin(t * 4.3 + idx) * 0.015;
  var fadeStart = isCurrent ? 0.86 : 0.78;
  var alpha = nyanTownClamp(t / 0.1, 0, 1) * (1 - nyanTownClamp((t - fadeStart) / (1 - fadeStart), 0, 1));
  return { depth: depth, x: x, y: y, roll: roll, alpha: alpha, side: side };
}

function nyanTownHideLyricRows() {
  var rows = nyanTownState.lyricRows;
  for (var i = 0; i < rows.length; i++) {
    rows[i].mesh.visible = false;
    rows[i].depthMesh.visible = false;
  }
}

function nyanTownUpdateLyrics(dt) {
  if (!nyanTownState.built || !nyanTownState.lyricScene) return false;
  var on = typeof fx === 'undefined' || !fx || fx.particleLyrics !== false;
  on = on && nyanTownParam('lyricOn') > 0;
  nyanTownState.lyricVisible = on ? 1 : 0;
  if (!on) {
    nyanTownHideLyricRows();
    nyanTownState.lyricSung = -2;
    if (nyanTownState.blitMat) nyanTownState.blitMat.uniforms.uLyricOn.value = 0;
    return true;
  }
  var items = nyanTownLyricItems();
  var listKey = nyanTownLyricListKey(items);
  if (listKey !== nyanTownState.lyricListKey) {
    nyanTownState.lyricListKey = listKey;
    nyanTownState.lyricItems = items;
    var resetRows = nyanTownState.lyricRows;
    for (var r = 0; r < resetRows.length; r++) {
      resetRows[r].itemIndex = -1;
      resetRows[r].drawKey = '';
      resetRows[r].mesh.visible = false;
      resetRows[r].depthMesh.visible = false;
    }
  }
  nyanTownLyricRowCount();
  var rows = nyanTownState.lyricRows;
  if (!items.length || !rows.length) {
    nyanTownHideLyricRows();
    if (nyanTownState.blitMat) nyanTownState.blitMat.uniforms.uLyricOn.value = 0;
    return true;
  }
  var clock = (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) ? Number(audio.currentTime) : 0;
  var t = (typeof getAdjustedLyricPlaybackTime === 'function') ? Number(getAdjustedLyricPlaybackTime(clock)) : clock;
  if (!isFinite(t)) t = clock;
  var sung = nyanTownLyricSungIndex(items, t);
  nyanTownState.lyricSung = sung;
  var lo = Math.max(0, (sung < 0 ? 0 : sung) - 2);
  var hi = Math.min(items.length - 1, (sung < 0 ? 0 : sung) + 3);
  var palette = nyanTownLyricPalette();
  var styleKey = nyanTownLyricStyleKey();
  if (styleKey !== nyanTownState.lyricStyleKey) {
    nyanTownState.lyricStyleKey = styleKey;
    for (var s = 0; s < rows.length; s++) rows[s].drawKey = '';
  }
  // Free rows whose line left the window or whose flight is over.
  var lead = Math.max(0, nyanTownParam('lyricLead'));
  var speed = Math.max(0.2, nyanTownParam('lyricSpeed'));
  var near = Math.max(1, nyanTownParam('lyricDepthNear'));
  var far = Math.max(near + 1, nyanTownParam('lyricDepthFar'));
  for (var f = 0; f < rows.length; f++) {
    var row = rows[f];
    if (row.itemIndex < 0) continue;
    var line = items[row.itemIndex];
    if (!line || row.itemIndex < lo || row.itemIndex > hi) {
      row.itemIndex = -1;
      row.drawKey = '';
      row.mesh.visible = false;
      row.depthMesh.visible = false;
      continue;
    }
    var dur = nyanTownLyricDuration(line, speed);
    var p = (t - (line.startAt - lead)) / dur;
    if (p > 1.15) {
      row.itemIndex = -1;
      row.drawKey = '';
      row.mesh.visible = false;
      row.depthMesh.visible = false;
    }
  }
  // Claim a row for every line that can be flying now.
  for (var idx = lo; idx <= hi; idx++) {
    var claimed = false;
    for (var c = 0; c < rows.length; c++) if (rows[c].itemIndex === idx) { claimed = true; break; }
    if (claimed) continue;
    var free = null;
    for (var fr = 0; fr < rows.length; fr++) if (rows[fr].itemIndex < 0) { free = rows[fr]; break; }
    if (!free) continue;
    free.itemIndex = idx;
    free.drawKey = '';
  }
  // The current line gets the raster budget first; a future line that has not spawned must not
  // consume it (that starved the one line actually on screen for a whole song in the first cut).
  var sungRow = null;
  for (var sr = 0; sr < rows.length; sr++) {
    if (rows[sr].itemIndex === sung) { sungRow = rows[sr]; break; }
  }
  function plateKey(item, current) {
    return [item.text, item.sub, styleKey, current ? 1 : 0].join('|');
  }
  if (sungRow) {
    var sungItem = items[sungRow.itemIndex];
    if (sungItem) {
      var sungDur = nyanTownLyricDuration(sungItem, speed);
      var sungP = (t - (sungItem.startAt - lead)) / sungDur;
      var sungKey = plateKey(sungItem, true);
      if (sungP >= 0 && sungP <= 1.15 && sungRow.drawKey !== sungKey) {
        nyanTownDrawLyricRow(sungRow, sungItem, true, palette, styleKey);
      }
    }
  }
  var sizeKnob = nyanTownClamp(nyanTownParam('lyricSize'), 0.2, 2);
  var opacityKnob = nyanTownClamp(nyanTownParam('lyricOpacity'), 0, 1);
  var spread = nyanTownParam('lyricSpread');
  var roll = nyanTownParam('lyricRoll');
  var aspect = (nyanTownState.lyricCam && nyanTownState.lyricCam.aspect) || 1.78;
  var fov = (nyanTownState.lyricCam && nyanTownState.lyricCam.fov) || 45;
  var rasterBudget = 1;
  var live = 0;
  for (var q = 0; q < rows.length; q++) {
    var piece = rows[q];
    if (piece.itemIndex < 0) continue;
    var item = items[piece.itemIndex];
    if (!item) continue;
    var current = piece.itemIndex === sung;
    var lineDur = nyanTownLyricDuration(item, speed);
    var rawProgress = (t - (item.startAt - lead)) / lineDur;
    if (rawProgress < 0) {
      piece.mesh.visible = false;
      piece.depthMesh.visible = false;
      continue;
    }
    var drawKey = plateKey(item, current);
    if (piece.drawKey !== drawKey) {
      piece.needsDraw = true;
      if (rasterBudget > 0 && piece !== sungRow) {
        nyanTownDrawLyricRow(piece, item, current, palette, styleKey);
        rasterBudget -= 1;
      } else if (piece !== sungRow) {
        piece.mesh.visible = false;
        piece.depthMesh.visible = false;
        continue;
      }
    }
    var progress = nyanTownClamp(rawProgress, 0, 1);
    var flight = nyanTownLyricFlight(item, progress, current, {
      near: near, far: far, spread: spread, roll: roll, fov: fov, aspect: aspect
    });
    // The readable moment is around depth 10, so the plate has to be large in world units: at
    // 1.15 it covers ~14% of the viewport there (about 45 px per text line on a 1080p window).
    var height = 1.8 * sizeKnob * (current ? 1.2 : 0.9);
    var width = height * piece.widthRatio;
    piece.mesh.position.set(flight.x, flight.y, -flight.depth);
    piece.mesh.rotation.set(0, 0, flight.roll);
    piece.mesh.scale.set(width, height, 1);
    piece.material.opacity = opacityKnob * flight.alpha;
    piece.mesh.visible = true;
    piece.depthMesh.position.copy(piece.mesh.position);
    piece.depthMesh.rotation.copy(piece.mesh.rotation);
    piece.depthMesh.scale.copy(piece.mesh.scale);
    piece.depthMat.uniforms.uDepth.value = nyanTownClamp(flight.depth / 25, 0, 0.98);
    // Far plates first, near plates last, so the depth target ends up holding the nearest plate
    // that also sits on top in the colour target. Without this a farther rectangle could own the
    // depth at a pixel and hide the text the colour pass drew there.
    piece.depthMesh.renderOrder = Math.round((1 - nyanTownClamp(flight.depth / far, 0, 1)) * 1000);
    piece.depthMesh.visible = true;
    live += 1;
  }
  if (nyanTownState.blitMat) {
    nyanTownState.blitMat.uniforms.uLyricOn.value = live > 0 ? 1 : 0;
    nyanTownState.blitMat.uniforms.uOcclusion.value = nyanTownParam('lyricOcclusion');
  }
  return true;
}



var nyanTownState = {
  built: false, quadScene: null, quadCam: null, quad: null, mat: null,
  blitScene: null, blitCam: null, blitMat: null,
  rt: null, rtW: 0, rtH: 0, passScale: 0,
  levelData: null, levelTex: null,
  spriteCanvas: null, spriteTex: null,
  lyricScene: null, lyricDepthScene: null, lyricCam: null,
  lyricRt: null, lyricDepthRt: null, lyricW: 0, lyricH: 0,
  lyricGeometry: null, lyricRows: [], lyricItems: [], lyricListKey: '', lyricStyleKey: '',
  lyricSung: -2, lyricVisible: 0, lyricLayerChecked: false, lyricLayerWasOff: false,
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
      uniforms: {
        tScene: { value: null },
        tLyric: { value: null },
        tLyricDepth: { value: null },
        uOcclusion: { value: 0.012 },
        uLyricOn: { value: 1 }
      },
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
    nyanTownState.lyricScene = new THREE.Scene();
    nyanTownState.lyricDepthScene = new THREE.Scene();
    nyanTownState.lyricCam = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    nyanTownState.lyricCam.position.set(0, 0, 0);
    nyanTownState.lyricGeometry = new THREE.PlaneGeometry(1, 1);
    nyanTownState.clearColor = new THREE.Color();
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
  var lw = Math.max(64, Math.round(nyanTownState.size.x || 1));
  var lh = Math.max(64, Math.round(nyanTownState.size.y || 1));
  var sceneSized = nyanTownState.rt && nyanTownState.rtW === w && nyanTownState.rtH === h && nyanTownState.passScale === scale;
  var lyricSized = nyanTownState.lyricRt && nyanTownState.lyricW === lw && nyanTownState.lyricH === lh;
  if (sceneSized && lyricSized) return true;
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
  if (!nyanTownState.lyricRt) {
    nyanTownState.lyricRt = new THREE.WebGLRenderTarget(lw, lh, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    nyanTownState.lyricDepthRt = new THREE.WebGLRenderTarget(lw, lh, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
  } else if (nyanTownState.lyricW !== lw || nyanTownState.lyricH !== lh) {
    nyanTownState.lyricRt.setSize(lw, lh);
    nyanTownState.lyricDepthRt.setSize(lw, lh);
  }
  nyanTownState.lyricW = lw;
  nyanTownState.lyricH = lh;
  nyanTownState.lyricCam.aspect = lw / lh;
  nyanTownState.lyricCam.updateProjectionMatrix();
  nyanTownState.blitMat.uniforms.tScene.value = nyanTownState.rt.texture;
  nyanTownState.blitMat.uniforms.tLyric.value = nyanTownState.lyricRt.texture;
  nyanTownState.blitMat.uniforms.tLyricDepth.value = nyanTownState.lyricDepthRt.texture;
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
  if (!nyanTownState.lyricLayerChecked) {
    nyanTownState.lyricLayerChecked = true;
    nyanTownEnableLyricLayer();
  }
  var startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  if (!nyanTownState.built && !nyanTownBuildScene()) return false;
  var step = Math.max(0, Math.min(0.12, Number(dt) || 0));
  nyanTownUpdateLevels(sonicFrame, step);
  nyanTownFeedUniforms();
  nyanTownUpdateLyrics(step);
  nyanTownState.frames++;
  nyanTownState.lastCostMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - startedAt;
  void now;
  return true;
}

function nyanTownRenderLyricPasses() {
  if (!nyanTownState.lyricRt || !nyanTownState.lyricDepthRt) return false;
  var rows = nyanTownState.lyricRows;
  var any = false;
  for (var i = 0; i < rows.length; i++) if (rows[i].mesh.visible) { any = true; break; }
  if (!any) return false;
  var clear = nyanTownState.clearColor || new THREE.Color();
  renderer.getClearColor(clear);
  var oldAlpha = renderer.getClearAlpha();
  renderer.autoClear = false;
  try {
    renderer.setRenderTarget(nyanTownState.lyricRt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(nyanTownState.lyricScene, nyanTownState.lyricCam);
    renderer.setRenderTarget(nyanTownState.lyricDepthRt);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear(true, false, false);
    renderer.render(nyanTownState.lyricDepthScene, nyanTownState.lyricCam);
  } finally {
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    renderer.setClearColor(clear, oldAlpha);
  }
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
    nyanTownRenderLyricPasses();
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
  var rows = nyanTownState.lyricRows || [];
  for (var i = 0; i < rows.length; i++) nyanTownDisposeLyricRow(rows[i]);
  nyanTownState.lyricRows = [];
  if (nyanTownState.lyricRt) nyanTownState.lyricRt.dispose();
  if (nyanTownState.lyricDepthRt) nyanTownState.lyricDepthRt.dispose();
  if (nyanTownState.lyricGeometry) nyanTownState.lyricGeometry.dispose();
  if (nyanTownState.lyricScene) nyanTownState.lyricScene.clear();
  if (nyanTownState.lyricDepthScene) nyanTownState.lyricDepthScene.clear();
  nyanTownState.lyricRt = null;
  nyanTownState.lyricDepthRt = null;
  nyanTownState.lyricGeometry = null;
  nyanTownState.lyricScene = null;
  nyanTownState.lyricDepthScene = null;
  nyanTownState.lyricCam = null;
  nyanTownState.lyricW = 0;
  nyanTownState.lyricH = 0;
  nyanTownState.lyricItems = [];
  nyanTownState.lyricListKey = '';
  nyanTownState.lyricStyleKey = '';
  nyanTownState.lyricSung = -2;
  nyanTownState.lyricVisible = 0;
  nyanTownState.lyricLayerChecked = false;
  nyanTownState.lyricLayerWasOff = false;
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
    nyan: nyanTownParam('catOn') > 0,
    lyricOn: nyanTownParam('lyricOn') > 0,
    lyricRows: nyanTownState.lyricRows.length,
    lyricLive: nyanTownState.lyricRows.filter(function (row) { return row.mesh.visible; }).length,
    lyricText: (nyanTownState.lyricSung >= 0 && nyanTownState.lyricItems[nyanTownState.lyricSung])
      ? String(nyanTownState.lyricItems[nyanTownState.lyricSung].text || '').slice(0, 24) : ''
  };
}

// The lane reads fx.particleLyrics as the global lyric switch (the app's 词 button). Restored fx
// state can land after the preset is applied, so the first active frame checks too.
function nyanTownEnableLyricLayer() {
  if (nyanTownState.lyricLayerWasOff) return true;
  if (typeof fx === 'undefined' || !fx || fx.particleLyrics !== false) return false;
  if (typeof setParticleLyricsSilently !== 'function') return false;
  nyanTownState.lyricLayerWasOff = true;
  setParticleLyricsSilently(true);
  return true;
}

function applyNyanTownPresetNow(prev, next) {
  var on = Number(next) === NYAN_TOWN_PRESET_INDEX;
  var was = Number(prev) === NYAN_TOWN_PRESET_INDEX;
  if (on) {
    nyanTownState.lyricLayerChecked = true;
    nyanTownEnableLyricLayer();
    nyanTownBuildScene();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('nyan-town-preset');
  } else if (was) {
    if (nyanTownState.lyricLayerWasOff) {
      nyanTownState.lyricLayerWasOff = false;
      if (typeof setParticleLyricsSilently === 'function') setParticleLyricsSilently(false);
    }
    nyanTownState.lyricLayerChecked = false;
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
