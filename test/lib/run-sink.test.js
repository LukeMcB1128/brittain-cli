// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/run-sink.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunSink, RUN_CHANNELS } = require('../../src/lib/run-sink');

function fakeWindow() {
  const sent = [];
  return {
    sent,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { send: (channel, payload, route) => sent.push({ channel, payload, route }) },
  };
}






test('a file target writes the narrative but not the token stream', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-sink-'));
  try {
    const transcriptPath = path.join(dir, 'nested', 'run.log');
    const sink = createRunSink({ targets: ['file'], transcriptPath });

    sink.info('starting');
    sink.toolCall({ name: 'write_file', args: { path: 'main.js', content: 'x'.repeat(500) } });
    sink.toolResult({ name: 'write_file', result: 'Wrote 10 lines' });
    sink.token('every');
    sink.token('single');
    sink.stats({ contextTokens: 10 });

    const text = fs.readFileSync(transcriptPath, 'utf8');
    assert.match(text, /starting/);
    assert.match(text, /→ write_file\(path=main\.js/);
    assert.match(text, /← write_file: Wrote 10 lines/);
    assert.doesNotMatch(text, /every|single/, 'the token stream is far too noisy for a transcript');
    assert.doesNotMatch(text, /contextTokens/);
    assert.ok(text.split('\n').filter(Boolean).every((line) => /^\[\d{4}-/.test(line)), 'every line is timestamped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('long tool arguments are summarized rather than dumped into the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-sink-'));
  try {
    const transcriptPath = path.join(dir, 'run.log');
    const sink = createRunSink({ targets: ['file'], transcriptPath });
    sink.toolCall({ name: 'write_file', args: { path: 'a.js', content: 'y'.repeat(5000), mode: 'overwrite', extra: 'ignored' } });
    const line = fs.readFileSync(transcriptPath, 'utf8');
    assert.ok(line.length < 400, `transcript line was ${line.length} chars`);
    assert.doesNotMatch(line, /extra=/, 'only the first few arguments are shown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable transcript does not take the run down', () => {
  const sink = createRunSink({ targets: ['file'], transcriptPath: '/dev/null/nope/run.log' });
  assert.doesNotThrow(() => sink.info('still running'));
  assert.equal(sink.counters().dropped, 1);
});


test('every channel a run emits is declared as a run channel', () => {
  for (const channel of ['stream:state', 'stream:info', 'stream:token', 'stream:toolcall',
    'stream:toolresult', 'stream:stats', 'stream:done']) {
    assert.ok(RUN_CHANNELS.has(channel), `${channel} should be a run channel`);
  }
  // A question is part of the run: whoever drives it has to be able to answer.
  assert.equal(RUN_CHANNELS.has('question:request'), true);
  // The CLI announces approvals on the sink so a stream-json consumer sees
  // every decision that was put to a human.
  assert.equal(RUN_CHANNELS.has('approval:request'), true);
  assert.equal(RUN_CHANNELS.has('approval:resolved'), true);
  assert.equal(RUN_CHANNELS.has('provider:changed'), true);
  // Pruned with subagents and the end-of-run report.
  for (const channel of ['stream:subagent', 'run:report', 'run:decisions']) {
    assert.equal(RUN_CHANNELS.has(channel), false);
  }
});

test('listeners receive every event with chat identity and a sequence number', () => {
  const sink = createRunSink({ meta: () => ({ chatId: 'c1', runId: 'r1' }) });
  const seen = [];
  const unsubscribe = sink.subscribe((channel, payload, meta) => seen.push({ channel, payload, meta }));
  sink.token('hel');
  sink.token('lo');
  unsubscribe();
  sink.token('!');
  assert.deepEqual(seen, [
    { channel: 'stream:token', payload: 'hel', meta: { chatId: 'c1', runId: 'r1', sequence: 1 } },
    { channel: 'stream:token', payload: 'lo', meta: { chatId: 'c1', runId: 'r1', sequence: 2 } },
  ]);
});

test('a listener that throws does not take the run down', () => {
  const sink = createRunSink();
  const seen = [];
  sink.subscribe(() => { throw new Error('boom'); });
  sink.subscribe((channel) => seen.push(channel));
  sink.info('still here');
  assert.deepEqual(seen, ['stream:info']);
  assert.equal(sink.counters().dropped, 1);
});


