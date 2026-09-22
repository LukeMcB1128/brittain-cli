// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/run-sink.js
'use strict';

// Where a run's output goes.
//
// Every progress message used to be posted straight to win.webContents, which
// makes the renderer a hard requirement for running anything: no window, no
// run. Routing run output through a sink puts one seam between producing an
// event and delivering it, so a run can be delivered somewhere else — a
// terminal, a file, a JSON stream — or to nobody at all, without touching the
// loops that produce it.
//
// Pruned: the renderer target. The CLI subscribes listeners instead; each one
// receives (channel, payload, meta) where meta is { chatId, runId, sequence }.
// The contract is docs/events.md.

const fs = require('fs');
const path = require('path');

// Channels that carry the narrative of a run.
const RUN_CHANNELS = new Set([
  'stream:state',
  'stream:info',
  'stream:token',
  'stream:thinking',
  'stream:cleancontent',
  // A completed assistant message. Distinct from the token stream: whole
  // thoughts, for a listener that cannot render tokens.
  'stream:message',
  'stream:toolcall',
  'stream:toolresult',
  'stream:stats',
  'stream:done',
  // A question is part of the run's narrative, not UI chatter: whoever is
  // driving the run has to be able to answer it.
  'question:request',
  // What a turn cost.
  'stream:cost',
  // Approvals are asked by the host, but announced here so a stream-json
  // consumer sees every decision that was put to a human.
  'approval:request',
  'approval:resolved',
  // Never carries the Brittain endpoint — only { mode, model }.
  'provider:changed',
]);

// Only these read as prose in a transcript. Tokens and stats are far too noisy
// to write to a file, and a reader wants the narrative, not the stream.
const TRANSCRIPT_CHANNELS = new Map([
  ['stream:state', (payload) => `· ${payload}`],
  ['stream:info', (payload) => String(payload)],
  ['stream:toolcall', (payload) => `→ ${payload?.name || 'tool'}${summarizeArgs(payload?.args)}`],
  ['stream:toolresult', (payload) => `← ${payload?.name || 'tool'}: ${firstLine(payload?.result)}${payload?.denied ? ' (denied)' : ''}`],
  ['stream:message', (payload) => `\n${String(payload ?? '')}\n`],
]);

function firstLine(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const shown = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${firstLine(value, 60)}`)
    .join(' ');
  return shown ? `(${shown})` : '';
}

function createRunSink({ targets = ['listeners'], transcriptPath = '', now = () => new Date(), meta = () => ({}) } = {}) {
  let active = new Set(targets);
  let currentTranscript = transcriptPath;
  const defaults = { targets: [...targets], transcriptPath };
  const listeners = new Set();
  let sequence = 0;
  let written = 0;
  let dropped = 0;

  function toListeners(channel, payload, eventMeta) {
    for (const listener of listeners) {
      // A listener that throws must not take the run down with it.
      try { listener(channel, payload, eventMeta); } catch { dropped += 1; }
    }
  }

  function toTranscript(channel, payload) {
    const render = TRANSCRIPT_CHANNELS.get(channel);
    if (!render || !currentTranscript) return;
    try {
      const line = render(payload);
      if (!line?.trim()) return;
      fs.mkdirSync(path.dirname(currentTranscript), { recursive: true });
      fs.appendFileSync(currentTranscript, `[${now().toISOString()}] ${line}\n`, 'utf8');
      written += 1;
    } catch {
      // A transcript that cannot be written must not take the run down with it.
      dropped += 1;
    }
  }

  function emit(channel, payload) {
    sequence += 1;
    const eventMeta = { ...(meta() || {}), sequence };
    if (active.has('listeners')) toListeners(channel, payload, eventMeta);
    if (active.has('file')) toTranscript(channel, payload);
  }

  return {
    // A run decides where its own output goes. Reset returns to the defaults
    // so a finished run cannot keep writing into its own transcript.
    configure({ targets: wanted, transcriptPath: transcript } = {}) {
      if (wanted) active = new Set(wanted);
      if (transcript !== undefined) currentTranscript = transcript;
    },
    reset() {
      active = new Set(defaults.targets);
      currentTranscript = defaults.transcriptPath;
    },
    // Returns an unsubscribe function.
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcriptPath: () => currentTranscript,
    emit,
    state: (text) => emit('stream:state', text),
    info: (text) => emit('stream:info', text),
    token: (text) => emit('stream:token', text),
    toolCall: (payload) => emit('stream:toolcall', payload),
    toolResult: (payload) => emit('stream:toolresult', payload),
    stats: (payload) => emit('stream:stats', payload),
    done: (payload) => emit('stream:done', payload),
    targets: () => [...active],
    counters: () => ({ written, dropped }),
  };
}

module.exports = { createRunSink, RUN_CHANNELS, TRANSCRIPT_CHANNELS };
