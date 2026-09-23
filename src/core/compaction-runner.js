// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- conversation compaction ----------" (compactConversation, and maybePrecompact from the chat job section)
'use strict';

// Native compaction only (PLAN.md §6.2): the Jev path is not in v1.
//
// Pruned: the Jev branch, image-aware measurement (there are no images), and
// the project-check count in the ledger total (run_project_check is not in
// v1).
//
// Added: when the current turn alone is larger than the tail budget, the tail
// is taken inside it — the request plus its newest complete steps (see
// selectTurnTail in lib/compaction.js). In the app, Jev pruned tool results
// within a turn for Brittain 4; without it, one long turn on a 32k model left
// compaction nothing it was allowed to keep.

const { estimateContextTokens } = require('../lib/context-estimator');
const { pinnedMessagesPrompt } = require('../lib/context-controls');
const { buildLedger, renderLedger, isEmptyLedger } = require('../lib/ledger');
const {
  retainedBudget,
  tailBudget,
  summaryBudget,
  selectVerbatimTail,
  selectTurnTail,
  minimumSummaryTokens,
  validateSummary,
  retryInstruction,
  summaryInstruction,
  planChunks,
  chunkInstruction,
  reduceInstruction,
  priorRecordPreamble,
  describeCompaction,
} = require('../lib/compaction');
const { estimateTokens, fitToWindow, modelReadyMessages } = require('./context-hygiene');

const SUMMARIZER_RESULT_CHARS = 3000;

