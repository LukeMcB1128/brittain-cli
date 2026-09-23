'use strict';

// PLAN.md M4 acceptance: `-p` completes a scripted task that reads, edits, and
// runs a command in a temp git repo; stream-json is one event per line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli, tempHome } = require('../helpers/cli');
const { createFakeProvider } = require('../helpers/fake-provider');

function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-print-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'greet.js'), "console.log('hello');\n");
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

const TASK = [
  { toolCalls: [{ name: 'read_file', arguments: { path: 'greet.js' } }] },
  { toolCalls: [{ name: 'edit_file', arguments: { path: 'greet.js', old_string: "'hello'", new_string: "'hello, world'" } }] },
  { toolCalls: [{ name: 'run_command', arguments: { command: 'node greet.js' } }] },
  { text: 'Changed the greeting and ran it: it prints "hello, world".' },
];

async function setup(t, turns = TASK) {
  const fake = await createFakeProvider({ turns }).start();
  t.after(() => fake.stop());
  const home = tempHome();
  await runCli(['config', 'set', 'providers.ollama.endpoint', fake.origin], { home });
  await runCli(['config', 'set', 'providers.ollama.model', 'alpha-model'], { home });
  await runCli(['config', 'set', 'provider', 'ollama'], { home });
  return { fake, home, cwd: gitRepo() };
}

test('-p --yes reads, edits, and runs a command, then prints the answer', async (t) => {
  const { home, cwd, fake } = await setup(t);
  const result = await runCli(['-p', 'make it greet the world', '--cwd', cwd, '--yes'], { home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Changed the greeting and ran it: it prints "hello, world".');
  assert.equal(fs.readFileSync(path.join(cwd, 'greet.js'), 'utf8'), "console.log('hello, world');\n");
  // chats[3] is the request for the final answer; the one after it names the chat.
  const toolResults = fake.chats[3].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(toolResults[0], /console\.log\('hello'\)/);
  assert.match(toolResults[1], /replaced 1 occurrence/);
  assert.match(toolResults[2], /^hello, world/);
  // The run was checkpointed before it touched anything.
  const refs = execFileSync('git', ['for-each-ref', 'refs/brittain/checkpoints/'], { cwd, encoding: 'utf8' });
  assert.ok(refs.trim().length > 0, 'a checkpoint ref exists');
  // And the chat was saved with a title.
  const history = fs.readdirSync(path.join(home, 'history')).filter((name) => name !== 'index.json');
  assert.equal(history.length, 1);
});

test('without --yes an edit is denied, never hangs, and the exit code is 2', async (t) => {
  const { home, cwd } = await setup(t);
  const result = await runCli(['-p', 'make it greet the world', '--cwd', cwd], { home });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(fs.readFileSync(path.join(cwd, 'greet.js'), 'utf8'), "console.log('hello');\n");
  assert.match(result.stderr, /denied/);
});

test('stream-json writes one event per line with increasing sequence numbers', async (t) => {
  const { home, cwd } = await setup(t);
  const result = await runCli(['-p', 'go', '--cwd', cwd, '--yes', '--output-format', 'stream-json'], { home });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const channels = new Set(events.map((event) => event.channel));
  for (const channel of ['stream:state', 'stream:toolcall', 'stream:toolresult', 'stream:message', 'stream:done']) {
    assert.ok(channels.has(channel), `missing ${channel}`);
  }
  assert.equal(events.at(-1).channel, 'stream:done');
  assert.equal(events.at(-1).payload.ok, true);
  const sequences = events.map((event) => event.sequence);
  assert.deepEqual(sequences, sequences.map((_, i) => sequences[0] + i));
  assert.ok(events.every((event) => event.runId && event.chatId));
});

test('json output is one object with the result and the denial count', async (t) => {
  const { home, cwd } = await setup(t);
  const result = await runCli(['-p', 'go', '--cwd', cwd, '--output-format', 'json'], { home });
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.provider, 'ollama');
  assert.ok(parsed.deniedCalls >= 1);
  assert.match(parsed.result, /hello, world/);
});

test('there is no chat mode: --mode is not an option', async (t) => {
  const { home } = await setup(t, [{ text: 'never' }]);
  const result = await runCli(['-p', 'hi', '--mode', 'chat'], { home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option '--mode'/);
});

test('a provider error exits 1', async (t) => {
  const { home, cwd } = await setup(t, [{ status: 500, body: { error: 'model exploded' } }]);
  const result = await runCli(['-p', 'go', '--cwd', cwd], { home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /provider request failed \(500\)/);
});
