// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/psychosis-detector.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  PsychosisDetectedError,
  scanContentForPsychosis,
  scanThinkingForPsychosis,
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





test('deliberation: glitch tokens in reasoning still route to compaction, not directive', () => {
  const hit = scanThinkingForPsychosis('value is getTitle．Content here', { value: 0 });
  assert.ok(hit);
  assert.equal(hit.recovery, 'compact', 'corruption needs a sanity reset, not a pep talk');
});


test('deliberation: PsychosisDetectedError defaults to compact and accepts directive', () => {
  assert.equal(new PsychosisDetectedError('r', 'e').recovery, 'compact');
  assert.equal(new PsychosisDetectedError('r', 'e', 'directive').recovery, 'directive');
});

