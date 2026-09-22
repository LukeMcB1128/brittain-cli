'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../../package.json');

const BIN = path.join(__dirname, '..', '..', 'bin', 'brittain.js');

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('--version prints the package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('--help prints usage', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /brittain -p/);
});

test('unknown flags exit 1 with a hint', () => {
  const result = run(['--nope']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brittain --help/);
});

test('package.json has no runtime dependencies and ships only whitelisted files', () => {
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(pkg.files, ['bin/', 'src/', 'README.md', 'LICENSE']);
  assert.equal(pkg.bin.brittain, 'bin/brittain.js');
});
