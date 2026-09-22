// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- conversation state (lives in main so tool messages stay in history) ----------", "---------- usage accounting (per chat; reset on new session / chat load) ----------", and the session variables above them
'use strict';

// The conversation, its context state, usage, and spend — everything main.js
// kept in top-level `let`s — now owned by rt.session (PLAN.md §6.3).
//
// Pruned: attachments, the online-research latch, and the subagent, coder,
// and verifier usage buckets with the metrics only they fed (Jev, loops,
// orchestration, repairs).

const { createSessions, loadSessionState } = require('../lib/sessions');
const { normalizeContextState } = require('../lib/context-controls');
const { emptyTotals: emptyCostTotals } = require('../lib/cost');
const { estimateContextTokens } = require('../lib/context-estimator');
const { modelReadyMessages } = require('./context-hygiene');

function newSessionIdValue() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function freshUsageBucket() {
  return {
    calls: 0,
    prompt: 0,
    gen: 0,
    loadMs: 0,
    promptEvalMs: 0,
    generationMs: 0,
    totalMs: 0,
  };
}

function freshUsage() {
  return {
    main: freshUsageBucket(),
    context: { tokens: 0, limit: 0 },
    metrics: {
      wallTimeMs: 0,
      peakContextTokens: 0,
      peakContextLimit: 0,
      toolCalls: 0,
      toolErrors: 0,
      deniedTools: 0,
      recoveredToolCalls: 0,
      toolCallRetries: 0,
      psychosisDetections: 0,
      compactions: 0,
      emergencyCompactions: 0,
      stoppedRuns: 0,
      failedRuns: 0,
    },
  };
}

function restoreUsage(saved) {
  const blank = freshUsage();
  if (!saved || typeof saved !== 'object') return blank;
  if (saved.main && typeof saved.main === 'object') blank.main = { ...blank.main, ...saved.main };
  if (saved.context && typeof saved.context === 'object') blank.context = { ...blank.context, ...saved.context };
  if (saved.metrics && typeof saved.metrics === 'object') {
    for (const key of Object.keys(blank.metrics)) {
      if (Number.isFinite(saved.metrics[key])) blank.metrics[key] = saved.metrics[key];
    }
  }
  return blank;
}

