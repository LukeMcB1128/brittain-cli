'use strict';

// Every request carries a repetition penalty, under the name the provider
// understands, and a provider that refuses the name gets the one it takes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, envFor, settingsFor } = require('../helpers/test-host');

async function chat(t, mode, { turns = [{ text: 'hi' }], settings = {} } = {}) {
  const fake = await createFakeProvider({ turns }).start();
  t.after(() => fake.stop());
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-penalty-')));
  const host = createTestHost({ settings: { ...settingsFor(mode, fake), ...settings } });
  const runtime = createRuntime({ host, env: envFor(mode, fake), overrides: { cwd } });
  const seen = collect(runtime.events);
  const result = await runtime.commands.chat({ text: 'hello', cwd });
  const agent = fake.chats.filter((body) => body.tools);
  return { result, agent, seen, runtime, fake, cwd };
}

for (const mode of ['brittain', 'openai']) {
  test(`${mode}: every request sends repetition_penalty 1.05 by default`, async (t) => {
    const { result, agent } = await chat(t, mode);
    assert.equal(result.ok, true, result.error);
    assert.equal(agent[0].repetition_penalty, 1.05);
    assert.equal('frequency_penalty' in agent[0], false);
  });
}

test('ollama: the penalty goes in options as repeat_penalty', async (t) => {
  const { agent } = await chat(t, 'ollama', { settings: { repetitionPenalty: 1.1 } });
  assert.equal(agent[0].options.repeat_penalty, 1.1);
});

test('a penalty of 1 is off, and nothing is sent', async (t) => {
  const { agent } = await chat(t, 'openai', { settings: { repetitionPenalty: 1 } });
  assert.equal('repetition_penalty' in agent[0], false);
  assert.equal('frequency_penalty' in agent[0], false);
});

test('a provider that rejects repetition_penalty gets frequency_penalty, from then on', async (t) => {
  const rejected = { status: 400, body: { error: { message: 'Unrecognized request argument supplied: repetition_penalty' } } };
  const { result, agent, seen, runtime, fake, cwd } = await chat(t, 'openai', { turns: [rejected, { text: 'first' }, { text: 'second' }] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.content, 'first');
  assert.equal(agent[0].repetition_penalty, 1.05);
  assert.equal(agent[1].frequency_penalty, 0.1);
  assert.equal('repetition_penalty' in agent[1], false);
  assert.ok(seen.some((e) => e.channel === 'stream:info' && /using frequency_penalty instead/.test(e.payload)));
  const next = await runtime.commands.chat({ text: 'again', cwd });
  assert.equal(next.content, 'second');
  const later = fake.chats.filter((body) => body.tools).at(-1);
  assert.equal(later.frequency_penalty, 0.1, 'the next message does not try repetition_penalty again');
  assert.equal('repetition_penalty' in later, false);
});

test('any other 400 is not mistaken for a refused penalty', async (t) => {
  const { result, agent } = await chat(t, 'openai', { turns: [{ status: 400, body: { error: { message: 'repetition_penalty must be greater than zero' } } }] });
  assert.equal(result.ok, false);
  assert.equal(agent.length, 1);
});
