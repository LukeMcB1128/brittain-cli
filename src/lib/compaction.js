// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/compaction.js
'use strict';

// Pure helpers for conversation compaction.
//
// Compaction used to replace the whole conversation with a single summary
// string, which meant a long session could collapse into a couple of sentences
// with no way back. These helpers split that job into parts that can be checked
// before anything is destroyed: how much room a compacted conversation may
// keep, which recent messages survive verbatim, and whether a returned summary
// is substantial enough to continue from.
//
// No Electron and no network here, so all of it is testable without a model.

const estimateTokensDefault = (value) => Math.round(JSON.stringify(value).length / 4);

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

// Compaction should buy back room to keep working, not reset the agent to zero.
// Small windows get a proportionally larger share: 25% of 8k is too little to
// hold a useful tail, while 25% of 128k is plenty.
function retainedBudget(contextLength) {
  const limit = Number(contextLength) || 0;
  if (limit <= 0) return 0;
  const share = limit <= 8192 ? 0.40
    : limit <= 16384 ? 0.32
    : limit <= 32768 ? 0.28
    : 0.25;
  return Math.floor(limit * share);
}

// Of the retained budget, this much goes to the verbatim tail. The remainder is
// summary room (and, once the ledger lands, ledger room).
const TAIL_SHARE = 0.6;

function tailBudget(contextLength) {
  return Math.floor(retainedBudget(contextLength) * TAIL_SHARE);
}

function summaryBudget(contextLength, spokenFor = 0) {
  return Math.max(256, retainedBudget(contextLength) - Math.max(0, spokenFor));
}

// A tail may only begin at a turn boundary. Starting mid-turn would hand the
// model tool results whose originating assistant tool_calls were summarized
// away — a shape Ollama rejects and the model cannot interpret.
//
// Deviation: only a message the person wrote starts a turn. The loop's own
// notes (nudges, failure directives, the step-cap warning) and compaction's
// notice are user-role messages too, and counting them let a tail begin at a
// nudge in the middle of a turn — so the request that opened the turn was
// summarized away, the record took its goal from whatever files had been read,
// and the model answered a question nobody asked.
function isTurnStart(message) {
  return message?.role === 'user' && message.meta !== 'nudge' && message.meta !== 'compaction';
}

function countTurns(messages) {
  return messages.reduce((total, message) => total + (isTurnStart(message) ? 1 : 0), 0);
}

// Largest suffix of `messages` that starts at a turn boundary and fits the
// budget. Never returns the entire conversation — compaction has to leave
// something behind to summarize, or it accomplishes nothing.
function selectVerbatimTail(messages, budgetTokens, estimateTokens = estimateTokensDefault) {
  const list = Array.isArray(messages) ? messages : [];
  const nothing = { tail: [], head: list.slice(), turns: 0, tokens: 0 };
  if (!list.length || !(budgetTokens > 0)) return nothing;

  let best = null;
  // Walk turn starts newest-first. Candidates grow as the index falls, so the
  // first one over budget means every earlier one is too.
  for (let i = list.length - 1; i > 0; i--) {
    if (!isTurnStart(list[i])) continue;
    const candidate = list.slice(i);
    const tokens = estimateTokens(candidate);
    if (tokens > budgetTokens) break;
    best = { tail: candidate, head: list.slice(0, i), turns: countTurns(candidate), tokens };
  }
  return best || nothing;
}

// CLI addition. The tail above can only begin at a user message, so a single
// turn larger than the budget — one request that read file after file — left
// nothing it was allowed to keep, and compaction refused outright. On a 32k
// model that is an ordinary turn, not an edge case.
//
// So within the current turn, keep the request that opened it plus the newest
// complete steps. A step begins at an assistant message and carries the tool
// results that answer it, so a result is never separated from its call. The
// request is kept whole: it is the goal, and losing it is how a session comes
// back saying it cannot see an active task.
//
// A request is a user message written by the person, not one the loop wrote
// (nudges) or compaction left behind.
const isRequest = isTurnStart;

function selectTurnTail(messages, budgetTokens, estimateTokens = estimateTokensDefault) {
  const list = Array.isArray(messages) ? messages : [];
  const nothing = { tail: [], head: list.slice(), summarize: list.slice(), turns: 0, steps: 0, tokens: 0, inTurn: true };
  if (!list.length || !(budgetTokens > 0)) return nothing;
  let requestIndex = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (isRequest(list[i])) { requestIndex = i; break; }
  }
  if (requestIndex < 0) return nothing;
  const request = list[requestIndex];
  const requestTokens = estimateTokens([request]);
  if (requestTokens > budgetTokens) return nothing;

  // Newest steps first; candidates grow as the index falls, so the first one
  // over budget means every earlier one is too.
  let cut = list.length;
  for (let i = list.length - 1; i > requestIndex; i--) {
    if (list[i]?.role !== 'assistant') continue;
    if (requestTokens + estimateTokens(list.slice(i)) > budgetTokens) break;
    cut = i;
  }
  const steps = list.slice(cut);
  const head = [...list.slice(0, requestIndex), ...list.slice(requestIndex + 1, cut)];
  // Nothing left to summarize means compaction would accomplish nothing.
  if (!head.length) return nothing;
  return {
    tail: [request, ...steps],
    head,
    // The summarizer sees the request too, in place: it is what the earlier
    // steps were for.
    summarize: list.slice(0, cut),
    turns: 1,
    steps: steps.filter((message) => message.role === 'assistant').length,
    tokens: requestTokens + estimateTokens(steps),
    inTurn: true,
  };
}

