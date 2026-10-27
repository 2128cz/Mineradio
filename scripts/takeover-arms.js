'use strict';

// The arm that checks the takeover mask's layers actually have consumers.
//
// It lives in its own file with the texts handed in, so the mutation driver can run it on
// a scene where a consumer has been removed: an arm that cannot be made to fail is an arm
// that proves nothing, and the shipped files must not be rewritten to find that out.

function parseTakeoverLayers(takeoverText) {
  const list = (takeoverText.match(/var VISUAL_TAKEOVER_LAYERS\s*=\s*\[([\s\S]*?)\];/) || [])[1] || '';
  return [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]);
}

// `consumerTexts` is the text of every module that could read the mask, except the module
// that builds it (that one names the layers, which is not the same as honouring them).
function checkTakeoverLayerConsumers(takeoverText, consumerTexts, fail) {
  const layerNames = parseTakeoverLayers(takeoverText);
  if (layerNames.length < 8) {
    fail(`the takeover layer list could not be read back (found ${layerNames.length} layers)`);
    return;
  }
  for (const layer of layerNames) {
    const read = new RegExp('suppress\\.' + layer + '\\b');
    const consumed = consumerTexts.some((text) => read.test(text));
    if (!consumed) {
      fail(`the takeover mask names the layer ${layer}, but no module reads suppress.${layer}: an owner that asks for it would not get it`);
    }
  }
}

module.exports = { parseTakeoverLayers, checkTakeoverLayerConsumers };
