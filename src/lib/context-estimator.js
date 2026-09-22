// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/context-estimator.js
'use strict';

// Pruned: image-token estimation (attachments are not in v1). Every payload is
// text, so the estimate is the serialized length over four.

function textTokens(value) {
  return Math.round(JSON.stringify(value).length / 4);
}

function estimateContextTokens(value) {
  return Math.round(JSON.stringify(value).length / 4);
}

module.exports = {
  estimateContextTokens,
  textTokens,
};
