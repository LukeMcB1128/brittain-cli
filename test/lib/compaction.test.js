// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/compaction.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  retainedBudget,
  tailBudget,
  summaryBudget,
  selectVerbatimTail,
  minimumSummaryTokens,
  validateSummary,
  describeCompaction,
  summaryInstruction,
  missingSections,
  retryInstruction,
  SUMMARY_SECTIONS,
  planChunks,
  chunkInstruction,
  reduceInstruction,
  priorRecordPreamble,
  MAX_CHUNKS,
} = require('../../src/lib/compaction');

const user = (content) => ({ role: 'user', content });
const assistant = (content, tool_calls) => ({ role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) });
const toolResult = (content) => ({ role: 'tool', content });

function turn(label, size = 20) {
  return [
    user(`${label} request ${'x'.repeat(size)}`),
    assistant(`${label} plan`, [{ function: { name: 'read_file', arguments: { path: `${label}.js` } } }]),
    toolResult(`${label} file body ${'y'.repeat(size)}`),
    assistant(`${label} done`),
  ];
}

test('retained budget gives small context windows a larger share', () => {
  assert.equal(retainedBudget(8192), Math.floor(8192 * 0.40));
  assert.equal(retainedBudget(32768), Math.floor(32768 * 0.28));
  assert.equal(retainedBudget(131072), Math.floor(131072 * 0.25));
  // A large window still retains more tokens outright than a small one.
  assert.ok(retainedBudget(131072) > retainedBudget(8192));
});

test('retained budget is zero for an unknown context length', () => {
  assert.equal(retainedBudget(0), 0);
  assert.equal(retainedBudget(undefined), 0);
  assert.equal(tailBudget(null), 0);
});

test('tail and summary budgets split the retained room without overspending it', () => {
  const limit = 32768;
  const tail = tailBudget(limit);
  const summary = summaryBudget(limit, tail);
  assert.ok(tail > 0);
  assert.ok(summary > 0);
  assert.ok(tail + summary <= retainedBudget(limit));
});

test('summary budget never returns a uselessly small floor', () => {
  assert.ok(summaryBudget(4096, 100_000) >= 256);
});

test('the verbatim tail starts at a user message, never mid-turn', () => {
  const messages = [...turn('one'), ...turn('two'), ...turn('three')];
  const { tail } = selectVerbatimTail(messages, 10_000);
  assert.ok(tail.length > 0);
  assert.equal(tail[0].role, 'user');
});

test('a tool result is never separated from the assistant message that called it', () => {
  const messages = [...turn('one'), ...turn('two'), ...turn('three')];
  const { tail } = selectVerbatimTail(messages, 10_000);
  for (let i = 0; i < tail.length; i++) {
    if (tail[i].role !== 'tool') continue;
    const previous = tail[i - 1];
    assert.ok(previous, 'a tool result must not be the first message in the tail');
    assert.ok(
      previous.role === 'assistant' || previous.role === 'tool',
      'a tool result must follow its assistant call'
    );
  }
});

test('the tail never swallows the whole conversation', () => {
  const messages = [...turn('one'), ...turn('two')];
  const { tail, head } = selectVerbatimTail(messages, 1_000_000);
  assert.ok(head.length > 0, 'compaction must leave something to summarize');
  assert.ok(tail.length < messages.length);
});

test('head and tail together reconstruct the original conversation exactly', () => {
  const messages = [...turn('one'), ...turn('two'), ...turn('three')];
  const { tail, head } = selectVerbatimTail(messages, 5_000);
  assert.deepEqual([...head, ...tail], messages);
});

test('a budget too small for any complete turn keeps no tail at all', () => {
  const messages = [...turn('one', 400), ...turn('two', 400)];
  const { tail, head, tokens } = selectVerbatimTail(messages, 5);
  assert.deepEqual(tail, []);
  assert.deepEqual(head, messages);
  assert.equal(tokens, 0);
});

test('a larger budget keeps at least as many turns as a smaller one', () => {
  const messages = [...turn('one'), ...turn('two'), ...turn('three'), ...turn('four')];
  const small = selectVerbatimTail(messages, 200);
  const large = selectVerbatimTail(messages, 4_000);
  assert.ok(large.turns >= small.turns);
  assert.ok(large.tokens >= small.tokens);
});

test('tail selection tolerates empty and malformed input', () => {
  assert.deepEqual(selectVerbatimTail([], 1000).tail, []);
  assert.deepEqual(selectVerbatimTail(undefined, 1000).tail, []);
  assert.deepEqual(selectVerbatimTail([user('only one')], 1000).tail, []);
});

