// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/context-controls.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeContextState,
  pinFile,
  pinnedFilesPrompt,
  pinnedMessagesPrompt,
  setMessagePinned,
  unpinFile,
} = require('../../src/lib/context-controls');

function project(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-context-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('context controls pin project files with confinement and current contents', (t) => {
  const cwd = project(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'app.js'), 'const version = 1;\n');
  const pinned = pinFile(normalizeContextState(), cwd, 'src/app.js');
  assert.equal(pinned.changed, true);
  assert.deepEqual(pinned.state.pinnedFiles, ['src/app.js']);
  assert.match(pinnedFilesPrompt(pinned.state, cwd), /const version = 1/);
  fs.writeFileSync(path.join(cwd, 'src', 'app.js'), 'const version = 2;\n');
  assert.match(pinnedFilesPrompt(pinned.state, cwd), /const version = 2/);
  assert.throws(() => pinFile(pinned.state, cwd, '../outside.js'), /escapes/);
  assert.deepEqual(unpinFile(pinned.state, cwd, 'src/app.js').state, { projectPath: '', pinnedFiles: [] });
});

test('context controls pin only user and model messages', () => {
  const conversation = [
    { role: 'user', content: 'Keep this decision.' },
    { role: 'assistant', content: 'Done.' },
    { role: 'tool', tool_name: 'read_file', content: 'very large output' },
  ];
  setMessagePinned(conversation, 0, true);
  assert.match(pinnedMessagesPrompt(conversation), /Keep this decision/);
  assert.throws(() => setMessagePinned(conversation, 2, true), /Only user and model/);
});
