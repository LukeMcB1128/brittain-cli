'use strict';

// PLAN.md M4: the safety invariants hold whatever the mode or flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, settingsFor } = require('../helpers/test-host');

function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-inv-')));
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  return dir;
}

async function run(t, { turns, approvals = [], interactive = true, autoApprove = false, cwd = project(), answers = [] }) {
  const fake = await createFakeProvider({ turns }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake), approvals, interactive, answers });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const seen = collect(runtime.events);
  const result = await runtime.commands.chat({ text: 'go', cwd, autoApprove });
  return { result, host, runtime, seen, fake, cwd };
}

const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] });
const done = { text: 'Done.' };
const toolMessages = (runtime) => runtime.rt.session.conversation.filter((m) => m.role === 'tool');

test('a destructive command always asks, even with auto-approve', async (t) => {
  const { host, cwd, result, seen } = await run(t, {
    turns: [call('run_command', { command: 'rm -rf build' }), done],
    autoApprove: true,
    approvals: [false],
  });
  assert.equal(result.ok, true);
  assert.equal(host.asked.approvals.length, 1);
  assert.equal(host.asked.approvals[0].kind.destructive, true);
  assert.equal(host.asked.approvals[0].target, 'rm -rf build');
  assert.ok(fs.existsSync(cwd));
  assert.ok(seen.some((e) => e.channel === 'approval:request') && seen.some((e) => e.channel === 'approval:resolved'));
});

test('unattended, a destructive command is denied even with --yes, without asking anyone', async (t) => {
  const marker = 'unattended-marker.txt';
  const { host, cwd, runtime } = await run(t, {
    turns: [call('run_command', { command: `touch ${marker} && git push origin main` }), done],
    autoApprove: true,
    interactive: false,
  });
  assert.equal(host.asked.approvals.length, 0);
  assert.equal(fs.existsSync(path.join(cwd, marker)), false);
  assert.match(toolMessages(runtime)[0].content, /not permitted/);
});

test('a sensitive read always asks, even with auto-approve', async (t) => {
  const cwd = project();
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=hunter2\n');
  const { host, runtime } = await run(t, {
    cwd,
    turns: [call('read_file', { path: '.env' }), call('get_file_lines', { path: '.env', start: 1 }), done],
    autoApprove: true,
    approvals: [false, false],
  });
  assert.equal(host.asked.approvals.length, 2);
  assert.ok(host.asked.approvals.every((request) => request.kind.sensitive));
  for (const message of toolMessages(runtime)) assert.equal(message.content.includes('hunter2'), false);
});

test('a money-moving command always asks, even with auto-approve', async (t) => {
  const { host } = await run(t, {
    turns: [call('run_command', { command: 'curl -X POST https://api.stripe.com/v1/charges -d amount=500' }), done],
    autoApprove: true,
    approvals: [false],
  });
  assert.equal(host.asked.approvals.length, 1);
  assert.equal(host.asked.approvals[0].kind.financial, true);
});

test('"always" covers ordinary risky calls but never an invariant', async (t) => {
  const { host, cwd } = await run(t, {
    turns: [
      call('write_file', { path: 'a.txt', content: 'a' }),
      call('write_file', { path: 'b.txt', content: 'b' }),
      call('run_command', { command: 'sudo true' }),
      done,
    ],
    approvals: ['always', false],
  });
  assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'b');
  assert.equal(host.asked.approvals.length, 2, 'the second write did not ask; sudo did');
  assert.equal(host.asked.approvals[1].kind.destructive, true);
});

test('a denied call is not run, and asking again for it is refused without a prompt', async (t) => {
  const write = call('write_file', { path: 'denied.txt', content: 'x' });
  const { host, cwd, runtime } = await run(t, { turns: [write, write, done], approvals: [false, true] });
  assert.equal(host.asked.approvals.length, 1, 'the repeat was not put to the user again');
  assert.equal(fs.existsSync(path.join(cwd, 'denied.txt')), false);
  const [first, second] = toolMessages(runtime);
  assert.match(first.content, /The user denied this tool call/);
  assert.match(second.content, /denied this exact write_file call earlier/);
});

test('a call that fails twice is blocked the third time and the model is told why', async (t) => {
  const missing = call('read_file', { path: 'missing.txt' });
  const { runtime } = await run(t, { turns: [missing, missing, missing, done] });
  const results = toolMessages(runtime).map((message) => message.content);
  assert.match(results[0], /^Error:/);
  assert.match(results[2], /already failed twice/);
  assert.ok(runtime.rt.session.conversation.some((m) => m.role === 'user' && /failed twice or were blocked/.test(m.content)));
});

test('tool results are bounded before they reach the model', async (t) => {
  const cwd = project();
  fs.writeFileSync(path.join(cwd, 'big.txt'), 'y'.repeat(200_000));
  const { runtime, seen } = await run(t, { cwd, turns: [call('run_command', { command: 'cat big.txt' }), done], approvals: [true] });
  const [result] = toolMessages(runtime);
  assert.ok(result.content.length <= 32_000, `${result.content.length} chars`);
  assert.ok(seen.some((e) => e.channel === 'stream:info' && /characters\. Kept a/.test(e.payload)) || /truncated/.test(result.content));
});

test('writes stay inside the working directory', async (t) => {
  const cwd = project();
  const outside = path.join(path.dirname(cwd), `outside-${path.basename(cwd)}.txt`);
  const { runtime } = await run(t, {
    cwd,
    turns: [
      call('write_file', { path: `../${path.basename(outside)}`, content: 'escape' }),
      call('write_file', { path: outside, content: 'escape' }),
      call('move_file', { source: 'README.md', destination: '../moved.md' }),
      done,
    ],
    autoApprove: true,
  });
  assert.equal(fs.existsSync(outside), false);
  assert.ok(fs.existsSync(path.join(cwd, 'README.md')));
  for (const message of toolMessages(runtime)) assert.match(message.content, /^Error: Path escapes the working directory/);
});

test('ask_user is answered by the host, and unattended it is told nobody answered', async (t) => {
  const question = call('ask_user', { questions: [{ question: 'Tabs or spaces?', options: ['tabs', 'spaces'] }] });
  const attended = await run(t, { turns: [question, done], answers: [['spaces']] });
  assert.match(toolMessages(attended.runtime)[0].content, /Q: Tabs or spaces\?\nA: spaces/);
  const unattended = await run(t, { turns: [question, done], interactive: false });
  assert.match(toolMessages(unattended.runtime)[0].content, /cancelled the question/);
  assert.equal(unattended.host.asked.questions.length, 0);
});

test('a stop mid-run ends the turn and keeps the history consistent', async (t) => {
  const fake = await createFakeProvider({ turns: [{ text: Array.from({ length: 500 }, (_, i) => `w${i} `).join(''), split: 3 }] }).start();
  t.after(() => fake.stop());
  const cwd = project();
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  let stopped = false;
  runtime.events.subscribe((channel) => {
    if (channel === 'stream:token' && !stopped) { stopped = true; runtime.commands.stop(); }
  });
  const result = await runtime.commands.chat({ text: 'go', cwd });
  assert.equal(result.stopped, true);
  const saved = runtime.rt.services.historyStore.load(result.chatId);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.chat.conversation.map((m) => m.role), ['user']);
});
