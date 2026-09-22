// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/history-durability.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryStore } = require('../../src/lib/history-store');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-durable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createHistoryStore({ userDataDir: () => dir, runtimeMetadata: async () => ({}) });
}

test('history recovers a corrupt index and an orphan detail file', async (t) => {
  const store = fixture(t);
  await store.save({ id: 'one', title: 'First' }, [{ role: 'user', content: 'Hello' }]);
  const index = path.join(store.directory(), 'index.json');
  fs.writeFileSync(index, '{broken');
  assert.equal(store.list()[0].title, 'First');
  fs.writeFileSync(index, '[]');
  assert.equal(store.list()[0].id, 'one');
  assert.equal((await store.save({ id: 'two' }, [])).ok, true);
  assert.equal(store.list().length, 2);
});

test('a failed replacement preserves the last complete chat', async (t) => {
  const store = fixture(t);
  await store.save({ id: 'one', title: 'Original' }, []);
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path.join(store.directory(), 'one.json')) throw new Error('simulated disk fault');
    return originalRename(source, target);
  });
  assert.equal((await store.save({ id: 'one', title: 'Replacement' }, [])).ok, false);
  assert.equal(store.load('one').chat.title, 'Original');
  assert.equal(fs.readdirSync(store.directory()).some((file) => file.endsWith('.tmp')), false);
});

test('the index cannot be overwritten or deleted as a conversation', async (t) => {
  const store = fixture(t);
  await store.save({ id: 'one' }, []);
  assert.equal((await store.save({ id: 'index' }, [])).ok, false);
  assert.equal(store.remove('index').ok, false);
  assert.equal(store.load('index').ok, false);
  assert.equal(store.list().length, 1);
});
