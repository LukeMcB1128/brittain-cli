// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/tools/policy.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createToolPolicy } = require('../../../src/lib/tools/policy');

function definition(name) {
  return { type: 'function', function: { name, parameters: { type: 'object' } } };
}

test('tool policy derives each mode from one definition registry', () => {
  const policy = createToolPolicy([
    definition('read_file'),
    definition('write_file'),
    definition('ask_user'),
    definition('remember'),
    definition('web_search'),
  ]);

  assert.deepEqual(policy.CODE_TOOLS.map((item) => item.function.name), ['read_file', 'write_file', 'ask_user', 'remember']);
  assert.deepEqual(policy.CHAT_TOOLS.map((item) => item.function.name), ['ask_user', 'remember']);
  assert.equal(policy.RISKY_TOOLS.has('write_file'), true);
  assert.equal(policy.RISKY_TOOLS.has('read_file'), false);
});
