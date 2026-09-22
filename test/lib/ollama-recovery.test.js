// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/ollama-recovery.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOOL_CALL_RETRY_MESSAGE,
  isToolCallParseError,
  withToolCallRetryInstruction,
  toolCallFailureMessage,
} = require('../../src/lib/ollama-recovery');

test('recognizes Ollama server-side tool-call parse failures only', () => {
  assert.equal(isToolCallParseError(500, '{"error":"error parsing tool call: raw=..."}'), true);
  assert.equal(isToolCallParseError(400, 'Error Parsing Tool Call'), true);
  assert.equal(isToolCallParseError(500, '{"error":"model runner crashed"}'), false);
  assert.equal(isToolCallParseError(200, 'error parsing tool call'), false);
});

test('adds a strict retry instruction without mutating chat history', () => {
  const messages = [{ role: 'user', content: 'Inspect the project.' }];
  const retried = withToolCallRetryInstruction(messages);
  assert.equal(messages.length, 1);
  assert.equal(retried.length, 2);
  assert.equal(retried[0], messages[0]);
  assert.equal(retried[1].role, 'user');
  assert.equal(retried[1].content, TOOL_CALL_RETRY_MESSAGE);
  assert.match(retried[1].content, /at most one structured tool call/);
  assert.match(retried[1].content, /do not include reasoning/);
});

test('persistent failure message explains the bounded safe recovery', () => {
  const message = toolCallFailureMessage('gpt-oss:20b');
  assert.match(message, /gpt-oss:20b/);
  assert.match(message, /retried once/);
  assert.match(message, /did not execute the malformed call/);
});
