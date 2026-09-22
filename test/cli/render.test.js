'use strict';

// PLAN.md M5: render snapshot tests over a scripted run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRenderer } = require('../../src/cli/render');
const { createMarkdownRenderer } = require('../../src/cli/markdown');

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; }, text: () => text };
}

const SCRIPT = [
  ['stream:state', 'starting'],
  ['stream:thinking', 'Let me look at the file'],
  ['stream:thinking', ' first.'],
  ['stream:token', 'I will '],
  ['stream:token', 'read it.'],
  ['stream:message', 'I will read it.'],
  ['stream:toolcall', { name: 'read_file', args: { path: 'greet.js' } }],
  ['stream:toolresult', { name: 'read_file', result: "console.log('hello');\n" }],
  ['stream:toolcall', { name: 'write_file', args: { path: 'x.js', content: 'x' } }],
  ['stream:toolresult', { name: 'write_file', result: '(call denied by user)', denied: true }],
  ['stream:info', 'Tool result from "run_command" was 90,000 characters.'],
  ['stream:token', '## Summary\n\nThe file prints **hello**.\n- uses `console.log`\n'],
  ['stream:token', '```js\nconsole.log(1);\n```\nDone'],
  ['stream:message', '…'],
  ['stream:stats', { contextTokens: 900, contextLength: 8192, tokPerSec: 42.5, scope: 'provider' }],
  ['stream:cost', { text: '$0.00012 · 900 in · 40 out', cost: 0.00012, sessionText: '' }],
  ['stream:done', { ok: true }],
];

const EXPECTED = [
  '✻ Thought (30 chars)',
  'I will read it.',
  '→ read_file(path=greet.js)',
  "← read_file: console.log('hello');",
  '→ write_file(path=x.js content=x)',
  '← write_file: (call denied by user) (denied)',
  '! Tool result from "run_command" was 90,000 characters.',
  'Summary',
  '',
  'The file prints hello.',
  '• uses console.log',
  '  ┌─ js',
  '  │ console.log(1);',
  '  └─',
  'Done',
  '  900 in · 40 out · 42.5 tok/s · $0.00012',
  '',
].join('\n');

test('a scripted run renders to the expected transcript (buffered, no color)', () => {
  const out = sink();
  const renderer = createRenderer({ out, color: false, live: false });
  for (const [channel, payload] of SCRIPT) renderer.handle(channel, payload);
  renderer.endTurn({ promptTokens: 900, evalTokens: 40 });
  assert.equal(out.text(), EXPECTED);
});

test('color adds styling without changing the words', () => {
  const out = sink();
  const renderer = createRenderer({ out, color: true, live: false });
  for (const [channel, payload] of SCRIPT) renderer.handle(channel, payload);
  renderer.endTurn({ promptTokens: 900, evalTokens: 40 });
  // eslint-disable-next-line no-control-regex
  assert.equal(out.text().replace(/\x1b\[[0-9;]*m/g, ''), EXPECTED);
  assert.match(out.text(), /\x1b\[1m/);
});

test('live mode shows tokens as they arrive, then restyles the finished line', () => {
  const out = sink();
  const renderer = createRenderer({ out, color: true, live: true, columns: () => 80 });
  renderer.handle('stream:token', 'Hello **wor');
  assert.equal(out.text(), 'Hello **wor', 'raw tokens appear immediately');
  renderer.handle('stream:token', 'ld**\n');
  // The raw line is erased (\r + clear) and rewritten with bold applied.
  assert.equal(out.text(), 'Hello **wor' + 'ld**' + '\r\x1b[J' + 'Hello \x1b[1mworld\x1b[22m\n');
});

test('live reasoning is streamed dimmed, then collapsed to one line', () => {
  const out = sink();
  const renderer = createRenderer({ out, color: false, live: true, columns: () => 20 });
  renderer.handle('stream:thinking', 'a'.repeat(45)); // three rows at 20 columns
  renderer.handle('stream:token', 'Answer\n');
  const text = out.text();
  assert.ok(text.startsWith('a'.repeat(45)));
  assert.match(text, /\r\x1b\[2A\x1b\[J✻ Thought \(45 chars\)\n/);
  assert.match(text, /Answer\n$/);
});

test('a failed run and a stop are reported plainly', () => {
  const out = sink();
  const renderer = createRenderer({ out });
  renderer.handle('stream:done', { ok: false, error: 'provider request failed (500)' });
  renderer.handle('stream:done', { ok: true, stopped: true });
  assert.equal(out.text(), '✗ provider request failed (500)\nStopped.\n');
});

test('the status line reports context use from conversation-scoped stats', () => {
  const renderer = createRenderer({ out: sink() });
  renderer.handle('stream:stats', { contextTokens: 2048, contextLength: 8192, scope: 'conversation' });
  assert.equal(renderer.contextPercent(), 25);
});

test('markdown renders headings, emphasis, code, lists, quotes and rules', () => {
  const md = createMarkdownRenderer({ color: false });
  assert.equal(md.render('# Title\n1) first\n* second\n> quoted\n---\nuse `a**b**`'), 'Title\n1. first\n• second\n│ quoted\n────────────────────\nuse a**b**');
});
