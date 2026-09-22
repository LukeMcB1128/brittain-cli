'use strict';

// An in-memory Host (src/core/host.js) with scripted approvals and answers,
// for core tests. Nothing here touches the keychain or the real data dir.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveSettings, normalizeSettings } = require('../../src/lib/settings');

function createTestHost({ settings = {}, keys = {}, approvals = [], answers = [], interactive = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-core-'));
  saveSettings(dataDir, normalizeSettings(settings));
  const secretValues = new Map(Object.entries(keys));
  const approvalQueue = [...approvals];
  const answerQueue = [...answers];
  const asked = { approvals: [], questions: [] };
  return {
    dataDir,
    tempDir: os.tmpdir(),
    secrets: {
      get: (name) => secretValues.get(name) || '',
      has: (name) => !!secretValues.get(name),
      set: (name, value) => { secretValues.set(name, value); return { ok: true, encrypted: true }; },
      remove: (name) => { secretValues.delete(name); },
    },
    // A scripted approval is a boolean, 'always', or a function of the request.
    async approve(request) {
      asked.approvals.push(request);
      const next = approvalQueue.length ? approvalQueue.shift() : false;
      return typeof next === 'function' ? next(request) : next;
    },
    async ask(request) {
      asked.questions.push(request);
      const next = answerQueue.length ? answerQueue.shift() : null;
      return typeof next === 'function' ? next(request) : next;
    },
    interactive: () => interactive,
    asked,
  };
}

// Point a mode at a fake provider in the settings shape.
function settingsFor(mode, fake, model = 'alpha-model') {
  if (mode === 'openai') return { provider: 'openai', providers: { openai: { endpoint: `${fake.base}/v1`, model } } };
  if (mode === 'ollama') return { provider: 'ollama', providers: { ollama: { endpoint: fake.base, model } } };
  return { provider: 'brittain', providers: { brittain: { model } } };
}

function envFor(mode, fake) {
  return mode === 'brittain' ? { BRITTAIN_API_URL: `${fake.base}/v1` } : {};
}

// Collects sink events as [channel, payload] pairs.
function collect(events) {
  const seen = [];
  events.subscribe((channel, payload, meta) => seen.push({ channel, payload, meta }));
  return seen;
}

module.exports = { collect, createTestHost, envFor, settingsFor };
