// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- generate chat title ----------" (+ recordTitleUsage and resolvePendingChatTitle from the chat job section)
'use strict';

const { generateChatTitle } = require('../lib/chat-title');
const { costOf, describeTurn: describeTurnCost, describeTotals: describeCostTotals } = require('../lib/cost');

const MAX_TITLE_ATTEMPTS = 3;

function fallbackChatTitle(text) {
  const source = String(text || '').trim() || 'Chat';
  return source.length > 30 ? source.slice(0, 30) + '...' : source;
}

function createTitles(rt) {
  const streamChat = (...args) => rt.stream.streamChat(...args);
  const thinkValue = (...args) => rt.models.thinkValue(...args);
  const effectiveContext = (...args) => rt.models.effectiveContext(...args);

  function recordTitleUsage(model, stats) {
    if (!stats) return;
    rt.state.recordUsage('main', stats);
    const promptTokens = stats.promptTokens || 0;
    const evalTokens = stats.evalTokens || 0;
    if (rt.providers.resolve().mode === 'ollama' || (!promptTokens && !evalTokens)) return;
    const cost = costOf({ promptTokens, evalTokens }, rt.models.ratesForModel(model));
    const spend = rt.session.spend;
    rt.session.spend = {
      ...spend,
      cost: spend.cost + (cost || 0),
      promptTokens: spend.promptTokens + promptTokens,
      evalTokens: spend.evalTokens + evalTokens,
      turns: Math.max(1, spend.turns),
      priced: spend.priced && cost !== null,
    };
    rt.sink.emit('stream:cost', {
      text: `Title: ${describeTurnCost({ cost, promptTokens, evalTokens })}`,
      cost,
      promptTokens,
      evalTokens,
      sessionText: describeCostTotals(rt.session.spend),
    });
  }

  // Runs under the run's own abort controller, so a stop during naming ends
  // the request rather than leaving it to its 20 second timeout.
  async function generate(conversation, model, signal) {
    const result = await generateChatTitle({ conversation, model, streamChat, thinkValue, effectiveContext, signal });
    recordTitleUsage(model, result.stats);
    return result;
  }

  async function resolvePendingChatTitle({ chatId, model, signal }) {
    const { historyStore } = rt.services;
    const loaded = historyStore.load(chatId);
    if (!loaded.ok || !loaded.chat.autoTitlePending) return { ok: true, changed: false };
    const attempts = Math.max(0, Number(loaded.chat.autoTitleAttempts) || 0);
    if (attempts >= MAX_TITLE_ATTEMPTS) return { ok: false, error: 'Automatic title generation reached its retry limit.' };
    const generated = await generate(loaded.chat.conversation, model, signal);
    if (!generated.ok) {
      if (!generated.aborted) {
        const nextAttempts = attempts + 1;
        await historyStore.save({
          ...loaded.chat,
          autoTitlePending: nextAttempts < MAX_TITLE_ATTEMPTS,
          autoTitleAttempts: nextAttempts,
          runMetrics: rt.session.usage,
          spend: rt.session.spend,
        }, loaded.chat.conversation);
      }
      return generated;
    }
    const saved = await historyStore.save({
      ...loaded.chat,
      title: generated.title,
      autoTitlePending: false,
      autoTitleAttempts: attempts + 1,
      runMetrics: rt.session.usage,
      spend: rt.session.spend,
    }, loaded.chat.conversation);
    return saved.ok ? { ok: true, changed: true, title: generated.title } : saved;
  }

  return { fallbackChatTitle, generate, recordTitleUsage, resolvePendingChatTitle };
}

module.exports = { createTitles, fallbackChatTitle };
