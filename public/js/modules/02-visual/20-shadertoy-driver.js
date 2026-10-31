'use strict';

// A small Shadertoy runtime, so a shader written for that site can be dropped in with almost no
// rewriting: the body is an `mainImage(out vec4 fragColor, in vec2 fragCoord)`, it may read
// iResolution / iTime / iFrame / iMouse, and it may sample iChannel0..3. This wrapper supplies those
// as GLSL declarations bound to our own uniforms and gives three.js a fragment stage whose `main`
// calls the body.
//
// This is a driver, not a port of anyone's shader: a Shadertoy shader carries its author's licence
// (many are CC BY-NC-SA, which cannot ship inside a GPL build), so anything pasted through here has
// to be checked separately. What it buys us is that a reference shader can be lifted into a test
// surface quickly, and the good ones can then be reimplemented against the same interface.

// Declarations are emitted only for the channels a shader asks for, so an unused sampler cannot be
// left unbound (WebGL reports a warning per frame for that and it is easy to miss).
function shadertoyPreamble(options) {
  options = options || {};
  var channels = Math.max(0, Math.min(4, Math.round(Number(options.channels) || 0)));
  var lines = [
    'precision highp float;',
    'uniform vec3 iResolution;',
    'uniform float iTime;',
    'uniform int iFrame;',
    'uniform vec4 iMouse;'
  ];
  for (var i = 0; i < channels; i++) lines.push('uniform sampler2D iChannel' + i + ';');
  return lines.join('\n');
}

// The full fragment stage: the preamble, then the body as written, then a main() that calls it.
// `postlude` exists because our passes need to write to the default framebuffer with their own
// blending rules; a plain copy keeps the body in Shadertoy shape.
function shadertoyFragment(body, options) {
  return [
    shadertoyPreamble(options),
    '',
    body,
    '',
    'void main() {',
    '  vec4 fragColor = vec4(0.0);',
    '  mainImage(fragColor, gl_FragCoord.xy);',
    '  gl_FragColor = fragColor;',
    '}'
  ].join('\n');
}

// A Shadertoy body expects fragCoord in pixels with the origin at the bottom-left, and uv as
// fragCoord / iResolution. This is that helper, pre-scaled for a render target.
function shadertoyUvUniforms(width, height) {
  return { value: [width, height, 1] };
}
