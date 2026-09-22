// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- context inspector ----------"
'use strict';

// Reconstructs exactly what the NEXT request would send — the system prompt,
// the tool schemas, and every message as it will be sent — so "what did the
// model actually see?" is a ten-second glance instead of an hour of
// forensics. Read-only: never calls the model.
//
// Pruned: image-eviction flags, MCP tool counts, the excluded-tool-output flag,
// and Jev stored decisions. Added: formatContext() renders the result as text
// for /context.

const { estimateContextTokens } = require('../lib/context-estimator');
const { estimateTokens, modelReadyMessages } = require('./context-hygiene');

function createContextInspector(rt) {
  async function inspect({ model, cwd, mode } = {}) {
    try {
      const view = rt.session.view;
      const useModel = model || rt.providers.resolve().model;
      const useMode = mode || view.mode || 'code';
      const useCwd = useMode === 'chat' ? '' : (cwd || view.cwd || rt.config.cwd);
      const chatMode = useMode === 'chat';
      const prompt = rt.prompts.promptFor(useMode, useCwd, useModel);
      const conversation = rt.session.conversation;
      const ready = modelReadyMessages(conversation);
      const contextLength = useModel ? await rt.models.effectiveContext(useModel) : 0;

      const rows = ready.map((msg, index) => {
        const original = conversation[index];
        const flags = [];
        if (msg.role === 'tool' && String(msg.content || '').length > 1500) flags.push('large tool output');
        if (original?.pinned) flags.push('pinned');
        if (original?.meta === 'compaction') flags.push('compaction');
        if (original?.meta === 'nudge') flags.push('nudge');
        return {
          index,
          role: msg.role,
          toolName: msg.tool_name || null,
          toolCalls: msg.tool_calls || null,
          content: typeof msg.content === 'string' ? msg.content : String(original?.content ?? ''),
          pinned: !!original?.pinned,
          tokens: estimateContextTokens(msg),
          preview: String(msg.content || '').replace(/\s+/g, ' ').slice(0, 140),
          flags,
        };
      });

      const systemTokens = estimateTokens({ role: 'system', content: prompt });
      // Tool schemas are part of every request and are usually the largest
      // single component in code mode, so they belong in the total.
      const toolDefs = rt.prompts.activeToolDefs(chatMode);
      const tools = toolDefs.map((def) => ({
        name: def.function.name,
        description: def.function.description,
        tokens: estimateTokens(def),
      }));
      const toolTokens = toolDefs.length ? estimateTokens(toolDefs) : 0;
      const totalTokens = systemTokens + toolTokens + rows.reduce((sum, r) => sum + r.tokens, 0);

      return {
        ok: true,
        model: useModel || '',
        mode: useMode,
        cwd: useCwd,
        systemPrompt: prompt,
        systemTokens,
        toolTokens,
        toolCount: toolDefs.length,
        tools,
        rows,
        totalTokens,
        contextLength,
        percentUsed: contextLength ? Math.round((totalTokens / contextLength) * 100) : 0,
        messageCount: ready.length,
        pinnedFiles: [...(rt.session.contextState.pinnedFiles || [])],
      };
    } catch (err) {
      return { ok: false, error: rt.providers.redact(String(err.message || err)) };
    }
  }

  return { inspect };
}

function formatContext(result, { style = { dim: (t) => t, bold: (t) => t } } = {}) {
  if (!result?.ok) return result?.error || 'Context unavailable.';
  const n = (value) => Number(value || 0).toLocaleString();
  const lines = [
    style.bold(`Context: ${n(result.totalTokens)} of ${n(result.contextLength)} tokens (${result.percentUsed}%)`) + style.dim(` · ${result.mode} · ${result.model}`),
    `  system prompt   ${n(result.systemTokens).padStart(8)}`,
    `  tools (${result.toolCount})${' '.repeat(Math.max(1, 8 - String(result.toolCount).length))}${n(result.toolTokens).padStart(8)}`,
    `  messages (${result.messageCount})${' '.repeat(Math.max(1, 5 - String(result.messageCount).length))}${n(result.rows.reduce((sum, row) => sum + row.tokens, 0)).padStart(8)}`,
  ];
  if (result.pinnedFiles.length) lines.push(style.dim(`  pinned files: ${result.pinnedFiles.join(', ')}`));
  if (result.rows.length) lines.push('');
  for (const row of result.rows) {
    const label = row.role === 'tool' ? `tool:${row.toolName || '?'}` : row.role;
    const calls = row.toolCalls?.length ? ` → ${row.toolCalls.map((call) => call.function?.name).join(', ')}` : '';
    const flags = row.flags.length ? style.dim(` [${row.flags.join(', ')}]`) : '';
    lines.push(`  ${String(row.index + 1).padStart(3)} ${label.padEnd(18)} ${n(row.tokens).padStart(7)}  ${style.dim(row.preview.slice(0, 60))}${calls}${flags}`);
  }
  return lines.join('\n');
}

module.exports = { createContextInspector, formatContext };
