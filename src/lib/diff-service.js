// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/diff-service.js
const fs = require('fs');
const path = require('path');

const UNTRACKED_PREVIEW_LIMIT = 300_000;

function splitNull(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function countPatchLines(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function statusMap(output) {
  const parts = splitNull(output);
  const statuses = new Map();
  for (let index = 0; index < parts.length;) {
    const status = parts[index++] || 'M';
    const firstPath = parts[index++] || '';
    if (!firstPath) continue;
    if (/^[RC]/.test(status) && index < parts.length) {
      const newPath = parts[index++];
      statuses.set(newPath, status);
    } else {
      statuses.set(firstPath, status);
    }
  }
  return statuses;
}

function safeProjectPath(cwd, relativePath) {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Invalid untracked path: ${relativePath}`);
  }
  return absolute;
}

function untrackedPatch(cwd, relativePath) {
  const absolute = safeProjectPath(cwd, relativePath);
  const stat = fs.lstatSync(absolute);
  const header = `diff --git a/${relativePath} b/${relativePath}\nnew file mode ${stat.isSymbolicLink() ? '120000' : '100644'}\n--- /dev/null\n+++ b/${relativePath}\n`;
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    return { patch: `${header}@@ -0,0 +1 @@\n+${target}`, binary: false, truncated: false };
  }
  if (!stat.isFile()) {
    return { patch: `${header}(non-regular file)`, binary: true, truncated: false };
  }
  const bytes = fs.readFileSync(absolute);
  if (bytes.includes(0)) {
    return { patch: `${header}Binary file not shown.`, binary: true, truncated: false };
  }
  const truncated = bytes.length > UNTRACKED_PREVIEW_LIMIT;
  const content = bytes.subarray(0, UNTRACKED_PREVIEW_LIMIT).toString('utf8');
  const lines = content
    ? (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n')
    : [];
  const body = lines.map((line) => '+' + line).join('\n');
  const suffix = truncated ? '\n+… preview truncated …' : '';
  return {
    patch: `${header}@@ -0,0 +1,${lines.length} @@\n${body}${suffix}`,
    binary: false,
    truncated,
  };
}

function createDiffService({ gitRun }) {
  async function trackedSection(cwd, id, label, baseArgs) {
    const [namesResult, statusesResult] = await Promise.all([
      gitRun([...baseArgs, '--name-only', '-z', '--', '.'], cwd),
      gitRun([...baseArgs, '--name-status', '-z', '--', '.'], cwd),
    ]);
    if (!namesResult.ok) throw new Error(namesResult.err || `Could not read ${label.toLowerCase()} changes.`);
    const statuses = statusMap(statusesResult.out);
    const files = [];
    for (const filePath of splitNull(namesResult.out)) {
      const patchResult = await gitRun([...baseArgs, '--no-ext-diff', '--unified=3', '--', filePath], cwd);
      const patch = patchResult.ok ? patchResult.out : `Could not render this file: ${patchResult.err}`;
      files.push({
        path: filePath,
        status: statuses.get(filePath) || 'M',
        patch,
        binary: /Binary files|GIT binary patch/.test(patch),
        truncated: false,
        ...countPatchLines(patch),
      });
    }
    return { id, label, files };
  }

  async function get(cwd) {
    try {
      const [staged, unstaged, untrackedResult] = await Promise.all([
        trackedSection(cwd, 'staged', 'Staged', ['diff', '--cached']),
        trackedSection(cwd, 'unstaged', 'Unstaged', ['diff']),
        gitRun(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], cwd),
      ]);
      if (!untrackedResult.ok) throw new Error(untrackedResult.err || 'Could not read untracked files.');
      const untracked = { id: 'untracked', label: 'Untracked', files: [] };
      for (const filePath of splitNull(untrackedResult.out)) {
        try {
          const preview = untrackedPatch(cwd, filePath);
          untracked.files.push({
            path: filePath,
            status: 'A',
            ...preview,
            ...countPatchLines(preview.patch),
          });
        } catch (error) {
          untracked.files.push({
            path: filePath,
            status: 'A',
            patch: `Could not render this file: ${error.message || error}`,
            additions: 0,
            deletions: 0,
            binary: true,
            truncated: false,
          });
        }
      }
      const sections = [staged, unstaged, untracked];
      const files = sections.flatMap((section) => section.files);
      return {
        ok: true,
        scope: {
          label: 'Working tree vs HEAD',
          note: 'Includes staged, unstaged, and untracked changes, including changes that existed before the latest agent run.',
        },
        sections,
        totals: {
          files: files.length,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        },
      };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }

  return { get };
}

module.exports = { countPatchLines, createDiffService, safeProjectPath, statusMap, untrackedPatch };
