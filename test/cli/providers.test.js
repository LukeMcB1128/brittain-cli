'use strict';

// docs/PLAN.md M2 acceptance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCli, tempHome } = require('../helpers/cli');
const { createFakeProvider } = require('../helpers/fake-provider');

function readSettings(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
}

test('a fresh BRITTAIN_HOME starts in brittain mode and writes defaults', async () => {
  const home = tempHome();
  const result = await runCli(['config', 'get', 'provider'], { home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'brittain');
  assert.equal(readSettings(home).provider, 'brittain');
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);

  const listing = await runCli(['provider'], { home });
  assert.match(listing.stdout, /Active provider: brittain/);
  assert.match(listing.stdout, /^\* brittain/m);
});

test('switching to openai and back keeps each mode\'s endpoint and model', async (t) => {
  const fake = await createFakeProvider({ models: ['z-ai/glm-4.6', 'qwen/qwen3-coder'], requireKey: 'sk-test' }).start();
  t.after(() => fake.stop());
  const home = tempHome();

  // endpoint → key (echo off) → pick a model
  const setup = await runCli(['provider', 'openai'], { home, input: `${fake.origin}/v1\nsk-test\n1\n` });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Provider: openai .* model: qwen\/qwen3-coder/);
  assert.equal(setup.stderr.includes('sk-test'), false, 'the key is never echoed');
  let settings = readSettings(home);
  assert.equal(settings.provider, 'openai');
  assert.deepEqual(settings.providers.openai, { endpoint: `${fake.origin}/v1`, model: 'qwen/qwen3-coder' });
  assert.equal(JSON.stringify(settings).includes('sk-test'), false, 'the key is not in settings.json');

  const back = await runCli(['provider', 'brittain'], { home });
  assert.equal(back.status, 0, back.stderr);
  settings = readSettings(home);
  assert.equal(settings.provider, 'brittain');
  assert.deepEqual(settings.providers.openai, { endpoint: `${fake.origin}/v1`, model: 'qwen/qwen3-coder' });

  // Returning needs no questions: everything was kept.
  const again = await runCli(['provider', 'openai'], { home });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readSettings(home).providers.openai.model, 'qwen/qwen3-coder');

  const models = await runCli(['models'], { home });
  assert.equal(models.status, 0, models.stderr);
  assert.match(models.stdout, /^\* qwen\/qwen3-coder$/m);
  assert.match(models.stdout, /^ {2}z-ai\/glm-4\.6$/m);
});

test('ollama mode lists installed models, or says Ollama is not running', async (t) => {
  const fake = await createFakeProvider({ models: ['qwen3:8b', 'llama3.2:3b'] }).start();
  t.after(() => fake.stop());
  const home = tempHome();
  await runCli(['config', 'set', 'providers.ollama.endpoint', fake.origin], { home });
  const setup = await runCli(['provider', 'ollama'], { home, input: 'qwen3\n' });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(readSettings(home).providers.ollama.model, 'qwen3:8b');

  const down = tempHome();
  await runCli(['config', 'set', 'providers.ollama.endpoint', 'http://127.0.0.1:9'], { home: down });
  const result = await runCli(['provider', 'ollama'], { home: down });
  assert.match(result.stderr, /Ollama isn't running at http:\/\/127\.0\.0\.1:9/);
});

test('BRITTAIN_API_KEY overrides the stored key; a 401 points at brittain login', async (t) => {
  const fake = await createFakeProvider({ prefix: '/b', requireKey: 'bk-env' }).start();
  t.after(() => fake.stop());
  const home = tempHome();
  const env = { BRITTAIN_API_URL: `${fake.base}/v1` };

  const denied = await runCli(['models'], { home, env });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /brittain login/);

  await runCli(['login'], { home, env, input: 'bk-stored-wrong\n' });
  const wrong = await runCli(['models'], { home, env });
  assert.match(wrong.stderr, /rejected the saved key.*brittain login/);

  const allowed = await runCli(['models'], { home, env: { ...env, BRITTAIN_API_KEY: 'bk-env' } });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /alpha-model/);
  assert.equal(fake.requests.at(-1).headers.authorization, 'Bearer bk-env');
});

test('login stores the key outside settings.json and logout removes it', async () => {
  const home = tempHome();
  const login = await runCli(['login', '--provider', 'openai'], { home, input: 'sk-abc123\n' });
  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stderr, /unencrypted/, 'the file fallback says so plainly');
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8').includes('sk-abc123'), false);
  assert.equal(fs.statSync(path.join(home, 'credentials.json')).mode & 0o777, 0o600);
  assert.match((await runCli(['provider'], { home })).stdout, /openai .* key saved/);

  const logout = await runCli(['logout', '--provider', 'openai'], { home });
  assert.equal(logout.status, 0);
  assert.match((await runCli(['provider'], { home })).stdout, /openai .* no key/);
});

test('config set validates keys and values', async () => {
  const home = tempHome();
  const ok = await runCli(['config', 'set', 'maxAgentSteps', '999'], { home });
  assert.match(ok.stdout, /maxAgentSteps = 100 \(adjusted/);
  for (const [args, pattern] of [
    [['config', 'set', 'nope', '1'], /Unknown setting "nope"/],
    [['config', 'set', 'autoApprove', 'maybe'], /true or false/],
    [['config', 'set', 'providers.openai.endpoint', 'https://x.test/v1?key=1'], /no query string/],
    [['config', 'set', 'provider', 'anthropic'], /provider must be one of/],
    [['config', 'set', 'providers.brittain.endpoint', 'https://x.test'], /built in and cannot be configured/],
  ]) {
    const result = await runCli(args, { home });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, pattern);
  }
});

test('the Brittain endpoint never appears in any output or error', async (t) => {
  const canary = 'canary-endpoint-7f3a';
  const fake = await createFakeProvider({ prefix: `/${canary}` }).start();
  const failing = await createFakeProvider({ prefix: `/${canary}`, status: 500 }).start();
  t.after(() => Promise.all([fake.stop(), failing.stop()]));

  const cases = [
    { env: { BRITTAIN_API_URL: `${fake.base}/v1` } },
    { env: { BRITTAIN_API_URL: `${failing.base}/v1` } },
    { env: { BRITTAIN_API_URL: `http://${canary}.invalid:4433/v1` } },
  ];
  const commands = [
    [['--help']], [['--version']],
    [['config', 'get']], [['config', 'get', 'providers']], [['config', 'get', 'providers.brittain']],
    [['config', 'get', 'providers.brittain.endpoint']],
    [['config', 'set', 'providers.brittain.endpoint', 'x']],
    [['provider']], [['provider', 'brittain']], [['models']],
    [['login'], 'bk-1\n'], [['logout']],
  ];
  const leaks = [canary, String(fake.port), String(failing.port), '4433'];
  for (const { env } of cases) {
    const home = tempHome();
    for (const [args, input = ''] of commands) {
      const result = await runCli(args, { home, env, input });
      const text = result.stdout + result.stderr;
      for (const leak of leaks) {
        assert.equal(text.includes(leak), false, `\`brittain ${args.join(' ')}\` printed "${leak}":\n${text}`);
      }
    }
    const stored = fs.readdirSync(home).map((name) => fs.readFileSync(path.join(home, name), 'utf8')).join('\n');
    for (const leak of leaks) assert.equal(stored.includes(leak), false, `"${leak}" was written to ${home}`);
  }
  assert.ok(fake.requests.length > 0 && failing.requests.length > 0, 'the commands did reach the endpoint');
});
