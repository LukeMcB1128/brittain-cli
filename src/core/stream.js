// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- streaming chat with ollama ----------"
'use strict';

// One streamed model call. Which protocol it speaks is decided by the active
// provider mode (docs/PLAN.md §5); the request shape and the response framing both
// differ, but everything below that — accumulation, degradation detection,
// what reaches the sink — is identical either way.

const {
  isToolCallParseError,
  withToolCallRetryInstruction,
  toolCallFailureMessage,
} = require('../lib/ollama-recovery');
const { safeProviderError } = require('../lib/inference');
const { LOGIN_HINT } = require('../lib/providers');
const { TOOL_DEFS } = require('../lib/tools');
const { PsychosisDetectedError, scanContentForPsychosis, scanThinkingForPsychosis } = require('./degradation');

// Deviation: a rejected key names the fix in one line (docs/PLAN.md §5.1) rather
// than surfacing the provider's raw 401 body.
function authFailure(provider) {
  if (provider.mode === 'brittain') {
    return provider.hasKey ? `The Brittain API rejected the saved key. ${LOGIN_HINT}` : `The Brittain API needs a key. ${LOGIN_HINT}`;
  }
  if (provider.mode === 'openai') {
    return `The provider rejected the request (no valid API key). Run \`brittain login --provider openai\`.`;
  }
  return 'The server refused the request (401/403).';
}

// A provider that refuses `repetition_penalty` names the field in its 400.
function rejectsRepetitionPenalty(status, body) {
  return status === 400 && /repetition_penalty/i.test(String(body || ''))
    && /unrecogni[sz]ed|unknown|not (?:permitted|allowed|supported)|extra (?:inputs|fields)|unexpected/i.test(String(body || ''));
}

function createStream(rt) {
  // Endpoints that refused `repetition_penalty` this process; they get
  // `frequency_penalty` instead, so a penalty is always sent.
  const frequencyOnly = new Set();

  async function streamChat(model, messages, signal, think, silent = false, numCtx = 8192, toolset = TOOL_DEFS, recovery = { toolCallRetries: 0 }, temperature = rt.config.settings().codeTemperature, maxTokens = 0) {
    const provider = rt.providers.resolve();
    const { transport } = provider;
    const penaltyKey = `${provider.mode}:${provider.endpoint}`;
    const { url, headers, body } = transport.request({
      endpoint: provider.endpoint,
      apiKey: provider.apiKey,
      extraHeaders: provider.extraHeaders,
      model,
      messages,
      tools: toolset || undefined, // null = no tools (forces a text answer)
      think,
      numCtx,
      temperature,
      keepAlive: rt.config.settings().keepAlive,
      maxTokens,
      repetitionPenalty: rt.config.settings().repetitionPenalty,
      penaltyStyle: frequencyOnly.has(penaltyKey) ? 'frequency' : 'repetition',
    });
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      const reason = err?.cause?.code || err?.cause?.message || err?.message || err;
      throw new Error(rt.providers.redact(`Cannot reach ${provider.mode === 'brittain' ? 'the Brittain API' : provider.endpoint} — ${reason}`));
    }
    if (!res.ok) {
      const errorBody = await res.text();
      if (res.status === 401 || res.status === 403) throw new Error(authFailure(provider));
      if (!frequencyOnly.has(penaltyKey) && rejectsRepetitionPenalty(res.status, errorBody)) {
        frequencyOnly.add(penaltyKey);
        rt.sink.info('This provider does not take repetition_penalty — using frequency_penalty instead.');
        return streamChat(model, messages, signal, think, silent, numCtx, toolset, recovery, temperature, maxTokens);
      }
      if (toolset && isToolCallParseError(res.status, errorBody)) {
        if ((recovery.toolCallRetries || 0) < 1) {
          rt.session.usage.metrics.toolCallRetries += 1;
          rt.sink.info(`Model ${model} emitted malformed tool JSON. Retrying once with strict formatting and THINK disabled…`);
          return streamChat(
            model,
            withToolCallRetryInstruction(messages),
            signal,
            think === undefined ? undefined : false,
            silent,
            numCtx,
            toolset,
            { toolCallRetries: 1 },
            temperature,
            maxTokens,
          );
        }
        throw new Error(toolCallFailureMessage(model));
      }
      throw new Error(safeProviderError(res.status, errorBody, { redact: rt.providers.redact }));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = transport.createParser();
    let buf = '';
    let content = '';
    let thinking = '';
    const toolCalls = [];
    let stats = null;
    const repetitionState = { value: 0 };
    const thinkingState = { value: 0 };
    const thinkingScan = { model, provider: provider.mode, contextLength: numCtx };

    // A reply already sitting in the buffer would otherwise be parsed to the
    // end after a stop; checking between lines stops within one chunk.
    const abortError = () => {
      const error = new Error('The run was stopped.');
      error.name = 'AbortError';
      return error;
    };

    const handleLine = async (line) => {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch {}
        throw abortError();
      }
      for (const delta of parser.push(line)) {
        if (delta.error) throw new Error(rt.providers.redact(delta.error));
        if (delta.thinking) {
          thinking += delta.thinking;
          const thinkHit = scanThinkingForPsychosis(thinking, thinkingState, thinkingScan);
          if (thinkHit) {
            try { await reader.cancel(); } catch {}
            throw new PsychosisDetectedError(thinkHit.reason, thinkHit.excerpt, thinkHit.recovery);
          }
          if (!silent) rt.sink.emit('stream:thinking', delta.thinking);
        }
        if (delta.content) {
          content += delta.content;
          const hit = scanContentForPsychosis(content, repetitionState);
          if (hit) {
            try { await reader.cancel(); } catch {}
            throw new PsychosisDetectedError(hit.reason, hit.excerpt, hit.recovery || 'compact');
          }
          if (!silent) rt.sink.token(delta.content);
        }
        if (delta.toolCalls) toolCalls.push(...delta.toolCalls);
        if (delta.stats) {
          stats = delta.stats;
          rt.models.recordModelSpeed(model, stats, numCtx);
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        await handleLine(line);
      }
    }
    // A stream that ends without a trailing newline still carries a last line.
    if (buf.trim()) await handleLine(buf.trim());
    return { content, thinking, toolCalls, stats };
  }

  // `details` returns what came back beside the text, for a caller that has to
  // explain an unusable answer (compaction records why it rejected a summary).
  async function completeText({ model, messages, signal, think, numCtx, temperature, maxTokens, usageBucket, details = false }) {
    const result = await streamChat(
      model,
      messages,
      signal,
      think,
      true,
      numCtx,
      null,
      { toolCallRetries: 0 },
      temperature,
      maxTokens,
    );
    if (usageBucket && result.stats) rt.state.recordUsage(usageBucket, result.stats);
    if (details) return { content: result.content.trim(), thinkingChars: (result.thinking || '').length, evalTokens: result.stats?.evalTokens || 0 };
    return result.content.trim();
  }

  return { completeText, streamChat };
}

module.exports = { createStream };