// The failure this guards against is a 130k conversation coming back as two
// sentences. The floor tracks the source so genuinely short conversations are
// still allowed to summarize short.
function minimumSummaryTokens(sourceTokens) {
  return clamp(Math.round((Number(sourceTokens) || 0) * 0.02), 120, 900);
}

// The five things that are expensive to rederive after the transcript is gone.
// Asking for them by name is what turns "summarize this" into a record.
const SUMMARY_SECTIONS = [
  { name: 'GOAL', hint: 'the original objective, in the user\'s own terms where possible' },
  { name: 'CONSTRAINTS', hint: 'user corrections, rejected approaches, and stated preferences' },
  { name: 'DECISIONS', hint: 'what was chosen and why — the part that costs most to work out twice' },
  { name: 'STATE', hint: 'where the work actually stands right now' },
  { name: 'NEXT', hint: 'the concrete remaining steps' },
];

function sectionPresent(text, name) {
  // Models label sections in several ways: bare, as a markdown heading, bolded,
  // or followed by a colon or dash. Accept all of them rather than retrying
  // over formatting.
  return new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*[:\\-—]?\\s*$|^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*[:\\-—]\\s*\\S`, 'im')
    .test(text);
}

function missingSections(text) {
  return SUMMARY_SECTIONS.map((section) => section.name).filter((name) => !sectionPresent(text, name));
}

// Two different questions, deliberately separated. `ok` means the summary is
// usable at all; `structured` means it is fully compliant. A long, unstructured
// summary is still far better than discarding the session, so the caller is
// allowed to accept one while retrying for the other.
// `minimumTokens` raises the floor for a caller that knows the record has to
// hold more than the source size suggests (CLI: one line per file read).
function validateSummary(summary, { sourceTokens = 0, estimateTokens = estimateTokensDefault, minimumTokens = 0 } = {}) {
  const text = String(summary || '').trim();
  const required = Math.max(minimumSummaryTokens(sourceTokens), Math.min(1200, Number(minimumTokens) || 0));
  if (!text) return { ok: false, structured: false, reason: 'empty', tokens: 0, required, missing: [] };
  const tokens = estimateTokens(text);
  const missing = missingSections(text);
  if (tokens < required) {
    return { ok: false, structured: missing.length === 0, reason: 'too short', tokens, required, missing };
  }
  return {
    ok: true,
    structured: missing.length === 0,
    reason: missing.length ? 'unstructured' : '',
    tokens,
    required,
    missing,
  };
}

// The instruction that asks for a record rather than a paragraph.
function summaryInstruction({ tailTurns = 0, minimumTokens = 0, inTurnSteps } = {}) {
  const scope = inTurnSteps !== undefined
    ? `Summarize the conversation above so work can continue in a fresh session. The user's current request${inTurnSteps ? ` and its ${inTurnSteps} most recent ${inTurnSteps === 1 ? 'step is' : 'steps are'}` : ' is'} being kept word for word. Carry forward everything else, since those earlier steps will not be shown again. Under STATE, give every file that was read or listed its own line: its path and what it contains or showed that matters for the request. Findings are the point of this record — without them the work has to be done again.`
    : tailTurns
    ? `Summarize the conversation above so work can continue in a fresh session. The ${tailTurns} most recent ${tailTurns === 1 ? 'turn is' : 'turns are'} being kept word for word and are not shown to you, so do not try to cover them — carry forward everything earlier that they would not reveal on their own.`
    : 'Summarize this entire conversation so work can continue seamlessly in a fresh session.';
  return [
    scope,
    '',
    'Use exactly these five headings, in this order:',
    ...SUMMARY_SECTIONS.map((section) => `${section.name}: ${section.hint}`),
    '',
    ...(minimumTokens ? [`Write at least ${minimumTokens} tokens. Detail that is expensive to rediscover is worth the room.`, ''] : []),
    'Do not continue the work, call tools, or ask questions. Output only the summary.',
  ].join('\n');
}

function retryInstruction(check) {
  const problems = [];
  if (check.reason === 'empty') problems.push('That response was empty.');
  else if (check.reason === 'too short') {
    problems.push(`That summary was roughly ${check.tokens} tokens — too thin to resume work from. Write at least ${check.required}.`);
  }
  if (check.missing?.length) {
    problems.push(`These required headings were missing: ${check.missing.join(', ')}. Include all five.`);
  }
  return [
    ...problems,
    'Rewrite it in full. Cover the goal, the decisions taken and why, every file created or modified and its current state,',
    'commands run and their outcomes, unresolved errors, and the remaining work. Output only the summary.',
  ].join(' ');
}

