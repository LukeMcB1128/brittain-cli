// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/inference.js
'use strict';

// How to talk to an inference endpoint.
//
// The app has always spoken Ollama's /api/chat: newline-delimited JSON, one
// complete object per line, tool calls arriving whole. Everything cloud speaks
// OpenAI's /v1/chat/completions instead: server-sent events, deltas rather than
// messages, and tool calls arriving as indexed fragments that have to be
// stitched back together. Pointing the endpoint setting at a cloud provider
// therefore did not "just work" — it could not.
//
// A transport owns exactly two things: how to phrase the request, and how to
// turn one line of the response into deltas. The consuming loop in main.js —
// which accumulates text, watches for degradation, and emits to the sink — is
// identical for both and stays where it is.
//
// A delta is { content?, thinking?, toolCalls?, stats?, error? }; a parser may
// return several, or none, for any given line.

// Ollama reports timings in nanoseconds and counts in fields of its own; the
// OpenAI shape has none of that, so anything missing simply stays zero rather
// than being invented.
function ollamaStats(chunk) {
  return {
    promptTokens: chunk.prompt_eval_count || 0,
    evalTokens: chunk.eval_count || 0,
    tokPerSec: chunk.eval_duration ? (chunk.eval_count || 0) / (chunk.eval_duration / 1e9) : 0,
    loadMs: (chunk.load_duration || 0) / 1e6,
    promptEvalMs: (chunk.prompt_eval_duration || 0) / 1e6,
    generationMs: (chunk.eval_duration || 0) / 1e6,
    totalMs: (chunk.total_duration || 0) / 1e6,
  };
}

const ollamaTransport = {
  id: 'ollama',
  needsKey: false,

  request({ endpoint, model, messages, tools, think, numCtx, temperature, keepAlive, maxTokens, extraHeaders }) {
    return {
      url: endpoint.replace(/\/+$/, '') + '/api/chat',
      // Ollama itself takes no key; extraHeaders exists so the Brittain mode can
      // authenticate against an Ollama-shaped server.
      headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
      body: {
        model,
        // A conversation can start on an OpenAI-compatible provider and then
        // continue here. Convert its string tool arguments back to the object
        // shape Ollama requires.
        messages: toOllamaMessages(messages),
        ...(tools ? { tools } : {}),
        stream: true,
        keep_alive: keepAlive,
        options: {
          num_ctx: numCtx,
          temperature,
          ...(maxTokens ? { num_predict: maxTokens } : {}),
        },
        ...(think === undefined ? {} : { think }),
      },
    };
  },

  createParser() {
    return {
      push(line) {
        const chunk = JSON.parse(line);
        if (chunk.error) return [{ error: String(chunk.error) }];
        const message = chunk.message || {};
        const deltas = [];
        if (message.thinking) deltas.push({ thinking: message.thinking });
        if (message.content) deltas.push({ content: message.content });
        if (message.tool_calls) deltas.push({ toolCalls: message.tool_calls });
        if (chunk.done) deltas.push({ stats: ollamaStats(chunk) });
        return deltas;
      },
    };
  },
};

function ollamaToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A malformed historical call has already received its stored tool result.
    // Keep the conversation usable without asking Ollama to parse bad JSON.
    return {};
  }
}

function toOllamaMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message?.role === 'tool' && message.tool_call_id) {
      const { tool_call_id, ...ollamaMessage } = message;
      return ollamaMessage;
    }
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => ({
        function: {
          name: String(call?.function?.name || ''),
          arguments: ollamaToolArguments(call?.function?.arguments),
        },
      })),
    };
  });
}

// The conversation is stored in Ollama's shape, which differs from OpenAI's in
// two ways that both produce a 500 rather than a useful complaint:
//
//   tool results Ollama identifies them by tool_name; OpenAI requires the
//               tool_call_id of the call being answered.
//   arguments   Ollama hands back objects; OpenAI requires a JSON string.
//
// Pruned: image content parts (attachments are not in v1).
function toOpenAIMessages(messages) {
  const out = [];
  // Calls from the most recent assistant turn, waiting to be answered.
  let awaiting = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'tool') {
      // Match the result to its call by name, falling back to order. Without an
      // id the provider rejects the whole request.
      let index = message.tool_call_id
        ? awaiting.findIndex((call) => call.id === message.tool_call_id)
        : -1;
      if (index < 0) index = awaiting.findIndex((call) => call.function?.name === message.tool_name);
      const call = index >= 0 ? awaiting.splice(index, 1)[0] : awaiting.shift();
      out.push({
        role: 'tool',
        tool_call_id: message.tool_call_id || call?.id || `call_${out.length}`,
        content: String(message.content ?? ''),
      });
      continue;
    }

    if (message?.role === 'assistant') {
      const calls = (message.tool_calls || []).map((call, index) => ({
        id: call.id || `call_${index}`,
        type: 'function',
        function: {
          name: call.function?.name || '',
          arguments: typeof call.function?.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {}),
        },
      }));
      awaiting = calls.slice();
      // `thinking` is Ollama's; sending it back is an unknown field.
      out.push({
        role: 'assistant',
        content: String(message.content ?? ''),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }

    out.push({ role: message?.role || 'user', content: String(message?.content ?? '') });
  }
  return out;
}

