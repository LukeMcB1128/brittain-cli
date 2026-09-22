'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntime } = require('../../src/core/runtime');
const { TOOL_DEFS } = require('../../src/lib/tools');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, envFor, settingsFor } = require('../helpers/test-host');

async function setup(t, mode, fakeOptions = {}, hostOptions = {}) {
  const fake = await createFakeProvider(mode === 'brittain' ? { prefix: '/brittain', ...fakeOptions } : fakeOptions).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor(mode, fake), ...hostOptions });
  const runtime = createRuntime({ host, env: envFor(mode, fake) });
  return { fake, host, runtime, seen: collect(runtime.events) };
}

for (const mode of ['brittain', 'openai', 'ollama']) {
  test(`${mode}: ask streams tokens through the sink and reports usage`, async (t) => {
    const { runtime, seen, fake } = await setup(t, mode, { turns: [{ text: 'Hello there, friend.', usage: { prompt: 12, completion: 6 } }] });
    const result = await runtime.commands.ask({ prompt: 'hi' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.content, 'Hello there, friend.');
    const tokens = seen.filter((e) => e.channel === 'stream:token').map((e) => e.payload);
    assert.ok(tokens.length > 1, 'streamed in pieces');
    assert.equal(tokens.join(''), 'Hello there, friend.');
    assert.equal(runtime.rt.session.usage.main.prompt, 12);
    assert.equal(runtime.rt.session.usage.main.gen, 6);
    const done = seen.find((e) => e.channel === 'stream:done');
    assert.equal(done.payload.ok, true);
    // Every event carries run identity and an increasing sequence.
    const sequences = seen.map((e) => e.meta.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.ok(seen.every((e) => e.meta.runId.startsWith('run-')));
    // No tools on an ask.
    assert.equal(fake.chats[0].tools, undefined);
  });

  test(`${mode}: thinking goes to stream:thinking, never into the answer`, async (t) => {
    const { runtime, seen } = await setup(t, mode, { turns: [{ thinking: 'Let me consider.', text: 'Answer.' }] });
    const result = await runtime.commands.ask({ prompt: 'q' });
    assert.equal(result.content, 'Answer.');
    assert.equal(seen.filter((e) => e.channel === 'stream:thinking').map((e) => e.payload).join(''), 'Let me consider.');
    assert.equal(seen.filter((e) => e.channel === 'stream:token').map((e) => e.payload).join(''), 'Answer.');
  });

  test(`${mode}: malformed tool JSON gets exactly one strict retry`, async (t) => {
    const { runtime, seen, fake } = await setup(t, mode, { turns: [{ malformed: true }, { text: 'Recovered.' }] });
    const { rt } = runtime;
    const model = rt.providers.resolve().model;
    const result = await rt.stream.streamChat(model, [{ role: 'user', content: 'go' }], undefined, undefined, false, 8192, TOOL_DEFS);
    assert.equal(result.content, 'Recovered.');
    assert.equal(fake.chats.length, 2);
    assert.match(fake.chats[1].messages.at(-1).content, /tool-call arguments were not valid JSON/);
    assert.equal(rt.session.usage.metrics.toolCallRetries, 1);
    assert.ok(seen.some((e) => e.channel === 'stream:info' && /malformed tool JSON/.test(e.payload)));
  });

  test(`${mode}: malformed tool JSON twice stops rather than looping`, async (t) => {
    const { runtime, fake } = await setup(t, mode, { turns: [{ malformed: true }, { malformed: true }, { text: 'never' }] });
    const { rt } = runtime;
    await assert.rejects(
      rt.stream.streamChat(rt.providers.resolve().model, [{ role: 'user', content: 'go' }], undefined, undefined, false, 8192, TOOL_DEFS),
      /malformed tool-call JSON twice/,
    );
    assert.equal(fake.chats.length, 2);
  });

  test(`${mode}: structured tool calls are returned whole`, async (t) => {
    const { runtime } = await setup(t, mode, { turns: [{ toolCalls: [{ name: 'read_file', arguments: { path: 'README.md' } }] }] });
    const { rt } = runtime;
    const result = await rt.stream.streamChat(rt.providers.resolve().model, [{ role: 'user', content: 'go' }], undefined, undefined, true, 8192, TOOL_DEFS);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'read_file');
    const args = result.toolCalls[0].function.arguments;
    assert.deepEqual(typeof args === 'string' ? JSON.parse(args) : args, { path: 'README.md' });
  });
}

test('a 401 in brittain mode names brittain login and never the endpoint', async (t) => {
  const { runtime, fake } = await setup(t, 'brittain', { requireKey: 'bk-right' });
  const result = await runtime.commands.ask({ prompt: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.error, /brittain login/);
  assert.equal(result.error.includes(String(fake.port)), false);
});

test('the Brittain key travels as the configured auth header', async (t) => {
  const { runtime, fake } = await setup(t, 'brittain', { requireKey: 'bk-right' }, { keys: { brittainApiKey: 'bk-right' } });
  const result = await runtime.commands.ask({ prompt: 'hi' });
  assert.equal(result.ok, true, result.error);
  assert.equal(fake.requests.at(-1).headers.authorization, 'Bearer bk-right');
});

test('context windows come from the server, per mode', async (t) => {
  const ollama = await setup(t, 'ollama', { contextLength: 16_384 });
  assert.equal(await ollama.runtime.rt.models.getContextLength('alpha-model'), 16_384);
  const openai = await setup(t, 'openai', { contextLength: 65_536 });
  assert.equal(await openai.runtime.rt.models.getContextLength('alpha-model'), 65_536);
  const vllm = await setup(t, 'openai', { contextLength: 40_960, templateKwargs: true });
  assert.equal(await vllm.runtime.rt.models.getContextLength('alpha-model'), 40_960);
  assert.equal(await vllm.runtime.rt.models.thinkValue('alpha-model', false), false, 'vLLM is told to stop thinking');
  assert.equal(await openai.runtime.rt.models.thinkValue('alpha-model', false), undefined, 'others are told nothing');
});

test('Ollama num_ctx and think follow the model capabilities', async (t) => {
  const { runtime, fake } = await setup(t, 'ollama', { contextLength: 16_384, capabilities: ['completion', 'thinking'] });
  await runtime.commands.ask({ prompt: 'hi', think: true });
  assert.equal(fake.chats[0].options.num_ctx, 16_384);
  assert.equal(fake.chats[0].think, true);
});

test('a stream can be stopped mid-answer', async (t) => {
  const { runtime, seen } = await setup(t, 'openai', { turns: [{ text: Array.from({ length: 800 }, (_, i) => `w${i} `).join(''), split: 2 }] });
  let stopped = false;
  runtime.events.subscribe((channel) => {
    if (channel === 'stream:token' && !stopped) { stopped = true; runtime.commands.stop(); }
  });
  const result = await runtime.commands.ask({ prompt: 'long' });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true, result.error);
  const tokens = seen.filter((e) => e.channel === 'stream:token').length;
  assert.ok(tokens < 10, `stopped early (${tokens} tokens)`);
});

test('the core never writes to stdout', async (t) => {
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) { writes.push(String(chunk)); return original.call(this, chunk, ...rest); };
  try {
    const { runtime } = await setup(t, 'ollama', { turns: [{ thinking: 'hm', text: 'quiet answer' }] });
    await runtime.commands.ask({ prompt: 'hi' });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(writes.some((chunk) => chunk.includes('quiet answer')), false);
});
