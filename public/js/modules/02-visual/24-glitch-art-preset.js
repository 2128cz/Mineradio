'use strict';

// 故障艺术 (preset 19). Reference: Shadertoy "lfscD7" — Common + Buffer A + Buffer B + Image,
// supplied by the requester. Common and Buffer A are ported verbatim (GLSL3): the reference's
// hexagonal tiling, ripple/invert field, two-style time blend, static/vertical/horizontal
// interference, ordered-dither quantisation, supersampling and motion blur. Image is adapted: bloom
// + the downsampled Buffer A at 0.6 + pow(0.8) + mix(0.1,0.9) + vignette. The reference's #defines
// are uniforms (GLITCH_SCHEMA). Buffer B/Up's bloom is approximated by two kernel passes.
//
// Added on top (not in the reference): the app's lyrics, rasterised to canvas textures and run
// through the same fault primitives so the type matches the picture. Licence UNVERIFIED — see the
// sidecar / NOTICE before shipping.
//
// Every knob lives in GLITCH_SCHEMA (one home for the defaults); the audio wiring is the 8-band
// frame + beat fed through glitchFeedAudio().

var GLITCH_PRESET_INDEX = 19;

var GLITCH_SCHEMA = {
  // ---- Buffer A: the reference's picture controls
  downsample: { def: 3, min: 1, max: 5, kind: 'count', rebuild: 'pass' },
  antiAlias: { def: 2, min: 1, max: 5, kind: 'count', rebuild: 'live' },
  iterations: { def: 1, min: 1, max: 2, kind: 'count', rebuild: 'live' },
  turns: { def: 7, min: 3, max: 12, kind: 'count', rebuild: 'live' },
  ripples: { def: 5, min: 1, max: 8, kind: 'count', rebuild: 'live' },
  timeSpeed: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  speed: { def: 0.15, min: 0.03, max: 1, kind: 'ratio', rebuild: 'live' },
  zoom: { def: 0.35, min: 0.1, max: 1, kind: 'ratio', rebuild: 'live' },
  scale: { def: 1, min: 0.4, max: 2, kind: 'ratio', rebuild: 'live' },
  staticFrequency: { def: 0.1, min: 0, max: 0.5, kind: 'ratio', rebuild: 'live' },
  vDisplace: { def: 0.07, min: 0, max: 0.5, kind: 'ratio', rebuild: 'live' },
  hDisplace: { def: 0.25, min: 0, max: 0.5, kind: 'ratio', rebuild: 'live' },
  quantisation: { def: 5, min: 1, max: 16, kind: 'count', rebuild: 'live' },
  gradeHue: { def: 0.07, min: 0, max: 0.3, kind: 'ratio', rebuild: 'live' },
  // ---- presentation (the reference Image pass)
  bloomOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  bloomStrength: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  bloomRadius: { def: 0.02, min: 0.005, max: 0.06, kind: 'ratio', rebuild: 'live' },
  lift: { def: 0.1, min: 0, max: 0.5, kind: 'ratio', rebuild: 'live' },
  gamma: { def: 0.8, min: 0.4, max: 1.5, kind: 'ratio', rebuild: 'live' },
  vignetteStrength: { def: 0.5, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  vignetteScale: { def: 0.6, min: 0, max: 1.5, kind: 'ratio', rebuild: 'live' },
  vignetteExponent: { def: 3, min: 1, max: 8, kind: 'ratio', rebuild: 'live' },
  // ---- centre logo + glitched lyrics
  lyricOn: { def: 1, min: 0, max: 1, kind: 'bool', rebuild: 'live' },
  lyricWarp: { def: 0.05, min: 0, max: 0.25, kind: 'ratio', rebuild: 'live' },
  lyricFill: { def: 0.8, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  lyricGlitch: { def: 0.6, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  lyricSize: { def: 1, min: 0.5, max: 1.6, kind: 'ratio', rebuild: 'live' },
  styleCycle: { def: 6, min: 2, max: 20, kind: 'sec', rebuild: 'live' },
  // ---- audio wiring
  audioDrive: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  audioGlitch: { def: 0.6, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  audioTear: { def: 0.5, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  audioBloom: { def: 0.35, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  beatPulse: { def: 0.4, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  audioSpeed: { def: 0.5, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  audioStyle: { def: 0.5, min: 0, max: 1, kind: 'ratio', rebuild: 'live' },
  audioRipple: { def: 0.4, min: 0, max: 1, kind: 'ratio', rebuild: 'live' }
};

var GLITCH_SOURCE_FS = `precision highp float;
out vec4 outColor;
#define gl_FragColor outColor
uniform vec3 iResolution;
uniform float iTime;
uniform int iFrame;
uniform vec4 iMouse;
uniform sampler2D iChannel0;
uniform float uBloomOn;
uniform float uBloomRadius;
uniform float uScreenDownsample;

// *******************************************************************************************************
// Global variables


// ---- port uniforms (the reference's #defines, exposed by GLITCH_SCHEMA)
uniform float uCaptureSpeed;
uniform float uSpeed;
uniform float uZoom;
uniform float uScale;
uniform int uIterations;
uniform int uAntiAlias;
uniform int uTurns;
uniform int uRipples;
uniform float uStaticFreq;
uniform float uVDisplaceFreq;
uniform float uHDisplaceFreq;
uniform float uQuantisation;
uniform float uGradeHue;
uniform float uDrive;
uniform float uBass;
uniform float uTreble;
uniform float uBeat;
uniform float uAudioGlitch;
uniform float uAudioTear;

vec2 gResolution;
vec2 gFragCoord;
float gTime;
uvec4 rngSeed;
float gDxyDuv;

void SetGlobals(vec2 fragCoord, vec2 resolution, float time)
{
    gFragCoord = fragCoord;
    gResolution = resolution;
    gTime = time;
    
     // First derivative of screen to world space (assuming square pixels)
    gDxyDuv = 1.0 / gResolution.x;
}

// *******************************************************************************************************
//    Math functions
// *******************************************************************************************************

#define kPi                    3.14159265359
#define kTwoPi                 (2.0 * kPi)
#define kHalfPi                (0.5 * kPi)
#define kRoot2                 1.41421356237
#define kFltMax                3.402823466e+38
#define kIntMax                0x7fffffff
#define kOne                   vec3(1.0)
#define kZero                  vec3(0.0)
#define kPink                  vec3(1.0, 0.0, 0.2)

float cubrt(float a)           { return sign(a) * pow(abs(a), 1.0 / 3.0); }
float toRad(float deg)         { return kTwoPi * deg / 360.0; }
float toDeg(float rad)         { return 360.0 * rad / kTwoPi; }
float sqr(float a)             { return a * a; }
vec3 sqr(vec3 a)               { return a * a; }
int sqr(int a)                 { return a * a; }
float cub(float a)             { return a * a * a; }
int mod2(int a, int b)         { return ((a % b) + b) % b; }
float mod2(float a, float b)   { return mod(mod(a, b) + b, b); }
vec3 mod2(vec3 a, vec3 b)      { return mod(mod(a, b) + b, b); }
float length2(vec2 v)          { return dot(v, v); }
float length2(vec3 v)          { return dot(v, v); }
int sum(ivec2 a)               { return a.x + a.y; }
float luminance(vec3 v)        { return v.x * 0.17691 + v.y * 0.8124 + v.z * 0.01063; }
float mean(vec3 v)             { return v.x / 3.0 + v.y / 3.0 + v.z / 3.0; }
vec4 mul4(vec3 a, mat4 m)      { return vec4(a, 1.0) * m; }
vec3 mul3(vec3 a, mat4 m)      { return (vec4(a, 1.0) * m).xyz; }
float sin01(float a)           { return 0.5 * sin(a) + 0.5; }
float cos01(float a)           { return 0.5 * cos(a) + 0.5; }
float saturate(float a)        { return clamp(a, 0.0, 1.0); }
vec3 saturate(vec3 a)          { return clamp(a, 0.0, 1.0); }
vec4 saturate(vec4 a)          { return clamp(a, 0.0, 1.0); }
float saw01(float a)           { return abs(fract(a) * 2.0 - 1.0); }
float cwiseMax(vec3 v)         { return (v.x > v.y) ? ((v.x > v.z) ? v.x : v.z) : ((v.y > v.z) ? v.y : v.z); }
float cwiseMax(vec2 v)         { return (v.x > v.y) ? v.x : v.y; }
float cwiseMin(vec3 v)         { return (v.x < v.y) ? ((v.x < v.z) ? v.x : v.z) : ((v.y < v.z) ? v.y : v.z); }
float cwiseMin(vec2 v)         { return (v.x < v.y) ? v.x : v.y; }
void sort(inout float a, inout float b) { if(a > b) { float s = a; a = b; b = s; } }
void swap(inout float a, inout float b) { float s = a; a = b; b = s; }

vec3 safeAtan(vec3 a, vec3 b)
{
    vec3 r;
    #define kAtanEpsilon 1e-10
    r.x = (abs(a.x) < kAtanEpsilon && abs(b.x) < kAtanEpsilon) ? 0.0 : atan(a.x, b.x); 
    r.y = (abs(a.y) < kAtanEpsilon && abs(b.y) < kAtanEpsilon) ? 0.0 : atan(a.y, b.y); 
    r.z = (abs(a.z) < kAtanEpsilon && abs(b.z) < kAtanEpsilon) ? 0.0 : atan(a.z, b.z); 
    return r;
}

// *******************************************************************************************************
//    2D SVG
// *******************************************************************************************************

float SDFLine(vec2 p, vec2 v0, vec2 v1, float thickness)
{
    v1 -= v0;
    float t = saturate((dot(p, v1) - dot(v0, v1)) / dot(v1, v1));
    vec2 perp = v0 + t * v1;
    return saturate((thickness - length(p - perp)) / gDxyDuv);
}

float SDFQuad(vec2 p, vec2 v[4], float thickness)
{
    float c = 0.0;
    for(int i = 0; i < 4; i++)
    {
        c = max(c, SDFLine(p, v[i], v[(i+1)%4], thickness)); 
    }
 
    return c;
}

// *******************************************************************************************************
//    2D primitive tests
// *******************************************************************************************************

bool IsPointInQuad(vec2 uv, vec2 v[4])
{
    for(int i = 0; i < 4; i++)
    {
        if(dot(uv - v[i], v[i] - v[(i+1)%4]) > 0.0) { return false; }
    }
    return true;
}

// *******************************************************************************************************
//    Transforms 
// *******************************************************************************************************

mat3 WorldToViewMatrix(float rot, vec2 trans, float sca)
{   
    return mat3(vec3(cos(rot) / sca, sin(rot) / sca, trans.x), 
                vec3(-sin(rot) / sca, cos(rot) / sca, trans.y),
                vec3(1.0));
}

vec2 TransformScreenToWorld(vec2 p)
{   
    return (p - vec2(gResolution.xy) * 0.5) / float(gResolution.y); 
}


vec3 Cartesian2DToBarycentric(vec2 p)
{    
    return vec3(p, 0.0) * mat3(vec3(0.0, 1.0 / 0.8660254037844387, 0.0),
                          vec3(1.0, 0.5773502691896257, 0.0),
                          vec3(-1.0, 0.5773502691896257, 0.0));    
}

vec2 BarycentricToCartesian2D(vec3 b)
{    
    return vec2(b.y * 0.5 - b.z * 0.5, b.x * 0.8660254037844387);    
}

// Maps an input uv position to periodic hexagonal tiling
//     inout vec2 uv: The mapped uv coordinate
//     out vec3 bary: The Barycentric coordinates at the point on the hexagon
//     out ivec2 ij: The coordinate of the tile
vec2 Cartesian2DToHexagonalTiling(in vec2 uv, out vec3 bary, out ivec2 ij)
{    
    #define kHexRatio vec2(1.5, 0.8660254037844387)
    vec2 uvClip = mod(uv + kHexRatio, 2.0 * kHexRatio) - kHexRatio;
    
    ij = ivec2((uv + kHexRatio) / (2.0 * kHexRatio)) * 2;
    if(uv.x + kHexRatio.x <= 0.0) ij.x -= 2;
    if(uv.y + kHexRatio.y <= 0.0) ij.y -= 2;
    
    bary = Cartesian2DToBarycentric(uvClip);
    if(bary.x > 0.0)
    {
        if(bary.z > 1.0) { bary += vec3(-1.0, 1.0, -2.0); ij += ivec2(-1, 1); }
        else if(bary.y > 1.0) { bary += vec3(-1.0, -2.0, 1.0); ij += ivec2(1, 1); }
    }
    else
    {
        if(bary.y < -1.0) { bary += vec3(1.0, 2.0, -1.0); ij += ivec2(-1, -1); }
        else if(bary.z < -1.0) { bary += vec3(1.0, -1.0, 2.0); ij += ivec2(1, -1); }
    }

    return vec2(bary.y * 0.5773502691896257 - bary.z * 0.5773502691896257, bary.x);
}

bool InverseSternograph(inout vec2 uv, float zoom)
{
    float theta = length(uv) * kPi * zoom;
    if(theta >= kPi - 1e-1) { return false; }
    
    float phi = atan(-uv.y, -uv.x) + kPi;
    
    vec3 sph = vec3(cos(phi) * sin(theta), sin(phi) * sin(theta), -cos(theta));
    
    uv = vec2(sph.x / (1.0 - sph.z), sph.y / (1.0 - sph.z));
    return true;
}

float SmoothStep(float a, float b, float x) { return mix(a, b, x * x * (3.0 - 2.0 * x)); }
vec4 SmoothStep(vec4 a, vec4 b, float x)    { return mix(a, b, x * x * (3.0 - 2.0 * x)); }
float SmoothStep(float x)                   { return mix(0.0, 1.0, x * x * (3.0 - 2.0 * x)); }

float PaddedSmoothStep(float x, float a, float b)
{ 
    return SmoothStep(saturate(x * (a + b + 1.0) - a));
}

float PaddedSmoothStep(float x, float a)
{
    return PaddedSmoothStep(x, a, a);
}

float Impulse(float x, float axis, float stdDev)
{
    return exp(-sqr((x - axis) / stdDev));
}

float KickDrop(float t, vec2 p0, vec2 p1, vec2 p2, vec2 p3)
{
    if(t < p1.x)
    {
        return mix(p0.y, p1.y, max(0.0, exp(-sqr((t - p1.x)*2.145966026289347/(p1.x-p0.x))) - 0.01) / 0.99);
    }
    else if(t < p2.x)
    {
        return mix(p1.y, p2.y, (t - p1.x) / (p2.x - p1.x));
    }
    else
    {  
        return mix(p3.y, p2.y, max(0.0, exp(-sqr((t - p2.x)*2.145966026289347/(p3.x-p2.x))) - 0.01) / 0.99);
    }
}

float KickDrop(float t, vec2 p0, vec2 p1, vec2 p2)
{
    return KickDrop(t, p0, p1, p1, p2);
}

// *******************************************************************************************************
//    Random number generation
// *******************************************************************************************************

// Permuted congruential generator from "Hash Functions for GPU Rendering" (Jarzynski and Olano)
// http://jcgt.org/published/0009/03/02/paper.pdf
uvec4 PCGAdvance()
{
    rngSeed = rngSeed * 1664525u + 1013904223u;
    
    rngSeed.x += rngSeed.y*rngSeed.w; 
    rngSeed.y += rngSeed.z*rngSeed.x; 
    rngSeed.z += rngSeed.x*rngSeed.y; 
    rngSeed.w += rngSeed.y*rngSeed.z;
    
    rngSeed ^= rngSeed >> 16u;
    
    rngSeed.x += rngSeed.y*rngSeed.w; 
    rngSeed.y += rngSeed.z*rngSeed.x; 
    rngSeed.z += rngSeed.x*rngSeed.y; 
    rngSeed.w += rngSeed.y*rngSeed.z;
    
    return rngSeed;
}

// Generates a tuple of canonical random number and uses them to sample an input texture
vec4 Rand(sampler2D sampler)
{
    return texelFetch(sampler, (ivec2(gFragCoord) + ivec2(PCGAdvance() >> 16)) % 1024, 0);
}

// Generates a tuple of canonical random numbers in the range [0, 1]
vec4 Rand()
{
    return vec4(PCGAdvance()) / float(0xffffffffu);
}

// Seed the PCG hash function with the current frame multipled by a prime
void PCGInitialise(uint seed)
{    
    rngSeed = uvec4(20219u, 7243u, 12547u, 28573u) * seed;
}

// Reverse the bits of 32-bit inteter
uint RadicalInverse(uint i)
{
    i = ((i & 0xffffu) << 16u) | (i >> 16u);
    i = ((i & 0x00ff00ffu) << 8u) | ((i & 0xff00ff00u) >> 8u);
    i = ((i & 0x0f0f0f0fu) << 4u) | ((i & 0xf0f0f0f0u) >> 4u);
    i = ((i & 0x33333333u) << 2u) | ((i & 0xccccccccu) >> 2u);    
    i = ((i & 0x55555555u) << 1u) | ((i & 0xaaaaaaaau) >> 1u);        
    return i;
}

// Samples the radix-2 Halton sequence from seed value, i
float HaltonBase2(uint i)
{    
    return float(RadicalInverse(i)) / float(0xffffffffu);
}

const mat4 kOrderedDither = mat4(vec4(0.0, 8.0, 2.0, 10.), vec4(12., 4., 14., 6.), vec4(3., 11., 1., 9.), vec4(15., 7., 13., 5.));
float OrderedDither()
{    
    return (kOrderedDither[int(gFragCoord.x) & 3][int(gFragCoord.y) & 3] + 1.0) / 17.0;
}

float OrderedDither(ivec2 p)
{    
    return (kOrderedDither[p.x & 3][p.y & 3] + 1.0) / 17.0;
}

// *******************************************************************************************************
//    Hash functions
// *******************************************************************************************************

// Constants for the Fowler-Noll-Vo hash function
// https://en.wikipedia.org/wiki/Fowler-Noll-Vo_hash_function
#define kFNVPrime              0x01000193u
#define kFNVOffset             0x811c9dc5u
#define kDimsPerBounce         4

// Mix and combine two hashes
uint HashCombine(uint a, uint b)
{
    return (((a << (31u - (b & 31u))) | (a >> (b & 31u)))) ^
            ((b << (a & 31u)) | (b >> (31u - (a & 31u))));
}

// Compute a 32-bit Fowler-Noll-Vo hash for the given input
uint HashOf(uint i)
{
    uint h = (kFNVOffset ^ (i & 0xffu)) * kFNVPrime;
    h = (h ^ ((i >> 8u) & 0xffu)) * kFNVPrime;
    h = (h ^ ((i >> 16u) & 0xffu)) * kFNVPrime;
    h = (h ^ ((i >> 24u) & 0xffu)) * kFNVPrime;
    return h;
}

uint HashOf(uint a, uint b) { return HashCombine(HashOf(a), HashOf(b)); }
uint HashOf(uint a, uint b, uint c) { return HashCombine(HashCombine(HashOf(a), HashOf(b)), HashOf(c)); }
uint HashOf(uint a, uint b, uint c, uint d) { return HashCombine(HashCombine(HashOf(a), HashOf(b)), HashCombine(HashOf(c), HashOf(d))); }
uint HashOf(ivec2 v) { return HashCombine(HashOf(uint(v.x)), HashOf(uint(v.y))); }

// Samples the radix-2 Halton sequence from seed value, i
float HashToFloat(uint i)
{    
    return float(i) / float(0xffffffffu);
}

// *******************************************************************************************************
//    Colour functions
// *******************************************************************************************************

vec3 Hue(float phi)
{
    float phiColour = 6.0 * phi;
    int i = int(phiColour);
    vec3 c0 = vec3(((i + 4) / 3) & 1, ((i + 2) / 3) & 1, ((i + 0) / 3) & 1);
    vec3 c1 = vec3(((i + 5) / 3) & 1, ((i + 3) / 3) & 1, ((i + 1) / 3) & 1);             
    return mix(c0, c1, phiColour - float(i));
}

vec3 HSVToRGB(vec3 hsv)
{
    return mix(vec3(0.0), mix(vec3(1.0), Hue(hsv.x), hsv.y), hsv.z);
}

vec3 RGBToHSV( vec3 rgb)
{
    // Value
    vec3 hsv;
    hsv.z = cwiseMax(rgb);

    // Saturation
    float chroma = hsv.z - cwiseMin(rgb);
    hsv.y = (hsv.z < 1e-10) ? 0.0 : (chroma / hsv.z);

    // Hue
    if (chroma < 1e-10)        { hsv.x = 0.0; }
    else if (hsv.z == rgb.x)    { hsv.x = (1.0 / 6.0) * (rgb.y - rgb.z) / chroma; }
    else if (hsv.z == rgb.y)    { hsv.x = (1.0 / 6.0) * (2.0 + (rgb.z - rgb.x) / chroma); }
    else                        { hsv.x = (1.0 / 6.0) * (4.0 + (rgb.x - rgb.y) / chroma); }
    hsv.x = fract(hsv.x + 1.0);

    return hsv;
}

vec3 Overlay(vec3 a, vec3 b)
{
    //return (luminance(a) < 0.5) ? (2.0 * a * b) : (1.0 - 2.0 * (1.0 - a) * (1.0 - b));
    return vec3((a.x < 0.5) ? (2.0 * a.x * b.x) : (1.0 - 2.0 * (1.0 - a.x) * (1.0 - b.x)),
                (a.y < 0.5) ? (2.0 * a.y * b.y) : (1.0 - 2.0 * (1.0 - a.y) * (1.0 - b.y)),
                (a.z < 0.5) ? (2.0 * a.z * b.z) : (1.0 - 2.0 * (1.0 - a.z) * (1.0 - b.z)));
}

vec3 SoftLight(vec3 a, vec3 b)
{
    return (kOne - 2.0 * b) * sqr(a) + 2.0 * b * a;
}

// A Gaussian function that we use to sample the XYZ standard observer 
float CIEXYZGauss(float lambda, float alpha, float mu, float sigma1, float sigma2)
{
   return alpha * exp(sqr(lambda - mu) / (-2.0 * sqr(lambda < mu ? sigma1 : sigma2)));
}

vec3 SampleSpectrum(float delta)
{
	// Here we use a set of fitted Gaussian curves to approximate the CIE XYZ standard observer.
	// See https://en.wikipedia.org/wiki/CIE_1931_color_space for detals on the formula
	// This allows us to map the sampled wavelength to usable RGB values. This code needs cleaning 
	// up because we do an unnecessary normalisation steps as we map from lambda to XYZ to RGB.

    float lambda = mix(3800.0, 7000.0, delta);    

	#define kRNorm (7000.0 - 3800.0) / 1143.07
	#define kGNorm (7000.0 - 3800.0) / 1068.7
	#define kBNorm (7000.0 - 3800.0) / 1068.25

	// Sample the Gaussian approximations
	vec3 xyz;
	xyz.x = (CIEXYZGauss(lambda, 1.056, 5998.0, 379.0, 310.0) +
             CIEXYZGauss(lambda, 0.362, 4420.0, 160.0, 267.0) +
             CIEXYZGauss(lambda, 0.065, 5011.0, 204.0, 262.0)) * kRNorm;
	xyz.y = (CIEXYZGauss(lambda, 0.821, 5688.0, 469.0, 405.0) +
             CIEXYZGauss(lambda, 0.286, 5309.0, 163.0, 311.0)) * kGNorm;
	xyz.z = (CIEXYZGauss(lambda, 1.217, 4370.0, 118.0, 360.0) +
             CIEXYZGauss(lambda, 0.681, 4590.0, 260.0, 138.0)) * kBNorm;

	// XYZ to RGB linear transform
	vec3 rgb;
	rgb.r = (2.04159 * xyz.x - 0.5650 * xyz.y - 0.34473 * xyz.z) / (2.0 * 0.565);
	rgb.g = (-0.96924 * xyz.x + 1.87596 * xyz.y + 0.04155 * xyz.z) / (2.0 * 0.472);
	rgb.b = (0.01344 * xyz.x - 0.11863 * xyz.y + 1.01517 * xyz.z) / (2.0 * 0.452);

	return rgb;
}

// *******************************************************************************************************
//    Filters
// *******************************************************************************************************

#define kBloomTint                vec3(1.0)       // The tint applied to the bloom effect
#define kBloomRadius vec2(uBloomRadius / uScreenDownsample)          
#define kBloomKernelShape         vec3(1.5, 1.0, 0.7)            // The fall-off of the bloom shape. Higher value = steeper fall-off
#define kBloomDownsample          3               // How much the bloom buffer is downsampled. Higher value = lower quality, but faster
#define kDebugBloom               false           // Show only the bloom in the final comp
#define kBloomBurnout              vec3(0.2) 


void Gaussian(in int k, in int radius, in vec3 rgbK, in vec3 kernelShape, inout vec3 sigmaL, inout vec3 sigmaWeights)
{
    float d = float(abs(k)) / float(radius);
    vec3 weight = pow(max(vec3(0.), (exp(-sqr(vec3(d) * 4.0)) - 0.0183156) / 0.981684), kernelShape);         

    sigmaL += rgbK * weight;
    sigmaWeights += weight;
}

void Epanechnikov(in int k, in int radius, in vec3 rgbK, in vec3 kernelShape, inout vec3 sigmaL, inout vec3 sigmaWeights)
{
    float d = float(abs(k)) / float(radius);
    float weight = 1. - d*d;

    sigmaL += rgbK * weight;
    sigmaWeights += weight;
}

#define glitchGaussian Gaussian
//#define glitchGaussian Epanechnikov

vec3 SeparableBlurDown(ivec2 xy, ivec2 res, sampler2D sampler)
{
    if(xy.y == 0 || xy.x >= res.x / kBloomDownsample || xy.y >= res.y / kBloomDownsample)
    {
        return kZero;
    }
    else
    {
        int radius = int(0.5 + float(min(res.x, res.y)) * kBloomRadius.x / float(kBloomDownsample));    
        vec3 sigmaL = kZero, sigmaWeights = kZero;
        for(int k = -radius; k <= radius; ++k)
        {
            ivec2 ij = (xy + ivec2(k, 0)) * kBloomDownsample;
            vec3 texel = texelFetch(sampler, ij, 0).xyz;
            texel = max(kZero, texel - vec3(kBloomBurnout));
            glitchGaussian(k, radius, texel, kBloomKernelShape, sigmaL, sigmaWeights);
        }

        return sigmaL / max(kOne, sigmaWeights);
    }
}

vec3 SeparableBlurUp(ivec2 xyFrag, ivec2 res, sampler2D sampler)
{   
    int radius = int(0.5 + float(min(res.x, res.y)) * kBloomRadius.y / float(kBloomDownsample));    
    vec3 sigmaL = kZero, sigmaWeights = kZero;
    for(int k = -radius; k <= radius; ++k)
    {        
        vec2 uv = (vec2(xyFrag + ivec2(0, k * kBloomDownsample)) - 0.5) / vec2(res);

        vec3 texel = texture(sampler, uv / float(kBloomDownsample), 0.0).xyz;
        
        glitchGaussian(k, radius, texel, kBloomKernelShape, sigmaL, sigmaWeights);
    }

    return sigmaL / max(kOne, sigmaWeights);
}


#define kCaptureTimeDelay 0.0

vec3 Render(vec2 uvScreen, int idx, int maxSamples, bool isDisplaced, float jpegDamage, out float blend)
{       
    #define kMBlurGain      (isDisplaced ? 100. : 10.0)
    #define kZoomOrder      2
    #define kEndPause       0.0
     
    // x: Lambda
    // y: Motion blur
    // z, w: Warping and distortion
    
    // Sample the time domain for motion blur
    vec4 xi = Rand(iChannel0);
    uint hash = HashOf(uint(98796523), uint(gFragCoord.x), uint(gFragCoord.y));        
    xi.y = (float(idx) + HaltonBase2(uint(idx) + hash)) / float(maxSamples);
    //xi.x = OrderedDither();
    xi.x = xi.y;
    float time = 1. * max(0.0, iTime - kCaptureTimeDelay);
    time = (time * uCaptureSpeed + xi.y * kMBlurGain / 60.0 + uBeat * 0.08 * uDrive * uAudioStyle) * uSpeed; 
    //time = time - 0.2 * sqrt(uvScreen.y / iResolution.y);
    
    float phase = fract(time);
    int interval = int(time) & 1;    
    interval <<= 1;
    float morph;
    float warpedTime;
    float spectrumBlend;
    #define kIntervalPartition 0.85
    if(phase < kIntervalPartition)
    {
        float y = (interval == 0) ? uvScreen.y : (iResolution.y - uvScreen.y);
        warpedTime = (phase / kIntervalPartition) - 0.2 * sqrt(y / iResolution.y) - 0.1;
        phase = fract(warpedTime);
        morph = 1.0 - PaddedSmoothStep(sin01(kTwoPi * phase), 0., 0.4);
        blend = float(interval / 2) * 0.5;
        if(interval == 2) { warpedTime *= 0.5; }
    }
    else
    {
        time -= 0.8 * uSpeed * xi.y * kMBlurGain / 60.0;
        warpedTime = time;
        phase = (fract(time) - kIntervalPartition) / (1.0 - kIntervalPartition);
        morph = 1.0;
        blend = (KickDrop(phase, vec2(0.0, 0.0), vec2(0.2, -0.1), vec2(0.3, -0.1), vec2(0.7, 1.0)) + float(interval / 2)) * 0.5;        
        interval++;
    }
    
    float beta = abs(2.0 * max(0.0, blend) - 1.0);
    
    int kMaxIterations = uIterations;
    //int kMaxIterations = 2 + 2 * int(round(jpegDamage));
    int kTurns = uTurns;
    int kNumRipples = uRipples;
    //#define kRippleDelay 1.
    float kRippleDelay = float(kNumRipples) / float(kTurns);
    #define kThickness mix(0.5, 0.4, morph)
    #define kExponent mix(0.05, 0.55, morph)
    
    float expMorph = pow(morph, 0.3);
    //#define kZoom mix(0.3, 0.3, expMorph)
    float kScale = mix(2.6, 1.1, expMorph) * uScale;
    //float kScale = (exp(5. * (1. - expMorph)) - 1.) + 1.05;
    
    //#define kZoom 0.35
    //#define kScale mix(1.7, 1.3, pow(phase, 0.3))    

    // Apply the transformation matrix and clip to screen space
    mat3 M = WorldToViewMatrix(blend * kTwoPi, vec2(0.0), uZoom);
    vec2 uvView = TransformScreenToWorld(uvScreen);
    int invert = 0;
     
   
    // Defocus blur
    //vec4 blueNoise = texture(iChannel0, vec2(fract(iTime * 0.002), 0.5));
    //blueNoise = pow(saturate((blueNoise - 0.5) / (1.0 - 0.5)), vec4(2.0));
    //uvView += vec2(cos(kTwoPi * xi.z), sin(kTwoPi * xi.z)) * xi.w * 0.05 * blueNoise.x;
    
    // Chromatic aberration
    //uvView /= 1.0 + mix(0.1, 0.5, length(uvView) * xiLambda * blueNoise.y); // Dynamic
    uvView /= 1.0 + 0.05 * length(uvView) * xi.z; // Static
    
    //uvView *= 1.0 + length(uvView) * xi * 0.05;

    uvView = (vec3(uvView, 1.0) * M).xy; 
    
     vec3 bary;
    ivec2 ij;
    Cartesian2DToHexagonalTiling(uvView / 1.4, bary, ij);    
    //float len = cwiseMax(abs(bary * mix(1.2, 1., cos01(1. * kTwoPi * blend))));
    float len = cwiseMax(abs(bary));
    //if(ij == ivec2(0) && len > 0.995 && len <= 1.) invert = 1;
    
    vec2 uvViewWarp = uvView;
    uvViewWarp.y *= mix(1.0, 0.1, sqr(1.0 - morph) * xi.y * saturate(sqr(0.5 * (1.0 + uvView.y))));   
    //uvViewWarp.x += mix(-1.0, 1.0, xi.w) * 0.002;
    
    float theta = toRad(30.0) * beta;
    mat2 r = mat2(vec2(cos(theta), -sin(theta)), vec2(sin(theta), cos(theta)));
    uvViewWarp = r * uvViewWarp;    

    vec3 sigma = vec3(0.0);
    for(int iterIdx = 0; iterIdx < kMaxIterations; ++iterIdx)
    {   
        vec3 bary;
        ivec2 ij;
        Cartesian2DToHexagonalTiling(uvViewWarp, bary, ij);        
                        
        if(!isDisplaced && ij != ivec2(0)) { break; }   
        
        //if(iterIdx == 0 && cwiseMax(abs(bary)) > 0.99) { invert = invert ^ 1; }
        
        int subdiv = 1 + int(exp(-sqr(10. * mix(-1., 1., phase))) * 100.);
        
        float theta = kTwoPi * (floor(cos01(kTwoPi * phase) * 12.) / 6.);
        Cartesian2DToHexagonalTiling(uvViewWarp * (0.1 + float(subdiv)) - kHexRatio.y * vec2(sin(theta), cos(theta)) * floor(0.5 + sin01(kTwoPi * phase) * 2.) / 2., bary, ij);        
        uint hexHash = HashOf(uint(phase * 6.), uint(subdiv), uint(ij.x), uint(ij.y));
        if(hexHash % 2u == 0u)
        {
            float alpha = PaddedSmoothStep(sin01(phase * 20.0), 0.2, 0.75);
            float dist = mix(cwiseMax(abs(bary)), length(uvView) * 2.5, 1.0 - alpha);
            float hashSum = bary[hexHash % 3u] + bary[(hexHash + 1u) % 3u];

            if( dist > 1.0 - 0.02 * float(subdiv)) { invert = invert ^ 1; }
            else if( fract(20. / float(subdiv) * hashSum) < 0.5)  { invert = invert ^ 1; }
            if(iterIdx == 0) break;
        }
        
        float sigma = 0.0, sigmaWeight = 0.0;
        for(int j = 0; j < kTurns; ++j)
        {   
            float delta = float(j) / float(kTurns);
            float theta = kTwoPi * delta;
            for(int i = 0; i < kNumRipples; ++i)
            {
                float l = length(uvViewWarp - vec2(cos(theta), sin(theta))) * 0.5;
                float weight = log2(1.0 / (l + 1e-10));
                sigma += fract(l - pow(fract((float(j) + float(i) / kRippleDelay) / float(kTurns) + warpedTime), kExponent)) * weight;
                sigmaWeight += weight;
            }            
        }
        invert = invert ^ int((sigma / sigmaWeight) > kThickness);
        
        //return vec3(sigma / sigmaWeight); 
       
        theta = kTwoPi * (floor(cos01(kTwoPi * -phase) * 5. * 6.) / 6.);
        uvViewWarp = r * (uvViewWarp + vec2(cos(theta), sin(theta)) * 0.5);
        uvViewWarp *= kScale; 
    }
    
    sigma = vec3(float(invert != 0));
    
    float spectrumDelta = fract(xi.x + uTreble * 0.25 * uDrive);
    return mix(1.0 - sigma, sigma * mix(kOne, SampleSpectrum(spectrumDelta), sqr(beta)), beta);
}

bool Interfere(inout vec2 xy, inout vec3 tint, in vec2 res)
{
    #define kStatic true
    
    #define kStaticLowMagnitude 0.01
    #define kStaticHighMagnitude 0.02
    
    #define kVDisplace true
    
    
    #define kHDisplace true
    
    #define kHDisplaceVMagnitude 0.1
    #define kHDisplaceHMagnitude 0.5
    
    float frameHash = HashToFloat(HashOf(uint(iFrame / int(10.0 / uCaptureSpeed))));
    bool isDisplaced = false;
    
    if(kStatic)
    {
        // Every now and then, add a ton of static
        float interP = 0.01, displacement = res.x * kStaticLowMagnitude;
        if(frameHash < uStaticFreq + uBass * 0.12 * uDrive * uAudioGlitch)
        {
            interP = 0.5;
            displacement = kStaticHighMagnitude * res.x;
            tint = vec3(0.5);
        }

        // CRT interference at PAL refresh rate 
        PCGInitialise(HashOf(uint(xy.y / 2.), uint(iFrame / int(60.0 / (24.0 * uCaptureSpeed)))));
        vec4 xi = Rand();
        if(xi.x < interP) 
        {  
            float mag = mix(-1.0, 1.0, xi.y);        
            xy.x -= displacement * sign(mag) * sqr(abs(mag)); 
            //isDisplaced = true;
        }
    }
    
    // Vertical displacment
    if(kVDisplace && frameHash > 1.0 - uVDisplaceFreq - uBeat * 0.12 * uDrive * uAudioGlitch)
    {
        float dispX = HashToFloat(HashOf(8783u, uint(iFrame / int(10.0 / uCaptureSpeed))));
        float dispY = HashToFloat(HashOf(364719u, uint(iFrame / int(12.0 / uCaptureSpeed))));
        
        if(xy.y < dispX * res.y) 
        { 
            xy.y -= mix(-1.0, 1.0, dispY) * res.y * 0.2; 
            isDisplaced = true;
            tint = vec3(3.);
        }
    }
    // Horizontal displacment
    else if(kHDisplace && frameHash > 1.0 - uHDisplaceFreq - uVDisplaceFreq - uBeat * 0.12 * uDrive * uAudioGlitch)
    {
        float dispX = HashToFloat(HashOf(147251u, uint(iFrame / int(9.0 / uCaptureSpeed))));
        float dispY = HashToFloat(HashOf(287512u, uint(iFrame / int(11.0 / uCaptureSpeed))));
        float dispZ = HashToFloat(HashOf(8756123u, uint(iFrame / int(7.0 / uCaptureSpeed))));
        
        if(xy.y > dispX * res.y && xy.y < (dispX + mix(0.0, kHDisplaceVMagnitude, dispZ)) * res.y) 
        { 
            xy.x -= mix(-1.0, 1.0, dispY) * res.x * kHDisplaceHMagnitude; 
            isDisplaced = true;
            tint = vec3(3.);
        }
    }
    
    return isDisplaced;
}

void mainImage( out vec4 rgba, in vec2 xy )
{
    rgba = vec4(0.);
    SetGlobals(xy, iResolution.xy, iTime);   
    
    if(xy.x > iResolution.x / uScreenDownsample || xy.y > iResolution.y / uScreenDownsample) { return; }      
    
    xy *= uScreenDownsample;
       
    vec3 tint;
    vec2 xyInterfere = xy;
    bool isDisplaced = Interfere(xyInterfere, tint, iResolution.xy);
    
    ivec2 xyDither = ivec2(xy) / int(HashOf(uint(iTime + sin(iTime) * 1.5), uint(xyInterfere.x / 128.), uint(xyInterfere.y / 128.)) & 127u);
    float jpegDamage = OrderedDither(xyDither);
   
    int aa = uAntiAlias;
    vec3 rgb = vec3(0.0);
    float blend = 0.0;
    for(int i = 0, idx = 0; i < aa; ++i)
    {
        for(int j = 0; j < aa; ++j, ++idx)
        {
            vec2 xyAA = xyInterfere + vec2(float(i) / float(aa), float(j) / float(aa));            
            
            rgb += Render(xyAA, idx, aa * aa, isDisplaced, jpegDamage, blend);
        }
    }
    
    rgb /= float(sqr(aa));
    rgb = mix(rgb, Overlay(rgb, vec3(.15, 0.29, 0.39)), blend);
    
    if(isDisplaced)
    {
        
        //int kColourQuantisation = (isDisplaced) ? 2 : (5 + int(HashOf(uint(iTime + cos(iTime) * 1.5), uint(xyInterfere.x / 128.), uint(xyInterfere.y / 128.)) % 5u));
        rgb *= uQuantisation;
        if(fract(rgb.x) > jpegDamage) rgb.x += 1.0;
        if(fract(rgb.y) > jpegDamage) rgb.y += 1.0;
        if(fract(rgb.z) > jpegDamage) rgb.z += 1.0;
        rgb = floor(rgb) / uQuantisation;
    }

        
    // Scanlines
    //rgb *= mix(1.0, 0.9, float((int(xy.y) / kScreenDownsample) & 1));
    
    // Grade
    vec3 hsv = RGBToHSV(rgb);    
    hsv.x += -sin((hsv.x + 0.05) * kTwoPi) * uGradeHue;
    hsv.y *= 1.0;    
    rgb = HSVToRGB(hsv);
    
    rgba.xyz = rgb;    
    rgba.w = 1.0;
}
void main() {
  vec4 c = vec4(0.0);
  mainImage(c, gl_FragCoord.xy);
  gl_FragColor = c;
}
`;

// Component split: the reference calls SeparableBlurUp() inside the composite. Here the separable
// blur is its own pair of passes (horizontal, then vertical) over the low-res source, so the
// composite only has to fetch the finished bloom once.
var GLITCH_BLUR_FS = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 18.0);
    sum += texture2D(uTex, vUv + uDir * uTexel * fi * uRadius).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}
`;

// The supplied presentation fragment, kept in Shadertoy shape: Vignette() verbatim with its three
// #defines lifted to uniforms, then the bloom + texelFetch(downsampled screen) + saturate/pow/lift
// chain. texelFetch(iChannel1, ivec2(xy)/kScreenDownsample) becomes a nearest sample at the centre
// of the matching low-res texel.
var GLITCH_COMPOSITE_FS = `
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform float uAudioStyle;
uniform vec2 uLowRes;
uniform float uDs;
uniform float uBloomOn;
uniform float uBloomStrength;
uniform float uLift;
uniform float uGamma;
uniform float uVigStrength;
uniform float uVigScale;
uniform float uVigExponent;
uniform sampler2D uLyricMain;
uniform sampler2D uLyricSub;
uniform vec4 uMainRect;
uniform vec4 uSubRect;
uniform float uLyricOn;
uniform float uLyricGlitch;
uniform float uLyricWarp;
uniform float uLyricFill;
uniform float uHasSub;
uniform float uStyleHue;
uniform float uAspect;
uniform float uStyleSeed;
uniform float uBass;
const float kRoot2 = 1.41421356237;
const float kTau = 6.28318530718;

float glitchHash(float n) {
  vec3 p3 = fract(vec3(n) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float glitchHash2(vec2 p, float seed) {
  return glitchHash(p.x * 127.1 + p.y * 311.7 + seed * 17.0);
}
vec3 glitchHsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}

float Vignette(vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  uv.x = (uv.x - 0.5) * (iResolution.x / iResolution.y) + 0.5;
  float x = 2.0 * (uv.x - 0.5);
  float y = 2.0 * (uv.y - 0.5);
  float dist = sqrt(x * x + y * y) / kRoot2;
  return mix(1.0, max(0.0, 1.0 - pow(dist * uVigScale, uVigExponent)), uVigStrength);
}

// Lyric plate: the glyphs are filled with the reference field and warped by it, so the text tears
// with the picture instead of carrying an unrelated random collage. The canvas text becomes the
// rim/glow; the field supplies the interior and the displacement.
vec4 lyricPlate(vec2 uv, sampler2D tex, vec4 rect, float seed) {
  vec2 cell = min(floor(gl_FragCoord.xy / max(1.0, uDs)), uLowRes - 1.0);
  vec3 field = texture2D(iChannel1, (cell + 0.5) / uLowRes).xyz;
  float lum = dot(field, vec3(0.17691, 0.8124, 0.01063));
  vec2 warp = vec2((field.r - field.b) * uLyricWarp, (lum - 0.5) * uLyricWarp * 0.5);
  vec2 tuv = (uv + warp - rect.xy) / rect.zw;
  float inside = step(0.0, tuv.x) * step(tuv.x, 1.0) * step(0.0, tuv.y) * step(tuv.y, 1.0);
  tuv = clamp(tuv, 0.0, 1.0);
  vec4 c0 = texture2D(tex, tuv);
  vec2 off = vec2((field.g - 0.5) * 0.012 * uLyricGlitch + 0.0015, 0.0);
  float aR = texture2D(tex, clamp(tuv + off, 0.0, 1.0)).a;
  float aB = texture2D(tex, clamp(tuv - off, 0.0, 1.0)).a;
  float a = max(c0.a, max(aR, aB) * 0.7);
  vec3 fillCol = field * 1.6 + c0.rgb * 0.5;
  vec3 col = mix(c0.rgb, fillCol, uLyricFill);
  col += vec3(1.0, 0.25, 0.55) * max(0.0, aB - aR) * uLyricGlitch * 0.6;
  col += glitchHsv(fract(uStyleHue + 0.5), 0.9, 1.0) * max(0.0, aR - aB) * uLyricGlitch * 0.6;
  float scan = 1.0 - 0.10 * (0.5 + 0.5 * sin(uv.y * 950.0));
  return vec4(col * scan, max(c0.a, max(aR, aB) * 0.7) * inside);
}

void mainImage(out vec4 rgba, vec2 xy) {
  vec2 uv = xy / iResolution.xy;
  vec3 rgb = vec3(0.0);
  if (uBloomOn > 0.5) rgb = texture2D(iChannel0, xy / iResolution.xy).xyz * uBloomStrength;
  vec2 cell = floor(xy / max(1.0, uDs));
  cell = min(cell, uLowRes - 1.0);
  rgb += texture2D(iChannel1, (cell + 0.5) / uLowRes).xyz * 0.6;
  rgb = clamp(rgb, 0.0, 1.0);
  rgb = pow(rgb, vec3(uGamma));
  rgb = mix(vec3(uLift), vec3(1.0 - uLift), rgb);
  float vig = Vignette(xy);
  rgb *= vig;
  if (uLyricOn > 0.5) {
    float phase = uStyleSeed;
    vec4 main = lyricPlate(uv, uLyricMain, uMainRect, phase * 2.7 + 1.0);
    main.rgb *= vig;
    rgb = mix(rgb, main.rgb, main.a);
    if (uHasSub > 0.5) {
      vec4 sub = lyricPlate(uv, uLyricSub, uSubRect, phase * 2.7 + 5.0);
      sub.rgb *= vig;
      rgb = mix(rgb, sub.rgb, sub.a);
    }
  }
  rgba = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}

void main() {
  vec4 rgba = vec4(0.0);
  mainImage(rgba, gl_FragCoord.xy);
  gl_FragColor = rgba;
}
`;

var GLITCH_QUAD_VS_GLSL3 = 'void main() { gl_Position = vec4(position.xy, 0.999999, 1.0); }';

var GLITCH_QUAD_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.999999, 1.0);
}
`;

var glitchState = {
  built: false,
  error: '',
  size: null,
  lowRt: null,
  bloomA: null,
  bloomB: null,
  lowW: 0,
  lowH: 0,
  bloomW: 0,
  bloomH: 0,
  sourceMat: null,
  blurMat: null,
  compositeMat: null,
  passes: null,
  frames: 0,
  mainCanvas: null,
  subCanvas: null,
  mainTex: null,
  subTex: null,
  mainKey: '',
  subKey: '',
  noiseTex: null
};

function glitchClamp(value, min, max) {
  var n = Number(value);
  if (!isFinite(n)) n = min;
  return Math.min(max, Math.max(min, n));
}

function glitchParam(key) {
  var spec = GLITCH_SCHEMA[key];
  var raw = (typeof glitchArtTuning !== 'undefined' && glitchArtTuning && glitchArtTuning[key] !== undefined)
    ? glitchArtTuning[key]
    : (spec ? spec.def : 0);
  var n = Number(raw);
  if (!isFinite(n)) n = spec ? spec.def : 0;
  return spec ? glitchClamp(n, spec.min, spec.max) : n;
}

function glitchPresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === GLITCH_PRESET_INDEX;
}

// ---------------------------------------------------------------- spectrum + bands

function glitchBandValues(frame) {
  var out = [0, 0, 0, 0, 0, 0, 0, 0];
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


// ---------------------------------------------------------------- lyric plates + centre logo
// The text is a canvas texture; the composite glitches it in screen space, which is what lets the
// same fault effect run over type. Timeline/font/colour helpers are the app's (shared with the
// town preset), so the console's lyric settings keep working here.

function glitchLyricItems() {
  if (typeof nyanTownLyricItems === 'function') { try { return nyanTownLyricItems(); } catch (_) {} }
  return [];
}
function glitchLyricSung(items, t) {
  if (typeof nyanTownLyricSungIndex === 'function') { try { return nyanTownLyricSungIndex(items, t); } catch (_) {} }
  return -1;
}
function glitchLyricPalette() {
  if (typeof nyanTownLyricPalette === 'function') { try { return nyanTownLyricPalette(); } catch (_) {} }
  return { primary: '#d6f8ff', highlight: '#eef7ff', context: '#9cffdf', glow: '#9cffdf', signature: 'default' };
}
function glitchLyricFontCss(px) {
  if (typeof nyanTownLyricFontCss === 'function') { try { return nyanTownLyricFontCss(px); } catch (_) {} }
  return '900 ' + px.toFixed(1) + 'px sans-serif';
}
function glitchTranslationShown() {
  if (typeof nyanTownLyricTranslationShown === 'function') { try { return !!nyanTownLyricTranslationShown(); } catch (_) {} }
  return false;
}
function glitchLyricSpacing(px) {
  if (typeof lyricLetterSpacingPx === 'function') { try { return Number(lyricLetterSpacingPx(px)) || 0; } catch (_) {} }
  return 0;
}

function glitchDrawPlate(canvas, text, fontPx, color, glow) {
  if (!canvas || !text) return false;
  var ctx = canvas.getContext('2d');
  var w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  var size = fontPx;
  var font = glitchLyricFontCss(size);
  ctx.font = font;
  var spacing = glitchLyricSpacing(size);
  if ('letterSpacing' in ctx) ctx.letterSpacing = spacing.toFixed(2) + 'px';
  var width = ctx.measureText(text).width || 0;
  var limit = w * 0.94;
  if (width > limit && width > 0) {
    size *= limit / width;
    font = glitchLyricFontCss(size);
    ctx.font = font;
    spacing = glitchLyricSpacing(size);
    if ('letterSpacing' in ctx) ctx.letterSpacing = spacing.toFixed(2) + 'px';
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(4, 2, 12, 0.72)';
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.strokeText(text, w / 2, h / 2);
  ctx.shadowColor = glow;
  ctx.shadowBlur = size * 0.32;
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);
  ctx.shadowBlur = 0;
  ctx.fillText(text, w / 2, h / 2);
  return true;
}

function glitchUpdateLyrics(clock) {
  var cu = glitchState.compositeMat && glitchState.compositeMat.uniforms;
  if (!cu || !glitchState.mainTex) return;
  var items = glitchLyricItems();
  var t = clock;
  if (typeof getAdjustedLyricPlaybackTime === 'function') {
    var adjusted = Number(getAdjustedLyricPlaybackTime(clock));
    if (isFinite(adjusted)) t = adjusted;
  }
  var sung = glitchLyricSung(items, t);
  var item = (sung >= 0 && items[sung]) ? items[sung] : null;
  var palette = glitchLyricPalette();
  var subText = (item && glitchTranslationShown()) ? String(item.sub || '') : '';
  if (item) {
    var mainKey = palette.signature + '|' + item.text;
    if (glitchState.mainKey !== mainKey) {
      glitchDrawPlate(glitchState.mainCanvas, item.text, 118, palette.highlight, palette.glow);
      glitchState.mainKey = mainKey;
      glitchState.mainTex.needsUpdate = true;
    }
  } else if (glitchState.mainKey !== '') {
    glitchState.mainCanvas.getContext('2d').clearRect(0, 0, glitchState.mainCanvas.width, glitchState.mainCanvas.height);
    glitchState.mainKey = '';
    glitchState.mainTex.needsUpdate = true;
  }
  var subKey = palette.signature + '|' + subText;
  if (glitchState.subKey !== subKey) {
    if (subText) glitchDrawPlate(glitchState.subCanvas, subText, 54, palette.context, palette.glow);
    else glitchState.subCanvas.getContext('2d').clearRect(0, 0, glitchState.subCanvas.width, glitchState.subCanvas.height);
    glitchState.subKey = subKey;
    glitchState.subTex.needsUpdate = true;
  }
  cu.uHasSub.value = subText ? 1 : 0;
}

// One phase drives the logo's hue and the lyric glitch seed: the two move through styles together.
function glitchUpdateStyle(clock) {
  var cu = glitchState.compositeMat && glitchState.compositeMat.uniforms;
  if (!cu) return;
  var cycle = Math.max(2, glitchParam('styleCycle'));
  var seed = Math.floor(clock / cycle);
  cu.uStyleSeed.value = seed;
  cu.uStyleHue.value = (glitchParam('gradeHue') * 3 + seed * 0.137) % 1;
  cu.uLyricOn.value = glitchParam('lyricOn') > 0 ? 1 : 0;
  var aspect = cu.uAspect.value || 1.78;
  var scale = glitchParam('lyricSize');
  var mainW = Math.min(1.35, 0.92 * scale);
  var mainH = mainW * aspect / (1536 / 224);
  var mainY = Math.min(0.64, 0.97 - mainH);
  var subW = Math.min(1.1, 0.62 * scale);
  var subH = subW * aspect / (1024 / 112);
  var subY = Math.max(0.03, Math.min(0.16, 0.33 - subH));
  cu.uMainRect.value.set(0.5 - mainW / 2, mainY, mainW, mainH);
  cu.uSubRect.value.set(0.5 - subW / 2, subY, subW, subH);
}

// The whole audio wiring is here: bands -> the source uniforms, the spectrum -> the 64-bin texture,
// and the master drive knobs. Nothing else in the preset reads audio.
function glitchFeedAudio(frame) {
  var bands = glitchBandValues(frame);
  var drive = glitchParam('audioDrive');
  var beat = (typeof beatPulse !== 'undefined' && isFinite(beatPulse)) ? Number(beatPulse) : 0;
  var u = glitchState.sourceMat && glitchState.sourceMat.uniforms;
  if (u) {
    u.uBass.value = bands[1];
    u.uTreble.value = bands[6];
    u.uBeat.value = glitchClamp(beat, 0, 1) * glitchParam('beatPulse');
    u.uAudioStyle.value = glitchParam('audioStyle');
    u.uCaptureSpeed.value = glitchParam('timeSpeed') * (1 + glitchParam('audioSpeed') * bands[1] * drive);
    u.uRipples.value = Math.max(1, Math.min(8, Math.round(glitchParam('ripples') + glitchParam('audioRipple') * glitchClamp(beat, 0, 1) * 3)));
  }
  var cu = glitchState.compositeMat && glitchState.compositeMat.uniforms;
  if (cu) {
    cu.uBloomStrength.value = glitchParam('bloomStrength') * (1 + glitchParam('audioBloom') * bands[1] * drive);
    cu.uBass.value = bands[1];
    cu.uLyricGlitch.value = glitchParam('lyricGlitch') * (0.65 + 0.7 * bands[6] * drive);
  }
}

// ---------------------------------------------------------------- pass plumbing

function glitchMakePass(material, geometry) {
  var scene = new THREE.Scene();
  var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene: scene, camera: camera, mesh: mesh };
}

function glitchBuildScene() {
  if (glitchState.built) return true;
  try {
    var mainCanvas = document.createElement('canvas');
    mainCanvas.width = 1536;
    mainCanvas.height = 224;
    var subCanvas = document.createElement('canvas');
    subCanvas.width = 1024;
    subCanvas.height = 112;
    var mainTex = new THREE.CanvasTexture(mainCanvas);
    mainTex.minFilter = THREE.LinearFilter;
    mainTex.magFilter = THREE.LinearFilter;
    mainTex.generateMipmaps = false;
    var subTex = new THREE.CanvasTexture(subCanvas);
    subTex.minFilter = THREE.LinearFilter;
    subTex.magFilter = THREE.LinearFilter;
    subTex.generateMipmaps = false;
    var noiseData = new Uint8Array(1024 * 1024 * 4);
    var noiseSeed = 0x9e3779b9;
    for (var ni = 0; ni < noiseData.length; ni += 4) {
      noiseSeed = (noiseSeed * 1664525 + 1013904223) >>> 0;
      noiseData[ni] = noiseSeed & 255;
      noiseData[ni + 1] = (noiseSeed >>> 8) & 255;
      noiseData[ni + 2] = (noiseSeed >>> 16) & 255;
      noiseData[ni + 3] = 255;
    }
    var noiseTex = new THREE.DataTexture(noiseData, 1024, 1024, THREE.RGBAFormat, THREE.UnsignedByteType);
    noiseTex.minFilter = THREE.NearestFilter;
    noiseTex.magFilter = THREE.NearestFilter;
    noiseTex.generateMipmaps = false;
    noiseTex.needsUpdate = true;
    var geometry = new THREE.PlaneGeometry(2, 2);
    var sourceMat = new THREE.ShaderMaterial({
      uniforms: {
        iResolution: { value: new THREE.Vector3(1, 1, 1) },
        iTime: { value: 0 },
        iFrame: { value: 0 },
        iMouse: { value: new THREE.Vector4(0, 0, 0, 0) },
        iChannel0: { value: noiseTex },
        uScreenDownsample: { value: 3 },
        uBloomOn: { value: 1 },
        uBloomRadius: { value: 0.02 },
        uCaptureSpeed: { value: 1 },
        uSpeed: { value: 0.15 },
        uZoom: { value: 0.35 },
        uScale: { value: 1 },
        uIterations: { value: 1 },
        uAntiAlias: { value: 2 },
        uTurns: { value: 7 },
        uRipples: { value: 5 },
        uStaticFreq: { value: 0.1 },
        uVDisplaceFreq: { value: 0.07 },
        uHDisplaceFreq: { value: 0.25 },
        uQuantisation: { value: 5 },
        uGradeHue: { value: 0.07 },
        uDrive: { value: 1 },
        uBass: { value: 0 },
        uTreble: { value: 0 },
        uBeat: { value: 0 },
        uAudioGlitch: { value: 0.6 },
        uAudioTear: { value: 0.5 },
        uAudioStyle: { value: 0.5 }
      },
      glslVersion: THREE.GLSL3,
      vertexShader: GLITCH_QUAD_VS_GLSL3,
      fragmentShader: GLITCH_SOURCE_FS,
      depthTest: false,
      depthWrite: false
    });
    var blurMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2(0.001, 0.001) },
        uRadius: { value: 2.5 }
      },
      vertexShader: GLITCH_QUAD_VS,
      fragmentShader: GLITCH_BLUR_FS,
      depthTest: false,
      depthWrite: false
    });
    var compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        iResolution: { value: new THREE.Vector3(1, 1, 1) },
        iChannel0: { value: null },
        iChannel1: { value: null },
        uLowRes: { value: new THREE.Vector2(1, 1) },
        uDs: { value: 3 },
        uBloomOn: { value: 1 },
        uBloomStrength: { value: 0.6 },
        uLift: { value: 0.1 },
        uGamma: { value: 0.8 },
        uVigStrength: { value: 0.5 },
        uVigScale: { value: 0.6 },
        uVigExponent: { value: 3 },
        iTime: { value: 0 },
        uLyricMain: { value: mainTex },
        uLyricSub: { value: subTex },
        uMainRect: { value: new THREE.Vector4(0, 0.64, 0.92, 0.24) },
        uSubRect: { value: new THREE.Vector4(0, 0.14, 0.62, 0.12) },
        uLyricOn: { value: 1 },
        uLyricGlitch: { value: 0.6 },
        uLyricWarp: { value: 0.05 },
        uLyricFill: { value: 0.8 },
        uHasSub: { value: 0 },
        uStyleHue: { value: 0.85 },
        uStyleSeed: { value: 0 },
        uBeat: { value: 0 },
        uBass: { value: 0 },
        uAspect: { value: 1.78 },
        uAudioStyle: { value: 0.5 }
      },
      vertexShader: GLITCH_QUAD_VS,
      fragmentShader: GLITCH_COMPOSITE_FS,
      depthTest: false,
      depthWrite: false
    });
    glitchState.geometry = geometry;
    glitchState.noiseTex = noiseTex;
    glitchState.sourceMat = sourceMat;
    glitchState.blurMat = blurMat;
    glitchState.compositeMat = compositeMat;
    glitchState.mainCanvas = mainCanvas;
    glitchState.subCanvas = subCanvas;
    glitchState.mainTex = mainTex;
    glitchState.subTex = subTex;
    glitchState.mainKey = '';
    glitchState.subKey = '';
    glitchState.passes = {
      source: glitchMakePass(sourceMat, geometry),
      blur: glitchMakePass(blurMat, geometry),
      composite: glitchMakePass(compositeMat, geometry)
    };
    glitchState.built = true;
    glitchState.error = '';
    return true;
  } catch (err) {
    glitchState.error = String(err && (err.message || err)).slice(0, 200);
    return false;
  }
}

