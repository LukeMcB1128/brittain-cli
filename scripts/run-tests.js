// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:scripts/run-tests.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return testFiles(fullPath);
      return entry.isFile() && entry.name.endsWith('.test.js') ? [fullPath] : [];
    })
    .sort();
}

const files = testFiles(path.join(__dirname, '..', 'test'));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
