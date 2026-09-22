// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- fallback tool-call parser ----------"
'use strict';

// Some models (seen with qwen3-coder) occasionally emit their native tool-call
// markup as plain text instead of a structured call, e.g.:
//   <tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.js\n</parameter>\n</function>\n</tool_call>
// often truncated or missing wrapper tags. When Ollama parses nothing, this
// recovers those calls from the raw text so the agent loop can still run them.
function coerceParamValue(v) {
  return /^(true|false|null|-?\d+(\.\d+)?)$/.test(v) ? JSON.parse(v) : v;
}

function parseRawToolCalls(content) {
  if (!content.includes('<function=')) return null;
  const calls = [];
  const fnRe = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
  let m;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[1];
    const args = {};
    // closed parameters
    const rest = m[2].replace(/<parameter=([\w.-]+)>\r?\n?([\s\S]*?)\r?\n?<\/parameter>/g, (_all, k, v) => {
      args[k] = coerceParamValue(v);
      return '';
    });
    // a trailing unclosed parameter (truncated output)
    const open = rest.match(/<parameter=([\w.-]+)>\r?\n?([\s\S]*)/);
    if (open) {
      const v = open[2].replace(/<[^>]*$/, '').trim();
      if (v) args[open[1]] = coerceParamValue(v);
    }
    calls.push({ function: { name, arguments: args } });
  }
  if (!calls.length) return null;
  const cleaned = content
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<function=[\s\S]*?(?:<\/function>|$)/g, '')
    .replace(/<\/?(tool_call|function|parameter)[^>]*>/g, '')
    .trim();
  return { calls, cleaned };
}

module.exports = { coerceParamValue, parseRawToolCalls };
