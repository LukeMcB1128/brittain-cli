// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js
'use strict';

// Read-only git tools: git_status, read_git_diff, get_git_log.
// Pruned: create_git_branch, revert_to_last_commit, get_git_graph (not in v1).

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { resolveInside, truncate } = require('./files');

// ---------- git integration ----------
function gitRun(args, cwd, env) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 4_000_000, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout || '', err: (stderr || '').trim() });
    });
  });
}

async function gitStatus(args, cwd) {
  return gitRun(['status', '--short', '--branch', '--untracked-files=all'], cwd)
    .then((res) => (res.ok ? truncate(res.out || '(working tree clean)') : `Error: ${res.err}`));
}

async function readGitDiff(args, cwd) {
  const mode = args.mode || 'unstaged';
  if (!['unstaged', 'staged', 'all'].includes(mode)) return `Error: invalid diff mode "${mode}".`;
  let pathArgs = [];
  if (args.path) {
    const absolutePath = resolveInside(cwd, args.path);
    pathArgs = ['--', path.relative(fs.realpathSync(cwd), absolutePath) || '.'];
  }
  const readOne = async (staged) => {
    const gitArgs = ['diff', '--no-color'];
    if (staged) gitArgs.push('--cached');
    gitArgs.push(...pathArgs);
    return gitRun(gitArgs, cwd);
  };
  if (mode === 'all') {
    const [staged, unstaged] = await Promise.all([readOne(true), readOne(false)]);
    if (!staged.ok) return `Error reading staged diff: ${staged.err}`;
    if (!unstaged.ok) return `Error reading unstaged diff: ${unstaged.err}`;
    const sections = [];
    if (staged.out) sections.push(`=== STAGED ===\n${staged.out.trimEnd()}`);
    if (unstaged.out) sections.push(`=== UNSTAGED ===\n${unstaged.out.trimEnd()}`);
    return truncate(sections.join('\n\n') || '(no staged or unstaged changes)');
  }
  const result = await readOne(mode === 'staged');
  return result.ok ? truncate(result.out || `(no ${mode} changes)`) : `Error: ${result.err}`;
}

async function getGitLog(args, cwd) {
  const gitArgs = ['log', '--oneline', '--no-color'];
  const limit = parseInt(args.limit, 10);
  gitArgs.push('-n', String(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20));
  return gitRun(gitArgs, cwd).then((res) => (res.ok ? truncate(res.out) : `Error: ${res.err}`));
}

module.exports = {
  gitRun,
  handlers: {
    git_status: gitStatus,
    read_git_diff: readGitDiff,
    get_git_log: getGitLog,
  },
};
