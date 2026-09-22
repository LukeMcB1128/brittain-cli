// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/chat-title.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  generateChatTitle,
  normalizeGeneratedTitle,
  titleMessages,
} = require('../../src/lib/chat-title');
const { createHistoryStore } = require('../../src/lib/history-store');

const root = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function historyStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-chat-title-'));
  return createHistoryStore({
    userDataDir: () => directory,
    runtimeMetadata: async (model) => ({ model }),
  });
}

test('a generated title is plain text on one line with seven words', () => {
  const raw = [
    '<think>Do not show this.</think>',
    'Title: "**Repair background chat naming safely across every new session**"',
    'This second line must not be in the title.',
  ].join('\n');

  assert.equal(
    normalizeGeneratedTitle(raw),
    'Repair background chat naming safely across every',
  );
});


test('title generation uses silent inference with no tools', async () => {
  let call;
  const stats = { promptTokens: 18, evalTokens: 4 };
  const result = await generateChatTitle({
    conversation: [{ role: 'user', content: 'Fix automatic chat naming.' }],
    model: 'title-model',
    streamChat: async (...args) => {
      call = args;
      return { content: 'Automatic Chat Naming Repair', stats };
    },
    thinkValue: async (_model, want) => !!want,
    effectiveContext: async () => 32_768,
    timeoutMs: 500,
  });

  assert.deepEqual(result, { ok: true, title: 'Automatic Chat Naming Repair', stats });
  assert.equal(call[0], 'title-model');
  assert.equal(call[2] instanceof AbortSignal, true);
  assert.equal(call[3], false, 'thinking must be disabled for the title request');
  assert.equal(call[4], true, 'title tokens must not go to the chat stream');
  assert.equal(call[5], 8192, 'the small title request must have a bounded context');
  assert.equal(call[6], null, 'the title request must not have tools');
  assert.deepEqual(call[7], { toolCallRetries: 0 });
  assert.equal(call[8], 0.2);
  assert.equal(call[9], 32);
});

test('title inference has a 20 second limit and accepts cancellation', async () => {
  const source = read('src/lib/chat-title.js');
  assert.match(source, /signal,\s*timeoutMs = 20_000,/);

  const controller = new AbortController();
  let requestSignal;
  let inferenceStarted;
  const started = new Promise((resolve) => { inferenceStarted = resolve; });
  const pending = generateChatTitle({
    conversation: [{ role: 'user', content: 'Fix automatic chat naming.' }],
    model: 'title-model',
    signal: controller.signal,
    streamChat: async (...args) => {
      requestSignal = args[2];
      inferenceStarted();
      return new Promise((resolve, reject) => {
        const stop = () => reject(requestSignal.reason);
        if (requestSignal.aborted) stop();
        else requestSignal.addEventListener('abort', stop, { once: true });
      });
    },
    thinkValue: async () => undefined,
    effectiveContext: async () => 4096,
  });

  await started;
  controller.abort();
  const result = await pending;

  assert.equal(requestSignal.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
});

test('empty model output cannot replace the temporary title', async () => {
  const result = await generateChatTitle({
    conversation: [{ role: 'user', content: 'Fix automatic chat naming.' }],
    model: 'title-model',
    streamChat: async () => ({ content: '<think>No visible answer.</think>\n  ' }),
    thinkValue: async () => undefined,
    effectiveContext: async () => 4096,
  });

  assert.deepEqual(result, { ok: false, error: 'The model returned an empty title.' });
});

test('the automatic-title marker survives history saves', async () => {
  const history = historyStore();
  const conversation = [{ role: 'user', content: 'Explain the project structure.' }];

  await history.save({
    id: 'chat-1',
    title: 'Explain the project structure.',
    model: 'm',
    autoTitlePending: true,
    autoTitleAttempts: 2,
  }, conversation);

  const pending = history.load('chat-1');
  assert.equal(pending.ok, true);
  assert.equal(pending.chat.autoTitlePending, true);
  assert.equal(pending.chat.autoTitleAttempts, 2);

  await history.save({ ...pending.chat, autoTitlePending: false, autoTitleAttempts: 3 }, conversation);
  const finished = history.load('chat-1').chat;
  assert.equal(finished.autoTitlePending, false);
  assert.equal(finished.autoTitleAttempts, 3);
});




