// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- subagents ----------"
'use strict';

// run_subagent: a read-only scout with a context of its own. It gets one task,
// explores with read-only tools, and hands back a findings report — the only
// part of its work the lead agent ever sees.
//
// On a 32k model this is mostly about context, not speed: file contents a
// subagent reads never enter the lead conversation, so the lead can survey a
// codebase without compacting away what it already knew.
//
// Deviations from the source:
//   - The subagent runs on the lead's provider, with the `subagentModel`
//     setting or else the lead's own model (the source defaulted to a local
//     qwen3:8b scout, which brittain mode does not have).
//   - Its window is the model's effective context, not a 24k cap: the cap
//     spared a local machine's memory, and a hosted model has no such cost.
//   - At 85% of that window (or sooner, if a request could not fit the
//     reply) it stops exploring and goes straight to the report, with the
//     oldest results cut down to fit.
//   - Sensitive reads still ask the human, exactly as they do for the lead.
//   - The repeat and failure guards run on its calls as well.

const { estimateContextTokens } = require('../lib/context-estimator');
const { boundToolResult, toolResultLimit } = require('../lib/tool-result');
const { createRepeatTracker, createToolFailureTracker } = require('../lib/tool-failure');
const { SUBAGENT_TOOL_NAMES } = require('../lib/tools');
const { isSensitiveToolCall, unapprovedResult } = require('./approvals');
const { parseRawToolCalls } = require('./tool-call-parser');

const SUBAGENT_MAX_STEPS = 12;
const SUBAGENT_REPORT_CAP = 6000;   // chars of findings returned to the main agent
const SUBAGENT_TIMEOUT_MS = 240_000; // wall-clock cap — model swapping makes steps slow, but not infinite
const WRAP_UP_TIMEOUT_MS = 60_000;
// Past this share of its window the subagent stops exploring and reports, so
// the report is written with room to spare rather than squeezed in at the end.
const SUBAGENT_REPORT_AT = 0.85;

function subagentSystemPrompt(cwd) {
  return [
    'You are a fast research subagent inside Brittain Code, working for a lead agent.',
    `Working directory: ${cwd} — use paths relative to it.`,
    'You have read-only exploration tools. You cannot edit code, run shell commands, or ask the user questions.',
    '',
    'Strategy — follow this order:',
    '1. browse_files first to see what files exist.',
    '2. search_files with SHORT single-word patterns: search "history", never "chat history persistence logic". Multi-word phrases almost never match code.',
    '3. read_file the promising files and base your answer on what you actually read.',
    'If a search finds nothing, do not retry it with similar words — switch tactics (list the directory, read the most likely file).',
    `You have a budget of roughly ${SUBAGENT_MAX_STEPS} tool calls. Spend a few exploring, then STOP calling tools and write your report.`,
    '',
    'Your FINAL message is the only thing returned to the lead agent, so make it a complete findings report: cite file paths and line numbers, quote the relevant code, and answer every part of the task. If you cannot find something, say so explicitly rather than guessing.',
  ].join('\n');
}

const WRAP_UP = 'Your tool budget is exhausted. Write your complete findings report NOW, using only what you have already seen. Cite file paths and line numbers. If parts of the task are unanswered, say which.';

// Cut the oldest tool results down until the request fits. The newest results
// are what the report is most likely to rest on.
function shrinkToFit(msgs, budget) {
  const fitted = msgs.map((message) => ({ ...message }));
  for (const message of fitted) {
    if (estimateContextTokens(fitted) <= budget) break;
    if (message.role !== 'tool' || message.content.length <= 400) continue;
    message.content = `${message.content.slice(0, 300)}\n[… cut to fit the context window; ${message.content.length.toLocaleString()} characters in full]`;
  }
  return fitted;
}

