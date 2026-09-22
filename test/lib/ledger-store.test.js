// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/ledger-store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLedgerStore, MAX_SNAPSHOTS } = require('../../src/lib/ledger-store');
const { buildLedger } = require('../../src/lib/ledger');

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-ledger-'));
  try {
    return run(createLedgerStore({ userDataDir: () => dir }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sample = () => buildLedger([
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'main.js' } } }] },
  { role: 'tool', tool_name: 'write_file', content: 'Wrote 10 lines' },
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_command', arguments: { command: 'npm test' } } }] },
  { role: 'tool', tool_name: 'run_command', content: 'Error: 1 failing' },
]);


test('repeated compactions append rather than overwrite', () => {
  withStore((store) => {
    store.append('chat-1', sample(), { before: 130_000 });
    store.append('chat-1', sample(), { before: 120_000 });
    const record = store.read('chat-1');
    assert.equal(record.snapshots.length, 2);
    assert.equal(record.startedAt, record.snapshots[0].at ? record.startedAt : record.startedAt);
    assert.ok(record.updatedAt);
  });
});

test('snapshots are capped so one long session cannot grow without bound', () => {
  withStore((store) => {
    for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) store.append('chat-1', sample(), { index: i });
    const record = store.read('chat-1');
    assert.equal(record.snapshots.length, MAX_SNAPSHOTS);
    assert.equal(record.snapshots.at(-1).index, MAX_SNAPSHOTS + 9, 'the newest snapshot is kept');
    assert.equal(record.snapshots[0].index, 10, 'the oldest are dropped');
  });
});

test('sessions are stored separately and can be listed', () => {
  withStore((store) => {
    store.append('chat-1', sample());
    store.append('chat-2', sample());
    assert.deepEqual(store.list().sort(), ['chat-1', 'chat-2']);
    assert.equal(store.read('chat-1').snapshots.length, 1);
  });
});

test('a session id cannot escape the runs directory', () => {
  withStore((store, dir) => {
    // Ids that survive sanitization must land in runs/ under a plain filename.
    for (const hostile of ['../../escape', '/etc/passwd', 'a/b/c']) {
      const target = store.filePath(hostile);
      assert.equal(path.dirname(target), path.join(dir, 'runs'), `${hostile} stayed inside runs/`);
      assert.doesNotMatch(path.basename(target), /[\\/]/);
      assert.doesNotMatch(path.basename(target), /^\./, `${hostile} produced a dotfile`);
    }
    // Ids that sanitize away entirely are refused instead of writing a dotfile.
    assert.equal(store.append('..', sample()).ok, false);
    assert.equal(store.append('../../escape', sample()).ok, true);
    assert.equal(fs.readdirSync(path.join(dir, 'runs')).length, 1);
  });
});

test('an unusable session id is refused rather than written somewhere odd', () => {
  withStore((store) => {
    assert.equal(store.append('', sample()).ok, false);
    assert.equal(store.append('///', sample()).ok, false);
    assert.equal(store.append('..', sample()).ok, false);
  });
});

test('reading a session that was never written returns nothing', () => {
  withStore((store) => {
    assert.equal(store.read('missing'), null);
    assert.deepEqual(store.list(), []);
  });
});

test('a write failure is reported, never thrown, so compaction still completes', () => {
  const store = createLedgerStore({ userDataDir: () => '/dev/null/not-a-directory' });
  const written = store.append('chat-1', sample());
  assert.equal(written.ok, false);
  assert.ok(written.error);
});
