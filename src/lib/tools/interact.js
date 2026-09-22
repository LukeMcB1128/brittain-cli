// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- agent loop ----------" (ask_user branch of runAgentTurn)
'use strict';

// ask_user is answered by whoever drives the run, so the agent loop owns the
// asking. What lives here is the part that does not depend on who answers:
// turning whatever shape the model emitted into questions, and turning the
// answers back into a tool result.

function normalizeQuestions(args = {}) {
  // accept both the questions array and the legacy single-question shape
  let qs = Array.isArray(args.questions) ? args.questions
    : args.question ? [{ question: args.question, options: args.options }]
    : [];
  // models emit several shapes: proper objects, plain strings, and
  // gpt-oss's flattened arrays ["question", "opt1", "opt2", ...]
  return qs.slice(0, 4).map((q) => {
    if (Array.isArray(q)) return { question: String(q[0] || ''), options: q.slice(1, 5).map(String) };
    if (typeof q === 'string') return { question: q, options: [] };
    let opts = q?.options;
    if (typeof opts === 'string') { try { opts = JSON.parse(opts); } catch { opts = [opts]; } }
    return { question: String(q?.question || ''), options: Array.isArray(opts) ? opts.map(String).slice(0, 4) : [] };
  }).filter((q) => q.question);
}

const MISSING_QUESTIONS = 'Error: ask_user requires a "questions" array of {question, options} objects.';

function answersResult(questions, answers) {
  return answers
    ? 'The user answered:\n' + questions.map((q, i) => `Q: ${q.question}\nA: ${answers[i]}`).join('\n')
    : 'The user cancelled the question. Stop and wait for further instructions.';
}

module.exports = { MISSING_QUESTIONS, answersResult, normalizeQuestions };