// Chunking exists because the old path hard-fit the transcript to the window by
// dropping the oldest messages first — which meant the summarizer was asked to
// summarize a conversation whose opening, including the goal, it had never been
// shown. Splitting chronologically and summarizing each part instead means no
// segment goes silently missing.
const MAX_CHUNKS = 6;

function planChunks(messages, { budget, maxChunks = MAX_CHUNKS, estimateTokens = estimateTokensDefault } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return [];
  const total = estimateTokens(list);
  if (!(budget > 0) || total <= budget) return [list];

  // Spread the content evenly rather than packing early chunks to the brim, so
  // the last chunk is not a sliver, and never exceed the chunk ceiling.
  const wanted = Math.min(maxChunks, Math.ceil(total / budget));
  const target = Math.ceil(total / wanted);

  const chunks = [];
  let current = [];
  let currentTokens = 0;
  for (const message of list) {
    const cost = estimateTokens(message);
    // Break at turn boundaries where possible so a chunk does not open with a
    // tool result whose call sits in the previous chunk.
    const wouldOverflow = currentTokens + cost > target && current.length > 0;
    if (wouldOverflow && (isTurnStart(message) || chunks.length + 1 >= wanted)) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Instruction for one chunk of a chronologically split transcript.
function chunkInstruction(index, total) {
  return [
    `This is part ${index + 1} of ${total} of a longer conversation, in chronological order.`,
    'Record what happens in this part only: decisions taken and why, files created or modified and their state,',
    'commands run and their outcomes, errors, and anything the user asked for or ruled out.',
    'Do not speculate about the other parts. Output only the record.',
  ].join(' ');
}

// Instruction for folding the per-chunk records into one.
function reduceInstruction(count, minimumTokens) {
  return [
    `Below are ${count} records covering one conversation in chronological order.`,
    'Merge them into a single record. Later parts override earlier ones where they conflict —',
    'a file changed twice should read as its latest state, and a resolved error should not appear as open.',
    '',
    'Use exactly these five headings, in this order:',
    ...SUMMARY_SECTIONS.map((section) => `${section.name}: ${section.hint}`),
    '',
    minimumTokens ? `Write at least ${minimumTokens} tokens.` : '',
    'Output only the merged record.',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

// A conversation that has already been compacted carries its previous record.
// Labelling it keeps facts from the first compaction alive through the third,
// instead of degrading a little on every pass.
function priorRecordPreamble(record) {
  return [
    'PRIOR RECORD — the state carried forward from an earlier compaction of this same session.',
    'Treat these as established facts and carry them into your summary unless the transcript below contradicts them.',
    '',
    String(record || '').trim(),
  ].join('\n');
}

function formatCount(value) {
  return String(Math.max(0, Math.round(Number(value) || 0)));
}

// One actionable line: how much room was reclaimed, what survived verbatim, and
// whether the summarizer had to be corrected. Compaction used to report nothing
// but a token count, which is how a session could collapse unnoticed.
function describeCompaction(result) {
  if (!result || !result.ok) return '';
  const parts = [`${formatCount(result.before)} \u2192 ${formatCount(result.after)} tokens`];
  parts.push(result.degraded
    ? `no usable summary${result.rejectedReason ? ` (${result.rejectedReason})` : ''} \u2014 recent turns only`
    : `summary ${formatCount(result.summaryTokens)} tok${result.unstructured ? ' (unstructured)' : ''}`);
  const entries = Math.max(0, Math.round(Number(result.ledgerEntries) || 0));
  if (entries) parts.push(`${entries} ledger ${entries === 1 ? 'entry' : 'entries'}`);
  const chunks = Math.max(0, Math.round(Number(result.chunks) || 0));
  if (chunks > 1) parts.push(`summarized in ${chunks} parts`);
  if (result.carriedPriorRecord) parts.push('carried prior record');
  const turns = Math.max(0, Math.round(Number(result.tailTurns) || 0));
  const steps = Math.max(0, Math.round(Number(result.tailSteps) || 0));
  parts.push(result.inTurn
    ? `current request${steps ? ` and ${steps} recent ${steps === 1 ? 'step' : 'steps'}` : ''} kept verbatim`
    : `${turns} recent ${turns === 1 ? 'turn' : 'turns'} kept verbatim`);
  const retries = Math.max(0, Math.round(Number(result.retries) || 0));
  if (retries) parts.push(`${retries} ${retries === 1 ? 'retry' : 'retries'}`);
  return parts.join(' \u00b7 ');
}

module.exports = {
  estimateTokensDefault,
  retainedBudget,
  tailBudget,
  summaryBudget,
  selectVerbatimTail,
  selectTurnTail,
  countTurns,
  minimumSummaryTokens,
  validateSummary,
  retryInstruction,
  summaryInstruction,
  planChunks,
  chunkInstruction,
  reduceInstruction,
  priorRecordPreamble,
  MAX_CHUNKS,
  SUMMARY_SECTIONS,
  missingSections,
  describeCompaction,
  TAIL_SHARE,
};
