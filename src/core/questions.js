// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- question flow (ask_user tool) ----------"
'use strict';

// ask_user, answered by whoever drives the run: the REPL through host.ask(),
// or anything else through the `answer` command. With nobody there (print
// mode) the answer is null at once, and the model is told the question went
// unanswered rather than being left to hang.
//
// Pruned: the remote (Discord/daemon) timeout — the CLI either has a person
// at the terminal or has nobody.

function createQuestions(rt) {
  const pending = new Map();
  rt.questions = { pending };

  function requestAnswer(info) {
    return new Promise((resolve) => {
      if (!rt.host.interactive()) return resolve(null);
      const id = Math.random().toString(36).slice(2);
      const settle = (answer) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve(answer ?? null);
      };
      pending.set(id, settle);
      const request = { id, ...info };
      rt.sink.emit('question:request', request);
      Promise.resolve()
        .then(() => rt.host.ask(request))
        .then(settle, () => settle(null));
    });
  }

  function answerQuestion(id, answer) {
    const settle = pending.get(String(id || ''));
    if (!settle) return { ok: false, error: 'No question is waiting — it may have been answered already.' };
    settle(answer);
    return { ok: true };
  }

  return { answerQuestion, requestAnswer };
}

module.exports = { createQuestions };
