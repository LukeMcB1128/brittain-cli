// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/workspace-memory.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createToolExecutor } = require('../../src/lib/tools');
const workspace = require('../../src/lib/workspace');

function initWorkspace(project) {
  fs.mkdirSync(path.join(project, '.brittain'), { recursive: true });
  fs.writeFileSync(workspace.memoryFile(project), '', 'utf8');
}

test('memory lives in app data until a project opts into .brittain/MEMORY.md, then in-repo', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mem-user-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mem-proj-'));
  const { memoryPath } = createToolExecutor({ dataDir: userDataDir });

  const appPath = memoryPath(project);
  assert.ok(appPath.startsWith(path.join(userDataDir, 'memory')), 'no workspace: app-data memory');

  // A bare .brittain/ directory is not the opt-in: ~/.brittain is the CLI's
  // own data dir, and a session in $HOME must not write memory into it.
  fs.mkdirSync(path.join(project, '.brittain'));
  assert.ok(memoryPath(project).startsWith(path.join(userDataDir, 'memory')), 'directory alone: still app data');

  initWorkspace(project);
  const repoPath = memoryPath(project);
  assert.equal(repoPath, workspace.memoryFile(project), 'workspace present: in-repo memory');
  assert.ok(repoPath.startsWith(fs.realpathSync(project)));
});

test('the in-repo secret refusal is wired into remember', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mem-user-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mem-proj-'));
  const { executeTool, readMemory } = createToolExecutor({ dataDir: userDataDir });
  const key = 'sk-' + 'a'.repeat(32);

  // In app data a key-shaped fact is allowed; it never leaves the machine.
  assert.match(await executeTool('remember', { fact: `the test key is ${key}` }, project), /^Remembered/);

  initWorkspace(project);
  const refused = await executeTool('remember', { fact: `the prod key is ${key}` }, project);
  assert.match(refused, /^Error: this fact looks like a credential/);
  assert.equal(readMemory(project), '');
  assert.match(await executeTool('remember', { fact: 'use tabs' }, project), /^Remembered/);
  assert.equal(readMemory(project), '- use tabs\n');
});
