'use strict';

// Where the CLI keeps its data: ~/.brittain, or $BRITTAIN_HOME.
//
// Holds settings.json, credentials.json (keychain fallback only), history/,
// memory/, and repl_history. Created 0700 because chats, memory, and possibly
// a key live there.

const fs = require('fs');
const os = require('os');
const path = require('path');

function dataDir(env = process.env) {
  const override = String(env.BRITTAIN_HOME || '').trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.brittain');
}

function ensureDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask, and does nothing to a directory that
  // already existed; set it explicitly.
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

module.exports = { dataDir, ensureDataDir };
