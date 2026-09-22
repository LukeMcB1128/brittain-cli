// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/tool-result.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_TOOL_RESULT_CHARS, boundToolResult, isUnboundedBrowserEvaluation } = require('../../src/lib/tool-result');

test('tool results keep normal output unchanged and bound large output', () => {
  assert.deepEqual(boundToolResult('small result'), {
    content: 'small result', truncated: false, originalChars: 12, omittedChars: 0,
  });

  const source = 'start-' + 'x'.repeat(MAX_TOOL_RESULT_CHARS * 2) + '-end';
  const bounded = boundToolResult(source, { toolName: 'browser_evaluate' });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.content.length, MAX_TOOL_RESULT_CHARS);
  assert.match(bounded.content, /^start-/);
  assert.match(bounded.content, /result shortened/);
  assert.match(bounded.content, /-end$/);
  assert.ok(bounded.omittedChars > 0);
});


