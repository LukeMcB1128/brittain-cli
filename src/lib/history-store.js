// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/history-store.js
'use strict';

// Pruned: the code/chat mode field (chat mode was removed); older chats that
// carry one still load.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

function writeJsonAtomic(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    // Persist the directory entry where the platform supports it.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function indexEntry(chat) {
  const { id, title, model, provider, cwd, think, autoApprove, timestamp } = chat;
  return { id, title, model, provider, cwd, think, autoApprove, timestamp };
}

function safeChatId(id) {
  return String(id).replace(/[^\w.-]/g, '');
}

function createHistoryStore({ userDataDir, runtimeMetadata }) {
  const directory = () => path.join(userDataDir(), 'history');
  const indexPath = () => path.join(directory(), 'index.json');

  function list() {
    let entries = [];
    try {
      const value = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
      entries = Array.isArray(value) ? value.filter((entry) => entry && typeof entry.id === 'string') : [];
    } catch {}
    // The detail files are authoritative. Recover a lost index or an orphan
    // detail saved just before a crash. Ignore incomplete temporary files.
    let files;
    try { files = new Set(fs.readdirSync(directory())); } catch { return entries; }
    entries = entries.filter((entry) => files.has(entry.id + '.json') && entry.id !== 'index');
    const known = new Set(entries.map((entry) => entry.id));
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'index.json') continue;
      const id = file.slice(0, -5);
      if (known.has(id)) continue;
      const loaded = load(id);
      if (loaded.ok && loaded.chat.id === id && Array.isArray(loaded.chat.conversation)) {
        entries.push(indexEntry(loaded.chat));
      }
    }
    return entries;
  }

  function writeIndex(entries) {
    fs.mkdirSync(directory(), { recursive: true });
    writeJsonAtomic(indexPath(), entries);
  }

  async function save(meta, conversation) {
    try {
      const id = safeChatId(meta?.id);
      if (!id || id === 'index') return { ok: false, error: 'invalid chat id' };
      const entry = {
        id,
        title: meta.title || 'Chat',
        model: meta.model || '',
        provider: meta.provider || '',
        cwd: meta.cwd || '',
        think: !!meta.think,
        autoApprove: !!meta.autoApprove,
        timestamp: meta.timestamp || new Date().toISOString(),
      };
      // Pruned: coder and subagent role models (not in v1).
      const mainRuntime = await runtimeMetadata(meta.model || '');
      const detailed = {
        // A temporary title must survive a restart.
        // The main chat lifecycle clears this after it saves a generated title.
        autoTitlePending: !!meta.autoTitlePending,
        autoTitleAttempts: Math.max(0, Number(meta.autoTitleAttempts) || 0),
        runMetrics: meta.runMetrics || null,
        spend: meta.spend || null,
        contextState: meta.contextState || { projectPath: '', pinnedFiles: [] },
        runtime: mainRuntime,
      };
      fs.mkdirSync(directory(), { recursive: true });
      writeJsonAtomic(path.join(directory(), id + '.json'), {
        ...entry,
        ...detailed,
        conversation: conversation || [],
      });
      const index = list().filter((chat) => chat.id !== id);
      index.push(entry);
      writeIndex(index);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function load(id) {
    try {
      if (!safeChatId(id) || safeChatId(id) === 'index') throw new Error('invalid chat id');
      const chat = JSON.parse(fs.readFileSync(path.join(directory(), safeChatId(id) + '.json'), 'utf8'));
      return { ok: true, chat };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function remove(id) {
    const safeId = safeChatId(id);
    if (!safeId || safeId === 'index') return { ok: false, error: 'invalid chat id' };
    try {
      try { fs.unlinkSync(path.join(directory(), safeId + '.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      writeIndex(list().filter((chat) => chat.id !== safeId));
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  }

  return { directory, list, save, load, remove };
}

module.exports = { createHistoryStore, safeChatId };
