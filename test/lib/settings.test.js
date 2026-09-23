// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/settings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_SETTINGS,
  normalizeEndpoint,
  normalizeSettings,
  loadSettings,
  saveSettings,
  settingsPath,
} = require('../../src/lib/settings');

test('accepts Ollama-compatible endpoints on alternate ports', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(normalizeEndpoint('http://localhost:8081/'), 'http://localhost:8081');
  assert.equal(normalizeEndpoint('https://models.example.test:8443'), 'https://models.example.test:8443');
});

test('accepts the base URLs cloud providers document', () => {
  // Refusing paths made every OpenAI-compatible endpoint impossible to enter:
  // they are documented with one, and the client appends only the method path.
  assert.equal(normalizeEndpoint('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
  assert.equal(normalizeEndpoint('https://api.z.ai/api/paas/v4/'), 'https://api.z.ai/api/paas/v4');
});

test('rejects credentials, query strings, and unsupported protocols', () => {
  // Still refused: anything that is not addressing. A key in a URL is either a
  // mistake or a credential about to be stored in the wrong place.
  assert.throws(() => normalizeEndpoint('http://user:secret@localhost:11434'), /credentials/);
  assert.throws(() => normalizeEndpoint('https://api.example.test/v1?key=sk-abc'), /query string or fragment/);
  assert.throws(() => normalizeEndpoint('https://api.example.test/v1#frag'), /query string or fragment/);
  assert.throws(() => normalizeEndpoint('ftp://localhost:11434'), /http:\/\/ or https:\/\//);
});

test('normalizes settings into safe runtime bounds', () => {
  const settings = normalizeSettings({
    mainContextCap: 9_999_999,
    compactThreshold: 0.2,
    codeTemperature: 9,
    maxAgentSteps: 999,
    keepAlive: 'forever',
  });
  assert.equal(settings.mainContextCap, 1_048_576);
  assert.equal(normalizeSettings({ mainContextCap: 999_999 }).mainContextCap, 999_999);
  assert.equal(settings.compactThreshold, 0.5);
  assert.equal(settings.codeTemperature, 1.5);
  assert.equal(settings.maxAgentSteps, 100);
  assert.equal(settings.keepAlive, DEFAULT_SETTINGS.keepAlive);
  // Pruned settings for deferred features do not survive normalization.
  for (const key of ['compactionEngine', 'jevEndpoint', 'coderModel', 'scoutModel', 'toolIndex', 'sidebarOpen',
    // chat mode's settings, removed with it
    'defaultMode', 'chatTemperature', 'chatThink', 'globalChatInstructions']) {
    assert.equal(key in normalizeSettings({ [key]: 'x' }), false, key);
  }
});

test('saves and reloads the complete settings document', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-settings-'));
  try {
    const saved = saveSettings(dir, {
      ...DEFAULT_SETTINGS,
      provider: 'ollama',
      providers: { ollama: { endpoint: 'http://127.0.0.1:9001', model: 'small-chat:latest' } },
      mainContextCap: 65_536,
      globalCodeInstructions: 'Prefer short answers.',
    });
    assert.equal(fs.existsSync(settingsPath(dir) + '.tmp'), false);
    assert.deepEqual(loadSettings(dir), saved);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('first run starts in brittain mode with a record per provider', () => {
  const settings = normalizeSettings({});
  assert.equal(settings.provider, 'brittain');
  assert.deepEqual(Object.keys(settings.providers), ['brittain', 'openai', 'ollama']);
  assert.equal(settings.providers.brittain.model, 'run4c-step-0116');
  assert.equal(settings.providers.ollama.endpoint, 'http://127.0.0.1:11434');
  assert.equal(normalizeSettings({ provider: 'anthropic' }).provider, 'brittain', 'an unknown value falls back to the default');
});

test('saved Brittain base-model defaults move to the served adapter', () => {
  assert.equal(normalizeSettings({ providers: { brittain: { model: 'brittain-4' } } }).providers.brittain.model, 'run4c-step-0116');
  assert.equal(normalizeSettings({ providers: { brittain: { model: 'custom-adapter' } } }).providers.brittain.model, 'custom-adapter');
});

test('the Brittain endpoint is never stored', () => {
  const settings = normalizeSettings({ providers: { brittain: { endpoint: 'https://leak.example.test/v1', model: 'b' } } });
  assert.deepEqual(settings.providers.brittain, { model: 'b' });
});

test('each provider keeps its own configuration across a switch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-settings-'));
  try {
    const first = saveSettings(dir, {
      provider: 'openai',
      providers: {
        openai: { endpoint: 'https://openrouter.ai/api/v1/', model: 'z-ai/glm-4.6' },
        ollama: { endpoint: 'http://127.0.0.1:11434', model: 'qwen3:8b' },
      },
    });
    const switched = saveSettings(dir, { ...first, provider: 'ollama' });
    const back = saveSettings(dir, { ...switched, provider: 'openai' });
    assert.deepEqual(back.providers.openai, { endpoint: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-4.6' });
    assert.deepEqual(back.providers.ollama, { endpoint: 'http://127.0.0.1:11434', model: 'qwen3:8b' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unparseable stored endpoint falls back instead of losing every setting', () => {
  const settings = normalizeSettings({ maxAgentSteps: 20, providers: { ollama: { endpoint: 'not a url' } } });
  assert.equal(settings.providers.ollama.endpoint, 'http://127.0.0.1:11434');
  assert.equal(settings.maxAgentSteps, 20);
});

test('auto-compaction defaults to 80% of the window', () => {
  assert.equal(DEFAULT_SETTINGS.compactThreshold, 0.8);
  assert.equal(normalizeSettings({}).compactThreshold, 0.8);
  assert.equal(normalizeSettings({ compactThreshold: 0.7 }).compactThreshold, 0.7, 'a stored choice is kept');
});
