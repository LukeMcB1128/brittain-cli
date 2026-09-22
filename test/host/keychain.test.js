'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSecrets, detectKeychain, quoteForSecurity, SERVICE } = require('../../src/host/keychain');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-keychain-'));
}

// A fake `security` / `secret-tool` that records every call and keeps an
// in-memory store, so the tests can check what crossed argv versus stdin.
function fakeRunner(parseSet) {
  const calls = [];
  const store = new Map();
  const run = (command, args, input) => {
    calls.push({ command, args, input });
    const flag = args.includes('-a') ? '-a' : 'account';
    const account = args[args.indexOf(flag) + 1];
    if (args[0] === 'find-generic-password' || args[0] === 'lookup') {
      return store.has(account) ? { status: 0, stdout: store.get(account) + '\n', stderr: '' } : { status: 44, stdout: '', stderr: '' };
    }
    if (args[0] === '-i' || args[0] === 'store') {
      const [name, value] = parseSet(args, input);
      store.set(name, value);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'delete-generic-password' || args[0] === 'clear') {
      store.delete(account);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls, store };
}

const macParse = (_args, input) => {
  const match = /-a "((?:[^"\\]|\\.)*)" -w "((?:[^"\\]|\\.)*)"/.exec(input);
  const unquote = (text) => text.replace(/\\(.)/g, '$1');
  return [unquote(match[1]), unquote(match[2])];
};

test('macOS: a saved key goes to the Keychain through stdin, never argv, and not to disk', () => {
  const dataDir = tempDir();
  const fake = fakeRunner(macParse);
  const secrets = createSecrets({ dataDir, env: {}, platform: 'darwin', run: fake.run });
  const secret = 'sk-live-"quoted"\\value';

  const saved = secrets.set('openaiApiKey', secret);
  assert.deepEqual(saved, { ok: true, encrypted: true, backend: 'macOS Keychain' });
  assert.equal(secrets.get('openaiApiKey'), secret);
  for (const call of fake.calls) {
    assert.equal(call.args.some((arg) => arg.includes('sk-live')), false, `secret leaked into argv: ${call.args.join(' ')}`);
  }
  assert.equal(fake.calls.find((call) => call.args[0] === '-i').args.includes(SERVICE), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'credentials.json')), false);
});

test('Linux: secret-tool receives the key on stdin', () => {
  const dataDir = tempDir();
  const fake = fakeRunner((args, input) => [args[args.indexOf('account') + 1], input]);
  const keychain = detectKeychain({ platform: 'linux', env: { PATH: '' }, run: fake.run });
  assert.equal(keychain, null, 'no secret-tool on PATH means no keychain');

  const bin = tempDir();
  fs.writeFileSync(path.join(bin, 'secret-tool'), '#!/bin/sh\n', { mode: 0o755 });
  const secrets = createSecrets({ dataDir, env: { PATH: bin }, platform: 'linux', run: fake.run });
  assert.equal(secrets.backend(), 'Secret Service');
  secrets.set('brittainApiKey', 'bk-123');
  const store = fake.calls.find((call) => call.args[0] === 'store');
  assert.equal(store.input, 'bk-123');
  assert.equal(store.args.includes('bk-123'), false);
  assert.equal(secrets.get('brittainApiKey'), 'bk-123');
});

test('without a keychain the key falls back to a 0600 file with a plain warning', () => {
  const dataDir = tempDir();
  const secrets = createSecrets({ dataDir, env: {}, keychain: null });
  const saved = secrets.set('openaiApiKey', 'sk-file');
  assert.equal(saved.encrypted, false);
  assert.match(saved.warning, /unencrypted/);
  assert.equal(fs.statSync(path.join(dataDir, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(secrets.get('openaiApiKey'), 'sk-file');
});

test('environment variables override whatever is stored', () => {
  const dataDir = tempDir();
  const secrets = createSecrets({ dataDir, env: { BRITTAIN_API_KEY: 'from-env', OPENAI_API_KEY: 'oa-env' }, keychain: null });
  secrets.set('brittainApiKey', 'stored');
  assert.equal(secrets.get('brittainApiKey'), 'from-env');
  assert.equal(secrets.get('openaiApiKey'), 'oa-env');
  assert.equal(secrets.describe('brittainApiKey').source, '$BRITTAIN_API_KEY');
  assert.equal(JSON.stringify(secrets.describe('brittainApiKey')).includes('from-env'), false);
});

test('removing a key clears both the keychain and any file copy', () => {
  const dataDir = tempDir();
  createSecrets({ dataDir, env: {}, keychain: null }).set('openaiApiKey', 'old-file-copy');
  const fake = fakeRunner(macParse);
  const secrets = createSecrets({ dataDir, env: {}, platform: 'darwin', run: fake.run });
  assert.equal(secrets.get('openaiApiKey'), 'old-file-copy', 'a key saved before the keychain still works');
  secrets.set('openaiApiKey', 'new');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf8')).openaiApiKey, undefined);
  secrets.remove('openaiApiKey');
  assert.equal(secrets.has('openaiApiKey'), false);
});

test('security -i quoting escapes quotes and backslashes', () => {
  assert.equal(quoteForSecurity('a"b\\c'), '"a\\"b\\\\c"');
});

// The real Keychain, opt-in: it writes to the login keychain of whoever runs it.
test('the real macOS Keychain round-trips a key', { skip: process.platform !== 'darwin' || !process.env.BRITTAIN_TEST_KEYCHAIN }, () => {
  const dataDir = tempDir();
  const secrets = createSecrets({ dataDir, env: {} });
  const name = `selftest-${process.pid}`;
  try {
    assert.equal(secrets.set(name, 'a b"c\\d$x').encrypted, true);
    assert.equal(secrets.get(name), 'a b"c\\d$x');
    assert.equal(fs.existsSync(path.join(dataDir, 'credentials.json')), false);
  } finally {
    secrets.remove(name);
  }
  assert.equal(secrets.has(name), false);
});