test('the summary floor scales with the source but stays bounded', () => {
  assert.equal(minimumSummaryTokens(1000), 120, 'short sources keep a modest floor');
  assert.equal(minimumSummaryTokens(20_000), 400);
  assert.equal(minimumSummaryTokens(10_000_000), 900, 'the floor is capped');
});

test('a two-sentence summary of a huge conversation is rejected', () => {
  const result = validateSummary('We worked on the parser. It is fine now.', { sourceTokens: 130_000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too short');
  assert.ok(result.required > result.tokens);
});

test('an empty or whitespace summary is rejected', () => {
  assert.equal(validateSummary('', { sourceTokens: 5000 }).reason, 'empty');
  assert.equal(validateSummary('   \n  ', { sourceTokens: 5000 }).reason, 'empty');
  assert.equal(validateSummary(null, { sourceTokens: 5000 }).reason, 'empty');
});

test('a substantial summary is accepted', () => {
  const summary = 'word '.repeat(2000);
  const result = validateSummary(summary, { sourceTokens: 130_000 });
  assert.equal(result.ok, true);
  assert.ok(result.tokens >= result.required);
});

test('a short summary of a short conversation is accepted', () => {
  const result = validateSummary('word '.repeat(200), { sourceTokens: 900 });
  assert.equal(result.ok, true);
});

test('a compaction is described with what was reclaimed and what survived', () => {
  const line = describeCompaction({
    ok: true, before: 131_000, after: 8_200, summaryTokens: 1_400, tailTurns: 3, retries: 0,
  });
  assert.match(line, /131000 → 8200 tokens/);
  assert.match(line, /summary 1400 tok/);
  assert.match(line, /3 recent turns kept verbatim/);
  assert.doesNotMatch(line, /retr/);
});

test('a degraded compaction says so instead of reporting a summary size', () => {
  const line = describeCompaction({
    ok: true, before: 99_000, after: 5_000, degraded: true, tailTurns: 1, retries: 1,
  });
  assert.match(line, /no usable summary/);
  assert.match(line, /1 recent turn kept verbatim/);
  assert.match(line, /1 retry/);
  assert.doesNotMatch(line, /summary \d+ tok/);
});

test('a failed compaction is described as nothing at all', () => {
  assert.equal(describeCompaction({ ok: false, error: 'boom' }), '');
  assert.equal(describeCompaction(null), '');
  assert.equal(describeCompaction(undefined), '');
});

const structured = (body = 'word '.repeat(2000)) => [
  'GOAL: ship the parser', '', 'CONSTRAINTS: no new dependencies', '',
  'DECISIONS: chose a hand-rolled lexer', '', 'STATE: half done', '',
  'NEXT: finish the error paths', '', body,
].join('\n');

test('all five required sections are recognised however the model labels them', () => {
  const labelled = ['# GOAL', '**CONSTRAINTS**', 'DECISIONS —  chose X', '## STATE:', 'NEXT - finish'].join('\n\n');
  assert.deepEqual(missingSections(labelled), []);
});

test('a missing section is reported by name', () => {
  const partial = 'GOAL: x\nSTATE: y\nNEXT: z';
  assert.deepEqual(missingSections(partial).sort(), ['CONSTRAINTS', 'DECISIONS']);
});

test('a long summary missing headings is usable but not structured', () => {
  const result = validateSummary('word '.repeat(3000), { sourceTokens: 130_000 });
  assert.equal(result.ok, true, 'it must not be discarded — it is still far better than nothing');
  assert.equal(result.structured, false);
  assert.ok(result.missing.length === SUMMARY_SECTIONS.length);
});

test('a long summary with every heading is both usable and structured', () => {
  const result = validateSummary(structured(), { sourceTokens: 130_000 });
  assert.equal(result.ok, true);
  assert.equal(result.structured, true);
  assert.deepEqual(result.missing, []);
});

test('the summary instruction names the sections and the length it wants', () => {
  const text = summaryInstruction({ tailTurns: 3, minimumTokens: 900 });
  for (const section of SUMMARY_SECTIONS) assert.match(text, new RegExp(section.name));
  assert.match(text, /3 most recent turns are being kept word for word/);
  assert.match(text, /at least 900 tokens/);
  assert.match(text, /Output only the summary/);
});

test('the instruction does not mention a tail when none is being kept', () => {
  const text = summaryInstruction({ tailTurns: 0 });
  assert.doesNotMatch(text, /kept word for word/);
  assert.match(text, /this entire conversation/);
});

test('the retry names the specific problem it wants fixed', () => {
  const short = retryInstruction({ reason: 'too short', tokens: 90, required: 900, missing: [] });
  assert.match(short, /roughly 90 tokens/);
  assert.match(short, /at least 900/);

  const unstructured = retryInstruction({ reason: 'unstructured', tokens: 1200, required: 900, missing: ['DECISIONS', 'NEXT'] });
  assert.match(unstructured, /DECISIONS, NEXT/);
  assert.doesNotMatch(unstructured, /too thin/);

  const empty = retryInstruction({ reason: 'empty', tokens: 0, required: 900, missing: [] });
  assert.match(empty, /empty/);
});

test('the description flags an unstructured summary and counts ledger entries', () => {
  const line = describeCompaction({
    ok: true, before: 131_000, after: 9_200, summaryTokens: 1_400,
    tailTurns: 3, retries: 1, unstructured: true, ledgerEntries: 12,
  });
  assert.match(line, /\(unstructured\)/);
  assert.match(line, /12 ledger entries/);
});

function longConversation(turns, size = 300) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push(user(`question ${i} ${'x'.repeat(size)}`));
    messages.push(assistant(`answer ${i} ${'y'.repeat(size)}`));
  }
  return messages;
}

