// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/psychosis-detector.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  PsychosisDetectedError,
  scanContentForPsychosis,
  scanThinkingForPsychosis,
  thinkingBudget,
} = require('../../src/core/degradation');
const { SELF_TALK } = require('../../src/lib/tools/files');

test('psychosis: byte-fallback / replacement token triggers content scan', () => {
  const state = { value: 0 };
  const hit = scanContentForPsychosis('some code <0xC2><0xA0> more code', state);
  assert.ok(hit, 'expected a hit');
  assert.match(hit.reason, /byte-fallback/);

  const hit2 = scanContentForPsychosis('normal output with a � in it', { value: 0 });
  assert.ok(hit2);
});

test('psychosis: full-width punctuation adjacent to identifier triggers, prose does not', () => {
  // real observed case (fablereview.md): a full-width period corrupting an
  // identifier mid-name, e.g. getTitleFromContent -> getTitle．Content
  const hit = scanContentForPsychosis('const value = getTitle．Content(note);', { value: 0 });
  assert.ok(hit, 'expected the identifier-adjacent full-width period to trigger');
  assert.match(hit.reason, /full-width/);

  // full-width characters in legitimate CJK prose, not touching an identifier, must NOT trigger
  const clean = scanContentForPsychosis('This paragraph discusses Japanese punctuation （like this） in passing.', { value: 0 });
  assert.equal(clean, null);
});

test('psychosis: self-talk leaking into code comments triggers, real comments do not', () => {
  const leaked = scanContentForPsychosis('const x = 1;\n// Wait, I messed up the assignment above\nconst y = 2;', { value: 0 });
  assert.ok(leaked);
  assert.match(leaked.reason, /self-talk/);

  const real = scanContentForPsychosis('const x = 1;\n// Wait for the DB connection before querying\nconst y = 2;', { value: 0 });
  assert.equal(real, null);
});

test('psychosis: repetition loop is detected but throttled, and short output never false-positives', () => {
  const state = { value: 0 };
  const chunk = 'const thisIsARepeatedLineOfCodeThatKeepsComingBack = 1;\n';
  let content = '';
  let hit = null;
  // simulate streaming: feed the same chunk repeatedly, exactly like a degenerate model would
  for (let i = 0; i < 30 && !hit; i++) {
    content += chunk;
    hit = scanContentForPsychosis(content, state);
  }
  assert.ok(hit, 'expected repetition to eventually trigger');
  assert.match(hit.reason, /repetition/);

  // a short, non-repeating response must never trigger anything
  const short = scanContentForPsychosis('function add(a, b) { return a + b; }', { value: 0 });
  assert.equal(short, null);
});

test('psychosis: thinking-channel scan only checks glitch tokens, never self-talk (normal CoT is not psychosis)', () => {
  const normalReasoning = "Wait, let me reconsider. I think the bug is in the loop condition. Let me re-check the file.";
  assert.equal(scanThinkingForPsychosis(normalReasoning), null);

  const glitchy = 'The value should be getTitle．Content based on the pattern';
  const hit = scanThinkingForPsychosis(glitchy);
  assert.ok(hit);
  assert.match(hit.reason, /full-width/);
});

test('psychosis: raw channel markers and task-loss phrases trigger context recovery', () => {
  const marker = scanThinkingForPsychosis('<|channel>thought\nThe user has not asked anything yet.', { value: 0 });
  assert.ok(marker);
  assert.match(marker.reason, /channel marker/);
  assert.equal(marker.recovery, 'compact');

  const reset = scanThinkingForPsychosis("The user hasn't provided a specific task yet. I should wait for instructions.", { value: 0 });
  assert.ok(reset);
  assert.match(reset.reason, /task was lost/);
  assert.equal(reset.recovery, 'compact');

  const visibleReset = scanContentForPsychosis('The user has not given any instructions.', { value: 0 });
  assert.ok(visibleReset);
  assert.match(visibleReset.reason, /task was lost/);

  const anythingReset = scanThinkingForPsychosis("The user hasn't asked anything yet.", { value: 0 });
  assert.ok(anythingReset);
  assert.match(anythingReset.reason, /task was lost/);
});

test('psychosis: PsychosisDetectedError carries reason as message and excerpt separately', () => {
  const err = new PsychosisDetectedError('repetition loop detected', 'const x = 1;');
  assert.equal(err.name, 'PsychosisDetectedError');
  assert.equal(err.message, 'repetition loop detected');
  assert.equal(err.excerpt, 'const x = 1;');
  assert.ok(err instanceof Error);
});

// ---------- deliberation loops (a distinct failure mode: coherent but stuck) ----------

// Condensed from a real trace: a model that produced 31 restart phrases, zero
// tool calls, and zero lines of code before running out of budget mid-sentence.
const REAL_DELIBERATION_TRACE = [
  'Let me analyze the code for these issues.',
  'The debounce logic is broken because currentTime keeps getting reset.',
  'Let me fix all these issues.',
  'Actually, for a quick fix, let me focus on the toggle.',
  'Actually, let me think about what is most impactful and least risky.',
  'Let me do instanced rendering for both 2D and 3D modes.',
  'Let me write the code. This will be a significant rewrite.',
  'Actually, let me be more strategic. Let me first fix the toggle bug.',
  'Let me write the fixes now. I will do them in a single large edit.',
  'Actually, let me think about this differently.',
  'OK let me just do it properly with instanced rendering.',
  'Actually, I realize I should be more careful about scope.',
  'Wait, I need to be careful about the size of this edit.',
  'Actually, let me just do one big comprehensive rewrite.',
  'Let me plan the exact changes.',
].join('\n');