function glitchAlignPassSize() {
  if (typeof renderer === 'undefined' || !renderer || !glitchState.compositeMat) return false;
  if (!glitchState.size) glitchState.size = new THREE.Vector2();
  renderer.getDrawingBufferSize(glitchState.size);
  var w = Math.max(32, glitchState.size.x || 1);
  var h = Math.max(32, glitchState.size.y || 1);
  var ds = Math.max(1, Math.round(glitchParam('downsample')));
  var lowW = Math.max(16, Math.round(w / ds));
  var lowH = Math.max(16, Math.round(h / ds));
  var bloomW = Math.max(8, Math.ceil(lowW / 2));
  var bloomH = Math.max(8, Math.ceil(lowH / 2));
  var sized = glitchState.lowRt && glitchState.lowW === lowW && glitchState.lowH === lowH
    && glitchState.bloomW === bloomW && glitchState.bloomH === bloomH;
  if (sized) return true;
  if (!glitchState.lowRt) {
    var opts = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    };
    glitchState.lowRt = new THREE.WebGLRenderTarget(lowW, lowH, opts);
    glitchState.bloomA = new THREE.WebGLRenderTarget(bloomW, bloomH, opts);
    glitchState.bloomB = new THREE.WebGLRenderTarget(bloomW, bloomH, opts);
  } else {
    glitchState.lowRt.setSize(lowW, lowH);
    glitchState.bloomA.setSize(bloomW, bloomH);
    glitchState.bloomB.setSize(bloomW, bloomH);
  }
  glitchState.lowW = lowW;
  glitchState.lowH = lowH;
  glitchState.bloomW = bloomW;
  glitchState.bloomH = bloomH;
  glitchState.sourceMat.uniforms.iResolution.value.set(w, h, 1);
  glitchState.sourceMat.uniforms.uScreenDownsample.value = ds;
  glitchState.compositeMat.uniforms.iResolution.value.set(w, h, 1);
  glitchState.compositeMat.uniforms.uAspect.value = w / h;
  glitchState.compositeMat.uniforms.uLowRes.value.set(lowW, lowH);
  glitchState.compositeMat.uniforms.uDs.value = ds;
  glitchState.compositeMat.uniforms.iChannel0.value = glitchState.bloomB.texture;
  glitchState.compositeMat.uniforms.iChannel1.value = glitchState.lowRt.texture;
  return true;
}

