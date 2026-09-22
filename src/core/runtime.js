'use strict';

// The core, assembled. Everything main.js kept as module state lives on `rt`
// (PLAN.md §6.3), so a process can hold more than one runtime and a test can
// build one against a fake provider without touching global state.
//
// The core never writes to stdout: everything it has to say goes through
// rt.sink, and whoever holds the runtime subscribes to it.

const pkg = require('../../package.json');
const { assertHost } = require('./host');
const { loadSettings, saveSettings } = require('../lib/settings');
const { createRunSink } = require('../lib/run-sink');
const { createProviders, isMode } = require('../lib/providers');
const { createHistoryStore } = require('../lib/history-store');
const { createLedgerStore } = require('../lib/ledger-store');
const { createModels } = require('./models');
const { createState } = require('./state');
const { createStream } = require('./stream');

// overrides: per-invocation choices that must not persist (--provider,
// --model, --mode, --cwd).
function createRuntime({ host, env = process.env, overrides = {} } = {}) {
  assertHost(host);
  if (overrides.provider && !isMode(overrides.provider)) {
    throw new Error(`Unknown provider "${overrides.provider}". Choose brittain, openai, or ollama.`);
  }

  const rt = {
    version: pkg.version,
    host,
    env,
    chatId: '',
    run: { id: '', abort: null, stopRequested: false },
  };

  rt.config = {
    dataDir: host.dataDir,
    // Read fresh each time so a change saved by another command is seen, then
    // the per-invocation overrides applied on top.
    settings() {
      const stored = loadSettings(host.dataDir);
      if (!overrides.provider && !overrides.model) return stored;
      const provider = overrides.provider || stored.provider;
      const providers = overrides.model
        ? { ...stored.providers, [provider]: { ...stored.providers[provider], model: overrides.model } }
        : stored.providers;
      return { ...stored, provider, providers };
    },
    save(next) {
      return saveSettings(host.dataDir, next);
    },
    cwd: overrides.cwd || process.cwd(),
    mode: overrides.mode === 'chat' ? 'chat' : overrides.mode === 'code' ? 'code' : '',
  };

  rt.sink = createRunSink({ meta: () => ({ chatId: rt.chatId, runId: rt.run.id }) });
  rt.providers = createProviders({ getSettings: () => rt.config.settings(), secrets: host.secrets, env });
  rt.services = {
    historyStore: createHistoryStore({ userDataDir: () => host.dataDir, runtimeMetadata: (model) => rt.models.runtimeMetadata(model) }),
    ledgerStore: createLedgerStore({ userDataDir: () => host.dataDir }),
  };
  rt.models = createModels(rt);
  rt.state = createState(rt);
  rt.stream = createStream(rt);

  function beginRun() {
    rt.run.id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    rt.run.abort = new AbortController();
    rt.run.stopRequested = false;
    return rt.run.abort;
  }

  function endRun() {
    rt.run.abort = null;
  }

  // One call, no tools: the whole of `brittain ask`.
  async function ask({ prompt, think } = {}) {
    const provider = rt.providers.resolve();
    const model = provider.model;
    if (!model) return { ok: false, error: `No model selected for ${provider.label}. Run \`brittain provider ${provider.mode}\` to pick one.` };
    const settings = rt.config.settings();
    const controller = beginRun();
    const startedAt = Date.now();
    try {
      const numCtx = await rt.models.effectiveContext(model);
      const thinkParam = await rt.models.thinkValue(model, think === undefined ? settings.chatThink : !!think);
      const result = await rt.stream.streamChat(
        model,
        [{ role: 'user', content: String(prompt || '') }],
        controller.signal,
        thinkParam,
        false,
        numCtx,
        null,
        { toolCallRetries: 0 },
        settings.chatTemperature,
      );
      rt.state.recordUsage('main', result.stats);
      if (result.stats) rt.state.publishContextStats(result.stats, numCtx);
      rt.state.finishRunMetrics(startedAt);
      rt.sink.done({ ok: true, stats: result.stats });
      return { ok: true, content: result.content, thinking: result.thinking, stats: result.stats };
    } catch (err) {
      const stopped = err?.name === 'AbortError';
      rt.state.finishRunMetrics(startedAt, stopped ? 'stopped' : 'failed');
      const error = stopped ? 'Stopped.' : rt.providers.redact(err?.message || String(err));
      rt.sink.done({ ok: false, error, stopped });
      return { ok: false, error, stopped };
    } finally {
      endRun();
    }
  }

  function stop() {
    rt.run.stopRequested = true;
    rt.run.abort?.abort();
    return { ok: true };
  }

  const commands = { ask, stop };

  return {
    rt,
    commands,
    events: { subscribe: (listener) => rt.sink.subscribe(listener) },
    shutdown() {
      stop();
    },
  };
}

module.exports = { createRuntime };
