// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/sessions.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSessions, sessionKeyFor, loadSessionState } = require('../../src/lib/sessions');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

// --- routing ---

test('a run belongs to the default session unless it names a chat', () => {
  // Anything that forgets to declare a chat must not quietly acquire a
  // conversation of its own.
  assert.equal(sessionKeyFor({}), 'window');
  assert.equal(sessionKeyFor(), 'window');
  assert.equal(sessionKeyFor({ chatId: '  ' }), 'window');
  // Origins are pruned: the chat id alone is the identity.
  assert.equal(sessionKeyFor({ origin: 'ui', chatId: '17390' }), '17390');
});



test('a saved session can be restored after restart', () => {
  const conversation = [
    { role: 'user', content: 'what did we learn?' },
    { role: 'assistant', content: 'Use the school portal first.' },
  ];
  const history = {
    load: (id) => id === 'discord-42'
      ? { ok: true, chat: { conversation, onlineResearch: true, runMetrics: { metrics: { toolCalls: 4 } }, contextState: { projectPath: '/project', pinnedFiles: [] } } }
      : { ok: false },
  };
  const restored = loadSessionState(history, 'discord-42');
  assert.deepEqual(restored.conversation, conversation);
  assert.equal('onlineResearch' in restored, false);
  assert.equal(restored.usage.metrics.toolCalls, 4);
  assert.equal(loadSessionState(history, 'discord-missing'), null);
});

// --- swapping ---

test('a conversation comes back exactly as it was left', () => {
  const sessions = createSessions('window');
  const windowState = { conversation: [{ role: 'user', content: 'in the app' }], sessionId: 's-win' };

  const away = sessions.switchTo('discord-42', windowState);
  assert.equal(away.changed, true);
  assert.equal(away.state, null, 'a session entered for the first time starts empty');

  const discordState = { conversation: [{ role: 'user', content: 'from discord' }], sessionId: 's-dis' };
  const back = sessions.switchTo('window', discordState);
  assert.equal(back.changed, true);
  assert.deepEqual(back.state, windowState, 'the window gets its own messages back, not Discord\'s');

  const again = sessions.switchTo('discord-42', windowState);
  assert.deepEqual(again.state, discordState);
});

test('switching to the session already active does nothing', () => {
  const sessions = createSessions('window');
  const result = sessions.switchTo('window', { conversation: [{ role: 'user', content: 'x' }] });
  assert.equal(result.changed, false);
  assert.equal(result.state, null);
  assert.deepEqual(sessions.known(), [], 'nothing was stashed, so nothing can be clobbered');
});

test('forget drops a session so a reset does not come back later', () => {
  const sessions = createSessions('window');
  sessions.switchTo('discord-42', { conversation: [{ role: 'user', content: 'old' }] });
  sessions.switchTo('window', { conversation: [] });
  assert.equal(sessions.forget('discord-42'), true);
  assert.equal(sessions.switchTo('discord-42', { conversation: [] }).state, null);
});

// --- wiring ---






// --- safety against concurrent access ---

test('a session can be read without becoming it', () => {
  const sessions = createSessions('window');
  const windowState = { conversation: [{ role: 'user', content: 'in the app' }], sessionId: 's-win' };
  sessions.switchTo('discord-42', windowState);

  assert.deepEqual(sessions.peek('window'), windowState);
  assert.equal(sessions.active(), 'discord-42', 'peeking must not change who is active');
  assert.equal(sessions.peek('never-seen'), null);
});