function glitchApplyKnobs() {
  var s = glitchState.sourceMat && glitchState.sourceMat.uniforms;
  if (s) {
    s.uCaptureSpeed.value = glitchParam('timeSpeed');
    s.uSpeed.value = glitchParam('speed');
    s.uZoom.value = glitchParam('zoom');
    s.uScale.value = glitchParam('scale');
    s.uIterations.value = Math.round(glitchParam('iterations'));
    s.uAntiAlias.value = Math.round(glitchParam('antiAlias'));
    s.uTurns.value = Math.round(glitchParam('turns'));
    s.uRipples.value = Math.round(glitchParam('ripples'));
    s.uStaticFreq.value = glitchParam('staticFrequency');
    s.uVDisplaceFreq.value = glitchParam('vDisplace');
    s.uHDisplaceFreq.value = glitchParam('hDisplace');
    s.uQuantisation.value = Math.round(glitchParam('quantisation'));
    s.uGradeHue.value = glitchParam('gradeHue');
    s.uAudioStyle.value = glitchParam('audioStyle');
    s.uDrive.value = glitchParam('audioDrive');
    s.uAudioGlitch.value = glitchParam('audioGlitch');
    s.uAudioTear.value = glitchParam('audioTear');
    s.uBloomOn.value = glitchParam('bloomOn') > 0 ? 1 : 0;
    s.uBloomRadius.value = glitchParam('bloomRadius');
  }
  var c = glitchState.compositeMat && glitchState.compositeMat.uniforms;
  if (c) {
    c.uDs.value = Math.max(1, Math.round(glitchParam('downsample')));
    c.uBloomOn.value = glitchParam('bloomOn') > 0 ? 1 : 0;
    c.uLift.value = glitchParam('lift');
    c.uGamma.value = glitchParam('gamma');
    c.uVigStrength.value = glitchParam('vignetteStrength');
    c.uVigScale.value = glitchParam('vignetteScale');
    c.uVigExponent.value = glitchParam('vignetteExponent');
    c.uLyricWarp.value = glitchParam('lyricWarp');
    c.uLyricFill.value = glitchParam('lyricFill');
  }
  var b = glitchState.blurMat && glitchState.blurMat.uniforms;
  if (b) b.uRadius.value = Math.max(1, glitchParam('bloomRadius') * 130);
}