function createSubagentRunner(rt, { safeExecute, hardInputFor }) {
  const sink = () => rt.sink;

  // Resolves with { result, stats } — stats summed over every model call, so
  // the lead's turn can count what the subagent cost.
  async function runSubagent({ task, leadModel, cwd, autoApprove }) {
    const model = rt.config.settings().subagentModel || leadModel;
    const contextLength = await rt.models.effectiveContext(model);
    const hardInput = hardInputFor(contextLength);
    // Whichever comes first: 85% of the window, or the most a request may
    // carry (on a 32k window that is already ~81%).
    const reportAt = Math.min(Math.floor(contextLength * SUBAGENT_REPORT_AT), hardInput);
    const resultLimit = toolResultLimit(contextLength);
    const tools = rt.prompts.subagentToolDefs();
    const toolTokens = estimateContextTokens(tools);
    const msgs = [
      { role: 'system', content: subagentSystemPrompt(cwd) },
      { role: 'user', content: task },
    ];
    // scouts should be fast: disable thinking where the model supports the flag
    const useThink = await rt.models.thinkValue(model, false);
    const temperature = rt.config.settings().codeTemperature;
    const toolFailures = createToolFailureTracker(2);
    const repeats = createRepeatTracker();
    const totals = { promptTokens: 0, evalTokens: 0 };
    const record = (stats) => {
      if (!stats) return;
      rt.state.recordUsage('main', stats);
      totals.promptTokens += stats.promptTokens || 0;
      totals.evalTokens += stats.evalTokens || 0;
    };
    let finalContent = '';
    let steps = 0;
    let note = '';
    // deadline for the whole subagent: aborts on user STOP or on timeout
    const signal = AbortSignal.any([rt.run.abort.signal, AbortSignal.timeout(SUBAGENT_TIMEOUT_MS)]);

    sink().emit('stream:subagent', { phase: 'start', task, model });
    rt.session.usage.metrics.subagentRuns = (rt.session.usage.metrics.subagentRuns || 0) + 1;
    try {
      for (let step = 0; step < SUBAGENT_MAX_STEPS; step++) {
        if (rt.run.stopRequested || signal.aborted) break;
        const used = estimateContextTokens(msgs) + toolTokens;
        if (used > reportAt) {
          note = `its context reached ${Math.round((used / contextLength) * 100)}% of the window`;
          break;
        }
        let { content, toolCalls, stats } = await rt.stream.streamChat(model, msgs, signal, useThink, true, contextLength, tools, { toolCallRetries: 0 }, temperature);
        record(stats);

        if (!toolCalls.length) {
          const recovered = parseRawToolCalls(content);
          if (recovered) {
            rt.session.usage.metrics.recoveredToolCalls += recovered.calls.length;
            toolCalls = recovered.calls;
            content = recovered.cleaned;
          }
        }
        if (content) finalContent = content;

        const assistantMsg = { role: 'assistant', content };
        if (toolCalls.length) {
          assistantMsg.tool_calls = toolCalls.map((call, index) => ({ ...call, id: call.id || `sub_${step}_${index}` }));
        }
        msgs.push(assistantMsg);
        if (!toolCalls.length) break;

        for (const tc of assistantMsg.tool_calls) {
          const name = tc.function?.name;
          let args = tc.function?.arguments || {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          if (!args || typeof args !== 'object') args = {};
          steps++;
          sink().emit('stream:subagent', { phase: 'tool', name, args });
          const result = await runTool(name, args, { cwd, autoApprove, toolFailures, repeats });
          rt.state.recordToolTelemetry(result, false);
          const bounded = boundToolResult(result, { toolName: name || 'tool', maxChars: resultLimit });
          msgs.push({ role: 'tool', tool_name: name, tool_call_id: tc.id, content: bounded.content });
        }
        // A report written alongside more tool calls is not the final one.
        finalContent = '';
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        if (rt.run.stopRequested) throw err; // user hit STOP — unwind the whole run
        note = 'it ran out of time';
        // timeout: fall through and salvage a report from what it saw
      } else if (err.name === 'PsychosisDetectedError') {
        note = `the live guard stopped it (${err.message})`;
      } else {
        finalContent = finalContent || `Subagent failed: ${rt.providers.redact(err.message || String(err))}`;
      }
    }

    // scout ran out of steps/time while still exploring — force a report from what it saw
    if (!finalContent && !rt.run.stopRequested) {
      try {
        const wrapUp = shrinkToFit([...msgs, { role: 'user', content: WRAP_UP }], hardInput);
        // fresh signal for the wrap-up: the main deadline may already be spent
        const wrapSignal = AbortSignal.any([rt.run.abort.signal, AbortSignal.timeout(WRAP_UP_TIMEOUT_MS)]);
        const wrap = await rt.stream.streamChat(model, wrapUp, wrapSignal, useThink, true, contextLength, null, { toolCallRetries: 0 }, temperature);
        record(wrap.stats);
        finalContent = wrap.content || '';
      } catch (err) {
        if (err.name === 'AbortError' && rt.run.stopRequested) throw err;
        finalContent = finalContent || '(subagent timed out before writing a report)';
      }
    }

    const report = (finalContent || '(subagent finished without producing findings)').slice(0, SUBAGENT_REPORT_CAP);
    sink().emit('stream:subagent', { phase: 'done', steps, ...(note ? { note } : {}) });
    const header = `Subagent report (${steps} tool ${steps === 1 ? 'call' : 'calls'}${note ? `; stopped early: ${note}` : ''}):`;
    return { result: `${header}\n${report}`, stats: totals };
  }

  async function runTool(name, args, { cwd, autoApprove, toolFailures, repeats }) {
    if (!SUBAGENT_TOOL_NAMES.has(name)) {
      return `Error: tool "${name}" is not available to subagents. Use your read-only exploration tools.`;
    }
    if (toolFailures.shouldBlock(name, args)) {
      return `Error: This exact ${name} call already failed twice. Use a different approach.`;
    }
    if (repeats.shouldBlock(name, args)) {
      return `Error: You already made this exact ${name} call twice and got the same result. Use what you have, or write your report.`;
    }
    let result;
    if (isSensitiveToolCall(name, args)) {
      // A secret read by a subagent is still a secret read: the human decides.
      const decision = await rt.approvalFlow.resolveToolCall(name, args, { autoApprove, promptKind: { sensitive: true } });
      result = decision.approved
        ? await safeExecute(name, args, cwd)
        : unapprovedResult(decision.verdict, 'The user denied this sensitive read. Do not retry it.');
    } else {
      result = await safeExecute(name, args, cwd);
    }
    toolFailures.record(name, args, result);
    repeats.record(name, args, result);
    return result;
  }

  return { runSubagent };
}

module.exports = {
  SUBAGENT_MAX_STEPS,
  SUBAGENT_REPORT_AT,
  SUBAGENT_REPORT_CAP,
  createSubagentRunner,
  subagentSystemPrompt,
};
