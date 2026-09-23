// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- agent loop ----------" (prepareAgentMessages, runAgentTurn)
'use strict';

// One full agent turn: stream → tools → repeat until the model stops calling
// tools or a cap is hit.
//
// Pruned: the tool index and schema reveals, MCP, online research, run_subagent,
// browser evaluation guards, rendered PDF pages, parked-call suspension, the
// orchestration run log, Jev context views, and the deliberation-loop
// directive (the detector that raised it is not in v1).

const { parseRawToolCalls } = require('./tool-call-parser');
const { modelReadyMessages, estimateTokens } = require('./context-hygiene');
const { unapprovedResult, isSensitiveToolCall } = require('./approvals');
const { estimateContextTokens } = require('../lib/context-estimator');
const { callSignature, createToolFailureTracker } = require('../lib/tool-failure');
const { boundToolResult, toolResultLimit } = require('../lib/tool-result');
const { outcomeOf } = require('../lib/ledger');
const { costOf, addTurn: addCostTurn, describeTurn: describeTurnCost, describeTotals: describeCostTotals } = require('../lib/cost');
const { RISKY_TOOLS, DESTRUCTIVE_TOOLS, isDestructiveCommand } = require('../lib/tools');
const { MISSING_QUESTIONS, answersResult, normalizeQuestions } = require('../lib/tools/interact');

// CLI addition. The failure tracker only stops a call that keeps failing; a
// model can also loop on calls that succeed — one session ran the same `open`
// and the same `curl | grep` eight times each, pasting the same paragraph
// between them. A call that already returned the same result twice this turn
// is not run a third time. A successful edit resets it: after a change,
// running the same check again is the point.
const REPEAT_LIMIT = 2;
function createRepeatTracker(limit = REPEAT_LIMIT) {
  const seen = new Map();
  return {
    shouldBlock(name, args) {
      return (seen.get(callSignature(name, args))?.count || 0) >= limit;
    },
    record(name, args, result) {
      if (RISKY_TOOLS.has(name) && name !== 'run_command' && !/^\s*Error:/i.test(String(result || ''))) {
        seen.clear();
        return;
      }
      const signature = callSignature(name, args);
      const last = seen.get(signature);
      const text = String(result || '');
      seen.set(signature, { result: text, count: last && last.result === text ? last.count + 1 : 1 });
    },
  };
}

const MAX_AGENT_STEPS = 50; // safety cap on tool-call loops per user message

