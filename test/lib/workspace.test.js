// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/workspace.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = require('../../src/lib/workspace');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ws-'));
}








test('the secret scan catches real key shapes, not the word "token"', () => {
  assert.equal(workspace.looksLikeSecret('the API uses token-based auth'), false);
  assert.equal(workspace.looksLikeSecret('tests need the fixtures regenerated after schema changes'), false);
  assert.equal(workspace.looksLikeSecret('AKIAIOSFODNN7EXAMPLE'), true);
  assert.equal(workspace.looksLikeSecret('ghp_' + 'a'.repeat(36)), true);
  assert.equal(workspace.looksLikeSecret('api_key = "sk4f8a9b2c1d0e3f4a5b6c7d8e9f0a1b"'), true);
  assert.equal(workspace.looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
});