test('a transcript that fits the budget is not chunked at all', () => {
  const messages = longConversation(3);
  const chunks = planChunks(messages, { budget: 1_000_000 });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], messages);
});

test('an oversized transcript is split rather than having its opening dropped', () => {
  const messages = longConversation(40);
  const chunks = planChunks(messages, { budget: 2_000 });
  assert.ok(chunks.length > 1);
  // The old path evicted oldest-first, losing the goal. Nothing may go missing.
  assert.deepEqual(chunks.flat(), messages);
  assert.deepEqual(chunks[0][0], messages[0], 'the opening of the conversation is still present');
});

test('chunks are split at turn boundaries', () => {
  const chunks = planChunks(longConversation(40), { budget: 2_000 });
  for (const chunk of chunks) assert.equal(chunk[0].role, 'user');
});

test('chunk count is capped so compaction cannot fan out without bound', () => {
  const chunks = planChunks(longConversation(400), { budget: 500 });
  assert.ok(chunks.length <= MAX_CHUNKS, `expected at most ${MAX_CHUNKS}, got ${chunks.length}`);
  assert.deepEqual(chunks.flat(), longConversation(400));
});

test('chunks are evenly sized rather than leaving a sliver at the end', () => {
  const messages = longConversation(40);
  const chunks = planChunks(messages, { budget: 2_000 });
  const sizes = chunks.map((chunk) => JSON.stringify(chunk).length);
  const largest = Math.max(...sizes);
  const smallest = Math.min(...sizes);
  assert.ok(smallest > largest / 3, `chunk sizes were uneven: ${sizes.join(', ')}`);
});

test('chunking tolerates empty and malformed input', () => {
  assert.deepEqual(planChunks([], { budget: 100 }), []);
  assert.deepEqual(planChunks(undefined, { budget: 100 }), []);
  assert.equal(planChunks(longConversation(2), { budget: 0 }).length, 1, 'no budget means no split');
});

test('a chunk record is asked for its own part only', () => {
  const text = chunkInstruction(1, 4);
  assert.match(text, /part 2 of 4/);
  assert.match(text, /this part only/);
  assert.match(text, /Do not speculate about the other parts/);
});

test('the reduce step is told later parts win and asked for the five sections', () => {
  const text = reduceInstruction(4, 900);
  assert.match(text, /4 records/);
  assert.match(text, /Later parts override earlier ones/);
  for (const section of SUMMARY_SECTIONS) assert.match(text, new RegExp(section.name));
  assert.match(text, /at least 900 tokens/);
});

test('a prior record is labelled as established fact that the transcript may override', () => {
  const text = priorRecordPreamble('GOAL: ship the parser');
  assert.match(text, /PRIOR RECORD/);
  assert.match(text, /established facts/);
  assert.match(text, /unless the transcript below contradicts them/);
  assert.match(text, /GOAL: ship the parser/);
});

test('the description reports chunking and a carried prior record', () => {
  const line = describeCompaction({
    ok: true, before: 260_000, after: 16_000, summaryTokens: 1_800,
    tailTurns: 4, retries: 0, ledgerEntries: 22, chunks: 4, carriedPriorRecord: true,
  });
  assert.match(line, /summarized in 4 parts/);
  assert.match(line, /carried prior record/);
});

