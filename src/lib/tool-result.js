// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/tool-result.js
'use strict';

// A tool result becomes part of every later model request. A single large
// command output can be larger than the complete context window, so keep a
// useful start and end while the full result remains available to the event.
//
// Pruned: the browser-evaluation guard (browser tools are not in v1).
const MAX_TOOL_RESULT_CHARS = 32_000;

function boundToolResult(value, { maxChars = MAX_TOOL_RESULT_CHARS, toolName = 'tool' } = {}) {
  const text = String(value ?? '');
  const limit = Math.max(200, Number(maxChars) || MAX_TOOL_RESULT_CHARS);
  if (text.length <= limit) {
    return { content: text, truncated: false, originalChars: text.length, omittedChars: 0 };
  }

  const omittedChars = text.length - limit;
  const notice = `\n\n[${toolName} result shortened: approximately ${omittedChars.toLocaleString()} characters omitted. Use a narrower query or a targeted search.]\n\n`;
  if (notice.length >= limit) {
    return { content: notice.slice(0, limit), truncated: true, originalChars: text.length, omittedChars };
  }

  const available = limit - notice.length;
  const headChars = Math.ceil(available * 0.6);
  const tailChars = available - headChars;
  return {
    content: text.slice(0, headChars) + notice + text.slice(text.length - tailChars),
    truncated: true,
    originalChars: text.length,
    omittedChars: text.length - headChars - tailChars,
  };
}

// CLI addition. Every tool result is re-sent with each later request in the
// turn, so on a small window one result can crowd out the rest: at 32,000
// characters, a single file read was a quarter of a 32k model's window. Allow
// about an eighth of the window instead, never more than the fixed ceiling and
// never less than 4,000 characters.
const MIN_TOOL_RESULT_CHARS = 4_000;

function toolResultLimit(contextLength) {
  const tokens = Number(contextLength) || 0;
  if (tokens <= 0) return MAX_TOOL_RESULT_CHARS;
  return Math.max(MIN_TOOL_RESULT_CHARS, Math.min(MAX_TOOL_RESULT_CHARS, Math.floor(tokens / 8) * 4));
}

module.exports = { MAX_TOOL_RESULT_CHARS, MIN_TOOL_RESULT_CHARS, boundToolResult, toolResultLimit };
