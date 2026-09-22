// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/context-estimator.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateContextTokens, textTokens } = require('../../src/lib/context-estimator');

test('text-only context keeps the standard estimate', () => {
  const messages = [{ role: 'user', content: 'Explain this code.' }];
  assert.equal(estimateContextTokens(messages), Math.round(JSON.stringify(messages).length / 4));
  assert.equal(textTokens(messages), estimateContextTokens(messages));
});
