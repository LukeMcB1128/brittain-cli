// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js
'use strict';

// ---------- persistent memory ----------
// Plain-text lessons saved by `remember`, scoped to the project. Project paths
// are hashed so app data stays filename-safe; projects.json keeps readable
// names. Pruned: the user-wide file for folder-free Chat mode (chat mode was
// removed).
//
// The data directory is passed in rather than held in module state (the
// source's initTools), so everything here is a function of its arguments.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const workspace = require('../workspace');

function canonicalProjectPath(cwd) {
  if (!cwd) throw new Error('A working directory is required for project memory.');
  try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); }
}

function projectMemoryId(cwd) {
  return crypto.createHash('sha256').update(canonicalProjectPath(cwd)).digest('hex');
}

function memoryDir(dataDir) {
  return path.join(dataDir, 'memory');
}

function memoryPath(dataDir, cwd) {
  // A project that opted into the in-repo workspace keeps its memory there,
  // where it shows up in diffs; everything else stays in app data.
  if (workspace.hasWorkspace(cwd)) return workspace.memoryFile(cwd);
  return path.join(memoryDir(dataDir), 'projects', projectMemoryId(cwd) + '.md');
}

// Memory from before it was scoped per project. Still read, never written.
function legacyMemoryPath(dataDir) {
  return path.join(dataDir, 'memory.md');
}

function readMemory(dataDir, cwd) {
  try { return fs.readFileSync(memoryPath(dataDir, cwd), 'utf8'); } catch { return ''; }
}

function readLegacyMemory(dataDir) {
  try { return fs.readFileSync(legacyMemoryPath(dataDir), 'utf8'); } catch { return ''; }
}

function registerProjectMemory(dataDir, cwd) {
  const canonicalPath = canonicalProjectPath(cwd);
  const id = projectMemoryId(cwd);
  const dir = memoryDir(dataDir);
  const indexPath = path.join(dir, 'projects.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
  index[id] = {
    path: canonicalPath,
    name: path.basename(canonicalPath) || canonicalPath,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = indexPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmp, indexPath);
}

function remember(dataDir, args, cwd) {
  const fact = String(args.fact || '').trim().replace(/\s*\n+\s*/g, ' ');
  if (!fact) return 'Error: fact must not be empty.';
  if (readMemory(dataDir, cwd).includes(fact)) return 'Already remembered for this project.';
  const target = memoryPath(dataDir, cwd);
  // In-repo memory is potentially committed and pushed. A remembered
  // credential there is a published credential, so anything key-shaped is
  // refused rather than written.
  if (workspace.hasWorkspace(cwd) && workspace.looksLikeSecret(fact)) {
    return 'Error: this fact looks like a credential or key, and project memory lives inside the repository (.brittain/MEMORY.md). Not saved. Rephrase without the secret value.';
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, '- ' + fact + '\n', 'utf8');
  registerProjectMemory(dataDir, cwd);
  return 'Remembered for this project. This will be available in future chats that use the same directory.';
}

module.exports = {
  memoryDir,
  memoryPath,
  legacyMemoryPath,
  readMemory,
  readLegacyMemory,
  remember,
};
