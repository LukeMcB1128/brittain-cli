// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/secrets.js
'use strict';

// API keys, kept out of settings.json.
//
// settings.json is plain text the user is invited to open and edit. A provider
// key is not configuration in that sense: it is a credential that pays for
// things, and it should not sit in a file that gets pasted into bug reports or
// synced somewhere by accident.
//
// The OS keychain is used where one is available. Where it is not, the key is
// still stored separately with tight permissions and the caller is told plainly
// that it is unencrypted, rather than being quietly given weaker protection
// than it thinks it has.

const fs = require('fs');
const path = require('path');

function secretPath(userDataDir) {
  return path.join(userDataDir, 'credentials.json');
}

function read(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretPath(userDataDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(userDataDir, value) {
  const target = secretPath(userDataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}

// Pruned: Electron safeStorage. The CLI keeps secrets in the OS keychain
// (src/host/keychain.js); this file store is the fallback when no keychain is
// available, and every write through it reports encrypted: false so the
// caller can say so.
function createSecretStore({ userDataDir }) {
  return {
    encrypted: () => false,

    get(name) {
      const record = read(userDataDir())[name];
      return record?.value ? String(record.value) : '';
    },

    has(name) {
      return !!this.get(name);
    },

    set(name, value) {
      const store = read(userDataDir());
      const text = String(value || '');
      if (!text) delete store[name];
      else store[name] = { encrypted: false, value: text };
      write(userDataDir(), store);
      return { ok: true, encrypted: false };
    },

    remove(name) {
      const store = read(userDataDir());
      if (!(name in store)) return;
      delete store[name];
      write(userDataDir(), store);
    },

    // Never return the key itself: callers only need to know whether one is
    // set, and showing it invites it into a screenshot.
    describe(name) {
      const value = this.get(name);
      return {
        set: !!value,
        encrypted: false,
        hint: value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '',
      };
    },
  };
}

module.exports = { createSecretStore, secretPath };