function glitchUpdateLayer(now, dt, sonicFrame) {
  if (!glitchPresetIsActive()) return false;
  if (!glitchState.built && !glitchBuildScene()) return false;
  glitchApplyKnobs();
  var clock = (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) ? Number(audio.currentTime) : 0;
  glitchState.sourceMat.uniforms.iTime.value = clock;
  glitchState.sourceMat.uniforms.iFrame.value = glitchState.frames | 0;
  glitchState.compositeMat.uniforms.iTime.value = clock;
  glitchFeedAudio(sonicFrame);
  glitchUpdateStyle(clock);
  glitchUpdateLyrics(clock);
  glitchState.frames++;
  void now;
  void dt;
  return true;
}

function glitchRenderFrame() {
  if (!glitchPresetIsActive()) return false;
  if (typeof renderer === 'undefined' || !renderer) return false;
  if (!glitchState.built && !glitchBuildScene()) return false;
  if (!glitchAlignPassSize()) return false;
  try {
    renderer.setRenderTarget(glitchState.lowRt);
    renderer.render(glitchState.passes.source.scene, glitchState.passes.source.camera);
    var blur = glitchState.blurMat;
    blur.uniforms.uTex.value = glitchState.lowRt.texture;
    blur.uniforms.uDir.value.set(1, 0);
    blur.uniforms.uTexel.value.set(1 / glitchState.lowW, 1 / glitchState.lowH);
    renderer.setRenderTarget(glitchState.bloomA);
    renderer.render(glitchState.passes.blur.scene, glitchState.passes.blur.camera);
    blur.uniforms.uTex.value = glitchState.bloomA.texture;
    blur.uniforms.uDir.value.set(0, 1);
    blur.uniforms.uTexel.value.set(1 / glitchState.bloomW, 1 / glitchState.bloomH);
    renderer.setRenderTarget(glitchState.bloomB);
    renderer.render(glitchState.passes.blur.scene, glitchState.passes.blur.camera);
    renderer.setRenderTarget(null);
    renderer.render(glitchState.passes.composite.scene, glitchState.passes.composite.camera);
    return true;
  } catch (err) {
    glitchState.error = String(err && (err.message || err)).slice(0, 200);
    renderer.setRenderTarget(null);
    return false;
  }
}

