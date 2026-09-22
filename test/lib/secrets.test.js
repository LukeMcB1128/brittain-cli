// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/provider.test.js (secret store tests)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSecretStore } = require('../../src/lib/secrets');

const store = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-secret-'));
  return { dir, secrets: createSecretStore({ userDataDir: () => dir }) };
};

test('a key is stored outside settings.json', () => {
  // settings.json is plain text a user is invited to edit and paste into bug
  // reports. A credential that pays for things does not belong there.
  const { dir, secrets } = store();
  secrets.set('openaiApiKey', 'sk-secret-value');
  assert.equal(secrets.get('openaiApiKey'), 'sk-secret-value');
  assert.equal(secrets.has('openaiApiKey'), true);
  assert.ok(fs.existsSync(path.join(dir, 'credentials.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
});

test('a key file is not world-readable', () => {
  const { dir, secrets } = store();
  secrets.set('openaiApiKey', 'sk-x');
  const mode = fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the file store says plainly that it is unencrypted', () => {
  const { secrets } = store();
  assert.deepEqual(secrets.set('openaiApiKey', 'sk-x'), { ok: true, encrypted: false });
  assert.equal(secrets.describe('openaiApiKey').encrypted, false);
});

test('describing a key never returns the key itself', () => {
  const { secrets } = store();
  secrets.set('openaiApiKey', 'sk-abcdefghijklmnop');
  const described = secrets.describe('openaiApiKey');
  assert.equal(described.set, true);
  assert.equal(JSON.stringify(described).includes('sk-abcdefghijklmnop'), false);
});

test('clearing a key removes it rather than storing an empty one', () => {
  const { dir, secrets } = store();
  secrets.set('openaiApiKey', 'sk-x');
  secrets.set('openaiApiKey', '');
  assert.equal(secrets.has('openaiApiKey'), false);
  secrets.set('brittainApiKey', 'bk-y');
  secrets.remove('brittainApiKey');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
  assert.deepEqual(stored, {});
});
