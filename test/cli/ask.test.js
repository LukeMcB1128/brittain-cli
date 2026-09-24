'use strict';

// docs/PLAN.md M3 acceptance: `brittain ask` streams in all three modes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runCli, tempHome } = require('../helpers/cli');
const { createFakeProvider } = require('../helpers/fake-provider');

async function configure(home, mode, fake) {
  if (mode === 'openai') {
    await runCli(['config', 'set', 'providers.openai.endpoint', `${fake.base}/v1`], { home });
    await runCli(['config', 'set', 'providers.openai.model', 'alpha-model'], { home });
  } else if (mode === 'ollama') {
    await runCli(['config', 'set', 'providers.ollama.endpoint', fake.base], { home });
    await runCli(['config', 'set', 'providers.ollama.model', 'alpha-model'], { home });
  }
  await runCli(['config', 'set', 'provider', mode], { home });
}

for (const mode of ['brittain', 'openai', 'ollama']) {
  test(`${mode}: ask streams the answer to stdout and hides thinking by default`, async (t) => {
    const fake = await createFakeProvider({
      prefix: mode === 'brittain' ? '/hidden-brittain' : '',
      turns: [{ thinking: 'secret reasoning', text: 'The answer is 42.' }],
    }).start();
    t.after(() => fake.stop());
    const home = tempHome();
    await configure(home, mode, fake);
    const env = mode === 'brittain' ? { BRITTAIN_API_URL: `${fake.base}/v1` } : {};

    const plain = await runCli(['ask', 'what is it?'], { home, env });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, 'The answer is 42.\n');
    assert.equal(plain.stderr.includes('secret reasoning'), false);

    const shown = await runCli(['ask', '--show-thinking', 'what is it?'], { home, env });
    assert.equal(shown.stdout, 'The answer is 42.\n');
    assert.match(shown.stderr, /secret reasoning/);
    assert.equal(fake.chats.at(-1).messages.at(-1).content, 'what is it?');
  });
}

test('--provider and --model apply to one invocation without being saved', async (t) => {
  const fake = await createFakeProvider({ turns: [{ text: 'from ollama' }] }).start();
  t.after(() => fake.stop());
  const home = tempHome();
  await runCli(['config', 'set', 'providers.ollama.endpoint', fake.base], { home });
  const result = await runCli(['ask', '--provider', 'ollama', '--model', 'beta-model', 'hi'], { home });
  assert.equal(result.stdout, 'from ollama\n', result.stderr);
  assert.equal(fake.chats[0].model, 'beta-model');
  assert.equal((await runCli(['config', 'get', 'provider'], { home })).stdout.trim(), 'brittain');
  assert.equal((await runCli(['config', 'get', 'providers.ollama.model'], { home })).stdout.trim(), '');
});

test('a 401 prints the brittain login hint and exits 1', async (t) => {
  const fake = await createFakeProvider({ prefix: '/p401', requireKey: 'needed' }).start();
  t.after(() => fake.stop());
  const result = await runCli(['ask', 'hi'], { env: { BRITTAIN_API_URL: `${fake.base}/v1` } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brittain login/);
  assert.equal(result.stderr.includes('p401'), false);
  assert.equal(result.stderr.includes(String(fake.port)), false);
});

test('an unreachable Brittain API is reported without naming it', async () => {
  const result = await runCli(['ask', 'hi'], { env: { BRITTAIN_API_URL: 'http://hidden-ask-host.invalid:6060/v1' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot reach the Brittain API/);
  assert.equal(/hidden-ask-host|6060/.test(result.stderr), false);
});
