// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/services.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { createCheckpointService } = require('../../src/lib/checkpoint-service');
const { createHistoryStore, safeChatId } = require('../../src/lib/history-store');

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-service-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('history store saves runtime data and keeps file names inside its directory', async (t) => {
  const userData = tempDirectory(t);
  const store = createHistoryStore({
    userDataDir: () => userData,
    runtimeMetadata: async (name) => ({ model: { name: name || null }, source: 'test' }),
  });

  assert.equal(safeChatId('chat:/one'), 'chatone');
  assert.deepEqual(store.list(), []);
  assert.deepEqual(await store.save({
    id: 'chat:/one',
    title: 'Saved chat',
    model: 'main:8b',
    provider: 'ollama',
    mode: 'chat',
    contextState: { projectPath: '/project', pinnedFiles: ['README.md'] },
  }, [{ role: 'user', content: 'Hello' }]), { ok: true });

  assert.equal(store.list()[0].id, 'chatone');
  const loaded = store.load('chat:/one');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.chat.runtime.model.name, 'main:8b');
  assert.equal(loaded.chat.provider, 'ollama');
  assert.equal(loaded.chat.conversation[0].content, 'Hello');
  assert.deepEqual(loaded.chat.contextState, { projectPath: '/project', pinnedFiles: ['README.md'] });
  assert.deepEqual(store.remove('chat:/one'), { ok: true });
  assert.deepEqual(store.list(), []);
});



test('checkpoint service reports an absent checkpoint without changing files', async () => {
  const gitCalls = [];
  let published = null;
  const service = createCheckpointService({
    gitRun: async (args) => {
      gitCalls.push(args);
      return { ok: false, out: '', err: 'not a repository' };
    },
    getTempDirectory: () => os.tmpdir(),
    publishState: (state) => { published = state; },
  });

  assert.equal(await service.create('/missing'), null);
  assert.deepEqual(await service.undo('/missing'), {
    ok: false,
    error: 'No checkpoint for this folder in this session.',
  });
  assert.deepEqual(gitCalls, [['rev-parse', '--git-dir']]);
  assert.deepEqual(published, { available: false, cwd: '/missing' });
});

test('checkpoint service can adopt a validated persisted checkpoint', () => {
  let published = null;
  const store = createCheckpointService({
    gitRun: async () => ({ ok: true, out: '' }),
    getTempDirectory: () => os.tmpdir(),
    publishState: (state) => { published = state; },
  });
  assert.equal(store.adopt({ ref: 'refs/brittain/checkpoints/saved', cwd: '/project', at: 123 }), true);
  assert.deepEqual(store.current(), { ref: 'refs/brittain/checkpoints/saved', cwd: '/project', at: 123 });
  assert.deepEqual(published, { available: true, cwd: '/project' });
});

test('checkpoint diff does not report an unchanged untracked file as deleted and new', async (t) => {
  const cwd = tempDirectory(t);
  cp.execFileSync('git', ['init', '-q'], { cwd });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  cp.execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'before\n');
  cp.execFileSync('git', ['add', 'tracked.txt'], { cwd });
  cp.execFileSync('git', ['commit', '-qm', 'base'], { cwd });
  fs.writeFileSync(path.join(cwd, 'existing-untracked.txt'), 'keep me\n');

  const gitRun = async (args, directory, env) => {
    const result = cp.spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' });
    return { ok: result.status === 0, out: result.stdout || '', err: result.stderr || '' };
  };
  const service = createCheckpointService({
    gitRun,
    getTempDirectory: () => os.tmpdir(),
    publishState: () => {},
  });
  assert.ok(await service.create(cwd));
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'after\n');

  const result = await service.diffStat(cwd);
  assert.equal(result.ok, true);
  assert.match(result.out, /tracked\.txt/);
  assert.doesNotMatch(result.out, /existing-untracked\.txt/);
});

test('checkpoint diff uses the snapshot supplied by the run', async (t) => {
  const cwd = tempDirectory(t);
  cp.execFileSync('git', ['init', '-q'], { cwd });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  cp.execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'base\n');
  cp.execFileSync('git', ['add', 'base.txt'], { cwd });
  cp.execFileSync('git', ['commit', '-qm', 'base'], { cwd });

  const gitRun = async (args, directory, env) => {
    const result = cp.spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' });
    return { ok: result.status === 0, out: result.stdout || '', err: result.stderr || '' };
  };
  const service = createCheckpointService({
    gitRun,
    getTempDirectory: () => os.tmpdir(),
    publishState: () => {},
  });
  const firstRun = await service.create(cwd);
  fs.writeFileSync(path.join(cwd, 'first-run.txt'), 'first\n');
  await service.create(cwd);
  fs.writeFileSync(path.join(cwd, 'second-run.txt'), 'second\n');

  const result = await service.diffStat(cwd, firstRun);
  assert.equal(result.ok, true);
  assert.match(result.out, /first-run\.txt/);
  assert.match(result.out, /second-run\.txt/);
});

test('a failed checkpoint cannot leave an older run available', async () => {
  const published = [];
  let fail = false;
  const service = createCheckpointService({
    gitRun: async (args) => {
      if (fail || args[0] === 'rev-parse') return fail
        ? { ok: false, out: '', err: 'locked' }
        : { ok: true, out: args[1] === '--git-dir' ? '.git' : 'head' };
      if (args[0] === 'write-tree') return { ok: true, out: 'tree' };
      if (args[0] === 'commit-tree') return { ok: true, out: 'commit' };
      return { ok: true, out: '' };
    },
    getTempDirectory: () => os.tmpdir(),
    publishState: (state) => published.push(state),
  });
  assert.ok(await service.create('/project'));
  fail = true;
  assert.equal(await service.create('/project'), null);
  assert.equal(service.current(), null);
  assert.deepEqual(published.at(-1), { available: false, cwd: '/project' });
});

test('checkpoint diff rejects an index that calls existing files deleted', async (t) => {
  const cwd = tempDirectory(t);
  fs.writeFileSync(path.join(cwd, 'still-here.txt'), 'present\n');
  let diffCalled = false;
  const service = createCheckpointService({
    gitRun: async (args) => {
      if (args[0] === 'rev-parse') return { ok: true, out: path.join(cwd, 'missing-index'), err: '' };
      if (args[0] === 'add') return { ok: true, out: '', err: '' };
      if (args[0] === 'ls-tree') return { ok: true, out: 'still-here.txt\0', err: '' };
      if (args[0] === 'ls-files') return { ok: true, out: '', err: '' };
      if (args[0] === 'diff') diffCalled = true;
      return { ok: true, out: '', err: '' };
    },
    getTempDirectory: () => os.tmpdir(),
    publishState: () => {},
  });
  const checkpoint = { ref: 'refs/brittain/checkpoints/run', cwd, at: 1 };
  const result = await service.diffStat(cwd, checkpoint);
  assert.equal(result.ok, false);
  assert.match(result.err, /omitted 1 existing path/);
  assert.equal(diffCalled, false);
});



