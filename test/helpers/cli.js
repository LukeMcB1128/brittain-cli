'use strict';

// Runs bin/brittain.js as a child process. Asynchronous on purpose: a test's
// fake provider lives in the test process, and spawnSync would block it from
// answering.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BIN = path.join(__dirname, '..', '..', 'bin', 'brittain.js');

function tempHome() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-')), 'home');
}

function runCli(args, { env = {}, input = '', home, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Never touch the real keychain, or a real key in the environment.
        BRITTAIN_NO_KEYCHAIN: '1',
        BRITTAIN_HOME: home || tempHome(),
        NO_COLOR: '1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

module.exports = { runCli, tempHome, BIN };