// Distinct sentences, so a check for verbatim repetition has nothing to find.
const productive = (chars, from = 0) => {
  const lines = [];
  for (let n = from; lines.join(' ').length < chars; n++) {
    lines.push(`Step ${n}: the parser at depth ${n % 7} reads token ${n * 13} and records its span.`);
  }
  return lines.join(' ');
};

test('deliberation: a real looping trace is caught and routed to directive recovery', () => {
  const hit = scanThinkingForPsychosis(REAL_DELIBERATION_TRACE, { value: 0 });
  assert.ok(hit, 'expected the looping trace to trigger');
  assert.match(hit.reason, /deliberation loop/);
  assert.equal(hit.recovery, 'directive', 'compaction is the wrong fix for dithering');
});

test('deliberation: the loop is caught for a cloud reasoning model too', () => {
  const hit = scanThinkingForPsychosis(REAL_DELIBERATION_TRACE, { value: 0 }, { model: 'run5c-step-0128', provider: 'brittain', contextLength: 32_768 });
  assert.match(hit?.reason || '', /deliberation loop/);
});

test('deliberation: normal chain-of-thought with one or two course-corrections is NOT flagged', () => {
  const healthy = [
    'The user wants a scrollbar. Let me start by reading the CSS to see how the container is sized.',
    'Wait, let me reconsider — the overflow is probably on the parent, not the child.',
    'I will read styles.css and confirm before changing anything.',
  ].join('\n');
  assert.equal(scanThinkingForPsychosis(healthy, { value: 0 }), null);
});

// Deviation: the source used one sentence repeated 120 times as "productive"
// reasoning. Verbatim repetition is now a loop signal, so the filler is
// distinct sentences instead.
test('deliberation: long but productive reasoning under the budget is not flagged', () => {
  const dense = productive(8000);
  assert.ok(dense.length > 5000 && dense.length < 12000);
  assert.equal(scanThinkingForPsychosis(dense, { value: 0 }), null);
});

test('deliberation: restarts spread across a long trace are not a loop; bunched together they are', () => {
  const restarts = ['Let me start with the parser.', 'Actually, let me check the lexer.', 'Let me reconsider the grammar.',
    'Let me first read the tests.', 'Wait, I should check the fixtures.', 'Let me just run the suite.'];
  const spread = restarts.map((line, index) => `${line} ${productive(1500, index * 100)}`).join(' ');
  const options = { provider: 'brittain', contextLength: 131_072 };
  assert.equal(scanThinkingForPsychosis(spread, { value: 0 }, options), null);
  assert.match(scanThinkingForPsychosis(`${productive(6000)} ${restarts.join(' ')}`, { value: 0 }, options)?.reason || '', /deliberation loop/);
});

test('deliberation: reasoning that repeats a passage word for word is a loop', () => {
  const passage = 'So the calculator is rendered into #root and the CSS centres it, which means the problem must be elsewhere. ';
  const hit = scanThinkingForPsychosis(`${productive(1000)} ${passage.repeat(3)}`, { value: 0 }, { provider: 'brittain', contextLength: 32_768 });
  assert.match(hit?.reason || '', /repeating itself/);
  assert.equal(hit.recovery, 'directive');
});

test('deliberation: runaway reasoning trips the char budget even without restart phrases', () => {
  const runaway = productive(12_500);
  const hit = scanThinkingForPsychosis(runaway, { value: 0 });
  assert.ok(hit);
  assert.match(hit.reason, /exceeded/);
  assert.equal(hit.recovery, 'directive');
});

test('deliberation: the budget is wide for cloud and large models, and never more than half the window', () => {
  assert.equal(thinkingBudget({ model: 'qwen3:8b', provider: 'ollama' }), 12_000);
  assert.equal(thinkingBudget({ model: 'qwen3:32b', provider: 'ollama' }), 100_000);
  assert.equal(thinkingBudget({ provider: 'brittain', contextLength: 32_768 }), 65_536);
  assert.equal(thinkingBudget({ provider: 'openai', contextLength: 200_000 }), 100_000);
  assert.equal(thinkingBudget({ model: 'qwen3:8b', provider: 'ollama', contextLength: 4096 }), 12_000);
});

test('deliberation: scan is throttled — state advances only past the interval', () => {
  const state = { value: 0 };
  scanThinkingForPsychosis('short'.repeat(10), state); // 50 chars, under 500
  assert.equal(state.value, 0, 'should not have scanned yet');
  scanThinkingForPsychosis(productive(600), state);
  assert.ok(state.value >= 600, 'should have scanned and recorded position');
});

test('deliberation: glitch tokens in reasoning still route to compaction, not directive', () => {
  const hit = scanThinkingForPsychosis('value is getTitle．Content here', { value: 0 });
  assert.ok(hit);
  assert.equal(hit.recovery, 'compact', 'corruption needs a sanity reset, not a pep talk');
});


test('deliberation: PsychosisDetectedError defaults to compact and accepts directive', () => {
  assert.equal(new PsychosisDetectedError('r', 'e').recovery, 'compact');
  assert.equal(new PsychosisDetectedError('r', 'e', 'directive').recovery, 'directive');
});

