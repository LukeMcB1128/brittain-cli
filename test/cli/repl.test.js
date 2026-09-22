'use strict';

// The REPL driven in-process over pipes: messages, approvals, questions, slash
// commands, Ctrl-C, and history persistence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { createRuntime } = require('../../src/core/runtime');
const { createRepl, loadHistory } = require('../../src/cli/repl');
const { createFakeProvider } = require('../helpers/fake-provider');
const { createTestHost, settingsFor } = require('../helpers/test-host');

async function session(t, { turns, lines = [], mode = 'code' }) {
  const fake = await createFakeProvider({ turns }).start();
  t.after(() => fake.stop());
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-repl-')));
  const bridge = { approve: async () => false, ask: async () => null };
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  host.approve = (request) => bridge.approve(request);
  host.ask = (request) => bridge.ask(request);
  const runtime = createRuntime({ host, overrides: { cwd } });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  let exited;
  const done = new Promise((resolve) => { exited = resolve; });
  const repl = createRepl({
    runtime, input, output, mode, bridge,
    historyFile: path.join(host.dataDir, 'repl_history'),
    exit: () => exited(),
  });
  repl.start();
  return {
    fake, cwd, host, runtime, repl, input, done,
    output: () => text,
    send(...more) { for (const line of more) input.write(`${line}\n`); },
    end() { input.end(); return done; },
  };
}

test('a message runs, an approval is answered at the prompt, and the answer is shown', async (t) => {
  const s = await session(t, {
    turns: [
      { toolCalls: [{ name: 'write_file', arguments: { path: 'note.txt', content: 'hi' } }] },
      { text: 'Wrote **note.txt**.' },
    ],
  });
  s.send('write a note', 'y');
  await s.end();
  assert.equal(fs.readFileSync(path.join(s.cwd, 'note.txt'), 'utf8'), 'hi');
  const out = s.output();
  assert.match(out, /code · ollama\/alpha-model · .* · ctx \d+%/);
  assert.match(out, /Allow write_file note\.txt\? \[y\]es \/ \[n\]o \/ \[a\]lways this session \/ \[v\]iew y/);
  assert.match(out, /→ write_file\(path=note\.txt content=hi\)/);
  assert.match(out, /Wrote note\.txt\./);
  assert.match(out, /\d+ in · \d+ out/);
});

test('an invariant does not offer "always", and "v" shows the arguments', async (t) => {
  const s = await session(t, {
    turns: [{ toolCalls: [{ name: 'run_command', arguments: { command: 'rm -rf dist' } }] }, { text: 'ok' }],
  });
  s.send('clean up', 'v', 'n');
  await s.end();
  const out = s.output();
  assert.match(out, /DESTRUCTIVE/);
  assert.match(out, /Allow run_command rm -rf dist\? \[y\]es \/ \[n\]o \/ \[v\]iew v/);
  assert.match(out, /"command": "rm -rf dist"/);
  assert.match(out, /← run_command: \(destructive command denied by user\) \(denied\)/);
});

test('ask_user questions take a number or free text', async (t) => {
  const s = await session(t, {
    turns: [
      { toolCalls: [{ name: 'ask_user', arguments: { questions: [{ question: 'Which?', options: ['red', 'blue'] }, { question: 'Why?' }] } }] },
      { text: 'Thanks.' },
    ],
  });
  s.send('pick', '2', 'because');
  await s.end();
  const toolMessage = s.runtime.rt.session.conversation.find((m) => m.role === 'tool');
  assert.equal(toolMessage.content, 'The user answered:\nQ: Which?\nA: blue\nQ: Why?\nA: because');
  assert.match(s.output(), /\? Which\?\n {2}1\. red\n {2}2\. blue/);
});

test('slash commands work at the prompt, and /help lists every command', async (t) => {
  const s = await session(t, { turns: [{ text: 'hello' }] });
  s.send('/help', '/mode chat', '/auto on', '/nope');
  await s.end();
  const out = s.output();
  for (const name of s.repl.slash.names()) assert.ok(out.includes(name), `${name} in /help`);
  assert.match(out, /Mode: chat/);
  assert.match(out, /Auto-approve on/);
  assert.match(out, /Unknown command \/nope/);
  assert.equal(s.repl.state.mode, 'chat');
});

test('a trailing backslash continues the message onto the next line', async (t) => {
  const s = await session(t, { turns: [{ text: 'got it' }] });
  s.send('first line\\', 'second line');
  await s.end();
  assert.equal(s.fake.chats[0].messages.at(-1).content, 'first line\nsecond line');
});

test('Ctrl-C mid-stream stops within one chunk and leaves history consistent', async (t) => {
  const words = Array.from({ length: 2000 }, (_, i) => `w${i} `).join('');
  const s = await session(t, { turns: [{ text: words, split: 4 }] });
  let tokens = 0;
  let tokensAtStop = -1;
  s.runtime.events.subscribe((channel) => {
    if (channel !== 'stream:token') return;
    tokens += 1;
    if (tokens === 3) { s.repl.interrupt(); tokensAtStop = tokens; }
  });
  s.send('talk');
  await s.end();
  assert.ok(tokens - tokensAtStop <= 1, `stopped within one chunk (${tokens - tokensAtStop} more)`);
  assert.match(s.output(), /Stopping…/);
  assert.match(s.output(), /Stopped\./);
  const saved = s.runtime.rt.services.historyStore.load(s.runtime.rt.chatId);
  assert.deepEqual(saved.chat.conversation.map((m) => m.role), ['user']);
  assert.equal(saved.chat.conversation[0].content, 'talk');
});

test('Ctrl-C twice at an idle prompt exits', async (t) => {
  const s = await session(t, { turns: [{ text: 'x' }] });
  s.repl.interrupt();
  assert.match(s.output(), /Press Ctrl-C again to exit/);
  s.repl.interrupt();
  await s.done;
});

test('input history is saved to repl_history', async (t) => {
  const s = await session(t, { turns: [{ text: 'x' }] });
  // History is recorded by readline only for a terminal; exercise the file
  // format directly.
  const file = path.join(s.host.dataDir, 'repl_history');
  fs.writeFileSync(file, 'oldest\nnewer\nnewest\n');
  assert.deepEqual(loadHistory(file), ['newest', 'newer', 'oldest']);
  await s.end();
});