function glitchDisposeScene() {
  if (glitchState.lowRt) glitchState.lowRt.dispose();
  if (glitchState.bloomA) glitchState.bloomA.dispose();
  if (glitchState.bloomB) glitchState.bloomB.dispose();
  if (glitchState.sourceMat) glitchState.sourceMat.dispose();
  if (glitchState.blurMat) glitchState.blurMat.dispose();
  if (glitchState.compositeMat) glitchState.compositeMat.dispose();
  if (glitchState.geometry) glitchState.geometry.dispose();
  if (glitchState.noiseTex) glitchState.noiseTex.dispose();
  if (glitchState.mainTex) glitchState.mainTex.dispose();
  if (glitchState.subTex) glitchState.subTex.dispose();
  glitchState.built = false;
  glitchState.lowRt = null;
  glitchState.bloomA = null;
  glitchState.bloomB = null;
  glitchState.lowW = 0;
  glitchState.lowH = 0;
  glitchState.bloomW = 0;
  glitchState.bloomH = 0;
  glitchState.sourceMat = null;
  glitchState.blurMat = null;
  glitchState.compositeMat = null;
  glitchState.passes = null;
  glitchState.geometry = null;
  glitchState.mainCanvas = null;
  glitchState.subCanvas = null;
  glitchState.noiseTex = null;
  glitchState.mainTex = null;
  glitchState.subTex = null;
  glitchState.mainKey = '';
  glitchState.subKey = '';
  glitchState.frames = 0;
}

function applyGlitchArtPresetNow(prev, next) {
  var on = Number(next) === GLITCH_PRESET_INDEX;
  var was = Number(prev) === GLITCH_PRESET_INDEX;
  if (on) {
    glitchBuildScene();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('glitch-art-preset');
  } else if (was) {
    glitchDisposeScene();
  }
  return on;
}

function glitchArtStatus() {
  return {
    active: glitchPresetIsActive(),
    built: glitchState.built,
    frames: glitchState.frames,
    error: glitchState.error,
    low: [glitchState.lowW, glitchState.lowH],
    bloom: [glitchState.bloomW, glitchState.bloomH],
    downsample: Math.round(glitchParam('downsample'))
  };
}

// The reference is a full-frame picture: no app particles, no lyric layer.
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'glitch-art',
    isActive: glitchPresetIsActive,
    suppresses: {
      particles: true, bloom: true, float: true, backCover: true,
      starRiver: true, ripples: true, lyricsParticles: true, stageLyrics: true
    }
  });
}



