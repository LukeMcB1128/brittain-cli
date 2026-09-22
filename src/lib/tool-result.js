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

module.exports = { MAX_TOOL_RESULT_CHARS, boundToolResult };
