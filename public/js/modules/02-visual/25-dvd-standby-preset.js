'use strict';

// DVD待机 (preset 20). Reference: Shadertoy view "wtcSzN" (DVD), supplied by the requester. This is
// a single Image pass and is ported as written: the DVD-logo SDF, the bouncing cell walk, the
// mirrored tile reflections, the wavefront/ripple normal bump, the inverted + lit surface, the
// dither and the gamma curve. The only rewrites are the environment preamble (GLSL3), the noise
// channel's resolution (our generated texture), and the knobs noted in DVD_SCHEMA.
//
// Licence UNVERIFIED — the Shadertoy page carries no licence header we can read; see the sidecar,
// NOTICE.md and docs/THIRD_PARTY_PORTS.md before distributing a build with this preset.
//
// The reference's screen-space composition is the whole picture: no app particles, bloom or lyric
// layer are left underneath it. The clock is advanced by our own frame dt (not the song clock), so
// the standby animation keeps bouncing while paused and in wallpaper mode.
//
// Two additions on top of the reference: the travel is a value the JS side can dash on a live
// beat (no beat map required), and the surface is the current song cover instead of the reference's
// inverted spectrum wall: the ripple normal refracts the cover lookup and steeper slopes use a
// blurred copy. The beat only pulses the logo; it never re-times the water. Both deviations and the
// ripple history/life are documented in the sidecar.

var DVD_PRESET_INDEX = 20;

