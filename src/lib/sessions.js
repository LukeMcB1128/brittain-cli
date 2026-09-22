// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/sessions.js
'use strict';

// Which conversation a run belongs to.
//
// One module-level conversation was right while every run started from the
// window. It stopped being right the moment runs could start anywhere: a
// Discord message, a scheduled trigger and the window all pushed into the same
// history, so a 3am heartbeat reasoned with Tuesday's chat still in scope, and
// a transcript saved under a Discord chat id carried messages that were never
// sent from Discord. Two separate bugs, one cause.
//
// Only one run executes at a time — the run queue guarantees that — so
// conversations are swapped rather than held concurrently. Each entry point
// declares which session it is for; the outgoing one is stashed on the way out
// and restored untouched when something returns to it. That keeps every
// existing use of the conversation variable working while giving each origin
// its own history, ledger and context state.
//
// In the CLI only one chat is live per process, but /history load and /clear
// still swap conversations, so the registry keeps the same shape.

// Pruned: origin keys for Discord and triggers. The CLI has one origin, so a
// session is keyed by its chat id, and a payload without one belongs to the
// default session — exactly the window's behaviour in the app.
function sessionKeyFor(payload = {}) {
  const chatId = String(payload?.chatId || '').trim();
  return chatId || 'window';
}

// The in-memory registry is empty after a restart, but conversations are saved
// under their stable chat id. Restore that record on first use so a resumed
// chat continues the conversation instead of starting over.
function loadSessionState(historyStore, key) {
  if (!historyStore || typeof historyStore.load !== 'function') return null;
  const loaded = historyStore.load(String(key || ''));
  if (!loaded?.ok || !loaded.chat) return null;
  return {
    conversation: Array.isArray(loaded.chat.conversation) ? loaded.chat.conversation : [],
    contextState: loaded.chat.contextState || null,
    usage: loaded.chat.runMetrics || null,
    spend: loaded.chat.spend || null,
  };
}

function createSessions(initialKey = 'window') {
  const stored = new Map();
  let active = String(initialKey);

  return {
    active: () => active,
    known: () => [...stored.keys()],

    // Stash `current` under the active key and hand back whatever `key` had.
    // `changed` is false when already there, so callers can skip the swap;
    // `state` is null for a session being entered for the first time, which the
    // caller turns into a fresh, empty conversation.
    switchTo(key, current) {
      const target = String(key || 'window');
      if (target === active) return { changed: false, state: null };
      stored.set(active, current);
      active = target;
      return { changed: true, state: stored.get(target) || null };
    },

    // Read a session's stored state without becoming it. Anything that only
    // needs to look must use this: switching would pull the conversation out
    // from under a running loop.
    peek(key) {
      return stored.get(String(key || '')) || null;
    },

    // Drop a session's stored history — used when a conversation is cleared, so
    // "reset" does not leave the old messages waiting to be restored later.
    forget(key) {
      return stored.delete(String(key || ''));
    },
  };
}

module.exports = { createSessions, sessionKeyFor, loadSessionState };
