// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- ollama helpers ----------"
'use strict';

// What the runtime knows about models: context windows, capabilities, how to
// ask for thinking, rates, and the metadata saved with a chat.
//
// The source kept these caches as module state keyed by model name alone, and
// cleared them when the one configured endpoint changed. Here they live on
// rt.models and are keyed by provider mode + model, so switching modes never
// serves one provider's answer for another's model.
//
// Pruned: the hardware profile in runtime metadata (hardware profiling is not
// in v1) and the app commit (there is no checkout beside an npm install).
//
// "Is this the OpenAI protocol?" is asked of the resolved transport rather
// than of the provider setting, because the Brittain mode speaks whichever
// protocol providers/brittain.js names.

const os = require('os');
const { providerPath, safeProviderError } = require('../lib/inference');
const { ratesFor } = require('../lib/cost');

// sized for heavy use
const NUM_CTX_CAP = 1_048_576;

function createModels(rt) {
  const contextCache = new Map();
  // What the provider said about its own models when it listed them. On a
  // cloud endpoint this is the only source for a context window: /api/show is
  // an Ollama path and does not exist there.
  const catalogDetails = new Map();
  const capsCache = new Map();
  const runtimeMetadataCache = new Map();
  const speedSamples = new Map();

  const resolved = () => rt.providers.resolve();
  const keyFor = (model, mode = resolved().mode) => `${mode}\u0000${model}`;
  const speaksOpenAI = (provider = resolved()) => provider.transportId === 'openai';

  async function ollamaJson(route, body, signal) {
    const provider = resolved();
    const requestBody = body && route === providerPath('ollama', 'chat')
      ? { ...body, keep_alive: rt.config.settings().keepAlive }
      : body;
    const res = await fetch(provider.endpoint + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...provider.extraHeaders },
      body: requestBody ? JSON.stringify(requestBody) : undefined,
      signal,
    });
    if (!res.ok) throw new Error(safeProviderError(res.status, await res.text(), { redact: rt.providers.redact }));
    return res.json();
  }

  function rememberModelDetails(details, mode = resolved().mode) {
    for (const entry of details || []) {
      if (entry?.id) catalogDetails.set(keyFor(entry.id, mode), entry);
    }
    // A model's window is a property of the model, but the cache was filled with
    // the fallback before the catalog arrived; drop it so the real figure is
    // picked up rather than the guess being kept forever.
    contextCache.clear();
    capsCache.clear();
  }

  async function listModels(mode) {
    const listed = await rt.providers.listModels(mode);
    if (listed.ok) rememberModelDetails(listed.modelDetails, listed.mode);
    return listed;
  }

  // The catalog is only filled by listing. A first message in a fresh process
  // has not listed yet, so fetch it once, quietly, before answering from it.
  async function ensureCatalog() {
    const provider = resolved();
    if (!speaksOpenAI(provider)) return;
    if ([...catalogDetails.keys()].some((key) => key.startsWith(`${provider.mode}\u0000`))) return;
    await listModels(provider.mode).catch(() => null);
  }

  async function getContextLength(model) {
    const provider = resolved();
    const key = keyFor(model, provider.mode);
    if (contextCache.has(key)) return contextCache.get(key);

    // Probing /api/show against a cloud endpoint fails, and a small fallback
    // there budgeted a million-token model as if it were tiny, compacting
    // almost immediately. Where the provider stated a window, use it; where it
    // did not, fall back to the mode's default, since on this transport the
    // number only drives local budgeting and the provider enforces its own
    // limit.
    if (speaksOpenAI(provider)) {
      await ensureCatalog();
      const stated = Number(catalogDetails.get(key)?.contextLength) || 0;
      const length = stated > 0 ? stated : (rt.config.settings().mainContextCap || provider.defaultContext);
      contextCache.set(key, length);
      return length;
    }

    try {
      const info = await ollamaJson(providerPath('ollama', 'model'), { model });
      const mi = info.model_info || {};
      const found = Object.keys(mi).find((k) => k.endsWith('.context_length'));
      const len = found ? mi[found] : provider.defaultContext;
      contextCache.set(key, len);
      return len;
    } catch {
      return provider.defaultContext;
    }
  }

  async function effectiveContext(model, configuredCap = rt.config.settings().mainContextCap) {
    const cap = configuredCap > 0 ? configuredCap : NUM_CTX_CAP;
    return Math.min(await getContextLength(model), cap);
  }

  // Model capability checks (thinking) — sending think:true to a model that
  // lacks the capability makes Ollama error out. Pruned: vision (attachments
  // are not in v1).
  async function getCapabilities(model) {
    const provider = resolved();
    const key = keyFor(model, provider.mode);
    if (capsCache.has(key)) return capsCache.get(key);
    // The OpenAI shape states no capabilities; thinking is decided by
    // thinkValue below instead.
    if (speaksOpenAI(provider)) return [];
    try {
      const info = await ollamaJson(providerPath('ollama', 'model'), { model });
      const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
      capsCache.set(key, caps);
      return caps;
    } catch {
      return [];
    }
  }
  const supportsThinking = async (model) => (await getCapabilities(model)).includes('thinking');

  // What to pass as `think`, given what a caller wants. Returning undefined
  // means "say nothing about thinking" and leaves the model on its own default.
  //
  // The capability gate is right for Ollama, where sending `think` to a model
  // without the capability is an error. It is wrong for the OpenAI transport,
  // where no capabilities are reported — so the gate would silently leave
  // thinking on. On a server with no reasoning parser that is worse than
  // wasteful: the trace comes back inside `content` rather than in a field of
  // its own, so it cannot be stripped after the fact.
  //
  // Only the servers that read the kwarg are told about it: sending it to every
  // OpenAI-compatible provider would draw a 400 from OpenAI itself for an
  // unrecognized param.
  async function thinkValue(model, want) {
    const provider = resolved();
    if (speaksOpenAI(provider)) {
      await ensureCatalog();
      return catalogDetails.get(keyFor(model, provider.mode))?.acceptsTemplateKwargs ? !!want : undefined;
    }
    return (await supportsThinking(model)) ? !!want : undefined;
  }

  // Summarizers want thinking off: the trace is charged to the same max_tokens
  // as the record, and a model that thinks past the budget returns empty
  // content with finish_reason "length".
  const summarizerThink = (model) => thinkValue(model, false);

  // Rates for the model about to run, from the provider's own listing. Local
  // models are free and cloud models with no published price are unknown,
  // which costOf keeps distinct.
  function ratesForModel(model) {
    const provider = resolved();
    if (provider.mode === 'ollama') return null;
    return ratesFor(catalogDetails.get(keyFor(model, provider.mode)));
  }

  function recordModelSpeed(model, stats, contextTokens) {
    if (!model || !stats || stats.evalTokens < 8 || !Number.isFinite(stats.tokPerSec) || stats.tokPerSec <= 0) return;
    const key = keyFor(model);
    const samples = speedSamples.get(key) || [];
    samples.push({ tokensPerSecond: stats.tokPerSec, contextTokens, recordedAt: new Date().toISOString() });
    speedSamples.set(key, samples.slice(-12));
  }

  // Saved with each chat so a transcript records what produced it. Never
  // includes an endpoint: the Brittain one must not be written anywhere, and
  // the others are in settings already.
  async function runtimeMetadata(model) {
    const provider = resolved();
    const key = keyFor(model, provider.mode);
    if (runtimeMetadataCache.has(key)) return runtimeMetadataCache.get(key);
    const settings = rt.config.settings();
    const base = {
      appVersion: rt.version,
      provider: provider.mode,
      settings: {
        requestedContextCap: settings.mainContextCap || NUM_CTX_CAP,
        codeTemperature: settings.codeTemperature,
        keepAlive: provider.mode === 'ollama' ? settings.keepAlive : null,
        provider: provider.mode,
      },
      platform: { platform: process.platform, arch: process.arch, totalMemoryBytes: os.totalmem() },
    };
    let metadata;
    if (speaksOpenAI(provider)) {
      const detail = catalogDetails.get(key) || {};
      metadata = {
        ...base,
        ollamaVersion: null,
        model: {
          name: model || null, digest: null, sizeBytes: null, family: null,
          parameterSize: null, quantization: null, nativeContext: Number(detail.contextLength) || null,
        },
      };
    } else {
      const [tags, show, version] = await Promise.all([
        ollamaJson(providerPath('ollama', 'models')).catch(() => ({ models: [] })),
        model ? ollamaJson(providerPath('ollama', 'model'), { model }).catch(() => ({})) : {},
        ollamaJson(providerPath('ollama', 'version')).catch(() => ({})),
      ]);
      const tag = (tags.models || []).find((entry) => entry.name === model || entry.model === model) || {};
      const modelInfo = show.model_info || {};
      const contextKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
      metadata = {
        ...base,
        ollamaVersion: version.version || null,
        model: {
          name: model || null,
          digest: tag.digest || null,
          sizeBytes: tag.size || null,
          family: tag.details?.family || show.details?.family || null,
          parameterSize: tag.details?.parameter_size || show.details?.parameter_size || null,
          quantization: tag.details?.quantization_level || show.details?.quantization_level || null,
          nativeContext: contextKey ? modelInfo[contextKey] : null,
        },
      };
    }
    runtimeMetadataCache.set(key, metadata);
    return metadata;
  }

  return {
    NUM_CTX_CAP,
    effectiveContext,
    getContextLength,
    listModels,
    ollamaJson,
    ratesForModel,
    recordModelSpeed,
    rememberModelDetails,
    runtimeMetadata,
    speedSamples: () => speedSamples,
    summarizerThink,
    supportsThinking,
    thinkValue,
  };
}

module.exports = { NUM_CTX_CAP, createModels };