test('a single-pass compaction says nothing about parts', () => {
  const line = describeCompaction({
    ok: true, before: 30_000, after: 8_000, summaryTokens: 900, tailTurns: 2, chunks: 1,
  });
  assert.doesNotMatch(line, /parts/);
  assert.doesNotMatch(line, /prior record/);
});

// ---------- CLI additions: compaction inside one long turn ----------

const { selectTurnTail, estimateTokensDefault } = require('../../src/lib/compaction');
const { toolResultLimit, MAX_TOOL_RESULT_CHARS } = require('../../src/lib/tool-result');

function longTurn(steps, size = 400) {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'report on the repo' },
  ];
  for (let i = 0; i < steps; i++) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: `f${i}` } } }] });
    messages.push({ role: 'tool', tool_name: 'read_file', content: `f${i}:` + 'x'.repeat(size) });
  }
  return messages;
}

test('one turn larger than the budget keeps its request and newest whole steps', () => {
  const messages = longTurn(6);
  const oneStep = estimateTokensDefault(messages.slice(-2));
  const result = selectTurnTail(messages, estimateTokensDefault([messages[2]]) + oneStep * 2 + 5);
  assert.equal(result.inTurn, true);
  assert.equal(result.tail[0].content, 'report on the repo');
  assert.equal(result.steps, 2);
  assert.deepEqual(result.tail.slice(1).map((m) => m.role), ['assistant', 'tool', 'assistant', 'tool']);
  assert.match(result.tail.at(-1).content, /^f5:/);
  // The request is kept, not summarized away; the summarizer still sees it.
  assert.equal(result.head.includes(messages[2]), false);
  assert.ok(result.summarize.includes(messages[2]));
  assert.equal(result.summarize.length + result.tail.length - 1, messages.length);
});

test('a step is never split from its tool results', () => {
  const messages = longTurn(4);
  for (let budget = 10; budget < 2000; budget += 37) {
    const { tail } = selectTurnTail(messages, budget);
    if (tail.length > 1) assert.equal(tail[1].role, 'assistant', `budget ${budget}`);
  }
});

test('with no step small enough, only the request is kept; nudges are not requests', () => {
  const messages = longTurn(2, 5000);
  messages.push({ role: 'user', meta: 'nudge', content: 'keep going' });
  const result = selectTurnTail(messages, estimateTokensDefault([messages[2]]) + 10);
  assert.deepEqual(result.tail, [messages[2]]);
  assert.equal(result.steps, 0);
});

test('nothing to summarize means no in-turn tail', () => {
  const messages = [{ role: 'user', content: 'only' }, { role: 'assistant', content: 'x'.repeat(50) }];
  // The whole turn fits, so nothing would be left to summarize.
  assert.deepEqual(selectTurnTail(messages, 10_000).tail, []);
  assert.deepEqual(selectTurnTail([{ role: 'user', content: 'only' }], 10_000).tail, []);
});

test('an in-turn compaction is described by what it kept', () => {
  assert.match(describeCompaction({ ok: true, before: 30000, after: 9000, summaryTokens: 400, inTurn: true, tailSteps: 2 }),
    /current request and 2 recent steps kept verbatim$/);
  assert.match(summaryInstruction({ inTurnSteps: 1 }), /current request and its 1 most recent step is being kept word for word/);
});

test('tool results are capped at about an eighth of the window', () => {
  assert.equal(toolResultLimit(32_768), 16_384);
  assert.equal(toolResultLimit(8192), 4096);
  assert.equal(toolResultLimit(2048), 4000, 'never below the floor');
  assert.equal(toolResultLimit(262_144), MAX_TOOL_RESULT_CHARS, 'never above the ceiling');
  assert.equal(toolResultLimit(0), MAX_TOOL_RESULT_CHARS, 'unknown window: the old cap');
});

test('a caller can raise the summary floor, and the retry names it', () => {
  const summary = SUMMARY_SECTIONS.map((s, i) => `${s.name}: ${Array.from({ length: 30 }, (_, n) => `w${i}_${n}`).join(' ')}`).join('\n');
  assert.equal(validateSummary(summary, { sourceTokens: 1000 }).ok, true);
  const raised = validateSummary(summary, { sourceTokens: 1000, minimumTokens: 600 });
  assert.equal(raised.ok, false);
  assert.equal(raised.required, 600);
  assert.match(retryInstruction(raised), /Write at least 600/);
  assert.equal(validateSummary(summary, { minimumTokens: 99_999 }).required, 1200, 'capped');
});
