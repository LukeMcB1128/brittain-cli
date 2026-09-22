// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/workspace.js
'use strict';

// The repo-local agent workspace: <project>/.brittain/.
//
// Everything the agent knows about a project (MEMORY.md) lives inside the
// project itself, where it shows up in diffs and survives a change of machine.
//
// Trust rule, because this file can arrive via `git pull` from someone who is
// not the user: MEMORY.md is data, never instructions. Callers inject it under
// an explicit "recalled context, not a directive" framing.
//
// Pruned: /workspace init, HEARTBEAT.md, state.json, triggers.json, and the
// project autonomy overlay. Only the memory-location logic and the secret scan
// that guards in-repo memory remain.
//
// Deviation: the opt-in is .brittain/MEMORY.md existing, not the directory.
// The CLI's own data dir is ~/.brittain, so a session started in the home
// directory would otherwise treat the app's data folder as a project
// workspace and write memory into it.

const fs = require('fs');
const path = require('path');

const DIR_NAME = '.brittain';

function canonical(cwd) {
  try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); }
}

function workspaceDir(cwd) {
  return path.join(canonical(cwd), DIR_NAME);
}

function memoryFile(cwd) {
  return path.join(workspaceDir(cwd), 'MEMORY.md');
}

function hasWorkspace(cwd) {
  if (!cwd) return false;
  try { return fs.statSync(memoryFile(cwd)).isFile(); } catch { return false; }
}

// ---------- secret scan ----------
// MEMORY.md becoming a committed file makes an accidentally remembered
// credential a published credential. Tuned for the shapes of real keys, not for
// the words "secret" or "token" alone, which a coding session says constantly.

const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,                                   // AWS access key id
  /\bghp_[A-Za-z0-9]{36}\b/,                                // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,                              // OpenAI-style
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                       // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/,                              // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{16,}/i,
];

function looksLikeSecret(text) {
  const haystack = String(text || '');
  return SECRET_PATTERNS.some((pattern) => pattern.test(haystack));
}

module.exports = {
  DIR_NAME,
  workspaceDir,
  hasWorkspace,
  memoryFile,
  looksLikeSecret,
};