const openAITransport = {
  id: 'openai',
  needsKey: true,

  request({ endpoint, apiKey, model, messages, tools, think, temperature, maxTokens, extraHeaders }) {
    return {
      // The endpoint setting holds the base URL — https://openrouter.ai/api/v1
      // or https://api.z.ai/api/paas/v4 — exactly as the provider documents it.
      url: endpoint.replace(/\/+$/, '') + '/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        // The Brittain mode sends its own auth header (providers/brittain.js).
        ...(extraHeaders || {}),
      },
      body: {
        model,
        messages: toOpenAIMessages(messages),
        ...(tools ? { tools } : {}),
        stream: true,
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        // `think` had no route through this transport at all, so callers that
        // asked for it off — the summarizers do — still got a thinking model.
        // The trace is charged to the same max_tokens as the answer, so a
        // summarizer could spend its entire budget inside an unterminated
        // <think> block and return empty content with finish_reason "length".
        // Measured against a local vLLM Qwen at the summarizer's real budget:
        // thinking on returned 0 characters, thinking off returned a complete
        // five-section record.
        //
        // Only sent when a caller explicitly asks for thinking off, so ordinary
        // requests keep the exact body they had. A provider that rejects
        // unknown fields would reject this one; if that shows up, gate it on
        // the endpoint rather than dropping it.
        ...(think === false ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        // Providers only report token usage on a stream when asked to, and
        // usage is the whole basis of knowing what a run cost.
        stream_options: { include_usage: true },
      },
    };
  },

  createParser() {
    // Tool calls arrive as fragments keyed by index: the name in one delta, the
    // arguments spread across many. They are only complete at finish_reason, so
    // they accumulate here and are emitted once.
    const pending = new Map();
    let emitted = false;

    const collect = () => {
      const calls = [...pending.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
        .filter((call) => call.function.name);
      pending.clear();
      return calls;
    };

    return {
      push(line) {
        // SSE framing: comments and non-data fields are keep-alives.
        if (!line.startsWith('data:')) return [];
        const payload = line.slice(5).trim();
        if (!payload) return [];
        if (payload === '[DONE]') {
          if (emitted) return [];
          emitted = true;
          const calls = collect();
          return calls.length ? [{ toolCalls: calls }] : [];
        }

        const chunk = JSON.parse(payload);
        if (chunk.error) return [{ error: String(chunk.error.message || chunk.error) }];

        const deltas = [];
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || {};

        // Reasoning models expose their thinking under different names; GLM and
        // DeepSeek use reasoning_content, others reasoning.
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (thinking) deltas.push({ thinking: String(thinking) });
        if (delta.content) deltas.push({ content: String(delta.content) });

        for (const fragment of delta.tool_calls || []) {
          const index = Number(fragment.index) || 0;
          const call = pending.get(index) || { id: '', name: '', arguments: '' };
          if (fragment.id) call.id = fragment.id;
          if (fragment.function?.name) call.name += fragment.function.name;
          if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
          pending.set(index, call);
        }

        if (choice?.finish_reason && !emitted) {
          emitted = true;
          const calls = collect();
          if (calls.length) deltas.push({ toolCalls: calls });
        }

        // Usage arrives in its own trailing chunk with no choices at all.
        if (chunk.usage) {
          deltas.push({
            stats: {
              promptTokens: chunk.usage.prompt_tokens || 0,
              evalTokens: chunk.usage.completion_tokens || 0,
              tokPerSec: 0,
              loadMs: 0,
              promptEvalMs: 0,
              generationMs: 0,
              totalMs: 0,
            },
          });
        }
        return deltas;
      },
    };
  },
};

const TRANSPORTS = { ollama: ollamaTransport, openai: openAITransport };

const PROVIDER_PATHS = Object.freeze({
  ollama: Object.freeze({
    chat: '/api/chat',
    models: '/api/tags',
    model: '/api/show',
    running: '/api/ps',
    version: '/api/version',
    generate: '/api/generate',
  }),
  openai: Object.freeze({
    chat: '/chat/completions',
    models: '/models',
  }),
});

function providerPath(provider, operation) {
  return PROVIDER_PATHS[String(provider || 'ollama')]?.[operation] || null;
}

// `redact` scrubs anything that must never be shown — the Brittain endpoint
// (docs/PLAN.md §5.2) — from the provider's body before it is excerpted.
function safeProviderError(status, body, { redact = (value) => value } = {}) {
  const code = Number(status) || 0;
  const text = String(redact(String(body || ''))).trim();
  if (/^(?:<!doctype\s+html|<html)\b/i.test(text)) {
    return `provider returned an HTML error page (${code}) — check endpoint base URL`;
  }
  const compact = text.replace(/\s+/g, ' ');
  const excerpt = compact.length > 200 ? compact.slice(0, 200) + '…' : compact;
  return `provider request failed (${code})${excerpt ? ` — ${excerpt}` : ''}`;
}

function transportFor(provider) {
  return TRANSPORTS[String(provider || 'ollama')] || ollamaTransport;
}

// Cloud tokens cost money, so a run's price is worth knowing rather than
// guessing. Rates are per million tokens and live in settings, because they
// change faster than any release cycle.
function estimateCost(stats, rates) {
  const input = Number(rates?.inputPerMillion) || 0;
  const output = Number(rates?.outputPerMillion) || 0;
  if (!input && !output) return 0;
  return ((Number(stats?.promptTokens) || 0) / 1e6) * input
    + ((Number(stats?.evalTokens) || 0) / 1e6) * output;
}

module.exports = {
  ollamaTransport,
  openAITransport,
  transportFor,
  providerPath,
  safeProviderError,
  estimateCost,
  toOpenAIMessages,
  toOllamaMessages,
  TRANSPORTS,
};
