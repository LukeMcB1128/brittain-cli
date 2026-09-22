// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/diff-service.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { createDiffService } = require('../../src/lib/diff-service');

function gitRun(args, cwd) {
  const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  return Promise.resolve({ ok: result.status === 0, out: result.stdout || '', err: result.stderr || '' });
}

test('Diff v2 separates staged, unstaged, and untracked files', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-diff-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  cp.execFileSync('git', ['init', '-q'], { cwd });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  cp.execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'staged.txt'), 'before\n');
  fs.writeFileSync(path.join(cwd, 'unstaged.txt'), 'before\n');
  cp.execFileSync('git', ['add', '.'], { cwd });
  cp.execFileSync('git', ['commit', '-qm', 'base'], { cwd });
  fs.writeFileSync(path.join(cwd, 'staged.txt'), 'before\nafter\n');
  cp.execFileSync('git', ['add', 'staged.txt'], { cwd });
  fs.writeFileSync(path.join(cwd, 'unstaged.txt'), 'changed\n');
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'one\ntwo\n');

  const result = await createDiffService({ gitRun }).get(cwd);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scope, {
    label: 'Working tree vs HEAD',
    note: 'Includes staged, unstaged, and untracked changes, including changes that existed before the latest agent run.',
  });
  assert.deepEqual(result.sections.map((section) => [section.id, section.files.map((file) => file.path)]), [
    ['staged', ['staged.txt']],
    ['unstaged', ['unstaged.txt']],
    ['untracked', ['new.txt']],
  ]);
  assert.deepEqual(result.totals, { files: 3, additions: 4, deletions: 1 });
  assert.match(result.sections[2].files[0].patch, /--- \/dev\/null/);
});