function preview(s) {
  s = String(s);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

// How many steps before the cap the model is told to start wrapping up.
function wrapUpWarningSteps(maxAgentSteps) {
  return Math.min(5, Math.max(1, Math.floor(maxAgentSteps / 5)));
}

function responseReserve(contextLength) {
  return Math.min(4096, Math.max(1024, Math.floor(contextLength * 0.125)));
}

function contextSafetyMargin(contextLength) {
  return Math.min(2048, Math.max(512, Math.floor(contextLength * 0.0625)));
}

function createAgentLoop(rt) {
  const sink = () => rt.sink;
  const conversation = () => rt.session.conversation;

  async function safeExecute(name, args, cwd) {
    try {
      return await rt.tools.executeTool(name, args, cwd);
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  function shouldAutoCompact(used, limit) {
    const settings = rt.config.settings();
    return settings.autoCompact && !!limit && used > settings.compactThreshold * limit;
  }

  function compactPercent() {
    return Math.round(rt.config.settings().compactThreshold * 100);
  }

  function prepareAgentMessages({ prompt, agentTools, contextLength }) {
    const system = { role: 'system', content: prompt };
    const hardInput = Math.max(2048, contextLength - responseReserve(contextLength) - contextSafetyMargin(contextLength));
    const messages = [system, ...modelReadyMessages(conversation())];
    return {
      messages,
      maxTokens: 0,
      estimatedTokens: estimateContextTokens(messages) + estimateTokens(agentTools || []),
      hardInput,
    };
  }

  // CLI addition: never send a request the model cannot take. The source
  // computed hardInput and left it to Jev; without Jev an oversized request
  // went out and came back as a provider 400 mid-turn. Compact once, then
  // refuse with a message that says what to do.
  async function fitRequest({ model, prompt, agentTools, contextLength }) {
    let prepared = prepareAgentMessages({ prompt, agentTools, contextLength });
    if (prepared.estimatedTokens <= prepared.hardInput) return prepared;
    const n = (value) => Number(value || 0).toLocaleString();
    sink().info(`The next request is about ${n(prepared.estimatedTokens)} tokens, more than the ${n(prepared.hardInput)} this model can take — compacting first…`);
    sink().state('compacting');
    const c = await rt.compaction.compactConversation(model);
    if (c.ok) {
      sink().emit('stream:stats', { contextTokens: c.approxTokens, contextLength: c.contextLength, tokPerSec: 0, scope: 'conversation' });
      sink().info(`Compacted: ${c.description}`);
    }
    prepared = prepareAgentMessages({ prompt, agentTools, contextLength });
    if (prepared.estimatedTokens <= prepared.hardInput) return prepared;
    throw new Error(`This request is about ${n(prepared.estimatedTokens)} tokens and the model's ${n(contextLength)}-token window leaves room for ${n(prepared.hardInput)}. `
      + (c.ok ? 'Compacting did not free enough room. ' : `Compaction failed: ${c.error} `)
      + 'Start a new chat with /clear, or switch to a model with a larger window.');
  }

  // Resolves one tool call and returns its result text. Every branch emits
  // exactly one stream:toolresult.
  async function resolveCall({ name, args, cwd, autoApprove, activeToolNames, toolFailures, repeats, failureDirectives }) {
    const emit = (result, denied) => sink().emit('stream:toolresult', { name, result: preview(result), ...(denied ? { denied: true } : {}) });
    const approveThenRun = async (promptKind, deniedText, label) => {
      const decision = await rt.approvalFlow.resolveToolCall(name, args, { autoApprove, promptKind });
      if (!decision.approved) {
        const result = decision.repeatDenied
          ? `The user denied this exact ${name} call earlier in this turn. Do not ask for it again; continue without it, or ask the user what they want instead.`
          : unapprovedResult(decision.verdict, deniedText);
        sink().emit('stream:toolresult', { name, result: `(${label} ${decision.verdict === 'deny' ? 'not permitted' : 'denied by user'})`, denied: true });
        return result;
      }
      const result = await safeExecute(name, args, cwd);
      emit(result);
      return result;
    };

    if (toolFailures.shouldBlock(name, args)) {
      const result = `Error: This exact ${name || 'tool'} call already failed twice, so Brittain did not run it again. Use a different approach.`;
      failureDirectives.add(name || 'tool');
      emit(result, true);
      return { result, repeatedCallBlocked: true };
    }
    if (repeats.shouldBlock(name, args)) {
      const result = `Error: You already made this exact ${name || 'tool'} call twice in this turn and got the same result both times, so Brittain did not run it again. Use the result you already have. If you are stuck, try a different approach, or use ask_user to ask the user for what you cannot see yourself.`;
      failureDirectives.add(name || 'tool');
      emit(result, true);
      return { result, repeatedCallBlocked: true };
    }
    if (!activeToolNames.has(name)) {
      const result = `Error: Tool unavailable for this turn: ${name}. Continue without it.`;
      emit(result, true);
      return { result };
    }
    if (rt.run.stopRequested) return { result: 'Cancelled by user.' };
    if (name === 'ask_user') {
      const questions = normalizeQuestions(args);
      const result = questions.length
        ? answersResult(questions, await rt.questionFlow.requestAnswer({ questions }))
        : MISSING_QUESTIONS;
      emit(result);
      return { result };
    }
    if (DESTRUCTIVE_TOOLS.has(name)) {
      return { result: await approveThenRun({ destructive: true }, 'The user denied this destructive operation. Do not retry it unless the user explicitly asks.', 'destructive operation') };
    }
    if (name === 'run_command' && isDestructiveCommand(args.command)) {
      // destructive shell patterns are never automatic, whatever the policy says
      return { result: await approveThenRun({ destructive: true }, 'The user denied this destructive command. Do not retry it or any variation of it unless the user explicitly asks.', 'destructive command') };
    }
    if (isSensitiveToolCall(name, args)) {
      return { result: await approveThenRun({ sensitive: true }, 'The user denied this sensitive read. Do not retry it unless the user explicitly asks.', 'sensitive read') };
    }
    if (name === 'apply_patch' && args.dry_run !== false) {
      const result = await safeExecute(name, args, cwd);
      emit(result);
      return { result };
    }
    if (RISKY_TOOLS.has(name)) {
      return { result: await approveThenRun({}, 'The user denied this tool call. Ask before retrying, or try another approach.', 'call') };
    }
    const result = await safeExecute(name, args, cwd);
    emit(result);
    return { result };
  }

  async function runAgentTurn({ model, cwd, autoApprove, think }) {
    const signal = rt.run.abort.signal;
    const prompt = rt.prompts.systemPrompt(cwd, model);
    const messages = () => [{ role: 'system', content: prompt }, ...modelReadyMessages(conversation())];
    // report the window we actually run with, not the model's theoretical max
    const contextLength = await rt.models.effectiveContext(model);
    const agentTools = rt.prompts.activeToolDefs();
    const activeToolNames = new Set(agentTools.map((definition) => definition.function.name));
    // For models that support thinking, always send an explicit true/false —
    // omitting the param makes Ollama think by default, ignoring the toggle.
    const useThink = await rt.models.thinkValue(model, think);
    let lastContent = '';
    let emptyNudges = 0;
    // A turn is one user message, however many model calls the tool loop makes.
    // Cost is summed across all of them and reported once, because that is the
    // unit a person recognises as "what that question cost me".
    const turnTokens = { promptTokens: 0, evalTokens: 0 };
    const toolFailures = createToolFailureTracker(2);
    const repeats = createRepeatTracker();
    let lastStats = null;
    let exhaustedWithToolCalls = false;
    let deniedCalls = 0;
    const settings = rt.config.settings();
    const maxAgentSteps = settings.maxAgentSteps || MAX_AGENT_STEPS;
    const temperature = settings.codeTemperature;
    rt.approvalFlow.beginTurn();

    const resultLimit = toolResultLimit(contextLength);

    let psychosisRetried = false;
    for (let step = 0; step < maxAgentSteps; step++) {
      let content, thinking, toolCalls, stats;
      try {
        const prepared = await fitRequest({ model, prompt, agentTools, contextLength });
        ({ content, thinking, toolCalls, stats } = await rt.stream.streamChat(model, prepared.messages, signal, useThink, false, contextLength, agentTools, { toolCallRetries: 0 }, temperature, prepared.maxTokens));
      } catch (err) {
        if (err.name !== 'PsychosisDetectedError') throw err;
        rt.session.usage.metrics.psychosisDetections += 1;
        sink().info(`⚠ LIVE GUARD: ${err.message} — excerpt: "${err.excerpt}"\nGeneration stopped immediately.`);
        if (psychosisRetried) {
          sink().info('Detected again after recovery — stopping this turn. Consider switching models or starting a new session.');
          break;
        }
        psychosisRetried = true;
        sink().state('auto-compacting (recovering)…');
        const c = await rt.compaction.compactConversation(model);
        if (!c.ok) {
          // Nothing to compact means there is no accumulated context — and a
          // conversation with no context cannot have lost the task from it. The
          // detection was wrong, so carry on rather than killing a turn that
          // had barely started.
          if (/nothing to compact/i.test(c.error || '')) {
            sink().info('Ignoring that detection — there is no earlier context it could have lost.');
            continue;
          }
          sink().info('Recovery compact failed (' + c.error + ') — stopping this turn.');
          break;
        }
        sink().emit('stream:stats', { contextTokens: c.approxTokens, contextLength: c.contextLength, tokPerSec: 0, scope: 'conversation' });
        sink().info(`Context compacted (${c.description}) — retrying this turn once.`);
        continue;
      }

      // rescue tool calls the model emitted as raw text (qwen3-coder quirk)
      if (!toolCalls.length) {
        const recovered = parseRawToolCalls(content);
        if (recovered) {
          rt.session.usage.metrics.recoveredToolCalls += recovered.calls.length;
          toolCalls = recovered.calls;
          content = recovered.cleaned;
          // the raw markup already streamed — replace it with the cleaned text
          sink().emit('stream:cleancontent', content);
        }
      }

      if (stats) {
        rt.state.recordUsage('main', stats);
        rt.state.publishContextStats(stats, contextLength);
        turnTokens.promptTokens += stats.promptTokens || 0;
        turnTokens.evalTokens += stats.evalTokens || 0;
      }

      if (toolCalls.length) {
        toolCalls = toolCalls.map((call, index) => ({
          ...call,
          id: call.id || `call_${rt.session.id}_${conversation().length}_${index}`.replace(/[^A-Za-z0-9_-]/g, '_'),
        }));
      }
      const assistantMsg = { role: 'assistant', content };
      if (thinking) assistantMsg.thinking = thinking;
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      exhaustedWithToolCalls = toolCalls.length > 0;
      conversation().push(assistantMsg);
      // Save complete messages, not token fragments, so a long tool loop
      // survives a crash without waiting for the final answer.
      await rt.chatJobs.persistActive();
      // One event per completed assistant message, carrying the model's own
      // words and nothing else.
      if (content && content.trim()) sink().emit('stream:message', content.trim());
      if (content) lastContent = content;
      if (stats) lastStats = stats;

      if (rt.run.stopRequested) break;
      if (!toolCalls.length) {
        // Thinking models sometimes emit EOS right after their reasoning —
        // no content, no tool call. Don't mistake a stall for completion:
        // nudge up to twice, visibly, then give up honestly.
        const stalled = !content || !content.trim();
        if (stalled && emptyNudges < 2) {
          emptyNudges++;
          sink().info(`Model stopped without output or a tool call — nudging it to continue (${emptyNudges}/2)…`);
          conversation().push({
            role: 'user',
            // Written by the loop, not by a person. Marked so the transcript
            // does not later replay it as something the user said.
            meta: 'nudge',
            content: 'You stopped without any visible output or tool call. Continue the task now: make your next tool call, or write your final summary if the task is complete.',
          });
          continue;
        }
        if (stalled) {
          sink().info('Model produced no output after 2 nudges — giving up on this turn. Send a message to continue.');
        }
        break;
      }

      const failureDirectives = new Set();
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        if (!args || typeof args !== 'object') args = {};

        sink().toolCall({ name, args });
        const { result, repeatedCallBlocked } = await resolveCall({
          name, args, cwd, autoApprove, activeToolNames, toolFailures, repeats, failureDirectives,
        });

        // Match the denial sentences rather than a UI label, or every denial
        // would count as a success and denied writes would be ledgered.
        const toolOutcome = outcomeOf(result);
        if (toolOutcome === 'denied') deniedCalls += 1;
        rt.state.recordToolTelemetry(result, toolOutcome === 'denied');
        if (!repeatedCallBlocked) {
          const failure = toolFailures.record(name, args, result);
          if (failure.reachedLimit) failureDirectives.add(name || 'tool');
          repeats.record(name, args, result);
        }
        const bounded = boundToolResult(result, { toolName: name || 'tool', maxChars: resultLimit });
        if (bounded.truncated) {
          sink().info(`Tool result from "${name}" was ${bounded.originalChars.toLocaleString()} characters. Kept a ${bounded.content.length.toLocaleString()}-character excerpt in model context.`);
        }
        conversation().push({ role: 'tool', tool_name: name, tool_call_id: tc.id, content: bounded.content });
      }
      await rt.chatJobs.persistActive();
      if (failureDirectives.size) {
        conversation().push({
          role: 'user',
          meta: 'nudge',
          content: `These tool calls have failed twice, or were blocked for repeating: ${[...failureDirectives].join(', ')}. Do not repeat the same call. Use a different approach, or explain the blocker and ask one focused question.`,
        });
      }
      // CLI addition: a model that keeps exploring used to run into the cap
      // with nothing written. Say how much room is left before it runs out.
      const remaining = maxAgentSteps - (step + 1);
      if (remaining === wrapUpWarningSteps(maxAgentSteps)) {
        conversation().push({
          role: 'user',
          meta: 'nudge',
          content: `You have ${remaining} model ${remaining === 1 ? 'call' : 'calls'} left for this request. Stop exploring: use them only for what is essential, then write your answer.`,
        });
      }
      rt.state.emitPersistedConversationContext(model, contextLength);
      if (rt.run.stopRequested) break;

      // Auto-compaction protects generation quality before the window
      // overflows (glitch tokens, thought-leak into files), so this is a
      // quality guard, not just a size guard.
      if (contextLength) {
        const measured = lastStats ? lastStats.promptTokens + lastStats.evalTokens : 0;
        // The last model statistics do not include tool results that arrived
        // after generation. Estimate the request as it exists now, including
        // tool definitions, so compaction runs before the next model call.
        const estimatedNow = estimateContextTokens(messages()) + estimateTokens(agentTools);
        const used = Math.max(measured, estimatedNow);
        if (shouldAutoCompact(used, contextLength)) {
          sink().info(`Context past ${compactPercent()}% — auto-compacting…`);
          sink().state('compacting');
          const c = await rt.compaction.compactConversation(model);
          if (c.ok) {
            sink().emit('stream:stats', { contextTokens: c.approxTokens, contextLength: c.contextLength, tokPerSec: 0, scope: 'conversation' });
            sink().info(`Compacted: ${c.description}`);
          } else {
            sink().info('Auto-compact failed (' + c.error + ') — continuing.');
          }
        }
      }
    }
    if (exhaustedWithToolCalls && !rt.run.stopRequested) {
      // CLI addition: the source stopped here, which left a long exploration
      // with no answer at all. Ask once more with tools switched off, so the
      // model has to answer from what it found.
      sink().info(`Agent reached the ${maxAgentSteps}-step safety cap — asking for a final answer without tools.`);
      conversation().push({
        role: 'user',
        meta: 'nudge',
        content: `You have used all ${maxAgentSteps} steps for this request and cannot call any more tools. Answer the user's request now from what you have found. Say plainly what you did not get to check.`,
      });
      try {
        const prepared = await fitRequest({ model, prompt, agentTools: [], contextLength });
        const final = await rt.stream.streamChat(model, prepared.messages, signal, useThink, false, contextLength, null, { toolCallRetries: 0 }, temperature, prepared.maxTokens);
        if (final.stats) {
          rt.state.recordUsage('main', final.stats);
          rt.state.publishContextStats(final.stats, contextLength);
          turnTokens.promptTokens += final.stats.promptTokens || 0;
          turnTokens.evalTokens += final.stats.evalTokens || 0;
          lastStats = final.stats;
        }
        const finalMsg = { role: 'assistant', content: final.content };
        if (final.thinking) finalMsg.thinking = final.thinking;
        conversation().push(finalMsg);
        await rt.chatJobs.persistActive();
        if (final.content && final.content.trim()) {
          sink().emit('stream:message', final.content.trim());
          lastContent = final.content;
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        sink().info(`The final answer failed (${rt.providers.redact(err.message || String(err))}). Ask "what did you find?" to get a summary.`);
      }
    }
    // What that message cost, reported once at the end of the turn. Only when
    // the provider is not local: a local model has no bill, and inventing a
    // line saying so would be noise on every single turn.
    if (rt.providers.resolve().mode !== 'ollama' && (turnTokens.promptTokens || turnTokens.evalTokens)) {
      const cost = costOf(turnTokens, rt.models.ratesForModel(model));
      rt.session.spend = addCostTurn(rt.session.spend, { cost, ...turnTokens });
      sink().emit('stream:cost', {
        text: describeTurnCost({ cost, ...turnTokens }),
        cost,
        ...turnTokens,
        sessionText: describeCostTotals(rt.session.spend),
      });
    }

    return { lastContent, lastStats, contextLength, deniedCalls };
  }

  return { runAgentTurn, shouldAutoCompact, compactPercent };
}

module.exports = { MAX_AGENT_STEPS, createAgentLoop, preview };