function createCompactionRunner(rt) {
  const sink = () => rt.sink;

  async function compactConversation(model, signal = rt.run.abort?.signal) {
    const conversation = rt.session.conversation;
    if (conversation.length < 2) return { ok: false, error: 'Nothing to compact yet.' };
    try {
      const contextLength = await rt.models.effectiveContext(model);
      const before = rt.state.currentConversationTokens(model);

      const pinnedConversation = conversation
        .filter((message) => message?.pinned && (message.role === 'user' || message.role === 'assistant'))
        .map(({ tool_calls, ...message }) => ({ ...message }));
      const unpinnedConversation = conversation.filter((message) => !message?.pinned);
      const pinnedContext = pinnedMessagesPrompt(pinnedConversation);
      const pinnedReady = pinnedContext ? [{ role: 'user', content: pinnedContext }] : [];
      const pinnedCost = estimateTokens(pinnedReady);

      // Measure candidates as they would be SENT, not as they are stored.
      const sendableTokens = (messages) => estimateContextTokens(modelReadyMessages(messages));

      // Keep the most recent complete turns verbatim. They are the most
      // relevant part of the conversation and the cheapest fidelity
      // available, and the summarizer is then only responsible for what came
      // before them. When not even the current turn fits, keep its request
      // and newest steps instead.
      const chooseTail = (budget) => {
        const turns = selectVerbatimTail(unpinnedConversation, budget, sendableTokens);
        if (turns.tail.length) return { ...turns, summarize: turns.head, steps: 0, inTurn: false };
        const inTurn = selectTurnTail(unpinnedConversation, budget, sendableTokens);
        return inTurn.tail.length ? inTurn : { ...turns, summarize: turns.head, steps: 0, inTurn: false };
      };
      const chosen = chooseTail(tailBudget(contextLength));
      const { tail, head, turns: tailTurns, tokens: tailTokens } = chosen;

      // Facts established by an earlier compaction of this same session.
      // Carrying them forward explicitly is what stops the record thinning a
      // little on every pass.
      const priorRecord = [...chosen.summarize].reverse().find((message) => message?.compactionRecord)?.content || '';
      const transcript = chosen.summarize.filter((message) => !message?.compactionRecord);

      // drop bulky tool outputs from what the summarizer sees — the summarizer
      // must not context-shift itself. Deviation: 3,000 characters per result
      // rather than the source's 1,500; at 1,500 a file's findings were mostly
      // cut before the summarizer saw them, and chunking already keeps the
      // input inside the window.
      const windowBudget = Math.floor(contextLength * 0.8);
      const summarizerInput = modelReadyMessages(transcript)
        .map((m) =>
          m.role === 'tool' && String(m.content).length > SUMMARIZER_RESULT_CHARS
            ? { ...m, content: String(m.content).slice(0, SUMMARIZER_RESULT_CHARS) + '…[truncated]' }
            : m
        );
      const sourceTokens = estimateTokens(summarizerInput);
      const summaryRoom = summaryBudget(contextLength, pinnedCost + tailTokens);
      const chunkBudget = Math.max(1200, windowBudget - pinnedCost - estimateTokens(priorRecord) - 600);

      // What the session did is read off the tool record rather than left to
      // the summarizer, which is why the file list used to be the first thing
      // lost.
      const ledger = buildLedger(head);
      const ledgerText = renderLedger(ledger);

      // A record that has to carry one line per file needs room for them: a
      // summary of fifteen files once came back at 286 tokens and the model
      // re-read what it had already read.
      const filesTouched = ledger.read.length + ledger.changed.length;
      const findingsFloor = chosen.inTurn && filesTouched ? 150 + 60 * filesTouched : 0;
      const minimumTokens = Math.max(minimumSummaryTokens(sourceTokens), Math.min(1200, findingsFloor));
      const priorReady = priorRecord ? [{ role: 'user', content: priorRecordPreamble(priorRecord) }] : [];

      // Summarizing is extraction, not deliberation, and the trace competes
      // with the record for the same max_tokens.
      const useThink = await rt.models.summarizerThink(model);

      // A transcript too large for one pass is split chronologically and
      // folded back together, rather than having its oldest half deleted to
      // make it fit.
      const chunks = planChunks(summarizerInput, { budget: chunkBudget, estimateTokens });
      let msgs;
      if (chunks.length > 1) {
        const partials = [];
        for (let index = 0; index < chunks.length; index++) {
          sink().state(`compacting (part ${index + 1}/${chunks.length})…`);
          // With the chunk ceiling reached, a single part can still overrun
          // the window. Trimming inside one part is bounded harm — every part
          // is still represented.
          const part = fitToWindow(chunks[index], chunkBudget);
          const partial = await rt.stream.completeText({
            model,
            messages: [
              ...pinnedReady,
              ...part,
              { role: 'user', content: chunkInstruction(index, chunks.length) },
            ],
            signal,
            think: useThink,
            numCtx: contextLength,
            temperature: 0.2,
            maxTokens: Math.max(512, Math.floor(summaryRoom / 2)),
            usageBucket: 'main',
          });
          partials.push(`PART ${index + 1} OF ${chunks.length}:\n${partial}`);
        }
        msgs = [
          ...pinnedReady,
          ...priorReady,
          { role: 'user', content: partials.join('\n\n') },
          { role: 'user', content: reduceInstruction(chunks.length, minimumTokens) },
        ];
      } else {
        msgs = [
          ...pinnedReady,
          ...priorReady,
          ...summarizerInput,
          {
            role: 'user',
            content: summaryInstruction({
              tailTurns: tail.length ? tailTurns : 0,
              minimumTokens,
              ...(chosen.inTurn ? { inTurnSteps: chosen.steps } : {}),
            }),
          },
        ];
      }

      let summary = '';
      let check = { ok: false, reason: 'empty', tokens: 0, required: 0 };
      let retries = 0;
      // Ask for the room the record can actually hold, and give one
      // corrective retry when the answer is too thin.
      for (let attempt = 0; attempt < 2; attempt++) {
        summary = await rt.stream.completeText({
          model,
          messages: msgs,
          signal,
          think: useThink,
          numCtx: contextLength,
          temperature: 0.2,
          maxTokens: Math.max(512, summaryRoom),
          usageBucket: 'main',
        });
        check = validateSummary(summary, { sourceTokens, estimateTokens, minimumTokens: findingsFloor });
        // Retry for missing headings too, but only once — a long summary
        // without them is still worth keeping.
        if (check.ok && check.structured) break;
        if (attempt === 0) {
          retries += 1;
          msgs.push({ role: 'assistant', content: summary || '(empty response)' });
          msgs.push({ role: 'user', content: retryInstruction(check) });
        }
      }

      // The findings floor is what the retry asks for, not a reason to throw a
      // record away: a short summary that clears the ordinary floor is still
      // far better than none.
      if (!check.ok && findingsFloor) {
        const ordinary = validateSummary(summary, { sourceTokens, estimateTokens });
        if (ordinary.ok) check = ordinary;
      }

      // Degrade toward raw text, never toward nothing. If the model will not
      // produce a usable summary, keep a larger verbatim tail rather than
      // compacting into a record that has lost the session.
      const degraded = !check.ok;
      const fallback = degraded
        ? chooseTail(Math.max(1200, retainedBudget(contextLength) - pinnedCost))
        : null;
      if (degraded && !fallback.tail.length) {
        return {
          ok: false,
          error: `The summary was ${check.reason} (${check.tokens} tokens, needed ${check.required}) and no complete turn fits the retained budget. The conversation was left unchanged.`,
        };
      }

      // A good summary does not make up for keeping nothing. The summary
      // covers what came BEFORE the recent turns, so a tail of zero discards
      // the request currently being worked on. Widen once, then decline
      // rather than destroy the conversation.
      let kept = degraded ? fallback : chosen;
      if (!degraded && !kept.tail.length) {
        const wider = chooseTail(Math.max(1200, retainedBudget(contextLength) - pinnedCost));
        if (!wider.tail.length) {
          return {
            ok: false,
            error: 'The most recent turn is too large to keep even at the widest budget, and compacting would discard it. '
              + 'The conversation was left unchanged — start a new chat with /clear.',
          };
        }
        kept = wider;
      }

      const keptTail = kept.tail;
      rt.session.usage.metrics.compactions += 1;

      const notice = degraded
        ? 'Compaction could not produce a usable summary, so the earlier conversation was dropped and only the most recent turns below were kept. Re-read anything you need from earlier work rather than assuming it.'
        : kept.inTurn
          ? 'This conversation was compacted to save context, partway through the current request. Continue from the summary below: the request itself and its most recent steps follow it intact, and the summary records what the earlier steps found. Do not redo work the summary says is done — re-read a file only when you need its exact text.'
          : 'This conversation was compacted to save context. Continue from the summary below; the most recent turns that follow it are intact.';

      rt.session.conversation = [
        ...pinnedConversation,
        {
          role: 'user',
          // The whole compaction block is bookkeeping the model must read and
          // a person should not have to scroll past as though it were dialogue.
          meta: 'compaction',
          content: notice
            + (/devstral/i.test(model)
              ? ' REMINDER: act only via tool calls (write_file/edit_file/read_file/run_command) — markdown code blocks in replies do nothing.'
              : ''),
        },
        ...(ledgerText ? [{ role: 'assistant', meta: 'compaction', content: ledgerText }] : []),
        ...(degraded ? [] : [{
          role: 'assistant',
          meta: 'compaction',
          content: 'Summary of the conversation so far:\n\n' + summary,
          compactionRecord: true,
        }]),
        ...keptTail,
      ];

      const approxTokens = rt.state.currentConversationTokens(model);
      rt.session.usage.context = { tokens: approxTokens, limit: contextLength };

      // Written before returning: this is the last moment the tool record
      // exists in the conversation, and a failed write must not fail the
      // compaction.
      const stored = isEmptyLedger(ledger)
        ? null
        : rt.services.ledgerStore.append(rt.session.id, ledger, { before, after: approxTokens, degraded, model });

      const result = {
        ok: true,
        approxTokens,
        contextLength,
        before,
        after: approxTokens,
        summaryTokens: degraded ? 0 : check.tokens,
        tailTurns: kept.turns,
        tailTokens: kept.tokens,
        tailSteps: kept.steps,
        inTurn: !!kept.inTurn,
        retries,
        degraded,
        unstructured: !degraded && !check.structured,
        ledgerEntries: isEmptyLedger(ledger)
          ? 0
          : ledger.changed.length + ledger.commands.length + ledger.errors.length,
        ledgerPath: stored?.ok ? stored.path : '',
        chunks: chunks.length,
        carriedPriorRecord: !!priorRecord,
      };
      return { ...result, description: describeCompaction(result) };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      return { ok: false, error: rt.providers.redact(String(err.message || err)) };
    }
  }

  // Before a message is sent: if the conversation is already past the
  // threshold, compact first so the new turn starts with room.
  async function maybePrecompact(model) {
    if (rt.session.conversation.length < 2) return;
    const contextLength = await rt.models.effectiveContext(model);
    const estimated = rt.state.currentConversationTokens(model);
    if (!rt.agentLoop.shouldAutoCompact(estimated, contextLength)) return;
    sink().info(`Context is ~${Math.round((estimated / contextLength) * 100)}% full before sending — auto-compacting first…`);
    sink().state('auto-compacting…');
    const c = await compactConversation(model);
    if (c.ok) {
      sink().emit('stream:stats', { contextTokens: c.approxTokens, contextLength: c.contextLength, tokPerSec: 0, scope: 'conversation' });
      sink().info(`Compacted: ${c.description}`);
    } else {
      sink().info('Pre-send compact failed (' + c.error + ') — sending anyway; the oldest messages may be invisible to the model.');
    }
  }

  return { compactConversation, maybePrecompact };
}

module.exports = { createCompactionRunner };