var DVD_SCHEMA = {
  speed: { def: 1, min: 0.1, max: 3, kind: 'ratio', rebuild: 'live' },
  angle: { def: 45, min: 5, max: 85, kind: 'unit', rebuild: 'live' },
  logoScale: { def: 1, min: 0.4, max: 2.5, kind: 'ratio', rebuild: 'live' },
  reflections: { def: 10, min: 1, max: 16, kind: 'count', rebuild: 'live' },
  rippleRange: { def: 1.5, min: 0, max: 4, kind: 'ratio', rebuild: 'live' },
  rippleFreq: { def: 2, min: 0.2, max: 5, kind: 'ratio', rebuild: 'live' },
  rippleLife: { def: 12, min: 3, max: 40, kind: 'unit', rebuild: 'live' },
  heightDecay: { def: 0.35, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  refract: { def: 0.5, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  coverBlur: { def: 10, min: 0, max: 30, kind: 'unit', rebuild: 'live' },
  bump: { def: 0.1, min: 0.02, max: 0.6, kind: 'ratio', rebuild: 'live' },
  dither: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  gamma: { def: 1.5, min: 0.8, max: 2.5, kind: 'ratio', rebuild: 'live' },
  brightness: { def: 1, min: 0.3, max: 2, kind: 'ratio', rebuild: 'live' },
  beatDash: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  dashBeats: { def: 0.55, min: 0.1, max: 1, kind: 'ratio', rebuild: 'live' },
  dashPower: { def: 3, min: 1, max: 5, kind: 'ratio', rebuild: 'live' },
  beatPunch: { def: 0.7, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  impactFlash: { def: 0.8, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' }
};

var DVD_QUAD_VS_GLSL3 = 'void main() { gl_Position = vec4(position.xy, 0.999999, 1.0); }';

var DVD_SOURCE_FS = `precision highp float;
out vec4 outColor;
#define gl_FragColor outColor
uniform vec3 iResolution;
uniform float iTime;
uniform int iFrame;
uniform vec4 iMouse;
uniform sampler2D iChannel0;
uniform vec2 uNoiseRes;
uniform int uReflections;
uniform float uAngle;
uniform float uLogoScale;
uniform float uRippleRange;
uniform float uRippleFreq;
uniform float uBump;
uniform float uDither;
uniform float uGamma;
uniform float uTravel;
uniform float uRippleLife;
uniform float uHeightDecay;
uniform float uHitAges[16];
uniform float uBeat;
uniform float uImpact;
uniform sampler2D uCover;
uniform sampler2D uCoverBlur;
uniform float uRefract;
uniform vec3 uLightColor;
uniform float uBrightness;

#define PI 3.14159265359

float vmin(vec2 v) { return min(v.x, v.y); }
float vmax(vec2 v) { return max(v.x, v.y); }

float ellip(vec2 p, vec2 s) {
    float m = vmin(s);
    return (length(p / s) * m) - m;
}

float halfEllip(vec2 p, vec2 s) {
    p.x = max(0., p.x);
    float m = vmin(s);
    return (length(p / s) * m) - m;
}

float fBox(vec2 p, vec2 b) {
    return vmax(abs(p) - b);
}

float dvd_d(vec2 p) {
    float d = halfEllip(p, vec2(.8, .5));
    d = max(d, -p.x - .5);
    float d2 = halfEllip(p, vec2(.45, .3));
    d2 = max(d2, min(-p.y + .2, -p.x - .15));
    d = max(d, -d2);
    return d;
}

float dvd_v(vec2 p) {
    vec2 pp = p;
    p.y += .7;
    p.x = abs(p.x);
    vec2 a = normalize(vec2(1, -.55));
    float d = dot(p, a);
    float d2 = d + .3;
    p = pp;
    d = min(d, -p.y + .3);
    d2 = min(d2, -p.y + .5);
    d = max(d, -d2);
    d = max(d, abs(p.x + .3) - 1.1);
    return d;
}

float dvd_c(vec2 p) {
    p.y += .95;
    float d = ellip(p, vec2(1.8, .25));
    float d2 = ellip(p, vec2(.45, .09));
    d = max(d, -d2);
    return d;
}

float dvd(vec2 p) {
    p.y -= .345;
    p.x -= .035;
    p *= mat2(1, -.2, 0, 1);
    float d = dvd_v(p);
    d = min(d, dvd_c(p));
    p.x += 1.3;
    d = min(d, dvd_d(p));
    p.x -= 2.4;
    d = min(d, dvd_d(p));
    return d;
}

float range(float vmin, float vmax, float value) {
    return (value - vmin) / (vmax - vmin);
}

float rangec(float a, float b, float t) {
    return clamp(range(a, b, t), 0., 1.);
}

void drawHit(inout vec4 col, vec2 p, vec2 hitPos, float hitAge) {
    float d = length(p - hitPos);
    float wavefront = d - hitAge * uRippleRange;
    float freq = uRippleFreq;

    float ripple = sin((wavefront * freq) * PI * 2. - PI / 2.);

    float blend = smoothstep(uRippleLife, 0., hitAge);
    blend *= smoothstep(.2, -.5, wavefront);
    blend *= rangec(-4., .0, wavefront);

    // The ring colour may linger, but its relief has to flatten with age; no beat term here.
    float height = ripple * blend * exp(-hitAge * uHeightDecay);
    col.a -= height * 1.9 / freq;
}

vec2 ref(vec2 p, vec2 planeNormal, float offset) {
    float t = dot(p, planeNormal) + offset;
    p -= (2. * t) * planeNormal;
    return p;
}

void drawReflectedHit(inout vec4 col, vec2 p, vec2 hitPos, float hitAge, vec2 screenSize) {
    col.a += length(p) * .0001;
    drawHit(col, p, ref(hitPos, vec2(0, 1), 1.), hitAge);
    drawHit(col, p, ref(hitPos, vec2(0, -1), 1.), hitAge);
    drawHit(col, p, ref(hitPos, vec2(1, 0), screenSize.x / screenSize.y), hitAge);
    drawHit(col, p, ref(hitPos, vec2(-1, 0), screenSize.x / screenSize.y), hitAge);
}

// Flip every second cell to create reflection
void flip(inout vec2 pos) {
    vec2 f = mod(floor(pos), 2.);
    pos = abs(f - mod(pos, 1.));
}

float stepSign(float a) {
    return step(0., a) * 2. - 1.;
}

vec2 compassDir(vec2 p) {
    vec2 a = vec2(stepSign(p.x), 0);
    vec2 b = vec2(0, stepSign(p.y));
    float s = stepSign(p.x - p.y) * stepSign(-p.x - p.y);
    return mix(a, b, s * .5 + .5);
}

vec2 calcHitPos(vec2 move, vec2 dir, vec2 size) {
    vec2 hitPos = mod(move, 1.);
    vec2 xCross = hitPos - hitPos.x / (size / size.x) * (dir / dir.x);
    vec2 yCross = hitPos - hitPos.y / (size / size.y) * (dir / dir.y);
    hitPos = max(xCross, yCross);
    hitPos += floor(move);
    return hitPos;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 p = (-iResolution.xy + 2.0 * fragCoord) / iResolution.y;
    vec2 screenSize = vec2(iResolution.x / iResolution.y, 1.) * 2.;

    // The reference's direction is normalize(vec2(9,16) * screenSize); it reads as 45° in cell
    // space on a 16:9 screen. The knob is a rotation of that base, so 45° is the reference exactly.
    float a = radians(uAngle - 45.);
    vec2 baseDir = normalize(vec2(9., 16.) * screenSize);
    vec2 dir = normalize(mat2(cos(a), -sin(a), sin(a), cos(a)) * baseDir);
    // uTravel replaces iTime/1.5: the JS side can hold or dash it on a beat. The collision walk
    // below only needs a position on the same folded ray, so resizing the logo/screen keeps working.
    vec2 move = dir * uTravel;
    float logoScale = .1 * uLogoScale;
    vec2 logoSize = vec2(2., .85) * logoScale;

    vec2 size = screenSize - logoSize * 2.;

    // Remap so (0,0) is bottom left, and (1,1) is top right
    move = move / size + .5;

    vec2 lastHitPos = calcHitPos(move, dir, size);
    vec4 col = vec4(1, 1, 1, 0);
    vec4 colFx = vec4(1, 1, 1, 0);
    vec4 colFy = vec4(1, 1, 1, 0);
    vec2 e = vec2(.8, 0) / iResolution.y;

    for (int i = 0; i < uReflections; i++) {
        vec2 hitPos = lastHitPos;
        if (i > 0) {
            // Nudge it before the boundary to find the previous hit point
            hitPos = calcHitPos(hitPos - .00001 / size, dir, size);
        }
        lastHitPos = hitPos;

        // The ring's age comes from the JS ripple clock, not from how far the logo has travelled.
        // A beat dash therefore moves the logo without speeding up the wavefronts.
        float hitAge = uHitAges[i];

        flip(hitPos);
        hitPos = (hitPos - .5) * size;
        hitPos += logoSize * compassDir(hitPos / size);

        drawReflectedHit(col, p, hitPos, hitAge, screenSize);
        drawReflectedHit(colFx, p + e, hitPos, hitAge, screenSize);
        drawReflectedHit(colFy, p + e.yx, hitPos, hitAge, screenSize);
    }

    flip(move);
    move = (move - .5) * size;

    // Calc normals
    float bf = uBump;
    float fx = (col.a - colFx.a) * 2.;
    float fy = (col.a - colFy.a) * 2.;
    vec3 nor = normalize(vec3(fx, fy, e.x / bf));
    float ff = length(vec2(fx, fy));
    float ee = rangec(0., 10. / iResolution.y, ff);
    nor = normalize(vec3(vec2(fx, fy) * ee, ff));

    // Water surface: the current cover is the flat colour; the ripple normal refracts the lookup,
// and the steeper the slope the more of the blurred cover is used.
    vec2 cuv = fragCoord / iResolution.xy;
    float aspect = iResolution.x / iResolution.y;
    if (aspect > 1.) cuv.y = .5 + (cuv.y - .5) / aspect;
    else cuv.x = .5 + (cuv.x - .5) * aspect;
    vec2 refr = nor.xy * uRefract * .35;
    float slope = length(nor.xy);
    vec3 waterSharp = texture(uCover, clamp(cuv + refr, 0., 1.)).rgb;
    vec3 waterBlur = texture(uCoverBlur, clamp(cuv + refr * 1.25, 0., 1.)).rgb;
    vec3 water = mix(waterSharp, waterBlur, smoothstep(0., .15, slope));

    // lighting (iq, Shadertoy Xds3zN): fixed 60° elevation, 45° azimuth, lyric-coloured highlight
    float el = radians(60.);
    float az = radians(45.);
    vec3 lig = normalize(vec3(cos(el) * cos(az), cos(el) * sin(az), sin(el)));
    vec3 rd = normalize(vec3(p, -10.));
    vec3 hal = normalize(lig - rd);

    float dif = clamp(dot(lig, nor), 0., 1.);
    float spe = pow(clamp(dot(nor, hal), 0.0, 1.0), 40.0) * dif
        * (0.04 + 0.96 * pow(clamp(1.0 + dot(hal, rd), 0.0, 1.0), 5.0));

    vec3 lin = vec3(.55 + .45 * dif) * uBrightness;
    col.rgb = water * lin + uLightColor * spe * 2.2 * uBrightness;

    // dvd logo — the beat and the wall impact pulse the mark itself; the background stays untouched.
    float logoPulse = 1. + uBeat * .16;
    float dRaw = dvd((p - move) / (logoScale * logoPulse));
    float d = dRaw / fwidth(dRaw);
    d = 1. - clamp(d, 0., 1.);
    float halo = exp(-max(dRaw, 0.) * 14.) * (uBeat * .55 + uImpact * .35);
    col.rgb += halo * vec3(.35, .8, 1.);
    col.rgb = mix(col.rgb, vec3(1), d);

    // banding be gone
    col += (texture(iChannel0, fragCoord / uNoiseRes) * 2. - 1.) * .005 * uDither;

    // gamma
    col.rgb = pow(col.rgb, vec3(1. / uGamma));

    col.a = col.a * .5 + .5;
    col.a *= .3;
    fragColor = vec4(col.rgb, 1.0);
}
`;

var DVD_SOURCE_FS_FULL = DVD_SOURCE_FS + `
void main() {
  vec4 fragColor = vec4(0.0);
  mainImage(fragColor, gl_FragCoord.xy);
  gl_FragColor = fragColor;
}
`;

var dvdState = {
  built: false,
  error: '',
  mat: null,
  pass: null,
  geometry: null,
  noiseTex: null,
  clock: 0,
  travel: 0,
  dash: null,
  rippleClock: 0,
  hitBirths: [],
  lastTravel: 0,
  pathKey: '',
  beatPulse: 0,
  impactPulse: 0,
  beatCount: 0,
  dashCount: 0,
  impactCount: 0,
  fallbackTex: null,
  coverCanvas: null,
  coverBlurTex: null,
  coverSource: null,
  coverBlurPx: -1,
  lightCss: '',
  frames: 0,
  size: null
};

function dvdClamp(value, min, max) {
  var n = Number(value);
  if (!isFinite(n)) n = min;
  return Math.min(max, Math.max(min, n));
}

function dvdParam(key) {
  var spec = DVD_SCHEMA[key];
  var raw = (typeof dvdStandbyTuning !== 'undefined' && dvdStandbyTuning && dvdStandbyTuning[key] !== undefined)
    ? dvdStandbyTuning[key]
    : (spec ? spec.def : 0);
  return spec ? dvdClamp(raw, spec.min, spec.max) : Number(raw) || 0;
}

function dvdPresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === DVD_PRESET_INDEX;
}

// The shader's screen and playable rectangle, in the same units it uses. `size` is what makes a
// collision land on the visible edge after the logo/screen changes: the centre may only travel
// screenSize - 2*logoSize.
function dvdPlayableSize() {
  var w = 1;
  var h = 1;
  if (typeof renderer !== 'undefined' && renderer && renderer.getDrawingBufferSize) {
    if (!dvdState.size) dvdState.size = new THREE.Vector2();
    renderer.getDrawingBufferSize(dvdState.size);
    w = Math.max(1, Number(dvdState.size.x) || 1);
    h = Math.max(1, Number(dvdState.size.y) || 1);
  } else if (typeof window !== 'undefined') {
    w = Math.max(1, Number(window.innerWidth) || 1);
    h = Math.max(1, Number(window.innerHeight) || 1);
  }
  var aspect = w / h;
  var screenW = aspect * 2;
  var screenH = 2;
  var logo = 0.1 * dvdParam('logoScale');
  return {
    screenW: screenW,
    screenH: screenH,
    x: Math.max(0.05, screenW - 2 * (2 * logo)),
    y: Math.max(0.05, screenH - 2 * (0.85 * logo)),
    aspect: aspect
  };
}

// The shader's rotated reference direction, recomputed from the live angle. The GLSL mat2 is
// column-major: mat2(c,-s,s,c) * v = (c*x + s*y, -s*x + c*y).
function dvdPathDirection() {
  var play = dvdPlayableSize();
  var a = (dvdParam('angle') - 45) * Math.PI / 180;
  var c = Math.cos(a);
  var s = Math.sin(a);
  var bx = 9 * play.screenW;
  var by = 16 * play.screenH;
  var len = Math.hypot(bx, by) || 1;
  bx /= len;
  by /= len;
  return {
    x: c * bx + s * by,
    y: -s * bx + c * by,
    size: play
  };
}

// The travel value at which the folded ray next crosses a cell boundary. This mirrors the
// shader's move/size mapping, so a beat dash ends exactly on the wall even after the logo or the
// window size changed. The cell is [0,1]^2, the position is dir*travel/size + .5.
function dvdNextBoundaryTravel(travel, dx, dy, sizeX, sizeY) {
  var sx = Math.max(1e-4, Number(sizeX) || 1);
  var sy = Math.max(1e-4, Number(sizeY) || 1);
  var mx = dx * travel / sx + 0.5;
  var my = dy * travel / sy + 0.5;
  var vx = dx / sx;
  var vy = dy / sy;
  var tx = Infinity;
  var ty = Infinity;
  if (Math.abs(vx) > 1e-9) {
    var nx = vx > 0 ? Math.floor(mx + 1e-9) + 1 : Math.ceil(mx - 1e-9) - 1;
    tx = (nx - mx) / vx;
    if (!(tx > 1e-9)) {
      nx += vx > 0 ? 1 : -1;
      tx = (nx - mx) / vx;
    }
  }
  if (Math.abs(vy) > 1e-9) {
    var ny = vy > 0 ? Math.floor(my + 1e-9) + 1 : Math.ceil(my - 1e-9) - 1;
    ty = (ny - my) / vy;
    if (!(ty > 1e-9)) {
      ny += vy > 0 ? 1 : -1;
      ty = (ny - my) / vy;
    }
  }
  var step = Math.min(tx, ty);
  if (!isFinite(step) || step <= 0) step = 1;
  return travel + step;
}

function dvdApplyKnobs() {
  var u = dvdState.mat && dvdState.mat.uniforms;
  if (!u) return;
  u.uReflections.value = Math.max(1, Math.round(dvdParam('reflections')));
  u.uAngle.value = dvdParam('angle');
  u.uLogoScale.value = dvdParam('logoScale');
  u.uRippleRange.value = dvdParam('rippleRange');
  u.uRippleFreq.value = dvdParam('rippleFreq');
  u.uBump.value = dvdParam('bump');
  u.uDither.value = dvdParam('dither');
  u.uGamma.value = dvdParam('gamma');
  u.uBrightness.value = dvdParam('brightness');
  u.uRippleLife.value = dvdParam('rippleLife');
  u.uHeightDecay.value = dvdParam('heightDecay');
  u.uRefract.value = dvdParam('refract');
}

function dvdUpdateCoverTexture() {
  var u = dvdState.mat && dvdState.mat.uniforms;
  if (!u) return;
  var cover = (typeof coverTex !== 'undefined' && coverTex) ? coverTex : null;
  var img = cover && cover.image ? cover.image : null;
  if (!img) {
    u.uCover.value = dvdState.fallbackTex;
    u.uCoverBlur.value = dvdState.fallbackTex;
    return;
  }
  u.uCover.value = cover;
  var blurPx = dvdParam('coverBlur');
  if (img === dvdState.coverSource && Math.abs(blurPx - dvdState.coverBlurPx) < 0.5) {
    u.uCoverBlur.value = dvdState.coverBlurTex || cover;
    return;
  }
  if (!dvdState.coverCanvas) {
    var size = 256;
    dvdState.coverCanvas = document.createElement('canvas');
    dvdState.coverCanvas.width = size;
    dvdState.coverCanvas.height = size;
    dvdState.coverBlurTex = new THREE.CanvasTexture(dvdState.coverCanvas);
    dvdState.coverBlurTex.minFilter = THREE.LinearFilter;
    dvdState.coverBlurTex.magFilter = THREE.LinearFilter;
    dvdState.coverBlurTex.wrapS = THREE.ClampToEdgeWrapping;
    dvdState.coverBlurTex.wrapT = THREE.ClampToEdgeWrapping;
  }
  var canvas = dvdState.coverCanvas;
  var ctx = canvas.getContext('2d');
  var iw = Math.max(1, img.width || img.videoWidth || 1);
  var ih = Math.max(1, img.height || img.videoHeight || 1);
  var scale = Math.max(canvas.width / iw, canvas.height / ih);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  if (blurPx > 0.5) ctx.filter = 'blur(' + blurPx.toFixed(1) + 'px)';
  ctx.drawImage(img, (canvas.width - iw * scale) * 0.5, (canvas.height - ih * scale) * 0.5, iw * scale, ih * scale);
  ctx.restore();
  dvdState.coverBlurTex.needsUpdate = true;
  dvdState.coverSource = img;
  dvdState.coverBlurPx = blurPx;
  u.uCoverBlur.value = dvdState.coverBlurTex;
}

// The water's highlight uses the lyric text colour (the console's lyric palette primary), with
// the light fixed at 60° elevation and 45° azimuth.
function dvdLyricLightCss() {
  if (typeof effectiveLyricPalette === 'function') {
    try {
      var pal = effectiveLyricPalette(null);
      if (pal && pal.primary) return pal.primary;
    } catch (_) {}
  }
  if (typeof fx !== 'undefined' && fx && fx.lyricColorPrimary) return fx.lyricColorPrimary;
  return '#ffffff';
}

function dvdUpdateLightColor() {
  var u = dvdState.mat && dvdState.mat.uniforms;
  if (!u) return;
  var css = dvdLyricLightCss();
  if (css === dvdState.lightCss) return;
  dvdState.lightCss = css;
  var color = u.uLightColor.value;
  try {
    if (typeof color.setStyle === 'function') color.setStyle(css);
    else color.set(css);
  } catch (_) {
    color.setRGB(1, 1, 1);
  }
}

function dvdBuildScene() {
  if (dvdState.built) return true;
  if (typeof THREE === 'undefined') {
    dvdState.error = 'THREE is not available';
    return false;
  }
  try {
    var noiseSize = 512;
    var noiseData = new Uint8Array(noiseSize * noiseSize * 4);
    var seed = 0x51ed270b;
    for (var i = 0; i < noiseData.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noiseData[i] = seed & 255;
      noiseData[i + 1] = (seed >>> 8) & 255;
      noiseData[i + 2] = (seed >>> 16) & 255;
      noiseData[i + 3] = 255;
    }
    var noiseTex = new THREE.DataTexture(noiseData, noiseSize, noiseSize, THREE.RGBAFormat, THREE.UnsignedByteType);
    noiseTex.wrapS = THREE.RepeatWrapping;
    noiseTex.wrapT = THREE.RepeatWrapping;
    noiseTex.minFilter = THREE.NearestFilter;
    noiseTex.magFilter = THREE.NearestFilter;
    noiseTex.generateMipmaps = false;
    noiseTex.needsUpdate = true;

    var geometry = new THREE.PlaneGeometry(2, 2);
    var hitAges = new Float32Array(16);
    hitAges.fill(99);
    var fallback = new THREE.DataTexture(new Uint8Array([6, 8, 12, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    fallback.needsUpdate = true;
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        iResolution: { value: new THREE.Vector3(1, 1, 1) },
        iTime: { value: 0 },
        iFrame: { value: 0 },
        iMouse: { value: new THREE.Vector4(0, 0, 0, 0) },
        iChannel0: { value: noiseTex },
        uNoiseRes: { value: new THREE.Vector2(noiseSize, noiseSize) },
        uReflections: { value: 5 },
        uAngle: { value: 45 },
        uLogoScale: { value: 1 },
        uRippleRange: { value: 1.5 },
        uRippleFreq: { value: 2 },
        uBump: { value: 0.1 },
        uDither: { value: 1 },
        uGamma: { value: 1.5 },
        uBrightness: { value: 1 },
        uTravel: { value: 0 },
        uRippleLife: { value: 12 },
        uHeightDecay: { value: 0.35 },
        uHitAges: { value: hitAges },
        uBeat: { value: 0 },
        uImpact: { value: 0 },
        uCover: { value: fallback },
        uCoverBlur: { value: fallback },
        uRefract: { value: 0.5 },
        uLightColor: { value: new THREE.Color(1, 1, 1) }
      },
      glslVersion: THREE.GLSL3,
      vertexShader: DVD_QUAD_VS_GLSL3,
      fragmentShader: DVD_SOURCE_FS_FULL,
      depthTest: false,
      depthWrite: false,
      transparent: false
    });
    var scene = new THREE.Scene();
    var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var mesh = new THREE.Mesh(geometry, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    dvdState.noiseTex = noiseTex;
    dvdState.geometry = geometry;
    dvdState.mat = mat;
    dvdState.pass = { scene: scene, camera: camera, mesh: mesh };
    dvdState.size = new THREE.Vector2();
    dvdState.fallbackTex = fallback;
    dvdState.coverSource = null;
    dvdState.coverBlurPx = -1;
    dvdState.lightCss = '';
    dvdState.built = true;
    dvdState.error = '';
    dvdState.travel = 0;
    dvdState.dash = null;
    dvdState.rippleClock = 0;
    dvdState.hitBirths = [];
    dvdState.lastTravel = 0;
    dvdState.pathKey = '';
    dvdState.beatPulse = 0;
    dvdState.impactPulse = 0;
    dvdState.beatCount = 0;
    dvdState.dashCount = 0;
    dvdState.impactCount = 0;
    dvdApplyKnobs();
    return true;
  } catch (err) {
    dvdState.error = String(err && (err.message || err)).slice(0, 200);
    return false;
  }
}

function dvdUpdateLayer(now, dt, sonicFrame) {
  if (!dvdPresetIsActive()) return false;
  if (!dvdState.built && !dvdBuildScene()) return false;
  dvdApplyKnobs();
  dvdUpdateCoverTexture();
  dvdUpdateLightColor();
  var step = Math.max(0, Math.min(0.12, Number(dt) || 0));
  dvdState.clock += step;

  var dir = dvdPathDirection();
  var play = dir.size;
  var speed = dvdParam('speed');
  var pathKey = dvdParam('angle') + '|' + dvdParam('logoScale') + '|' + play.aspect.toFixed(4);
  var skipCross = false;
  if (dvdState.pathKey !== pathKey) {
    // A resize/logo/angle change remaps the cell coordinates; the old travel is not on the same
    // boundary grid, so start the crossing detector fresh instead of emitting a phantom hit.
    dvdState.pathKey = pathKey;
    dvdState.lastTravel = dvdState.travel;
    skipCross = true;
  }
  // Ripples age on their own clock at the base speed, never at the dash's eased speed.
  var cellSpeed = Math.hypot(dir.x / Math.max(1e-4, play.x), dir.y / Math.max(1e-4, play.y)) * (speed / 1.5);
  dvdState.rippleClock += step * cellSpeed;

  var beatDash = dvdParam('beatDash') > 0;
  var beatHit = typeof beatOnsetFlag !== 'undefined' && beatOnsetFlag;
  var gap = (typeof rtBeat !== 'undefined' && rtBeat && Number(rtBeat.tempoGap) > 0.15 && Number(rtBeat.tempoGap) <= 2)
    ? Number(rtBeat.tempoGap)
    : 0.5;
  if (beatHit) {
    dvdState.beatPulse = 1;
    dvdState.beatCount++;
  }

  if (beatDash && beatHit && !dvdState.dash) {
    var beatTarget = dvdNextBoundaryTravel(dvdState.travel + 1e-4, dir.x, dir.y, play.x, play.y);
    var beatDuration = Math.max(0.08, Math.min(0.6, gap * dvdParam('dashBeats')));
    if (beatTarget > dvdState.travel + 1e-4) {
      dvdState.dash = {
        from: dvdState.travel, to: beatTarget, elapsed: 0, duration: beatDuration,
        dirX: dir.x, dirY: dir.y, sizeX: play.x, sizeY: play.y
      };
      dvdState.dashCount++;
    }
  }

  if (dvdState.dash) {
    var dash = dvdState.dash;
    // A live resize (window or logo) changes the playable rectangle under the dash. Re-aim the
    // remaining travel at the new wall instead of ending at a boundary that no longer exists.
    if (Math.abs(dash.sizeX - play.x) > 1e-4 || Math.abs(dash.sizeY - play.y) > 1e-4
      || Math.abs(dash.dirX - dir.x) > 1e-4 || Math.abs(dash.dirY - dir.y) > 1e-4) {
      dash.from = dvdState.travel;
      dash.to = dvdNextBoundaryTravel(dvdState.travel + 1e-4, dir.x, dir.y, play.x, play.y);
      dash.elapsed = 0;
      dash.dirX = dir.x;
      dash.dirY = dir.y;
      dash.sizeX = play.x;
      dash.sizeY = play.y;
      skipCross = true;
    }
    dash.elapsed += step;
    var progress = Math.min(1, dash.elapsed / Math.max(0.001, dash.duration));
    var eased = Math.pow(progress, dvdParam('dashPower'));
    dvdState.travel = dash.from + (dash.to - dash.from) * eased;
    if (progress >= 1) {
      dvdState.travel = dash.to;
      dvdState.dash = null;
    }
  } else {
    dvdState.travel += step * speed / 1.5;
  }

  dvdState.mat.uniforms.uTravel.value = dvdState.travel;

  // Record each wall crossing as a ripple birth, in chronological order. The shader's walk reports
  // its hits most-recent-first, which is the same order as this list.
  if (!skipCross && isFinite(dvdState.travel)) {
    var cursor = dvdState.lastTravel;
    for (var guard = 0; guard < 16; guard++) {
      var nextHit = dvdNextBoundaryTravel(cursor + 1e-6, dir.x, dir.y, play.x, play.y);
      if (!isFinite(nextHit) || nextHit > dvdState.travel + 1e-6) break;
      dvdState.hitBirths.unshift(dvdState.rippleClock);
      dvdState.impactPulse = 1;
      dvdState.impactCount++;
      if (dvdState.hitBirths.length > 16) dvdState.hitBirths.length = 16;
      cursor = nextHit;
    }
  }
  dvdState.lastTravel = dvdState.travel;
  var ages = dvdState.mat.uniforms.uHitAges.value;
  for (var ai = 0; ai < 16; ai++) {
    ages[ai] = ai < dvdState.hitBirths.length
      ? Math.max(0, dvdState.rippleClock - dvdState.hitBirths[ai])
      : 99;
  }

  dvdState.beatPulse *= Math.exp(-step * 9);
  dvdState.impactPulse *= Math.exp(-step * 18);
  dvdState.mat.uniforms.uBeat.value = dvdState.beatPulse * dvdParam('beatPunch');
  dvdState.mat.uniforms.uImpact.value = dvdState.impactPulse * dvdParam('impactFlash');

  dvdState.mat.uniforms.iTime.value = dvdState.clock;
  dvdState.mat.uniforms.iFrame.value = dvdState.frames | 0;
  dvdState.frames++;
  void now;
  void sonicFrame;
  return true;
}

function dvdRenderFrame() {
  if (!dvdPresetIsActive()) return false;
  if (typeof renderer === 'undefined' || !renderer) return false;
  if (!dvdState.built && !dvdBuildScene()) return false;
  if (!dvdState.size) dvdState.size = new THREE.Vector2();
  renderer.getDrawingBufferSize(dvdState.size);
  var w = Math.max(32, dvdState.size.x || 1);
  var h = Math.max(32, dvdState.size.y || 1);
  dvdState.mat.uniforms.iResolution.value.set(w, h, 1);
  var prevAutoClear = renderer.autoClear;
  try {
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.render(dvdState.pass.scene, dvdState.pass.camera);
    return true;
  } catch (err) {
    dvdState.error = String(err && (err.message || err)).slice(0, 200);
    renderer.setRenderTarget(null);
    return false;
  } finally {
    renderer.autoClear = prevAutoClear;
  }
}

function dvdDisposeScene() {
  if (dvdState.mat) dvdState.mat.dispose();
  if (dvdState.geometry) dvdState.geometry.dispose();
  if (dvdState.noiseTex) dvdState.noiseTex.dispose();
  if (dvdState.coverBlurTex) dvdState.coverBlurTex.dispose();
  if (dvdState.fallbackTex) dvdState.fallbackTex.dispose();
  dvdState.built = false;
  dvdState.mat = null;
  dvdState.geometry = null;
  dvdState.noiseTex = null;
  dvdState.pass = null;
  dvdState.size = null;
  dvdState.fallbackTex = null;
  dvdState.coverCanvas = null;
  dvdState.coverBlurTex = null;
  dvdState.coverSource = null;
  dvdState.coverBlurPx = -1;
  dvdState.lightCss = '';
  dvdState.clock = 0;
  dvdState.travel = 0;
  dvdState.dash = null;
  dvdState.rippleClock = 0;
  dvdState.hitBirths = [];
  dvdState.lastTravel = 0;
  dvdState.pathKey = '';
  dvdState.beatPulse = 0;
  dvdState.impactPulse = 0;
  dvdState.beatCount = 0;
  dvdState.dashCount = 0;
  dvdState.impactCount = 0;
  dvdState.frames = 0;
}

function applyDvdPresetNow(prev, next) {
  var on = Number(next) === DVD_PRESET_INDEX;
  var was = Number(prev) === DVD_PRESET_INDEX;
  if (on) {
    dvdBuildScene();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('dvd-standby-preset');
  } else if (was) {
    dvdDisposeScene();
  }
  return on;
}

function dvdStandbyStatus() {
  return {
    active: dvdPresetIsActive(),
    built: dvdState.built,
    frames: dvdState.frames,
    clock: dvdState.clock,
    travel: dvdState.travel,
    rippleClock: dvdState.rippleClock,
    beats: dvdState.beatCount,
    dashes: dvdState.dashCount,
    impacts: dvdState.impactCount,
    beatPulse: dvdState.beatPulse,
    impactPulse: dvdState.impactPulse,
    error: dvdState.error
  };
}

// The reference is the whole screen: no app particles, no lyric layer.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'dvd-standby',
    isActive: dvdPresetIsActive,
    suppresses: {
      particles: true, bloom: true, float: true, backCover: true,
      starRiver: true, ripples: true, lyricsParticles: true, stageLyrics: true
    }
  });
}