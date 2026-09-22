// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/ledger-store.js
'use strict';

// Durable per-session ledgers.
//
// Compaction is where a session's history stops being recoverable from the
// conversation itself, so each ledger is written out at that moment. The file
// is what answers "what actually happened" afterwards — including for a run
// nobody watched — and it survives the compaction that prompted it.

const fs = require('fs');
const path = require('path');

const MAX_SNAPSHOTS = 50;
const MAX_SESSION_FILES = 200;

function safeId(value) {
  // Path separators go, and so do leading dots — a name like ".." is not a
  // traversal once an extension is appended, but it is not a filename anyone
  // wants to see in the runs directory either.
  return String(value || '')
    .replace(/[^\w.-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+/, '')
    .slice(0, 80);
}

// The stored shape is plain JSON, so Maps from the ledger are flattened here.
function serializeLedger(ledger) {
  return {
    changed: (ledger?.changed || []).map((entry) => ({
      path: entry.path,
      verbs: Object.fromEntries(entry.verbs || []),
      reads: entry.reads || 0,
      failures: entry.failures || 0,
    })),
    read: (ledger?.read || []).map((entry) => ({ path: entry.path, reads: entry.reads || 0 })),
    commands: ledger?.commands || [],
    denied: ledger?.denied || [],
    errors: ledger?.errors || [],
    totals: ledger?.totals || {},
  };
}

function createLedgerStore({ userDataDir }) {
  const directory = () => path.join(userDataDir(), 'runs');
  const filePath = (sessionId) => path.join(directory(), `${safeId(sessionId)}.json`);

  function read(sessionId) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath(sessionId), 'utf8'));
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  // Oldest session files are pruned rather than left to grow without bound.
  function prune() {
    try {
      const dir = directory();
      const entries = fs.readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const full = path.join(dir, name);
          return { full, at: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.at - a.at);
      for (const stale of entries.slice(MAX_SESSION_FILES)) {
        try { fs.unlinkSync(stale.full); } catch {}
      }
    } catch {}
  }

  // Never throws: losing a ledger write must not take a compaction down with
  // it, since the compaction is the part the user is waiting on.
  function append(sessionId, ledger, meta = {}) {
    const id = safeId(sessionId);
    if (!id) return { ok: false, error: 'invalid session id' };
    try {
      const existing = read(id);
      const snapshots = Array.isArray(existing?.snapshots) ? existing.snapshots : [];
      snapshots.push({
        at: new Date().toISOString(),
        ...meta,
        ledger: serializeLedger(ledger),
      });
      const record = {
        sessionId: id,
        startedAt: existing?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        snapshots: snapshots.slice(-MAX_SNAPSHOTS),
      };
      const target = filePath(id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = target + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', 'utf8');
      fs.renameSync(temporary, target);
      prune();
      return { ok: true, path: target, snapshots: record.snapshots.length };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }

  function list() {
    try {
      return fs.readdirSync(directory())
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  return { append, read, list, directory, filePath };
}

module.exports = { createLedgerStore, serializeLedger, safeId, MAX_SNAPSHOTS, MAX_SESSION_FILES };
