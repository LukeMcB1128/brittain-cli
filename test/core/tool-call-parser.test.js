'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRawToolCalls } = require('../../src/core/tool-call-parser');
const { fitToWindow, modelReadyMessages } = require('../../src/core/context-hygiene');

test('native tool-call markup emitted as text is recovered', () => {
  const parsed = parseRawToolCalls('Reading it now.\n<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.js\n</parameter>\n</function>\n</tool_call>');
  assert.deepEqual(parsed.calls, [{ function: { name: 'read_file', arguments: { path: 'src/a.js' } } }]);
  assert.equal(parsed.cleaned, 'Reading it now.');
});

test('a truncated trailing parameter is still recovered, and scalars are typed', () => {
  const parsed = parseRawToolCalls('<function=get_file_lines>\n<parameter=start>\n10\n</parameter>\n<parameter=path>\nREADME.md');
  assert.deepEqual(parsed.calls[0].function.arguments, { start: 10, path: 'README.md' });
});

test('ordinary text is not mistaken for a tool call', () => {
  assert.equal(parseRawToolCalls('Use read_file to look at it.'), null);
});

test('model-ready messages drop CLI-only fields and bound old tool results', () => {
  const ready = modelReadyMessages([
    { role: 'user', content: 'hi', displayContent: 'hi', pinned: true, meta: { at: 1 } },
    { role: 'tool', tool_name: 'run_command', content: 'x'.repeat(100_000) },
  ]);
  assert.deepEqual(ready[0], { role: 'user', content: 'hi' });
  assert.ok(ready[1].content.length < 40_000);
  assert.match(ready[1].content, /run_command result shortened/);
});

test('fitting to a window keeps the newest messages and says what was dropped', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(20) }));
  const fitted = fitToWindow(messages, 400);
  assert.match(fitted[0].content, /Earlier conversation omitted/);
  assert.equal(fitted.at(-1), messages.at(-1));
  assert.ok(fitted.length < messages.length);
});