function createState(rt) {
  const session = {
    // Identifies the stretch of work whose ledgers belong together. Reset
    // whenever the conversation is cleared or replaced, so one file covers one
    // session.
    id: newSessionIdValue(),
    conversation: [], // provider-format messages, excluding system
    view: { model: '', cwd: '', mode: 'code' },
    contextState: normalizeContextState(),
    usage: freshUsage(),
    // What this conversation has cost. Per session, so /cost answers for the
    // conversation you are looking at.
    spend: emptyCostTotals(),
  };
  rt.session = session;

  // Whose conversation rt.session.conversation currently is. See
  // src/lib/sessions.js for why runs are scoped this way.
  const sessions = createSessions('window');
  rt.sessions = sessions;

  function newSessionId() {
    session.id = newSessionIdValue();
    session.spend = emptyCostTotals();
    return session.id;
  }

  function rememberConversationView(view = {}) {
    session.view = {
      ...session.view,
      ...view,
      mode: view.mode === 'chat' ? 'chat' : (view.mode || session.view.mode || 'code'),
    };
    return session.view;
  }

  function enterSession(key) {
    const target = String(key || 'window');
    // Never swap under a running loop. The agent loop reads the conversation
    // on every step, so switching mid-run pushes the rest of that run's
    // messages into somebody else's transcript and leaves both sessions
    // holding a torn copy.
    if (rt.run.abort && target !== sessions.active()) return sessions.active();
    const current = {
      conversation: session.conversation,
      sessionId: session.id,
      contextState: session.contextState,
      usage: session.usage,
      spend: session.spend,
    };
    const { changed, state } = sessions.switchTo(key, current);
    if (!changed) return sessions.active();
    const restored = state || (target !== 'window' ? loadSessionState(rt.services.historyStore, target) : null);
    session.conversation = restored?.conversation || [];
    session.contextState = restored?.contextState || normalizeContextState();
    session.usage = restored?.usage ? restoreUsage(restored.usage) : freshUsage();
    // Spend belongs to the conversation too, so /cost answers for the one you
    // are looking at rather than for whatever ran most recently.
    session.spend = restored?.spend || emptyCostTotals();
    // Last, and deliberately: newSessionId resets spend, so a fresh session
    // starts clean while a restored one keeps what was set above.
    if (restored?.sessionId) session.id = restored.sessionId;
    else {
      const spend = session.spend;
      newSessionId();
      if (restored) session.spend = spend;
    }
    return sessions.active();
  }

  function recordUsage(bucket, stats) {
    if (!stats) return;
    const target = session.usage[bucket];
    if (!target) return;
    target.calls += 1;
    target.prompt += stats.promptTokens || 0;
    target.gen += stats.evalTokens || 0;
    target.loadMs += stats.loadMs || 0;
    target.promptEvalMs += stats.promptEvalMs || 0;
    target.generationMs += stats.generationMs || 0;
    target.totalMs += stats.totalMs || 0;
  }

  function finishRunMetrics(startedAt, outcome = 'ok') {
    session.usage.metrics.wallTimeMs += Math.max(0, Date.now() - startedAt);
    if (outcome === 'stopped') session.usage.metrics.stoppedRuns += 1;
    if (outcome === 'failed') session.usage.metrics.failedRuns += 1;
  }

  function recordToolTelemetry(result, denied = false) {
    session.usage.metrics.toolCalls += 1;
    if (denied) session.usage.metrics.deniedTools += 1;
    if (/error|failed|timed out|exception|traceback/i.test(String(result).slice(0, 500))) {
      session.usage.metrics.toolErrors += 1;
    }
  }

  // Provider counts describe one completed inference. They are useful for
  // speed and usage totals, but they are not the size of the conversation's
  // next request. In particular, Ollama can omit prompt counts on tool-call
  // chunks.
  function publishContextStats(stats, contextLength, scope = 'provider') {
    if (!stats || !contextLength) return;
    const contextTokens = (stats.promptTokens || 0) + (stats.evalTokens || 0);
    rt.sink.emit('stream:stats', {
      contextTokens,
      contextLength,
      tokPerSec: stats.tokPerSec || 0,
      scope,
    });
  }

  // The size of the next request: system prompt and tool schemas included,
  // since both are sent every time but live outside the conversation.
  function currentConversationTokens(model = session.view.model) {
    const view = { ...session.view, model: model || session.view.model };
    const overhead = rt.prompts.fixedOverheadTokens(view.cwd, view.model, view.mode);
    return overhead + estimateContextTokens(modelReadyMessages(session.conversation));
  }

  function emitPersistedConversationContext(model, contextLength) {
    const contextTokens = currentConversationTokens(model);
    session.usage.context = { tokens: contextTokens, limit: contextLength };
    if (contextTokens > session.usage.metrics.peakContextTokens) {
      session.usage.metrics.peakContextTokens = contextTokens;
      session.usage.metrics.peakContextLimit = contextLength;
    }
    rt.sink.emit('stream:stats', {
      contextTokens,
      contextLength,
      tokPerSec: 0,
      scope: 'conversation',
    });
    return contextTokens;
  }

  async function publishPersistedConversationContext(model, view = {}) {
    rememberConversationView({ ...view, model: model || view.model || session.view.model });
    const contextLength = await rt.models.effectiveContext(model);
    return emitPersistedConversationContext(model, contextLength);
  }

  return {
    currentConversationTokens,
    emitPersistedConversationContext,
    enterSession,
    finishRunMetrics,
    freshUsage,
    newSessionId,
    publishContextStats,
    publishPersistedConversationContext,
    recordToolTelemetry,
    recordUsage,
    rememberConversationView,
    restoreUsage,
  };
}

module.exports = { createState, freshUsage, restoreUsage };
