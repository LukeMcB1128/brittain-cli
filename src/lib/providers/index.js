'use strict';

// The three provider modes (docs/PLAN.md §5.1) and how each one resolves to a
// concrete { transport, endpoint, key, model }.
//
// Everything that talks to a provider goes through resolve(), so the rule
// that the Brittain endpoint is never shown has one place to hold: describe()
// omits it, and every error that leaves this module passes through redact().

const { transportFor, providerPath, safeProviderError } = require('../inference');
const { normalizeOpenAIModels, normalizeOllamaModels } = require('../model-catalog');
const brittain = require('./brittain');

const MODES = Object.freeze({
  brittain: Object.freeze({ id: 'brittain', label: 'Brittain', keyName: 'brittainApiKey' }),
  openai: Object.freeze({ id: 'openai', label: 'OpenAI-compatible', keyName: 'openaiApiKey' }),
  ollama: Object.freeze({ id: 'ollama', label: 'Ollama', keyName: '' }),
});

const MODE_IDS = Object.freeze(Object.keys(MODES));

// The context window to budget against when the server states none. Ollama's
// is the source's /api/show fallback; the OpenAI-compatible and Brittain
// defaults stand in for the source's configured cap, since there the provider
// enforces its own limit and the number only drives local budgeting.
const DEFAULT_CONTEXT = Object.freeze({
  brittain: 32_768,
  openai: 131_072,
  ollama: 8192,
});

const LOGIN_HINT = 'Run `brittain login` to save an API key.';

function isMode(value) {
  return MODE_IDS.includes(value);
}

function createProviders({ getSettings, secrets, env = process.env, fetchImpl = (...args) => fetch(...args) }) {
  const redact = (text) => brittain.redactEndpoint(text, env);

  function resolve(mode = getSettings().provider) {
    const id = isMode(mode) ? mode : 'brittain';
    const settings = getSettings();
    const record = settings.providers?.[id] || {};
    const info = MODES[id];
    const key = info.keyName ? secrets.get(info.keyName) : '';
    if (id === 'brittain') {
      return {
        mode: id,
        label: info.label,
        transportId: brittain.BRITTAIN_TRANSPORT,
        transport: transportFor(brittain.BRITTAIN_TRANSPORT),
        endpoint: brittain.brittainEndpoint(env),
        // The key travels as the Brittain auth header rather than the
        // transport's own Bearer handling, so the scheme lives in brittain.js.
        apiKey: '',
        extraHeaders: brittain.authHeaders(key),
        hasKey: !!key,
        model: record.model || brittain.DEFAULT_MODEL,
        defaultContext: DEFAULT_CONTEXT.brittain,
      };
    }
    return {
      mode: id,
      label: info.label,
      transportId: id,
      transport: transportFor(id),
      endpoint: record.endpoint || '',
      apiKey: id === 'openai' ? key : '',
      extraHeaders: {},
      hasKey: !!key,
      model: record.model || '',
      defaultContext: DEFAULT_CONTEXT[id],
    };
  }

  // What may be shown to a person: never the Brittain endpoint, never a key.
  function describe(mode) {
    const resolved = resolve(mode);
    return {
      mode: resolved.mode,
      label: resolved.label,
      model: resolved.model,
      ...(resolved.mode === 'brittain' ? {} : { endpoint: resolved.endpoint }),
      ...(MODES[resolved.mode].keyName ? { keySet: resolved.hasKey } : {}),
    };
  }

  // Headers for a non-chat request (model listing), matching how chat
  // requests authenticate for the same mode.
  function requestHeaders(resolved) {
    return {
      ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
      ...resolved.extraHeaders,
    };
  }

  function unreachable(resolved, err) {
    const reason = redact(String(err?.cause?.code || err?.message || err));
    if (resolved.mode === 'brittain') return `Cannot reach the Brittain API — ${reason}`;
    if (resolved.mode === 'ollama') {
      return `Ollama isn't running at ${resolved.endpoint} (${reason}). Start it with \`ollama serve\`, or change the endpoint with \`brittain config set providers.ollama.endpoint <url>\`.`;
    }
    return `Cannot reach ${resolved.endpoint} — ${reason}`;
  }

  // Each protocol lists its models somewhere different. Asking Ollama's path of
  // a cloud provider returns nothing and reads as "no server", which is how a
  // correctly configured endpoint ended up behind an "install Ollama" screen.
  async function listModels(mode, { timeoutMs = 10_000 } = {}) {
    const resolved = resolve(mode);
    if (!resolved.endpoint) {
      return { ok: false, mode: resolved.mode, error: `No endpoint configured for ${resolved.label}. Run \`brittain provider ${resolved.mode}\` to set one up.` };
    }
    const route = providerPath(resolved.transportId, 'models');
    let res;
    try {
      res = await fetchImpl(resolved.endpoint + route, {
        headers: requestHeaders(resolved),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { ok: false, mode: resolved.mode, error: unreachable(resolved, err) };
    }
    if (res.status === 401 || res.status === 403) {
      const error = resolved.mode === 'brittain'
        ? (resolved.hasKey ? `The Brittain API rejected the saved key. ${LOGIN_HINT}` : `The Brittain API needs a key. ${LOGIN_HINT}`)
        : resolved.hasKey ? `The provider rejected the saved API key. ${LOGIN_HINT.replace('login', 'login --provider openai')}`
        : `No API key saved for this provider yet. ${LOGIN_HINT.replace('login', 'login --provider openai')}`;
      return { ok: false, mode: resolved.mode, auth: true, error };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, mode: resolved.mode, error: safeProviderError(res.status, body, { redact }) };
    }
    try {
      const listed = await res.json();
      const modelDetails = resolved.transportId === 'openai'
        ? normalizeOpenAIModels(listed)
        : normalizeOllamaModels(listed?.models);
      return { ok: true, mode: resolved.mode, models: modelDetails.map((model) => model.id), modelDetails };
    } catch (err) {
      return { ok: false, mode: resolved.mode, error: redact(`The model list could not be read — ${err.message || err}`) };
    }
  }

  return { resolve, describe, listModels, redact };
}

module.exports = {
  DEFAULT_CONTEXT,
  LOGIN_HINT,
  MODES,
  MODE_IDS,
  createProviders,
  isMode,
};
