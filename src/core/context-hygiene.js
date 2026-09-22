// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- context hygiene ----------"
'use strict';

// Oversized input does NOT error: Ollama context-shifts, silently discarding
// the oldest tokens (seen live: 174k evaluated through a 65k window). These
// helpers keep what we send inside the window so the model never loses the
// system prompt without us knowing.
//
// Pruned: stripOldImages (attachments), Jev stored decisions, and the
// user-excluded tool result placeholder (the inspector UI that set it).

const { boundToolResult } = require('../lib/tool-result');

const estimateTokens = (value) => Math.round(JSON.stringify(value).length / 4);

// Fields the conversation carries for the CLI's own use, never for the model.
function modelReadyMessages(msgs) {
  return (Array.isArray(msgs) ? msgs : []).map(({ displayContent, pinned, compactionRecord, meta, ...message }) => {
    // Old saved conversations can contain tool results from before the limit
    // existed. Bound them at the inference boundary as a second line of
    // defense, without changing what the user sees in saved history.
    if (message.role === 'tool') {
      const bounded = boundToolResult(message.content, { toolName: message.tool_name || 'tool' });
      if (bounded.truncated) return { ...message, content: bounded.content };
    }
    return message;
  });
}

// Drop oldest messages until the set fits the budget (used for the summarizer
// call, which would otherwise context-shift while trying to fix context-shifting).
function fitToWindow(msgs, maxTokens) {
  if (estimateTokens(msgs) <= maxTokens) return msgs;
  const kept = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const cost = estimateTokens(msgs[i]);
    if (total + cost > maxTokens && kept.length) break;
    kept.unshift(msgs[i]);
    total += cost;
  }
  kept.unshift({ role: 'user', content: '[Earlier conversation omitted — it no longer fit the context window.]' });
  return kept;
}

module.exports = { estimateTokens, fitToWindow, modelReadyMessages };
