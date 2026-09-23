// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- durable chat storage ----------"
'use strict';

// One JSON file per chat in <dataDir>/history/ plus a light index.json. Saves
// rewrite one chat's file, never the whole history. The store itself is built
// in runtime.js (rt.services.historyStore); this is what the commands and
// the REPL need on top of it.

const fs = require('fs');
const { normalizeContextState } = require('../lib/context-controls');
const { safeChatId } = require('../lib/history-store');

function canonical(cwd) {
  try { return fs.realpathSync(cwd); } catch { return String(cwd || ''); }
}

function createHistory(rt) {
  const store = () => rt.services.historyStore;

  function list({ cwd } = {}) {
    const entries = store().list()
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    if (!cwd) return entries;
    const wanted = canonical(cwd);
    return entries.filter((entry) => entry.cwd && canonical(entry.cwd) === wanted);
  }

  // The newest chat started in this directory, for --continue.
  function latestFor(cwd) {
    return list({ cwd })[0] || null;
  }

  // Make a saved chat the active conversation. Refused mid-run: swapping the
  // conversation under a running loop tears both transcripts.
  function load(id) {
    if (rt.run.abort) return { ok: false, error: 'A run is in progress. Stop it first.' };
    const loaded = store().load(id);
    if (!loaded.ok) return loaded;
    const chatId = safeChatId(loaded.chat.id);
    rt.chatId = chatId;
    rt.state.enterSession(chatId);
    rt.session.conversation = Array.isArray(loaded.chat.conversation) ? loaded.chat.conversation : [];
    rt.session.contextState = normalizeContextState(loaded.chat.contextState);
    rt.session.usage = rt.state.restoreUsage(loaded.chat.runMetrics);
    rt.session.spend = loaded.chat.spend || rt.session.spend;
    rt.state.rememberConversationView({ model: loaded.chat.model, cwd: loaded.chat.cwd || rt.config.cwd });
    return { ok: true, chat: loaded.chat };
  }

  function remove(id) {
    const safeId = safeChatId(id);
    if (safeId === rt.chatId && rt.run.abort) return { ok: false, error: 'That chat is running. Stop it first.' };
    const removed = store().remove(safeId);
    if (removed.ok) rt.sessions.forget(safeId);
    return removed;
  }

  return { latestFor, list, load, remove };
}

module.exports = { createHistory };
