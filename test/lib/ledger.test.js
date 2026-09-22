// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/ledger.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLedger, renderLedger, isEmptyLedger, outcomeOf, pathsFromPatch } = require('../../src/lib/ledger');

const call = (name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ function: { name, arguments: args } }],
});
const result = (name, content) => ({ role: 'tool', tool_name: name, content });

function exchange(name, args, content) {
  return [call(name, args), result(name, content)];
}

test('a denial is recognised from the sentence the app actually writes', () => {
  assert.equal(outcomeOf('The user denied this tool call. Ask before retrying, or try another approach.'), 'denied');
  assert.equal(outcomeOf('The user denied this destructive command. Do not retry it.'), 'denied');
  assert.equal(outcomeOf('The user cancelled the question. Stop and wait.'), 'denied');
  assert.equal(outcomeOf('Cancelled by user.'), 'denied');
  assert.equal(outcomeOf('Error: no exact match for old_string'), 'error');
  assert.equal(outcomeOf('Wrote 42 lines to main.js'), 'ok');
});

test('a denied write is never recorded as a change', () => {
  const ledger = buildLedger(exchange('write_file', { path: 'secrets.js' },
    'The user denied this tool call. Ask before retrying, or try another approach.'));
  assert.deepEqual(ledger.changed, []);
  assert.equal(ledger.denied.length, 1);
  assert.equal(ledger.denied[0].target, 'secrets.js');
});

test('a failed edit is counted as a failure, not as a change', () => {
  const ledger = buildLedger(exchange('edit_file', { path: 'main.js' }, 'Error: no exact match for old_string'));
  assert.deepEqual(ledger.changed, []);
  assert.equal(ledger.errors.length, 1);
  assert.equal(ledger.errors[0].tool, 'edit_file');
  assert.match(ledger.errors[0].message, /no exact match/);
});

test('repeated edits to one file collapse into a single entry with a count', () => {
  const ledger = buildLedger([
    ...exchange('edit_file', { path: 'main.js' }, 'Replaced 1 occurrence'),
    ...exchange('edit_file', { path: 'main.js' }, 'Replaced 1 occurrence'),
    ...exchange('edit_file', { path: 'main.js' }, 'Replaced 1 occurrence'),
  ]);
  assert.equal(ledger.changed.length, 1);
  assert.equal(ledger.changed[0].path, 'main.js');
  assert.equal(ledger.changed[0].verbs.get('edited'), 3);
});

test('a file that was read and later written counts as changed, not as read', () => {
  const ledger = buildLedger([
    ...exchange('read_file', { path: 'main.js' }, 'file contents'),
    ...exchange('write_file', { path: 'main.js' }, 'Wrote 10 lines'),
  ]);
  assert.equal(ledger.changed.length, 1);
  assert.deepEqual(ledger.read, []);
});


test('apply_patch targets come from the diff, and a preview changes nothing', () => {
  const patch = '--- a/one.js\n+++ b/one.js\n@@ -1 +1 @@\n-a\n+b\n--- a/two.js\n+++ b/two.js\n@@ -1 +1 @@\n-c\n+d\n';
  assert.deepEqual(pathsFromPatch(patch), ['one.js', 'two.js']);

  const applied = buildLedger(exchange('apply_patch', { patch, dry_run: false }, 'Applied 2 files'));
  assert.deepEqual(applied.changed.map((entry) => entry.path), ['one.js', 'two.js']);

  const preview = buildLedger(exchange('apply_patch', { patch }, 'Preview only'));
  assert.deepEqual(preview.changed, [], 'a dry run must not be reported as a change');
});

test('a deleted file in a patch is not recorded as a written target', () => {
  const patch = '--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n';
  assert.deepEqual(pathsFromPatch(patch), []);
});

test('commands keep their outcomes', () => {
  const ledger = buildLedger([
    ...exchange('run_command', { command: 'npm test' }, 'Error: 3 failing'),
    ...exchange('run_command', { command: 'git status' }, 'clean'),
  ]);
  assert.deepEqual(ledger.commands, [
    { command: 'npm test', outcome: 'error' },
    { command: 'git status', outcome: 'ok' },
  ]);
});

test('a move is recorded at its destination', () => {
  const ledger = buildLedger(exchange('move_file', { path: 'old.js', destination: 'new.js' }, 'Moved'));
  assert.deepEqual(ledger.changed.map((entry) => entry.path), ['new.js']);
});

test('tool calls are paired with their results by name, not by position alone', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'read_file', arguments: { path: 'a.js' } } },
        { function: { name: 'write_file', arguments: { path: 'b.js' } } },
      ],
    },
    result('write_file', 'Wrote b.js'),
    result('read_file', 'contents of a.js'),
  ];
  const ledger = buildLedger(messages);
  assert.deepEqual(ledger.changed.map((entry) => entry.path), ['b.js']);
  assert.deepEqual(ledger.read.map((entry) => entry.path), ['a.js']);
});

test('string tool arguments are parsed, and malformed ones do not throw', () => {
  const fromJson = buildLedger([
    call('write_file', '{"path":"x.js"}'),
    result('write_file', 'Wrote x.js'),
  ]);
  assert.deepEqual(fromJson.changed.map((entry) => entry.path), ['x.js']);

  assert.doesNotThrow(() => buildLedger([call('write_file', 'not json{'), result('write_file', 'ok')]));
  assert.doesNotThrow(() => buildLedger(undefined));
  assert.doesNotThrow(() => buildLedger([{ role: 'user', content: 'hi' }]));
});

test('an empty ledger renders as nothing at all', () => {
  assert.equal(isEmptyLedger(buildLedger([{ role: 'user', content: 'hello' }])), true);
  assert.equal(renderLedger(buildLedger([])), '');
});

test('the rendered ledger states its provenance and lists what happened', () => {
  const text = renderLedger(buildLedger([
    ...exchange('write_file', { path: 'main.js' }, 'Wrote 10 lines'),
    ...exchange('read_file', { path: 'tools.js' }, 'contents'),
    ...exchange('run_command', { command: 'npm test' }, 'Error: 1 failing'),
    ...exchange('delete_file', { path: 'old.js' }, 'The user denied this tool call.'),
  ]));
  assert.match(text, /read directly from the tool record/);
  assert.match(text, /main\.js \(written\)/);
  assert.match(text, /tools\.js/);
  assert.match(text, /npm test` → error/);
  assert.match(text, /Denied by the user/);
  assert.match(text, /delete_file on old\.js/);
});

test('long lists are capped rather than allowed to dominate the record', () => {
  const messages = [];
  for (let i = 0; i < 60; i++) messages.push(...exchange('write_file', { path: `f${i}.js` }, 'Wrote'));
  const text = renderLedger(buildLedger(messages), { changedLimit: 30 });
  assert.match(text, /…and 30 more/);
});
