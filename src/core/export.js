// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- chat export ----------"
'use strict';

// A chat as Markdown. The app asked where to save through a dialog; the CLI
// takes a path (default: chat-YYYY-MM-DD.md in the working directory).
//
// Pruned: attachment lists.

const fs = require('fs');
const path = require('path');

function chatToMarkdown(conversation) {
  const parts = [];
  for (const m of conversation) {
    if (m.meta === 'nudge') continue;
    if (m.role === 'user') {
      parts.push((m.meta === 'compaction' ? '## Compaction\n\n' : '## You\n\n') + (m.displayContent || m.content));
    } else if (m.role === 'assistant') {
      if (m.thinking) parts.push('<details><summary>Thinking</summary>\n\n' + m.thinking + '\n\n</details>');
      if (m.content) parts.push('## Model\n\n' + m.content);
      for (const tc of m.tool_calls || []) {
        const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {});
        parts.push('**Tool call:** `' + (tc.function?.name || '?') + '` — `' + args.slice(0, 300) + '`');
      }
    } else if (m.role === 'tool') {
      parts.push('<details><summary>Tool result: ' + (m.tool_name || '') + '</summary>\n\n```\n' + String(m.content).slice(0, 4000) + '\n```\n\n</details>');
    }
  }
  return parts.join('\n\n') + '\n';
}

function createExport(rt) {
  function exportChat({ path: requested } = {}) {
    const conversation = rt.session.conversation;
    if (!conversation.length) return { ok: false, error: 'Nothing to export.' };
    const target = path.resolve(rt.config.cwd, requested || `chat-${new Date().toISOString().slice(0, 10)}.md`);
    if (fs.existsSync(target)) return { ok: false, error: `${target} already exists — give /export another path.` };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, chatToMarkdown(conversation), 'utf8');
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }

  return { exportChat };
}

module.exports = { chatToMarkdown, createExport };
